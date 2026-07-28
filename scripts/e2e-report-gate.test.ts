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
    expect(validateE2eReport(reportFor('gate0.2b-success'), ['--project=gate0.2b-success']).expectedCount).toBe(2);
    expect(validateE2eReport(reportFor('gate0.2b-negative'), ['--project=gate0.2b-negative']).expectedCount).toBe(5);
    expect(validateE2eReport(reportFor('gate0.2b-recovery'), ['--project=gate0.2b-recovery']).expectedCount).toBe(3);
    expect(validateE2eReport(reportFor('gate0.2b-visual-desktop'), ['--project=gate0.2b-visual-desktop']).expectedCount).toBe(1);
    expect(validateE2eReport(reportFor('gate0.2b-visual-narrow'), ['--project=gate0.2b-visual-narrow']).expectedCount).toBe(1);
    expect(validateE2eReport(reportFor('gate0.2b-fast-chat-local'), ['--project=gate0.2b-fast-chat-local']).expectedCount).toBe(1);
    expect(validateE2eReport(reportFor('gate-a0-live'), ['--project=gate-a0-live']).expectedCount).toBe(2);
    expect(validateE2eReport(reportFor('gate-a0-lan'), ['--project=gate-a0-lan']).expectedCount).toBe(1);
    expect(validateE2eReport(reportFor('gate-a-not-open'), ['--project=gate-a-not-open']).expectedCount).toBe(1);
    const gateANotOpenSuite = (reportFor('gate-a-not-open').suites as Array<{ specs: unknown[] }>)[0];
    if (gateANotOpenSuite === undefined) throw new Error('Expected a Gate A not-open test suite');

    const gateABrowserReport = reportFor('gate-a-browser-egress');
    const gateABrowserReportSuite = (gateABrowserReport.suites as Array<{ specs: unknown[] }>)[0];
    if (gateABrowserReportSuite === undefined) throw new Error('Expected a Gate A browser egress report suite');
    gateABrowserReportSuite.specs.push(...gateANotOpenSuite.specs);
    (gateABrowserReport.stats as { expected: number }).expected += gateANotOpenSuite.specs.length;
    expect(validateE2eReport(gateABrowserReport, ['--project=gate-a-browser-egress']).expectedCount).toBe(2);

    const gateALiveReport = reportFor('gate-a-live');
    const gateALiveSuite = (gateALiveReport.suites as Array<{ specs: unknown[] }>)[0];
    if (gateALiveSuite === undefined) throw new Error('Expected a Gate A live test suite');
    const gateABrowserSuite = (reportFor('gate-a-browser-egress').suites as Array<{ specs: unknown[] }>)[0];
    if (gateABrowserSuite === undefined) throw new Error('Expected a Gate A browser egress test suite');
    gateALiveSuite.specs.push(...gateANotOpenSuite.specs, ...gateABrowserSuite.specs);
    (gateALiveReport.stats as { expected: number }).expected += gateANotOpenSuite.specs.length + gateABrowserSuite.specs.length;
    expect(validateE2eReport(gateALiveReport, ['--project=gate-a-live']).expectedCount).toBe(14);

    const gateARecoveryReport = reportFor('gate-a-recovery');
    const gateARecoverySuite = (gateARecoveryReport.suites as Array<{ specs: unknown[] }>)[0];
    if (gateARecoverySuite === undefined) throw new Error('Expected a Gate A recovery test suite');
    gateARecoverySuite.specs.push(...gateANotOpenSuite.specs, ...gateABrowserSuite.specs);
    (gateARecoveryReport.stats as { expected: number }).expected += gateANotOpenSuite.specs.length + gateABrowserSuite.specs.length;
    expect(validateE2eReport(gateARecoveryReport, ['--project=gate-a-recovery']).expectedCount).toBe(3);
  });

  it('keeps dependency inventory outside a top-level Gate A file filter', () => {
    const gateALiveReport = reportFor('gate-a-live');
    const gateALiveSuite = (gateALiveReport.suites as Array<{ specs: Array<Readonly<{ file: string }>> }>)[0];
    if (gateALiveSuite === undefined) throw new Error('Expected a Gate A live test suite');
    gateALiveSuite.specs = gateALiveSuite.specs.filter((spec) => spec.file === 'gate-a-solution-analysis.spec.ts');
    const gateANotOpenSuite = (reportFor('gate-a-not-open').suites as Array<{ specs: unknown[] }>)[0];
    if (gateANotOpenSuite === undefined) throw new Error('Expected a Gate A not-open test suite');
    const gateABrowserSuite = (reportFor('gate-a-browser-egress').suites as Array<{ specs: unknown[] }>)[0];
    if (gateABrowserSuite === undefined) throw new Error('Expected a Gate A browser egress test suite');
    gateALiveSuite.specs.push(...gateANotOpenSuite.specs as Array<Readonly<{ file: string }>>,
      ...gateABrowserSuite.specs as Array<Readonly<{ file: string }>>);
    (gateALiveReport.stats as { expected: number }).expected = gateALiveSuite.specs.length;
    expect(validateE2eReport(gateALiveReport, [
      '--project=gate-a-live',
      'gate-a-solution-analysis.spec.ts',
    ]).expectedCount).toBe(11);
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
