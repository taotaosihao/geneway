import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const HELP = `用法: pnpm dev-up

启动一次性的 geneway 本地验收栈，并把 Web 暴露到局域网：
  Web                  <局域网 IPv4>:3200（默认，占用时自动顺延）
  Control Plane        127.0.0.1:3100（默认，占用时自动顺延）
  PostgreSQL / storage 随机 loopback 端口
  Worker               本机 Unix-domain socket

环境变量：
  GENEWAY_DEV_LAN_HOST           覆盖自动识别的局域网 IPv4
  GENEWAY_WEB_PORT               覆盖 Web 端口
  GENEWAY_CONTROL_PLANE_PORT     覆盖 Control Plane 端口

按 Ctrl+C 停止全部进程并删除本次临时数据库、对象存储和 Worker 凭据。
`;

function parsePort(environment, name, fallback) {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return value;
}

function assertUsableIpv4(value, source) {
  if (!net.isIPv4(value)) throw new Error(`${source} must be an IPv4 address`);
  const [first, second] = value.split('.').map(Number);
  const isPrivate = first === 10
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
  if (!isPrivate) {
    throw new Error(`${source} must be an RFC1918 private IPv4 address`);
  }
  return value;
}

function detectLanHost() {
  let routes;
  try {
    routes = execFileSync('ip', ['-4', 'route', 'show', 'default'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error('Unable to inspect the default IPv4 route; set GENEWAY_DEV_LAN_HOST explicitly', { cause: error });
  }
  const sourceAddress = routes.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b/u)?.[1];
  if (sourceAddress !== undefined) return assertUsableIpv4(sourceAddress, 'Detected LAN host');

  const device = routes.match(/\bdev\s+(\S+)\b/u)?.[1];
  if (device === undefined || !/^[A-Za-z0-9_.:-]+$/u.test(device)) {
    throw new Error('Default IPv4 route has no safe device or source address; set GENEWAY_DEV_LAN_HOST explicitly');
  }
  let addresses;
  try {
    addresses = execFileSync('ip', ['-o', '-4', 'address', 'show', 'dev', device, 'scope', 'global'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`Unable to inspect IPv4 addresses for ${device}; set GENEWAY_DEV_LAN_HOST explicitly`, { cause: error });
  }
  const address = addresses.match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\//u)?.[1];
  if (address === undefined) throw new Error(`No global IPv4 address found on ${device}; set GENEWAY_DEV_LAN_HOST explicitly`);
  return assertUsableIpv4(address, 'Detected LAN host');
}

function readConfiguration(environment) {
  const webPort = parsePort(environment, 'GENEWAY_WEB_PORT', 3200);
  const controlPlanePort = parsePort(environment, 'GENEWAY_CONTROL_PLANE_PORT', 3100);
  if (webPort === controlPlanePort) throw new Error('GENEWAY_WEB_PORT and GENEWAY_CONTROL_PLANE_PORT must be different');
  const lanHost = environment.GENEWAY_DEV_LAN_HOST === undefined
    ? detectLanHost()
    : assertUsableIpv4(environment.GENEWAY_DEV_LAN_HOST, 'GENEWAY_DEV_LAN_HOST');
  const localOrigins = [`http://localhost:${String(webPort)}`, `http://127.0.0.1:${String(webPort)}`];
  const publicOrigin = `http://${lanHost}:${String(webPort)}`;
  return {
    lanHost,
    webBindHost: lanHost,
    webPort,
    controlPlaneBindHost: '127.0.0.1',
    controlPlanePort,
    allowedWebOrigins: [...localOrigins, publicOrigin],
    publicUrl: `${publicOrigin}/conversations/new?capability=solution.analysis.v1`,
  };
}

function minimalEnvironment() {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
}

async function portIsAvailable(host, port) {
  const server = net.createServer();
  const available = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, host, resolve);
  });
  if (available === false) return false;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return true;
}

