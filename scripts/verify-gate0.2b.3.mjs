import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = new URL('..', import.meta.url);
const runId = process.env.GENEWAY_RUN_ID ?? `gate0.2b.3-${Date.now()}-${process.pid}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
const outputRoot = `/tmp/geneway-runs/${runId}`;
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

function run(command, options = {}) {
  const environment = { ...process.env, ...(options.env ?? {}) };
  for (const name of options.unsetEnvironment ?? []) delete environment[name];
  return spawnSync(command[0], command.slice(1), {
    cwd: repositoryRoot, encoding: options.encoding, stdio: options.stdio, maxBuffer: 32 * 1024 * 1024,
    env: environment,
  });
}

function sourceBinding() {
  const listed = run(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'buffer' });
  if (listed.status !== 0 || !Buffer.isBuffer(listed.stdout)) throw new Error('Unable to enumerate Gate 0.2B.3 source files');
  const files = listed.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const file of files) {
    const bytes = readFileSync(resolve(repositoryRoot.pathname, file));
    digest.update(`${Buffer.byteLength(file, 'utf8')}:${file}:${String(bytes.byteLength)}:`);
    digest.update(bytes);
  }
  const head = run(['git', 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) throw new Error('Unable to resolve Gate 0.2B.3 source HEAD');
  return { head: head.stdout.trim(), workspaceSha256: digest.digest('hex'), fileCount: files.length };
}

const forbiddenPaths = [
  'services/model-gateway', 'connectors/gearjob', 'infra/hatchet', 'apps/channel-gateway',
  'packages/evidence', 'packages/authorization', 'packages/storage',
];
const allowedWorkerRuntimePaths = new Set([
  'apps/worker/src/worker-loop.ts', 'apps/worker/src/interpreter.ts', 'apps/worker/src/worker-loop.test.ts',
  'packages/runtime/src/index.ts', 'packages/runtime/src/runtime.test.ts',
]);
const diffNames = run(['git', 'diff', '--name-only', 'e7dbd8e'], { encoding: 'utf8' });
const untrackedNames = run(['git', 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
if (diffNames.status !== 0 || untrackedNames.status !== 0) throw new Error('Unable to enumerate Gate 0.2B.3 changed paths');
const changedPaths = [...new Set(`${diffNames.stdout}\n${untrackedNames.stdout}`.split('\n').filter(Boolean))].sort();
const forbiddenChangedPaths = changedPaths.filter((file) => forbiddenPaths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
  || ((file.startsWith('apps/worker/') || file.startsWith('packages/runtime/')) && !allowedWorkerRuntimePaths.has(file)));
if (forbiddenChangedPaths.length > 0) {
  throw new Error(`Gate 0.2B.3 forbidden path diff detected:\n${forbiddenChangedPaths.join('\n')}`);
}
const authoredValidatorScan = run(['rg', '-n', '--glob', '!verify-gate0.2b.3.mjs',
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:ajv|@sinclair/typebox)(?:[/.'"]|$)|\bTypeBox\b`,
  'apps/control-plane', 'apps/web', 'packages/contracts', 'packages/workflow', 'scripts'], { encoding: 'utf8' });
if (![0, 1].includes(authoredValidatorScan.status ?? -1) || authoredValidatorScan.status === 0) {
  throw new Error(`Gate 0.2B.3 second authored validator/schema authority detected:\n${authoredValidatorScan.stdout}`);
}

const initialBinding = sourceBinding();
const steps = [
  ['lint', ['pnpm', 'lint']],
  ['typecheck', ['pnpm', 'typecheck']],
  ['unit', ['pnpm', 'test']],
  ['contracts', ['pnpm', 'test:contracts']],
  ['integration', ['pnpm', 'test:integration']],
  ['security', ['pnpm', 'test:security']],
  ['build', ['pnpm', 'build']],
  ['negative-states', ['pnpm', 'test:e2e', '--', '--project=gate0.2b-negative']],
  ['recovery', ['pnpm', 'test:e2e', '--', '--project=gate0.2b-recovery']],
  ['visual-desktop', ['pnpm', 'test:e2e', '--', '--project=gate0.2b-visual-desktop']],
  ['visual-narrow', ['pnpm', 'test:e2e', '--', '--project=gate0.2b-visual-narrow']],
  ['gate0.2a-regression', ['pnpm', 'verify:gate0.2a']],
  ['gate0.2b.1-regression', ['pnpm', 'verify:gate0.2b.1']],
];
const commandSafetyReceipt = {
  scannedCommands: steps.map(([, command]) => command.join(' ')),
  forbiddenPatterns: ['verify:gate-a0', 'model-gateway', 'provider', 'auth.json'],
};
const unsafeCommands = commandSafetyReceipt.scannedCommands.filter((command) =>
  commandSafetyReceipt.forbiddenPatterns.some((pattern) => command.includes(pattern)));
if (unsafeCommands.length > 0) throw new Error(`Gate 0.2B.3 live/auth command detected:\n${unsafeCommands.join('\n')}`);
const results = [];
let failed;
for (const [name, command] of steps) {
  const startedAt = new Date().toISOString();
  const result = name === 'gate0.2a-regression'
    ? run(command, { stdio: 'inherit', unsetEnvironment: ['GENEWAY_RUN_ID'] })
    : run(command, { stdio: 'inherit', env: { GENEWAY_RUN_ID: `${runId}-${name}` } });
  const record = { name, command: command.join(' '), startedAt, finishedAt: new Date().toISOString(), status: result.status, signal: result.signal };
  results.push(record);
  if (result.status !== 0) { failed = record; break; }
}
const finalBinding = sourceBinding();
const sourceStable = JSON.stringify(finalBinding) === JSON.stringify(initialBinding);
const passed = failed === undefined && sourceStable;
const summaryPath = `${outputRoot}/gate0.2b.3-aggregate.json`;
writeFileSync(summaryPath, `${JSON.stringify({
  schemaVersion: 'geneway-gate0.2b.3-aggregate/1', runId, passed, sourceStable,
  sourceBinding: finalBinding, requiredOrder: steps.map(([name]) => name), commandSafetyReceipt: { ...commandSafetyReceipt, passed: true },
  results, failed: failed ?? null,
}, null, 2)}\n`, { mode: 0o600 });
if (!passed) {
  process.stderr.write(`geneway Gate 0.2B.3 aggregate failed: ${summaryPath}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`geneway Gate 0.2B.3 aggregate passed: ${summaryPath}\n`);
}
