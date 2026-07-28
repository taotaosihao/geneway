import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from 'json-canonicalize';
import { describe, expect, it } from 'vitest';
import {
  gateA3ActorRegistrySchema,
  gateA3CapabilityAcceptanceAggregateSchema,
  gateA3ControlPlaneAuthorityBundleSchema,
  gateA3PrelaunchTopologyReceiptSchema,
  gateA3RunScopedAcceptanceAdmissionSchema,
  type GateA3ControlPlaneAuthorityBundle,
} from '@geneway/contracts';
import {
  assertGateA3ControlPlaneAuthorityCurrent,
  assertGateA3CapabilityAcceptanceAggregate,
  gateA3AuthorityCanonical,
  readGateA3ControlPlaneAuthorityBundle,
} from './gate-a3-prelaunch-authority.js';

const ZERO_DIGEST = '0'.repeat(64);
const EMPTY_SIGNATURE = 'A'.repeat(86);
const NOW = new Date('2026-07-28T02:00:00.000Z');

const sha256 = (value: string | Uint8Array): string => createHash('sha256')
  .update(value).digest('hex');

function signedFixtureWithKeys(): Readonly<{
  bundle: GateA3ControlPlaneAuthorityBundle;
  verifierPrivateKey: KeyObject;
}> {
  const roles = ['implementer', 'reviewer', 'verifier', 'controller', 'signer'] as const;
  const actors = roles.map((role) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      identity: {
        role,
        actorId: `actor-${role}`,
        sessionId: `session-${role}`,
        keyId: `key-${role}`,
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      },
      privateKey,
    };
  });
  let actorRegistry = gateA3ActorRegistrySchema.parse({
    schemaVersion: 'gate-a3-actor-registry/1',
    candidateDigest: 'a'.repeat(64),
    sourceManifestDigest: 'b'.repeat(64),
    frozenAt: '2026-07-28T01:30:00.000Z',
    actors: actors.map(({ identity }) => identity),
    registryDigest: ZERO_DIGEST,
  });
  actorRegistry = gateA3ActorRegistrySchema.parse({
    ...actorRegistry,
    registryDigest: gateA3AuthorityCanonical.registryDigest(actorRegistry),
  });

  const signer = actors.find(({ identity }) => identity.role === 'signer');
  if (signer === undefined) throw new Error('fixture signer is missing');
  let acceptanceAdmission = gateA3RunScopedAcceptanceAdmissionSchema.parse({
    schemaVersion: 'gate-a3-internal-acceptance-admission/1',
    decision: 'ADMIT_IMMUTABLE_SHADOW_ACCEPTANCE',
    runId: 'gate-a3-test-run',
    capabilityId: 'production.work-order-status.v1',
    candidateDigest: actorRegistry.candidateDigest,
    sourceManifestDigest: actorRegistry.sourceManifestDigest,
    acceptanceManifestDigest: 'c'.repeat(64),
    authorityRevision: 'authority-revision-1',
    actorRegistryDigest: actorRegistry.registryDigest,
    strictPreflightDigest: 'd'.repeat(64),
    controllerRecordDigest: 'e'.repeat(64),
    preOpenReceiptDigests: ['d'.repeat(64), 'e'.repeat(64)],
    allowlistedPrincipal: {
      tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local',
    },
    allowlistedObjectDigest: 'f'.repeat(64),
    credentialVersionIds: {
      provider: 'provider-version-1', connector: 'connector-version-1',
    },
    runtime: {
      imageId: `sha256:${'1'.repeat(64)}`,
      topologyDigest: '2'.repeat(64),
    },
    issuedAt: '2026-07-28T01:45:00.000Z',
    expiresAt: '2026-07-28T05:00:00.000Z',
    declaredMaximumRunDurationMs: 60 * 60 * 1_000,
    maxInvocationTokenTtlMs: 60_000,
    shutdownGraceMs: 60_000,
    renewalOf: null,
    signer: {
      actorId: signer.identity.actorId,
      sessionId: signer.identity.sessionId,
      keyId: signer.identity.keyId,
      nonce: 'admission-nonce-1',
      signature: EMPTY_SIGNATURE,
    },
    integrity: {
      canonicalizationVersion: 'RFC8785/JCS-1', canonicalSha256: ZERO_DIGEST,
    },
  });
  const admissionPayload = gateA3AuthorityCanonical.acceptanceAdmissionSigningPayload(
    acceptanceAdmission,
  );
  const admissionBytes = Buffer.from(canonicalize(admissionPayload), 'utf8');
  acceptanceAdmission = gateA3RunScopedAcceptanceAdmissionSchema.parse({
    ...acceptanceAdmission,
    signer: {
      ...acceptanceAdmission.signer,
      signature: sign(null, admissionBytes, signer.privateKey).toString('base64url'),
    },
    integrity: {
      ...acceptanceAdmission.integrity,
      canonicalSha256: sha256(admissionBytes),
    },
  });

  const verifier = actors.find(({ identity }) => identity.role === 'verifier');
  if (verifier === undefined) throw new Error('fixture verifier is missing');
  let prelaunchReceipt = gateA3PrelaunchTopologyReceiptSchema.parse({
    schemaVersion: 'gate-a3-prelaunch-topology-receipt/1',
    runId: acceptanceAdmission.runId,
    candidateDigest: acceptanceAdmission.candidateDigest,
    sourceManifestDigest: acceptanceAdmission.sourceManifestDigest,
    acceptanceAdmissionDigest: gateA3AuthorityCanonical.digest(acceptanceAdmission),
    actorRegistryDigest: actorRegistry.registryDigest,
    strictPreflightDigest: acceptanceAdmission.strictPreflightDigest,
    controllerRecordDigest: acceptanceAdmission.controllerRecordDigest,
    credentialVersionIds: acceptanceAdmission.credentialVersionIds,
    runtimeImageId: acceptanceAdmission.runtime.imageId,
    runtimeTopologyDigest: acceptanceAdmission.runtime.topologyDigest,
    runtimeAuthorityDigest: '7'.repeat(64),
    dynamicAuthorityDigest: '8'.repeat(64),
    runtimeIpv4: '172.31.0.10',
    runtimePort: 8100,
    businessProcessBoundary: {
      dockerHostPresent: false,
      dockerSocketVisible: false,
      dockerCliExecutable: false,
      codexAuthorityVisible: false,
    },
    observedAt: '2026-07-28T01:50:00.000Z',
    expiresAt: '2026-07-28T05:00:00.000Z',
    verifier: {
      actorId: verifier.identity.actorId,
      sessionId: verifier.identity.sessionId,
      keyId: verifier.identity.keyId,
      commandManifestDigest: '3'.repeat(64),
      rawOutputDigest: '4'.repeat(64),
      nonce: 'prelaunch-nonce-1',
      signature: EMPTY_SIGNATURE,
    },
    integrity: {
      canonicalizationVersion: 'RFC8785/JCS-1', canonicalSha256: ZERO_DIGEST,
    },
  });
  const receiptPayload = gateA3AuthorityCanonical.prelaunchReceiptSigningPayload(prelaunchReceipt);
  const receiptBytes = Buffer.from(canonicalize(receiptPayload), 'utf8');
  prelaunchReceipt = gateA3PrelaunchTopologyReceiptSchema.parse({
    ...prelaunchReceipt,
    verifier: {
      ...prelaunchReceipt.verifier,
      signature: sign(null, receiptBytes, verifier.privateKey).toString('base64url'),
    },
    integrity: {
      ...prelaunchReceipt.integrity,
      canonicalSha256: sha256(receiptBytes),
    },
  });

  const envelopeBody = {
    schemaVersion: 'gate-a3-control-plane-authority-envelope/2',
    capabilityId: acceptanceAdmission.capabilityId,
    artifactId: 'gate-a3-test-authority',
    releaseState: 'shadow',
    publicCustomerState: 'NOT_OPEN',
    environmentClass: 'isolated-local-development',
    productionAuthority: false,
    runId: acceptanceAdmission.runId,
    candidateDigest: acceptanceAdmission.candidateDigest,
    sourceManifestDigest: acceptanceAdmission.sourceManifestDigest,
    actorRegistryDigest: actorRegistry.registryDigest,
    acceptanceAdmissionDigest: gateA3AuthorityCanonical.digest(acceptanceAdmission),
    internalValidationAdmissionDigest: gateA3AuthorityCanonical.digest(acceptanceAdmission),
    renewalOfInternalAdmissionDigest: null,
    prelaunchReceiptDigest: gateA3AuthorityCanonical.digest(prelaunchReceipt),
    approvedPreflightDigest: acceptanceAdmission.strictPreflightDigest,
    controllerAdmissionDigest: acceptanceAdmission.controllerRecordDigest,
    preflightControllerAdmissionDigest: acceptanceAdmission.controllerRecordDigest,
    gearjobCommit: 'b'.repeat(40),
    credentialVersionIds: acceptanceAdmission.credentialVersionIds,
    runtimeAuthorityDigest: '7'.repeat(64),
    dynamicAuthorityDigest: '8'.repeat(64),
    runtimeImageId: acceptanceAdmission.runtime.imageId,
    runtimeTopologyDigest: acceptanceAdmission.runtime.topologyDigest,
    connectorProfileVersion: 'gearjob-work-order-status-dev/1',
    endpointMethodAllowlistDigest: '9'.repeat(64),
    fieldMaskVersion: 'gearjob-work-order-status-nine-fields/1',
    fieldMaskDigest: 'a'.repeat(64),
    invocationTokenSchemaVersion: 'connector-invocation-token/1',
    responseSchemaVersion: 'connector-work-order-response/1',
    cardSchemaVersion: 'WorkOrderStatusCard/1',
    issuedAt: acceptanceAdmission.issuedAt,
    effectiveAt: acceptanceAdmission.issuedAt,
    expiresAt: acceptanceAdmission.expiresAt,
  } as const;
  const bundle = gateA3ControlPlaneAuthorityBundleSchema.parse({
    schemaVersion: 'gate-a3-control-plane-authority-bundle/1',
    actorRegistry,
    acceptanceAdmission,
    prelaunchReceipt,
    envelope: {
      ...envelopeBody,
      authorityDigest: gateA3AuthorityCanonical.digest(envelopeBody),
    },
  });
  return { bundle, verifierPrivateKey: verifier.privateKey };
}

