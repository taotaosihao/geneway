import { describe, expect, it } from 'vitest';
import { GenewayError } from '@geneway/contracts';
import { FakeRuntime } from './index.js';

describe('server fake runtime', () => {
  it('produces the fixed candidates without a provider route', () => {
    const result = new FakeRuntime().executeStep('evidence_verify', {
      inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1', fixtureVersion: 1 },
    });
    expect(result.claims).toHaveLength(2);
    expect(result.evidence).toMatchObject({ kind: 'legacy_fixture', sourceId: 'fixture:solution-analysis:v1#requirements' });
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
