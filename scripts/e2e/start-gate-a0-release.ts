import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { CapabilityReleaseRepository } from '../../apps/control-plane/src/capability-release.js';
import { conformanceSchema } from '../../services/model-gateway/src/index.js';
import {
  verifyOwnedPrivateFile, verifyProviderAuthFile, verifyProviderManifest,
} from '../../services/model-gateway/src/provider-manifest.js';

const { Pool } = pg;
const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
};
const runId = required('GENEWAY_RUN_ID');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
const databaseUrl = required('DATABASE_URL');
const authFilePath = required('GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE');
const conformanceFilePath = required('GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE');
const port = Number(required('GENEWAY_GATE_A0_RELEASE_PORT'));
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('GENEWAY_GATE_A0_RELEASE_PORT is invalid');

const verified = await verifyProviderManifest();
await verifyProviderAuthFile(authFilePath, verified.manifest);
await verifyOwnedPrivateFile(conformanceFilePath, 'Conformance file');
const conformanceBytes = await readFile(conformanceFilePath);
const conformance = conformanceSchema.parse(JSON.parse(conformanceBytes.toString('utf8')));
if (conformance.manifestDigest !== verified.digest || Date.parse(conformance.expiresAt) <= Date.now()
  || Date.parse(conformance.passedAt) > Date.parse(conformance.deadline)
  || Date.parse(conformance.deadline) > Date.parse(conformance.expiresAt)) {
  throw new Error('live conformance is missing, expired, or belongs to another manifest');
}
const conformanceDigest = createHash('sha256').update(conformanceBytes).digest('hex');
const shadowEvidence = {
  kind: 'provider-readiness' as const,
  manifestDigest: verified.digest,
  conformanceDigest,
  profile: conformance.profile,
  providerModel: conformance.providerModel,
  conformancePassedAt: conformance.passedAt,
  conformanceDeadline: conformance.deadline,
  conformanceExpiresAt: conformance.expiresAt,
  credentialBoundary: 'manifest-bound-owner-0700-or-authorized-0775-parent-0600-file-v1',
} as const;
const pool = new Pool({ connectionString: databaseUrl });
let shadow;
let internal;
try {
  let draftReady = false;
  for (let attempt = 0; attempt < 600 && !draftReady; attempt += 1) {
    try {
      const result = await pool.query(`SELECT 1 FROM capability_active_releases
        WHERE tenant_id='tenant_local' AND capability_id='xiaowei.chat.v1'
          AND release_id='release_xiaowei_chat_v1_draft' AND pointer_version=1`);
      draftReady = result.rowCount === 1;
    } catch {
      draftReady = false;
    }
    if (!draftReady) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!draftReady) throw new Error('Gate A0 draft release authority did not become ready');
  const releases = new CapabilityReleaseRepository(pool);
  shadow = await releases.promote({
    tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'shadow',
    expectedReleaseId: 'release_xiaowei_chat_v1_draft', expectedPointerVersion: 1,
    actor: 'user@source-thread:019f880e-bac8-7412-a129-68db9bf6506a', evidence: shadowEvidence,
    releaseId: `release_xiaowei_chat_v1_shadow_${runId}`,
  });
  const candidateExpiresAt = new Date(Math.min(Date.parse(conformance.expiresAt), Date.now() + 15 * 60_000)).toISOString();
  internal = await releases.promote({
    tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'internal',
    expectedReleaseId: shadow.releaseId, expectedPointerVersion: shadow.pointerVersion,
    actor: 'user@source-thread:019f880e-bac8-7412-a129-68db9bf6506a',
    evidence: {
      kind: 'disposable-live-validation-candidate',
      runId,
      manifestDigest: verified.digest,
      conformanceDigest,
      shadowEvidenceDigest: shadow.gateEvidenceDigest,
      purpose: 'temporarily open the disposable route solely for gate-a0-live validation',
      expiresAt: candidateExpiresAt,
    },
    releaseId: `release_xiaowei_chat_v1_internal_${runId}`,
  });
} finally {
  await pool.end();
}
const evidenceDirectory = `/tmp/geneway-runs/${runId}/gate-a0`;
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await chmod(evidenceDirectory, 0o700);
await writeFile(`${evidenceDirectory}/release-promotion.json`, `${JSON.stringify({
  schemaVersion: 'geneway-gate-a0-release-promotion/1',
  runId,
  manifestDigest: verified.digest,
  conformanceDigest,
  admission: 'disposable-live-validation-candidate; not Gate A0.1 success evidence',
  shadow,
  internal,
}, null, 2)}\n`, { mode: 0o600 });

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ready: true, state: 'internal' }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
const stop = (): void => { void new Promise<void>((resolve) => server.close(() => resolve())); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
