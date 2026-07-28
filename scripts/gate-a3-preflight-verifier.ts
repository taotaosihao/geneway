import { createHash, verify } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import {
  gateA3StrictPreflightCandidateSchema,
  type GateA3ActorRegistry,
  type GateA3ExactSourceManifest,
  type GateA3OwnerApproval,
  type GateA3OwnerRegistry,
  type GateA3StrictPreflightCandidate,
} from '@geneway/contracts';

const SHA256 = /^[a-f0-9]{64}$/u;

const digest = (value: unknown): string => createHash('sha256')
  .update(canonicalize(value), 'utf8').digest('hex');

function digestWithout<T extends object>(value: T, field: keyof T): string {
  const payload = structuredClone(value);
  Reflect.deleteProperty(payload, field);
  return digest(payload);
}

function ownerApprovalPayload(approval: GateA3OwnerApproval): unknown {
  const payload = structuredClone(approval);
  Reflect.deleteProperty(payload, 'signature');
  return payload;
}

function sourceManifestDigest(manifest: GateA3ExactSourceManifest): string {
  const payload = structuredClone(manifest);
  Reflect.deleteProperty(payload, 'manifestDigest');
  Reflect.deleteProperty(payload, 'producedBy');
  return digest(payload);
}

function preflightIntegrityPayload(preflight: GateA3StrictPreflightCandidate): unknown {
  const payload = structuredClone(preflight);
  Reflect.deleteProperty(payload.integrity, 'canonicalSha256');
  return payload;
}

export function assertGateA3StrictPreflightAuthority(
  value: unknown,
  trust: Readonly<{
    actorRegistryDigest: string;
    ownerRegistryDigest: string;
    expectedSourceManifestDigest: string;
  }>,
  now: Date = new Date(),
): GateA3StrictPreflightCandidate {
  if (!SHA256.test(trust.actorRegistryDigest) || !SHA256.test(trust.ownerRegistryDigest)
    || !SHA256.test(trust.expectedSourceManifestDigest)) {
    throw new Error('Gate A.3 preflight trust anchors must be exact SHA-256 digests');
  }
  const preflight = gateA3StrictPreflightCandidateSchema.parse(value);
  const actorRegistryDigest = digestWithout(preflight.actorRegistry, 'registryDigest');
  const ownerRegistryDigest = digestWithout(preflight.ownerRegistry, 'registryDigest');
  const expectedSourceManifestDigest = sourceManifestDigest(preflight.expectedSourceManifest);
  const observedSourceManifestDigest = sourceManifestDigest(preflight.observedSourceManifest);
  if (preflight.actorRegistry.registryDigest !== actorRegistryDigest
    || actorRegistryDigest !== trust.actorRegistryDigest
    || preflight.ownerRegistry.registryDigest !== ownerRegistryDigest
    || ownerRegistryDigest !== trust.ownerRegistryDigest
    || preflight.expectedSourceManifest.manifestDigest !== expectedSourceManifestDigest
    || expectedSourceManifestDigest !== trust.expectedSourceManifestDigest
    || preflight.observedSourceManifest.manifestDigest !== observedSourceManifestDigest
    || observedSourceManifestDigest !== expectedSourceManifestDigest) {
    throw new Error('Gate A.3 preflight registry or source-manifest digest is invalid');
  }
  const approvalNonces = new Set<string>();
  for (const approval of preflight.ownerApprovals) {
    const owner = preflight.ownerRegistry.owners.find((candidate) => candidate.role === approval.role);
    if (owner === undefined || approvalNonces.has(approval.nonce)
      || Date.parse(approval.approvedAt) > now.getTime()
      || Date.parse(approval.expiresAt) <= now.getTime()) {
      throw new Error('Gate A.3 preflight owner approval identity, nonce, or time is invalid');
    }
    approvalNonces.add(approval.nonce);
    const bytes = Buffer.from(canonicalize(ownerApprovalPayload(approval)), 'utf8');
    let signatureValid = false;
    try {
      signatureValid = verify(
        null,
        bytes,
        owner.publicKeyPem,
        Buffer.from(approval.signature, 'base64url'),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) throw new Error(`Gate A.3 ${approval.role} owner approval signature is invalid`);
  }
  if (Date.parse(preflight.issuedAt) > now.getTime() || Date.parse(preflight.expiresAt) <= now.getTime()
    || digest(preflightIntegrityPayload(preflight)) !== preflight.integrity.canonicalSha256) {
    throw new Error('Gate A.3 preflight integrity or effective interval is invalid');
  }
  return preflight;
}

export const gateA3PreflightCanonical = Object.freeze({
  digest,
  actorRegistryDigest: (registry: GateA3ActorRegistry) => digestWithout(registry, 'registryDigest'),
  ownerRegistryDigest: (registry: GateA3OwnerRegistry) => digestWithout(registry, 'registryDigest'),
  sourceManifestDigest,
  ownerApprovalPayload,
  preflightIntegrityPayload,
});
