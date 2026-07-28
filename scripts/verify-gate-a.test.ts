import { describe, expect, it } from 'vitest';
import { requiredGateASteps, validateGateAStepPlan } from './verify-gate-a.mjs';

describe('Gate A aggregate command authority', () => {
  it('pins V1 through V7 membership, order, profile, and independent child run IDs', () => {
    expect(validateGateAStepPlan(requiredGateASteps)).toBe(true);
    expect(requiredGateASteps.map(({ phase, name }) => `${phase}:${name}`)).toEqual([
      'V1:authority-contract',
      'V2:lint',
      'V2:typecheck',
      'V2:unit',
      'V2:contracts',
      'V2:build',
      'V3:integration',
      'V3:storage',
      'V3:security',
      'V4:model-gateway',
      'V4:gate-a-runtime',
      'V5:gearjob-preflight',
      'V5:connector-gateway',
      'V6:served-live-product',
      'V7:fault-restart-matrix',
      'V7:actual-lan',
      'V7:gate-a0-regression',
      'V7:gate0.2a-regression',
      'V7:gate0.2b-regression',
      'V7:secret-egress-zero-write-scan',
    ]);
    expect(requiredGateASteps.find(({ name }) => name === 'connector-gateway')?.command).toEqual([
      'pnpm', 'test:connector-gateway', '--', '--profile=gearjob-work-order-status',
    ]);
  });

  it('rejects omitted, reordered, recursive, or aliased plans', () => {
    expect(() => validateGateAStepPlan(requiredGateASteps.slice(1))).toThrow(/membership or order/u);
    expect(() => validateGateAStepPlan([...requiredGateASteps].reverse())).toThrow(/membership or order/u);
    const changed = requiredGateASteps.map((step) => ({ ...step, command: [...step.command] }));
    const lintStep = changed[1];
    if (lintStep === undefined) throw new Error('Gate A lint step is missing');
    changed[1] = { ...lintStep, command: ['pnpm', 'verify:gate-a'] };
    expect(() => validateGateAStepPlan(changed)).toThrow(/membership or order/u);
  });
});
