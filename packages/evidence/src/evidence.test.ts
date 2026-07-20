import { describe, expect, it } from 'vitest';
import { SIMULATION_ENVELOPE } from '@geneway/contracts';
import { assertPublishableClaim, FIXTURE_EXCERPT, sha256Text, verifyEvidence, type EvidenceCandidate } from './index.js';

const evidence: EvidenceCandidate = {
  id: 'ev_1', tenantId: 'tenant_local', businessTaskId: 'task_1', sourceId: 'fixture:v1#requirements',
  sourceExcerpt: FIXTURE_EXCERPT, sourceHash: sha256Text(FIXTURE_EXCERPT), resourceScope: 'fixture:solution-analysis:v1', dataClass: 'C1', accessible: true,
  ...SIMULATION_ENVELOPE,
};

describe('evidence guard', () => {
  it('accepts a valid accessible hash', () => {
    expect(() => verifyEvidence(evidence, 'tenant_local', 'task_1', new Set(['fixture:solution-analysis:v1']))).not.toThrow();
  });
  it('rejects hash mismatch and unsupported claims', () => {
    expect(() => verifyEvidence({ ...evidence, sourceHash: '0'.repeat(64) }, 'tenant_local', 'task_1', new Set(['fixture:solution-analysis:v1']))).toThrow(/hash/);
    expect(() => assertPublishableClaim({ id: 'cl_1', tenantId: 'tenant_local', businessTaskId: 'task_1', text: 'unsupported', evidenceRefId: null, ...SIMULATION_ENVELOPE }, undefined)).toThrow(/without valid evidence/);
  });
});
