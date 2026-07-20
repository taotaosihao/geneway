import { describe, expect, it } from 'vitest';
import { createTaskInputSchema, simulationEnvelopeSchema } from './index.js';

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
});
