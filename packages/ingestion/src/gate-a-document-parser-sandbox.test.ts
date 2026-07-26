import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { deflateRawSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalizeGateAProjection, gateAParserStartupApprovalSchema } from '@geneway/contracts';
import { GateADocumentParserSandboxCandidate, inspectGateADocumentParserAuthority, type GateADocumentParserCommandRunner, type GateAParserStartupApproval } from './gate-a-document-parser-sandbox.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const repositoryRoot = new URL('../../../', import.meta.url);
const runtimeFiles = [
  '/usr/local/bin/node', '/opt/geneway-parser/document-parser.mjs',
  '/usr/lib/x86_64-linux-gnu/libdl.so.2', '/usr/lib/x86_64-linux-gnu/libm.so.6',
  '/usr/lib/x86_64-linux-gnu/libpthread.so.0', '/usr/lib/x86_64-linux-gnu/libc.so.6',
  '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.30',
  '/usr/lib/x86_64-linux-gnu/libgcc_s.so.1',
] as const;
const fakeRuntimeLines = runtimeFiles.map((path, index) => `${index === 0 ? 'b'.repeat(64) : index === 1 ? 'c'.repeat(64) : (index + 1).toString(16).repeat(64)}  ${path}`);
const fakeRuntimeFiles = fakeRuntimeLines.map((line, index) => ({ path: runtimeFiles[index], sha256: line.slice(0, 64) }));
const approval = {
  schemaVersion: 'gate-a-parser-startup-approval/2' as const,
  runId: 'gate-a-document-parser-test',
  approvedBy: 'gate-a-parser-reviewer', approvedAt: '2026-07-26T00:00:00.000Z', expiresAt: '2027-07-26T00:00:00.000Z',
  image: 'geneway-document-parser:0123456789abcdef', imageId: 'sha256:' + 'a'.repeat(64), imageSourceDigest: 'd'.repeat(64),
  executableDigest: 'b'.repeat(64), packageDigest: 'c'.repeat(64), runtimeClosureDigest: sha256(Buffer.from(canonicalizeGateAProjection(fakeRuntimeFiles))),
  dependencyInventoryDigest: 'f'.repeat(64), formatManifestDigests: { txt: '1'.repeat(64), pdf: '2'.repeat(64), docx: '3'.repeat(64) },
};
function imageTag(): string {
  const result = spawnSync(process.execPath, ['scripts/build-gate-a-document-parser-image.mjs', '--print-tag'], { cwd: repositoryRoot, env: {}, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
}
function ensureImage(): string {
  const image = imageTag();
  const inspect = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  if (inspect.status !== 0) {
    const build = spawnSync(process.execPath, ['scripts/build-gate-a-document-parser-image.mjs'], { cwd: repositoryRoot, stdio: 'inherit', env: {} });
    if (build.error !== undefined || build.status !== 0) throw build.error ?? new Error('image build failed');
  }
  return image;
}
async function realApproval(image: string): Promise<GateAParserStartupApproval> {
  const inspected = await inspectGateADocumentParserAuthority(image, { runId: approval.runId, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt });
  return gateAParserStartupApprovalSchema.parse(inspected.startupApprovalCandidate);
}
function pdf(pages: readonly string[], extra = '', options: Readonly<{ physicalReverse?: boolean; kidsReverse?: boolean }> = {}): Buffer {
  const objects: string[] = [];
  const pageReferences = pages.map((_page, index) => `${3 + index * 2} 0 R`);
  const pageRefs = (options.kidsReverse === true ? [...pageReferences].reverse() : pageReferences).join(' ');
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${extra} >>\nendobj`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>\nendobj`);
  pages.forEach((page, index) => {
    const pageId = 3 + index * 2; const streamId = pageId + 1;
    const escaped = page.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)');
    const stream = `BT /F1 12 Tf (${escaped}) Tj ET`;
    objects.push(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 100 0 R >> >> /Contents ${streamId} 0 R >>\nendobj`);
    objects.push(`${streamId} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj`);
  });
  objects.push('100 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj');
  const ordered = options.physicalReverse === true ? [...objects].reverse() : objects;
  let body = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  for (const object of ordered) {
    const id = Number.parseInt(/^(\d+)\s+0\s+obj/u.exec(object)?.[1] ?? '0', 10);
    offsets.set(id, Buffer.byteLength(body, 'latin1'));
    body += `${object}\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  const size = Math.max(...offsets.keys()) + 1;
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) body += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 ${offsets.has(id) ? 'n' : 'f'} \n`;
  body += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
async function productionPdfFixture(name: 'chrome' | 'wkhtml' | 'ghostscript'): Promise<Buffer> {
  const encoded = await readFile(new URL(`../../../scripts/fixtures/gate-a-documents/${name}-production.pdf.gz.b64`, import.meta.url), 'utf8');
  return gunzipSync(Buffer.from(encoded.trim(), 'base64'));
}
async function productionDocxFixture(): Promise<Buffer> {
  const encoded = await readFile(new URL('../../../scripts/fixtures/gate-a-documents/pandoc-production.docx.gz.b64', import.meta.url), 'utf8');
  return gunzipSync(Buffer.from(encoded.trim(), 'base64'));
}
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320); }
  return (value ^ 0xffffffff) >>> 0;
}
function docx(input: Readonly<Record<string, string | Buffer>>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, raw] of Object.entries(input)) {
    const nameBytes = Buffer.from(name); const value = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); const compressed = deflateRawSync(value); const crc = crc32(value);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(value.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(value.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes); offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(Object.keys(input).length, 8); eocd.writeUInt16LE(Object.keys(input).length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}
const contentTypes = '<?xml version="1.0"?><Types><Default Extension="xml" ContentType="application/xml"/></Types>';
const relationship = '<?xml version="1.0"?><Relationships></Relationships>';
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function validDocx(document: string, extra: Readonly<Record<string, string | Buffer>> = {}): Buffer {
  return docx({ '[Content_Types].xml': contentTypes, '_rels/.rels': relationship, 'word/document.xml': document, 'word/_rels/document.xml.rels': relationship, ...extra });
}
function withEocdComment(input: Buffer): Buffer {
  const output = Buffer.concat([input, Buffer.from('PK\x03\x04', 'latin1')]);
  output.writeUInt16LE(4, input.length - 2);
  return output;
}
function withLocalGap(input: Buffer): Buffer {
  const eocd = input.length - 22; const central = input.readUInt32LE(eocd + 16); const hidden = Buffer.from('PK\x03\x04', 'latin1');
  const output = Buffer.concat([input.subarray(0, central), hidden, input.subarray(central)]);
  output.writeUInt32LE(central + hidden.length, eocd + hidden.length + 16);
  return output;
}
function withLocalExtra(input: Buffer): Buffer {
  const nameLength = input.readUInt16LE(26); const insertion = 30 + nameLength; const eocd = input.length - 22; const central = input.readUInt32LE(eocd + 16); const hidden = Buffer.from('PK\x03\x04', 'latin1');
  const output = Buffer.concat([input.subarray(0, insertion), hidden, input.subarray(insertion)]);
  output.writeUInt16LE(hidden.length, 28);
  output.writeUInt32LE(central + hidden.length, eocd + hidden.length + 16);
  return output;
}
function withCentralExtra(input: Buffer): Buffer {
  const eocd = input.length - 22; const central = input.readUInt32LE(eocd + 16); const nameLength = input.readUInt16LE(central + 28); const insertion = central + 46 + nameLength; const hidden = Buffer.from('PK\x03\x04', 'latin1');
  const output = Buffer.concat([input.subarray(0, insertion), hidden, input.subarray(insertion)]);
  output.writeUInt16LE(hidden.length, central + 30);
  output.writeUInt32LE(input.readUInt32LE(eocd + 12) + hidden.length, eocd + hidden.length + 12);
  return output;
}

describe('Gate A PDF/DOCX/TXT candidate parser', () => {
  it('rejects extension, MIME, and content mismatches before image inspection', async () => {
    const calls: string[][] = [];
    const runner: GateADocumentParserCommandRunner = (_command, args) => {
      calls.push([...args]);
      return Promise.reject(new Error('must not run'));
    };
    const sandbox = new GateADocumentParserSandboxCandidate('geneway-document-parser:0123456789abcdef', approval, runner);
    await expect(inspectGateADocumentParserAuthority('geneway-document-parser:0123456789abcdef', { runId: '../invalid', approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt }, runner)).rejects.toThrow('approval metadata is invalid');
    for (const input of [
      { fileName: 'a.doc', mediaType: 'application/msword', bytes: Uint8Array.of(1) },
      { fileName: 'a.docm', mediaType: 'application/vnd.ms-word.document.macroEnabled.12', bytes: Uint8Array.of(0x50, 0x4b, 3, 4) },
      { fileName: 'a.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: Uint8Array.of(0x50, 0x4b, 3, 4) },
      { fileName: 'a.pdf', mediaType: 'text/plain', bytes: Buffer.from('%PDF-') },
      { fileName: 'a.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from('%PDF-') },
      { fileName: 'too-large.txt', mediaType: 'text/plain', bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 0x41) },
    ]) await expect(sandbox.parse(input)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('rejects manifest/image byte authority drift before a parse container starts', async () => {
    const calls: string[][] = [];
    const runner: GateADocumentParserCommandRunner = (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return Promise.resolve({ stdout: JSON.stringify([{ Id: 'sha256:' + 'a'.repeat(64), Config: { User: '65532:65532', Entrypoint: [], Labels: {} } }]), stderr: '' });
      return Promise.reject(new Error('unexpected command'));
    };
    const sandbox = new GateADocumentParserSandboxCandidate('geneway-document-parser:0123456789abcdef', approval, runner);
    await expect(sandbox.parse({ fileName: 'safe.txt', mediaType: 'text/plain', bytes: Buffer.from('safe') })).rejects.toThrow('image authority was invalid');
    expect(calls).toHaveLength(3);
  });

  it('fails closed and cleans the one-shot authority on container crash or timeout', async () => {
    for (const failure of [new Error('container crash'), new Error('document parser command timed out')]) {
      const calls: string[][] = [];
      let parseInput: Uint8Array | undefined;
      const runner: GateADocumentParserCommandRunner = (_command, args, _timeout, stdinBytes) => {
        calls.push([...args]);
        if (args[0] === 'image') return Promise.resolve({ stdout: JSON.stringify([{
          Id: 'sha256:' + 'a'.repeat(64),
          Config: {
            User: '65532:65532',
            Entrypoint: ['node', '--permission', '--allow-fs-read=/opt/geneway-parser/document-parser.mjs', '--allow-fs-read=/opt/geneway-parser/pdfjs', '--no-addons', '/opt/geneway-parser/document-parser.mjs'],
            Labels: { 'org.geneway.parser.name': 'geneway-document-parser', 'org.geneway.parser.version': '1.0.0-candidate.1', 'org.geneway.parser.base-digest': 'sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c', 'org.geneway.parser.package-digest': 'c'.repeat(64), 'org.geneway.parser.image-source-digest': 'd'.repeat(64), 'org.geneway.parser.pdfjs-inventory-digest': 'e'.repeat(64) },
          },
        }]), stderr: '' });
        if (args.includes('sha256sum')) return Promise.resolve({ stdout: `${fakeRuntimeLines.join('\n')}\n`, stderr: '' });
        if (args.includes('verify-pdfjs-inventory')) return Promise.resolve({ stdout: JSON.stringify({ schemaVersion: 'gate-a-pdfjs-inventory-receipt/1', inventoryDigest: 'e'.repeat(64) }), stderr: '' });
        parseInput = stdinBytes;
        return Promise.reject(failure);
      };
      const prepared = await inspectGateADocumentParserAuthority('geneway-document-parser:0123456789abcdef', { runId: approval.runId, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt }, runner);
      calls.length = 0;
      const sandbox = new GateADocumentParserSandboxCandidate('geneway-document-parser:0123456789abcdef', prepared.startupApprovalCandidate, runner);
      await expect(sandbox.parse({ fileName: 'safe.txt', mediaType: 'text/plain', bytes: Buffer.from('safe') })).rejects.toThrow(failure.message);
      const parseArgs = calls.at(-1) ?? [];
      expect(parseArgs).toContain('-i');
      expect(parseArgs.some((value) => value === '--mount')).toBe(false);
      expect(Buffer.from(parseInput ?? [])).toEqual(Buffer.from('safe'));
    }
  });

  it('parses real multi-page PDF and DOCX into ordered zero-based byte pages', async () => {
    const image = ensureImage();
    const sandbox = new GateADocumentParserSandboxCandidate(image, await realApproval(image));
    const previousSecret = process.env.GENEWAY_DOCUMENT_PARSER_SECRET_SENTINEL;
    process.env.GENEWAY_DOCUMENT_PARSER_SECRET_SENTINEL = 'must-never-enter-canonical-output';
    try {
      const pdfResult = await sandbox.parse({ fileName: 'two-pages.pdf', mediaType: 'application/pdf', bytes: pdf(['第一页 alpha', '第二页 beta']) });
      expect(pdfResult.canonicalPageIndex.pages.map((page) => page.pageIndex)).toEqual([0, 1]);
      expect(pdfResult.canonicalPageIndex.pages.at(0)?.canonicalStartByte).toBe(0);
      expect(pdfResult.canonicalPageIndex.pages.at(-1)?.canonicalEndByteExclusive).toBe(pdfResult.canonicalBytes.length);
      expect(pdfResult.canonicalPageIndex.pages.every((page) => page.canonicalEndByteExclusive > page.canonicalStartByte)).toBe(true);
      expect(Buffer.from(pdfResult.canonicalBytes).toString('utf8')).toMatch(/alpha\n.*beta/u);
      expect(pdfResult.canonicalTextSha256).toBe(sha256(pdfResult.canonicalBytes));
      expect(Buffer.from(pdfResult.canonicalBytes).toString('utf8')).toContain('alpha');
      const physicalReverse = await sandbox.parse({ fileName: 'physical-reverse.pdf', mediaType: 'application/pdf', bytes: pdf(['first alpha', 'second beta'], '', { physicalReverse: true }) });
      expect(Buffer.from(physicalReverse.canonicalBytes).toString('utf8')).toMatch(/^first alpha\nsecond beta\n$/u);
      const kidsReverse = await sandbox.parse({ fileName: 'kids-reverse.pdf', mediaType: 'application/pdf', bytes: pdf(['first alpha', 'second beta'], '', { kidsReverse: true }) });
      expect(Buffer.from(kidsReverse.canonicalBytes).toString('utf8')).toMatch(/^second beta\nfirst alpha\n$/u);
      for (const [name, expected] of [['chrome', 'GJ-2026-0718'], ['wkhtml', 'Alpha evidence'], ['ghostscript', 'gamma 31']] as const) {
        const produced = await sandbox.parse({ fileName: `${name}.pdf`, mediaType: 'application/pdf', bytes: await productionPdfFixture(name) });
        expect(Buffer.from(produced.canonicalBytes).toString('utf8')).toContain(expected);
        expect(produced.canonicalPageIndex.pages).toHaveLength(2);
      }
      const document = `<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>NFD é 与 CRLF\r\n</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/><w:t>第二页</w:t></w:r></w:p></w:body></w:document>`;
      const docxResult = await sandbox.parse({ fileName: 'two-pages.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: validDocx(document) });
      expect(docxResult.canonicalPageIndex.pages).toHaveLength(2);
      expect(Buffer.from(docxResult.canonicalBytes).toString('utf8')).toContain('NFD é');
      expect(docxResult.parserManifest.mediaType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(docxResult.processReceipt).toMatchObject({ networkMode: 'none', credentialEnvironmentCount: 0, pidsLimit: 16, inputStreamCount: 1, outputStreamCount: 1, inputMountCount: 0, outputMountCount: 0 });
      const producedDocx = await sandbox.parse({ fileName: 'pandoc.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: await productionDocxFixture() });
      expect(Buffer.from(producedDocx.canonicalBytes).toString('utf8')).toContain('GJ-DOCX-001');
      const textBytes = Buffer.from('byte-exact CRLF\r\nNFD é 与多字节字符');
      const textResult = await sandbox.parse({ fileName: 'material.txt', mediaType: 'text/plain', bytes: textBytes });
      expect(Buffer.from(textResult.canonicalBytes)).toEqual(textBytes);
      expect(textResult.canonicalPageIndex.pages).toEqual([{ pageIndex: 0, canonicalStartByte: 0, canonicalEndByteExclusive: textBytes.length, canonicalPageSha256: sha256(textBytes) }]);
      expect(textResult.extractionVersion).toBe('canonical-text/plain-utf8/1');
      expect(textResult.parserDigest).toBe(textResult.parserManifest.manifestDigest);
      expect(Buffer.from(textResult.canonicalBytes).toString('utf8')).not.toContain('must-never-enter-canonical-output');
    } finally {
      if (previousSecret === undefined) delete process.env.GENEWAY_DOCUMENT_PARSER_SECRET_SENTINEL;
      else process.env.GENEWAY_DOCUMENT_PARSER_SECRET_SENTINEL = previousSecret;
    }
  }, 120_000);

  it('fails closed on encrypted/action PDF and DOCX external, macro, OLE, and expansion attacks', async () => {
    const image = ensureImage();
    const sandbox = new GateADocumentParserSandboxCandidate(image, await realApproval(image));
    for (const bytes of [
      pdf(['safe'], '/Encrypt 8 0 R'), pdf(['safe'], '/OpenAction << /S /JavaScript >>'),
      pdf(['safe'], '/URI (https://forbidden.invalid)'), pdf(['safe'], '/S /GoToR /F (other.pdf)'),
      pdf(['safe'], '/S /SubmitForm /F (https://forbidden.invalid)'),
      pdf(['safe'], '/Open#41ction << /S /Java#53cript >>'),
    ]) {
      await expect(sandbox.parse({ fileName: 'bad.pdf', mediaType: 'application/pdf', bytes })).rejects.toThrow();
    }
    await expect(sandbox.parse({ fileName: 'bad-name.pdf', mediaType: 'application/pdf', bytes: pdf(['safe'], '/Open#4Gction') })).rejects.toThrow('invalid #xx escape');
    for (const bytes of [
      Buffer.from(pdf(['one']).toString('latin1').replace('/Count 1', '/Count 2'), 'latin1'),
      Buffer.from(pdf(['one']).toString('latin1').replace('/Kids [3 0 R]', '/Kids [3 0 R 3 0 R]').replace('/Count 1', '/Count 2'), 'latin1'),
      Buffer.from(pdf(['one']).toString('latin1').replace('/Kids [3 0 R]', '/Kids [2 0 R]'), 'latin1'),
    ]) await expect(sandbox.parse({ fileName: 'bad-tree.pdf', mediaType: 'application/pdf', bytes })).rejects.toThrow();
    const document = `<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>safe</w:t></w:r></w:p></w:body></w:document>`;
    const external = validDocx(document, { 'word/_rels/document.xml.rels': '<Relationships><Relationship TargetMode="External" Target="https://forbidden.invalid/x"/></Relationships>' });
    const macro = validDocx(document, { 'word/vbaProject.bin': Buffer.from('macro') });
    const ole = validDocx(document, { 'word/embeddings/oleObject1.bin': Buffer.from('OLE') });
    const fieldCode = validDocx(`<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:instrText>DDEAUTO cmd</w:instrText></w:r></w:p></w:body></w:document>`);
    const aliasField = validDocx(`<?xml version="1.0"?><x:document xmlns:x="${wordNamespace}"><x:body><x:instrText>DDEAUTO cmd</x:instrText></x:body></x:document>`);
    const reboundNamespace = validDocx(`<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}"><w:body><w:p xmlns:w="urn:evil"><w:r><w:t>unsafe</w:t></w:r></w:p></w:body></w:document>`);
    const undeclaredPrefix = validDocx(`<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}"><w:body><x:t>unsafe</x:t></w:body></w:document>`);
    const nestedArchive = validDocx(document, { 'word/media/nested.dat': validDocx(document) });
    const bomb = validDocx(document, { 'word/media/bomb.txt': Buffer.alloc(2_000_000, 0x41) });
    const localCentralDrift = Buffer.from(validDocx(document));
    const centralOffset = localCentralDrift.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    localCentralDrift.writeUInt32LE((localCentralDrift.readUInt32LE(centralOffset + 16) + 1) >>> 0, centralOffset + 16);
    const oneEntry = docx({ 'only.xml': 'safe' });
    for (const bytes of [external, macro, ole, fieldCode, aliasField, reboundNamespace, undeclaredPrefix, nestedArchive, bomb, localCentralDrift, withEocdComment(oneEntry), withLocalGap(oneEntry), withLocalExtra(oneEntry), withCentralExtra(oneEntry)]) await expect(sandbox.parse({ fileName: 'bad.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes })).rejects.toThrow();
    await expect(sandbox.parse({ fileName: 'overflow.txt', mediaType: 'text/plain', bytes: Buffer.alloc(2_097_153, 0x41) })).rejects.toThrow('output is outside its bound');
  }, 120_000);
});
