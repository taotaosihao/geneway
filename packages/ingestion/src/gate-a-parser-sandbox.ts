import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  digestGateAParserManifest,
  gateAParserManifestSchema,
  verifyGateAParserManifestDigest,
  type GateAParserManifest,
} from '@geneway/contracts';

const MAX_BYTES = 1_048_576;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1_024;
const BASE_IMAGE_DIGEST = '25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c';
const PARSER_PATH = '/opt/geneway-parser/plain-text-parser.mjs';
const NODE_PATH = '/usr/local/bin/node';
const safeImage = /^geneway-plain-text-parser:[a-f0-9]{16}$/u;
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export type GateAParserProcessReceipt = Readonly<{
  schemaVersion: 'gate-a-parser-process-receipt/1';
  imageId: string;
  networkMode: 'none';
  readOnlyRootFilesystem: true;
  uid: 65_534;
  gid: 65_534;
  capabilities: readonly [];
  noNewPrivileges: true;
  pidsLimit: 16;
  memoryLimitBytes: 67_108_864;
  cpuLimit: 0.5;
  inputMountCount: 1;
  outputMountCount: 1;
}>;

export type GateAParsedCanonicalText = Readonly<{
  canonicalBytes: Uint8Array;
  canonicalTextSha256: string;
  parserManifest: GateAParserManifest;
  parserDigest: string;
  processReceipt: GateAParserProcessReceipt;
}>;

type CommandResult = Readonly<{ stdout: string; stderr: string }>;
export type GateAParserCommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

const defaultCommandRunner: GateAParserCommandRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  const finish = (effect: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    effect();
  };
  const collect = (target: Buffer[]) => (chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
      child.kill('SIGKILL');
      finish(() => reject(new Error('Gate A parser command output exceeded its bound')));
    } else target.push(chunk);
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  child.once('error', (error) => finish(() => reject(error)));
  child.once('close', (code) => finish(() => {
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    if (code === 0) resolve({ stdout: out, stderr: err });
    else reject(new Error(`Gate A parser command failed (${String(code ?? 1)}): ${err.slice(0, 1_000)}`));
  }));
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(() => reject(new Error('Gate A parser command timed out')));
  }, timeoutMs);
});

type ImageInspection = Readonly<{
  Id?: unknown;
  Config?: Readonly<{
    Labels?: Readonly<Record<string, unknown>>;
    User?: unknown;
    Entrypoint?: unknown;
  }>;
}>;


function parseDigestOutput(stdout: string): Readonly<{ executableDigest: string; packageDigest: string }> {
  const lines = stdout.trim().split('\n');
  if (lines.length !== 2) throw new Error('Gate A parser digest probe returned an invalid line count');
  const parseLine = (line: string, expectedPath: string): string => {
    const match = /^([a-f0-9]{64}) {2}(\/[A-Za-z0-9._/-]+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] !== expectedPath) {
      throw new Error('Gate A parser digest probe returned an invalid identity');
    }
    return match[1];
  };
  return {
    executableDigest: parseLine(lines[0] ?? '', NODE_PATH),
    packageDigest: parseLine(lines[1] ?? '', PARSER_PATH),
  };
}

function processReceipt(imageId: string): GateAParserProcessReceipt {
  return Object.freeze({
    schemaVersion: 'gate-a-parser-process-receipt/1',
    imageId,
    networkMode: 'none',
    readOnlyRootFilesystem: true,
    uid: 65_534,
    gid: 65_534,
    capabilities: [] as const,
    noNewPrivileges: true,
    pidsLimit: 16,
    memoryLimitBytes: 67_108_864,
    cpuLimit: 0.5,
    inputMountCount: 1,
    outputMountCount: 1,
  });
}

export class GateAPlainTextParserSandbox {
  constructor(
    private readonly image: string,
    private readonly approval: Readonly<{
      approvedBy: string;
      approvedAt: string;
      expiresAt: string;
    }>,
    private readonly runCommand: GateAParserCommandRunner = defaultCommandRunner,
  ) {
    if (!safeImage.test(image)) throw new Error('Gate A parser image reference is invalid');
  }

