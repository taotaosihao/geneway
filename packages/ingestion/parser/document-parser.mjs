#!/usr/bin/env node
/* eslint-disable -- isolated container executable; authority is its hashed bytes and hostile-byte Docker corpus */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { argv, stdin, stdout } from 'node:process';
import { inflateRawSync } from 'node:zlib';

const MAX_INPUT = 8 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_PAGES = 256;
const MAX_ZIP_ENTRIES = 2_048;
const MAX_ENTRY = 4 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 40;
const MAX_XML_DEPTH = 64;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fail(message) { throw new Error(message); }
function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('document contains invalid UTF-8'); }
}
function xmlText(value) {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"').replace(/&apos;/gu, "'");
}
const forbiddenPdfNames = new Set([
  'Encrypt', 'JavaScript', 'JS', 'OpenAction', 'AA', 'Launch', 'URI', 'GoToR', 'GoToE',
  'SubmitForm', 'ImportData', 'Rendition', 'Movie', 'Sound', 'EmbeddedFile', 'RichMedia',
  'XFA', 'AcroForm',
]);
function decodePdfNames(value) {
  let normalized = '';
  for (let cursor = 0; cursor < value.length;) {
    const character = value[cursor];
    if (character === '(') {
      let depth = 1;
      normalized += '()';
      for (cursor += 1; cursor < value.length && depth > 0; cursor += 1) {
        if (value[cursor] === '\\') cursor += 1;
        else if (value[cursor] === '(') depth += 1;
        else if (value[cursor] === ')') depth -= 1;
      }
      // Literal contents are irrelevant to the Name authority scan. A truncated
      // classic-object pre-scan is never allowed to turn string bytes into names;
      // PDF.js remains the authoritative syntax/parser boundary below.
      continue;
    }
    if (character === '<' && value[cursor + 1] === '<') { normalized += '<<'; cursor += 2; continue; }
    if (character === '<') {
      const end = value.indexOf('>', cursor + 1);
      if (end < 0) { normalized += '<>'; cursor = value.length; continue; }
      normalized += '<>';
      cursor = end + 1;
      continue;
    }
    if (character === '%') {
      const end = value.indexOf('\n', cursor + 1);
      cursor = end < 0 ? value.length : end;
      normalized += '\n';
      continue;
    }
    if (character !== '/') { normalized += character; cursor += 1; continue; }
    let end = cursor + 1;
    while (end < value.length && !/[\x00-\x20()<>\[\]{}/%]/u.test(value[end])) end += 1;
    const rawName = value.slice(cursor + 1, end);
    let decoded = '';
    for (let index = 0; index < rawName.length; index += 1) {
      if (rawName[index] !== '#') { decoded += rawName[index]; continue; }
      const escape = rawName.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/u.test(escape)) fail('PDF Name contains an invalid #xx escape');
      decoded += String.fromCharCode(Number.parseInt(escape, 16));
      index += 2;
    }
    if (forbiddenPdfNames.has(decoded)) fail('PDF active, encrypted, or embedded content is forbidden');
    normalized += `/${decoded}`;
    cursor = end;
  }
  return normalized;
}
function singlePdfReference(dictionary, name) {
  const match = new RegExp(`/${name}\\s+(\\d+)\\s+0\\s+R\\b`, 'u').exec(dictionary);
  return match?.[1];
}
async function extractPdfWithPdfjs(bytes) {
  if (globalThis.DOMMatrix === undefined) globalThis.DOMMatrix = class DOMMatrix {};
  if (globalThis.Path2D === undefined) globalThis.Path2D = class Path2D {};
  // @ts-ignore -- module is copied into the immutable parser image build context.
  const { getDocument, GlobalWorkerOptions } = await import('file:///opt/geneway-parser/pdfjs/legacy/build/pdf.mjs');
  GlobalWorkerOptions.workerSrc = 'file:///opt/geneway-parser/pdfjs/legacy/build/pdf.worker.mjs';
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    useWasm: false,
    cMapUrl: '/opt/geneway-parser/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/opt/geneway-parser/pdfjs/standard_fonts/',
    wasmUrl: '/opt/geneway-parser/pdfjs/wasm/',
  });
  let document;
  try {
    document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > MAX_PAGES) fail('PDF.js page count is outside its bound');
    if (await document.getAttachments() !== null) fail('PDF attachments are forbidden');
    if (await document.getOpenAction() !== null) fail('PDF document OpenAction is forbidden');
    if (await document.getFieldObjects() !== null || await document.getCalculationOrderIds() !== null) fail('PDF interactive form authority is forbidden');
    const documentActions = await document.getJSActions();
    if (documentActions !== null && Object.keys(documentActions).length > 0) fail('PDF JavaScript actions are forbidden');
    const outline = await document.getOutline();
    const hasExternalOutlineAction = (items) => (items ?? []).some((item) => item.url !== undefined || item.unsafeUrl !== undefined
      || item.action !== undefined || hasExternalOutlineAction(item.items));
    if (hasExternalOutlineAction(outline)) fail('PDF outline action or external URL is forbidden');
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const annotations = await page.getAnnotations({ intent: 'display' });
      if (annotations.some((annotation) => annotation.url !== undefined || annotation.unsafeUrl !== undefined || annotation.action !== undefined)) {
        fail('PDF annotation action or external URL is forbidden');
      }
      const content = await page.getTextContent({ disableNormalization: true, includeMarkedContent: false });
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str;
        text += item.hasEOL === true ? '\n' : ' ';
      }
      pages.push(text.replace(/[ \t]+\n/gu, '\n').replace(/[ \t]+$/gu, ''));
      await page.cleanup();
    }
    if (pages.every((page) => page.trim() === '')) fail('image-only PDF is unsupported because Gate A has no OCR route');
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}
async function parsePdf(bytes) {
  const source = bytes.toString('latin1');
  if (!source.startsWith('%PDF-1.') || !/%%EOF\s*$/u.test(source)) fail('PDF signature or EOF is invalid');
  const objects = new Map();
  for (const match of source.matchAll(/(?:^|\n)(\d+)\s+0\s+obj\b([\s\S]*?)endobj/gu)) {
    if (objects.has(match[1])) fail('PDF contains a duplicate object identity');
    const raw = match[2];
    const streamOffset = raw.search(/\bstream(?:\r\n|\r|\n)/u);
    const dictionary = decodePdfNames(streamOffset < 0 ? raw : raw.slice(0, streamOffset));
    objects.set(match[1], { raw, dictionary });
  }
  if (objects.size === 0 || objects.size > 20_000) fail('PDF object table is invalid');
  for (const trailer of source.matchAll(/trailer\s*<<(.*?)>>/gsu)) decodePdfNames(trailer[1] ?? '');
  if ([...objects.values()].some((object) => /\/Type\s*\/(?:ObjStm|XRef)\b/u.test(object.dictionary))) return await extractPdfWithPdfjs(bytes);
  const catalogs = [...objects.entries()].filter(([, object]) => /\/Type\s*\/Catalog\b/u.test(object.dictionary));
  if (catalogs.length !== 1) fail('PDF must contain exactly one Catalog');
  const rootReference = singlePdfReference(catalogs[0][1].dictionary, 'Pages');
  if (rootReference === undefined) fail('PDF Catalog is missing its Pages root');
  const visited = new Set();
  function walk(reference, parentReference, depth) {
    if (depth > 32) fail('PDF Pages tree exceeds its depth bound');
    if (visited.has(reference)) fail('PDF Pages tree contains a cycle or duplicate reference');
    visited.add(reference);
    const object = objects.get(reference);
    if (object === undefined) fail('PDF Pages tree refers to a missing object');
    const { dictionary } = object;
    if (/\/Type\s*\/Pages\b/u.test(dictionary)) {
      const kidsMatch = /\/Kids\s*\[([^\]]*)\]/u.exec(dictionary);
      const countMatch = /\/Count\s+(\d+)\b/u.exec(dictionary);
      if (kidsMatch?.[1] === undefined || countMatch?.[1] === undefined) fail('PDF Pages node is missing Kids or Count');
      const references = [...kidsMatch[1].matchAll(/(\d+)\s+0\s+R\b/gu)].map((match) => match[1]);
      if (references.length === 0 || kidsMatch[1].replace(/\d+\s+0\s+R\b/gu, '').trim() !== '') fail('PDF Pages Kids is invalid');
      const descendants = references.flatMap((child) => walk(child, reference, depth + 1));
      if (descendants.length !== Number.parseInt(countMatch[1], 10)) fail('PDF Pages Count does not match its descendants');
      if (descendants.length > MAX_PAGES) fail('PDF page count exceeds its bound');
      return descendants;
    }
    if (!/\/Type\s*\/Page\b/u.test(dictionary)) fail('PDF Pages Kids contains a non-page node');
    if (parentReference !== undefined && singlePdfReference(dictionary, 'Parent') !== parentReference) fail('PDF Page Parent does not match its tree authority');
    return [object];
  }
  const orderedPageObjects = walk(rootReference, undefined, 0);
  const physicalPageCount = [...objects.values()].filter((object) => /\/Type\s*\/Page\b/u.test(object.dictionary) && !/\/Type\s*\/Pages\b/u.test(object.dictionary)).length;
  if (orderedPageObjects.length !== physicalPageCount) fail('PDF contains a Page outside the Catalog Pages tree');
  const extracted = await extractPdfWithPdfjs(bytes);
  if (extracted.length !== orderedPageObjects.length) fail('PDF.js page count differs from the classic Pages tree authority');
  return extracted;
}

