import { spawnSync } from 'node:child_process';
import net from 'node:net';

async function findAvailablePort(excludedPort) {
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
    if (port !== excludedPort) return port;
  }
}

const forwarded = process.argv.slice(2).filter((argument, index) => !(argument === '--' && index === 0));
const runId = process.env.GENEWAY_RUN_ID ?? `gate-0.1-${Date.now()}-${process.pid}`;
const controlPlanePort = process.env.GENEWAY_CONTROL_PLANE_PORT ?? String(await findAvailablePort());
const webPort = process.env.GENEWAY_WEB_PORT ?? String(await findAvailablePort(Number(controlPlanePort)));
const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '-c', 'scripts/playwright.config.ts', ...forwarded], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    GENEWAY_RUN_ID: runId,
    GENEWAY_CONTROL_PLANE_PORT: controlPlanePort,
    GENEWAY_WEB_PORT: webPort,
  },
  stdio: 'inherit',
});
console.log(`Gate 0.1 raw artifacts: /tmp/geneway-runs/${runId}/`);
process.exit(result.status ?? 1);
