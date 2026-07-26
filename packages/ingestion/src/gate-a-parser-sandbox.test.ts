import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, chown, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GateAPlainTextParserSandbox,
  type GateAParserCommandRunner,
} from './gate-a-parser-sandbox.js';

const image = 'geneway-plain-text-parser:0123456789abcdef';
const imageId = 'sha256:' + 'a'.repeat(64);
const executableDigest = 'b'.repeat(64);
const packageDigest = 'c'.repeat(64);
const baseDigest = '25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const approval = {
  approvedBy: 'user_local',
  approvedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function localParserImageTag(): string {
  const printed = spawnSync(process.execPath, [
    'scripts/build-gate-a-parser-image.mjs',
    '--print-tag',
  ], {
    cwd: process.cwd(),
    env: {},
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (printed.error !== undefined) throw printed.error;
  if (printed.status !== 0) {
    throw new Error('Gate A parser local image tag calculation failed: ' + printed.stderr.trim());
  }
  const tag = printed.stdout.trim();
  if (!/^geneway-plain-text-parser:[a-f0-9]{16}$/u.test(tag)) {
    throw new Error('Gate A parser local image tag calculation returned an invalid tag');
  }
  return tag;
}

type Invocation = Readonly<{ command: string; args: readonly string[]; timeoutMs: number }>;

function imageInspection(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify([{
    Id: imageId,
    Config: {
      User: '65534:65534',
      Entrypoint: [
        'node',
        '--permission',
        '--allow-fs-read=/input/source',
        '--allow-fs-read=/opt/geneway-parser/plain-text-parser.mjs',
        '--allow-fs-write=/output/canonical.bin',
        '--no-addons',
        '/opt/geneway-parser/plain-text-parser.mjs',
      ],
      Labels: {
        'org.geneway.parser.name': 'geneway-plain-text-parser',
        'org.geneway.parser.version': '1.0.0',
        'org.geneway.parser.base-digest': 'sha256:' + baseDigest,
        'org.geneway.parser.package-digest': packageDigest,
        ...overrides,
      },
    },
  }]);
}

function mountSource(args: readonly string[], destination: string): string {
  const mount = args.find((value) => value.startsWith('type=bind,') && value.includes('dst=' + destination));
  const source = /(?:^|,)src=([^,]+)/u.exec(mount ?? '')?.[1];
  if (source === undefined) throw new Error('test runner did not receive the expected mount');
  return source;
}

function runner(input: Readonly<{
  invocations: Invocation[];
  tamperOutput?: boolean;
  parseFailure?: Error;
  labels?: Readonly<Record<string, unknown>>;
}>): GateAParserCommandRunner {
  return async (command, args, timeoutMs) => {
    input.invocations.push({ command, args, timeoutMs });
    if (args[0] === 'image') return { stdout: imageInspection(input.labels), stderr: '' };
    if (args.includes('sha256sum')) {
      return {
        stdout: executableDigest + '  /usr/local/bin/node\n'
          + packageDigest + '  /opt/geneway-parser/plain-text-parser.mjs\n',
        stderr: '',
      };
    }
    if (input.parseFailure !== undefined) throw input.parseFailure;
    const inputPath = mountSource(args, '/input/source');
    const outputDirectory = mountSource(args, '/output');
    const bytes = await readFile(inputPath);
    const output = input.tamperOutput ? Buffer.from('tampered') : bytes;
    const outputPath = outputDirectory + '/canonical.bin';
    await writeFile(outputPath, output, { flag: 'wx', mode: 0o444 });
    await chmod(outputPath, 0o444);
    await chown(outputPath, 65_534, 65_534);
    return {
      stdout: JSON.stringify({
        schemaVersion: 'geneway-plain-text-parser-result/1',
        inputBytes: bytes.byteLength,
        outputBytes: output.byteLength,
        canonicalTextSha256: sha256(output),
      }),
      stderr: '',
    };
  };
}

describe('Gate A plain-text Docker sandbox contract', () => {
  const runRoots: string[] = [];
  afterEach(async () => {
    for (const root of runRoots.splice(0)) {
      await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.runIf(process.getuid?.() === 0)('returns exact bytes and proves the frozen no-network/no-secret process authority', async () => {
    const invocations: Invocation[] = [];
    const bytes = new TextEncoder().encode('NFC e\u0301 / CRLF\r\n / 多字节字符');
    const sandbox = new GateAPlainTextParserSandbox(image, approval, runner({ invocations }));
    const parsed = await sandbox.parse(bytes);
    expect(Buffer.from(parsed.canonicalBytes)).toEqual(Buffer.from(bytes));
    expect(parsed.canonicalTextSha256).toBe(sha256(bytes));
    expect(parsed.parserDigest).toBe(parsed.parserManifest.manifestDigest);
    expect(parsed.processReceipt).toEqual({
      schemaVersion: 'gate-a-parser-process-receipt/1',
      imageId,
      networkMode: 'none',
      readOnlyRootFilesystem: true,
      uid: 65_534,
      gid: 65_534,
      capabilities: [],
      noNewPrivileges: true,
      pidsLimit: 16,
      memoryLimitBytes: 67_108_864,
      cpuLimit: 0.5,
      inputMountCount: 1,
      outputMountCount: 1,
    });
    const parseRun = invocations.at(-1);
    expect(parseRun?.command).toBe('docker');
    expect(parseRun?.args).toEqual(expect.arrayContaining([
      'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '16',
      '--memory', '64m', '--cpus', '0.5', '--user', '65534:65534',
    ]));
    expect(parseRun?.args.join(' ')).not.toContain('SECRET');
    expect(parseRun?.args.join(' ')).not.toContain('--env');
    expect(parseRun?.args.join(' ')).not.toContain('--pull');
    const mounted = mountSource(parseRun?.args ?? [], '/input/source');
    runRoots.push(mounted.replace(/\/input\/source$/u, ''));
  });

  it('rejects an image-label/package identity mismatch before parsing', async () => {
    const invocations: Invocation[] = [];
    const sandbox = new GateAPlainTextParserSandbox(image, approval, runner({
      invocations,
      labels: { 'org.geneway.parser.package-digest': 'd'.repeat(64) },
    }));
    await expect(sandbox.parse(new TextEncoder().encode('material'))).rejects.toThrow(
      'package bytes do not match the image label',
    );
    expect(invocations).toHaveLength(2);
  });

  it('fails closed and removes the one-shot directory after container crash or timeout', async () => {
    for (const failure of [new Error('container crash'), new Error('Gate A parser command timed out')]) {
      const invocations: Invocation[] = [];
      const sandbox = new GateAPlainTextParserSandbox(image, approval, runner({
        invocations,
        parseFailure: failure,
      }));
      await expect(sandbox.parse(new TextEncoder().encode('material'))).rejects.toThrow(failure.message);
      const parseRun = invocations.at(-1);
      const mounted = mountSource(parseRun?.args ?? [], '/input/source');
      await expect(lstat(mounted.replace(/\/input\/source$/u, ''))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.runIf(process.getuid?.() === 0)('rejects output byte drift and cleans the temporary authority', async () => {
    const invocations: Invocation[] = [];
    const sandbox = new GateAPlainTextParserSandbox(image, approval, runner({
      invocations,
      tamperOutput: true,
    }));
    await expect(sandbox.parse(new TextEncoder().encode('original material'))).rejects.toThrow(
      'output did not match the byte-exact contract',
    );
    const mounted = mountSource(invocations.at(-1)?.args ?? [], '/input/source');
    await expect(lstat(mounted.replace(/\/input\/source$/u, ''))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['empty', new Uint8Array()],
    ['oversize', new Uint8Array(1_048_577)],
  ])('rejects %s input before any Docker command', async (_name, bytes) => {
    const invocations: Invocation[] = [];
    const sandbox = new GateAPlainTextParserSandbox(image, approval, runner({ invocations }));
    await expect(sandbox.parse(bytes)).rejects.toThrow('input exceeds its byte bound');
    expect(invocations).toHaveLength(0);
  });
});
describe('Gate A plain-text real local Docker image', () => {
  it('runs the source-derived local image against the real text/plain rejection corpus', async () => {
    const dockerImage = process.env.GENEWAY_GATE_A_PARSER_TEST_IMAGE
      ?? localParserImageTag();
    const sandbox = new GateAPlainTextParserSandbox(dockerImage, approval);
    const before = new Set((await readdir('/tmp')).filter((name) => name.startsWith('geneway-parser-')));
    const previousSecret = process.env.GENEWAY_PARSER_HOST_SECRET_SENTINEL;
    process.env.GENEWAY_PARSER_HOST_SECRET_SENTINEL = 'must-never-enter-parser-container';
    try {
      const valid = new TextEncoder().encode('byte-exact CRLF\r\nNFD e\u0301 与多字节字符\n');
      const parsed = await sandbox.parse(valid);
      expect(Buffer.from(parsed.canonicalBytes)).toEqual(Buffer.from(valid));
      expect(parsed.canonicalTextSha256).toBe(sha256(valid));
      expect(parsed.processReceipt).toMatchObject({
        networkMode: 'none',
        readOnlyRootFilesystem: true,
        uid: 65_534,
        gid: 65_534,
        capabilities: [],
        noNewPrivileges: true,
        inputMountCount: 1,
        outputMountCount: 1,
      });
      expect(Buffer.from(parsed.canonicalBytes).toString('utf8')).not.toContain(
        'must-never-enter-parser-container',
      );

      const rejected: readonly Uint8Array[] = [
        Uint8Array.of(0xef, 0xbb, 0xbf, 0x61),
        Uint8Array.of(0x61, 0x00, 0x62),
        Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d),
        Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x00),
        Uint8Array.of(0xc3, 0x28),
        Uint8Array.of(0x61, 0x01, 0x62),
      ];
      for (const bytes of rejected) {
        await expect(sandbox.parse(bytes)).rejects.toThrow();
      }
      await expect(sandbox.parse(new Uint8Array(1_048_577))).rejects.toThrow(
        'input exceeds its byte bound',
      );
    } finally {
      if (previousSecret === undefined) delete process.env.GENEWAY_PARSER_HOST_SECRET_SENTINEL;
      else process.env.GENEWAY_PARSER_HOST_SECRET_SENTINEL = previousSecret;
    }
    const after = (await readdir('/tmp')).filter((name) => name.startsWith('geneway-parser-'));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  }, 120_000);
});
