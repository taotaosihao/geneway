import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const HELP = `用法: pnpm dev-up

启动一次性的 geneway 本地验收栈，并把 Web 暴露到本机可用的 192.168/16 与 10/8 网络：
  Web                  <局域网 IPv4>:3200（全部入口共用，占用时自动顺延）
  Control Plane        127.0.0.1:3100（默认，占用时自动顺延）
  Model Gateway        127.0.0.1:3150（默认，占用时自动顺延）
  PostgreSQL / storage 随机 loopback 端口
  Worker               本机 Unix-domain socket

环境变量：
  GENEWAY_WEB_PORT               覆盖 Web 端口
  GENEWAY_CONTROL_PLANE_PORT     覆盖 Control Plane 端口
  GENEWAY_MODEL_GATEWAY_PORT     覆盖 Model Gateway 端口
  GENEWAY_GATE_A0_RELEASE_PORT   覆盖 loopback release helper 端口

同时提供已授权的 GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE 与尚未过期的
GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE 时，会通过 loopback release helper
为本次 disposable run 临时开放真实聊天；仅提供其中一项会安全失败，
两项都未提供时真实聊天保持 NOT_OPEN。

按 Ctrl+C 停止全部进程并删除本次临时数据库、对象存储和 Worker 凭据。
`;

function parsePort(environment, name, fallback) {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return value;
}

function isDefaultLanIpv4(value) {
  if (!net.isIPv4(value)) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || (first === 192 && second === 168);
}

const EXCLUDED_INTERFACE = /^(?:br-|cni|docker|flannel|kube|podman|veth|virbr|vmnet)/u;

export function parseLanHosts(addressOutput) {
  const hosts = [];
  for (const line of addressOutput.split('\n')) {
    const match = line.match(/^\d+:\s+([^@\s]+)(?:@\S+)?\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})\//u);
    if (match === null) continue;
    const [, interfaceName, address] = match;
    if (interfaceName === undefined || address === undefined || EXCLUDED_INTERFACE.test(interfaceName) || !isDefaultLanIpv4(address)) continue;
    if (!hosts.includes(address)) hosts.push(address);
  }
  hosts.sort((left, right) => {
    const leftPriority = left.startsWith('192.168.') ? 0 : 1;
    const rightPriority = right.startsWith('192.168.') ? 0 : 1;
    return leftPriority - rightPriority || left.localeCompare(right, 'en');
  });
  if (hosts.length === 0) {
    throw new Error('No usable 192.168/16 or 10/8 address found on an active non-virtual interface');
  }
  return hosts;
}

function detectLanHosts() {
  let addresses;
  try {
    addresses = execFileSync('ip', ['-o', '-4', 'address', 'show', 'up', 'scope', 'global'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error('Unable to inspect active IPv4 addresses', { cause: error });
  }
  return parseLanHosts(addresses);
}

export function readConfiguration(environment, lanHosts = detectLanHosts()) {
  const webPort = parsePort(environment, 'GENEWAY_WEB_PORT', 3200);
  const controlPlanePort = parsePort(environment, 'GENEWAY_CONTROL_PLANE_PORT', 3100);
  const modelGatewayPort = parsePort(environment, 'GENEWAY_MODEL_GATEWAY_PORT', 3150);
  const releaseHelperPort = parsePort(environment, 'GENEWAY_GATE_A0_RELEASE_PORT', 3160);
  if (new Set([webPort, controlPlanePort, modelGatewayPort]).size !== 3) {
    throw new Error('Web, Control Plane, and Model Gateway ports must be different');
  }
  if (environment.GENEWAY_GATE_A0_RELEASE_PORT !== undefined
    && new Set([webPort, controlPlanePort, modelGatewayPort, releaseHelperPort]).size !== 4) {
    throw new Error('Web, Control Plane, Model Gateway, and release helper ports must be different');
  }
  const localOrigins = [`http://localhost:${String(webPort)}`, `http://127.0.0.1:${String(webPort)}`];
  const publicOrigins = lanHosts.map((host) => `http://${host}:${String(webPort)}`);
  return {
    lanHosts,
    webBindHosts: lanHosts,
    webPort,
    controlPlaneBindHost: '127.0.0.1',
    controlPlanePort,
    modelGatewayBindHost: '127.0.0.1',
    modelGatewayPort,
    releaseHelperBindHost: '127.0.0.1',
    releaseHelperPort,
    allowedWebOrigins: [...localOrigins, ...publicOrigins],
    publicUrls: publicOrigins.map((origin) => `${origin}/conversations/new`),
  };
}

export function minimalEnvironment(environment = process.env) {
  return {
    PATH: environment.PATH ?? '/usr/bin:/bin',
    HOME: environment.HOME ?? '/tmp',
    TMPDIR: environment.TMPDIR ?? '/tmp',
    LANG: environment.LANG ?? 'C.UTF-8',
  };
}

export function controlPlaneEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => ![
    'GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE',
    'GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE',
  ].includes(name)));
}

