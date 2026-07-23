import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const runId = process.env.GENEWAY_RUN_ID ?? `gate-a0-deferred-${Date.now()}-${process.pid}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const controlPlane = readFileSync(new URL('../apps/control-plane/src/index.ts', import.meta.url), 'utf8');

const deferredScripts = Object.keys(manifest.scripts ?? {}).filter((name) => /gate0?\.2b\.[23]/iu.test(name));
const checks = {
  readmeKeepsDeferredGatesUnclosed: /0\.2B\.2[–-]0\.2B\.3[^\n]*(?:未完成|未关闭)[^\n]*(?:未开放|延期)/u.test(readme)
    || /0\.2B\.2[–-]0\.2B\.3[^\n]*(?:延期|未完成)[^\n]*(?:未关闭|未开放)/u.test(readme),
  noExecutableDeferredGateScripts: deferredScripts.length === 0,
  materialAnalysisRemainsFixtureSimulation: controlPlane.includes("id: 'solution.analysis.v1'")
    && controlPlane.includes('fixtureOnly: true')
    && controlPlane.includes('simulation: true, runtimeMode: \'fake\', businessDecisionAllowed: false'),
  noPaperclipRuntimeDependency: Object.keys({
    ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}), ...(manifest.optionalDependencies ?? {}),
  }).every((name) => !name.startsWith('@paperclipai/')),
};
if (Object.values(checks).some((passed) => !passed)) {
  throw new Error(`Gate A0 deferred/status scan failed: ${JSON.stringify({ checks, deferredScripts })}`);
}
const outputDirectory = `/tmp/geneway-runs/${runId}/gate-a0`;
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
writeFileSync(`${outputDirectory}/deferred-status-scan.json`, `${JSON.stringify({
  schemaVersion: 'geneway-gate-a0-deferred-status-scan/1',
  runId,
  status: 'passed',
  checks,
  deferredScripts,
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`geneway Gate A0 deferred/status scan passed: ${outputDirectory}/deferred-status-scan.json\n`);
