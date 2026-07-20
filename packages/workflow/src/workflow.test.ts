import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  compileWorkflow,
  createSolutionAnalysisDraft,
  hashCanonical,
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
  });
});