async function resolvePort(host, preferredPort, explicit, label) {
  if (await portIsAvailable(host, preferredPort)) return preferredPort;
  if (explicit) throw new Error(`${label} port ${host}:${String(preferredPort)} is unavailable`);
  for (let port = preferredPort + 1; port <= Math.min(preferredPort + 99, 65_535); port += 1) {
    if (await portIsAvailable(host, port)) return port;
  }
  throw new Error(`No available ${label} port found from ${String(preferredPort)} to ${String(preferredPort + 99)}`);
}

function processGroupExists(child) {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined || !processGroupExists(child)) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stopProcess(child, timeoutMs) {
  if (child === undefined || child.pid === undefined || !processGroupExists(child)) return;
  signalProcessGroup(child, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processGroupExists(child)) signalProcessGroup(child, 'SIGKILL');
}

async function waitFor(check, description, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${description} failed because its process exited`);
    try {
      if (await check()) return;
    } catch {
      // The service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function startProcess(command, args, environment) {
  return spawn(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
    detached: true,
  });
}

async function main() {
  const arguments_ = process.argv.slice(2).filter((argument, index) => !(argument === '--' && index === 0));
  if (arguments_.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  if (arguments_.some((argument) => argument !== '--print-config')) throw new Error(`Unknown argument: ${arguments_.join(' ')}`);

  let configuration = readConfiguration(process.env);
  if (arguments_.includes('--print-config')) {
    process.stdout.write(`${JSON.stringify(configuration)}\n`);
    return;
  }

  const [controlPlanePort, webPort] = await Promise.all([
    resolvePort('127.0.0.1', configuration.controlPlanePort, process.env.GENEWAY_CONTROL_PLANE_PORT !== undefined, 'Control Plane'),
    resolvePort(configuration.webBindHost, configuration.webPort, process.env.GENEWAY_WEB_PORT !== undefined, 'Web'),
  ]);
  configuration = readConfiguration({
    ...process.env,
    GENEWAY_CONTROL_PLANE_PORT: String(controlPlanePort),
    GENEWAY_WEB_PORT: String(webPort),
  });

  const runId = `dev-${String(Date.now())}-${String(process.pid)}`;
  const authorityDirectory = mkdtempSync('/tmp/geneway-dev-');
  const tokenFile = `${authorityDirectory}/worker.token`;
  const socketPath = `${authorityDirectory}/worker.sock`;
  const workerInstanceId = `dev-worker-${String(process.pid)}-${String(Date.now())}`;
  const receiptPath = `/tmp/geneway-runs/${runId}/process-boundaries/worker.json`;
  writeFileSync(tokenFile, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(tokenFile, 0o600);

  let controlPlane;
  let worker;
  let web;
  let stopping = false;
  let shutdownRequested = false;
  let fatalError;
  let releaseFatal;
  const fatal = new Promise((resolve) => { releaseFatal = resolve; });
  let releaseShutdown;
  const shutdown = new Promise((resolve) => { releaseShutdown = resolve; });
  const requestShutdown = () => {
    shutdownRequested = true;
    releaseShutdown();
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  const waitForLifecycle = async (readiness) => {
    const outcome = await Promise.race([
      readiness.then(() => 'ready'),
      fatal.then(() => 'fatal'),
      shutdown.then(() => 'shutdown'),
    ]);
    if (outcome === 'fatal') throw fatalError;
    return outcome;
  };
  const watch = (label, child) => {
    child.once('exit', (code, signal) => {
      if (stopping) return;
      fatalError = new Error(`${label} exited unexpectedly: code=${String(code)} signal=${String(signal)}`);
      releaseFatal();
    });
  };

  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\n正在停止 geneway 开发环境…\n');
    await stopProcess(web, 5_000);
    await stopProcess(worker, 5_000);
    await stopProcess(controlPlane, 20_000);
    if (!authorityDirectory.startsWith('/tmp/geneway-dev-')) throw new Error('Refusing to clean an unexpected authority directory');
    rmSync(authorityDirectory, { recursive: true, force: true });
    const runDirectory = `/tmp/geneway-runs/${runId}`;
    if (runDirectory.startsWith('/tmp/geneway-runs/dev-')) rmSync(runDirectory, { recursive: true, force: true });
  };

  try {
    process.stdout.write(`启动 Control Plane 与临时基础设施（run ${runId}）…\n`);
    controlPlane = startProcess('bash', [
      'scripts/with-storage.sh',
      'env',
      `GENEWAY_WEB_ALLOWED_ORIGINS=${configuration.allowedWebOrigins.join(',')}`,
      `GENEWAY_WORKER_SOCKET_PATH=${socketPath}`,
      `GENEWAY_WORKER_TOKEN_FILE=${tokenFile}`,
      'GENEWAY_WORKER_LEASE_MS=1000',
      './node_modules/.bin/tsx',
      'apps/control-plane/src/main.ts',
    ], {
      ...process.env,
      GENEWAY_STORAGE_TARGET_ROLE: 'control-plane',
      GENEWAY_START_STORAGE_RECONCILER: '1',
      GENEWAY_RUN_ID: runId,
      PORT: String(configuration.controlPlanePort),
      GENEWAY_WEB_PORT: String(configuration.webPort),
    });
    watch('Control Plane', controlPlane);
    if (await waitForLifecycle(waitFor(
      async () => (await fetch(`http://127.0.0.1:${String(configuration.controlPlanePort)}/health`)).ok && existsSync(socketPath) && lstatSync(socketPath).isSocket(),
      'Control Plane and Worker UDS',
      60_000,
      controlPlane,
    )) === 'shutdown') return;

    process.stdout.write('启动独立 Worker…\n');
    worker = startProcess('./node_modules/.bin/tsx', ['apps/worker/src/main.ts'], {
      ...minimalEnvironment(),
      NODE_ENV: 'test',
      GENEWAY_RUN_ID: runId,
      GENEWAY_WORKER_SOCKET_PATH: socketPath,
      GENEWAY_WORKER_TOKEN_FILE: tokenFile,
      GENEWAY_WORKER_INSTANCE_ID: workerInstanceId,
      GENEWAY_WORKER_CONSUMER: 'gate0.2a-worker',
      GENEWAY_WORKER_DEPLOYMENT: 'gate0.2a-local',
    });
    watch('Worker', worker);
    if (await waitForLifecycle(waitFor(() => {
      if (!existsSync(receiptPath)) return false;
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      return receipt.ready === true && receipt.workerInstanceId === workerInstanceId;
    }, 'Worker readiness', 20_000, worker)) === 'shutdown') return;

    process.stdout.write('启动局域网 Web…\n');
    web = startProcess('pnpm', ['--filter', '@geneway/web', 'dev'], {
      ...minimalEnvironment(),
      NODE_ENV: 'development',
      GENEWAY_RUN_ID: runId,
      GENEWAY_WEB_HOST: configuration.webBindHost,
      GENEWAY_WEB_PORT: String(configuration.webPort),
      GENEWAY_CONTROL_PLANE_PORT: String(configuration.controlPlanePort),
    });
    watch('Web', web);
    if (await waitForLifecycle(waitFor(
      async () => (await fetch(`http://${configuration.webBindHost}:${String(configuration.webPort)}/health`)).ok,
      'Web',
      30_000,
      web,
    )) === 'shutdown') return;

    process.stdout.write(`\n✓ geneway 开发环境已启动\n\n局域网（本机同样使用）：${configuration.publicUrl}\n\nWeb 只监听 ${configuration.lanHost}；按 Ctrl+C 停止并清理全部临时数据。\n`);
    const outcome = await Promise.race([fatal.then(() => 'fatal'), shutdown.then(() => 'shutdown')]);
    if (outcome === 'fatal') throw fatalError;
  } finally {
    await cleanup();
    process.removeListener('SIGINT', requestShutdown);
    process.removeListener('SIGTERM', requestShutdown);
    if (shutdownRequested) process.exitCode = 0;
  }
}

await main();
