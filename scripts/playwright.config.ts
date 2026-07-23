import { mkdirSync, writeFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const runId = process.env.GENEWAY_RUN_ID ?? 'gate-0.1-local';
if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error('GENEWAY_RUN_ID contains unsafe path characters');
const webPort = Number(process.env.GENEWAY_WEB_PORT ?? 3200);
const controlPlanePort = Number(process.env.GENEWAY_CONTROL_PLANE_PORT ?? 3100);
const controlPlaneSupervisorPort = Number(process.env.GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT ?? 3400);
const workerHealthPort = Number(process.env.GENEWAY_WORKER_HEALTH_PORT ?? 3300);
const workerSocketPath = process.env.GENEWAY_WORKER_SOCKET_PATH;
const workerTokenFile = process.env.GENEWAY_WORKER_TOKEN_FILE;
const workerInstanceId = process.env.GENEWAY_WORKER_INSTANCE_ID;
const gateA0Live = process.env.GENEWAY_GATE_A0_LIVE === '1';
const modelGatewayPort = Number(process.env.GENEWAY_MODEL_GATEWAY_PORT ?? 3150);
const modelGatewaySupervisorPort = Number(process.env.GENEWAY_MODEL_GATEWAY_SUPERVISOR_PORT ?? 3450);
const gateA0ReleasePort = Number(process.env.GENEWAY_GATE_A0_RELEASE_PORT ?? 3160);
const modelGatewayServiceTokenFile = process.env.GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE;
const modelGatewayInvocationSecretFile = process.env.GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE;
const codexSubscriptionAuthFile = process.env.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE;
const modelGatewayConformanceFile = process.env.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE;
const e2eSecretCanary = process.env.GENEWAY_E2E_SECRET_CANARY;
if (!Number.isInteger(webPort) || !Number.isInteger(controlPlanePort) || !Number.isInteger(controlPlaneSupervisorPort)
  || !Number.isInteger(workerHealthPort) || !Number.isInteger(modelGatewayPort)
  || !Number.isInteger(modelGatewaySupervisorPort)
  || !Number.isInteger(gateA0ReleasePort)) throw new Error('GENEWAY ports must be integers');
if (workerSocketPath === undefined || workerTokenFile === undefined || workerInstanceId === undefined) throw new Error('E2E Worker authority is required');
if (!/^\/tmp\/gw-uds-[a-zA-Z0-9]+\/worker\.sock$/u.test(workerSocketPath)
  || !/^\/tmp\/gw-uds-[a-zA-Z0-9]+\/token$/u.test(workerTokenFile)
  || !/^e2e-worker-[a-zA-Z0-9._-]+$/u.test(workerInstanceId)) {
  throw new Error('E2E Worker authority contains unsafe values');
}
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
if (gateA0Live && ([modelGatewayServiceTokenFile, modelGatewayInvocationSecretFile, codexSubscriptionAuthFile, modelGatewayConformanceFile]
  .some((value) => value === undefined || !value.startsWith('/')))) {
  throw new Error('gate-a0-live requires absolute Model Gateway authority, auth and conformance paths');
}
if (gateA0Live && (e2eSecretCanary === undefined || !/^geneway-secret-canary-[a-f0-9]{48}$/u.test(e2eSecretCanary))) {
  throw new Error('gate-a0-live requires a valid secret-isolation canary');
}
const modelGatewayUrl = `http://127.0.0.1:${String(modelGatewayPort)}`;
const controlPlaneGatewayEnvironment = gateA0Live
  ? ` GENEWAY_MODEL_GATEWAY_URL=${shellQuote(modelGatewayUrl)}`
    + ` GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(modelGatewayServiceTokenFile ?? '')}`
    + ` GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE=${shellQuote(modelGatewayInvocationSecretFile ?? '')}`
    + ` GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID=${shellQuote(runId)}`
  : '';
const workerGatewayEnvironment = gateA0Live
  ? ` GENEWAY_MODEL_GATEWAY_URL=${shellQuote(modelGatewayUrl)}`
    + ` GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(modelGatewayServiceTokenFile ?? '')}`
  : '';
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
    { name: 'gate0.2a-success', testMatch: /gate-0\.2a-(?:storage-thin|evidence|recovery)\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'gate0.2a-negative', testMatch: /gate-0\.2a-negative\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'gate0.2a-recovery-multiprocess', testMatch: /gate-0\.2a-recovery(?:-matrix)?\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'gate0.2b-success', testMatch: /gate-0\.2b-(?:task-workflow-routes|exception-flow)\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'gate0.2b-negative', testMatch: /gate-0\.2b-state-negative\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'gate0.2b-recovery', testMatch: /gate-0\.2b-state-recovery\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'gate0.2b-visual-desktop', testMatch: /gate-0\.2b-visual\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'gate0.2b-visual-narrow', testMatch: /gate-0\.2b-visual\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    { name: 'gate0.2b-fast-chat-local', testMatch: /gate-0\.2b-fast-chat-local\.spec\.ts/u, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'gate-a0-live', testMatch: /gate-a0-(?:fast-chat|context-cancel)\.spec\.ts/u, use: {
      ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, trace: 'on',
    } },
  ],
  webServer: [
    {
      command: `cd .. && exec env GENEWAY_STORAGE_TARGET_ROLE=control-plane GENEWAY_START_STORAGE_RECONCILER=1 PORT=${String(controlPlanePort)} GENEWAY_WEB_PORT=${String(webPort)} bash scripts/with-storage.sh env GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT=${String(controlPlaneSupervisorPort)} GENEWAY_WORKER_SOCKET_PATH=${workerSocketPath} GENEWAY_WORKER_TOKEN_FILE=${workerTokenFile} GENEWAY_WORKER_LEASE_MS=1000 GENEWAY_E2E_HOOK_URL=http://127.0.0.1:${String(workerHealthPort)} GENEWAY_E2E_HOOK_TOKEN_FILE=${workerTokenFile}${controlPlaneGatewayEnvironment} ./node_modules/.bin/tsx scripts/e2e/start-e2e-control-plane.ts`,
      url: `http://127.0.0.1:${String(controlPlaneSupervisorPort)}/health`,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `cd .. && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_RUN_ID=${runId} GENEWAY_WORKER_HEALTH_PORT=${String(workerHealthPort)} GENEWAY_WORKER_SOCKET_PATH=${workerSocketPath} GENEWAY_WORKER_TOKEN_FILE=${workerTokenFile} GENEWAY_WORKER_INSTANCE_ID=${workerInstanceId} GENEWAY_WORKER_CONSUMER=gate0.2a-worker GENEWAY_WORKER_DEPLOYMENT=gate0.2a-local${workerGatewayEnvironment} ./node_modules/.bin/tsx scripts/e2e/start-e2e-worker.ts`,
      url: `http://127.0.0.1:${String(workerHealthPort)}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `cd .. && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_RUN_ID=${runId} GENEWAY_WEB_PORT=${String(webPort)} GENEWAY_CONTROL_PLANE_PORT=${String(controlPlanePort)} ./node_modules/.bin/tsx scripts/e2e/start-e2e-service.ts vite`,
      url: `http://127.0.0.1:${String(webPort)}/conversations/new`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    ...(gateA0Live ? [{
      command: `cd .. && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_RUN_ID=${shellQuote(runId)} GENEWAY_WORKER_TOKEN_FILE=${shellQuote(workerTokenFile)} GENEWAY_MODEL_GATEWAY_SUPERVISOR_PORT=${String(modelGatewaySupervisorPort)} GENEWAY_E2E_SECRET_CANARY=${shellQuote(e2eSecretCanary ?? '')} GENEWAY_MODEL_GATEWAY_PORT=${String(modelGatewayPort)} GENEWAY_CONTROL_PLANE_URL=${shellQuote(`http://127.0.0.1:${String(controlPlanePort)}`)} GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(modelGatewayServiceTokenFile ?? '')} GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE=${shellQuote(modelGatewayInvocationSecretFile ?? '')} GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE=${shellQuote(codexSubscriptionAuthFile ?? '')} GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE=${shellQuote(modelGatewayConformanceFile ?? '')} ./node_modules/.bin/tsx scripts/e2e/start-e2e-model-gateway.ts`,
      url: `http://127.0.0.1:${String(modelGatewaySupervisorPort)}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    }, {
      command: `cd .. && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_RUN_ID=${shellQuote(runId)} DATABASE_URL=${shellQuote(process.env.DATABASE_URL ?? '')} GENEWAY_GATE_A0_RELEASE_PORT=${String(gateA0ReleasePort)} GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE=${shellQuote(codexSubscriptionAuthFile ?? '')} GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE=${shellQuote(modelGatewayConformanceFile ?? '')} ./node_modules/.bin/tsx scripts/e2e/start-gate-a0-release.ts`,
      url: `http://127.0.0.1:${String(gateA0ReleasePort)}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    }] : []),
  ],
});
