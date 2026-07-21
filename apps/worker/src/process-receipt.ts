import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { GenewayError } from '@geneway/contracts';
import type { WorkerIdentity } from './command-client.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WORKER_INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export type WorkerProcessConfiguration = Readonly<{
  runId: string;
  socketPath: string;
  tokenFile: string;
  identity: WorkerIdentity;
}>;

export type WorkerProcessReceipt = Readonly<{
  schemaVersion: 'geneway-process-boundary/1';
  role: 'worker';
  checked: true;
  phase: 'starting' | 'ready';
  ready: boolean;
  runId: string;
  pid: number;
  ppid: number;
  procStartTicks: string;
  workerInstanceId: string;
  consumer: 'gate0.2a-worker';
  deploymentId: 'gate0.2a-local';
  forbiddenNamesPresent: readonly [];
  startingAt: string;
  readyAt: string | null;
}>;

export type WorkerProcessReceiptHandle = Readonly<{
  path: string;
  startingReceipt: WorkerProcessReceipt;
  markReady(): Promise<WorkerProcessReceipt>;
}>;

const POSTGRES_ENVIRONMENT_NAMES = new Set([
  'DATABASE_URL',
  'GENEWAY_E2E_DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGSERVICE',
]);

export function findForbiddenWorkerEnvironmentNames(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).filter((name) => POSTGRES_ENVIRONMENT_NAMES.has(name)
    || name.startsWith('POSTGRES_')
    || name.startsWith('AWS_')
    || name.startsWith('GENEWAY_S3_')
    || name.startsWith('GENEWAY_STORAGE_')
    || name.startsWith('GENEWAY_E2E_S3_')
    || name.startsWith('GENEWAY_E2E_ORACLE_')
    || name === 'GENEWAY_SESSION_TOKEN'
    || name === 'GENEWAY_USER_SESSION'
    || name.startsWith('GENEWAY_PUBLIC_SESSION_'))
    .sort();
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new GenewayError('WORKER_ENV_REQUIRED', `${name} is required`);
  return value;
}

export function readWorkerProcessConfiguration(environment: NodeJS.ProcessEnv): WorkerProcessConfiguration {
  const forbiddenNames = findForbiddenWorkerEnvironmentNames(environment);
  if (forbiddenNames.length > 0) {
    throw new GenewayError('WORKER_FORBIDDEN_ENVIRONMENT', `Worker received forbidden environment names: ${forbiddenNames.join(',')}`);
  }

  const runId = requiredEnvironment(environment, 'GENEWAY_RUN_ID');
  if (!RUN_ID_PATTERN.test(runId)) throw new GenewayError('WORKER_RUN_ID_INVALID', 'GENEWAY_RUN_ID is invalid');
  const workerInstanceId = requiredEnvironment(environment, 'GENEWAY_WORKER_INSTANCE_ID');
  if (!WORKER_INSTANCE_PATTERN.test(workerInstanceId)) throw new GenewayError('WORKER_INSTANCE_ID_INVALID', 'GENEWAY_WORKER_INSTANCE_ID is invalid');
  const consumer = requiredEnvironment(environment, 'GENEWAY_WORKER_CONSUMER');
  const deploymentId = requiredEnvironment(environment, 'GENEWAY_WORKER_DEPLOYMENT');
  if (consumer !== 'gate0.2a-worker') throw new GenewayError('WORKER_CONSUMER_NOT_OPEN', 'GENEWAY_WORKER_CONSUMER is not open');
  if (deploymentId !== 'gate0.2a-local') throw new GenewayError('WORKER_DEPLOYMENT_NOT_OPEN', 'GENEWAY_WORKER_DEPLOYMENT is not open');

  return {
    runId,
    socketPath: requiredEnvironment(environment, 'GENEWAY_WORKER_SOCKET_PATH'),
    tokenFile: requiredEnvironment(environment, 'GENEWAY_WORKER_TOKEN_FILE'),
    identity: { workerInstanceId, consumer, deploymentId },
  };
}

type ProcIdentity = Readonly<{ pid: number; ppid: number; procStartTicks: string }>;

