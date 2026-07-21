import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkerProcessReceipt,
  findForbiddenWorkerEnvironmentNames,
  readWorkerProcessConfiguration,
  type WorkerProcessReceipt,
} from './process-receipt.js';

const runDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function safeEnvironment(runId: string): NodeJS.ProcessEnv {
  return {
    GENEWAY_RUN_ID: runId,
    GENEWAY_WORKER_SOCKET_PATH: '/tmp/gw-worker-receipt-test.sock',
    GENEWAY_WORKER_TOKEN_FILE: `/tmp/geneway-runs/${runId}/secrets/worker-token`,
    GENEWAY_WORKER_INSTANCE_ID: 'worker-receipt-test',
    GENEWAY_WORKER_CONSUMER: 'gate0.2a-worker',
    GENEWAY_WORKER_DEPLOYMENT: 'gate0.2a-local',
  };
}

describe('worker process-boundary receipt', () => {
  it('atomically records the same independent process before and after authenticated readiness without credential data', async () => {
    const runId = `worker-receipt-${randomUUID()}`;
    const runDirectory = `/tmp/geneway-runs/${runId}`;
    runDirectories.push(runDirectory);
    const environment = safeEnvironment(runId);
    const configuration = readWorkerProcessConfiguration(environment);
    const handle = await createWorkerProcessReceipt(configuration, environment);

    const starting = JSON.parse(await readFile(handle.path, 'utf8')) as WorkerProcessReceipt;
    expect(starting).toMatchObject({
      schemaVersion: 'geneway-process-boundary/1',
      role: 'worker',
      checked: true,
      phase: 'starting',
      ready: false,
      runId,
      pid: process.pid,
      ppid: process.ppid,
      workerInstanceId: 'worker-receipt-test',
      consumer: 'gate0.2a-worker',
      deploymentId: 'gate0.2a-local',
      forbiddenNamesPresent: [],
      readyAt: null,
    });
    expect(starting.procStartTicks).toMatch(/^\d+$/u);

    const ready = await handle.markReady();
    const persistedReady = JSON.parse(await readFile(handle.path, 'utf8')) as WorkerProcessReceipt;
    expect(persistedReady).toEqual(ready);
    expect(ready).toMatchObject({
      phase: 'ready',
      ready: true,
      pid: starting.pid,
      ppid: starting.ppid,
      procStartTicks: starting.procStartTicks,
      startingAt: starting.startingAt,
      forbiddenNamesPresent: [],
    });
    expect(ready.readyAt).not.toBeNull();
    expect((await stat(handle.path)).mode & 0o777).toBe(0o600);

    const serialized = await readFile(handle.path, 'utf8');
    expect(serialized).not.toContain('worker-token');
    expect(serialized).not.toContain(configuration.tokenFile);
    expect(serialized).not.toContain(configuration.socketPath);
  });

  it('rejects missing, malformed, or authority-bearing environments before writing a valid receipt', () => {
    expect(() => readWorkerProcessConfiguration({})).toThrowError(/GENEWAY_RUN_ID is required/u);
    expect(() => readWorkerProcessConfiguration(safeEnvironment('../escape'))).toThrowError(/GENEWAY_RUN_ID is invalid/u);

    const runId = `worker-receipt-forbidden-${randomUUID()}`;
    const environment = { ...safeEnvironment(runId), DATABASE_URL: 'postgres://forbidden' };
    expect(findForbiddenWorkerEnvironmentNames(environment)).toEqual(['DATABASE_URL']);
    expect(() => readWorkerProcessConfiguration(environment)).toThrowError(/forbidden environment names: DATABASE_URL/u);
  });

  it('detects storage, AWS, database, oracle, and user-session authority by name without inspecting values', () => {
    expect(findForbiddenWorkerEnvironmentNames({
      AWS_REGION: 'cn-test-1',
      GENEWAY_S3_ENDPOINT: 'hidden',
      GENEWAY_STORAGE_ADAPTER_TOKEN: 'hidden',
      GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY: 'hidden',
      PGPASSWORD: 'hidden',
      POSTGRES_PASSWORD: 'hidden',
      GENEWAY_SESSION_TOKEN: 'hidden',
    })).toEqual([
      'AWS_REGION',
      'GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY',
      'GENEWAY_S3_ENDPOINT',
      'GENEWAY_SESSION_TOKEN',
      'GENEWAY_STORAGE_ADAPTER_TOKEN',
      'PGPASSWORD',
      'POSTGRES_PASSWORD',
    ]);
  });
});
