import { createHash } from 'node:crypto';
import { gateAC1MaterialCorpus } from './e2e/gate-a-c1-materials.js';

const runId = process.env.GENEWAY_RUN_ID;
if (runId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
  throw new Error('GENEWAY_RUN_ID is required and must be a safe run identity');
}
const hashes = [...new Set((await gateAC1MaterialCorpus()).map((bytes) =>
  createHash('sha256').update(bytes).digest('hex')))];
if (hashes.length !== 6 || hashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) {
  throw new Error('Gate A C1 served material corpus did not produce six distinct SHA-256 authorities');
}
process.stdout.write(`${JSON.stringify({
  schemaVersion: 'gate-a-c1-served-allowlist/1',
  runId,
  hashes,
})}\n`);
