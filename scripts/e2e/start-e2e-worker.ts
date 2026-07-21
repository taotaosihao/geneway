import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const runId = required('GENEWAY_RUN_ID');
const healthPort = Number(required('GENEWAY_WORKER_HEALTH_PORT'));
const workerInstanceId = required('GENEWAY_WORKER_INSTANCE_ID');
const socketPath = required('GENEWAY_WORKER_SOCKET_PATH');
const tokenFile = required('GENEWAY_WORKER_TOKEN_FILE');
const consumer = required('GENEWAY_WORKER_CONSUMER');
const deploymentId = required('GENEWAY_WORKER_DEPLOYMENT');
if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) throw new Error('GENEWAY_WORKER_HEALTH_PORT is invalid');

const receiptPath = `/tmp/geneway-runs/${runId}/process-boundaries/worker.json`;
const workerEnvironment = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: process.env.LANG ?? 'C.UTF-8',
  NODE_ENV: 'test',
  GENEWAY_RUN_ID: runId,
  GENEWAY_WORKER_SOCKET_PATH: socketPath,
  GENEWAY_WORKER_TOKEN_FILE: tokenFile,
  GENEWAY_WORKER_INSTANCE_ID: workerInstanceId,
  GENEWAY_WORKER_CONSUMER: consumer,
  GENEWAY_WORKER_DEPLOYMENT: deploymentId,
};

let workerReady = false;
let stopping = false;
const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], {
  cwd: process.cwd(),
  env: workerEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (child.stdout === null || child.stderr === null) throw new Error('Worker output pipes were not created');

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  if (chunk.includes('GENEWAY_WORKER_READY')) workerReady = true;
});

const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/health') {
    response.writeHead(404).end();
    return;
  }
  void (async () => {
    try {
      const tokenStat = await stat(tokenFile);
      const socketStat = await stat(socketPath);
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Readonly<Record<string, unknown>>;
      const ready = workerReady
        && tokenStat.isFile()
        && (tokenStat.mode & 0o777) === 0o600
        && socketStat.isSocket()
        && (socketStat.mode & 0o777) === 0o600
        && receipt.role === 'worker'
        && receipt.phase === 'ready'
        && receipt.ready === true
        && receipt.pid === child.pid
        && receipt.workerInstanceId === workerInstanceId
        && Array.isArray(receipt.forbiddenNamesPresent)
        && receipt.forbiddenNamesPresent.length === 0;
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready }));
    } catch {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: false }));
    }
  })();
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(healthPort, '127.0.0.1', resolve);
});

async function closeServer(): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  void closeServer().finally(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

child.once('error', (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  void closeServer().then(() => { process.exitCode = 1; });
});
child.once('exit', (code, signal) => {
  void closeServer().then(() => {
    if (!stopping && (code !== 0 || signal !== null)) {
      process.stderr.write(`E2E Worker exited unexpectedly: code=${String(code)} signal=${String(signal)}\n`);
      process.exitCode = code ?? 1;
    }
  });
});
