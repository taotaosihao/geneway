import { mkdirSync, writeFileSync } from 'node:fs';

const role = process.argv[2];
if (role !== 'control-plane' && role !== 'vite') throw new Error('Process boundary role must be control-plane or vite');
const names = Object.keys(process.env).sort();
const forbidden = names.filter((name) => name === 'AWS_ACCESS_KEY_ID'
  || name === 'AWS_SECRET_ACCESS_KEY'
  || name === 'AWS_SESSION_TOKEN'
  || name === 'GENEWAY_S3_ENDPOINT'
  || name.startsWith('GENEWAY_S3_ADMIN_')
  || name.startsWith('GENEWAY_S3_APP_')
  || name.startsWith('GENEWAY_S3_RECONCILER_')
  || name.startsWith('GENEWAY_E2E_S3_')
  || name.startsWith('GENEWAY_RECONCILIATION_ADAPTER_')
  || (role === 'vite' && name.startsWith('GENEWAY_STORAGE_')));
if (forbidden.length > 0) throw new Error(`${role} received forbidden credential sources: ${forbidden.join(',')}`);
if (role === 'control-plane' && (!names.includes('GENEWAY_STORAGE_ADAPTER_URL') || !names.includes('GENEWAY_STORAGE_ADAPTER_TOKEN'))) {
  throw new Error('control-plane did not receive its bounded storage adapter authority');
}
const runId = process.env.GENEWAY_RUN_ID;
if (runId !== undefined) {
  const directory = `/tmp/geneway-runs/${runId}/process-boundaries`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/${role}.json`, `${JSON.stringify({ role, checked: true, forbiddenNamesPresent: [] })}\n`, { mode: 0o600 });
}
