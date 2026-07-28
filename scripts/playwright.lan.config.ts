import { mkdirSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const runId = process.env.GENEWAY_RUN_ID;
const baseURL = process.env.GENEWAY_LAN_BASE_URL;
if (runId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
  throw new Error('Gate A0 LAN validation requires a safe GENEWAY_RUN_ID');
}
if (baseURL === undefined) throw new Error('Gate A0 LAN validation requires GENEWAY_LAN_BASE_URL');
const parsedBaseUrl = new URL(baseURL);
if (parsedBaseUrl.protocol !== 'http:'
  || (!/^192\.168\.\d{1,3}\.\d{1,3}$/u.test(parsedBaseUrl.hostname)
    && !/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(parsedBaseUrl.hostname))
  || parsedBaseUrl.pathname !== '/' || parsedBaseUrl.username !== '' || parsedBaseUrl.password !== '') {
  throw new Error('GENEWAY_LAN_BASE_URL must be an unauthenticated 192.168/16 or 10/8 HTTP origin');
}

const outputRoot = `/tmp/geneway-runs/${runId}`;
mkdirSync(outputRoot, { recursive: true });

export default defineConfig({
  testDir: './e2e',
  testMatch: /gate-a0-lan-regression\.spec\.ts/u,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: `${outputRoot}/playwright-lan-artifacts`,
  reporter: [['list'], ['json', { outputFile: `${outputRoot}/gate-a0-lan/playwright-report.json` }]],
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    trace: { mode: 'on', sources: false },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        LANG: process.env.LANG ?? 'C.UTF-8',
      },
    },
  },
  projects: [{ name: 'gate-a0-lan' }],
});
