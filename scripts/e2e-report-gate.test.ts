import { describe, expect, it } from 'vitest';
import { expectedE2eTests, validateE2eReport } from './e2e-report-gate.js';

function reportFor(project: string): Record<string, unknown> {
  const selected = expectedE2eTests.filter((item) => item.project === project);
  return {
    errors: [],
    stats: { expected: selected.length, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [{ specs: selected.map((item) => ({
      file: item.file, title: item.title,
      tests: [{ projectName: item.project, status: 'expected', results: [{ status: 'passed' }] }],
    })), suites: [] }],
  };
}

describe('E2E report gate', () => {
  it('accepts only the exact clean project membership', () => {
    expect(validateE2eReport(reportFor('gate0.2a-success'), ['--project=gate0.2a-success']).expectedCount).toBe(4);
    expect(validateE2eReport(
      reportFor('gate0.2a-recovery-multiprocess'),
      ['--project=gate0.2a-recovery-multiprocess'],
    ).expectedCount).toBe(13);
    expect(validateE2eReport(reportFor('gate0.2b-success'), ['--project=gate0.2b-success']).expectedCount).toBe(1);
    expect(validateE2eReport(reportFor('gate-a0-live'), ['--project=gate-a0-live']).expectedCount).toBe(2);
    expect(validateE2eReport(reportFor('gate-a0-lan'), ['--project=gate-a0-lan']).expectedCount).toBe(1);
  });

  it('rejects a skipped test even when Playwright would exit zero', () => {
    const report = reportFor('gate0.2a-success');
    (report.stats as { skipped: number }).skipped = 1;
    expect(() => validateE2eReport(report, ['--project=gate0.2a-success'])).toThrow(/not clean/u);
  });

  it('rejects missing or cross-project test membership', () => {
    const report = reportFor('gate0.2a-success');
    const suite = (report.suites as Array<{ specs: unknown[] }>)[0];
    if (suite === undefined) throw new Error('Expected a test suite');
    suite.specs.pop();
    expect(() => validateE2eReport(report, ['--project=gate0.2a-success'])).toThrow(/membership drifted/u);
  });
});
