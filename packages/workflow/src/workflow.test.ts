import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  compileWorkflow,
  createExceptionAssistDraft,
  createSolutionAnalysisDraft,
  hashCanonical,
  GATE_0_2B_WORKFLOW_REGISTRY,
  readStoredWorkflowVersion,
  workflowDraftSchema,
} from './index.js';

describe('workflow compiler', () => {
  it('compiles the fixed template deterministically', () => {
    const first = compileWorkflow(createSolutionAnalysisDraft());
    const second = compileWorkflow(structuredClone(createSolutionAnalysisDraft()));
    expect(second).toEqual(first);
    expect(first.payload.nodes.map((node) => node.id)).toEqual([
      'document_ingest', 'requirement_extract', 'contradiction_check', 'solution_design',
      'evidence_verify', 'result_quality_check', 'report_publish',
    ]);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hash).toBe('be038895345cb58a8f6080bb023b076613379403881eac6ea0f1763e8bd0eca4');
    const childHash = execFileSync(process.execPath, ['--import', 'tsx', 'packages/workflow/src/hash-probe.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(childHash).toBe(first.hash);
  });

  it('uses RFC 8785 key order and UTF-8 semantics', () => {
    expect(hashCanonical({ z: '中文', a: 1 })).toBe(hashCanonical({ a: 1, z: '中文' }));
    expect(hashCanonical([2, 1])).not.toBe(hashCanonical([1, 2]));
  });

  it('compiles and reads back the exact fixed exception-assist workflow', () => {
    const draft = createExceptionAssistDraft('factory-01/workshop-machining/line-02');
    const compiled = compileWorkflow(draft);
    expect(compiled.hash).toBe('e8332ef339d019051fea3f1d0d9148266628abfdb471f8c359c803ab451a1ba3');
    expect(compiled.payload.nodes.map((node) => node.id)).toEqual([
      'exception_snapshot_load', 'deterministic_baseline', 'expert_route_resolve', 'impact_analysis',
      'action_recommendation', 'evidence_quality_check', 'report_publish',
    ]);
    expect(compiled.payload.edges).toHaveLength(6);
    expect(compiled.payload.permissionCeiling).toEqual({
      actions: ['R0', 'R1', 'A1'],
      resourceScopes: ['factory-01/workshop-machining/line-02'],
      dataClasses: ['C1'],
    });
    expect(compiled.canonicalJson).not.toContain('expert-catalog.gate0.2b/1');
    expect(readStoredWorkflowVersion({
      id: compiled.id,
      hash: compiled.hash,
      canonicalizationVersion: compiled.canonicalizationVersion,
      canonicalPayload: JSON.parse(compiled.canonicalJson) as unknown,
    })).toEqual(compiled);
  });

  it('materializes an immutable version from stored canonical payload', () => {
    const compiled = compileWorkflow(createSolutionAnalysisDraft());
    const readback = readStoredWorkflowVersion({
      id: compiled.id,
      hash: compiled.hash,
      canonicalizationVersion: compiled.canonicalizationVersion,
      canonicalPayload: JSON.parse(compiled.canonicalJson) as unknown,
    });
    expect(readback).toEqual(compiled);
    expect(() => readStoredWorkflowVersion({
      id: compiled.id,
      hash: '0'.repeat(64),
      canonicalizationVersion: compiled.canonicalizationVersion,
      canonicalPayload: compiled.payload,
    })).toThrow(/immutable hash/);
  });

  it('fails closed for unknown kinds, refs and unsafe values', () => {
    const dynamic = { ...createSolutionAnalysisDraft(), nodes: [{ id: 'wait', kind: 'wait' }] };
    expect(() => compileWorkflow(dynamic)).toThrow();
    const unknown = createSolutionAnalysisDraft();
    unknown.harnessVersionId = 'harness_unknown';
    expect(() => compileWorkflow(unknown)).toThrow(/not registered/);
    const unsafe = createSolutionAnalysisDraft() as Record<string, unknown>;
    unsafe.bad = undefined;
    expect(() => compileWorkflow(unsafe)).toThrow(/unsafe value/);
    expect(workflowDraftSchema.safeParse({ ...createSolutionAnalysisDraft(), url: 'https://example.test' }).success).toBe(false);
    const badRef = createSolutionAnalysisDraft();
    const firstAgent = badRef.nodes[1];
    if (firstAgent !== undefined) firstAgent.inputRefs = ['step.report_publish.output'];
    expect(() => compileWorkflow(badRef)).toThrow(/unknown or forward/);
    const badEdges = createSolutionAnalysisDraft();
    badEdges.edges = badEdges.edges.slice().reverse();
    expect(() => compileWorkflow(badEdges)).toThrow(/exact fixed/);

    const mutatedException = createExceptionAssistDraft('factory-01/workshop-machining/line-02');
    const impact = mutatedException.nodes[3];
    if (impact !== undefined && impact.kind === 'agent') impact.outputSchemaId = 'free-form-output/1';
    expect(() => compileWorkflow(mutatedException)).toThrow(/exact registered fixed template/);
    expect(() => compileWorkflow(createExceptionAssistDraft('factory-01/workshop-machining/line-02'), {
      ...GATE_0_2B_WORKFLOW_REGISTRY,
      routingPolicyVersions: new Set(),
    })).toThrow(/routing policy/);
  });
});
