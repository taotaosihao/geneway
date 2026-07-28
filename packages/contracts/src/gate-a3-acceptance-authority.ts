import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);
const publicKeySchema = z.string().regex(
  /^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END PUBLIC KEY-----\n$/u,
);
const credentialVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);
const relativeManifestPathSchema = z.string().min(1).max(512).superRefine((value, context) => {
  if (value.startsWith('/') || value.includes('\0') || value.split('/').some((part) => part === '..' || part === '')) {
    context.addIssue({ code: 'custom', message: 'source manifest paths must be normalized relative paths' });
  }
});

export const gateA3ActorRoleSchema = z.enum([
  'implementer',
  'reviewer',
  'verifier',
  'controller',
  'signer',
]);

export const gateA3OwnerRoleSchema = z.enum([
  'deployment',
  'credential',
  'api_authorization',
  'data_test_object',
]);

const actorIdentity = <T extends z.infer<typeof gateA3ActorRoleSchema>>(role: T) => z.object({
  role: z.literal(role),
  actorId: safeIdSchema,
  sessionId: safeIdSchema,
  keyId: safeIdSchema,
  publicKeyPem: publicKeySchema,
}).strict();

const ownerIdentity = <T extends z.infer<typeof gateA3OwnerRoleSchema>>(role: T) => z.object({
  role: z.literal(role),
  actorId: safeIdSchema,
  keyId: safeIdSchema,
  publicKeyPem: publicKeySchema,
}).strict();

export const gateA3ActorRegistrySchema = z.object({
  schemaVersion: z.literal('gate-a3-actor-registry/1'),
  candidateDigest: sha256Schema,
  sourceManifestDigest: sha256Schema,
  frozenAt: z.string().datetime({ offset: true }),
  actors: z.tuple([
    actorIdentity('implementer'),
    actorIdentity('reviewer'),
    actorIdentity('verifier'),
    actorIdentity('controller'),
    actorIdentity('signer'),
  ]),
  registryDigest: sha256Schema,
}).strict().superRefine((registry, context) => {
  for (const field of ['actorId', 'sessionId', 'keyId', 'publicKeyPem'] as const) {
    const values = registry.actors.map((actor) => actor[field]);
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', path: ['actors'], message: `actor ${field} values must be pairwise distinct` });
    }
  }
});

export const gateA3OwnerRegistrySchema = z.object({
  schemaVersion: z.literal('gate-a3-owner-registry/1'),
  candidateDigest: sha256Schema,
  expectedSourceManifestDigest: sha256Schema,
  frozenAt: z.string().datetime({ offset: true }),
  owners: z.tuple([
    ownerIdentity('deployment'),
    ownerIdentity('credential'),
    ownerIdentity('api_authorization'),
    ownerIdentity('data_test_object'),
  ]),
  registryDigest: sha256Schema,
}).strict().superRefine((registry, context) => {
  for (const field of ['actorId', 'keyId', 'publicKeyPem'] as const) {
    const values = registry.owners.map((owner) => owner[field]);
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', path: ['owners'], message: `owner ${field} values must be pairwise distinct` });
    }
  }
});

export const gateA3SourceManifestEntrySchema = z.object({
  path: relativeManifestPathSchema,
  sha256: sha256Schema,
  kind: z.enum(['file', 'source-tree', 'runner', 'deployment-config', 'container-image']),
}).strict();

export const gateA3ExactSourceManifestSchema = z.object({
  schemaVersion: z.literal('gate-a3-exact-source-manifest/1'),
  candidateDigest: sha256Schema,
  producedBy: z.enum(['expected-source-owner', 'independent-verifier']),
  entries: z.array(gateA3SourceManifestEntrySchema).min(1),
  manifestDigest: sha256Schema,
}).strict().superRefine((manifest, context) => {
  const paths = manifest.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: 'custom', path: ['entries'], message: 'source manifest paths must be unique' });
  }
  const sorted = [...manifest.entries].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(sorted) !== JSON.stringify(manifest.entries)) {
    context.addIssue({ code: 'custom', path: ['entries'], message: 'source manifest entries must be path-sorted' });
  }
});

