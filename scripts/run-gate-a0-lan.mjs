import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { parseLanHosts } from './dev-up.mjs';

const repositoryRoot = new URL('..', import.meta.url);
const runId = process.env.GENEWAY_RUN_ID ?? `gate-a0-lan-${Date.now()}-${process.pid}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
const authFile = process.env.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE;
const conformanceFile = process.env.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE;
if (authFile === undefined || conformanceFile === undefined) {
  throw new Error('Gate A0 LAN validation requires Model Gateway auth and conformance files');
}

const addressOutput = execFileSync('ip', ['-o', '-4', 'address', 'show', 'up', 'scope', 'global'], { encoding: 'utf8' });
const lanHosts = parseLanHosts(addressOutput);

async function portIsAvailable(hosts, port) {
  const servers = [];
  try {
    for (const host of hosts) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      servers.push(server);
    }
    return true;
  } catch {
    return false;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

async function findPort(hosts, excluded) {
  const start = 20_000 + Number.parseInt(randomBytes(2).toString('hex'), 16) % 30_000;
  for (let offset = 0; offset < 500; offset += 1) {
    const port = 1_024 + ((start + offset - 1_024) % (65_535 - 1_024));
    if (!excluded.has(port) && await portIsAvailable(hosts, port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new Error(`Unable to find a common port for ${hosts.join(', ')}`);
}

function postgresContainerIds() {
  const listed = spawnSync('docker', [
    'ps', '-q', '--filter', 'label=com.docker.compose.service=postgres',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error('Unable to enumerate disposable Postgres containers');
  return new Set(listed.stdout.split('\n').filter(Boolean));
}

function writeSourceBinding(outputDirectory) {
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  });
  if (listed.status !== 0 || !Buffer.isBuffer(listed.stdout)) throw new Error('Unable to enumerate LAN validation sources');
  const files = listed.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const file of files) {
    const bytes = readFileSync(resolve(repositoryRoot.pathname, file));
    digest.update(`${Buffer.byteLength(file, 'utf8')}:${file}:${String(bytes.byteLength)}:`);
    digest.update(bytes);
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (head.status !== 0) throw new Error('Unable to resolve LAN validation source HEAD');
  writeFileSync(`${outputDirectory}/source-binding.json`, `${JSON.stringify({
    schemaVersion: 'geneway-source-binding/1',
    runId,
    head: head.stdout.trim(),
    workspaceSha256: digest.digest('hex'),
    fileCount: files.length,
  })}\n`, { mode: 0o600 });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopDevUp(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGINT'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  if (await waitForExit(child, 30_000)) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  if (!await waitForExit(child, 5_000)) throw new Error('pnpm dev-up process group did not exit');
}

const excludedPorts = new Set();
const webPort = await findPort(lanHosts, excludedPorts);
const controlPlanePort = await findPort(['127.0.0.1'], excludedPorts);
const modelGatewayPort = await findPort(['127.0.0.1'], excludedPorts);
const releasePort = await findPort(['127.0.0.1'], excludedPorts);
const beforePostgres = postgresContainerIds();
const outputRoot = `/tmp/geneway-runs/${runId}`;
mkdirSync(`${outputRoot}/gate-a0-lan`, { recursive: true, mode: 0o700 });
writeSourceBinding(outputRoot);

let output = '';
let devUpRunId;
let ready = false;
let releaseReady;
let releaseFailed;
const readyPromise = new Promise((resolve, reject) => {
  releaseReady = resolve;
  releaseFailed = reject;
});
const devUp = spawn('pnpm', ['dev-up'], {
  cwd: repositoryRoot,
  detached: true,
  env: {
    ...process.env,
    GENEWAY_WEB_PORT: String(webPort),
    GENEWAY_CONTROL_PLANE_PORT: String(controlPlanePort),
    GENEWAY_MODEL_GATEWAY_PORT: String(modelGatewayPort),
    GENEWAY_GATE_A0_RELEASE_PORT: String(releasePort),
    GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE: authFile,
    GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE: conformanceFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const consume = (chunk, target) => {
  const text = chunk.toString('utf8');
  target.write(text);
  output = `${output}${text}`.slice(-2_000_000);
  devUpRunId ??= output.match(/\brun (dev-[A-Za-z0-9._-]+)\b/u)?.[1];
  if (!ready && output.includes('✓ geneway 开发环境已启动')) {
    ready = true;
    releaseReady();
  }
};
devUp.stdout.on('data', (chunk) => consume(chunk, process.stdout));
devUp.stderr.on('data', (chunk) => consume(chunk, process.stderr));
devUp.once('exit', (code, signal) => {
  if (!ready) releaseFailed(new Error(`pnpm dev-up exited before readiness: code=${String(code)} signal=${String(signal)}`));
});

let validationError;
try {
  await Promise.race([
    readyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for pnpm dev-up readiness')), 120_000)),
  ]);
  if (devUpRunId === undefined) throw new Error('pnpm dev-up did not expose its disposable run ID');
  const advertisedUrls = [...output.matchAll(/^\s+(http:\/\/(?:192\.168|10\.)[^\s]+\/conversations\/new)$/gmu)]
    .map((match) => match[1]);
  const expectedUrls = lanHosts.map((host) => `http://${host}:${String(webPort)}/conversations/new`);
  if (JSON.stringify(advertisedUrls) !== JSON.stringify(expectedUrls)) {
    throw new Error(`pnpm dev-up advertised unexpected URLs: ${JSON.stringify(advertisedUrls)}`);
  }

  const newPostgres = [...postgresContainerIds()].filter((id) => !beforePostgres.has(id));
  if (newPostgres.length !== 1) throw new Error(`Expected one disposable Postgres container, observed ${String(newPostgres.length)}`);
  const inspected = JSON.parse(execFileSync('docker', ['inspect', newPostgres[0]], { encoding: 'utf8' }));
  const binding = inspected[0]?.NetworkSettings?.Ports?.['5432/tcp']?.[0];
  if (binding?.HostIp !== '127.0.0.1' || !/^\d{2,5}$/u.test(binding.HostPort ?? '')) {
    throw new Error('Disposable Postgres was not published on an ephemeral loopback port');
  }
  const databaseUrl = `postgres://geneway:geneway@127.0.0.1:${binding.HostPort}/geneway_test`;
  const listenerOutput = execFileSync('ss', ['-H', '-ltn'], { encoding: 'utf8' });
  const requiredListeners = [
    ...lanHosts.map((host) => `${host}:${String(webPort)}`),
    `127.0.0.1:${String(controlPlanePort)}`,
    `127.0.0.1:${String(modelGatewayPort)}`,
    `127.0.0.1:${String(releasePort)}`,
  ];
  for (const listener of requiredListeners) {
    if (!listenerOutput.includes(listener)) throw new Error(`Required listener was not observed: ${listener}`);
  }
  for (const port of [webPort, controlPlanePort, modelGatewayPort, releasePort]) {
    if (listenerOutput.includes(`0.0.0.0:${String(port)}`) || listenerOutput.includes(`*:${String(port)}`)) {
      throw new Error(`Service port ${String(port)} unexpectedly listened on a wildcard address`);
    }
  }
  if (listenerOutput.includes(`127.0.0.1:${String(webPort)}`)) {
    throw new Error('Web unexpectedly listened on loopback instead of the discovered LAN addresses');
  }

  const authStat = statSync(authFile);
  const authParentStat = statSync(new URL('.', `file://${authFile}`).pathname);
  const listenerEvidence = {
    schemaVersion: 'geneway-gate-a0-lan-listeners/1',
    runId,
    devUpRunId,
    command: 'pnpm dev-up',
    lanHosts,
    advertisedUrls,
    listeners: {
      web: lanHosts.map((host) => ({ host, port: webPort })),
      controlPlane: { host: '127.0.0.1', port: controlPlanePort },
      modelGateway: { host: '127.0.0.1', port: modelGatewayPort },
      releaseAuthority: { host: '127.0.0.1', port: releasePort },
      worker: 'unix-domain-socket',
      postgres: { host: '127.0.0.1', port: Number(binding.HostPort) },
    },
    wildcardListenerObserved: false,
    credentialBoundary: {
      parentMode: (authParentStat.mode & 0o777).toString(8),
      fileMode: (authStat.mode & 0o777).toString(8),
      sameOwner: authParentStat.uid === authStat.uid,
      browserEnvironmentIsolated: true,
    },
  };
  writeFileSync(`${outputRoot}/gate-a0-lan/listeners.json`, `${JSON.stringify(listenerEvidence, null, 2)}\n`, { mode: 0o600 });

  const lanBaseUrl = `http://${lanHosts[0]}:${String(webPort)}`;
  const secretCanary = `geneway-secret-canary-${randomBytes(24).toString('hex')}`;
  const playwright = spawnSync('pnpm', [
    'exec', 'playwright', 'test', '-c', 'scripts/playwright.lan.config.ts', '--project=gate-a0-lan',
  ], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: process.env.LANG ?? 'C.UTF-8',
      GENEWAY_RUN_ID: runId,
      GENEWAY_DEV_UP_RUN_ID: devUpRunId,
      GENEWAY_LAN_BASE_URL: lanBaseUrl,
      GENEWAY_E2E_DATABASE_URL: databaseUrl,
      GENEWAY_E2E_SECRET_CANARY: secretCanary,
    },
    stdio: 'inherit',
  });
  if (playwright.status !== 0) throw new Error(`Gate A0 LAN Playwright failed with status ${String(playwright.status)}`);
  const reportGate = spawnSync('pnpm', [
    'exec', 'tsx', 'scripts/e2e-report-gate.ts',
    `${outputRoot}/gate-a0-lan/playwright-report.json`, JSON.stringify(['--project=gate-a0-lan']),
  ], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: process.env.LANG ?? 'C.UTF-8',
      GENEWAY_RUN_ID: runId,
    },
    stdio: 'inherit',
  });
  if (reportGate.status !== 0) throw new Error(`Gate A0 LAN report gate failed with status ${String(reportGate.status)}`);
  const secretScan = spawnSync('node', ['scripts/gate-a0-secret-scan.mjs'], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: process.env.LANG ?? 'C.UTF-8',
      GENEWAY_RUN_ID: runId,
    },
    stdio: 'inherit',
  });
  if (secretScan.status !== 0) throw new Error(`Gate A0 LAN secret scan failed with status ${String(secretScan.status)}`);
} catch (error) {
  validationError = error;
} finally {
  await stopDevUp(devUp);
}

if (validationError !== undefined) throw validationError;
process.stdout.write(`geneway Gate A0 LAN validation passed: ${outputRoot}/gate-a0-lan\n`);
