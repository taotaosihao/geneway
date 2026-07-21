import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { z } from 'zod';
import { GenewayError } from '@geneway/contracts';

const idSchema = z.string().regex(/^[a-z][a-z0-9_.:-]*$/);

const deterministicNodeSchema = z.object({
  id: idSchema,
  kind: z.literal('deterministic'),
  handlerVersion: z.string().min(1),
  inputRefs: z.array(z.string()).default([]),
  outputSchemaId: z.string().min(1),
}).strict();

const agentNodeSchema = z.object({
  id: idSchema,
  kind: z.literal('agent'),
  capabilityVersionId: z.string().min(1),
  harnessVersionId: z.string().min(1),
  inputRefs: z.array(z.string()).default([]),
  outputSchemaId: z.string().min(1),
}).strict();

const verificationNodeSchema = z.object({
  id: idSchema,
  kind: z.literal('verification'),
  policyVersion: z.string().min(1),
  inputRefs: z.array(z.string()).default([]),
  outputSchemaId: z.string().min(1),
}).strict();

export const workflowNodeSchema = z.discriminatedUnion('kind', [
  deterministicNodeSchema,
  agentNodeSchema,
  verificationNodeSchema,
]);

export const workflowDraftSchema = z.object({
  schemaVersion: z.literal('workflow-draft.fixed-v1'),
  capabilityVersionId: z.string().min(1),
  harnessVersionId: z.string().min(1),
  featureSet: z.literal('fixed-v1'),
  nodes: z.array(workflowNodeSchema).min(1),
  edges: z.array(z.object({ from: idSchema, to: idSchema }).strict()),
  permissionCeiling: z.object({
    actions: z.array(z.enum(['R0', 'R1', 'A1'])).min(1),
    resourceScopes: z.array(z.string().min(1)).min(1),
    dataClasses: z.array(z.enum(['C0', 'C1', 'C2'])).min(1),
  }).strict(),
}).strict();

export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowVersionPayloadSchema = z.object({
  schemaVersion: z.literal('workflow-version.fixed-v1'),
  compilerVersion: z.literal('geneway-workflow-compiler/0.1.0'),
  canonicalizationVersion: z.literal('RFC8785/JCS-1'),
  capabilityVersionId: z.string(),
  harnessVersionId: z.string(),
  featureSet: z.literal('fixed-v1'),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(z.object({ from: idSchema, to: idSchema }).strict()),
  permissionCeiling: workflowDraftSchema.shape.permissionCeiling,
}).strict();

export type WorkflowVersionPayload = z.infer<typeof workflowVersionPayloadSchema>;

export type CompiledWorkflowVersion = Readonly<{
  id: string;
  hash: string;
  canonicalizationVersion: 'RFC8785/JCS-1';
  canonicalJson: string;
  payload: Readonly<WorkflowVersionPayload>;
}>;

export type WorkflowRegistry = Readonly<{
  capabilityVersionIds: ReadonlySet<string>;
  harnessVersionIds: ReadonlySet<string>;
  deterministicHandlers: ReadonlySet<string>;
  verificationPolicies: ReadonlySet<string>;
}>;

const FIXED_NODE_IDS = [
  'document_ingest',
  'requirement_extract',
  'contradiction_check',
  'solution_design',
  'evidence_verify',
  'result_quality_check',
  'report_publish',
] as const;

export const SOLUTION_CAPABILITY_VERSION_ID = 'cap_solution_analysis_v1_1';
export const SOLUTION_HARNESS_VERSION_ID = 'harness_solution_analysis_v1_1';

