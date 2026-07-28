import { constants } from 'node:fs';
import { createHash, verify as verifySignature } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { canonicalize } from 'json-canonicalize';
import {
  gateA3ControlPlaneAuthorityBundleSchema,
  gateA3CapabilityAcceptanceAggregateSchema,
  type GateA3ActorRegistry,
  type GateA3ControlPlaneAuthorityBundle,
  type GateA3RunScopedAcceptanceAdmission,
  type GateA3PrelaunchTopologyReceipt,
  type GateA3CapabilityAcceptanceAggregate,
} from '@geneway/contracts';

const SHA256 = /^[a-f0-9]{64}$/u;
const CODEX_AUTHORITY_SEGMENT = '/.codex/workflow/artifacts/';

const canonicalDigest = (value: unknown): string => createHash('sha256')
  .update(canonicalize(value), 'utf8').digest('hex');

function registryDigest(registry: GateA3ActorRegistry): string {
  const payload = structuredClone(registry);
  Reflect.deleteProperty(payload, 'registryDigest');
  return canonicalDigest(payload);
}

function acceptanceAdmissionSigningPayload(admission: GateA3RunScopedAcceptanceAdmission): unknown {
  const payload = structuredClone(admission);
  Reflect.deleteProperty(payload.integrity, 'canonicalSha256');
  Reflect.deleteProperty(payload.signer, 'signature');
  return payload;
}

function prelaunchReceiptSigningPayload(receipt: GateA3PrelaunchTopologyReceipt): unknown {
  const payload = structuredClone(receipt);
  Reflect.deleteProperty(payload.integrity, 'canonicalSha256');
  Reflect.deleteProperty(payload.verifier, 'signature');
  return payload;
}

function acceptanceAggregateSigningPayload(aggregate: GateA3CapabilityAcceptanceAggregate): unknown {
  const payload = structuredClone(aggregate);
  Reflect.deleteProperty(payload.integrity, 'canonicalSha256');
  Reflect.deleteProperty(payload.verifier, 'signature');
  return payload;
}

function actorForRole(registry: GateA3ActorRegistry, role: 'signer' | 'verifier') {
  const actor = registry.actors.find((candidate) => candidate.role === role);
  if (actor === undefined) throw new Error(`Gate A.3 ${role} identity is missing`);
  return actor;
}

function assertSignedPayload(input: Readonly<{
  payload: unknown;
  integrityDigest: string;
  signature: string;
  publicKeyPem: string;
  label: string;
}>): void {
  const bytes = Buffer.from(canonicalize(input.payload), 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== input.integrityDigest
    || !verifySignature(null, bytes, input.publicKeyPem, Buffer.from(input.signature, 'base64url'))) {
    throw new Error(`${input.label} signature or canonical digest is invalid`);
  }
}

function assertAdmissionSignature(
  registry: GateA3ActorRegistry,
  admission: GateA3RunScopedAcceptanceAdmission,
): void {
  const actor = actorForRole(registry, 'signer');
  if (admission.signer.actorId !== actor.actorId
    || admission.signer.sessionId !== actor.sessionId
    || admission.signer.keyId !== actor.keyId) {
    throw new Error('Gate A.3 acceptance admission signer is not the frozen registry signer');
  }
  assertSignedPayload({
    payload: acceptanceAdmissionSigningPayload(admission),
    integrityDigest: admission.integrity.canonicalSha256,
    signature: admission.signer.signature,
    publicKeyPem: actor.publicKeyPem,
    label: 'Gate A.3 acceptance admission',
  });
}

function assertPrelaunchSignature(
  registry: GateA3ActorRegistry,
  receipt: GateA3PrelaunchTopologyReceipt,
): void {
  const actor = actorForRole(registry, 'verifier');
  if (receipt.verifier.actorId !== actor.actorId
    || receipt.verifier.sessionId !== actor.sessionId
    || receipt.verifier.keyId !== actor.keyId) {
    throw new Error('Gate A.3 prelaunch receipt verifier is not the frozen registry verifier');
  }
  assertSignedPayload({
    payload: prelaunchReceiptSigningPayload(receipt),
    integrityDigest: receipt.integrity.canonicalSha256,
    signature: receipt.verifier.signature,
    publicKeyPem: actor.publicKeyPem,
    label: 'Gate A.3 prelaunch receipt',
  });
}

