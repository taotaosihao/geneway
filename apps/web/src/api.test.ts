import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskEventProjectionSchema, type TaskEventProjection } from '@geneway/contracts';
import { ApiError, api, mergeTaskEventBatch } from './api.js';
import { routeStateForError } from './product-routes.js';

function event(cursor: number, id = `event_${String(cursor)}`): TaskEventProjection {
  return taskEventProjectionSchema.parse({
    cursor,
    id,
    businessTaskId: 'task_exception',
    sequence: cursor,
    aggregateVersion: cursor,
    occurredAt: '2026-07-23T08:00:00.000Z',
    simulation: true,
    runtimeMode: 'fake',
    businessDecisionAllowed: false,
    eventType: cursor === 4 ? 'workflow.run_reclaimed' : 'workflow.step_completed',
    payload: cursor === 4 ? {} : { stepId: `step_${String(cursor)}` },
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

function stubJson(value: unknown) {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubText(value: string): void {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(new Response(value, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }))));
}

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const shaC = 'c'.repeat(64);
const timestamp = '2026-07-23T08:00:00.000Z';
const liveBoundary = {
  simulation: false,
  runtimeMode: 'model_gateway',
  businessDecisionAllowed: false,
  internalAcceptance: true,
} as const;
const liveStepIds = [
  'document_ingest',
  'requirement_extract',
  'contradiction_check',
  'solution_design',
  'evidence_verify',
  'result_quality_check',
  'report_publish',
] as const;
const liveCanonicalSelectionProjection = {
  schemaVersion: 'canonical-selection-projection.gate-a/1',
  selectionPolicyVersion: 'canonical-complete-paragraph-concat/1',
  sourceExtractionVersion: 'canonical-text/plain-utf8/1',
  sourceCanonicalTextSha256: shaC,
  sourceCanonicalByteLength: 1,
  sourceCanonicalPageIndexSha256: null,
  selectedParagraphs: [{
    sourceParagraphIndex: 0,
    startByte: 0,
    endByteExclusive: 1,
    paragraphByteLength: 1,
    paragraphBytesSha256: shaA,
    pageSegments: [],
  }],
  selectedTotalBytes: 1,
  selectedModelInputSha256: shaC,
  truncated: false,
} as const;
const liveInputRef = {
  kind: 'live_document_snapshot',
  recordVariant: 'business-task-input.live-material/1',
  documentSnapshotId: 'snapshot_live_1',
  artifactId: 'artifact_source_1',
  artifactSha256: shaA,
  parserManifestId: 'parser_manifest_1',
  parserDigest: shaB,
  mediaType: 'text/plain',
  extractionVersion: 'canonical-text/plain-utf8/1',
  canonicalTextSha256: shaC,
  canonicalPageIndexSha256: null,
  canonicalSelectionProjection: liveCanonicalSelectionProjection,
  canonicalSelectionProjectionDigest: shaB,
  resourceScope: 'document-snapshot:approval-subject-bound',
  dataClass: 'C1',
  audience: 'conversation:conversation_live_1',
  trust: 'untrusted_text',
} as const;
const liveEvidence = {
  recordVariant: 'evidence.live/1',
  id: 'evidence_live_1',
  businessTaskId: 'task_live_1',
  statementId: 'statement_fact_1',
  source: {
    schemaVersion: 'evidence-locator.live/1',
    kind: 'canonical_text_span',
    sourceArtifactId: 'artifact_source_1',
    sourceArtifactSha256: shaA,
    documentSnapshotId: 'snapshot_live_1',
    canonicalTextSha256: shaC,
    parserManifestId: 'parser_manifest_1',
    parserDigest: shaB,
    extractionVersion: 'canonical-text/plain-utf8/1',
    excerptSha256: shaA,
    excerptByteLength: 1,
    startByte: 0,
    endByteExclusive: 1,
  },
  excerpt: 'A',
  resourceScope: 'document-snapshot:approval-subject-bound',
  dataClass: 'C1',
  audience: { kind: 'private-conversation', conversationId: 'conversation_live_1' },
  lineageRecordIds: ['lineage_live_1'],
  createdAt: timestamp,
} as const;
const liveArtifact = {
  recordVariant: 'artifact.analysis-report.live/1',
  id: 'artifact_report_1',
  manifestId: 'manifest_report_1',
  kind: 'analysis_report',
  displayName: 'analysis-report.md',
  mediaType: 'text/markdown',
  sizeBytes: 32,
  contentSha256: shaB,
  downloadUrl: '/api/artifacts/artifact_report_1',
  lineageRecordIds: ['lineage_live_1'],
  internalAcceptance: true,
} as const;
const liveWorkflow = {
  recordVariant: 'workflow-read-model.live/1',
  id: 'workflow_live_1',
  hash: shaA,
  schemaVersion: 'workflow-version.template-v1',
  templateSchemaVersion: 'workflow-template-version/1',
  compilerVersion: 'geneway-workflow-compiler/0.2.0',
  canonicalizationVersion: 'RFC8785/JCS-1',
  featureSet: 'fixed-template-v1',
  templateId: 'workflow-template.solution-live/1',
  registryDigest: shaB,
  capabilityVersionId: 'cap_solution_analysis_v1_live_1',
  harnessVersionId: 'harness_solution_analysis_v1_live_1',
  nodes: liveStepIds.map((id, index) => ({
    id,
    kind: index === 3 ? 'agent' : index === 4 || index === 5 ? 'verification' : 'deterministic',
    registryReference: 'registry.' + id,
    inputRefs: [],
    outputSchemaId: 'schema.' + id,
  })),
  edges: liveStepIds.slice(1).map((id, index) => ({ from: liveStepIds[index], to: id })),
  permissionCeiling: {
    actions: ['R0', 'R1', 'A1'],
    resourceScopes: ['document-snapshot:approval-subject-bound'],
    dataClasses: ['C0', 'C1'],
    connectors: [],
    modelTools: [],
  },
  createdAt: timestamp,
  ...liveBoundary,
} as const;
const liveTask = {
  recordVariant: 'business-task.live/1',
  id: 'task_live_1',
  capabilityId: 'solution.analysis.v1',
  capabilityVersionId: 'cap_solution_analysis_v1_live_1',
  title: '方案分析',
  conversationId: 'conversation_live_1',
  status: 'completed',
  createdAt: timestamp,
  updatedAt: timestamp,
  inputRef: liveInputRef,
  workflowVersion: {
    id: 'workflow_live_1',
    hash: shaA,
    templateId: 'workflow-template.solution-live/1',
    registryDigest: shaB,
  },
  approval: {
    id: 'approval_live_1',
    version: 1,
    status: 'approved',
    subjectDigest: shaC,
    expiresAt: '2026-07-23T09:00:00.000Z',
  },
  expertTarget: {
    requested: { mode: 'auto' },
    resolved: {
      mode: 'expert',
      resolution: 'automatic',
      expertId: 'expert.solution.architect.live/1',
      agentVersionId: 'agent.solution.architect.live/1',
      promptPolicyVersionId: 'xiaowei.solution-analysis.system/1',
    },
  },
  steps: liveStepIds.map((id) => ({ id, status: 'completed' })),
  modelInvocation: {
    id: 'model_invocation_live_1',
    status: 'completed',
    providerRevision: 'provider_revision_1',
    modelRevision: 'model_revision_1',
  },
  result: {
    recordVariant: 'business-task-result.live/1',
    schemaVersion: 'analysis-result/1',
    id: 'result_live_1',
    summary: '结构化分析完成',
    statements: [{
      id: 'statement_fact_1',
      kind: 'fact',
      text: '事实 A',
      confidence: 0.95,
      status: 'published',
      evidenceRefIds: ['evidence_live_1'],
      rejectionCode: null,
    }],
    outputPayloadDigest: shaC,
    createdAt: timestamp,
  },
  evidence: [liveEvidence],
  artifacts: [liveArtifact],
  lineage: [{
    id: 'lineage_live_1',
    fromKind: 'document_snapshot',
    fromId: 'snapshot_live_1',
    toKind: 'analysis_report',
    toId: 'artifact_report_1',
    relation: 'derived_from',
  }],
  errorClass: null,
  aggregateVersion: 5,
  eventWatermark: 7,
  ...liveBoundary,
} as const;
const liveCreateResponse = {
  recordVariant: 'business-task.live/1',
  executionRoute: 'live',
  taskId: 'task_live_1',
  approvalId: 'approval_live_1',
  approvalSubjectDigest: shaC,
  workflowVersion: {
    id: 'workflow_live_1',
    hash: shaA,
    templateId: 'workflow-template.solution-live/1',
    registryDigest: shaB,
  },
  ...liveBoundary,
} as const;
const liveEvent = {
  recordVariant: 'business-task-event.live/1',
  schemaVersion: 2,
  cursor: 1,
  id: 'event_live_1',
  businessTaskId: 'task_live_1',
  sequence: 1,
  aggregateVersion: 1,
  occurredAt: timestamp,
  eventType: 'business_task.live.created',
  payload: {
    approvalId: 'approval_live_1',
    approvalSubjectDigest: shaC,
    workflowVersionId: 'workflow_live_1',
    workflowHash: shaA,
  },
  ...liveBoundary,
} as const;
const liveDocumentList = {
  documentSnapshots: [{
    status: 'available',
    documentSnapshot: {
      id: 'snapshot_live_1',
      artifactId: 'artifact_source_1',
      manifestId: 'manifest_source_1',
      conversationId: 'conversation_live_1',
      displayName: 'input.txt',
      mediaType: 'text/plain',
      sizeBytes: 1,
      contentSha256: shaA,
      dataClass: 'C1',
      audience: { kind: 'private-conversation', conversationId: 'conversation_live_1' },
      resourceScope: 'document-snapshot:approval-subject-bound',
      trust: 'untrusted_text',
      simulationProfile: null,
      profileRegistryVersion: 'gate0.2a-profile-registry/1',
      createdAt: timestamp,
    },
    artifactState: {
      availability: 'active',
      integrity: 'verified',
      retentionStatus: 'active',
      reconcileStatus: 'in_sync',
      stateVersion: 1,
      downloadAllowed: true,
    },
    downloadUrl: '/api/artifacts/artifact_source_1',
    executionEligibility: {
      route: 'live',
      eligible: true,
      capabilityVersionId: 'cap_solution_analysis_v1_live_1',
      parserManifestId: 'parser_manifest_1',
      parserDigest: shaB,
      extractionVersion: 'canonical-text/plain-utf8/1',
      canonicalTextSha256: shaC,
      ...liveBoundary,
    },
  }],
} as const;

describe('Gate A live public API parsing', () => {
  it('accepts live eligibility and rejects credential-bearing eligibility projections', async () => {
    stubJson(liveDocumentList);
    await expect(api.getDocumentSnapshots('conversation_live_1')).resolves.toMatchObject({
      documentSnapshots: [{ executionEligibility: { route: 'live', eligible: true } }],
    });

    stubJson({
      documentSnapshots: [{
        ...liveDocumentList.documentSnapshots[0],
        executionEligibility: {
          ...liveDocumentList.documentSnapshots[0].executionEligibility,
          providerApiKey: 'must-not-cross-public-boundary',
        },
      }],
    });
    await expect(api.getDocumentSnapshots('conversation_live_1')).rejects.toThrow();
  });

  it('parses live create and keeps the request limited to the legacy four-field command', async () => {
    const fetchMock = stubJson(liveCreateResponse);
    await expect(api.createTask('conversation_live_1', 'snapshot_live_1', { mode: 'auto' })).resolves.toMatchObject({
      recordVariant: 'business-task.live/1',
      taskId: 'task_live_1',
    });
    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('create task request body was not serialized JSON');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toEqual({
      conversationId: 'conversation_live_1',
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'document_snapshot', documentSnapshotId: 'snapshot_live_1' },
      expertTarget: { mode: 'auto' },
    });
    expect(body).not.toHaveProperty('live');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('model');
  });

  it.each([
    [{ mode: 'expert', expertId: 'expert.solution.architect' } as const],
    [{ mode: 'team', teamId: 'team.solution.core' } as const],
  ])('sends a frozen A.2 expert selector without internal authority fields', async (expertTarget) => {
    const fetchMock = stubJson(liveCreateResponse);
    await api.createTask('conversation_live_1', 'snapshot_live_1', expertTarget);
    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('create task request body was not serialized JSON');
    expect(JSON.parse(init.body)).toEqual({
      conversationId: 'conversation_live_1',
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'document_snapshot', documentSnapshotId: 'snapshot_live_1' },
      expertTarget,
    });
  });

  it('strictly parses live task, nested Evidence and analysis_report while rejecting mixed or secret-bearing records', async () => {
    stubJson(liveTask);
    const parsed = await api.getTask('task_live_1');
    expect('recordVariant' in parsed ? parsed.recordVariant : undefined).toBe('business-task.live/1');
    expect(parsed.evidence[0]).toMatchObject({ recordVariant: 'evidence.live/1', id: 'evidence_live_1' });
    expect(parsed.artifacts[0]).toMatchObject({ recordVariant: 'artifact.analysis-report.live/1', kind: 'analysis_report' });

    stubJson({ ...liveTask, providerApiKey: 'must-not-cross-public-boundary' });
    await expect(api.getTask('task_live_1')).rejects.toThrow();

    stubJson({ ...liveTask, recordVariant: 'business-task-event.live/1' });
    await expect(api.getTask('task_live_1')).rejects.toThrow();
  });

  it('strictly parses live event, workflow and Evidence projections', async () => {
    stubText('data: ' + JSON.stringify(liveEvent) + '\n\n');
    await expect(api.events('task_live_1', 0)).resolves.toMatchObject([
      { recordVariant: 'business-task-event.live/1', eventType: 'business_task.live.created' },
    ]);

    stubJson(liveWorkflow);
    await expect(api.getWorkflow('workflow_live_1')).resolves.toMatchObject({
      recordVariant: 'workflow-read-model.live/1',
      id: 'workflow_live_1',
    });

    stubJson(liveEvidence);
    await expect(api.getEvidence('evidence_live_1')).resolves.toMatchObject({
      recordVariant: 'evidence.live/1',
      source: { kind: 'canonical_text_span', startByte: 0, endByteExclusive: 1 },
    });

    stubText('data: ' + JSON.stringify({ ...liveEvent, recordVariant: 'business-task-event.unknown/1' }) + '\n\n');
    await expect(api.events('task_live_1', 0)).rejects.toThrow();
  });

  it('accepts mixed live/legacy task-list items and rejects unknown selectors or secret extras', async () => {
    const legacyItem = {
      id: 'task_sim_1',
      capabilityId: 'solution.analysis.v1',
      status: 'completed',
      title: '方案分析',
      conversationId: 'conversation_sim_1',
      workflowVersion: { id: 'workflow_sim_1', hash: shaB },
      approvalStatus: 'approved',
      createdAt: timestamp,
      updatedAt: timestamp,
      aggregateVersion: 1,
      simulation: true,
    };
    const liveItem = {
      recordVariant: 'business-task.live/1',
      id: liveTask.id,
      capabilityId: liveTask.capabilityId,
      status: liveTask.status,
      title: liveTask.title,
      conversationId: liveTask.conversationId,
      workflowVersion: { id: liveTask.workflowVersion.id, hash: liveTask.workflowVersion.hash },
      approvalStatus: liveTask.approval.status,
      createdAt: liveTask.createdAt,
      updatedAt: liveTask.updatedAt,
      aggregateVersion: liveTask.aggregateVersion,
      ...liveBoundary,
    };
    const envelope = { nextCursor: null, asOf: timestamp, queryVersion: 'business-tasks.list.v1' };

    stubJson({ tasks: [legacyItem, liveItem], ...envelope });
    await expect(api.listTasks()).resolves.toMatchObject({
      tasks: [{ simulation: true }, { recordVariant: 'business-task.live/1', internalAcceptance: true }],
    });

    stubJson({ tasks: [{ ...liveItem, recordVariant: 'business-task.unknown/1' }], ...envelope });
    await expect(api.listTasks()).rejects.toThrow();

    stubJson({ tasks: [{ ...liveItem, providerApiKey: 'must-not-cross-public-boundary' }], ...envelope });
    await expect(api.listTasks()).rejects.toThrow();
  });
});