export const gateA3OwnerApprovalSchema = z.object({
  schemaVersion: z.literal('gate-a3-owner-approval/1'),
  role: gateA3OwnerRoleSchema,
  actorId: safeIdSchema,
  keyId: safeIdSchema,
  candidateDigest: sha256Schema,
  expectedSourceManifestDigest: sha256Schema,
  actorRegistryDigest: sha256Schema,
  ownerRegistryDigest: sha256Schema,
  credentialVersionId: credentialVersionSchema.nullable(),
  testObjectDigest: sha256Schema.nullable(),
  decision: z.literal('APPROVE_ISOLATED_LOCAL_GATE_A3'),
  approvedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  nonce: safeIdSchema,
  signature: signatureSchema,
}).strict().superRefine((approval, context) => {
  const hasCredential = approval.credentialVersionId !== null;
  const hasTestObject = approval.testObjectDigest !== null;
  if (hasCredential !== (approval.role === 'credential')) {
    context.addIssue({ code: 'custom', path: ['credentialVersionId'], message: 'only the credential owner binds credentialVersionId' });
  }
  if (hasTestObject !== (approval.role === 'data_test_object')) {
    context.addIssue({ code: 'custom', path: ['testObjectDigest'], message: 'only the data/test-object owner binds testObjectDigest' });
  }
  if (Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'owner approval expiry must follow approval time' });
  }
});

export const gateA3SignedRoleReceiptSchema = z.object({
  schemaVersion: z.literal('gate-a3-signed-role-receipt/1'),
  role: gateA3ActorRoleSchema,
  actorId: safeIdSchema,
  sessionId: safeIdSchema,
  keyId: safeIdSchema,
  candidateDigest: sha256Schema,
  sourceManifestDigest: sha256Schema,
  commandManifestDigest: sha256Schema,
  rawOutputDigest: sha256Schema,
  result: z.enum(['pass', 'fail']),
  issuedAt: z.string().datetime({ offset: true }),
  nonce: safeIdSchema,
  signature: signatureSchema,
}).strict();

export const gateA3ControllerRecordSchema = z.object({
  schemaVersion: z.literal('gate-a3-preopen-controller-record/1'),
  decision: z.literal('ADMIT_SIGNER_FOR_SHADOW_ACCEPTANCE'),
  candidateDigest: sha256Schema,
  sourceManifestDigest: sha256Schema,
  actorRegistryDigest: sha256Schema,
  strictPreflightDigest: sha256Schema,
  reviewReceiptDigest: sha256Schema,
  verificationReceiptDigest: sha256Schema,
  ownerApprovalDigests: z.tuple([
    sha256Schema,
    sha256Schema,
    sha256Schema,
    sha256Schema,
  ]),
  credentialVersionIds: z.object({
    provider: credentialVersionSchema,
    connector: credentialVersionSchema,
  }).strict(),
  issuedAt: z.string().datetime({ offset: true }),
  controller: z.object({
    actorId: safeIdSchema,
    sessionId: safeIdSchema,
    keyId: safeIdSchema,
    nonce: safeIdSchema,
    signature: signatureSchema,
  }).strict(),
  integrity: z.object({
    canonicalizationVersion: z.literal('RFC8785/JCS-1'),
    canonicalSha256: sha256Schema,
  }).strict(),
}).strict();

