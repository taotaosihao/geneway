import { describe, expect, it } from 'vitest';
import { GenewayError } from '@geneway/contracts';
import { FakeRuntime } from './index.js';

const capacityBytes = '{"dataClass":"C1","detectedAt":"2026-07-21T08:30:00.000Z","detectionWindow":"2026-07-21T08:00:00.000Z/2026-07-21T09:00:00.000Z","exceptionType":"capacity_progress_lag","fixtureVersion":"gate0.2b-capacity-lag/1","resourceScope":"factory-01/workshop-machining/line-02","severity":"high","sourceObjectRef":"work-order:WO-GATE02B-001","sourceSystem":"fixture-manufacturing","summary":"二号机加工线工单进度落后","values":{"completedQty":48,"elapsedPct":75,"planQty":100,"progressPct":48,"thresholdPct":60}}';

const exceptionInputRef = {
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
} as const;

describe('server fake runtime', () => {
  it('produces the fixed candidates without a provider route', () => {
    const result = new FakeRuntime().executeStep('evidence_verify', {
      inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1', fixtureVersion: 1 },
    });
    expect(result.claims).toHaveLength(2);
    expect(result.evidence).toMatchObject({ kind: 'legacy_fixture', sourceId: 'fixture:solution-analysis:v1#requirements' });
  });
  it('produces only source-bound exception Evidence and simulated A1 summaries', () => {
    const runtime = new FakeRuntime();
    const context = { inputRef: exceptionInputRef, inputBytes: Buffer.from(capacityBytes, 'utf8') };
    expect(runtime.executeStep('action_recommendation', context).summary).toContain('A1 模拟建议');
    const result = runtime.executeStep('evidence_quality_check', context);
    expect(result.evidence).toEqual({
      kind: 'business_exception_snapshot',
      candidateKey: 'capacity-progress-fact',
      businessExceptionId: 'exception_capacity',
      sourceVersionId: 'source_capacity_v1',
      sourceSha256: exceptionInputRef.sourceSha256,
      canonicalizationVersion: 'rfc8785-jcs/1',
      jsonPointer: '/values/progressPct',
      valueSha256: '98010bd9270f9b100b6214a21754fd33bdc8d41b2bc9f9dd16ff54d3c34ffd71',
    });
    expect(result.claims).toEqual([
      {
        candidateKey: 'capacity-progress-observation',
        text: '固定模拟来源记录的工单进度为 48%。',
        evidenceCandidateKey: 'capacity-progress-fact',
      },
      {
        candidateKey: 'exception-cause-unknown',
        text: '当前固定来源不足以判断异常根因或实际处置结果。',
        evidenceCandidateKey: null,
      },
    ]);
  });
  it('does not create exception Evidence without authorized canonical bytes', () => {
    expect(() => new FakeRuntime().executeStep('evidence_quality_check', { inputRef: exceptionInputRef })).toThrow(/required/);
  });
  it('fails closed for unopened runtime kinds', () => {
    try {
      new FakeRuntime().executeExternal('openai');
      throw new Error('expected runtime to fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(GenewayError);
      expect((error as GenewayError).code).toBe('NOT_OPEN');
    }
    expect(() => new FakeRuntime().executeStep('wait', {
      inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1', fixtureVersion: 1 },
    })).toThrow(/not open/);
  });
});