describe('Gate A public Web route parsing', () => {
  it('accepts the frozen internal live capability route', async () => {
    stubJson({
      capabilityId: 'solution.analysis.v1',
      status: 'internal',
      executionRoute: 'live',
      capabilityVersionId: 'cap_solution_analysis_v1_live_1',
      availableExpertModes: ['auto'],
      simulation: false,
      runtimeMode: 'model_gateway',
      businessDecisionAllowed: false,
      internalAcceptance: true,
    });
    await expect(api.getAnalysisCapabilityRoute()).resolves.toMatchObject({
      status: 'internal', executionRoute: 'live', availableExpertModes: ['auto'],
    });
  });

  it('accepts the A.2 internal route only with all three frozen public modes', async () => {
    stubJson({
      capabilityId: 'solution.analysis.v1',
      status: 'internal',
      executionRoute: 'live',
      capabilityVersionId: 'cap_solution_analysis_v1_live_2',
      availableExpertModes: ['auto', 'expert', 'team'],
      simulation: false,
      runtimeMode: 'model_gateway',
      businessDecisionAllowed: false,
      internalAcceptance: true,
    });
    await expect(api.getAnalysisCapabilityRoute()).resolves.toMatchObject({
      status: 'internal', executionRoute: 'live', availableExpertModes: ['auto', 'expert', 'team'],
    });

    stubJson({
      capabilityId: 'solution.analysis.v1',
      status: 'internal',
      executionRoute: 'live',
      capabilityVersionId: 'cap_solution_analysis_v1_live_2',
      availableExpertModes: ['auto', 'team'],
      simulation: false,
      runtimeMode: 'model_gateway',
      businessDecisionAllowed: false,
      internalAcceptance: true,
    });
    await expect(api.getAnalysisCapabilityRoute()).rejects.toThrow('CAPABILITY_ROUTE_PROJECTION_INVALID');
  });

  it('preserves the existing legacy simulation route and fails closed on unknown shapes', async () => {
    stubJson({ id: 'solution.analysis.v1', simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false });
    await expect(api.getAnalysisCapabilityRoute()).resolves.toMatchObject({ status: 'legacy-simulation', executionRoute: 'simulation' });

    stubJson({ capabilityId: 'solution.analysis.v1', status: 'internal', executionRoute: 'live', availableExpertModes: ['auto'] });
    await expect(api.getAnalysisCapabilityRoute()).rejects.toThrow('CAPABILITY_ROUTE_PROJECTION_INVALID');
  });

  it('preserves structured Control Plane error details for approval recovery', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({
      error: {
        code: 'APPROVAL_REAUTH_REQUIRED',
        message: 'approval expired',
        details: { approvalId: 'approval_live_v2', version: 2 },
      },
    }), { status: 409, headers: { 'content-type': 'application/json' } }))));
    const error = await api.getAnalysisCapabilityRoute().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'APPROVAL_REAUTH_REQUIRED',
      status: 409,
      details: { approvalId: 'approval_live_v2', version: 2 },
    });
  });
});

