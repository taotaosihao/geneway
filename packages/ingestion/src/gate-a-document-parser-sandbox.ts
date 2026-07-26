import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, extname } from 'node:path';
import { canonicalizeGateAProjection } from '@geneway/contracts';

const BASE_DIGEST = '25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c';
const PARSER_PATH = '/opt/geneway-parser/document-parser.mjs';
const NODE_PATH = '/usr/local/bin/node';
const RUNTIME_FILES = Object.freeze([
  NODE_PATH,
  PARSER_PATH,
  '/usr/lib/x86_64-linux-gnu/libdl.so.2',
  '/usr/lib/x86_64-linux-gnu/libm.so.6',
  '/usr/lib/x86_64-linux-gnu/libpthread.so.0',
  '/usr/lib/x86_64-linux-gnu/libc.so.6',
  '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
  '/usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.30',
  '/usr/lib/x86_64-linux-gnu/libgcc_s.so.1',
] as const);
const LIBC_FILES = RUNTIME_FILES.slice(2, 7);
const MAX_INPUT = 8 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const safeImage = /^geneway-document-parser:[a-f0-9]{16}$/u;
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export const gateADocumentFormats = Object.freeze({
  txt: { mediaType: 'text/plain', parserFormat: 'text', extractionVersion: 'canonical-text/plain-utf8/1' },
  pdf: { mediaType: 'application/pdf', parserFormat: 'pdf', extractionVersion: 'canonical-text/pdf-pages-utf8/1' },
  docx: { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', parserFormat: 'docx', extractionVersion: 'canonical-text/docx-pages-utf8/1' },
} as const);
export type GateADocumentExtension = keyof typeof gateADocumentFormats;
export type GateADocumentMediaType = typeof gateADocumentFormats[GateADocumentExtension]['mediaType'];
export type GateADocumentExtractionVersion = typeof gateADocumentFormats[GateADocumentExtension]['extractionVersion'];

export type GateADocumentParserManifestCandidate = Readonly<{
  schemaVersion: 'parser-manifest.gate-a/2';
  id: string;
  format: GateADocumentExtension;
  mediaType: GateADocumentMediaType;
  extractionVersion: GateADocumentExtractionVersion;
  parser: Readonly<{
    name: 'geneway-document-parser'; version: '1.0.0-candidate.1';
    registrySource: 'geneway-workspace'; upstreamSource: 'geneway://packages/ingestion/document-parser';
    lockResolution: string; lockIntegrity: string; imageDigest: string; executableDigest: string; packageDigest: string; license: 'UNLICENSED-internal';
  }>;
  runtimeClosureDigest: string;
  dependencies: readonly Readonly<{
    name: 'node' | 'libc6' | 'libstdc++6' | 'libgcc-s1' | 'pdfjs-dist'; version: string;
    registrySource: string; upstreamSource: string; lockResolution: string; lockIntegrity: string;
    imageDigest: string; actualFiles: readonly Readonly<{ path: string; sha256: string }>[];
    packageDigest: string; license: string;
  }>[];
  conversionConfig: Readonly<{
    inputFormat: GateADocumentExtension;
    outputEncoding: 'UTF-8'; unicodeNormalization: 'none'; newlineNormalization: 'none';
    pageIndexSchemaVersion: 'canonical-page-index/1';
    maxInputBytes: 8_388_608; maxOutputBytes: 2_097_152; maxPages: 256;
    maxZipEntries: 2_048; maxZipEntryBytes: 4_194_304; maxExpansionRatio: 40; maxNestingDepth: 64;
  }>;
  resourceLimitsVersion: 'gate-a-document-parser-limits-candidate/1';
  approvedBy: string; approvedAt: string; expiresAt: string;
  approvedImage: string; approvedImageId: string; approvedImageSourceDigest: string;
  approvedPackageDigest: string; approvedRuntimeClosureDigest: string;
  manifestDigest: string;
}>;

export type GateADocumentParserApprovalMetadata = Readonly<{
  runId: string; approvedBy: string; approvedAt: string; expiresAt: string;
}>;
export type GateAParserStartupApproval = Readonly<{
  schemaVersion: 'gate-a-parser-startup-approval/2';
  runId: string; approvedBy: string; approvedAt: string; expiresAt: string;
  image: string; imageId: string; imageSourceDigest: string;
  executableDigest: string; packageDigest: string; runtimeClosureDigest: string; dependencyInventoryDigest: string;
  formatManifestDigests: Readonly<Record<GateADocumentExtension, string>>;
}>;
export type GateADocumentParserApprovalCandidate = GateAParserStartupApproval;

export type GateADocumentParserAuthorityInspection = Readonly<{
  schemaVersion: 'gate-a-document-parser-authority-inspection/2';
  image: string; imageId: string; imageSourceDigest: string;
  executableDigest: string; packageDigest: string; runtimeClosureDigest: string; dependencyInventoryDigest: string;
  manifests: Readonly<Record<GateADocumentExtension, GateADocumentParserManifestCandidate>>;
  startupApprovalCandidate: GateAParserStartupApproval;
}>;

export type GateACanonicalPageCandidate = Readonly<{
  pageIndex: number; canonicalStartByte: number; canonicalEndByteExclusive: number; canonicalPageSha256: string;
}>;
export type GateACanonicalPageIndexCandidate = Readonly<{
  schemaVersion: 'canonical-page-index/1'; format: GateADocumentExtension; mediaType: GateADocumentMediaType;
  extractionVersion: GateADocumentExtractionVersion; canonicalTextSha256: string; canonicalByteLength: number;
  pageCount: number; pages: readonly GateACanonicalPageCandidate[];
}>;
export type GateAParsedDocumentCandidate = Readonly<{
  mediaType: GateADocumentMediaType;
  extractionVersion: GateADocumentExtractionVersion;
  canonicalBytes: Uint8Array;
  canonicalTextSha256: string;
  canonicalPageIndex: GateACanonicalPageIndexCandidate;
  canonicalPageIndexSha256: string;
  parserManifest: GateADocumentParserManifestCandidate;
  parserDigest: string;
  processReceipt: Readonly<{
    schemaVersion: 'gate-a-parser-process-receipt/2'; imageId: string; networkMode: 'none';
    readOnlyRootFilesystem: true; uid: 65_532; gid: 65_532; capabilities: readonly [];
    noNewPrivileges: true; pidsLimit: 16; memoryLimitBytes: 134_217_728; cpuLimit: 0.5;
    credentialEnvironmentCount: 0; inputStreamCount: 1; outputStreamCount: 1; inputMountCount: 0; outputMountCount: 0;
  }>;
}>;

type CommandResult = Readonly<{ stdout: string | Uint8Array; stderr: string }>;
const commandStdoutBytes = (stdout: string | Uint8Array): Buffer => typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : Buffer.from(stdout);
const commandStdoutText = (stdout: string | Uint8Array): string => commandStdoutBytes(stdout).toString('utf8');
export type GateADocumentParserCommandRunner = (command: string, args: readonly string[], timeoutMs: number, stdinBytes?: Uint8Array) => Promise<CommandResult>;
const runDefault: GateADocumentParserCommandRunner = (command, args, timeoutMs, stdinBytes) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let settled = false;
  const settle = (callback: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); callback(); } };
  const collect = (target: Buffer[], kind: 'stdout' | 'stderr', maximum: number) => (chunk: Buffer): void => {
    if (kind === 'stdout') stdoutSize += chunk.length; else stderrSize += chunk.length;
    if ((kind === 'stdout' ? stdoutSize : stderrSize) > maximum) { child.kill('SIGKILL'); settle(() => reject(new Error(`document parser command ${kind} exceeded its bound`))); }
    else target.push(chunk);
  };
  child.stdout.on('data', collect(stdout, 'stdout', MAX_OUTPUT + 256 * 1024 + 12));
  child.stderr.on('data', collect(stderr, 'stderr', 128 * 1024));
  child.stdin.on('error', (error) => settle(() => reject(new Error(`document parser stdin failed: ${error.message}`))));
  child.once('error', (error) => settle(() => reject(error)));
  child.once('close', (code) => settle(() => code === 0
      ? resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') })
    : reject(new Error(`document parser command failed (${String(code ?? 1)}): ${Buffer.concat(stderr).toString('utf8').slice(0, 1_000)}`))));
  const timer = setTimeout(() => { child.kill('SIGKILL'); settle(() => reject(new Error('document parser command timed out'))); }, timeoutMs);
  child.stdin.end(stdinBytes);
});

