import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  businessExceptionListQuerySchema,
  businessExceptionRefSchema,
  businessExceptionSnapshotEvidenceSourceSchema,
  exceptionAudienceSchema,
  gate02bPublicWireJsonSchemas,
  workerInputContentSchema,
} from './index.js';

type CorpusRow = Readonly<{
  schema: 'businessExceptionRef' | 'exceptionAudience' | 'businessExceptionListQuery' | 'businessExceptionSnapshotEvidenceSource';
  accepted: boolean;
  value: unknown;
}>;

const schemaByName = {
  businessExceptionRef: businessExceptionRefSchema,
  exceptionAudience: exceptionAudienceSchema,
  businessExceptionListQuery: businessExceptionListQuerySchema,
  businessExceptionSnapshotEvidenceSource: businessExceptionSnapshotEvidenceSourceSchema,
} as const;

describe('Gate 0.2B public wire contracts', () => {
  it('keeps the frozen corpus aligned with Zod runtime acceptance', () => {
    const corpus = JSON.parse(readFileSync(new URL('./gate-0.2b.corpus.json', import.meta.url), 'utf8')) as CorpusRow[];
    expect(corpus.length).toBeGreaterThanOrEqual(9);
    for (const row of corpus) {
      expect(schemaByName[row.schema].safeParse(row.value).success, row.schema).toBe(row.accepted);
    }
  });

  it('checks in the exact JSON Schema artifact generated from the authored Zod schemas', () => {
    const artifactText = readFileSync(new URL('../generated/gate-0.2b.schema.json', import.meta.url), 'utf8');
    const artifact = JSON.parse(artifactText) as unknown;
    expect(artifact).toEqual({
      schemaVersion: 'geneway-gate-0.2b-public-wire/1',
      schemas: gate02bPublicWireJsonSchemas,
    });
    expect(createHash('sha256').update(artifactText).digest('hex')).toBe('10edaef6b001b210df3d2aa3543ce19d7c8734c178e4cb12cb9fc713b3a7d6b2');
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
    expect(workerInputContentSchema.parse(input)).toEqual(input);
    expect(workerInputContentSchema.safeParse({ ...input, kind: 'unregistered_source' }).success).toBe(false);
    expect(workerInputContentSchema.safeParse({ ...input, rootArtifactId: 'artifact_not_allowed' }).success).toBe(false);
  });
});
