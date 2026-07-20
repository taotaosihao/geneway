import { describe, expect, it } from 'vitest';
import { GenewayError } from '@geneway/contracts';
import { FakeRuntime } from './index.js';

describe('server fake runtime', () => {
  it('produces the fixed candidates without a provider route', () => {
    const result = new FakeRuntime().executeStep('evidence_verify', { tenantId: 'tenant_local', businessTaskId: 'task_1', fixtureRef: 'fixture:solution-analysis:v1' });
    expect(result.claims).toHaveLength(2);
    expect(result.evidence?.runtimeMode).toBe('fake');
  });
  it('fails closed for unopened runtime kinds', () => {
    try {
      new FakeRuntime().executeExternal('openai');
      throw new Error('expected runtime to fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(GenewayError);
      expect((error as GenewayError).code).toBe('NOT_OPEN');
    }
    expect(() => new FakeRuntime().executeStep('wait', { tenantId: 'tenant_local', businessTaskId: 'task_1', fixtureRef: 'fixture:solution-analysis:v1' })).toThrow(/not open/);
  });
});
