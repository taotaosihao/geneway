import { z } from 'zod';
import {
  gateA3ActorRegistrySchema,
  gateA3ExactSourceManifestSchema,
  gateA3OwnerApprovalSchema,
  gateA3OwnerRegistrySchema,
} from './gate-a3-acceptance-authority.js';
import {
  GATE_A3_CONNECTOR_PROFILE_VERSION,
  GATE_A3_FIELD_MASK_VERSION,
  GATE_A3_GEARJOB_ENDPOINT,
  GATE_A3_WORK_ORDER_FIELD_MASK,
} from './gate-a3-work-order.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const credentialVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);

export const gateA3StrictPreflightCandidateSchema = z.object({
  schemaVersion: z.literal('geneway.gate-a3-strict-preflight/2'),
  candidateDigest: sha256Schema,
  status: z.literal('owner-approved-candidate'),
  environmentClass: z.literal('isolated-local-development'),
  productionAuthority: z.literal(false),
  publicCustomerState: z.literal('NOT_OPEN'),
  actorRegistry: gateA3ActorRegistrySchema,
  ownerRegistry: gateA3OwnerRegistrySchema,
  expectedSourceManifest: gateA3ExactSourceManifestSchema,
  observedSourceManifest: gateA3ExactSourceManifestSchema,
  ownerApprovals: z.tuple([
    gateA3OwnerApprovalSchema.refine((approval) => approval.role === 'deployment'),
    gateA3OwnerApprovalSchema.refine((approval) => approval.role === 'credential'),
    gateA3OwnerApprovalSchema.refine((approval) => approval.role === 'api_authorization'),
    gateA3OwnerApprovalSchema.refine((approval) => approval.role === 'data_test_object'),
  ]),
  target: z.object({
    baseUrl: z.literal('http://127.0.0.1:8100'),
    endpoint: z.literal(GATE_A3_GEARJOB_ENDPOINT),
    method: z.literal('GET'),
    endpointMethodAllowlistDigest: z.literal(
      'b415df4a23faaebc8779b0ddf86f63209ec0345aed9bfaad178b57b5803b74e5',
    ),
    redirectPolicy: z.literal('reject'),
  }).strict(),
  credential: z.object({
    servicePrincipal: z.literal('geneway-gate-a3@dev.local'),
    authenticationScheme: z.literal('frappe-api-token'),
    credentialVersionId: credentialVersionSchema,
    secretPresent: z.literal(false),
    connectorGatewayPidExclusive: z.literal(true),
    isolationReceiptDigest: sha256Schema,
  }).strict(),
  resourceAuthorization: z.object({
    permissionPoint: z.literal('gearjob.api.work_order.get_work_order_status'),
    objectKind: z.literal('Work Order'),
    objectCardinality: z.literal('exactly-one'),
    objectSelectedByUser: z.literal(true),
    listAccess: z.literal(false),
    databaseAccess: z.literal(false),
    writeAccess: z.literal(false),
    rolePolicyDigest: sha256Schema,
    userPermissionPolicyDigest: sha256Schema,
  }).strict(),
  requestResponse: z.object({
    requestSchemaVersion: z.literal('connector-work-order-request/1'),
    responseSchemaVersion: z.literal('connector-work-order-response/1'),
    cardSchemaVersion: z.literal('WorkOrderStatusCard/1'),
    invocationTokenSchemaVersion: z.literal('connector-invocation-token/1'),
    connectorProfileVersion: z.literal(GATE_A3_CONNECTOR_PROFILE_VERSION),
    fieldMaskVersion: z.literal(GATE_A3_FIELD_MASK_VERSION),
    fieldMask: z.tuple(GATE_A3_WORK_ORDER_FIELD_MASK.map((field) => z.literal(field)) as [
      z.ZodLiteral<'workOrderRef'>,
      z.ZodLiteral<'status'>,
      z.ZodLiteral<'planQty'>,
      z.ZodLiteral<'completedQty'>,
      z.ZodLiteral<'unit'>,
      z.ZodLiteral<'plannedStart'>,
      z.ZodLiteral<'plannedEnd'>,
      z.ZodLiteral<'updatedAt'>,
      z.ZodLiteral<'sourceRevision'>,
    ]),
    fieldMaskDigest: z.literal(
      'ee8a67aa0bc5933ebd26c9d6b09425bd09ebf0cf58fa727fa4a94e6288030e11',
    ),
    notFoundForbiddenEquivalence: z.literal('indistinguishable-public-error'),
    unknownResponseFields: z.literal('reject'),
  }).strict(),
  operationalPolicy: z.object({
    connectorConnectTimeoutMs: z.literal(2_000),
    connectorResponseTimeoutMs: z.literal(5_000),
    maximumAttempts: z.literal(2),
    retryableClasses: z.tuple([
      z.literal('CONNECTOR_RATE_LIMITED'),
      z.literal('CONNECTOR_ROUTE_UNAVAILABLE'),
      z.literal('CONNECTOR_TIMEOUT'),
    ]),
    rateLimit: z.object({ requests: z.literal(2), windowMs: z.literal(60_000) }).strict(),
    auditFields: z.tuple([
      z.literal('requestId'),
      z.literal('principalId'),
      z.literal('workOrderRefHash'),
      z.literal('responseDigest'),
      z.literal('statusClass'),
    ]),
    allowedSideEffects: z.tuple([
      z.literal('bounded-access-audit-append'),
      z.literal('bounded-cache-session-metrics'),
    ]),
    businessMutationAllowed: z.literal(false),
  }).strict(),
  namedTestObject: z.object({
    objectDigest: sha256Schema,
    opaqueReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    sanitizedLocalData: z.literal(true),
    customerProductionData: z.literal(false),
  }).strict(),
  runtime: z.object({
    runtimeAuthorityDigest: sha256Schema,
    dynamicAuthorityDigest: sha256Schema,
    runtimeImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    runtimeTopologyDigest: sha256Schema,
  }).strict(),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  integrity: z.object({
    canonicalizationVersion: z.literal('RFC8785/JCS-1'),
    canonicalSha256: sha256Schema,
  }).strict(),
}).strict().superRefine((preflight, context) => {
  if (preflight.actorRegistry.candidateDigest !== preflight.candidateDigest
    || preflight.ownerRegistry.candidateDigest !== preflight.candidateDigest
    || preflight.expectedSourceManifest.candidateDigest !== preflight.candidateDigest
    || preflight.observedSourceManifest.candidateDigest !== preflight.candidateDigest) {
    context.addIssue({ code: 'custom', path: ['candidateDigest'], message: 'all registries and manifests must bind the exact candidate' });
  }
  if (preflight.expectedSourceManifest.producedBy !== 'expected-source-owner'
    || preflight.observedSourceManifest.producedBy !== 'independent-verifier'
    || JSON.stringify(preflight.expectedSourceManifest.entries)
      !== JSON.stringify(preflight.observedSourceManifest.entries)
    || preflight.expectedSourceManifest.manifestDigest
      !== preflight.observedSourceManifest.manifestDigest) {
    context.addIssue({ code: 'custom', path: ['observedSourceManifest'], message: 'observed source must exactly equal the frozen expected source' });
  }
  if (preflight.actorRegistry.sourceManifestDigest !== preflight.expectedSourceManifest.manifestDigest
    || preflight.ownerRegistry.expectedSourceManifestDigest !== preflight.expectedSourceManifest.manifestDigest) {
    context.addIssue({ code: 'custom', path: ['expectedSourceManifest'], message: 'registry source bindings are inconsistent' });
  }
  for (const field of ['actorId', 'keyId', 'publicKeyPem'] as const) {
    const actorValues = new Set(preflight.actorRegistry.actors.map((actor) => actor[field]));
    if (preflight.ownerRegistry.owners.some((owner) => actorValues.has(owner[field]))) {
      context.addIssue({ code: 'custom', path: ['ownerRegistry', 'owners'], message: `owner ${field} must be independent of every execution actor` });
    }
  }
  for (let index = 0; index < preflight.ownerApprovals.length; index += 1) {
    const approval = preflight.ownerApprovals[index];
    const owner = preflight.ownerRegistry.owners[index];
    if (approval === undefined || owner === undefined) {
      context.addIssue({ code: 'custom', path: ['ownerApprovals', index], message: 'owner approval tuple is incomplete' });
      continue;
    }
    if (approval.actorId !== owner.actorId || approval.keyId !== owner.keyId
      || approval.candidateDigest !== preflight.candidateDigest
      || approval.expectedSourceManifestDigest !== preflight.expectedSourceManifest.manifestDigest
      || approval.actorRegistryDigest !== preflight.actorRegistry.registryDigest
      || approval.ownerRegistryDigest !== preflight.ownerRegistry.registryDigest
      || approval.credentialVersionId !== (approval.role === 'credential'
        ? preflight.credential.credentialVersionId : null)
      || approval.testObjectDigest !== (approval.role === 'data_test_object'
        ? preflight.namedTestObject.objectDigest : null)) {
      context.addIssue({ code: 'custom', path: ['ownerApprovals', index], message: 'owner approval does not bind the exact frozen preflight tuple' });
    }
  }
  if (Date.parse(preflight.expiresAt) <= Date.parse(preflight.issuedAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'preflight expiry must follow issue time' });
  }
});

export type GateA3StrictPreflightCandidate = z.infer<typeof gateA3StrictPreflightCandidateSchema>;