type RuntimeFileIdentity = Readonly<{ path: string; sha256: string }>;
function parseRuntimeIdentity(stdout: string): Readonly<{ files: readonly RuntimeFileIdentity[]; executableDigest: string; packageDigest: string; runtimeClosureDigest: string }> {
  const lines = stdout.trim().split('\n');
  const parse = (line: string, path: string): RuntimeFileIdentity => {
    const match = /^([a-f0-9]{64}) {2}(\/[A-Za-z0-9._+/-]+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] !== path) throw new Error('document parser byte probe was invalid');
    return { path, sha256: match[1] };
  };
  if (lines.length !== RUNTIME_FILES.length) throw new Error('document parser byte probe returned an invalid line count');
  const files = RUNTIME_FILES.map((path, index) => parse(lines[index] ?? '', path));
  return {
    files,
    executableDigest: files[0]?.sha256 ?? '',
    packageDigest: files[1]?.sha256 ?? '',
    runtimeClosureDigest: sha256(canonicalizeGateAProjection(files)),
  };
}
function digestRuntimePackage(files: readonly RuntimeFileIdentity[]): string {
  return sha256(canonicalizeGateAProjection(files));
}
function selectFormat(fileName: string, mediaType: string, bytes: Uint8Array): Readonly<{ extension: GateADocumentExtension; parserFormat: 'text' | 'pdf' | 'docx'; extractionVersion: GateADocumentExtractionVersion }> {
  const name = basename(fileName);
  if (name !== fileName || name.startsWith('.') || name.includes('..') || name.length > 120) throw new Error('document file name is invalid');
  const rawExtension = extname(name).slice(1).toLowerCase();
  if (['doc', 'docm', 'xls', 'xlsx', 'ppt', 'pptx'].includes(rawExtension)) throw new Error('legacy, macro, spreadsheet, and presentation Office formats are not supported');
  if (!(rawExtension in gateADocumentFormats)) throw new Error('document extension is not supported');
  const extension = rawExtension as GateADocumentExtension;
  const format = gateADocumentFormats[extension];
  if (mediaType !== format.mediaType) throw new Error('document extension and media type do not match');
  const isPdf = bytes.subarray(0, 5).every((value, index) => value === Buffer.from('%PDF-')[index]);
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if ((extension === 'pdf' && !isPdf) || (extension === 'docx' && !isZip) || (extension === 'txt' && (isPdf || isZip))) {
    throw new Error('document content signature does not match its declared type');
  }
  return { extension, parserFormat: format.parserFormat, extractionVersion: format.extractionVersion };
}

