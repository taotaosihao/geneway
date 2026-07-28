import { z } from 'zod';
import { gateA3GearJobRuntimeAuthoritySchema } from './gate-a3-runtime-authority.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const idSchema = z.string().min(1).max(256);

export const GATE_A3_LOCAL_ADMISSION_KEY_ID = 'geneway-gate-a3-local-admission-root/1' as const;
export const GATE_A3_LOCAL_ADMISSION_ALGORITHM = 'Ed25519' as const;
export const GATE_A3_LOCAL_ADMISSION_SIGNED_PAYLOAD =
  'RFC8785/JCS internal admission with integrity.canonical_sha256 and admission_signature.signature omitted' as const;
export const GATE_A3_LOCAL_ADMISSION_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5K9Fxlmd7Mp/2KsLDlTbaDVg5SujoN4qTNyBaGh/ekM=
-----END PUBLIC KEY-----
` as const;

export const gateA3PreflightArtifactSchema = z.object({
  schema_version: z.literal('geneway.gearjob-preflight/1'),
  artifact_id: idSchema,
  task_id: z.literal('20260723-008-geneway-gate-a-gearjob'),
  slice_id: z.literal('gate-a-business-mvp'),
  capability_id: z.literal('production.work-order-status.v1'),
  status: z.literal('approved'),
  environment_class: z.literal('isolated-local-development'),
  production_authority: z.literal(false),
  approved_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  target_site_and_endpoint: z.object({
    base_url: z.literal('http://127.0.0.1:8100'),
    endpoint: z.literal('/api/method/gearjob.api.work_order.get_work_order_status'),
    methods: z.tuple([z.literal('GET')]),
    endpoint_method_allowlist_digest: z.literal('b415df4a23faaebc8779b0ddf86f63209ec0345aed9bfaad178b57b5803b74e5'),
  }).passthrough(),
  service_identity_and_credential: z.object({
    service_principal: z.literal('geneway-gate-a3@dev.local'),
    invocation_token: z.object({
      schema_version: z.literal('connector-invocation-token/1'),
      issuer: z.literal('geneway-control-plane'),
      audience: z.literal('gearjob-work-order-status-connector'),
      max_ttl_seconds: z.literal(60),
      max_clock_skew_seconds: z.literal(5),
    }).passthrough(),
  }).passthrough(),
  strict_request_response_and_field_mask: z.object({
    field_mask: z.object({
      version: z.literal('gearjob-work-order-status-nine-fields/1'),
      digest: z.literal('ee8a67aa0bc5933ebd26c9d6b09425bd09ebf0cf58fa727fa4a94e6288030e11'),
    }).passthrough(),
  }).passthrough(),
  operational_policy: z.object({
    connector_connect_timeout_ms: z.literal(2000),
    connector_response_timeout_ms: z.literal(5000),
  }).passthrough(),
  runtime_authority: gateA3GearJobRuntimeAuthoritySchema,
  runtime_authority_digest: sha256Schema,
  verification: z.object({ gearjob_commit: gitCommitSchema }).passthrough(),
  release_admission: z.object({
    preflight_result: z.literal('approved-for-local-development'),
    production_release_may_open: z.literal(false),
    required_tuple: z.object({
      approvedPreflightDigest: sha256Schema,
      connectorProfileVersion: z.literal('gearjob-work-order-status-dev/1'),
      fieldMaskVersion: z.literal('gearjob-work-order-status-nine-fields/1'),
      invocationTokenSchemaVersion: z.literal('connector-invocation-token/1'),
      responseSchemaVersion: z.literal('connector-work-order-response/1'),
      cardSchemaVersion: z.literal('WorkOrderStatusCard/1'),
      runtimeAuthorityDigest: sha256Schema,
      dynamicAuthorityDigest: sha256Schema,
      runtimeImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    }).passthrough(),
  }).passthrough(),
  integrity: z.object({
    canonicalization_version: z.literal('RFC8785/JCS-1'),
    digest_scope: z.literal('whole JSON artifact with integrity.canonical_sha256 omitted and release_admission.required_tuple.approvedPreflightDigest set to TO_BE_FILLED'),
    canonical_sha256: sha256Schema,
  }).strict(),
}).passthrough();

export const gateA3ControllerAdmissionArtifactSchema = z.object({
  schema_version: z.literal('geneway.gearjob-preflight-controller-admission/1'),
  task_id: z.literal('20260723-008-geneway-gate-a-gearjob'),
  slice_id: z.literal('gate-a-business-mvp'),
  decision: z.literal('ADMIT_LOCAL_DEVELOPMENT_A3_PRODUCT_CODE'),
  decided_at: z.string().datetime(),
  controller: z.literal('codex-team:/root'),
  authority: z.object({
    environment_class: z.literal('isolated-local-development'),
    production_authority: z.literal(false),
  }).passthrough(),
  required_tuple: z.object({
    gearjob_commit: gitCommitSchema,
    approved_preflight_digest: sha256Schema,
    connector_profile_version: z.literal('gearjob-work-order-status-dev/1'),
    field_mask_version: z.literal('gearjob-work-order-status-nine-fields/1'),
    invocation_token_schema_version: z.literal('connector-invocation-token/1'),
    response_schema_version: z.literal('connector-work-order-response/1'),
    card_schema_version: z.literal('WorkOrderStatusCard/1'),
    runtime_authority_digest: sha256Schema,
    dynamic_authority_digest: sha256Schema,
    runtime_image_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  }).strict(),
  controller_resolution: z.object({
    a3_product_code_may_start: z.literal(true),
    production_work_order_route_status: z.literal('NOT_OPEN'),
    production_release_may_open: z.literal(false),
  }).passthrough(),
}).passthrough();

export const gateA3InternalValidationAdmissionArtifactSchema = z.object({
  schema_version: z.literal('geneway.gate-a3-internal-validation-admission/1'),
  task_id: z.literal('20260723-008-geneway-gate-a-gearjob'),
  slice_id: z.literal('gate-a-business-mvp'),
  decision: z.literal('ADMIT_ISOLATED_LOCAL_INTERNAL_VALIDATION'),
  decided_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  controller: z.literal('codex-team:/root'),
  renewal_of: sha256Schema.optional(),
  authority: z.object({
    environment_class: z.literal('isolated-local-development'),
    production_authority: z.literal(false),
  }).passthrough(),
  required_tuple: z.object({
    approved_preflight_digest: sha256Schema,
    preflight_controller_admission_digest: sha256Schema,
    gearjob_commit: gitCommitSchema,
    runtime_authority_digest: sha256Schema,
    dynamic_authority_digest: sha256Schema,
    runtime_image_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  }).strict(),
  release_scope: z.object({
    maximum_state: z.literal('internal'),
    internal_acceptance_only: z.literal(true),
    production_release_may_open: z.literal(false),
  }).strict(),
  forbidden: z.array(z.string().min(1)).min(1),
  admission_signature: z.object({
    key_id: z.literal(GATE_A3_LOCAL_ADMISSION_KEY_ID),
    algorithm: z.literal(GATE_A3_LOCAL_ADMISSION_ALGORITHM),
    signed_payload: z.literal(GATE_A3_LOCAL_ADMISSION_SIGNED_PAYLOAD),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
  }).strict(),
  integrity: z.object({
    canonicalization_version: z.literal('RFC8785/JCS-1'),
    canonical_sha256: sha256Schema,
  }).strict(),
}).passthrough();

export const gateA3AuthorityEnvelopeSchema = z.object({
  schemaVersion: z.literal('gate-a3-authority-envelope/1'),
  authorityDigest: sha256Schema,
  capabilityId: z.literal('production.work-order-status.v1'),
  environmentClass: z.literal('isolated-local-development'),
  productionAuthority: z.literal(false),
  artifactId: idSchema,
  approvedPreflightDigest: sha256Schema,
  preflightControllerAdmissionDigest: sha256Schema,
  internalValidationAdmissionDigest: sha256Schema,
  renewalOfInternalAdmissionDigest: sha256Schema.nullable(),
  gearjobCommit: gitCommitSchema,
  runtimeAuthorityDigest: sha256Schema,
  dynamicAuthorityDigest: sha256Schema,
  runtimeImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  connectorProfileVersion: z.literal('gearjob-work-order-status-dev/1'),
  endpointMethodAllowlistDigest: z.literal('b415df4a23faaebc8779b0ddf86f63209ec0345aed9bfaad178b57b5803b74e5'),
  fieldMaskVersion: z.literal('gearjob-work-order-status-nine-fields/1'),
  fieldMaskDigest: z.literal('ee8a67aa0bc5933ebd26c9d6b09425bd09ebf0cf58fa727fa4a94e6288030e11'),
  invocationTokenSchemaVersion: z.literal('connector-invocation-token/1'),
  responseSchemaVersion: z.literal('connector-work-order-response/1'),
  cardSchemaVersion: z.literal('WorkOrderStatusCard/1'),
  effectiveAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export type GateA3AuthorityEnvelope = z.infer<typeof gateA3AuthorityEnvelopeSchema>;