function zipEntries(bytes) {
  let eocd = -1;
  for (let offset = Math.max(0, bytes.length - 65_557); offset <= bytes.length - 22; offset += 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) fail('DOCX central directory is missing');
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (commentLength !== 0 || eocd + 22 !== bytes.length) fail('DOCX archive comment or trailing bytes are forbidden');
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralStart = bytes.readUInt32LE(eocd + 16);
  let cursor = centralStart;
  const centralEnd = cursor + centralSize;
  if (count < 1 || count > MAX_ZIP_ENTRIES || cursor + centralSize > bytes.length) fail('DOCX archive bounds are invalid');
  const entries = new Map();
  const occupied = [];
  let expandedTotal = 0;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) fail('DOCX central entry is invalid');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crcExpected = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const expandedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = utf8(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (extraLength !== 0 || commentLength !== 0) fail('DOCX central extra fields and comments are forbidden');
    if ((flags & 1) !== 0 || (flags & 8) !== 0 || ![0, 8].includes(method)) fail('DOCX encryption, data descriptor, or compression method is forbidden');
    if ([compressedSize, expandedSize, localOffset].includes(0xffffffff)) fail('DOCX ZIP64 is forbidden');
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || name.includes('\0')) fail('DOCX entry path is unsafe');
    const pathSegments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
    if (pathSegments.length > 16 || pathSegments.some((segment) => segment.length < 1 || segment.length > 120)) fail('DOCX entry path depth or segment length exceeds its bound');
    if (expandedSize > MAX_ENTRY || (compressedSize > 0 && expandedSize / compressedSize > MAX_EXPANSION_RATIO)) fail('DOCX expansion limit exceeded');
    expandedTotal += expandedSize;
    if (expandedTotal > MAX_INPUT * MAX_EXPANSION_RATIO) fail('DOCX aggregate expansion limit exceeded');
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) fail('DOCX local entry is invalid');
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localExpandedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    if (localExtraLength !== 0) fail('DOCX local extra fields are forbidden');
    const localName = utf8(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (localFlags !== flags || localMethod !== method || localCrc !== crcExpected
      || localCompressedSize !== compressedSize || localExpandedSize !== expandedSize || localName !== name || end > bytes.length || end > bytes.readUInt32LE(eocd + 16)) {
      fail('DOCX central and local entry authority differs');
    }
    if (occupied.some(([from, to]) => localOffset < to && end > from)) fail('DOCX local entries overlap');
    occupied.push([localOffset, end]);
    const compressed = bytes.subarray(start, start + compressedSize);
    if (compressed.length !== compressedSize) fail('DOCX entry is truncated');
    let expanded;
    try { expanded = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY }); }
    catch { fail('DOCX entry cannot be decompressed'); }
    if (expanded.length !== expandedSize) fail('DOCX entry size is inconsistent');
    let crc = 0xffffffff;
    for (const byte of expanded) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320); }
    if (((crc ^ 0xffffffff) >>> 0) !== localCrc) fail('DOCX entry CRC is invalid');
    if (expanded.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || expanded.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02]))) {
      fail('DOCX nested archive content is forbidden');
    }
    if (entries.has(name)) fail('DOCX contains a duplicate entry');
    entries.set(name, expanded);
  }
  if (cursor !== centralEnd || centralEnd !== eocd) fail('DOCX central directory size or placement is inconsistent');
  occupied.sort(([left], [right]) => left - right);
  let coveredUntil = 0;
  for (const [from, to] of occupied) {
    if (from !== coveredUntil) fail('DOCX contains bytes outside an authorized local entry');
    coveredUntil = to;
  }
  if (coveredUntil !== centralStart) fail('DOCX local entries do not continuously cover the archive prefix');
  return entries;
}
function parseDocx(bytes) {
  const entries = zipEntries(bytes);
  const names = [...entries.keys()];
  if (!entries.has('[Content_Types].xml') || !entries.has('word/document.xml')) fail('DOCX required parts are missing');
  if (names.some((name) => /(?:^|\/)(?:vbaProject\.bin|embeddings\/|activeX\/|macros\/)/iu.test(name)
    || /\.(?:bin|exe|dll|js|vbs|ole)$/iu.test(name))) fail('DOCX macro, OLE, script, or embedded object is forbidden');
  for (const [name, value] of entries) {
    if (!name.endsWith('.rels')) continue;
    const relationships = utf8(value);
    if (/TargetMode\s*=\s*["']External["']/iu.test(relationships)
      || /Target\s*=\s*["'](?:https?:|ftp:|file:|\\\\|\/)/iu.test(relationships)) fail('DOCX external relationship is forbidden');
  }
  const xml = utf8(entries.get('word/document.xml'));
  const typeXml = utf8(entries.get('[Content_Types].xml'));
  const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const documentRoot = /<w:document\b([^>]*)>/u.exec(xml);
  if (documentRoot?.[1] === undefined || !new RegExp(`\\bxmlns:w=["']${wordNamespace}["']`, 'u').test(documentRoot[1])) {
    fail('DOCX main WordprocessingML namespace must use the fixed w prefix');
  }
  const namespaceBindings = [...xml.matchAll(/\bxmlns:([A-Za-z_][\w.-]*)=["']([^"']+)["']/gu)];
  if (namespaceBindings.filter((binding) => binding[1] === 'w' && binding[2] === wordNamespace).length !== 1
    || namespaceBindings.some((binding) => (binding[2] === wordNamespace && binding[1] !== 'w')
      || (binding[1] === 'w' && binding[2] !== wordNamespace))) fail('DOCX WordprocessingML namespace alias or rebind is forbidden');
  for (const element of xml.matchAll(/<\/?([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*/gu)) {
    if (element[1] !== 'w') fail('DOCX element uses an undeclared or unsupported namespace prefix');
  }
  const allXmlParts = [typeXml, ...[...entries].filter(([name]) => name.startsWith('word/') && name.endsWith('.xml')).map(([, value]) => utf8(value))];
  if (allXmlParts.some((part) => /<!DOCTYPE|<!ENTITY/iu.test(part))) fail('DOCX DTD and entity declarations are forbidden');
  if (allXmlParts.some((part) => /macroEnabled|vnd\.ms-office|oleObject|activeX|<(?:[A-Za-z_][\w.-]*:)?(?:instrText|fldSimple|fldChar)\b|\bDDEAUTO?\b/iu.test(part))) fail('DOCX active content is forbidden');
  let depth = 0;
  for (const token of xml.match(/<\/?[^>]+>/gu) ?? []) {
    if (/^<\//u.test(token)) depth -= 1;
    else if (!/\/>$/u.test(token) && !/^<\?/u.test(token)) depth += 1;
    if (depth < 0 || depth > MAX_XML_DEPTH) fail('DOCX XML nesting is invalid');
  }
  if (depth !== 0) fail('DOCX XML is unbalanced');
  const pages = [''];
  const tokens = xml.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/>|<w:lastRenderedPageBreak\s*\/>|<\/w:p>/gu) ?? [];
  for (const token of tokens) {
    if (token.startsWith('<w:t')) pages[pages.length - 1] += xmlText(token.replace(/^<w:t(?:\s[^>]*)?>/u, '').replace(/<\/w:t>$/u, ''));
    else if (token.startsWith('<w:tab')) pages[pages.length - 1] += '\t';
    else if (/w:lastRenderedPageBreak|w:type\s*=\s*["']page["']/u.test(token)) pages.push('');
    else pages[pages.length - 1] += '\n';
  }
  if (pages.length > MAX_PAGES) fail('DOCX page count exceeds its bound');
  return pages.map((page) => page.replace(/\n{3,}/gu, '\n\n'));
}
function parseText(bytes) {
  const text = utf8(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf || bytes.includes(0)) fail('text/plain byte policy is invalid');
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if ((point < 32 && ![9, 10, 13].includes(point)) || (point >= 127 && point <= 159)) fail('text/plain contains a forbidden control');
  }
  return [text];
}
function jcs(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(',')}}`;
}
function outputPages(format, pages) {
  const formatAuthority = {
    text: { format: 'txt', mediaType: 'text/plain', extractionVersion: 'canonical-text/plain-utf8/1' },
    pdf: { format: 'pdf', mediaType: 'application/pdf', extractionVersion: 'canonical-text/pdf-pages-utf8/1' },
    docx: { format: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extractionVersion: 'canonical-text/docx-pages-utf8/1' },
  }[format];
  const encoded = pages.map((page) => Buffer.from(format === 'text' ? page : (page.endsWith('\n') ? page : `${page}\n`), 'utf8'));
  const canonical = Buffer.concat(encoded);
  if (canonical.length < 1 || canonical.length > MAX_OUTPUT) fail('canonical document output is outside its bound');
  let offset = 0;
  const pageEntries = encoded.map((page, pageIndex) => {
    const startByte = offset;
    offset += page.length;
    return { pageIndex, canonicalStartByte: startByte, canonicalEndByteExclusive: offset, canonicalPageSha256: sha256(page) };
  });
  const index = { schemaVersion: 'canonical-page-index/1', ...formatAuthority, canonicalTextSha256: sha256(canonical), canonicalByteLength: canonical.length, pageCount: pageEntries.length, pages: pageEntries };
  return { canonical, index };
}

async function main() {
  if (argv.length === 3 && argv[2] === 'verify-pdfjs-inventory') {
    const inventory = JSON.parse(utf8(await readFile('/opt/geneway-parser/pdfjs/inventory.json')));
    if (inventory?.schemaVersion !== 'gate-a-pdfjs-inventory/1' || !Array.isArray(inventory.files) || inventory.files.length < 1) fail('PDF.js inventory manifest is invalid');
    for (const entry of inventory.files) {
      if (typeof entry?.path !== 'string' || !/^[A-Za-z0-9._+/-]+$/u.test(entry.path) || !/^[a-f0-9]{64}$/u.test(entry.sha256)) fail('PDF.js inventory entry is invalid');
      const actual = await readFile(`/opt/geneway-parser/pdfjs/${entry.path}`);
      if (sha256(actual) !== entry.sha256) fail('PDF.js inventory bytes drifted');
    }
    stdout.write(`${JSON.stringify({ schemaVersion: 'gate-a-pdfjs-inventory-receipt/1', inventoryDigest: sha256(Buffer.from(JSON.stringify(inventory.files))) })}\n`);
    return;
  }
  if (argv.length !== 3 || !['text', 'pdf', 'docx'].includes(argv[2])) fail('parser requires one frozen format argument');
  const chunks = [];
  let inputBytes = 0;
  for await (const chunk of stdin) {
    inputBytes += chunk.length;
    if (inputBytes > MAX_INPUT) fail('stdin input exceeds its byte bound');
    chunks.push(chunk);
  }
  if (inputBytes < 1) fail('stdin input must not be empty');
  const bytes = Buffer.concat(chunks);
  let pages;
  if (argv[2] === 'text') pages = parseText(bytes);
  else if (argv[2] === 'pdf') pages = await parsePdf(bytes);
  else pages = parseDocx(bytes);
  const result = outputPages(argv[2], pages);
  const metadata = Buffer.from(JSON.stringify({ schemaVersion: 'geneway-document-parser-result/3', canonicalPageIndex: result.index, canonicalPageIndexSha256: sha256(Buffer.from(jcs(result.index), 'utf8')) }), 'utf8');
  if (metadata.length > 256 * 1024) fail('parser result metadata exceeds its byte bound');
  const header = Buffer.alloc(12);
  header.write('GWP3', 0, 'ascii');
  header.writeUInt32BE(metadata.length, 4);
  header.writeUInt32BE(result.canonical.length, 8);
  stdout.write(Buffer.concat([header, metadata, result.canonical]));
}

await main();