async function inspectDocumentParserManifest(image: string, format: GateADocumentExtension, approval: GateADocumentParserApprovalMetadata, run: GateADocumentParserCommandRunner): Promise<Readonly<{ imageId: string; imageSourceDigest: string; executableDigest: string; packageDigest: string; runtimeClosureDigest: string; dependencyInventoryDigest: string; manifest: GateADocumentParserManifestCandidate }>> {
    if (!safeImage.test(image)) throw new Error('document parser image reference is invalid');
    const raw = await run('docker', ['image', 'inspect', image], 5_000);
    const parsed = JSON.parse(commandStdoutText(raw.stdout)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('document parser image inspection was invalid');
    const inspected = parsed[0] as { Id?: unknown; Config?: { User?: unknown; Entrypoint?: unknown; Labels?: Record<string, unknown> } };
    const imageId = typeof inspected.Id === 'string' ? inspected.Id : '';
    const labels = inspected.Config?.Labels ?? {};
    const expectedEntrypoint = ['node', '--permission', '--allow-fs-read=/opt/geneway-parser/document-parser.mjs', '--allow-fs-read=/opt/geneway-parser/pdfjs', '--no-addons', PARSER_PATH];
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId) || inspected.Config?.User !== '65532:65532'
      || JSON.stringify(inspected.Config.Entrypoint) !== JSON.stringify(expectedEntrypoint)
      || labels['org.geneway.parser.name'] !== 'geneway-document-parser'
      || labels['org.geneway.parser.version'] !== '1.0.0-candidate.1'
      || labels['org.geneway.parser.base-digest'] !== `sha256:${BASE_DIGEST}`
      || typeof labels['org.geneway.parser.package-digest'] !== 'string'
      || typeof labels['org.geneway.parser.image-source-digest'] !== 'string'
      || typeof labels['org.geneway.parser.pdfjs-inventory-digest'] !== 'string') throw new Error('document parser image authority was invalid');
    const probe = await run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '16', '--memory', '128m', '--cpus', '0.5', '--user', '65532:65532', '--entrypoint', 'sha256sum', imageId, ...RUNTIME_FILES], 10_000);
    const identity = parseRuntimeIdentity(commandStdoutText(probe.stdout));
    if (identity.packageDigest !== labels['org.geneway.parser.package-digest']) throw new Error('document parser package bytes do not match its image label');
    const pdfjsProbe = await run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '16', '--memory', '128m', '--cpus', '0.5', '--user', '65532:65532', imageId, 'verify-pdfjs-inventory'], 15_000);
    const pdfjsReceipt = JSON.parse(commandStdoutText(pdfjsProbe.stdout)) as Readonly<Record<string, unknown>>;
    if (pdfjsReceipt.schemaVersion !== 'gate-a-pdfjs-inventory-receipt/1'
      || pdfjsReceipt.inventoryDigest !== labels['org.geneway.parser.pdfjs-inventory-digest']) throw new Error('PDF.js fixed inventory bytes do not match the image authority');
    const formatAuthority = gateADocumentFormats[format];
    const file = (path: string): RuntimeFileIdentity => {
      const found = identity.files.find((entry) => entry.path === path);
      if (found === undefined) throw new Error('document parser runtime closure is incomplete');
      return found;
    };
    const nodeFiles = [file(NODE_PATH)];
    const libcFiles = LIBC_FILES.map(file);
    const stdcppFiles = [file('/usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.30')];
    const gccFiles = [file('/usr/lib/x86_64-linux-gnu/libgcc_s.so.1')];
    const unsigned = {
      schemaVersion: 'parser-manifest.gate-a/2' as const,
      id: `parser_document_v2_${identity.packageDigest.slice(0, 12)}_${imageId.slice(-12)}_${format}`,
      format,
      mediaType: formatAuthority.mediaType,
      extractionVersion: formatAuthority.extractionVersion,
      parser: { name: 'geneway-document-parser' as const, version: '1.0.0-candidate.1' as const, registrySource: 'geneway-workspace' as const, upstreamSource: 'geneway://packages/ingestion/document-parser' as const, lockResolution: `docker-image:${imageId}`, lockIntegrity: imageId.slice('sha256:'.length), imageDigest: imageId, executableDigest: identity.executableDigest, packageDigest: identity.packageDigest, license: 'UNLICENSED-internal' as const },
      runtimeClosureDigest: identity.runtimeClosureDigest,
      dependencies: [
        { name: 'node' as const, version: '22.21.1', registrySource: 'docker.io/library/node', upstreamSource: `node:22.21.1-bookworm-slim@sha256:${BASE_DIGEST}`, lockResolution: `node@sha256:${BASE_DIGEST}`, lockIntegrity: BASE_DIGEST, imageDigest: `sha256:${BASE_DIGEST}`, actualFiles: nodeFiles, packageDigest: digestRuntimePackage(nodeFiles), license: 'MIT' },
        { name: 'libc6' as const, version: '2.36-9+deb12u13', registrySource: 'deb.debian.org/debian', upstreamSource: `node:22.21.1-bookworm-slim@sha256:${BASE_DIGEST}`, lockResolution: 'libc6:amd64=2.36-9+deb12u13', lockIntegrity: BASE_DIGEST, imageDigest: `sha256:${BASE_DIGEST}`, actualFiles: libcFiles, packageDigest: digestRuntimePackage(libcFiles), license: 'LGPL-2.1-or-later' },
        { name: 'libstdc++6' as const, version: '12.2.0-14+deb12u1', registrySource: 'deb.debian.org/debian', upstreamSource: `node:22.21.1-bookworm-slim@sha256:${BASE_DIGEST}`, lockResolution: 'libstdc++6:amd64=12.2.0-14+deb12u1', lockIntegrity: BASE_DIGEST, imageDigest: `sha256:${BASE_DIGEST}`, actualFiles: stdcppFiles, packageDigest: digestRuntimePackage(stdcppFiles), license: 'GPL-3.0-or-later WITH GCC-exception-3.1' },
        { name: 'libgcc-s1' as const, version: '12.2.0-14+deb12u1', registrySource: 'deb.debian.org/debian', upstreamSource: `node:22.21.1-bookworm-slim@sha256:${BASE_DIGEST}`, lockResolution: 'libgcc-s1:amd64=12.2.0-14+deb12u1', lockIntegrity: BASE_DIGEST, imageDigest: `sha256:${BASE_DIGEST}`, actualFiles: gccFiles, packageDigest: digestRuntimePackage(gccFiles), license: 'GPL-3.0-or-later WITH GCC-exception-3.1' },
        { name: 'pdfjs-dist' as const, version: '6.1.200', registrySource: 'registry.npmjs.org', upstreamSource: 'https://github.com/mozilla/pdf.js/releases/tag/v6.1.200', lockResolution: 'pdfjs-dist@6.1.200', lockIntegrity: 'sha512-o8MolyzirkkLrcdsae/HEOiIcXWI7DS5zGpvqW8xTC2YUsW30rltFw2bDGvw/fskUdEMrQm2br68jzDS5BH2vw==', imageDigest: imageId, actualFiles: [{ path: '/opt/geneway-parser/pdfjs/<fixed-inventory>', sha256: String(pdfjsReceipt.inventoryDigest) }], packageDigest: String(pdfjsReceipt.inventoryDigest), license: 'Apache-2.0' },
      ] as const,
      conversionConfig: { inputFormat: format, outputEncoding: 'UTF-8' as const, unicodeNormalization: 'none' as const, newlineNormalization: 'none' as const, pageIndexSchemaVersion: 'canonical-page-index/1' as const, maxInputBytes: 8_388_608 as const, maxOutputBytes: 2_097_152 as const, maxPages: 256 as const, maxZipEntries: 2_048 as const, maxZipEntryBytes: 4_194_304 as const, maxExpansionRatio: 40 as const, maxNestingDepth: 64 as const },
      resourceLimitsVersion: 'gate-a-document-parser-limits-candidate/1' as const,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      expiresAt: approval.expiresAt,
      approvedImage: image,
      approvedImageId: imageId,
      approvedImageSourceDigest: String(labels['org.geneway.parser.image-source-digest']),
      approvedPackageDigest: identity.packageDigest,
      approvedRuntimeClosureDigest: identity.runtimeClosureDigest,
    };
    const manifestDigest = sha256(canonicalizeGateAProjection(unsigned));
    const dependencies = unsigned.dependencies;
    return { imageId, imageSourceDigest: String(labels['org.geneway.parser.image-source-digest']), executableDigest: identity.executableDigest, packageDigest: identity.packageDigest, runtimeClosureDigest: identity.runtimeClosureDigest, dependencyInventoryDigest: sha256(canonicalizeGateAProjection(dependencies)), manifest: Object.freeze({ ...unsigned, manifestDigest }) };
}

