import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const reconciliationAdapterPort = await allocatePort();
const workerHealthPort = await allocatePort();
const controlPlaneSupervisorPort = await allocatePort();
const composeRunId = runId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
const composeProjectName = `geneway-e2e-${composeRunId}`;
const databaseUrl = `postgres://geneway:geneway@127.0.0.1:${postgresPort}/geneway_test`;
const s3Endpoint = `http://127.0.0.1:${s3Port}`;
const workerAuthorityDirectory = mkdtempSync('/tmp/gw-uds-');
const workerSocketPath = `${workerAuthorityDirectory}/worker.sock`;
const workerTokenFile = `${workerAuthorityDirectory}/token`;
const workerInstanceId = `e2e-worker-${process.pid}-${Date.now()}`;
const baseEnvironment = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: process.env.LANG ?? 'C.UTF-8',
  NODE_ENV: 'test',
  ...(process.env.CI === undefined ? {} : { CI: process.env.CI }),
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
};

function processIdentityMatches(pid, procStartTicks) {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const closingParenthesis = raw.lastIndexOf(')');
    if (closingParenthesis < 1) return false;
    return raw.slice(closingParenthesis + 1).trim().split(/\s+/u)[19] === procStartTicks;
  } catch {
    return false;
  }
}

function belongsToWorkerRun(candidate) {
  if (candidate === workerInstanceId) return true;
  const prefix = `${workerInstanceId}-g`;
  return typeof candidate === 'string' && candidate.startsWith(prefix) && /^\d+$/u.test(candidate.slice(prefix.length));
}

async function waitForProcessExit(pid, procStartTicks, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processIdentityMatches(pid, procStartTicks) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processIdentityMatches(pid, procStartTicks);
}

