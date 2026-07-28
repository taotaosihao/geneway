import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { describe, expect, it } from 'vitest';
import { gateA3StrictPreflightCandidateSchema } from './gate-a3-preflight.js';

const sha = (character: string): string => character.repeat(64);
const signature = 'A'.repeat(86);
const publicKey = (character: string): string => `-----BEGIN PUBLIC KEY-----\n${character.repeat(43)}=\n-----END PUBLIC KEY-----\n`;

function strictPreflightFixture() {
  const candidateDigest = sha('a');
  const manifestDigest = sha('b');
  const actorRoles = ['implementer', 'reviewer', 'verifier', 'controller', 'signer'] as const;
  const ownerRoles = ['deployment', 'credential', 'api_authorization', 'data_test_object'] as const;
  const expectedSourceManifest = {
    schemaVersion: 'gate-a3-exact-source-manifest/1',
    candidateDigest,
    producedBy: 'expected-source-owner',
    entries: [
      { path: 'deploy/Dockerfile.gate-a3-runtime', sha256: sha('c'), kind: 'deployment-config' },
      { path: 'scripts/gate-a3-prelaunch-verifier.ts', sha256: sha('d'), kind: 'runner' },
    ],
    manifestDigest,
  } as const;
  const owners = ownerRoles.map((role, index) => ({
    role,
    actorId: `owner-${role}`,
    keyId: `owner-key-${role}`,
    publicKeyPem: publicKey(String(index + 6)),
  }));
  return gateA3StrictPreflightCandidateSchema.parse({
    schemaVersion: 'geneway.gate-a3-strict-preflight/2',
    candidateDigest,
    status: 'owner-approved-candidate',
    environmentClass: 'isolated-local-development',
    productionAuthority: false,
    publicCustomerState: 'NOT_OPEN',
    actorRegistry: {
      schemaVersion: 'gate-a3-actor-registry/1',
      candidateDigest,
      sourceManifestDigest: manifestDigest,
      frozenAt: '2026-07-28T01:00:00.000Z',
      actors: actorRoles.map((role, index) => ({
        role,
        actorId: `actor-${role}`,
        sessionId: `session-${role}`,
        keyId: `key-${role}`,
        publicKeyPem: publicKey(String(index + 1)),
      })),
      registryDigest: sha('e'),
    },
    ownerRegistry: {
      schemaVersion: 'gate-a3-owner-registry/1',
      candidateDigest,
      expectedSourceManifestDigest: manifestDigest,
      frozenAt: '2026-07-28T01:00:00.000Z',
      owners,
      registryDigest: sha('f'),
    },
    expectedSourceManifest,
    observedSourceManifest: { ...expectedSourceManifest, producedBy: 'independent-verifier' },
    ownerApprovals: ownerRoles.map((role, index) => ({
      schemaVersion: 'gate-a3-owner-approval/1',
      role,
      actorId: owners[index]?.actorId,
      keyId: owners[index]?.keyId,
      candidateDigest,
      expectedSourceManifestDigest: manifestDigest,
      actorRegistryDigest: sha('e'),
      ownerRegistryDigest: sha('f'),
      credentialVersionId: role === 'credential' ? 'gearjob-credential-version-1' : null,
      testObjectDigest: role === 'data_test_object' ? sha('1') : null,
      decision: 'APPROVE_ISOLATED_LOCAL_GATE_A3',
      approvedAt: '2026-07-28T01:10:00.000Z',
      expiresAt: '2026-07-28T05:00:00.000Z',
      nonce: `owner-approval-nonce-${String(index)}`,
      signature,
    })),
    target: {
      baseUrl: 'http://127.0.0.1:8100',
      endpoint: '/api/method/gearjob.api.work_order.get_work_order_status',
      method: 'GET',
      endpointMethodAllowlistDigest: 'b415df4a23faaebc8779b0ddf86f63209ec0345aed9bfaad178b57b5803b74e5',
      redirectPolicy: 'reject',
    },
    credential: {
      servicePrincipal: 'geneway-gate-a3@dev.local',
      authenticationScheme: 'frappe-api-token',
      credentialVersionId: 'gearjob-credential-version-1',
      secretPresent: false,
      connectorGatewayPidExclusive: true,
      isolationReceiptDigest: sha('2'),
    },
    resourceAuthorization: {
      permissionPoint: 'gearjob.api.work_order.get_work_order_status',
      objectKind: 'Work Order',
      objectCardinality: 'exactly-one',
      objectSelectedByUser: true,
      listAccess: false,
      databaseAccess: false,
      writeAccess: false,
      rolePolicyDigest: sha('3'),
      userPermissionPolicyDigest: sha('4'),
    },
    requestResponse: {
      requestSchemaVersion: 'connector-work-order-request/1',
      responseSchemaVersion: 'connector-work-order-response/1',
      cardSchemaVersion: 'WorkOrderStatusCard/1',
      invocationTokenSchemaVersion: 'connector-invocation-token/1',
      connectorProfileVersion: 'gearjob-work-order-status-dev/1',
      fieldMaskVersion: 'gearjob-work-order-status-nine-fields/1',
      fieldMask: ['workOrderRef', 'status', 'planQty', 'completedQty', 'unit', 'plannedStart',
        'plannedEnd', 'updatedAt', 'sourceRevision'],
      fieldMaskDigest: 'ee8a67aa0bc5933ebd26c9d6b09425bd09ebf0cf58fa727fa4a94e6288030e11',
      notFoundForbiddenEquivalence: 'indistinguishable-public-error',
      unknownResponseFields: 'reject',
    },
    operationalPolicy: {
      connectorConnectTimeoutMs: 2_000,
      connectorResponseTimeoutMs: 5_000,
      maximumAttempts: 2,
      retryableClasses: ['CONNECTOR_RATE_LIMITED', 'CONNECTOR_ROUTE_UNAVAILABLE', 'CONNECTOR_TIMEOUT'],
      rateLimit: { requests: 2, windowMs: 60_000 },
      auditFields: ['requestId', 'principalId', 'workOrderRefHash', 'responseDigest', 'statusClass'],
      allowedSideEffects: ['bounded-access-audit-append', 'bounded-cache-session-metrics'],
      businessMutationAllowed: false,
    },
    namedTestObject: {
      objectDigest: sha('1'),
      opaqueReference: 'approved-local-work-order-1',
      sanitizedLocalData: true,
      customerProductionData: false,
    },
    runtime: {
      runtimeAuthorityDigest: sha('5'),
      dynamicAuthorityDigest: sha('6'),
      runtimeImageId: `sha256:${sha('7')}`,
      runtimeTopologyDigest: sha('8'),
    },
    issuedAt: '2026-07-28T01:15:00.000Z',
    expiresAt: '2026-07-28T05:00:00.000Z',
    integrity: { canonicalizationVersion: 'RFC8785/JCS-1', canonicalSha256: sha('9') },
  });
}