export async function inspectGateADocumentParserAuthority(image: string, approval: GateADocumentParserApprovalMetadata, run: GateADocumentParserCommandRunner = runDefault): Promise<GateADocumentParserAuthorityInspection> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(approval.runId) || approval.approvedBy.trim() === '' || !Number.isFinite(Date.parse(approval.approvedAt)) || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) throw new Error('document parser approval metadata is invalid');
  const entries = await Promise.all((Object.keys(gateADocumentFormats) as GateADocumentExtension[]).map(async (format) => [format, await inspectDocumentParserManifest(image, format, approval, run)] as const));
  const first = entries[0]?.[1];
  if (first === undefined || entries.some(([, value]) => value.imageId !== first.imageId || value.imageSourceDigest !== first.imageSourceDigest || value.executableDigest !== first.executableDigest || value.packageDigest !== first.packageDigest || value.runtimeClosureDigest !== first.runtimeClosureDigest || value.dependencyInventoryDigest !== first.dependencyInventoryDigest)) throw new Error('document parser authority changed during inspection');
  const manifests = Object.fromEntries(entries.map(([format, value]) => [format, value.manifest])) as Record<GateADocumentExtension, GateADocumentParserManifestCandidate>;
  const startupApprovalCandidate: GateAParserStartupApproval = Object.freeze({ schemaVersion: 'gate-a-parser-startup-approval/2', ...approval, image, imageId: first.imageId, imageSourceDigest: first.imageSourceDigest, executableDigest: first.executableDigest, packageDigest: first.packageDigest, runtimeClosureDigest: first.runtimeClosureDigest, dependencyInventoryDigest: first.dependencyInventoryDigest, formatManifestDigests: Object.freeze({ txt: manifests.txt.manifestDigest, pdf: manifests.pdf.manifestDigest, docx: manifests.docx.manifestDigest }) });
  return Object.freeze({ schemaVersion: 'gate-a-document-parser-authority-inspection/2', image, imageId: first.imageId, imageSourceDigest: first.imageSourceDigest, executableDigest: first.executableDigest, packageDigest: first.packageDigest, runtimeClosureDigest: first.runtimeClosureDigest, dependencyInventoryDigest: first.dependencyInventoryDigest, manifests: Object.freeze(manifests), startupApprovalCandidate });
}

