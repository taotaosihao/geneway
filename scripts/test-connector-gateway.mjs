import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

const arguments_ = process.argv.slice(2).filter((argument, index) => !(argument === '--' && index === 0));
if (arguments_.length !== 1 || arguments_[0] !== '--profile=gearjob-work-order-status') {
  throw new Error('test:connector-gateway requires exactly --profile=gearjob-work-order-status');
}
const runId = process.env.GENEWAY_RUN_ID ?? `gate-a3-connector-${String(Date.now())}-${String(process.pid)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
const evidenceDirectory = `/tmp/geneway-runs/${runId}/gate-a`;
const summaryPath = `${evidenceDirectory}/connector-gateway.json`;
const safeEnvironment = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/home/gewu',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: process.env.LANG ?? 'C.UTF-8',
  NODE_ENV: 'test',
};

function run(label, executable, commandArguments, environment = safeEnvironment) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(executable, commandArguments, {
    cwd: new URL('..', import.meta.url), env: environment, stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${String(result.status ?? 1)}`);
  return { label, startedAt, completedAt: new Date().toISOString(), exitCode: 0 };
}

mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
chmodSync(`/tmp/geneway-runs/${runId}`, 0o700);
chmodSync(evidenceDirectory, 0o700);
const targeted = run('strict connector profile contract and runtime', 'pnpm', ['exec', 'vitest', 'run',
  'packages/contracts/src/gate-a3-work-order.contract.test.ts',
  'services/connector-gateway/src',
  'apps/worker/src/gate-a3-work-order-runtime.test.ts',
  'services/model-gateway/src/gate-a-work-order.test.ts',
]);
const freshRepository = run('fresh Postgres connector authority integration', 'bash', [
  'scripts/with-storage.sh', 'pnpm', 'exec', 'vitest', 'run', '--no-file-parallelism',
  'apps/control-plane/src/gate-a3-work-order-repository.integration.test.ts',
], {
  ...safeEnvironment,
  GENEWAY_MANAGED_TEST_INFRA: '0',
  DATABASE_URL: 'postgres://forbidden:forbidden@192.0.2.1/forbidden',
  GENEWAY_S3_ENDPOINT: 'http://192.0.2.1:9',
});
const summary = {
  schemaVersion: 'geneway-gate-a3-connector-profile-verification/1',
  ok: true,
  runId,
  profile: 'gearjob-work-order-status',
  profileArgumentValidated: true,
  targeted,
  freshRepository,
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(summary)}\n`);