export function createSolutionAnalysisDraft(): WorkflowDraft {
  return {
    schemaVersion: 'workflow-draft.fixed-v1',
    capabilityVersionId: SOLUTION_CAPABILITY_VERSION_ID,
    harnessVersionId: SOLUTION_HARNESS_VERSION_ID,
    featureSet: 'fixed-v1',
    nodes: [
      { id: 'document_ingest', kind: 'deterministic', handlerVersion: 'fixture-reader/1', inputRefs: ['workflow.input.fixtureRef'], outputSchemaId: 'document.snapshot/1' },
      { id: 'requirement_extract', kind: 'agent', capabilityVersionId: SOLUTION_CAPABILITY_VERSION_ID, harnessVersionId: SOLUTION_HARNESS_VERSION_ID, inputRefs: ['step.document_ingest.output'], outputSchemaId: 'requirement.candidates/1' },
      { id: 'contradiction_check', kind: 'agent', capabilityVersionId: SOLUTION_CAPABILITY_VERSION_ID, harnessVersionId: SOLUTION_HARNESS_VERSION_ID, inputRefs: ['step.requirement_extract.output'], outputSchemaId: 'contradiction.result/1' },
      { id: 'solution_design', kind: 'agent', capabilityVersionId: SOLUTION_CAPABILITY_VERSION_ID, harnessVersionId: SOLUTION_HARNESS_VERSION_ID, inputRefs: ['step.requirement_extract.output', 'step.contradiction_check.output'], outputSchemaId: 'solution.design/1' },
      { id: 'evidence_verify', kind: 'verification', policyVersion: 'claim-evidence-minimum/1', inputRefs: ['step.solution_design.output'], outputSchemaId: 'evidence.verdict/1' },
      { id: 'result_quality_check', kind: 'verification', policyVersion: 'simulation-quality/1', inputRefs: ['step.evidence_verify.output'], outputSchemaId: 'quality.verdict/1' },
      { id: 'report_publish', kind: 'deterministic', handlerVersion: 'simulation-publisher/1', inputRefs: ['step.result_quality_check.output'], outputSchemaId: 'report.projection/1' },
    ],
    edges: FIXED_NODE_IDS.slice(0, -1).map((from, index) => ({ from, to: FIXED_NODE_IDS[index + 1] as string })),
    permissionCeiling: {
      actions: ['R0', 'R1', 'A1'],
      resourceScopes: ['fixture:solution-analysis:v1'],
      dataClasses: ['C0', 'C1'],
    },
  };
}

export function createSolutionAnalysisDocumentDraft(resourceScope: string): WorkflowDraft {
  const draft = createSolutionAnalysisDraft();
  return workflowDraftSchema.parse({
    ...draft,
    nodes: draft.nodes.map((node) => node.id === 'document_ingest'
      ? {
          id: node.id,
          kind: 'deterministic',
          handlerVersion: 'document-snapshot-reader/1',
          inputRefs: ['workflow.input.documentSnapshotId'],
          outputSchemaId: node.outputSchemaId,
        }
      : node),
    permissionCeiling: { ...draft.permissionCeiling, resourceScopes: [resourceScope] },
  });
}