function withoutPath(value: unknown, path: readonly string[]): unknown {
  const clone = structuredClone(value) as Record<string, unknown>;
  let current = clone;
  for (const segment of path.slice(0, -1)) {
    current = current[segment] as Record<string, unknown>;
  }
  Reflect.deleteProperty(current, path.at(-1) ?? '');
  return clone;
}

describe('Gate A.3 strict preflight candidate', () => {
  it('accepts only the fully locked expected/observed candidate', () => {
    expect(gateA3StrictPreflightCandidateSchema.parse(strictPreflightFixture()).status)
      .toBe('owner-approved-candidate');
  });

  it.each([
    ['target', 'baseUrl'],
    ['credential', 'credentialVersionId'],
    ['resourceAuthorization', 'permissionPoint'],
    ['requestResponse', 'fieldMask'],
    ['operationalPolicy', 'retryableClasses'],
    ['namedTestObject', 'objectDigest'],
    ['runtime', 'runtimeImageId'],
    ['integrity', 'canonicalSha256'],
  ])('rejects deletion of required safety field %s.%s', (objectName, fieldName) => {
    expect(gateA3StrictPreflightCandidateSchema.safeParse(
      withoutPath(strictPreflightFixture(), [objectName, fieldName]),
    ).success).toBe(false);
  });

  it.each([
    ['target'],
    ['credential'],
    ['resourceAuthorization'],
    ['requestResponse'],
    ['operationalPolicy'],
    ['namedTestObject'],
    ['runtime'],
    ['integrity'],
  ])('rejects unknown fields in strict object %s', (objectName) => {
    const fixture = structuredClone(strictPreflightFixture()) as unknown as Record<string, Record<string, unknown>>;
    fixture[objectName] = { ...fixture[objectName], unexpected: true };
    expect(gateA3StrictPreflightCandidateSchema.safeParse(fixture).success).toBe(false);
  });

  it('rejects source mismatch and owner/execution actor collapse', () => {
    const sourceMismatch = structuredClone(strictPreflightFixture());
    sourceMismatch.observedSourceManifest.entries[0]!.sha256 = sha('0');
    expect(gateA3StrictPreflightCandidateSchema.safeParse(sourceMismatch).success).toBe(false);

    const actorCollapse = structuredClone(strictPreflightFixture());
    actorCollapse.ownerRegistry.owners[0].actorId = actorCollapse.actorRegistry.actors[0].actorId;
    actorCollapse.ownerApprovals[0].actorId = actorCollapse.actorRegistry.actors[0].actorId;
    expect(gateA3StrictPreflightCandidateSchema.safeParse(actorCollapse).success).toBe(false);
  });

  it('rejects credential and test-object owner approvals bound to a different tuple', () => {
    const credentialDrift = structuredClone(strictPreflightFixture());
    credentialDrift.ownerApprovals[1].credentialVersionId = 'gearjob-credential-version-2';
    expect(gateA3StrictPreflightCandidateSchema.safeParse(credentialDrift).success).toBe(false);

    const objectDrift = structuredClone(strictPreflightFixture());
    objectDrift.ownerApprovals[3].testObjectDigest = sha('0');
    expect(gateA3StrictPreflightCandidateSchema.safeParse(objectDrift).success).toBe(false);
  });

  it('verifies trust-anchored registry/source digests and every independent owner signature', async () => {
    const verifierModulePath: string = '../../../scripts/gate-a3-preflight-verifier.js';
    const verifier = await import(verifierModulePath) as unknown as Readonly<{
      assertGateA3StrictPreflightAuthority: (
        value: unknown,
        trust: Readonly<{
          actorRegistryDigest: string;
          ownerRegistryDigest: string;
          expectedSourceManifestDigest: string;
        }>,
        now: Date,
      ) => unknown;
      gateA3PreflightCanonical: Readonly<{
        digest: (value: unknown) => string;
        actorRegistryDigest: (value: unknown) => string;
        ownerRegistryDigest: (value: unknown) => string;
        sourceManifestDigest: (value: unknown) => string;
        ownerApprovalPayload: (value: unknown) => unknown;
        preflightIntegrityPayload: (value: unknown) => unknown;
      }>;
    }>;
    const { assertGateA3StrictPreflightAuthority, gateA3PreflightCanonical } = verifier;
    const preflight = structuredClone(strictPreflightFixture());
    const sourceManifestDigest = gateA3PreflightCanonical.sourceManifestDigest(
      preflight.expectedSourceManifest,
    );
    preflight.expectedSourceManifest.manifestDigest = sourceManifestDigest;
    preflight.observedSourceManifest.manifestDigest = sourceManifestDigest;
    preflight.actorRegistry.sourceManifestDigest = sourceManifestDigest;
    preflight.ownerRegistry.expectedSourceManifestDigest = sourceManifestDigest;
    preflight.actorRegistry.registryDigest = gateA3PreflightCanonical.actorRegistryDigest(
      preflight.actorRegistry,
    );

    const ownerKeys = preflight.ownerRegistry.owners.map((owner) => ({
      role: owner.role,
      keyPair: generateKeyPairSync('ed25519'),
    }));
    for (let index = 0; index < preflight.ownerRegistry.owners.length; index += 1) {
      const owner = preflight.ownerRegistry.owners[index];
      const key = ownerKeys[index];
      if (owner === undefined || key === undefined) throw new Error('owner fixture is incomplete');
      owner.publicKeyPem = key.keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    }
    preflight.ownerRegistry.registryDigest = gateA3PreflightCanonical.ownerRegistryDigest(
      preflight.ownerRegistry,
    );
    for (let index = 0; index < preflight.ownerApprovals.length; index += 1) {
      const approval = preflight.ownerApprovals[index];
      const key = ownerKeys[index];
      if (approval === undefined || key === undefined || approval.role !== key.role) {
        throw new Error('owner approval fixture is incomplete');
      }
      approval.expectedSourceManifestDigest = sourceManifestDigest;
      approval.actorRegistryDigest = preflight.actorRegistry.registryDigest;
      approval.ownerRegistryDigest = preflight.ownerRegistry.registryDigest;
      approval.signature = sign(
        null,
        Buffer.from(canonicalize(gateA3PreflightCanonical.ownerApprovalPayload(approval)), 'utf8'),
        key.keyPair.privateKey,
      ).toString('base64url');
    }
    preflight.integrity.canonicalSha256 = gateA3PreflightCanonical.digest(
      gateA3PreflightCanonical.preflightIntegrityPayload(preflight),
    );
    const parsed = gateA3StrictPreflightCandidateSchema.parse(preflight);
    const trust = {
      actorRegistryDigest: parsed.actorRegistry.registryDigest,
      ownerRegistryDigest: parsed.ownerRegistry.registryDigest,
      expectedSourceManifestDigest: sourceManifestDigest,
    };
    expect(assertGateA3StrictPreflightAuthority(
      parsed,
      trust,
      new Date('2026-07-28T02:00:00.000Z'),
    )).toEqual(parsed);

    const tampered = structuredClone(parsed);
    tampered.ownerApprovals[0].signature = `${tampered.ownerApprovals[0].signature.slice(0, -1)}B`;
    expect(() => assertGateA3StrictPreflightAuthority(
      tampered,
      trust,
      new Date('2026-07-28T02:00:00.000Z'),
    )).toThrow(/signature/u);
  });
});