export class GateADocumentParserSandboxCandidate {
  private inspection: Promise<GateADocumentParserAuthorityInspection> | undefined;
  constructor(private readonly image: string, private readonly approval: GateAParserStartupApproval, private readonly run: GateADocumentParserCommandRunner = runDefault) {
    if (!safeImage.test(image) || approval.schemaVersion !== 'gate-a-parser-startup-approval/2') throw new Error('document parser startup approval is invalid');
  }

  async resolveAuthority(): Promise<GateADocumentParserAuthorityInspection> {
    this.inspection ??= inspectGateADocumentParserAuthority(this.image, this.approval, this.run);
    const inspection = await this.inspection;
    const actual = inspection.startupApprovalCandidate;
    if (canonicalizeGateAProjection(actual) !== canonicalizeGateAProjection(this.approval)) throw new Error('document parser startup approval does not exactly bind the current runtime and all format manifests');
    if (Date.parse(this.approval.expiresAt) <= Date.now()) throw new Error('document parser startup approval is expired');
    return inspection;
  }

  private async resolveManifest(format: GateADocumentExtension): Promise<Readonly<{ imageId: string; manifest: GateADocumentParserManifestCandidate }>> {
    const inspection = await this.resolveAuthority();
    return { imageId: inspection.imageId, manifest: inspection.manifests[format] };
  }