function assertJsonSafe(value: unknown, seen = new Set<object>(), path = '$'): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') {
    throw new GenewayError('WORKFLOW_UNSAFE_VALUE', `Workflow contains an unsafe value at ${path}`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new GenewayError('WORKFLOW_NON_FINITE_NUMBER', `Workflow contains a non-finite number at ${path}`);
  }
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) throw new GenewayError('WORKFLOW_CYCLE', `Workflow contains a cycle at ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, seen, `${path}[${index}]`));
  } else {
    Object.entries(value).forEach(([key, entry]) => assertJsonSafe(entry, seen, `${path}.${key}`));
  }
  seen.delete(value);
}

function assertGraph(draft: WorkflowDraft): void {
  const ids = new Set<string>();
  for (const node of draft.nodes) {
    if (ids.has(node.id)) throw new GenewayError('WORKFLOW_DUPLICATE_NODE', `Duplicate node: ${node.id}`);
    ids.add(node.id);
  }
  const outgoing = new Map<string, string[]>();
  const indegree = new Map([...ids].map((id) => [id, 0]));
  for (const edge of draft.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new GenewayError('WORKFLOW_UNKNOWN_EDGE', 'Edge references an unknown node');
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const roots = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  if (roots.length !== 1) throw new GenewayError('WORKFLOW_ROOT_COUNT', 'Workflow requires exactly one root');
  const queue = [...roots];
  const visited: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    visited.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) queue.push(next);
    }
  }
  if (visited.length !== ids.size) throw new GenewayError('WORKFLOW_NOT_DAG', 'Workflow must be an acyclic reachable graph');

  const actual = draft.nodes.map((node) => node.id);
  if (actual.length !== FIXED_NODE_IDS.length || actual.some((id, index) => id !== FIXED_NODE_IDS[index])) {
    throw new GenewayError('NOT_OPEN', 'Only the fixed solution.analysis.v1 workflow is open in Gate 0.1', 422);
  }
  const expectedEdges = FIXED_NODE_IDS.slice(0, -1).map((from, index) => `${from}->${FIXED_NODE_IDS[index + 1] as string}`);
  const actualEdges = draft.edges.map((edge) => `${edge.from}->${edge.to}`);
  if (actualEdges.length !== expectedEdges.length || actualEdges.some((edge, index) => edge !== expectedEdges[index])) {
    throw new GenewayError('NOT_OPEN', 'Gate 0.1 requires the exact fixed seven-step topology', 422);
  }

  const preceding = new Set<string>();
  for (const node of draft.nodes) {
    for (const ref of node.inputRefs) {
      if (ref === 'workflow.input.fixtureRef' || ref === 'workflow.input.documentSnapshotId') continue;
      const match = /^step\.([a-z][a-z0-9_]*)\.output$/.exec(ref);
      if (match === null || match[1] === undefined || !preceding.has(match[1])) {
        throw new GenewayError('WORKFLOW_UNKNOWN_INPUT_REF', `Node ${node.id} has an unknown or forward input reference: ${ref}`);
      }
    }
    preceding.add(node.id);
  }
}

function assertRegistry(draft: WorkflowDraft, registry: WorkflowRegistry): void {
  if (!registry.capabilityVersionIds.has(draft.capabilityVersionId)) throw new GenewayError('WORKFLOW_CAPABILITY_NOT_FOUND', 'Capability version is not registered');
  if (!registry.harnessVersionIds.has(draft.harnessVersionId)) throw new GenewayError('WORKFLOW_HARNESS_NOT_FOUND', 'Harness version is not registered');
  for (const node of draft.nodes) {
    if (node.kind === 'agent') {
      if (!registry.capabilityVersionIds.has(node.capabilityVersionId) || !registry.harnessVersionIds.has(node.harnessVersionId)) {
        throw new GenewayError('WORKFLOW_AGENT_REF_NOT_FOUND', `Agent node ${node.id} has an unknown immutable reference`);
      }
    } else if (node.kind === 'deterministic' && !registry.deterministicHandlers.has(node.handlerVersion)) {
      throw new GenewayError('WORKFLOW_HANDLER_NOT_FOUND', `Handler ${node.handlerVersion} is not registered`);
    } else if (node.kind === 'verification' && !registry.verificationPolicies.has(node.policyVersion)) {
      throw new GenewayError('WORKFLOW_POLICY_NOT_FOUND', `Policy ${node.policyVersion} is not registered`);
    }
  }
}

export const GATE_0_1_WORKFLOW_REGISTRY: WorkflowRegistry = Object.freeze({
  capabilityVersionIds: new Set([SOLUTION_CAPABILITY_VERSION_ID]),
  harnessVersionIds: new Set([SOLUTION_HARNESS_VERSION_ID]),
  deterministicHandlers: new Set(['fixture-reader/1', 'document-snapshot-reader/1', 'simulation-publisher/1']),
  verificationPolicies: new Set(['claim-evidence-minimum/1', 'simulation-quality/1']),
});

export function compileWorkflow(input: unknown, registry: WorkflowRegistry = GATE_0_1_WORKFLOW_REGISTRY): CompiledWorkflowVersion {
  assertJsonSafe(input);
  const draft = workflowDraftSchema.parse(input);
  assertGraph(draft);
  assertRegistry(draft, registry);
  const payload = workflowVersionPayloadSchema.parse({
    schemaVersion: 'workflow-version.fixed-v1',
    compilerVersion: 'geneway-workflow-compiler/0.1.0',
    canonicalizationVersion: 'RFC8785/JCS-1',
    capabilityVersionId: draft.capabilityVersionId,
    harnessVersionId: draft.harnessVersionId,
    featureSet: draft.featureSet,
    nodes: draft.nodes,
    edges: draft.edges,
    permissionCeiling: draft.permissionCeiling,
  });
  const canonicalJson = canonicalize(payload);
  const hash = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return Object.freeze({
    id: `workflow_${hash.slice(0, 24)}`,
    hash,
    canonicalizationVersion: 'RFC8785/JCS-1',
    canonicalJson,
    payload: Object.freeze(payload),
  });
}

export function hashCanonical(value: unknown): string {
  assertJsonSafe(value);
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

export function readStoredWorkflowVersion(input: Readonly<{
  id: string;
  hash: string;
  canonicalizationVersion: string;
  canonicalPayload: unknown;
}>): CompiledWorkflowVersion {
  assertJsonSafe(input.canonicalPayload);
  const payload = workflowVersionPayloadSchema.parse(input.canonicalPayload);
  if (input.canonicalizationVersion !== 'RFC8785/JCS-1' || payload.canonicalizationVersion !== input.canonicalizationVersion) {
    throw new GenewayError('WORKFLOW_CANONICALIZATION_VERSION_MISMATCH', 'Stored workflow canonicalization version is unsupported or inconsistent', 409);
  }
  const canonicalJson = canonicalize(payload);
  const hash = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  if (hash !== input.hash || input.id !== `workflow_${hash.slice(0, 24)}`) {
    throw new GenewayError('WORKFLOW_HASH_MISMATCH', 'Stored workflow does not match its immutable hash or id', 409);
  }
  return Object.freeze({
    id: input.id,
    hash,
    canonicalizationVersion: 'RFC8785/JCS-1',
    canonicalJson,
    payload: Object.freeze(payload),
  });
}
