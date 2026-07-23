import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

async function createRun(): Promise<Readonly<{ root: string; runId: string }>> {
  const root = await mkdtemp('/tmp/geneway-runs/secret-scan-test-');
  await mkdir(join(root, 'secret-oracles'));
  await writeFile(join(root, 'secret-oracles', 'browser-public-boundary.json'), JSON.stringify({
    schemaVersion: 'geneway-browser-secret-oracle/1',
    checked: true,
    publicResponseAndDomClean: true,
    browserReconnectFaultInjected: true,
    canarySha256: 'a'.repeat(64),
  }));
  return { root, runId: basename(root) };
}

describe('Gate A0 evidence secret scan', () => {
  it('extracts and scans Playwright trace ZIP entries and writes an auditable inventory', async () => {
    const run = await createRun();
    const source = await mkdtemp('/tmp/geneway-secret-scan-source-');
    try {
      await writeFile(join(source, '0-trace.network'), '{"public":"clean"}\n');
      await execute('zip', ['-q', join(run.root, 'trace.zip'), '0-trace.network'], { cwd: source });
      await execute(process.execPath, ['scripts/gate-a0-secret-scan.mjs'], {
        cwd: repositoryRoot,
        env: { ...process.env, GENEWAY_RUN_ID: run.runId },
      });
      const report = JSON.parse(await readFile(join(run.root, 'secret-scan.json'), 'utf8')) as {
        candidateSourceFilesScanned: number; archiveFilesScanned: number;
        archiveEntriesScanned: number; browserPublicBoundaryOracle: boolean;
      };
      const candidates = await execute('git', ['ls-files', '-co', '--exclude-standard'], {
        cwd: repositoryRoot, encoding: 'utf8',
      });
      const candidateCount = candidates.stdout.split('\n').filter(Boolean).length;
      expect(report).toMatchObject({ archiveFilesScanned: 1, archiveEntriesScanned: 1, browserPublicBoundaryOracle: true });
      expect(report.candidateSourceFilesScanned).toBe(candidateCount);
    } finally {
      await rm(run.root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  it('fails closed when a trace entry contains credential material', async () => {
    const run = await createRun();
    const source = await mkdtemp('/tmp/geneway-secret-scan-source-');
    try {
      const tokenField = ['access', 'token'].join('_');
      await writeFile(join(source, '0-trace.network'), JSON.stringify({ [tokenField]: 'credential-payload-must-be-rejected' }));
      await execute('zip', ['-q', join(run.root, 'trace.zip'), '0-trace.network'], { cwd: source });
      let rejected = false;
      try {
        await execute(process.execPath, ['scripts/gate-a0-secret-scan.mjs'], {
          cwd: repositoryRoot,
          env: { ...process.env, GENEWAY_RUN_ID: run.runId },
        });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      await rm(run.root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  it('fails closed when an untracked non-ignored candidate source contains credential material', async () => {
    const run = await createRun();
    const candidatePath = join(repositoryRoot, `.geneway-secret-scan-untracked-${String(process.pid)}.tmp`);
    try {
      const tokenField = ['refresh', 'token'].join('_');
      await writeFile(candidatePath, JSON.stringify({ [tokenField]: 'untracked-credential-payload-must-be-rejected' }));
      let rejected = false;
      try {
        await execute(process.execPath, ['scripts/gate-a0-secret-scan.mjs'], {
          cwd: repositoryRoot,
          env: { ...process.env, GENEWAY_RUN_ID: run.runId },
        });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      await rm(candidatePath, { force: true });
      await rm(run.root, { recursive: true, force: true });
    }
  });
});
