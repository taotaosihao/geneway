#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const [role, receiptPath, roleEnvironmentPath, command, ...args] = process.argv.slice(2);
if (role === undefined || receiptPath === undefined || roleEnvironmentPath === undefined || command === undefined) {
  throw new Error('usage: role-launcher.mjs <role> <receipt> <role-env.json> <command> [...args]');
}

const roleEnvironment = JSON.parse(await readFile(roleEnvironmentPath, 'utf8'));
for (const [name, value] of Object.entries(roleEnvironment)) {
  if (typeof value !== 'string') throw new Error(`Role environment ${name} is not a string`);
  process.env[name] = value;
}

const names = Object.keys(process.env).sort();
const forbidden = names.filter((name) => {
  if (role === 'online-storage') {
    return name === 'DATABASE_URL' || name.startsWith('AWS_') || name.startsWith('GENEWAY_S3_ADMIN_')
      || name.startsWith('GENEWAY_S3_RECONCILER_')
      || name.startsWith('GENEWAY_S3_BACKUP_') || name.startsWith('GENEWAY_E2E_S3_ORACLE_')
      || name.startsWith('GENEWAY_WORKER_');
  }
  if (role === 'control-plane') {
    return name.startsWith('GENEWAY_S3_ADMIN_') || name.startsWith('GENEWAY_S3_APP_')
      || name.startsWith('GENEWAY_S3_RECONCILER_')
      || name.startsWith('GENEWAY_S3_BACKUP_') || name.startsWith('GENEWAY_E2E_S3_ORACLE_');
  }
  if (role === 'worker') {
    return name === 'DATABASE_URL' || name.startsWith('POSTGRES_') || name.startsWith('AWS_')
      || name.startsWith('GENEWAY_S3_') || name.startsWith('GENEWAY_STORAGE_')
      || name.startsWith('GENEWAY_BACKUP_') || name.startsWith('GENEWAY_E2E_S3_');
  }
  return false;
});
if (forbidden.length > 0) throw new Error(`${role} received forbidden environment names: ${forbidden.join(',')}`);

await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify({
  schemaVersion: 'geneway-backup-role-boundary/1',
  role,
  pid: process.pid,
  environmentNames: names,
  forbiddenNamesPresent: forbidden,
  checked: true,
  startedAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600 });

const child = spawn(command, args, { env: process.env, stdio: 'inherit' });
const forward = (signal) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
process.once('SIGTERM', () => forward('SIGTERM'));
process.once('SIGINT', () => forward('SIGINT'));
child.once('error', (error) => { throw error; });
const result = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code: code ?? 1, signal })));
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exitCode = result.code;
