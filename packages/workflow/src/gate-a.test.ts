import { describe, expect, it } from 'vitest';
import canonicalFixture from './fixtures/gate-a/canonical-fixture.json' with { type: 'json' };
import independentExpected from './fixtures/gate-a/independent-expected.json' with { type: 'json' };
import {
  compileTemplateWorkflow,
  GATE_A_WORKFLOW_TEMPLATE_REGISTRY,
  readStoredTemplateWorkflowVersion,
  SOLUTION_FIXTURE_TEMPLATE,
  SOLUTION_LIVE_TEMPLATE,
  WORK_ORDER_STATUS_TEMPLATE,
  workflowTemplateSelectionSchema,
  workflowTemplateVersionSchema,
} from './gate-a.js';
import { compileWorkflow, createSolutionAnalysisDraft } from './index.js';

describe('Gate A immutable workflow template authority', () => {
  it('matches checked-in independent registry digests and both live workflow hashes', () => {
    expect(SOLUTION_FIXTURE_TEMPLATE.registryDigest).toBe(independentExpected.legacy.registryDigest);
    expect(SOLUTION_LIVE_TEMPLATE.registryDigest).toBe(independentExpected.solutionLive.registryDigest);
    expect(WORK_ORDER_STATUS_TEMPLATE.registryDigest).toBe(independentExpected.workOrderStatus.registryDigest);

    const solution = compileTemplateWorkflow({
      schemaVersion: 'workflow-draft.template-v1',
      templateId: SOLUTION_LIVE_TEMPLATE.templateId,
      registryDigest: independentExpected.solutionLive.registryDigest,
    });
    const workOrder = compileTemplateWorkflow({
      schemaVersion: 'workflow-draft.template-v1',
      templateId: WORK_ORDER_STATUS_TEMPLATE.templateId,
      registryDigest: independentExpected.workOrderStatus.registryDigest,
    });
    expect({ id: solution.id, hash: solution.hash, canonicalJson: solution.canonicalJson }).toEqual({
      id: independentExpected.solutionLive.workflowId,
      hash: independentExpected.solutionLive.workflowHash,
      canonicalJson: canonicalFixture.compiled.solutionLive.canonicalJson,
    });
    expect({ id: workOrder.id, hash: workOrder.hash, canonicalJson: workOrder.canonicalJson }).toEqual({
      id: independentExpected.workOrderStatus.workflowId,
      hash: independentExpected.workOrderStatus.workflowHash,
      canonicalJson: canonicalFixture.compiled.workOrderStatus.canonicalJson,
    });
    expect(Object.values(GATE_A_WORKFLOW_TEMPLATE_REGISTRY)).toEqual(canonicalFixture.registry);
  });

    expect(Object.isFrozen(SOLUTION_LIVE_TEMPLATE)).toBe(true);
    expect(Object.isFrozen(SOLUTION_LIVE_TEMPLATE.nodes)).toBe(true);
    expect(Object.isFrozen(SOLUTION_LIVE_TEMPLATE.nodes[0]?.inputRefs)).toBe(true);
    expect(Object.isFrozen(SOLUTION_LIVE_TEMPLATE.permissionCeiling.actions)).toBe(true);
    const originalNodeId = SOLUTION_LIVE_TEMPLATE.nodes[0]?.id;
    expect(() => {
      (SOLUTION_LIVE_TEMPLATE.nodes as unknown as Array<unknown>).reverse();
    }).toThrow();
    expect(SOLUTION_LIVE_TEMPLATE.nodes[0]?.id).toBe(originalNodeId);

  it('preserves exact legacy workflow payload/hash outside the registry wrapper', () => {
    const legacy = compileWorkflow(createSolutionAnalysisDraft());
    expect(legacy.hash).toBe(independentExpected.legacy.existingWorkflowHash);
    expect(legacy.canonicalJson).not.toContain('templateId');
    expect(legacy.canonicalJson).not.toContain('registryDigest');
    expect(SOLUTION_FIXTURE_TEMPLATE.templateId).toBe(independentExpected.legacy.templateId);
  });

  it('reads back immutable template workflow bytes and rejects drift', () => {
    const compiled = compileTemplateWorkflow({
      schemaVersion: 'workflow-draft.template-v1',
      templateId: SOLUTION_LIVE_TEMPLATE.templateId,
      registryDigest: SOLUTION_LIVE_TEMPLATE.registryDigest,
    });
    expect(readStoredTemplateWorkflowVersion({
      id: compiled.id,
      hash: compiled.hash,
      canonicalizationVersion: compiled.canonicalizationVersion,
      canonicalPayload: JSON.parse(compiled.canonicalJson) as unknown,
    })).toEqual(compiled);
    expect(() => readStoredTemplateWorkflowVersion({
      id: compiled.id,
      hash: '0'.repeat(64),
      canonicalizationVersion: compiled.canonicalizationVersion,
      canonicalPayload: compiled.payload,
    })).toThrow(/immutable registry\/hash/u);
  });

  it('rejects cross-template, topology and concrete-resource injection', () => {
    expect(() => compileTemplateWorkflow({
      schemaVersion: 'workflow-draft.template-v1',
      templateId: SOLUTION_LIVE_TEMPLATE.templateId,
      registryDigest: WORK_ORDER_STATUS_TEMPLATE.registryDigest,
    })).toThrow(/approved live template/u);
    for (const injected of [
      { nodes: SOLUTION_LIVE_TEMPLATE.nodes },
      { documentSnapshotId: 'snapshot-a' },
      { workOrderRef: 'WO-1' },
      { permissionCeiling: SOLUTION_LIVE_TEMPLATE.permissionCeiling },
      { url: 'https://example.invalid' },
    ]) {
      expect(workflowTemplateSelectionSchema.safeParse({
        schemaVersion: 'workflow-draft.template-v1',
        templateId: SOLUTION_LIVE_TEMPLATE.templateId,
        registryDigest: SOLUTION_LIVE_TEMPLATE.registryDigest,
        ...injected,
      }).success).toBe(false);
    const driftedPayload = structuredClone(canonicalFixture.compiled.solutionLive.payload);
    driftedPayload.nodes.reverse();
    expect(() => readStoredTemplateWorkflowVersion({
      id: independentExpected.solutionLive.workflowId,
      hash: independentExpected.solutionLive.workflowHash,
      canonicalizationVersion: 'RFC8785/JCS-1',
      canonicalPayload: driftedPayload,
    })).toThrow();

    }
    const mutated = structuredClone(SOLUTION_LIVE_TEMPLATE);
    mutated.nodes.reverse();
    expect(workflowTemplateVersionSchema.safeParse(mutated).success).toBe(true);
    expect(canonicalFixture.registry).not.toContainEqual(mutated);
  });

  it('keeps task-specific document ids outside the canonical workflow', () => {
    const compileForDocument = (documentSnapshotId: string) => {
      const compiled = compileTemplateWorkflow({
        schemaVersion: 'workflow-draft.template-v1',
        templateId: SOLUTION_LIVE_TEMPLATE.templateId,
        registryDigest: SOLUTION_LIVE_TEMPLATE.registryDigest,
      });
      expect(compiled.canonicalJson).not.toContain(documentSnapshotId);
      return compiled;
    };
    const first = compileForDocument('document-a');
    const second = compileForDocument('document-b');
    expect(first.hash).toBe(second.hash);
    expect(first.canonicalJson).not.toContain('document-a');
    expect(second.canonicalJson).not.toContain('document-b');
  });
});