function parseProcStat(raw: string): ProcIdentity {
  const closingParenthesis = raw.lastIndexOf(')');
  const openingParenthesis = raw.indexOf('(');
  if (openingParenthesis < 1 || closingParenthesis <= openingParenthesis) {
    throw new GenewayError('WORKER_PROC_STAT_INVALID', 'Worker process stat is malformed');
  }
  const pid = Number(raw.slice(0, openingParenthesis).trim());
  const fieldsAfterCommand = raw.slice(closingParenthesis + 1).trim().split(/\s+/u);
  const ppid = Number(fieldsAfterCommand[1]);
  const procStartTicks = fieldsAfterCommand[19];
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || procStartTicks === undefined || !/^\d+$/u.test(procStartTicks)) {
    throw new GenewayError('WORKER_PROC_STAT_INVALID', 'Worker process identity fields are malformed');
  }
  return { pid, ppid, procStartTicks };
}

async function readCurrentProcessIdentity(): Promise<ProcIdentity> {
  const identity = parseProcStat(await readFile('/proc/self/stat', 'utf8'));
  if (identity.pid !== process.pid || identity.ppid !== process.ppid) {
    throw new GenewayError('WORKER_PROC_IDENTITY_MISMATCH', 'Worker process identity does not match /proc');
  }
  return identity;
}

function assertEnvironmentRemainsSafe(environment: NodeJS.ProcessEnv): void {
  const forbiddenNames = findForbiddenWorkerEnvironmentNames(environment);
  if (forbiddenNames.length > 0) {
    throw new GenewayError('WORKER_FORBIDDEN_ENVIRONMENT', `Worker received forbidden environment names: ${forbiddenNames.join(',')}`);
  }
}

function assertReceiptConfiguration(configuration: WorkerProcessConfiguration): void {
  if (!RUN_ID_PATTERN.test(configuration.runId)) throw new GenewayError('WORKER_RUN_ID_INVALID', 'Worker receipt run ID is invalid');
  if (!WORKER_INSTANCE_PATTERN.test(configuration.identity.workerInstanceId)) {
    throw new GenewayError('WORKER_INSTANCE_ID_INVALID', 'Worker receipt instance ID is invalid');
  }
  if (configuration.identity.consumer !== 'gate0.2a-worker' || configuration.identity.deploymentId !== 'gate0.2a-local') {
    throw new GenewayError('WORKER_RECEIPT_IDENTITY_NOT_OPEN', 'Worker receipt identity is not open');
  }
}

async function atomicWriteReceipt(path: string, receipt: WorkerProcessReceipt): Promise<void> {
  const directory = path.slice(0, path.lastIndexOf('/'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new GenewayError('WORKER_RECEIPT_DIRECTORY_INVALID', 'Worker receipt directory must not be a symbolic link');
  await chmod(directory, 0o700);
  const temporaryPath = join(directory, `.worker.json.${String(process.pid)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

export async function createWorkerProcessReceipt(
  configuration: WorkerProcessConfiguration,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkerProcessReceiptHandle> {
  assertReceiptConfiguration(configuration);
  assertEnvironmentRemainsSafe(environment);
  const processIdentity = await readCurrentProcessIdentity();
  const path = `/tmp/geneway-runs/${configuration.runId}/process-boundaries/worker.json`;
  const startingAt = new Date().toISOString();
  const base = {
    schemaVersion: 'geneway-process-boundary/1',
    role: 'worker',
    checked: true,
    runId: configuration.runId,
    ...processIdentity,
    workerInstanceId: configuration.identity.workerInstanceId,
    consumer: configuration.identity.consumer,
    deploymentId: configuration.identity.deploymentId,
    forbiddenNamesPresent: [],
    startingAt,
  } as const;
  const startingReceipt: WorkerProcessReceipt = {
    ...base,
    phase: 'starting',
    ready: false,
    readyAt: null,
  };
  await atomicWriteReceipt(path, startingReceipt);

  let readyReceipt: WorkerProcessReceipt | undefined;
  return {
    path,
    startingReceipt,
    markReady: async () => {
      if (readyReceipt !== undefined) return readyReceipt;
      assertEnvironmentRemainsSafe(environment);
      const currentIdentity = await readCurrentProcessIdentity();
      if (currentIdentity.pid !== processIdentity.pid
        || currentIdentity.ppid !== processIdentity.ppid
        || currentIdentity.procStartTicks !== processIdentity.procStartTicks) {
        throw new GenewayError('WORKER_PROC_IDENTITY_CHANGED', 'Worker process identity changed before readiness');
      }
      readyReceipt = {
        ...base,
        phase: 'ready',
        ready: true,
        readyAt: new Date().toISOString(),
      };
      await atomicWriteReceipt(path, readyReceipt);
      return readyReceipt;
    },
  };
}
