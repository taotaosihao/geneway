import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const runId = process.env.GENEWAY_RUN_ID;
if (runId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
  throw new Error('GENEWAY_RUN_ID is required for the Gate A0 secret scan');
}
const credentialPayloadPatterns = [
  /["'](?:access_token|refresh_token|id_token)["']\s*:\s*["'][^"']{8,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /authorization\s*:\s*bearer\s+[A-Za-z0-9._~-]{16,}/iu,
  /geneway-secret-canary-[a-f0-9]{48}/u,
];
const artifactBoundaryPatterns = [
  ...credentialPayloadPatterns,
  /\/home\/gewu\/\.codex\/auth\.json/u,
  /GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE/u,
];
const report = {
  schemaVersion: 'geneway-gate-a0-secret-scan/1',
  runId,
  status: 'passed',
  candidateSourceFilesScanned: 0,
  artifactFilesScanned: 0,
  archiveFilesScanned: 0,
  archiveEntriesScanned: 0,
  textPayloadsScanned: 0,
  binaryPayloadsChecked: 0,
  binaryExclusions: [],
  browserPublicBoundaryOracle: false,
};

function assertPatterns(bytes, label, patterns) {
  const text = bytes.toString('utf8');
  for (const pattern of patterns) {
    if (pattern.test(text)) throw new Error(`Gate A0 secret scan found forbidden credential material in ${label}`);
  }
}

function binaryKind(bytes, label) {
  const extension = extname(label).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.webm', '.mp4', '.woff', '.woff2'].includes(extension)) return extension.slice(1);
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if (bytes.subarray(0, 4).toString('ascii') === 'wOFF' || bytes.subarray(0, 4).toString('ascii') === 'wOF2') return 'font';
  if (bytes.byteLength >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  return null;
}

function scanPayload(bytes, label, patterns, boundary) {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`Gate A0 secret scan refuses oversized evidence payload ${label}`);
  assertPatterns(bytes, label, patterns);
  if (!bytes.includes(0)) {
    report.textPayloadsScanned += 1;
    return;
  }
  const kind = binaryKind(bytes, label);
  if (kind === null) throw new Error(`Gate A0 secret scan cannot safely parse binary evidence payload ${label}`);
  report.binaryPayloadsChecked += 1;
  if (boundary === 'artifact') {
    report.binaryExclusions.push({
      label,
      kind,
      equivalentOracle: 'browser-public-boundary-canary-and-sanitized-browser-process',
    });
  }
}

function scanZip(path) {
  const listing = spawnSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (listing.status !== 0 || typeof listing.stdout !== 'string') {
    throw new Error(`Gate A0 secret scan could not enumerate archive ${path}`);
  }
  report.archiveFilesScanned += 1;
  const entries = listing.stdout.split('\n').filter(Boolean);
  if (entries.length === 0 || entries.length > 20_000) throw new Error(`Gate A0 secret scan found an invalid archive entry count in ${path}`);
  for (const entry of entries) {
    if (entry.endsWith('/')) continue;
    const components = entry.split('/');
    if (entry.startsWith('/') || entry.startsWith('-') || components.includes('..') || entry.includes('\0')) {
      throw new Error(`Gate A0 secret scan rejected unsafe archive entry ${entry}`);
    }
    const extracted = spawnSync('unzip', ['-p', path, entry], { encoding: 'buffer', maxBuffer: MAX_FILE_BYTES + 1 });
    if (extracted.status !== 0 || !Buffer.isBuffer(extracted.stdout)) {
      throw new Error(`Gate A0 secret scan could not extract archive entry ${path}#${entry}`);
    }
    report.archiveEntriesScanned += 1;
    scanPayload(extracted.stdout, `${path}#${entry}`, artifactBoundaryPatterns, 'artifact');
  }
}

const candidateSources = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
for (const path of candidateSources) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error(`Gate A0 secret scan refuses tracked symlink ${path}`);
  if (!metadata.isFile()) continue;
  scanPayload(readFileSync(path), path, credentialPayloadPatterns, 'source');
  report.candidateSourceFilesScanned += 1;
}

const artifactRoot = `/tmp/geneway-runs/${runId}`;
const oraclePath = join(artifactRoot, 'secret-oracles', 'browser-public-boundary.json');
try {
  const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'));
  report.browserPublicBoundaryOracle = oracle.schemaVersion === 'geneway-browser-secret-oracle/1'
    && oracle.checked === true
    && oracle.publicResponseAndDomClean === true
    && oracle.browserReconnectFaultInjected === true
    && typeof oracle.canarySha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(oracle.canarySha256);
} catch {
  report.browserPublicBoundaryOracle = false;
}

const pending = [artifactRoot];
while (pending.length > 0) {
  const current = pending.pop();
  if (current === undefined) continue;
  const metadata = lstatSync(current);
  if (metadata.isSymbolicLink()) throw new Error(`Gate A0 secret scan refuses artifact symlink ${current}`);
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(current)) pending.push(join(current, entry));
    continue;
  }
  if (!metadata.isFile() || current.endsWith('/secret-scan.json')) continue;
  if (metadata.size > MAX_FILE_BYTES) throw new Error(`Gate A0 secret scan refuses oversized artifact ${current}`);
  report.artifactFilesScanned += 1;
  const bytes = readFileSync(current);
  const zip = current.toLowerCase().endsWith('.zip') || bytes.subarray(0, 4).toString('binary') === 'PK\u0003\u0004';
  if (zip) scanZip(current);
  else scanPayload(bytes, current, artifactBoundaryPatterns, 'artifact');
}

if (report.binaryExclusions.length > 0 && !report.browserPublicBoundaryOracle) {
  throw new Error('Gate A0 secret scan found binary browser evidence without the required public-boundary canary oracle');
}
writeFileSync(join(artifactRoot, 'secret-scan.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`geneway Gate A0 secret scan passed: ${artifactRoot}; files=${String(report.artifactFilesScanned)}, archives=${String(report.archiveFilesScanned)}, entries=${String(report.archiveEntriesScanned)}, binary=${String(report.binaryPayloadsChecked)}\n`);
