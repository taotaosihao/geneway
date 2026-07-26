import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { z } from 'zod';
import a2ExpertRegistry from './fixtures/gate-a/a2-expert-registry.json' with { type: 'json' };
import { GenewayError, gateA2ExpertRegistrySchema } from '@geneway/contracts';

const idSchema = z.string().regex(/^[a-z][a-z0-9_.:/+-]*$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const workflowTemplateNodeSchema = z.object({
  id: idSchema,
  kind: z.enum(['deterministic', 'agent', 'verification']),
  registryReference: z.string().min(1),
  inputRefs: z.array(z.string().min(1)),
  outputSchemaId: z.string().min(1),
}).strict();
export const workflowTemplateEdgeSchema = z.object({ from: idSchema, to: idSchema }).strict();
export const workflowTemplatePermissionCeilingSchema = z.object({
  actions: z.array(z.enum(['R0', 'R1', 'A1'])).min(1),
  resourceScopes: z.array(z.string().min(1)).min(1),
  dataClasses: z.array(z.enum(['C0', 'C1'])).min(1),
  connectors: z.array(z.string().min(1)),
  modelTools: z.array(z.string().min(1)),
}).strict();

const templateIds = [
  'workflow-template.solution-fixture/1',
  'workflow-template.solution-live/1',
  'workflow-template.solution-live/2',
  'workflow-template.work-order-status/1',
] as const;
const capabilityIds = [
  'cap_solution_analysis_v1_1',
  'cap_solution_analysis_v1_live_1',
  'cap_solution_analysis_v1_live_2',
  'cap_production_work_order_status_v1_1',
] as const;
const harnessIds = [
  'harness_solution_analysis_v1_1',
  'harness_solution_analysis_v1_live_1',
  'harness_solution_analysis_v1_live_2',
  'harness_production_work_order_status_v1_1',
] as const;
const unsignedShape = {
  schemaVersion: z.literal('workflow-template-version/1'),
  templateId: z.enum(templateIds),
  capabilityVersionId: z.enum(capabilityIds),
  harnessVersionId: z.enum(harnessIds),
  workflowDraftSchemaVersion: z.enum(['workflow-draft.fixed-v1', 'workflow-draft.template-v1']),
  workflowPayloadSchemaVersion: z.enum(['workflow-version.fixed-v1', 'workflow-version.template-v1']),
  compilerVersion: z.enum(['geneway-workflow-compiler/0.1.0', 'geneway-workflow-compiler/0.2.0']),
  canonicalizationVersion: z.literal('RFC8785/JCS-1'),
  nodes: z.array(workflowTemplateNodeSchema).min(1),
  edges: z.array(workflowTemplateEdgeSchema),
  permissionCeiling: workflowTemplatePermissionCeilingSchema,
} as const;
export const workflowTemplateVersionUnsignedSchema = z.object(unsignedShape).strict();
export const workflowTemplateVersionSchema = z.object({ ...unsignedShape, registryDigest: sha256Schema }).strict();
export type WorkflowTemplateVersion = z.infer<typeof workflowTemplateVersionSchema>;

export const workflowTemplateSelectionSchema = z.object({
  schemaVersion: z.literal('workflow-draft.template-v1'),
  templateId: z.enum(['workflow-template.solution-live/1', 'workflow-template.solution-live/2', 'workflow-template.work-order-status/1']),
  registryDigest: sha256Schema,
}).strict();
export const templateWorkflowVersionPayloadSchema = z.object({
  schemaVersion: z.literal('workflow-version.template-v1'),
  templateSchemaVersion: z.literal('workflow-template-version/1'),
  compilerVersion: z.literal('geneway-workflow-compiler/0.2.0'),
  canonicalizationVersion: z.literal('RFC8785/JCS-1'),
  featureSet: z.literal('fixed-template-v1'),
  templateId: z.enum(['workflow-template.solution-live/1', 'workflow-template.solution-live/2', 'workflow-template.work-order-status/1']),
  registryDigest: sha256Schema,
  capabilityVersionId: z.enum(['cap_solution_analysis_v1_live_1', 'cap_solution_analysis_v1_live_2', 'cap_production_work_order_status_v1_1']),
  harnessVersionId: z.enum(['harness_solution_analysis_v1_live_1', 'harness_solution_analysis_v1_live_2', 'harness_production_work_order_status_v1_1']),
  nodes: z.array(workflowTemplateNodeSchema).min(1),
  edges: z.array(workflowTemplateEdgeSchema),
  permissionCeiling: workflowTemplatePermissionCeilingSchema,
}).strict();
export type TemplateWorkflowVersionPayload = z.infer<typeof templateWorkflowVersionPayloadSchema>;
export type CompiledTemplateWorkflowVersion = Readonly<{
  id: string; hash: string; canonicalizationVersion: 'RFC8785/JCS-1';
  canonicalJson: string; payload: Readonly<TemplateWorkflowVersionPayload>;
}>;

type NodeTuple = readonly [string, 'deterministic' | 'agent' | 'verification', string, readonly string[], string];
const fixtureTuples: readonly NodeTuple[] = [
  ['document_ingest', 'deterministic', 'fixture-reader/1', ['workflow.input.fixtureRef'], 'document.snapshot/1'],
  ['requirement_extract', 'agent', 'cap_solution_analysis_v1_1+harness_solution_analysis_v1_1', ['step.document_ingest.output'], 'requirement.candidates/1'],
  ['contradiction_check', 'agent', 'cap_solution_analysis_v1_1+harness_solution_analysis_v1_1', ['step.requirement_extract.output'], 'contradiction.result/1'],
  ['solution_design', 'agent', 'cap_solution_analysis_v1_1+harness_solution_analysis_v1_1', ['step.requirement_extract.output', 'step.contradiction_check.output'], 'solution.design/1'],
  ['evidence_verify', 'verification', 'claim-evidence-minimum/1', ['step.solution_design.output'], 'evidence.verdict/1'],
  ['result_quality_check', 'verification', 'simulation-quality/1', ['step.evidence_verify.output'], 'quality.verdict/1'],
  ['report_publish', 'deterministic', 'simulation-publisher/1', ['step.result_quality_check.output'], 'report.projection/1'],
];
const liveTuples: readonly NodeTuple[] = [
  ['document_ingest', 'deterministic', 'document-snapshot-reader/live-1', ['workflow.input.documentSnapshotId'], 'document.snapshot.live/1'],
  ['requirement_extract', 'agent', 'agent.solution.requirement/live-1', ['step.document_ingest.output'], 'analysis.requirement-candidates/1'],
  ['contradiction_check', 'agent', 'agent.solution.contradiction/live-1', ['step.requirement_extract.output'], 'analysis.contradiction/1'],
  ['solution_design', 'agent', 'agent.solution.architect/live-1', ['step.requirement_extract.output', 'step.contradiction_check.output'], 'analysis.result-candidate/1'],
  ['evidence_verify', 'verification', 'claim-evidence-live/1', ['step.solution_design.output'], 'evidence.verdict/1'],
  ['result_quality_check', 'verification', 'analysis-quality-live/1', ['step.evidence_verify.output'], 'analysis.quality-verdict/1'],
  ['report_publish', 'deterministic', 'analysis-report-publisher/live-1', ['step.result_quality_check.output'], 'artifact.analysis-report/1'],
];
const workOrderTuples: readonly NodeTuple[] = [
  ['validate_work_order_ref', 'deterministic', 'work-order-ref-validator/1', ['workflow.input.workOrderRef'], 'work-order.ref/1'],
  ['fetch_authorized_status', 'deterministic', 'gearjob-work-order-status-reader/1', ['step.validate_work_order_ref.output'], 'connector.work-order-snapshot/1'],
  ['compute_progress', 'deterministic', 'work-order-progress/1', ['step.fetch_authorized_status.output'], 'work-order.progress/1'],
  ['explain_status', 'agent', 'agent.production.work-order-status/1', ['step.fetch_authorized_status.output', 'step.compute_progress.output'], 'work-order.explanation/1'],
  ['evidence_verify', 'verification', 'connector-evidence/1', ['step.fetch_authorized_status.output', 'step.explain_status.output'], 'evidence.verdict/1'],
  ['publish_status_card', 'deterministic', 'work-order-card-publisher/1', ['step.fetch_authorized_status.output', 'step.compute_progress.output', 'step.explain_status.output', 'step.evidence_verify.output'], 'work-order-status-card/1'],
];
function nodes(tuples: readonly NodeTuple[]) {
  return tuples.map(([id, kind, registryReference, inputRefs, outputSchemaId]) => ({
    id, kind, registryReference, inputRefs: [...inputRefs], outputSchemaId,
  }));
}
function edges(value: ReadonlyArray<{ id: string }>) {
  return value.slice(0, -1).map((node, index) => ({ from: node.id, to: value[index + 1]!.id }));
}
function unsignedDigest(value: unknown): string {
  return createHash('sha256').update(canonicalize(workflowTemplateVersionUnsignedSchema.parse(value)), 'utf8').digest('hex');
}
function entry(value: z.input<typeof workflowTemplateVersionUnsignedSchema>): WorkflowTemplateVersion {
  const unsigned = workflowTemplateVersionUnsignedSchema.parse(value);
  return freezeRecursively(workflowTemplateVersionSchema.parse({ ...unsigned, registryDigest: unsignedDigest(unsigned) }));
}
const fixtureNodes = nodes(fixtureTuples);
const liveNodes = nodes(liveTuples);
function freezeRecursively<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeRecursively(child);
    }
    Object.freeze(value);
  }
  return value;
}
const workOrderNodes = nodes(workOrderTuples);
export const SOLUTION_FIXTURE_TEMPLATE = entry({
  schemaVersion: 'workflow-template-version/1', templateId: 'workflow-template.solution-fixture/1',
  capabilityVersionId: 'cap_solution_analysis_v1_1', harnessVersionId: 'harness_solution_analysis_v1_1',
  workflowDraftSchemaVersion: 'workflow-draft.fixed-v1', workflowPayloadSchemaVersion: 'workflow-version.fixed-v1',
  compilerVersion: 'geneway-workflow-compiler/0.1.0', canonicalizationVersion: 'RFC8785/JCS-1',
  nodes: fixtureNodes, edges: edges(fixtureNodes),
  permissionCeiling: { actions: ['R0', 'R1', 'A1'], resourceScopes: ['fixture:solution-analysis:v1'],
    dataClasses: ['C0', 'C1'], connectors: [], modelTools: [] },
});
export const SOLUTION_LIVE_TEMPLATE = entry({
  schemaVersion: 'workflow-template-version/1', templateId: 'workflow-template.solution-live/1',
  capabilityVersionId: 'cap_solution_analysis_v1_live_1', harnessVersionId: 'harness_solution_analysis_v1_live_1',
  workflowDraftSchemaVersion: 'workflow-draft.template-v1', workflowPayloadSchemaVersion: 'workflow-version.template-v1',
  compilerVersion: 'geneway-workflow-compiler/0.2.0', canonicalizationVersion: 'RFC8785/JCS-1',
  nodes: liveNodes, edges: edges(liveNodes),
  permissionCeiling: { actions: ['R0', 'R1', 'A1'], resourceScopes: ['document-snapshot:approval-subject-bound'],
    dataClasses: ['C0', 'C1'], connectors: [], modelTools: [] },
});
export const SOLUTION_LIVE_V2_TEMPLATE = entry({
  schemaVersion: 'workflow-template-version/1', templateId: 'workflow-template.solution-live/2',
  capabilityVersionId: 'cap_solution_analysis_v1_live_2', harnessVersionId: 'harness_solution_analysis_v1_live_2',
  workflowDraftSchemaVersion: 'workflow-draft.template-v1', workflowPayloadSchemaVersion: 'workflow-version.template-v1',
  compilerVersion: 'geneway-workflow-compiler/0.2.0', canonicalizationVersion: 'RFC8785/JCS-1',
  nodes: liveNodes, edges: edges(liveNodes),
  permissionCeiling: { actions: ['R0', 'R1', 'A1'], resourceScopes: ['document-snapshot:approval-subject-bound'],
    dataClasses: ['C0', 'C1'], connectors: [], modelTools: [] },
});
export const SOLUTION_LIVE_V2_EXPERT_REGISTRY = freezeRecursively(
  gateA2ExpertRegistrySchema.parse(a2ExpertRegistry),
);
export const WORK_ORDER_STATUS_TEMPLATE = entry({
  schemaVersion: 'workflow-template-version/1', templateId: 'workflow-template.work-order-status/1',
  capabilityVersionId: 'cap_production_work_order_status_v1_1',
  harnessVersionId: 'harness_production_work_order_status_v1_1',
  workflowDraftSchemaVersion: 'workflow-draft.template-v1', workflowPayloadSchemaVersion: 'workflow-version.template-v1',
  compilerVersion: 'geneway-workflow-compiler/0.2.0', canonicalizationVersion: 'RFC8785/JCS-1',
  nodes: workOrderNodes, edges: edges(workOrderNodes),
  permissionCeiling: { actions: ['R0', 'R1', 'A1'], resourceScopes: ['gearjob-work-order:connector-query-spec-bound'],
    dataClasses: ['C0', 'C1'], connectors: ['gearjob.work-order-status.read/1'], modelTools: [] },
});
export const GATE_A_WORKFLOW_TEMPLATE_REGISTRY = Object.freeze({
  [SOLUTION_FIXTURE_TEMPLATE.templateId]: SOLUTION_FIXTURE_TEMPLATE,
  [SOLUTION_LIVE_TEMPLATE.templateId]: SOLUTION_LIVE_TEMPLATE,
  [SOLUTION_LIVE_V2_TEMPLATE.templateId]: SOLUTION_LIVE_V2_TEMPLATE,
  [WORK_ORDER_STATUS_TEMPLATE.templateId]: WORK_ORDER_STATUS_TEMPLATE,
});
function assertDigest(value: WorkflowTemplateVersion): void {
  const { registryDigest, ...unsigned } = value;
  if (unsignedDigest(unsigned) !== registryDigest) throw new GenewayError('NOT_OPEN', 'Workflow registry digest mismatch', 422);
}
export function compileTemplateWorkflow(input: unknown): CompiledTemplateWorkflowVersion {
  const selection = workflowTemplateSelectionSchema.parse(input);
  const selected = GATE_A_WORKFLOW_TEMPLATE_REGISTRY[selection.templateId];
  if (selected === undefined) {
    throw new GenewayError('NOT_OPEN', 'Workflow template is not registered', 422);
  }
  assertDigest(selected);
  if (selection.registryDigest !== selected.registryDigest
    || selected.workflowDraftSchemaVersion !== 'workflow-draft.template-v1'
    || selected.workflowPayloadSchemaVersion !== 'workflow-version.template-v1'
    || selected.compilerVersion !== 'geneway-workflow-compiler/0.2.0') {
    throw new GenewayError('NOT_OPEN', 'Workflow selection is not an approved live template', 422);
  }
  const payload = templateWorkflowVersionPayloadSchema.parse({
    schemaVersion: 'workflow-version.template-v1', templateSchemaVersion: 'workflow-template-version/1',
    compilerVersion: 'geneway-workflow-compiler/0.2.0', canonicalizationVersion: 'RFC8785/JCS-1',
    featureSet: 'fixed-template-v1', templateId: selected.templateId, registryDigest: selected.registryDigest,
    capabilityVersionId: selected.capabilityVersionId, harnessVersionId: selected.harnessVersionId,
    nodes: selected.nodes, edges: selected.edges, permissionCeiling: selected.permissionCeiling,
  });
  const canonicalJson = canonicalize(payload);
  const hash = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return Object.freeze({ id: 'workflow_' + hash.slice(0, 24), hash,
    canonicalizationVersion: 'RFC8785/JCS-1', canonicalJson, payload: Object.freeze(payload) });
}
export function readStoredTemplateWorkflowVersion(input: Readonly<{
  id: string; hash: string; canonicalizationVersion: string; canonicalPayload: unknown;
}>): CompiledTemplateWorkflowVersion {
  const payload = templateWorkflowVersionPayloadSchema.parse(input.canonicalPayload);
  const expected = compileTemplateWorkflow({
    schemaVersion: 'workflow-draft.template-v1', templateId: payload.templateId, registryDigest: payload.registryDigest,
  });
  if (input.id !== expected.id || input.hash !== expected.hash
    || input.canonicalizationVersion !== expected.canonicalizationVersion
    || canonicalize(payload) !== expected.canonicalJson) {
    throw new GenewayError('WORKFLOW_HASH_MISMATCH', 'Stored workflow does not match immutable registry/hash', 409);
  }
  return expected;
}
export const workflowTemplateVersionJsonSchema = z.toJSONSchema(workflowTemplateVersionSchema);
export const workflowTemplateSelectionJsonSchema = z.toJSONSchema(workflowTemplateSelectionSchema);
export const templateWorkflowVersionPayloadJsonSchema = z.toJSONSchema(templateWorkflowVersionPayloadSchema);