export const gateA3RunScopedAcceptanceAdmissionSchema = z.object({
  schemaVersion: z.literal('gate-a3-internal-acceptance-admission/1'),
  decision: z.literal('ADMIT_IMMUTABLE_SHADOW_ACCEPTANCE'),
  runId: runIdSchema,
  capabilityId: z.literal('production.work-order-status.v1'),
  candidateDigest: sha256Schema,
  sourceManifestDigest: sha256Schema,
  acceptanceManifestDigest: sha256Schema,
  authorityRevision: safeIdSchema,
  actorRegistryDigest: sha256Schema,
  strictPreflightDigest: sha256Schema,
  controllerRecordDigest: sha256Schema,
  preOpenReceiptDigests: z.array(sha256Schema).min(1),
  allowlistedPrincipal: z.object({
    tenantId: z.literal('tenant_local'),
    userId: z.literal('user_local'),
    trust: z.literal('trusted-local'),
  }).strict(),
  allowlistedObjectDigest: sha256Schema,
  credentialVersionIds: z.object({
    provider: credentialVersionSchema,
    connector: credentialVersionSchema,
  }).strict(),
  runtime: z.object({
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    topologyDigest: sha256Schema,
  }).strict(),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  declaredMaximumRunDurationMs: z.number().int().positive().max(8 * 60 * 60 * 1_000),
  maxInvocationTokenTtlMs: z.number().int().positive().max(10 * 60 * 1_000),
  shutdownGraceMs: z.number().int().min(30_000).max(15 * 60 * 1_000),
  renewalOf: z.null(),
  signer: z.object({
    actorId: safeIdSchema,
    sessionId: safeIdSchema,
    keyId: safeIdSchema,
    nonce: safeIdSchema,
    signature: signatureSchema,
  }).strict(),
  integrity: z.object({
    canonicalizationVersion: z.literal('RFC8785/JCS-1'),
    canonicalSha256: sha256Schema,
  }).strict(),
}).strict().superRefine((admission, context) => {
  const issuedAt = Date.parse(admission.issuedAt);
  const expiresAt = Date.parse(admission.expiresAt);
  const leaseMs = expiresAt - issuedAt;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 8 * 60 * 60 * 1_000) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'acceptance lease must be positive and no longer than eight hours' });
  }
  const requiredRunway = admission.declaredMaximumRunDurationMs
    + admission.maxInvocationTokenTtlMs
    + admission.shutdownGraceMs;
  if (leaseMs < requiredRunway) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'acceptance lease does not satisfy the mechanical runway inequality' });
  }
  if (new Set(admission.preOpenReceiptDigests).size !== admission.preOpenReceiptDigests.length) {
    context.addIssue({ code: 'custom', path: ['preOpenReceiptDigests'], message: 'pre-open receipt digests must be unique' });
  }
  if (!admission.preOpenReceiptDigests.includes(admission.strictPreflightDigest)
    || !admission.preOpenReceiptDigests.includes(admission.controllerRecordDigest)) {
    context.addIssue({ code: 'custom', path: ['preOpenReceiptDigests'], message: 'pre-open receipts must include strict preflight and controller record' });
  }
});

export const gateA3PrelaunchTopologyReceiptSchema = z.object({
  schemaVersion: z.literal('gate-a3-prelaunch-topology-receipt/1'),
  runId: runIdSchema,
  candidateDigest: sha256Schema,
  sourceManifestDigest: sha256Schema,
  acceptanceAdmissionDigest: sha256Schema,
  actorRegistryDigest: sha256Schema,
  strictPreflightDigest: sha256Schema,
  controllerRecordDigest: sha256Schema,
  credentialVersionIds: z.object({
    provider: credentialVersionSchema,
    connector: credentialVersionSchema,
  }).strict(),
  runtimeImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  runtimeTopologyDigest: sha256Schema,
  runtimeAuthorityDigest: sha256Schema,
  dynamicAuthorityDigest: sha256Schema,
  runtimeIpv4: z.ipv4(),
  runtimePort: z.literal(8100),
  businessProcessBoundary: z.object({
    dockerHostPresent: z.literal(false),
    dockerSocketVisible: z.literal(false),
    dockerCliExecutable: z.literal(false),
    codexAuthorityVisible: z.literal(false),
  }).strict(),
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  verifier: z.object({
    actorId: safeIdSchema,
    sessionId: safeIdSchema,
    keyId: safeIdSchema,
    commandManifestDigest: sha256Schema,
    rawOutputDigest: sha256Schema,
    nonce: safeIdSchema,
    signature: signatureSchema,
  }).strict(),
  integrity: z.object({
    canonicalizationVersion: z.literal('RFC8785/JCS-1'),
    canonicalSha256: sha256Schema,
  }).strict(),
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.observedAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'prelaunch receipt expiry must follow observation time' });
  }
});

