import { spawnSync } from 'node:child_process';
import net from 'node:net';

async function findAvailablePort(excludedPorts = new Set()) {
  while (true) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Unable to allocate a local E2E port');
    const port = address.port;
    await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    if (!excludedPorts.has(port)) return port;
  }
}

const forwarded = process.argv.slice(2).filter((argument, index) => !(argument === '--' && index === 0));
const runId = process.env.GENEWAY_RUN_ID ?? `gate-0.1-${Date.now()}-${process.pid}`;
const allocatedPorts = new Set();
const allocatePort = async () => {
  const port = String(await findAvailablePort(allocatedPorts));
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535 || allocatedPorts.has(numericPort)) {
    throw new Error(`Invalid or duplicate E2E port: ${String(port)}`);
  }
  allocatedPorts.add(numericPort);
  return port;
};
const controlPlanePort = await allocatePort();
const webPort = await allocatePort();
const postgresPort = await allocatePort();
const s3Port = await allocatePort();
const storageAdapterPort = await allocatePort();
const composeRunId = runId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
const composeProjectName = `geneway-e2e-${composeRunId}`;
const databaseUrl = `postgres://geneway:geneway@127.0.0.1:${postgresPort}/geneway_test`;
const s3Endpoint = `http://127.0.0.1:${s3Port}`;
const baseEnvironment = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: process.env.LANG ?? 'C.UTF-8',
  NODE_ENV: 'test',
  ...(process.env.CI === undefined ? {} : { CI: process.env.CI }),
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
};
const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '-c', 'scripts/playwright.config.ts', ...forwarded], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...baseEnvironment,
    GENEWAY_RUN_ID: runId,
    GENEWAY_CONTROL_PLANE_PORT: controlPlanePort,
    GENEWAY_WEB_PORT: webPort,
    GENEWAY_POSTGRES_PORT: postgresPort,
    GENEWAY_S3_PORT: s3Port,
    GENEWAY_STORAGE_ADAPTER_PORT: storageAdapterPort,
    GENEWAY_MANAGED_TEST_INFRA: '1',
    DATABASE_URL: databaseUrl,
    GENEWAY_E2E_DATABASE_URL: databaseUrl,
    GENEWAY_S3_ENDPOINT: s3Endpoint,
    COMPOSE_PROJECT_NAME: composeProjectName,
  },
  stdio: 'inherit',
});
for (const [resource, listArguments, removeArguments] of [
  ['container', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${composeProjectName}`], ['rm', '-f']],
  ['volume', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${composeProjectName}`], ['volume', 'rm', '-f']],
  ['network', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${composeProjectName}`], ['network', 'rm']],
]) {
  const listed = spawnSync('docker', listArguments, { encoding: 'utf8' });
  if (listed.status !== 0) {
    console.error(`unable to list disposable ${resource} resources: ${listed.stderr}`);
    process.exit(1);
  }
  const identifiers = listed.stdout.trim().split(/\s+/u).filter(Boolean);
  if (identifiers.length > 0) {
    const removed = spawnSync('docker', [...removeArguments, ...identifiers], { encoding: 'utf8' });
    if (removed.status !== 0) {
      console.error(`unable to remove disposable ${resource} resources: ${removed.stderr}`);
      process.exit(1);
    }
  }
}
console.log(`geneway served-test artifacts: /tmp/geneway-runs/${runId}/`);
process.exit(result.status ?? 1);
