#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const [inputPath, outputPath] = process.argv.slice(2);
if (inputPath === undefined || outputPath === undefined) {
  throw new Error('usage: bootstrap-stack.mjs <public-input.json> <public-output.json>');
}
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const credentialsRoot = input.credentialsRoot;
await mkdir(credentialsRoot, { recursive: true, mode: 0o700 });
await chmod(credentialsRoot, 0o700);

const secret = () => randomBytes(32).toString('hex');
const postgresPassword = secret();
const adminAccessKeyId = `gw${input.projectSuffix}${input.label}admin`;
const adminSecretAccessKey = secret();
const appAccessKeyId = `gw${input.projectSuffix}${input.label}online`;
const appSecretAccessKey = secret();
const reconcilerAccessKeyId = `gw${input.projectSuffix}${input.label}reconcile`;
const reconcilerSecretAccessKey = secret();
const oracleAccessKeyId = `gw${input.projectSuffix}${input.label}oracle`;
const oracleSecretAccessKey = secret();
const backupAccessKeyId = `gw${input.projectSuffix}${input.label}backup`;
const backupSecretAccessKey = secret();
const storageAdapterToken = secret();
const workerToken = secret();
const cursorHmacSecret = secret();
const databaseUrl = `postgres://geneway:${postgresPassword}@127.0.0.1:${input.postgresPort}/geneway_backup`;
const s3Endpoint = `http://127.0.0.1:${input.s3Port}`;
const backupDatabaseUrl = `postgres://geneway:${postgresPassword}@postgres:5432/geneway_backup`;
const backupS3Endpoint = 'http://versitygw:7070';
const storageAdapterUrl = `http://127.0.0.1:${input.storageAdapterPort}`;
const controlPlaneUrl = `http://127.0.0.1:${input.controlPlanePort}`;

const roleFiles = {};
async function roleFile(name, value) {
  const path = join(credentialsRoot, `${name}.json`);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  roleFiles[name] = path;
}

const composeEnvFile = join(credentialsRoot, 'compose.env');
await writeFile(composeEnvFile, [
  `GENEWAY_BACKUP_POSTGRES_PORT=${input.postgresPort}`,
  `GENEWAY_BACKUP_POSTGRES_PASSWORD=${postgresPassword}`,
  `GENEWAY_BACKUP_S3_PORT=${input.s3Port}`,
  `GENEWAY_BACKUP_S3_ACCESS_KEY_ID=${adminAccessKeyId}`,
  `GENEWAY_BACKUP_S3_SECRET_ACCESS_KEY=${adminSecretAccessKey}`,
  '',
].join('\n'), { mode: 0o600 });

await writeFile(input.tokenFile, workerToken, { mode: 0o600 });
await chmod(input.tokenFile, 0o600);

await roleFile('provision', {
  label: input.label,
  project: input.project,
  composeEnvFile,
  databaseUrl,
  s3Endpoint,
  adminAccessKeyId,
  adminSecretAccessKey,
  appAccessKeyId,
  appSecretAccessKey,
  reconcilerAccessKeyId,
  reconcilerSecretAccessKey,
  oracleAccessKeyId,
  oracleSecretAccessKey,
  backupAccessKeyId,
  backupSecretAccessKey,
  env: {
    GENEWAY_BACKUP_POSTGRES_PORT: String(input.postgresPort),
    GENEWAY_BACKUP_POSTGRES_PASSWORD: postgresPassword,
    GENEWAY_BACKUP_S3_PORT: String(input.s3Port),
    GENEWAY_BACKUP_S3_ACCESS_KEY_ID: adminAccessKeyId,
    GENEWAY_BACKUP_S3_SECRET_ACCESS_KEY: adminSecretAccessKey,
  },
});
await roleFile('backup', {
  label: input.label,
  project: input.project,
  databaseUrl: backupDatabaseUrl,
  s3Endpoint: backupS3Endpoint,
  backupAccessKeyId,
  backupSecretAccessKey,
});
await roleFile('oracle', { label: input.label, s3Endpoint, oracleAccessKeyId, oracleSecretAccessKey });
await roleFile('worker-command', { label: input.label, socketPath: input.socketPath, workerToken });
await roleFile('online-storage-env', {
  GENEWAY_STORAGE_ADAPTER_PORT: String(input.storageAdapterPort),
  GENEWAY_STORAGE_ADAPTER_HOST: '127.0.0.1',
  GENEWAY_STORAGE_ADAPTER_TOKEN: storageAdapterToken,
  GENEWAY_S3_ENDPOINT: s3Endpoint,
  GENEWAY_S3_BUCKET: 'geneway-artifacts',
  GENEWAY_S3_REGION: 'us-east-1',
  GENEWAY_S3_APP_ACCESS_KEY_ID: appAccessKeyId,
  GENEWAY_S3_APP_SECRET_ACCESS_KEY: appSecretAccessKey,
  GENEWAY_STORAGE_ALLOWED_PREFIX: 'tenants/tenant_local/artifacts/',
});
await roleFile('control-plane-env', {
  DATABASE_URL: databaseUrl,
  PORT: String(input.controlPlanePort),
  GENEWAY_WEB_PORT: '3200',
  GENEWAY_STORAGE_ADAPTER_URL: storageAdapterUrl,
  GENEWAY_STORAGE_ADAPTER_TOKEN: storageAdapterToken,
  GENEWAY_S3_BUCKET: 'geneway-artifacts',
  GENEWAY_WORKER_SOCKET_PATH: input.socketPath,
  GENEWAY_WORKER_TOKEN_FILE: input.tokenFile,
  GENEWAY_WORKER_LEASE_MS: '300000',
  GENEWAY_CURSOR_HMAC_SECRET: cursorHmacSecret,
});
await roleFile('worker-env', {
  GENEWAY_RUN_ID: input.runId,
  GENEWAY_WORKER_SOCKET_PATH: input.socketPath,
  GENEWAY_WORKER_TOKEN_FILE: input.tokenFile,
  GENEWAY_WORKER_CONSUMER: 'gate0.2a-worker',
  GENEWAY_WORKER_DEPLOYMENT: 'gate0.2a-local',
  GENEWAY_WORKER_STEP_DELAY_MS: '0',
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({
  ...input,
  s3Endpoint,
  storageAdapterUrl,
  controlPlaneUrl,
  composeEnvFile,
  roleFiles,
}, null, 2)}\n`, { mode: 0o600 });