  async resolveManifest(): Promise<Readonly<{
    imageId: string;
    manifest: GateAParserManifest;
  }>> {
    const inspected = await this.runCommand('docker', ['image', 'inspect', this.image], 5_000);
    const parsed = JSON.parse(inspected.stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('Gate A parser image inspection was invalid');
    const inspection = parsed[0] as ImageInspection;
    const imageId = typeof inspection.Id === 'string' ? inspection.Id : '';
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error('Gate A parser image ID was invalid');
    const labels = inspection.Config?.Labels ?? {};
    if (labels['org.geneway.parser.name'] !== 'geneway-plain-text-parser'
      || labels['org.geneway.parser.version'] !== '1.0.0'
      || labels['org.geneway.parser.base-digest'] !== `sha256:${BASE_IMAGE_DIGEST}`
      || typeof labels['org.geneway.parser.package-digest'] !== 'string') {
      throw new Error('Gate A parser image labels were invalid');
    }
    const expectedEntrypoint = [
      'node',
      '--permission',
      '--allow-fs-read=/input/source',
      '--allow-fs-read=/opt/geneway-parser/plain-text-parser.mjs',
      '--allow-fs-write=/output/canonical.bin',
      '--no-addons',
      PARSER_PATH,
    ];
    if (inspection.Config?.User !== '65534:65534'
      || JSON.stringify(inspection.Config.Entrypoint) !== JSON.stringify(expectedEntrypoint)) {
      throw new Error('Gate A parser image execution identity was invalid');
    }
    const probed = await this.runCommand('docker', [
      'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '16', '--memory', '64m', '--cpus', '0.5',
      '--user', '65534:65534', '--entrypoint', 'sha256sum', imageId, NODE_PATH, PARSER_PATH,
    ], 10_000);
    const digests = parseDigestOutput(probed.stdout);
    if (digests.packageDigest !== labels['org.geneway.parser.package-digest']) {
      throw new Error('Gate A parser package bytes do not match the image label');
    }
    const unsignedManifest = {
      schemaVersion: 'parser-manifest.gate-a/1' as const,
      id: `parser_plain_text_1_${digests.packageDigest.slice(0, 12)}_${imageId.slice(-12)}`,
      mediaType: 'text/plain' as const,
      parser: {
        name: 'geneway-plain-text-parser' as const,
        version: '1.0.0' as const,
        registrySource: 'geneway-workspace' as const,
        upstreamSource: 'geneway://packages/ingestion/plain-text-parser' as const,
        lockResolution: `docker-image:${imageId}`,
        lockIntegrity: imageId.slice('sha256:'.length),
        executableDigest: digests.executableDigest,
        packageDigest: digests.packageDigest,
        license: 'UNLICENSED-internal' as const,
      },
      dependencies: [{
        name: 'node',
        version: '22.21.1',
        registrySource: 'docker.io/library/node',
        upstreamSource: `node:22.21.1-bookworm-slim@sha256:${BASE_IMAGE_DIGEST}`,
        lockResolution: `node@sha256:${BASE_IMAGE_DIGEST}`,
        lockIntegrity: BASE_IMAGE_DIGEST,
        packageDigest: digests.executableDigest,
        license: 'MIT',
      }],
      conversionConfig: {
        inputEncoding: 'UTF-8' as const,
        outputEncoding: 'UTF-8' as const,
        unicodeNormalization: 'none' as const,
        newlineNormalization: 'none' as const,
        stripByteOrderMark: false as const,
        maxInputBytes: MAX_BYTES as 1_048_576,
        maxOutputBytes: MAX_BYTES as 1_048_576,
      },
      resourceLimitsVersion: 'gate-a-parser-limits/1' as const,
      approvedBy: this.approval.approvedBy,
      approvedAt: this.approval.approvedAt,
      expiresAt: this.approval.expiresAt,
    };
    const manifestDigest = await digestGateAParserManifest(unsignedManifest);
    const manifest = gateAParserManifestSchema.parse({ ...unsignedManifest, manifestDigest });
    if (!await verifyGateAParserManifestDigest(manifest)) throw new Error('Gate A parser manifest self-verification failed');
    return { imageId, manifest };
  }

  async parse(bytes: Uint8Array): Promise<GateAParsedCanonicalText> {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) throw new Error('Gate A parser input exceeds its byte bound');
    const { imageId, manifest } = await this.resolveManifest();
    if (Date.parse(manifest.expiresAt) <= Date.now()) throw new Error('Gate A parser manifest is expired');
    const runRoot = await mkdtemp('/tmp/geneway-parser-');
    const inputDirectory = join(runRoot, 'input');
    const outputDirectory = join(runRoot, 'output');
    const inputPath = join(inputDirectory, 'source');
    const outputPath = join(outputDirectory, 'canonical.bin');
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(inputDirectory, { mode: 0o755 });
      await mkdir(outputDirectory, { mode: 0o777 });
      await chmod(runRoot, 0o755);
      await chmod(inputDirectory, 0o755);
      await chmod(outputDirectory, 0o777);
      const handle = await open(inputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      await chmod(inputPath, 0o444);
      const run = await this.runCommand('docker', [
        'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '16', '--memory', '64m', '--cpus', '0.5',
        '--user', '65534:65534', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=4m',
        '--mount', `type=bind,src=${inputPath},dst=/input/source,readonly`,
        '--mount', `type=bind,src=${outputDirectory},dst=/output`,
        imageId,
      ], 10_000);
      const reported = JSON.parse(run.stdout) as Readonly<Record<string, unknown>>;
      const outputStat = await lstat(outputPath);
      if (!outputStat.isFile() || outputStat.isSymbolicLink() || (outputStat.mode & 0o777) !== 0o444
        || outputStat.uid !== 65_534 || outputStat.gid !== 65_534
        || outputStat.size < 1 || outputStat.size > MAX_BYTES) {
        throw new Error('Gate A parser output authority was invalid');
      }
      const canonicalBytes = await readFile(outputPath);
      const canonicalTextSha256 = sha256(canonicalBytes);
      if (reported.schemaVersion !== 'geneway-plain-text-parser-result/1'
        || reported.inputBytes !== bytes.byteLength || reported.outputBytes !== canonicalBytes.byteLength
        || reported.canonicalTextSha256 !== canonicalTextSha256
        || canonicalBytes.byteLength !== bytes.byteLength
        || !Buffer.from(canonicalBytes).equals(Buffer.from(bytes))) {
        throw new Error('Gate A parser output did not match the byte-exact contract');
      }
      return {
        canonicalBytes,
        canonicalTextSha256,
        parserManifest: manifest,
        parserDigest: manifest.manifestDigest,
        processReceipt: processReceipt(imageId),
      };
    } finally {
      if (/^\/tmp\/geneway-parser-[A-Za-z0-9]+$/u.test(runRoot)) {
        await rm(runRoot, { recursive: true, force: true });
      }
    }
  }
}