function assertBundleCrossBindings(bundle: GateA3ControlPlaneAuthorityBundle): void {
  const { actorRegistry, acceptanceAdmission, prelaunchReceipt, envelope } = bundle;
  const actorRegistryDigest = registryDigest(actorRegistry);
  const acceptanceAdmissionDigest = canonicalDigest(acceptanceAdmission);
  const prelaunchReceiptDigest = canonicalDigest(prelaunchReceipt);
  const envelopePayload = structuredClone(envelope);
  Reflect.deleteProperty(envelopePayload, 'authorityDigest');
  if (actorRegistry.registryDigest !== actorRegistryDigest
    || acceptanceAdmission.actorRegistryDigest !== actorRegistryDigest
    || prelaunchReceipt.actorRegistryDigest !== actorRegistryDigest
    || envelope.actorRegistryDigest !== actorRegistryDigest) {
    throw new Error('Gate A.3 ActorRegistry digest bindings are inconsistent');
  }
  if (prelaunchReceipt.acceptanceAdmissionDigest !== acceptanceAdmissionDigest
    || envelope.acceptanceAdmissionDigest !== acceptanceAdmissionDigest
    || envelope.prelaunchReceiptDigest !== prelaunchReceiptDigest) {
    throw new Error('Gate A.3 admission/prelaunch digest bindings are inconsistent');
  }
  if (envelope.authorityDigest !== canonicalDigest(envelopePayload)) {
    throw new Error('Gate A.3 Control Plane envelope digest is invalid');
  }
  const common = [actorRegistry, acceptanceAdmission, prelaunchReceipt, envelope] as const;
  if (common.some((value) => value.candidateDigest !== envelope.candidateDigest
    || value.sourceManifestDigest !== envelope.sourceManifestDigest)) {
    throw new Error('Gate A.3 candidate/source bindings are inconsistent');
  }
  if (acceptanceAdmission.runId !== envelope.runId || prelaunchReceipt.runId !== envelope.runId
    || acceptanceAdmission.capabilityId !== envelope.capabilityId
    || acceptanceAdmission.strictPreflightDigest !== envelope.approvedPreflightDigest
    || acceptanceAdmission.controllerRecordDigest !== envelope.controllerAdmissionDigest
    || prelaunchReceipt.strictPreflightDigest !== envelope.approvedPreflightDigest
    || prelaunchReceipt.controllerRecordDigest !== envelope.controllerAdmissionDigest
    || acceptanceAdmission.credentialVersionIds.provider !== envelope.credentialVersionIds.provider
    || acceptanceAdmission.credentialVersionIds.connector !== envelope.credentialVersionIds.connector
    || prelaunchReceipt.credentialVersionIds.provider !== envelope.credentialVersionIds.provider
    || prelaunchReceipt.credentialVersionIds.connector !== envelope.credentialVersionIds.connector
    || acceptanceAdmission.runtime.imageId !== envelope.runtimeImageId
    || acceptanceAdmission.runtime.topologyDigest !== envelope.runtimeTopologyDigest
    || prelaunchReceipt.runtimeImageId !== envelope.runtimeImageId
    || prelaunchReceipt.runtimeTopologyDigest !== envelope.runtimeTopologyDigest
    || prelaunchReceipt.runtimeAuthorityDigest !== envelope.runtimeAuthorityDigest
    || prelaunchReceipt.dynamicAuthorityDigest !== envelope.dynamicAuthorityDigest
    || envelope.releaseState !== 'shadow' || envelope.publicCustomerState !== 'NOT_OPEN') {
    throw new Error('Gate A.3 run/release/runtime bindings are inconsistent');
  }
}

export function assertGateA3ControlPlaneAuthorityCurrent(
  bundle: GateA3ControlPlaneAuthorityBundle,
  now: Date = new Date(),
  requireFullRunway = false,
): void {
  const parsed = gateA3ControlPlaneAuthorityBundleSchema.parse(bundle);
  assertAdmissionSignature(parsed.actorRegistry, parsed.acceptanceAdmission);
  assertPrelaunchSignature(parsed.actorRegistry, parsed.prelaunchReceipt);
  assertBundleCrossBindings(parsed);
  const nowMs = now.getTime();
  const admissionExpiry = Date.parse(parsed.acceptanceAdmission.expiresAt);
  const receiptExpiry = Date.parse(parsed.prelaunchReceipt.expiresAt);
  const envelopeExpiry = Date.parse(parsed.envelope.expiresAt);
  if (!Number.isFinite(nowMs) || nowMs < Date.parse(parsed.acceptanceAdmission.issuedAt)
    || nowMs < Date.parse(parsed.prelaunchReceipt.observedAt)
    || nowMs >= admissionExpiry || nowMs >= receiptExpiry || nowMs >= envelopeExpiry) {
    throw new Error('Gate A.3 run-scoped authority is not currently effective');
  }
  if (requireFullRunway) {
    const requiredRunway = parsed.acceptanceAdmission.declaredMaximumRunDurationMs
      + parsed.acceptanceAdmission.maxInvocationTokenTtlMs
      + parsed.acceptanceAdmission.shutdownGraceMs;
    if (admissionExpiry - nowMs < requiredRunway || receiptExpiry - nowMs < requiredRunway
      || envelopeExpiry - nowMs < requiredRunway) {
      throw new Error('Gate A.3 run-scoped authority has insufficient startup runway');
    }
  }
}

