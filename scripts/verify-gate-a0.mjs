import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = new URL('..', import.meta.url);
const runId = process.env.GENEWAY_RUN_ID ?? `gate-a0-${Date.now()}-${process.pid}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
if (process.env.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE === undefined
  || process.env.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE === undefined) {
  throw new Error('verify:gate-a0 requires Model Gateway auth and conformance files');
}
const outputRoot = `/tmp/geneway-runs/${runId}`;
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

function sourceBinding() {
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  });
  if (listed.status !== 0 || !Buffer.isBuffer(listed.stdout)) throw new Error('Unable to enumerate Gate A0 source files');
  const files = listed.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const file of files) {
    const bytes = readFileSync(resolve(repositoryRoot.pathname, file));
    digest.update(`${Buffer.byteLength(file, 'utf8')}:${file}:${String(bytes.byteLength)}:`);
    digest.update(bytes);
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (head.status !== 0) throw new Error('Unable to resolve Gate A0 source HEAD');
  return { head: head.stdout.trim(), workspaceSha256: digest.digest('hex'), fileCount: files.length };
}

const initialBinding = sourceBinding();
const steps = [
  { name: 'lint', command: ['pnpm', 'lint'], runId: `${runId}-quality` },
  { name: 'typecheck', command: ['pnpm', 'typecheck'], runId: `${runId}-quality` },
  { name: 'unit', command: ['pnpm', 'test'], runId: `${runId}-quality` },
  { name: 'contracts', command: ['pnpm', 'test:contracts'], runId: `${runId}-quality` },
  { name: 'model-gateway', command: ['pnpm', 'test:model-gateway'], runId: `${runId}-quality` },
  { name: 'integration', command: ['pnpm', 'test:integration'], runId: `${runId}-quality` },
  { name: 'security', command: ['pnpm', 'test:security'], runId: `${runId}-quality` },
  { name: 'build', command: ['pnpm', 'build'], runId: `${runId}-quality` },
  { name: 'served-live', command: ['pnpm', 'test:e2e', '--', '--project=gate-a0-live'], runId: `${runId}-live` },
  { name: 'secret-scan', command: ['pnpm', 'gate-a0:secret-scan'], runId: `${runId}-live` },
  { name: 'actual-lan', command: ['pnpm', 'gate-a0:lan'], runId: `${runId}-lan` },
  { name: 'gate0.2b.1-regression', command: ['pnpm', 'verify:gate0.2b.1'], runId: `${runId}-regression` },
  { name: 'deferred-status-scan', command: ['pnpm', 'gate-a0:deferred-scan'], runId: `${runId}` },
];
const results = [];
let failed;
for (const step of steps) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(step.command[0], step.command.slice(1), {
    cwd: repositoryRoot,
    env: { ...process.env, GENEWAY_RUN_ID: step.runId },
    stdio: 'inherit',
  });
  const record = {
    name: step.name,
    command: step.command.join(' '),
    runId: step.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
  };
  results.push(record);
  if (result.status !== 0) {
    failed = record;
    break;
  }
}
const finalBinding = sourceBinding();
const sourceStable = JSON.stringify(finalBinding) === JSON.stringify(initialBinding);
const passed = failed === undefined && sourceStable;
const summaryPath = `${outputRoot}/gate-a0-aggregate.json`;
writeFileSync(summaryPath, `${JSON.stringify({
  schemaVersion: 'geneway-gate-a0-aggregate/1',
  runId,
  passed,
  sourceStable,
  sourceBinding: finalBinding,
  requiredOrder: steps.map((step) => step.name),
  results,
  failed: failed ?? null,
}, null, 2)}\n`, { mode: 0o600 });
if (!passed) {
  process.stderr.write(`geneway Gate A0 aggregate failed: ${summaryPath}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`geneway Gate A0 aggregate passed: ${summaryPath}\n`);
}
