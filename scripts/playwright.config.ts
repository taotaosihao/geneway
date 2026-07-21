import { mkdirSync, writeFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const runId = process.env.GENEWAY_RUN_ID ?? 'gate-0.1-local';
if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error('GENEWAY_RUN_ID contains unsafe path characters');
const webPort = Number(process.env.GENEWAY_WEB_PORT ?? 3200);
const controlPlanePort = Number(process.env.GENEWAY_CONTROL_PLANE_PORT ?? 3100);
if (!Number.isInteger(webPort) || !Number.isInteger(controlPlanePort)) throw new Error('GENEWAY ports must be integers');
const outputRoot = `/tmp/geneway-runs/${runId}`;
const browserEnvironment = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: process.env.LANG ?? 'C.UTF-8',
};
const browserEnvironmentNames = Object.keys(browserEnvironment);
if (browserEnvironmentNames.some((name) => name.startsWith('GENEWAY_S3_') || name.startsWith('GENEWAY_STORAGE_') || name.startsWith('AWS_'))) {
  throw new Error('Browser launch environment contains a forbidden storage credential source');
}
mkdirSync(`${outputRoot}/process-boundaries`, { recursive: true });
writeFileSync(`${outputRoot}/process-boundaries/browser.json`, `${JSON.stringify({ role: 'browser', checked: true, forbiddenNamesPresent: [] })}\n`, { mode: 0o600 });

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: `${outputRoot}/playwright-artifacts`,
  reporter: [['list'], ['json', { outputFile: `${outputRoot}/playwright-report.json` }]],
  use: {
    baseURL: `http://localhost:${String(webPort)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: { env: browserEnvironment },
  },
  projects: [
    { name: 'gate0.1', testMatch: /gate-0\.1\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'gate0.2a-storage-thin', testMatch: /gate-0\.2a-storage-thin\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    {
      command: `cd .. && exec env GENEWAY_STORAGE_TARGET_ROLE=control-plane PORT=${String(controlPlanePort)} GENEWAY_WEB_PORT=${String(webPort)} bash scripts/with-storage.sh ./node_modules/.bin/tsx apps/control-plane/src/main.ts`,
      url: `http://127.0.0.1:${String(controlPlanePort)}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `cd ../apps/web && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_RUN_ID=${runId} GENEWAY_WEB_PORT=${String(webPort)} GENEWAY_CONTROL_PLANE_PORT=${String(controlPlanePort)} sh -c 'node ../../scripts/assert-process-env.mjs vite && exec ./node_modules/.bin/vite --host 127.0.0.1 --port ${String(webPort)} --strictPort'`,
      url: `http://127.0.0.1:${String(webPort)}/conversations/new?capability=solution.analysis.v1`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