export function assertGateA3CapabilityAcceptanceAggregate(
  bundle: GateA3ControlPlaneAuthorityBundle,
  value: unknown,
  now: Date = new Date(),
): GateA3CapabilityAcceptanceAggregate {
  assertGateA3ControlPlaneAuthorityCurrent(bundle, now);
  const aggregate = gateA3CapabilityAcceptanceAggregateSchema.parse(value);
  const verifier = actorForRole(bundle.actorRegistry, 'verifier');
  if (aggregate.verifier.actorId !== verifier.actorId
    || aggregate.verifier.sessionId !== verifier.sessionId
    || aggregate.verifier.keyId !== verifier.keyId) {
    throw new Error('Gate A.3 acceptance aggregate verifier is not the frozen registry verifier');
  }
  assertSignedPayload({
    payload: acceptanceAggregateSigningPayload(aggregate),
    integrityDigest: aggregate.integrity.canonicalSha256,
    signature: aggregate.verifier.signature,
    publicKeyPem: verifier.publicKeyPem,
    label: 'Gate A.3 acceptance aggregate',
  });
  const { acceptanceAdmission, envelope } = bundle;
  if (aggregate.runId !== acceptanceAdmission.runId
    || aggregate.candidateDigest !== envelope.candidateDigest
    || aggregate.sourceManifestDigest !== envelope.sourceManifestDigest
    || aggregate.authorityDigest !== envelope.authorityDigest
    || aggregate.acceptanceAdmissionDigest !== canonicalDigest(acceptanceAdmission)
    || aggregate.strictPreflightDigest !== acceptanceAdmission.strictPreflightDigest
    || aggregate.controllerRecordDigest !== acceptanceAdmission.controllerRecordDigest
    || aggregate.actorRegistryDigest !== acceptanceAdmission.actorRegistryDigest
    || aggregate.credentialVersionIds.provider !== acceptanceAdmission.credentialVersionIds.provider
    || aggregate.credentialVersionIds.connector !== acceptanceAdmission.credentialVersionIds.connector
    || aggregate.runtimeImageId !== acceptanceAdmission.runtime.imageId
    || aggregate.runtimeTopologyDigest !== acceptanceAdmission.runtime.topologyDigest
    || Date.parse(aggregate.issuedAt) > now.getTime()
    || Date.parse(aggregate.expiresAt) <= now.getTime()
    || Date.parse(aggregate.issuedAt) >= Date.parse(acceptanceAdmission.expiresAt)) {
    throw new Error('Gate A.3 acceptance aggregate does not bind the current immutable run');
  }
  return aggregate;
}

async function readOwnedBundle(filePath: string): Promise<Readonly<{ raw: Buffer; value: unknown }>> {
  if (!isAbsolute(filePath) || filePath.includes('\0') || filePath.includes(CODEX_AUTHORITY_SEGMENT)) {
    throw new Error('Gate A.3 Control Plane bundle path must be an absolute non-Codex path');
  }
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.()
    || (before.mode & 0o777) !== 0o600 || before.size < 2 || before.size > 512 * 1_024) {
    throw new Error('Gate A.3 Control Plane bundle must be an owned regular 0600 file');
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Gate A.3 Control Plane bundle changed while opening');
    }
    const raw = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Gate A.3 Control Plane bundle changed while reading');
    }
    return { raw, value: JSON.parse(raw.toString('utf8')) as unknown };
  } finally {
    await handle.close();
  }
}

export async function readGateA3ControlPlaneAuthorityBundle(input: Readonly<{
  bundleFile: string;
  expectedRawSha256: string;
  now?: Date;
}>): Promise<GateA3ControlPlaneAuthorityBundle> {
  if (!SHA256.test(input.expectedRawSha256)) {
    throw new Error('Gate A.3 Control Plane bundle digest is invalid');
  }
  const { raw, value } = await readOwnedBundle(input.bundleFile);
  if (createHash('sha256').update(raw).digest('hex') !== input.expectedRawSha256) {
    throw new Error('Gate A.3 Control Plane bundle bytes do not match the prelaunch handoff');
  }
  const bundle = gateA3ControlPlaneAuthorityBundleSchema.parse(value);
  assertGateA3ControlPlaneAuthorityCurrent(bundle, input.now ?? new Date(), true);
  return bundle;
}

export const gateA3AuthorityCanonical = Object.freeze({
  digest: canonicalDigest,
  registryDigest,
  acceptanceAdmissionSigningPayload,
  prelaunchReceiptSigningPayload,
  acceptanceAggregateSigningPayload,
});
