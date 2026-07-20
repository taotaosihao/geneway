import { defineConfig, devices } from '@playwright/test';

const runId = process.env.GENEWAY_RUN_ID ?? 'gate-0.1-local';
if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error('GENEWAY_RUN_ID contains unsafe path characters');
const webPort = Number(process.env.GENEWAY_WEB_PORT ?? 3200);
const controlPlanePort = Number(process.env.GENEWAY_CONTROL_PLANE_PORT ?? 3100);
if (!Number.isInteger(webPort) || !Number.isInteger(controlPlanePort)) throw new Error('GENEWAY ports must be integers');
const outputRoot = `/tmp/geneway-runs/${runId}`;

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
  },
  projects: [{ name: 'gate0.1', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: `cd .. && exec env PORT=${String(controlPlanePort)} GENEWAY_WEB_PORT=${String(webPort)} bash scripts/with-postgres.sh ./node_modules/.bin/tsx apps/control-plane/src/main.ts`,
      url: `http://127.0.0.1:${String(controlPlanePort)}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `cd ../apps/web && exec env GENEWAY_WEB_PORT=${String(webPort)} GENEWAY_CONTROL_PLANE_PORT=${String(controlPlanePort)} ./node_modules/.bin/vite --host 127.0.0.1 --port ${String(webPort)} --strictPort`,
      url: `http://127.0.0.1:${String(webPort)}/conversations/new?capability=solution.analysis.v1`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