let result;
let cleanupFailed = false;
let reportGateFailed = false;
try {
  writeFileSync(workerTokenFile, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(workerTokenFile, 0o600);
  if ((statSync(workerTokenFile).mode & 0o777) !== 0o600 || Buffer.byteLength(workerSocketPath, 'utf8') > 100) {
    throw new Error('E2E Worker authority did not satisfy the 0600 token or short UDS boundary');
  }
  result = spawnSync('pnpm', ['exec', 'playwright', 'test', '-c', 'scripts/playwright.config.ts', ...forwarded], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...baseEnvironment,
      GENEWAY_RUN_ID: runId,
      GENEWAY_CONTROL_PLANE_PORT: controlPlanePort,
      GENEWAY_WEB_PORT: webPort,
      GENEWAY_POSTGRES_PORT: postgresPort,
      GENEWAY_S3_PORT: s3Port,
      GENEWAY_STORAGE_ADAPTER_PORT: storageAdapterPort,
      GENEWAY_RECONCILIATION_ADAPTER_PORT: reconciliationAdapterPort,
      GENEWAY_WORKER_HEALTH_PORT: workerHealthPort,
      GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT: controlPlaneSupervisorPort,
      GENEWAY_WORKER_SOCKET_PATH: workerSocketPath,
      GENEWAY_WORKER_TOKEN_FILE: workerTokenFile,
      GENEWAY_WORKER_INSTANCE_ID: workerInstanceId,
      GENEWAY_MANAGED_TEST_INFRA: '1',
      DATABASE_URL: databaseUrl,
      GENEWAY_E2E_DATABASE_URL: databaseUrl,
      GENEWAY_S3_ENDPOINT: s3Endpoint,
      COMPOSE_PROJECT_NAME: composeProjectName,
    },
    stdio: 'inherit',
  });
  if (result.status === 0) {
    const reportGate = spawnSync('pnpm', ['exec', 'tsx', 'scripts/e2e-report-gate.ts',
      `/tmp/geneway-runs/${runId}/playwright-report.json`, JSON.stringify(forwarded)], {
      cwd: new URL('..', import.meta.url), env: baseEnvironment, stdio: 'inherit',
    });
    reportGateFailed = reportGate.status !== 0;
  }
} finally {
  const boundaryDirectory = `/tmp/geneway-runs/${runId}/process-boundaries`;
  const workerReceiptPath = `/tmp/geneway-runs/${runId}/process-boundaries/worker.json`;
  let workerReceiptFound = false;
  let workerExited = true;
  let workerGenerationReceipts = [];
  let workerGenerationsExited = true;
  let workerPid;
  let workerProcStartTicks;
  try {
    const receipt = JSON.parse(readFileSync(workerReceiptPath, 'utf8'));
    workerReceiptFound = receipt.role === 'worker'
      && receipt.phase === 'ready'
      && receipt.ready === true
      && belongsToWorkerRun(receipt.workerInstanceId)
      && Number.isSafeInteger(receipt.pid)
      && typeof receipt.procStartTicks === 'string';
    if (workerReceiptFound) {
      workerPid = receipt.pid;
      workerProcStartTicks = receipt.procStartTicks;
      workerExited = await waitForProcessExit(workerPid, workerProcStartTicks, 2_000);
      if (!workerExited && processIdentityMatches(workerPid, workerProcStartTicks)) {
        process.kill(workerPid, 'SIGTERM');
        workerExited = await waitForProcessExit(workerPid, workerProcStartTicks, 2_000);
      }
      if (!workerExited && processIdentityMatches(workerPid, workerProcStartTicks)) {
        process.kill(workerPid, 'SIGKILL');
        workerExited = await waitForProcessExit(workerPid, workerProcStartTicks, 2_000);
      }
    }
  } catch (error) {
    if (result?.status === 0) console.error(`unable to verify Worker process receipt: ${String(error)}`);
    workerExited = false;
  }
  try {
    workerGenerationReceipts = readdirSync(boundaryDirectory)
      .filter((name) => /^worker-generation-\d+\.json$/u.test(name))
      .map((name) => JSON.parse(readFileSync(`${boundaryDirectory}/${name}`, 'utf8')))
      .filter((receipt) => receipt.role === 'worker' && receipt.phase === 'ready' && receipt.ready === true
        && belongsToWorkerRun(receipt.workerInstanceId)
        && Number.isSafeInteger(receipt.generation) && Number.isSafeInteger(receipt.pid) && typeof receipt.procStartTicks === 'string')
      .sort((left, right) => left.generation - right.generation);
    const uniqueIdentities = new Map(workerGenerationReceipts.map((receipt) => [`${String(receipt.pid)}:${receipt.procStartTicks}`, receipt]));
    for (const receipt of uniqueIdentities.values()) {
      let exited = await waitForProcessExit(receipt.pid, receipt.procStartTicks, 2_000);
      if (!exited && processIdentityMatches(receipt.pid, receipt.procStartTicks)) {
        process.kill(receipt.pid, 'SIGTERM');
        exited = await waitForProcessExit(receipt.pid, receipt.procStartTicks, 2_000);
      }
      if (!exited && processIdentityMatches(receipt.pid, receipt.procStartTicks)) {
        process.kill(receipt.pid, 'SIGKILL');
        exited = await waitForProcessExit(receipt.pid, receipt.procStartTicks, 2_000);
      }
      workerGenerationsExited &&= exited;
    }
  } catch (error) {
    if (result?.status === 0) console.error(`unable to verify Worker generation receipts: ${String(error)}`);
    workerGenerationsExited = false;
  }
  if (result?.status === 0 && (!workerReceiptFound || !workerExited || workerGenerationReceipts.length === 0 || !workerGenerationsExited)) cleanupFailed = true;

  let controlPlaneReceiptFound = false;
  let controlPlaneGenerations = [];
  let controlPlaneGenerationsExited = true;
  try {
    const current = JSON.parse(readFileSync(`${boundaryDirectory}/control-plane.json`, 'utf8'));
    controlPlaneReceiptFound = current.role === 'control-plane' && current.phase === 'ready' && current.ready === true
      && Number.isSafeInteger(current.pid) && typeof current.procStartTicks === 'string' && Number.isSafeInteger(current.generation);
    controlPlaneGenerations = readdirSync(boundaryDirectory)
      .filter((name) => /^control-plane-generation-\d+\.json$/u.test(name))
      .map((name) => JSON.parse(readFileSync(`${boundaryDirectory}/${name}`, 'utf8')))
      .filter((receipt) => receipt.role === 'control-plane' && receipt.phase === 'ready' && receipt.ready === true
        && Number.isSafeInteger(receipt.generation) && Number.isSafeInteger(receipt.pid) && typeof receipt.procStartTicks === 'string')
      .sort((left, right) => left.generation - right.generation);
    const uniqueIdentities = new Map(controlPlaneGenerations.map((receipt) => [`${String(receipt.pid)}:${receipt.procStartTicks}`, receipt]));
    for (const receipt of uniqueIdentities.values()) {
      let exited = await waitForProcessExit(receipt.pid, receipt.procStartTicks, 2_000);
      if (!exited && processIdentityMatches(receipt.pid, receipt.procStartTicks)) {
        process.kill(receipt.pid, 'SIGTERM');
        exited = await waitForProcessExit(receipt.pid, receipt.procStartTicks, 2_000);
      }
      if (!exited && processIdentityMatches(receipt.pid, receipt.procStartTicks)) {
        process.kill(receipt.pid, 'SIGKILL');
        exited = await waitForProcessExit(receipt.pid, receipt.procStartTicks, 2_000);
      }
      controlPlaneGenerationsExited &&= exited;
    }
  } catch (error) {
    if (result?.status === 0) console.error(`unable to verify Control Plane generation receipts: ${String(error)}`);
    controlPlaneGenerationsExited = false;
  }
  if (result?.status === 0 && (!controlPlaneReceiptFound || controlPlaneGenerations.length === 0 || !controlPlaneGenerationsExited)) cleanupFailed = true;

  for (const [resource, listArguments, removeArguments] of [
    ['container', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${composeProjectName}`], ['rm', '-f']],
    ['volume', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${composeProjectName}`], ['volume', 'rm', '-f']],
    ['network', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${composeProjectName}`], ['network', 'rm']],
  ]) {
    const listed = spawnSync('docker', listArguments, { encoding: 'utf8' });
    if (listed.status !== 0) {
      console.error(`unable to list disposable ${resource} resources: ${listed.stderr}`);
      cleanupFailed = true;
      continue;
    }
    const identifiers = listed.stdout.trim().split(/\s+/u).filter(Boolean);
    if (identifiers.length > 0) {
      const removed = spawnSync('docker', [...removeArguments, ...identifiers], { encoding: 'utf8' });
      if (removed.status !== 0) {
        console.error(`unable to remove disposable ${resource} resources: ${removed.stderr}`);
        cleanupFailed = true;
      }
    }
  }
  const socketRemovedByControlPlane = !existsSync(workerSocketPath);
  if (!workerAuthorityDirectory.startsWith('/tmp/gw-uds-')) throw new Error('Refusing to clean an unexpected Worker authority directory');
  rmSync(workerAuthorityDirectory, { recursive: true, force: true });
  const authorityCleaned = !existsSync(workerTokenFile) && !existsSync(workerSocketPath) && !existsSync(workerAuthorityDirectory);
  mkdirSync(`/tmp/geneway-runs/${runId}`, { recursive: true });
  writeFileSync(`/tmp/geneway-runs/${runId}/worker-authority-cleanup.json`, `${JSON.stringify({
    workerReceiptFound,
    workerPid: workerPid ?? null,
    workerProcStartTicks: workerProcStartTicks ?? null,
    workerExited,
    workerGenerationCount: workerGenerationReceipts.length,
    workerGenerationsExited,
    workerGenerations: workerGenerationReceipts.map((receipt) => ({
      generation: receipt.generation,
      pid: receipt.pid,
      procStartTicks: receipt.procStartTicks,
      workerInstanceId: receipt.workerInstanceId,
    })),
    controlPlaneReceiptFound,
    controlPlaneGenerationCount: controlPlaneGenerations.length,
    controlPlaneGenerationsExited,
    controlPlaneGenerations: controlPlaneGenerations.map((receipt) => ({
      generation: receipt.generation,
      pid: receipt.pid,
      procStartTicks: receipt.procStartTicks,
    })),
    authorityCleaned,
    tokenRemoved: !existsSync(workerTokenFile),
    socketRemoved: !existsSync(workerSocketPath),
    socketRemovedByControlPlane,
  })}\n`, { mode: 0o600 });
  if (!authorityCleaned) cleanupFailed = true;
}
console.log(`geneway served-test artifacts: /tmp/geneway-runs/${runId}/`);
process.exit(cleanupFailed || reportGateFailed ? 1 : (result?.status ?? 1));