function readLiveProviderPaths(environment) {
  const authFilePath = environment.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE;
  const conformanceFilePath = environment.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE;
  if ((authFilePath === undefined) !== (conformanceFilePath === undefined)) {
    throw new Error('GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE and GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE must be configured together');
  }
  return authFilePath === undefined ? undefined : { authFilePath, conformanceFilePath };
}

export function modelGatewayProviderEnvironment(environment = process.env) {
  const liveProvider = readLiveProviderPaths(environment);
  return {
    ...minimalEnvironment(environment),
    ...(liveProvider === undefined ? {} : {
      GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE: liveProvider.authFilePath,
      GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE: liveProvider.conformanceFilePath,
    }),
  };
}

const CONTROL_PLANE_WITH_RELEASE_COMMAND = `set -euo pipefail
control_plane_pid=''
release_helper_pid=''
stop_stack() {
  trap - EXIT INT TERM
  [[ -z "$release_helper_pid" ]] || kill "$release_helper_pid" 2>/dev/null || true
  [[ -z "$control_plane_pid" ]] || kill "$control_plane_pid" 2>/dev/null || true
  [[ -z "$release_helper_pid" ]] || wait "$release_helper_pid" 2>/dev/null || true
  [[ -z "$control_plane_pid" ]] || wait "$control_plane_pid" 2>/dev/null || true
}
trap stop_stack EXIT INT TERM
env -u GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE -u GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE -u GENEWAY_GATE_A0_RELEASE_PORT \
  ./node_modules/.bin/tsx apps/control-plane/src/main.ts &
control_plane_pid=$!
./node_modules/.bin/tsx scripts/e2e/start-gate-a0-release.ts &
release_helper_pid=$!
wait -n "$control_plane_pid" "$release_helper_pid"`;

export function buildControlPlaneStackPlan({
  configuration,
  runId,
  socketPath,
  tokenFile,
  gatewayServiceTokenFile,
  gatewayInvocationSecretFile,
  liveProvider,
}) {
  const environmentArguments = [
    `GENEWAY_WEB_ALLOWED_ORIGINS=${configuration.allowedWebOrigins.join(',')}`,
    `GENEWAY_WORKER_SOCKET_PATH=${socketPath}`,
    `GENEWAY_WORKER_TOKEN_FILE=${tokenFile}`,
    `GENEWAY_MODEL_GATEWAY_URL=http://${configuration.modelGatewayBindHost}:${String(configuration.modelGatewayPort)}`,
    `GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE=${gatewayServiceTokenFile}`,
    `GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE=${gatewayInvocationSecretFile}`,
    `GENEWAY_RUN_ID=${runId}`,
    `GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID=${runId}`,
    'GENEWAY_WORKER_LEASE_MS=1000',
  ];
  if (liveProvider === undefined) {
    return {
      arguments: ['scripts/with-storage.sh', 'env', ...environmentArguments, './node_modules/.bin/tsx', 'apps/control-plane/src/main.ts'],
      releaseHealthUrl: null,
    };
  }
  environmentArguments.push(
    `GENEWAY_GATE_A0_RELEASE_PORT=${String(configuration.releaseHelperPort)}`,
    `GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE=${liveProvider.authFilePath}`,
    `GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE=${liveProvider.conformanceFilePath}`,
  );
  return {
    arguments: ['scripts/with-storage.sh', 'env', ...environmentArguments, 'bash', '-c', CONTROL_PLANE_WITH_RELEASE_COMMAND],
    releaseHealthUrl: `http://${configuration.releaseHelperBindHost}:${String(configuration.releaseHelperPort)}/health`,
  };
}

async function portIsAvailable(host, port) {
  const server = net.createServer();
  const available = await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(port, host, resolve);
  });
  if (available === false) return false;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return true;
}

async function portIsAvailableOnAll(hosts, port) {
  for (const host of hosts) {
    if (!await portIsAvailable(host, port)) return false;
  }
  return true;
}

