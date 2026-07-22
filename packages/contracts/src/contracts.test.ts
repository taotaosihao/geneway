import { describe, expect, it } from 'vitest';
import {
  createTaskInputSchema,
  taskEventProjectionSchema,
  taskListQuerySchema,
  taskListResponseJsonSchema,
  taskListResponseSchema,
  taskSnapshotSchema,
  workflowDetailProjectionJsonSchema,
  workflowDetailProjectionSchema,
  workflowListQuerySchema,
  simulationEnvelopeSchema,
} from './index.js';

const hash = 'a'.repeat(64);

const taskListItem = {
  id: 'task_1',
  capabilityId: 'solution.analysis.v1',
  status: 'completed',
  title: '方案分析',
  conversationId: 'conversation_1',
  workflowVersion: { id: 'workflow_1', hash },
  approvalStatus: 'approved',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:01:00.000Z',
  aggregateVersion: 3,
  simulation: true,
} as const;

describe('wire contracts', () => {
  it('rejects client-owned identity and unknown fields', () => {
    expect(() => createTaskInputSchema.parse({
      conversationId: 'conv_1',
      capabilityId: 'solution.analysis.v1',
      fixtureRef: 'fixture:solution-analysis:v1',
      expertTarget: { mode: 'auto' },
      tenantId: 'forged',
    })).toThrow();
  });

  it('requires complete simulation semantics', () => {
    expect(simulationEnvelopeSchema.safeParse({ simulation: true, runtimeMode: 'fake' }).success).toBe(false);
    expect(simulationEnvelopeSchema.safeParse({
      simulation: true,
      runtimeMode: 'fake',
      businessDecisionAllowed: false,
    }).success).toBe(true);
  });

  it('keeps list queries strict and separates signed pagination cursors from event offsets', () => {
    expect(taskListQuerySchema.parse({})).toEqual({ sort: 'updatedAt', direction: 'desc', limit: 25 });
    expect(workflowListQuerySchema.parse({ limit: '1' })).toEqual({ limit: 1 });
    expect(taskListQuerySchema.safeParse({ ownerId: 'user_other' }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ direction: 'asc' }).success).toBe(false);
    expect(workflowListQuerySchema.safeParse({ cursor: '7' }).success).toBe(false);
  });

  it('rejects undeclared list and task-detail fields recursively', () => {
    const response = {
      tasks: [taskListItem],
      nextCursor: null,
      asOf: '2026-07-22T00:01:00.000Z',
      queryVersion: 'business-tasks.list.v1',
    };
    expect(taskListResponseSchema.parse(response)).toEqual(response);
    expect(taskListResponseSchema.safeParse({ ...response, totalCount: 1 }).success).toBe(false);
    expect(taskListResponseSchema.safeParse({
      ...response,
      tasks: [{ ...taskListItem, requesterId: 'user_other' }],
    }).success).toBe(false);
    expect(taskSnapshotSchema.safeParse({
      ...taskListItem,
      inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1', fixtureVersion: '1' },
      approval: { id: 'approval_1', version: 1, status: 'approved', subjectDigest: hash },
      expertTarget: { mode: 'auto' },
      steps: [{ id: 'document_ingest', status: 'completed', output: { private: true } }],
      claims: [], evidence: [], artifacts: [], lineage: [], result: null, eventWatermark: 1,
      runtimeMode: 'fake', businessDecisionAllowed: false,
    }).success).toBe(false);
  });

  it('keeps public task events strict and excludes Worker execution identity', () => {
    const event = {
      cursor: 2,
      id: 'event_2',
      businessTaskId: 'task_1',
      sequence: 2,
      aggregateVersion: 2,
      occurredAt: '2026-07-22T00:01:00.000Z',
      simulation: true,
      runtimeMode: 'fake',
      businessDecisionAllowed: false,
      eventType: 'workflow.run_started',
      payload: {},
    } as const;
    expect(taskEventProjectionSchema.parse(event)).toEqual(event);
    expect(taskEventProjectionSchema.safeParse({
      ...event,
      payload: { workerInstanceId: 'worker_private', attemptId: 'attempt_private', fencingToken: 7 },
    }).success).toBe(false);
    expect(taskEventProjectionSchema.safeParse({ ...event, tenantId: 'tenant_private' }).success).toBe(false);
  });

  it('keeps immutable workflow projection strict and JSON Schema in structural parity', () => {
    const workflow = {
      id: 'workflow_1', hash,
      capabilityVersionId: 'cap_solution_analysis_v1_1',
      harnessVersionId: 'harness_solution_analysis_v1_1',
      createdAt: '2026-07-22T00:00:00.000Z', simulation: true,
      compilerVersion: 'geneway-workflow-compiler/0.1.0',
      canonicalizationVersion: 'RFC8785/JCS-1', featureSet: 'fixed-v1',
      nodes: [{ id: 'document_ingest', kind: 'deterministic', handlerVersion: 'fixture-reader/1', inputRefs: [], outputSchemaId: 'document.snapshot/1' }],
      edges: [],
      permissionCeiling: { actions: ['R0'], resourceScopes: ['fixture:solution-analysis:v1'], dataClasses: ['C1'] },
    } as const;
    expect(workflowDetailProjectionSchema.parse(workflow)).toEqual(workflow);
    expect(workflowDetailProjectionSchema.safeParse({ ...workflow, approval: { status: 'approved' } }).success).toBe(false);
    expect(taskListResponseJsonSchema.additionalProperties).toBe(false);
    expect(taskListResponseJsonSchema.required).toEqual(expect.arrayContaining(['tasks', 'nextCursor', 'asOf', 'queryVersion']) as unknown);
    expect(workflowDetailProjectionJsonSchema.additionalProperties).toBe(false);
    expect(workflowDetailProjectionJsonSchema.required).toEqual(expect.arrayContaining(['nodes', 'edges', 'permissionCeiling']) as unknown);
  });
});
