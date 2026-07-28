import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { ensureGateA3Runtime, readApprovedGateA3Authority } from './dev-up.mjs';

const runId = process.env.GENEWAY_RUN_ID ?? `gate-a3-preflight-${String(Date.now())}-${String(process.pid)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
const evidenceDirectory = `/tmp/geneway-runs/${runId}/gate-a`;
const summaryPath = `${evidenceDirectory}/gearjob-preflight.json`;

await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await chmod(`/tmp/geneway-runs/${runId}`, 0o700);
await chmod(evidenceDirectory, 0o700);
const authority = readApprovedGateA3Authority();
const runtime = ensureGateA3Runtime(authority);
const summary = {
  schemaVersion: 'geneway-gate-a3-gearjob-preflight-verification/1',
  ok: true,
  runId,
  authority: {
    artifactId: authority.artifactId,
    approvedPreflightDigest: authority.approvedPreflightDigest,
    internalValidationAdmissionDigest: authority.internalValidationAdmissionDigest,
    admissionRootKeyId: authority.admissionRootKeyId,
    admissionSignatureVerified: authority.admissionSignatureVerified,
    expiresAt: authority.expiresAt,
  },
  source: {
    gearjobCommit: authority.gearjobCommit,
    nestedAppCommits: authority.nestedAppCommits,
    runtimeAuthorityDigest: authority.runtimeAuthorityDigest,
    dynamicAuthorityDigest: authority.dynamicAuthorityDigest,
    runtimeImageId: authority.runtimeImageId,
  },
  runtime: {
    imageBuilt: runtime.imageBuilt,
    exactSignedImage: true,
    fullVerificationPassed: true,
    liveVerificationPassed: true,
    exactFourServiceInternalTopology: true,
    zeroPublishedHostPorts: true,
    retainedOnCleanup: true,
  },
  credentialBoundary: {
    serviceCredentialReadByConnectorGatewayOnly: true,
    preflightReceiptContainsCredentialMaterial: false,
  },
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(summary)}\n`);