async function resolvePort(hosts, preferredPort, explicit, label) {
  if (await portIsAvailableOnAll(hosts, preferredPort)) return preferredPort;
  if (explicit) throw new Error(`${label} port ${hosts.join(', ')}:${String(preferredPort)} is unavailable`);
  for (let port = preferredPort + 1; port <= Math.min(preferredPort + 99, 65_535); port += 1) {
    if (await portIsAvailableOnAll(hosts, port)) return port;
  }
  throw new Error(`No available ${label} port found from ${String(preferredPort)} to ${String(preferredPort + 99)}`);
}

async function resolveUnreservedPort(hosts, preferredPort, reservedPorts, explicit, label) {
  if (!reservedPorts.has(preferredPort) && await portIsAvailableOnAll(hosts, preferredPort)) return preferredPort;
  if (explicit) throw new Error(`${label} port ${hosts.join(', ')}:${String(preferredPort)} is unavailable`);
  for (let port = preferredPort + 1; port <= Math.min(preferredPort + 99, 65_535); port += 1) {
    if (!reservedPorts.has(port) && await portIsAvailableOnAll(hosts, port)) return port;
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

function startProcess(command, args, environment, cwd = repositoryRoot) {
  return spawn(command, args, {
    cwd,
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
  const liveProvider = readLiveProviderPaths(process.env);
  if (arguments_.includes('--print-config')) {
    process.stdout.write(`${JSON.stringify(configuration)}\n`);
    return;
  }

  const [controlPlanePort, modelGatewayPort, webPort] = await Promise.all([
    resolvePort(['127.0.0.1'], configuration.controlPlanePort, process.env.GENEWAY_CONTROL_PLANE_PORT !== undefined, 'Control Plane'),
    resolvePort(['127.0.0.1'], configuration.modelGatewayPort, process.env.GENEWAY_MODEL_GATEWAY_PORT !== undefined, 'Model Gateway'),
    resolvePort(configuration.webBindHosts, configuration.webPort, process.env.GENEWAY_WEB_PORT !== undefined, 'Web'),
  ]);
  const releaseHelperPort = liveProvider === undefined
    ? configuration.releaseHelperPort
    : await resolveUnreservedPort(
      [configuration.releaseHelperBindHost],
      configuration.releaseHelperPort,
      new Set([controlPlanePort, modelGatewayPort, webPort]),
      process.env.GENEWAY_GATE_A0_RELEASE_PORT !== undefined,
      'Gate A0 release helper',
    );
  configuration = {
    ...readConfiguration({
      ...process.env,
      GENEWAY_CONTROL_PLANE_PORT: String(controlPlanePort),
      GENEWAY_MODEL_GATEWAY_PORT: String(modelGatewayPort),
      GENEWAY_WEB_PORT: String(webPort),
    }),
    releaseHelperPort,
  };

  const runId = `dev-${String(Date.now())}-${String(process.pid)}`;
  const authorityDirectory = mkdtempSync('/tmp/geneway-dev-');
  const tokenFile = `${authorityDirectory}/worker.token`;
  const gatewayServiceTokenFile = `${authorityDirectory}/model-gateway-service.token`;
  const gatewayInvocationSecretFile = `${authorityDirectory}/model-gateway-invocation.token`;
  const socketPath = `${authorityDirectory}/worker.sock`;
  const workerInstanceId = `dev-worker-${String(process.pid)}-${String(Date.now())}`;
  const receiptPath = `/tmp/geneway-runs/${runId}/process-boundaries/worker.json`;
  writeFileSync(tokenFile, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  writeFileSync(gatewayServiceTokenFile, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  writeFileSync(gatewayInvocationSecretFile, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(gatewayServiceTokenFile, 0o600);
  chmodSync(gatewayInvocationSecretFile, 0o600);

  let modelGateway;
  let controlPlane;
  let worker;
  let webs = [];
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
    for (const web of [...webs].reverse()) await stopProcess(web, 5_000);
    await stopProcess(worker, 5_000);
    await stopProcess(controlPlane, 20_000);
    await stopProcess(modelGateway, 5_000);
    if (!authorityDirectory.startsWith('/tmp/geneway-dev-')) throw new Error('Refusing to clean an unexpected authority directory');
    rmSync(authorityDirectory, { recursive: true, force: true });
    const runDirectory = `/tmp/geneway-runs/${runId}`;
    if (runDirectory.startsWith('/tmp/geneway-runs/dev-')) rmSync(runDirectory, { recursive: true, force: true });
  };

  try {
    process.stdout.write('启动 loopback Model Gateway…\n');
    modelGateway = startProcess('./node_modules/.bin/tsx', ['services/model-gateway/src/main.ts'], {
      ...modelGatewayProviderEnvironment(process.env),
      NODE_ENV: 'development',
      GENEWAY_MODEL_GATEWAY_PORT: String(configuration.modelGatewayPort),
      GENEWAY_CONTROL_PLANE_URL: `http://127.0.0.1:${String(configuration.controlPlanePort)}`,
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: gatewayServiceTokenFile,
      GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE: gatewayInvocationSecretFile,
    });
    watch('Model Gateway', modelGateway);
    if (await waitForLifecycle(waitFor(
      async () => (await fetch(`http://127.0.0.1:${String(configuration.modelGatewayPort)}/health`)).ok,
      'Model Gateway', 30_000, modelGateway,
    )) === 'shutdown') return;

    const controlPlaneStack = buildControlPlaneStackPlan({
      configuration,
      runId,
      socketPath,
      tokenFile,
      gatewayServiceTokenFile,
      gatewayInvocationSecretFile,
      liveProvider,
    });
    process.stdout.write(`启动 Control Plane 与临时基础设施（run ${runId}）…\n`);
    controlPlane = startProcess('bash', controlPlaneStack.arguments, {
      ...controlPlaneEnvironment(),
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

    if (controlPlaneStack.releaseHealthUrl !== null) {
      process.stdout.write('等待本次 disposable chat release 进入 internal…\n');
      if (await waitForLifecycle(waitFor(async () => {
        const response = await fetch(controlPlaneStack.releaseHealthUrl);
        if (!response.ok) return false;
        const body = await response.json();
        return body.ready === true && body.state === 'internal';
      }, 'Gate A0 release helper', 60_000, controlPlane)) === 'shutdown') return;
    }

    process.stdout.write('启动独立 Worker…\n');
    worker = startProcess('./node_modules/.bin/tsx', ['apps/worker/src/main.ts'], {
      ...minimalEnvironment(process.env),
      NODE_ENV: 'test',
      GENEWAY_RUN_ID: runId,
      GENEWAY_WORKER_SOCKET_PATH: socketPath,
      GENEWAY_WORKER_TOKEN_FILE: tokenFile,
      GENEWAY_WORKER_INSTANCE_ID: workerInstanceId,
      GENEWAY_WORKER_CONSUMER: 'gate0.2a-worker',
      GENEWAY_WORKER_DEPLOYMENT: 'gate0.2a-local',
      GENEWAY_MODEL_GATEWAY_URL: `http://${configuration.modelGatewayBindHost}:${String(configuration.modelGatewayPort)}`,
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: gatewayServiceTokenFile,
    });
    watch('Worker', worker);
    if (await waitForLifecycle(waitFor(() => {
      if (!existsSync(receiptPath)) return false;
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      return receipt.ready === true && receipt.workerInstanceId === workerInstanceId;
    }, 'Worker readiness', 20_000, worker)) === 'shutdown') return;

    process.stdout.write(`启动 ${String(configuration.webBindHosts.length)} 个局域网 Web 入口…\n`);
    webs = configuration.webBindHosts.map((host) => startProcess('./node_modules/.bin/vite', [], {
      ...minimalEnvironment(process.env),
      NODE_ENV: 'development',
      GENEWAY_RUN_ID: runId,
      GENEWAY_WEB_HOST: host,
      GENEWAY_WEB_PORT: String(configuration.webPort),
      GENEWAY_CONTROL_PLANE_PORT: String(configuration.controlPlanePort),
    }, `${repositoryRoot}/apps/web`));
    webs.forEach((web, index) => watch(`Web ${configuration.webBindHosts[index]}`, web));
    const webReadiness = Promise.all(configuration.webBindHosts.map((host, index) => waitFor(
      async () => (await fetch(`http://${host}:${String(configuration.webPort)}/health`)).ok,
      `Web ${host}`,
      30_000,
      webs[index],
    )));
    if (await waitForLifecycle(webReadiness) === 'shutdown') return;

    const displayedUrls = configuration.publicUrls.map((url) => `  ${url}`).join('\n');
    process.stdout.write(`\n✓ geneway 开发环境已启动\n\n局域网入口（本机同样使用）：\n${displayedUrls}\n\nWeb 只监听 ${configuration.lanHosts.join('、')}；按 Ctrl+C 停止并清理全部临时数据。\n`);
    const outcome = await Promise.race([fatal.then(() => 'fatal'), shutdown.then(() => 'shutdown')]);
    if (outcome === 'fatal') throw fatalError;
  } finally {
    await cleanup();
    process.removeListener('SIGINT', requestShutdown);
    process.removeListener('SIGTERM', requestShutdown);
    if (shutdownRequested) process.exitCode = 0;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