describe('Gate 0.2B.3 public recovery helpers', () => {
  it('replays strictly after eventCursor and deduplicates an out-of-order batch', () => {
    const merged = mergeTaskEventBatch('task_exception', 2, [event(5), event(3), event(4), event(3)]);
    expect(merged.events.map((item) => item.cursor)).toEqual([3, 4, 5]);
    expect(merged.cursor).toBe(5);
    expect(() => mergeTaskEventBatch('task_exception', 2, [event(3), event(3, 'collision')]))
      .toThrow('TASK_EVENT_CURSOR_COLLISION');
    expect(() => mergeTaskEventBatch('other_task', 2, [event(3)]))
      .toThrow('TASK_EVENT_TASK_MISMATCH');
  });

  it('maps real HTTP and network failures to stable route states', () => {
    expect(routeStateForError(new ApiError('DENIED', 'denied', 403))).toBe('forbidden');
    expect(routeStateForError(new ApiError('MISSING', 'missing', 404))).toBe('not-found');
    expect(routeStateForError(new ApiError('BUSINESS_EXCEPTION_STALE', 'stale', 409))).toBe('stale');
    expect(routeStateForError(new ApiError('ANALYSIS_BINDING_CONFLICT', 'conflict', 409))).toBe('binding-conflict');
    expect(routeStateForError(new ApiError('APPROVAL_SUBJECT_CHANGED', 'stale approval', 409))).toBe('approval-stale');
    expect(routeStateForError(new ApiError('NETWORK_OFFLINE', 'offline', 0))).toBe('offline');
    expect(routeStateForError(new ApiError('INTERNAL', 'failed', 500))).toBe('server-error');
  });
});