const signedFixture = (): GateA3ControlPlaneAuthorityBundle => signedFixtureWithKeys().bundle;

describe('Gate A.3 prelaunch authority bundle', () => {
  it('accepts a strict, independently signed, shadow-only bundle with full runway', () => {
    expect(() => assertGateA3ControlPlaneAuthorityCurrent(signedFixture(), NOW, true)).not.toThrow();
  });

  it('rejects unknown safety-critical fields at every bundle boundary', () => {
    const bundle = signedFixture();
    expect(gateA3ControlPlaneAuthorityBundleSchema.safeParse({ ...bundle, unexpected: true }).success)
      .toBe(false);
    expect(gateA3ControlPlaneAuthorityBundleSchema.safeParse({
      ...bundle,
      acceptanceAdmission: {
        ...bundle.acceptanceAdmission,
        runtime: { ...bundle.acceptanceAdmission.runtime, unexpected: true },
      },
    }).success).toBe(false);
    expect(gateA3ControlPlaneAuthorityBundleSchema.safeParse({
      ...bundle,
      prelaunchReceipt: {
        ...bundle.prelaunchReceipt,
        businessProcessBoundary: {
          ...bundle.prelaunchReceipt.businessProcessBoundary, unexpected: true,
        },
      },
    }).success).toBe(false);
  });

  it('rejects actor identity collision, signature tamper, and candidate drift', () => {
    const actorCollision = structuredClone(signedFixture());
    actorCollision.actorRegistry.actors[1].sessionId = actorCollision.actorRegistry.actors[0].sessionId;
    expect(() => assertGateA3ControlPlaneAuthorityCurrent(actorCollision, NOW)).toThrow();

    const signatureTamper = structuredClone(signedFixture());
    signatureTamper.acceptanceAdmission.signer.signature = `B${
      signatureTamper.acceptanceAdmission.signer.signature.slice(1)}`;
    expect(() => assertGateA3ControlPlaneAuthorityCurrent(signatureTamper, NOW))
      .toThrow(/signature or canonical digest/u);

    const candidateDrift = structuredClone(signedFixture());
    candidateDrift.envelope.candidateDigest = 'f'.repeat(64);
    expect(() => assertGateA3ControlPlaneAuthorityCurrent(candidateDrift, NOW))
      .toThrow(/envelope digest|candidate\/source/u);
  });

  it('rejects an overlong lease, inadequate runway, and expired authority', () => {
    const fixture = signedFixture();
    expect(gateA3RunScopedAcceptanceAdmissionSchema.safeParse({
      ...fixture.acceptanceAdmission,
      expiresAt: '2026-07-28T10:00:00.001Z',
    }).success).toBe(false);
    expect(gateA3RunScopedAcceptanceAdmissionSchema.safeParse({
      ...fixture.acceptanceAdmission,
      expiresAt: '2026-07-28T02:00:00.000Z',
    }).success).toBe(false);
    expect(() => assertGateA3ControlPlaneAuthorityCurrent(
      fixture,
      new Date('2026-07-28T05:00:00.000Z'),
    )).toThrow(/not currently effective/u);
  });

  it('reads only the exact prelaunch handoff bytes from a non-Codex 0600 file', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'geneway-gate-a3-bundle-'));
    const bundleFile = join(parent, 'control-plane-authority.json');
    try {
      const raw = `${JSON.stringify(signedFixture())}\n`;
      await writeFile(bundleFile, raw, { mode: 0o600 });
      await chmod(bundleFile, 0o600);
      await expect(readGateA3ControlPlaneAuthorityBundle({
        bundleFile, expectedRawSha256: sha256(raw), now: NOW,
      })).resolves.toMatchObject({ schemaVersion: 'gate-a3-control-plane-authority-bundle/1' });
      await expect(readGateA3ControlPlaneAuthorityBundle({
        bundleFile, expectedRawSha256: 'f'.repeat(64), now: NOW,
      })).rejects.toThrow(/bytes do not match/u);
      await expect(readGateA3ControlPlaneAuthorityBundle({
        bundleFile: '/tmp/.codex/workflow/artifacts/forbidden.json',
        expectedRawSha256: sha256(raw),
        now: NOW,
      })).rejects.toThrow(/non-Codex path/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('accepts only a fresh V1-V7 aggregate signed by this run verifier', () => {
    const { bundle, verifierPrivateKey } = signedFixtureWithKeys();
    let aggregate = gateA3CapabilityAcceptanceAggregateSchema.parse({
      schemaVersion: 'gate-a3-capability-acceptance-aggregate/1',
      result: 'pass',
      capabilityId: bundle.envelope.capabilityId,
      runId: bundle.acceptanceAdmission.runId,
      candidateDigest: bundle.envelope.candidateDigest,
      sourceManifestDigest: bundle.envelope.sourceManifestDigest,
      authorityDigest: bundle.envelope.authorityDigest,
      acceptanceAdmissionDigest: gateA3AuthorityCanonical.digest(bundle.acceptanceAdmission),
      strictPreflightDigest: bundle.acceptanceAdmission.strictPreflightDigest,
      controllerRecordDigest: bundle.acceptanceAdmission.controllerRecordDigest,
      actorRegistryDigest: bundle.actorRegistry.registryDigest,
      credentialVersionIds: bundle.envelope.credentialVersionIds,
      runtimeImageId: bundle.envelope.runtimeImageId,
      runtimeTopologyDigest: bundle.envelope.runtimeTopologyDigest,
      steps: ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7'].map((step, index) => ({
        step,
        result: 'pass',
        receiptDigest: String(index + 1).repeat(64),
      })),
      issuedAt: '2026-07-28T02:05:00.000Z',
      expiresAt: '2026-07-28T04:00:00.000Z',
      verifier: {
        actorId: bundle.actorRegistry.actors[2].actorId,
        sessionId: bundle.actorRegistry.actors[2].sessionId,
        keyId: bundle.actorRegistry.actors[2].keyId,
        nonce: 'aggregate-nonce-1',
        signature: EMPTY_SIGNATURE,
      },
      integrity: {
        canonicalizationVersion: 'RFC8785/JCS-1', canonicalSha256: ZERO_DIGEST,
      },
    });
    const payload = gateA3AuthorityCanonical.acceptanceAggregateSigningPayload(aggregate);
    const bytes = Buffer.from(canonicalize(payload), 'utf8');
    aggregate = gateA3CapabilityAcceptanceAggregateSchema.parse({
      ...aggregate,
      verifier: {
        ...aggregate.verifier,
        signature: sign(null, bytes, verifierPrivateKey).toString('base64url'),
      },
      integrity: { ...aggregate.integrity, canonicalSha256: sha256(bytes) },
    });
    const aggregateNow = new Date('2026-07-28T02:10:00.000Z');
    expect(assertGateA3CapabilityAcceptanceAggregate(bundle, aggregate, aggregateNow)).toEqual(aggregate);
    expect(() => assertGateA3CapabilityAcceptanceAggregate(
      bundle,
      { ...aggregate, sourceManifestDigest: 'f'.repeat(64) },
      aggregateNow,
    )).toThrow(/signature|immutable run/u);
  });
});
