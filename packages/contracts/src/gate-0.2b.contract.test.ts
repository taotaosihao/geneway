import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';

type CorpusRow = Readonly<{
  schema: keyof typeof contracts.gate02bPublicWireJsonSchemas;
  accepted: boolean;
  value: unknown;
}>;

const schemaByName = {
  BusinessExceptionRef: contracts.businessExceptionRefSchema,
  BusinessExceptionSourceSnapshot: contracts.businessExceptionSourceSnapshotSchema,
  ExceptionAudience: contracts.exceptionAudienceSchema,
  BusinessExceptionListQuery: contracts.businessExceptionListQuerySchema,
  BusinessExceptionListResponse: contracts.businessExceptionListResponseSchema,
  BusinessExceptionDetail: contracts.businessExceptionDetailSchema,
  AcknowledgeBusinessExceptionInput: contracts.acknowledgeBusinessExceptionInputSchema,
  CreateExceptionAnalysisTaskInput: contracts.createExceptionAnalysisTaskInputSchema,
  CreateExceptionAnalysisTaskResponse: contracts.createExceptionAnalysisTaskResponseSchema,
  ConversationProjection: contracts.conversationProjectionSchema,
  TaskListQuery: contracts.taskListQuerySchema,
  TaskListResponse: contracts.taskListResponseSchema,
  TaskSnapshot: contracts.taskSnapshotSchema,
  TaskEventProjection: contracts.taskEventProjectionSchema,
  TaskEventListResponse: contracts.taskEventListResponseSchema,
  ApprovalProjection: contracts.approvalProjectionSchema,
  ExecuteTaskInput: contracts.executeTaskInputSchema,
  WorkflowListQuery: contracts.workflowListQuerySchema,
  WorkflowListResponse: contracts.workflowListResponseSchema,
  WorkflowDetailProjection: contracts.workflowDetailProjectionSchema,
  WorkerDelivery: contracts.workerDeliverySchema,
  WorkerInputContent: contracts.workerInputContentSchema,
  AttemptOutputCandidatePayload: contracts.attemptOutputCandidatePayloadSchema,
  EvidenceLocatorCandidate: contracts.evidenceLocatorCandidateSchema,
  EvidenceSource: contracts.evidenceSourceSchema,
} as const;

describe('Gate 0.2B public wire contracts', () => {
  it('keeps the frozen corpus aligned with Zod runtime acceptance', () => {
    const corpus = JSON.parse(readFileSync(new URL('./gate-0.2b.corpus.json', import.meta.url), 'utf8')) as CorpusRow[];
    const artifactNames = Object.keys(contracts.gate02bPublicWireJsonSchemas).sort();
    expect([...new Set(corpus.map((row) => row.schema))].sort()).toEqual(artifactNames);
    for (const schema of artifactNames as CorpusRow['schema'][]) {
      const rows = corpus.filter((row) => row.schema === schema);
      expect(rows.some((row) => row.accepted), `${schema} needs an accepted corpus case`).toBe(true);
      expect(rows.some((row) => !row.accepted), `${schema} needs a rejected corpus case`).toBe(true);
    }
    for (const row of corpus) {
      expect(schemaByName[row.schema].safeParse(row.value).success, row.schema).toBe(row.accepted);
    }
  });

  it('checks in the exact JSON Schema artifact generated from the authored Zod schemas', () => {
    const artifactText = readFileSync(new URL('../generated/gate-0.2b.schema.json', import.meta.url), 'utf8');
    const artifact = JSON.parse(artifactText) as unknown;
    expect(artifact).toEqual({
      schemaVersion: 'geneway-gate-0.2b-public-wire/1',
      schemas: contracts.gate02bPublicWireJsonSchemas,
    });
    expect(createHash('sha256').update(artifactText).digest('hex')).toBe('00ef79d42297f56ae58a98e1811e8f002efc7959ffb5e979de96cb4285d741f5');
  });

  it('keeps exception Worker input source-bound and rejects unregistered source kinds', () => {
    const input = {
      kind: 'business_exception_snapshot',
      inputRef: {
        kind: 'business_exception_snapshot',
        businessExceptionId: 'exception_capacity',
        sourceVersionId: 'source_capacity_v1',
        sourceSha256: '0aaf071f5cb062251011970b382e239d3ae5fdcdc4f977b96f325825723b2ed6',
        canonicalizationVersion: 'rfc8785-jcs/1',
        fixtureVersion: 'gate0.2b-capacity-lag/1',
        sourceSystem: 'fixture-manufacturing',
        sourceObjectRef: 'work-order:WO-GATE02B-001',
        detectionWindow: '2026-07-21T08:00:00.000Z/2026-07-21T09:00:00.000Z',
        resourceScope: 'factory-01/workshop-machining/line-02',
        dataClass: 'C1',
        sourceAudience: {
          kind: 'resource_exception',
          businessExceptionId: 'exception_capacity',
          resourceScope: 'factory-01/workshop-machining/line-02',
          dataClass: 'C1',
        },
        taskAudience: { kind: 'private_conversation', conversationId: 'conversation_capacity' },
      },
      canonicalBytes: '{"fixed":true}',
    } as const;
    expect(contracts.workerInputContentSchema.parse(input)).toEqual(input);
    expect(contracts.workerInputContentSchema.safeParse({ ...input, kind: 'unregistered_source' }).success).toBe(false);
    expect(contracts.workerInputContentSchema.safeParse({ ...input, rootArtifactId: 'artifact_not_allowed' }).success).toBe(false);
  });
});