  async parse(input: Readonly<{ fileName: string; mediaType: string; bytes: Uint8Array }>): Promise<GateAParsedDocumentCandidate> {
    if (input.bytes.length < 1 || input.bytes.length > MAX_INPUT) throw new Error('document parser input exceeds its byte bound');
    const selected = selectFormat(input.fileName, input.mediaType, input.bytes);
    const { imageId, manifest } = await this.resolveManifest(selected.extension);
    if (Date.parse(manifest.expiresAt) <= Date.now()) throw new Error('document parser manifest is expired');
      const execution = await this.run('docker', ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '16', '--memory', '128m', '--cpus', '0.5', '--user', '65532:65532', '--env-file', '/dev/null', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m', imageId, selected.parserFormat], 15_000, input.bytes);
      const frame = commandStdoutBytes(execution.stdout);
      if (frame.length < 12 || frame.subarray(0, 4).toString('ascii') !== 'GWP3') throw new Error('document parser output frame header is invalid');
      const metadataLength = frame.readUInt32BE(4); const canonicalLength = frame.readUInt32BE(8);
      if (metadataLength < 1 || metadataLength > 256 * 1024 || canonicalLength < 1 || canonicalLength > MAX_OUTPUT || frame.length !== 12 + metadataLength + canonicalLength) throw new Error('document parser output frame bounds are invalid');
      const reported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(12, 12 + metadataLength))) as Record<string, unknown>;
      if (reported.schemaVersion !== 'geneway-document-parser-result/3') throw new Error('document parser output frame schema is invalid');
      const canonicalBytes = frame.subarray(12 + metadataLength);
      const pageIndex = reported.canonicalPageIndex as { schemaVersion?: unknown; format?: unknown; mediaType?: unknown; extractionVersion?: unknown; canonicalTextSha256?: unknown; canonicalByteLength?: unknown; pageCount?: unknown; pages?: unknown };
      if (pageIndex.schemaVersion !== 'canonical-page-index/1' || pageIndex.format !== selected.extension
        || pageIndex.mediaType !== gateADocumentFormats[selected.extension].mediaType || pageIndex.extractionVersion !== selected.extractionVersion
        || pageIndex.canonicalByteLength !== canonicalBytes.length || !Array.isArray(pageIndex.pages)
        || pageIndex.pageCount !== pageIndex.pages.length || pageIndex.pages.length < 1 || pageIndex.pages.length > 256
        || pageIndex.canonicalTextSha256 !== sha256(canonicalBytes)
        || reported.canonicalPageIndexSha256 !== sha256(canonicalizeGateAProjection(pageIndex))) throw new Error('document parser page index authority was invalid');
      let expectedOffset = 0;
      const pages = pageIndex.pages.map((raw, index): GateACanonicalPageCandidate => {
        const page = raw as Partial<GateACanonicalPageCandidate>;
        if (page.pageIndex !== index || page.canonicalStartByte !== expectedOffset || !Number.isSafeInteger(page.canonicalEndByteExclusive)
          || (page.canonicalEndByteExclusive ?? -1) <= expectedOffset || (page.canonicalEndByteExclusive ?? Infinity) > canonicalBytes.length) throw new Error('document parser page span is invalid');
        const end = page.canonicalEndByteExclusive as number; const bytes = canonicalBytes.subarray(expectedOffset, end);
        if (page.canonicalPageSha256 !== sha256(bytes)) throw new Error('document parser page hash is invalid');
        const parsed = { pageIndex: index, canonicalStartByte: expectedOffset, canonicalEndByteExclusive: end, canonicalPageSha256: page.canonicalPageSha256 };
        expectedOffset = end; return parsed;
      });
      if (expectedOffset !== canonicalBytes.length || canonicalBytes.length > MAX_OUTPUT) throw new Error('document parser canonical output coverage is invalid');
      try { new TextDecoder('utf-8', { fatal: true }).decode(canonicalBytes); } catch { throw new Error('document parser canonical output is not UTF-8'); }
      const canonicalPageIndex: GateACanonicalPageIndexCandidate = { schemaVersion: 'canonical-page-index/1', format: selected.extension, mediaType: gateADocumentFormats[selected.extension].mediaType, extractionVersion: selected.extractionVersion, canonicalTextSha256: sha256(canonicalBytes), canonicalByteLength: canonicalBytes.length, pageCount: pages.length, pages };
      return { mediaType: canonicalPageIndex.mediaType, extractionVersion: selected.extractionVersion, canonicalBytes, canonicalTextSha256: canonicalPageIndex.canonicalTextSha256, canonicalPageIndex, canonicalPageIndexSha256: sha256(canonicalizeGateAProjection(canonicalPageIndex)), parserManifest: manifest, parserDigest: manifest.manifestDigest, processReceipt: { schemaVersion: 'gate-a-parser-process-receipt/2', imageId, networkMode: 'none', readOnlyRootFilesystem: true, uid: 65_532, gid: 65_532, capabilities: [] as const, noNewPrivileges: true, pidsLimit: 16, memoryLimitBytes: 134_217_728, cpuLimit: 0.5, credentialEnvironmentCount: 0, inputStreamCount: 1, outputStreamCount: 1, inputMountCount: 0, outputMountCount: 0 } };
  }
}