export const gateA3ControlPlaneAuthorityEnvelopeSchema = z.object({
  schemaVersion: z.literal('gate-a3-control-plane-authority-envelope/2'),
  authorityDigest: sha256Schema,
  capabilityId: z.literal('production.work-order-status.v1'),
  artifactId: safeIdSchema,
  releaseState: z.literal('shadow'),
  publicCustomerState: z.literal('NOT_OPEN'),
  environmentClass: z.literal('isolated-local-development'),
  productionAuthority: z.literal(false),
  runId: runIdSchema,
  candidateDigest: sha256Schema,
  sourceManifestDigest: sha256Schema,
  actorRegistryDigest: sha256Schema,
  acceptanceAdmissionDigest: sha256Schema,
  internalValidationAdmissionDigest: sha256Schema,
  renewalOfInternalAdmissionDigest: z.null(),
  prelaunchReceiptDigest: sha256Schema,
  approvedPreflightDigest: sha256Schema,
  controllerAdmissionDigest: sha256Schema,
  preflightControllerAdmissionDigest: sha256Schema,
  gearjobCommit: gitCommitSchema,
  credentialVersionIds: z.object({
    provider: credentialVersionSchema,
    connector: credentialVersionSchema,
  }).strict(),
  runtimeAuthorityDigest: sha256Schema,
  dynamicAuthorityDigest: sha256Schema,
  runtimeImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  runtimeTopologyDigest: sha256Schema,
  connectorProfileVersion: z.literal('gearjob-work-order-status-dev/1'),
  endpointMethodAllowlistDigest: sha256Schema,
  fieldMaskVersion: z.literal('gearjob-work-order-status-nine-fields/1'),
  fieldMaskDigest: sha256Schema,
  invocationTokenSchemaVersion: z.literal('connector-invocation-token/1'),
  responseSchemaVersion: z.literal('connector-work-order-response/1'),
  cardSchemaVersion: z.literal('WorkOrderStatusCard/1'),
  issuedAt: z.string().datetime({ offset: true }),
  effectiveAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict().superRefine((envelope, context) => {
  if (envelope.acceptanceAdmissionDigest !== envelope.internalValidationAdmissionDigest) {
    context.addIssue({
      code: 'custom',
      path: ['internalValidationAdmissionDigest'],
      message: 'the durable internal-admission alias must bind the run-scoped acceptance admission',
    });
  }
  if (envelope.controllerAdmissionDigest !== envelope.preflightControllerAdmissionDigest) {
    context.addIssue({
      code: 'custom',
      path: ['preflightControllerAdmissionDigest'],
      message: 'the durable controller-admission alias must bind the strict controller admission',
    });
  }
  if (envelope.issuedAt !== envelope.effectiveAt) {
    context.addIssue({
      code: 'custom',
      path: ['effectiveAt'],
      message: 'the durable effective time must equal the envelope issue time',
    });
  }
});

export const gateA3ControlPlaneAuthorityBundleSchema = z.object({
  schemaVersion: z.literal('gate-a3-control-plane-authority-bundle/1'),
  actorRegistry: gateA3ActorRegistrySchema,
  acceptanceAdmission: gateA3RunScopedAcceptanceAdmissionSchema,
  prelaunchReceipt: gateA3PrelaunchTopologyReceiptSchema,
  envelope: gateA3ControlPlaneAuthorityEnvelopeSchema,
}).strict();

export const gateA3CapabilityAcceptanceAggregateSchema = z.object({
  schemaVersion: z.literal('gate-a3-capability-acceptance-aggregate/1'),
  result: z.literal('pass'),
  capabilityId: z.literal('production.work-order-status.v1'),
  runId: runIdSchema,
  candidateDigest: sha256Schema,
  sourceManifestDigest: sha256Schema,
  authorityDigest: sha256Schema,
  acceptanceAdmissionDigest: sha256Schema,
  strictPreflightDigest: sha256Schema,
  controllerRecordDigest: sha256Schema,
  actorRegistryDigest: sha256Schema,
  credentialVersionIds: z.object({
    provider: credentialVersionSchema,
    connector: credentialVersionSchema,
  }).strict(),
  runtimeImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  runtimeTopologyDigest: sha256Schema,
  steps: z.tuple([
    z.object({ step: z.literal('V1'), result: z.literal('pass'), receiptDigest: sha256Schema }).strict(),
    z.object({ step: z.literal('V2'), result: z.literal('pass'), receiptDigest: sha256Schema }).strict(),
    z.object({ step: z.literal('V3'), result: z.literal('pass'), receiptDigest: sha256Schema }).strict(),
    z.object({ step: z.literal('V4'), result: z.literal('pass'), receiptDigest: sha256Schema }).strict(),
    z.object({ step: z.literal('V5'), result: z.literal('pass'), receiptDigest: sha256Schema }).strict(),
    z.object({ step: z.literal('V6'), result: z.literal('pass'), receiptDigest: sha256Schema }).strict(),
    z.object({ step: z.literal('V7'), result: z.literal('pass'), receiptDigest: sha256Schema }).strict(),
  ]),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  verifier: z.object({
    actorId: safeIdSchema,
    sessionId: safeIdSchema,
    keyId: safeIdSchema,
    nonce: safeIdSchema,
    signature: signatureSchema,
  }).strict(),
  integrity: z.object({
    canonicalizationVersion: z.literal('RFC8785/JCS-1'),
    canonicalSha256: sha256Schema,
  }).strict(),
}).strict().superRefine((aggregate, context) => {
  if (Date.parse(aggregate.expiresAt) <= Date.parse(aggregate.issuedAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'aggregate expiry must follow issue time' });
  }
  const receipts = aggregate.steps.map((step) => step.receiptDigest);
  if (new Set(receipts).size !== receipts.length) {
    context.addIssue({ code: 'custom', path: ['steps'], message: 'V1-V7 receipt digests must be unique' });
  }
});

export type GateA3ActorRegistry = z.infer<typeof gateA3ActorRegistrySchema>;
export type GateA3OwnerRegistry = z.infer<typeof gateA3OwnerRegistrySchema>;
export type GateA3ExactSourceManifest = z.infer<typeof gateA3ExactSourceManifestSchema>;
export type GateA3OwnerApproval = z.infer<typeof gateA3OwnerApprovalSchema>;
export type GateA3ControllerRecord = z.infer<typeof gateA3ControllerRecordSchema>;
export type GateA3RunScopedAcceptanceAdmission = z.infer<typeof gateA3RunScopedAcceptanceAdmissionSchema>;
export type GateA3PrelaunchTopologyReceipt = z.infer<typeof gateA3PrelaunchTopologyReceiptSchema>;
export type GateA3ControlPlaneAuthorityEnvelope = z.infer<typeof gateA3ControlPlaneAuthorityEnvelopeSchema>;
export type GateA3ControlPlaneAuthorityBundle = z.infer<typeof gateA3ControlPlaneAuthorityBundleSchema>;
export type GateA3CapabilityAcceptanceAggregate = z.infer<typeof gateA3CapabilityAcceptanceAggregateSchema>;
