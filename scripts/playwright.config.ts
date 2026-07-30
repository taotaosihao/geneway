import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';

const runId = process.env.GENEWAY_RUN_ID ?? 'gate-0.1-local';
const syntheticProductionBrief = process.env.GENEWAY_SYNTHETIC_PRODUCTION_BRIEF === '1'
  || process.argv.some((argument) => argument === '--project=synthetic-production-brief'
    || argument === 'synthetic-production-brief');
if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error('GENEWAY_RUN_ID contains unsafe path characters');
const webPort = Number(process.env.GENEWAY_WEB_PORT ?? 3200);
const controlPlanePort = Number(process.env.GENEWAY_CONTROL_PLANE_PORT ?? 3100);
const controlPlaneSupervisorPort = Number(process.env.GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT ?? 3400);
const workerHealthPort = Number(process.env.GENEWAY_WORKER_HEALTH_PORT ?? 3300);
const workerSocketPath = process.env.GENEWAY_WORKER_SOCKET_PATH;
const workerTokenFile = process.env.GENEWAY_WORKER_TOKEN_FILE ?? '';
const workerInstanceId = process.env.GENEWAY_WORKER_INSTANCE_ID;
const gateA0Live = process.env.GENEWAY_GATE_A0_LIVE === '1';
const gateALive = process.env.GENEWAY_GATE_A_LIVE === '1';
const modelGatewayPort = Number(process.env.GENEWAY_MODEL_GATEWAY_PORT ?? 3150);
const modelGatewaySupervisorPort = Number(process.env.GENEWAY_MODEL_GATEWAY_SUPERVISOR_PORT ?? 3450);
const connectorGatewayPort = Number(process.env.GENEWAY_CONNECTOR_GATEWAY_PORT ?? 3155);
const connectorGatewaySupervisorPort = Number(process.env.GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_PORT ?? 3455);
const gateA0ReleasePort = Number(process.env.GENEWAY_GATE_A0_RELEASE_PORT ?? 3160);
const gateAReleasePort = Number(process.env.GENEWAY_GATE_A_RELEASE_PORT ?? 3170);
const gateA3ReleasePort = Number(process.env.GENEWAY_GATE_A3_RELEASE_PORT ?? 3175);
const modelGatewayServiceTokenFile = process.env.GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE;
const modelGatewayInvocationSecretFile = process.env.GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE;
const codexSubscriptionAuthFile = process.env.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE;
const modelGatewayConformanceFile = process.env.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE;
const e2eSecretCanary = process.env.GENEWAY_E2E_SECRET_CANARY;
const gateAParserImage = process.env.GENEWAY_GATE_A_PARSER_IMAGE;
const gateAParserBuildJson = process.env.GENEWAY_GATE_A_PARSER_BUILD_JSON;
const gateAParserApprovalJson = process.env.GENEWAY_GATE_A_PARSER_APPROVAL_JSON;
const gateAApprovedC1Sha256 = process.env.GENEWAY_GATE_A_APPROVED_C1_SHA256;
const gateA3ValidationRunId = process.env.GENEWAY_GATE_A3_VALIDATION_RUN_ID;
const gateA3ApprovedPreflightFile = process.env.GENEWAY_GATE_A3_APPROVED_PREFLIGHT_FILE;
const gateA3ControllerAdmissionFile = process.env.GENEWAY_GATE_A3_CONTROLLER_ADMISSION_FILE;
const gateA3InternalValidationAdmissionFile = process.env.GENEWAY_GATE_A3_INTERNAL_VALIDATION_ADMISSION_FILE;
const connectorGatewayServiceTokenFile = process.env.GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE;
const connectorGatewayInvocationSecretFile = process.env.GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE;
const connectorGatewayReceiptSecretFile = process.env.GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE;
const connectorGatewaySupervisorTokenFile = process.env.GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_TOKEN_FILE;
const modelGatewayWorkOrderReceiptSecretFile = process.env.GENEWAY_MODEL_GATEWAY_WORK_ORDER_RECEIPT_SECRET_FILE;
const gearJobServiceCredentialFile = process.env.GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE;
const gearJobFacadeUrl = process.env.GENEWAY_GEARJOB_FACADE_URL;
if (!Number.isInteger(webPort) || !Number.isInteger(controlPlanePort) || !Number.isInteger(controlPlaneSupervisorPort)
  || !Number.isInteger(workerHealthPort) || !Number.isInteger(modelGatewayPort)
  || !Number.isInteger(modelGatewaySupervisorPort) || !Number.isInteger(connectorGatewayPort)
  || !Number.isInteger(connectorGatewaySupervisorPort)
  || !Number.isInteger(gateA0ReleasePort) || !Number.isInteger(gateAReleasePort)
  || !Number.isInteger(gateA3ReleasePort)) {
  throw new Error('GENEWAY ports must be integers');
}
if (!syntheticProductionBrief && (workerSocketPath === undefined || workerTokenFile === undefined || workerInstanceId === undefined)) throw new Error('E2E Worker authority is required');
if (!syntheticProductionBrief && (!/^\/tmp\/gw-uds-[a-zA-Z0-9]+\/worker\.sock$/u.test(workerSocketPath ?? '')
  || !/^\/tmp\/gw-uds-[a-zA-Z0-9]+\/token$/u.test(workerTokenFile)
  || !/^e2e-worker-[a-zA-Z0-9._-]+$/u.test(workerInstanceId ?? ''))) {
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
if (gateALive && (!gateA0Live
  || gateAParserImage === undefined || !/^geneway-document-parser:[a-f0-9]{16}$/u.test(gateAParserImage)
  || gateAParserBuildJson === undefined || gateAParserApprovalJson === undefined
  || gateAApprovedC1Sha256 === undefined
  || gateAApprovedC1Sha256.split(',').length !== 6
  || new Set(gateAApprovedC1Sha256.split(',')).size !== 6
  || gateAApprovedC1Sha256.split(',').some((hash) => !/^[a-f0-9]{64}$/u.test(hash)))) {
  throw new Error('gate-a-live requires Gate A0 live plus source-bound parser and exact C1 corpus authority');
}
const gateA3Files = [gateA3ApprovedPreflightFile, gateA3ControllerAdmissionFile,
  gateA3InternalValidationAdmissionFile, connectorGatewayServiceTokenFile,
  connectorGatewayInvocationSecretFile, connectorGatewayReceiptSecretFile,
  connectorGatewaySupervisorTokenFile, modelGatewayWorkOrderReceiptSecretFile,
  gearJobServiceCredentialFile];
if (gateALive && (gateA3ValidationRunId !== runId
  || gateA3Files.some((value) => value === undefined || !value.startsWith('/'))
  || gearJobFacadeUrl !== 'http://127.0.0.1:8100')) {
  throw new Error('gate-a-live requires run-bound Gate A.3 authority and private Gateway credential files');
}
const modelGatewayUrl = `http://127.0.0.1:${String(modelGatewayPort)}`;
const connectorGatewayUrl = `http://127.0.0.1:${String(connectorGatewayPort)}`;
const controlPlaneGatewayEnvironment = gateA0Live
  ? ` GENEWAY_MODEL_GATEWAY_URL=${shellQuote(modelGatewayUrl)}`
    + ` GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(modelGatewayServiceTokenFile ?? '')}`
    + ` GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE=${shellQuote(modelGatewayInvocationSecretFile ?? '')}`
    + ` GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID=${shellQuote(runId)}`
    + (gateALive
      ? ` GENEWAY_GATE_A_LIVE_VALIDATION_RUN_ID=${shellQuote(runId)}`
        + ` GENEWAY_GATE_A_PARSER_IMAGE=${shellQuote(gateAParserImage ?? '')}`
        + ` GENEWAY_GATE_A_PARSER_APPROVAL_JSON=${shellQuote(gateAParserApprovalJson ?? '')}`
        + ` GENEWAY_GATE_A_APPROVED_C1_SHA256=${shellQuote(gateAApprovedC1Sha256 ?? '')}`
        + ` GENEWAY_GATE_A3_VALIDATION_RUN_ID=${shellQuote(gateA3ValidationRunId ?? '')}`
        + ` GENEWAY_GATE_A3_APPROVED_PREFLIGHT_FILE=${shellQuote(gateA3ApprovedPreflightFile ?? '')}`
        + ` GENEWAY_GATE_A3_CONTROLLER_ADMISSION_FILE=${shellQuote(gateA3ControllerAdmissionFile ?? '')}`
        + ` GENEWAY_GATE_A3_INTERNAL_VALIDATION_ADMISSION_FILE=${shellQuote(gateA3InternalValidationAdmissionFile ?? '')}`
        + ` GENEWAY_CONNECTOR_GATEWAY_URL=${shellQuote(connectorGatewayUrl)}`
        + ` GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(connectorGatewayServiceTokenFile ?? '')}`
        + ` GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE=${shellQuote(connectorGatewayInvocationSecretFile ?? '')}`
        + ` GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE=${shellQuote(connectorGatewayReceiptSecretFile ?? '')}`
        + ` GENEWAY_MODEL_GATEWAY_WORK_ORDER_RECEIPT_SECRET_FILE=${shellQuote(modelGatewayWorkOrderReceiptSecretFile ?? '')}`
      : '')
  : '';
const workerGatewayEnvironment = gateA0Live
  ? ` GENEWAY_MODEL_GATEWAY_URL=${shellQuote(modelGatewayUrl)}`
    + ` GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(modelGatewayServiceTokenFile ?? '')}`
    + (gateALive
      ? ` GENEWAY_GATE_A3_WORK_ORDER_ENABLED=1`
        + ` GENEWAY_CONNECTOR_GATEWAY_URL=${shellQuote(connectorGatewayUrl)}`
        + ` GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(connectorGatewayServiceTokenFile ?? '')}`
      : '')
  : '';
const outputRoot = `/tmp/geneway-runs/${runId}`;
const syntheticHomeRoot = `${outputRoot}/home`;
const browserHome = `${syntheticHomeRoot}/browser`;
const stackHome = `${syntheticHomeRoot}/stack`;
if (syntheticProductionBrief) {
  for (const directory of [outputRoot, syntheticHomeRoot, browserHome, stackHome, `${outputRoot}/process-boundaries`]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
}
const gate02bGuarded = syntheticProductionBrief || process.env.GENEWAY_GATE02B_EGRESS_GUARD === 'required';
const gate02bGuardLibrary = syntheticProductionBrief
  ? `${outputRoot}/synthetic-browser-egress-guard.so`
  : process.env.GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY;
if (gate02bGuarded && (gate02bGuardLibrary === undefined || !gate02bGuardLibrary.startsWith('/'))) {
  throw new Error('Guarded browser launch requires an absolute egress guard library path');
}
const browserEgressReceipt = `${outputRoot}/process-boundaries/browser-egress.raw`;
if (syntheticProductionBrief && gate02bGuardLibrary !== undefined && !existsSync(gate02bGuardLibrary)) {
  const compiled = spawnSync('cc', [
    '-std=gnu17', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-ldl',
    '-o', gate02bGuardLibrary, 'scripts/backup-restore/gate02b-egress-guard.c',
  ], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (compiled.error !== undefined) throw compiled.error;
  if (compiled.status !== 0) throw new Error(`Synthetic browser egress guard compilation failed: ${compiled.stderr}`);
  chmodSync(gate02bGuardLibrary, 0o555);
}
if (gate02bGuarded && gate02bGuardLibrary !== undefined) {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) throw new Error('Guarded browser launch requires a Linux process identity');
  const libraryStat = lstatSync(gate02bGuardLibrary);
  if (!libraryStat.isFile() || libraryStat.isSymbolicLink() || libraryStat.uid !== currentUid
    || (libraryStat.mode & 0o022) !== 0 || realpathSync(gate02bGuardLibrary) !== gate02bGuardLibrary) {
    throw new Error('Guarded browser egress library is unsafe');
  }
  if (!existsSync(browserEgressReceipt)) writeFileSync(browserEgressReceipt, '', { flag: 'wx', mode: 0o600 });
  const receiptStat = lstatSync(browserEgressReceipt);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.uid !== currentUid
    || (receiptStat.mode & 0o777) !== 0o600 || receiptStat.nlink !== 1) {
    throw new Error('Guarded browser egress receipt is unsafe');
  }
}
const browserGuardLibrarySha256 = gate02bGuarded
  ? createHash('sha256').update(readFileSync(gate02bGuardLibrary ?? '')).digest('hex')
  : null;
const configuredSyntheticBrowserExecutable = process.env.GENEWAY_SYNTHETIC_CHROMIUM_EXECUTABLE;
if (syntheticProductionBrief && (configuredSyntheticBrowserExecutable === undefined
  || !configuredSyntheticBrowserExecutable.startsWith('/'))) {
  throw new Error('Synthetic browser launch requires an explicitly bound absolute Chromium executable');
}
const browserExecutable = syntheticProductionBrief
  ? configuredSyntheticBrowserExecutable ?? ''
  : chromium.executablePath();
if (syntheticProductionBrief) {
  const currentUid = process.getuid?.();
  const executableStat = lstatSync(browserExecutable);
  if (currentUid === undefined || !executableStat.isFile() || executableStat.isSymbolicLink()
    || executableStat.uid !== currentUid || (executableStat.mode & 0o111) === 0
    || realpathSync(browserExecutable) !== browserExecutable) {
    throw new Error('Synthetic Chromium executable is not a safe current-user-owned regular executable');
  }
}
const browserExecutables = [browserExecutable, join(dirname(browserExecutable), 'chrome_crashpad_handler')].map((executable) => {
  const stat = statSync(executable);
  return { executable, device: stat.dev, inode: stat.ino, sha256: createHash('sha256').update(readFileSync(executable)).digest('hex') };
});
const browserPolicyHash = gate02bGuarded
  ? createHash('sha256').update(JSON.stringify({
    runId, webPort, browserGuardLibrarySha256, browserExecutables,
  })).digest('hex')
  : null;
const browserEnvironment = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: syntheticProductionBrief ? browserHome : process.env.HOME ?? '/tmp',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: process.env.LANG ?? 'C.UTF-8',
  ...(gate02bGuarded ? {
    LD_PRELOAD: gate02bGuardLibrary ?? '',
    GENEWAY_GATE02B_BROWSER_EGRESS_GUARD: 'required',
    GENEWAY_GATE02B_BROWSER_POLICY_HASH: browserPolicyHash ?? '',
    GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS: String(webPort),
    GENEWAY_GATE02B_EGRESS_RECEIPT: browserEgressReceipt,
  } : {}),
};
const browserEnvironmentNames = Object.keys(browserEnvironment);
if (browserEnvironmentNames.some((name) => name.startsWith('GENEWAY_S3_') || name.startsWith('GENEWAY_STORAGE_') || name.startsWith('AWS_'))) {
  throw new Error('Browser launch environment contains a forbidden storage credential source');
}
mkdirSync(`${outputRoot}/process-boundaries`, { recursive: true });
writeFileSync(`${outputRoot}/process-boundaries/browser.json`, `${JSON.stringify({
  role: 'browser', checked: true, home: browserEnvironment.HOME, forbiddenNamesPresent: [],
  egressGuard: {
    required: gate02bGuarded,
    allowedPorts: gate02bGuarded ? [webPort] : [],
    receipt: gate02bGuarded ? browserEgressReceipt : null,
    librarySha256: browserGuardLibrarySha256,
    browserExecutable,
    browserExecutables,
    policyHash: browserPolicyHash,
  },
})}\n`, { mode: 0o600 });

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: `${outputRoot}/playwright-artifacts`,
  reporter: [['list'], ['json', { outputFile: `${outputRoot}/playwright-report.json` }]],
  use: {
    baseURL: `http://${syntheticProductionBrief ? '127.0.0.1' : 'localhost'}:${String(webPort)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: { env: browserEnvironment, ...(gate02bGuarded ? { executablePath: browserExecutable } : {}) },
  },
  projects: [
    { name: 'synthetic-production-brief', testMatch: /synthetic-production-brief\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, trace: 'on', video: 'off' } },
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
    { name: 'gate-a-not-open', testMatch: /gate-a-not-open\.spec\.ts/u, use: {
      ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 },
      trace: { mode: 'on', sources: false },
    } },
    { name: 'gate-a-browser-egress', dependencies: ['gate-a-not-open'],
      testMatch: /gate-a-browser-egress\.setup\.ts/u, use: {
      ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 },
      trace: { mode: 'on', sources: false },
    } },
    { name: 'gate-a-live', dependencies: ['gate-a-browser-egress'],
      testMatch: /(?:gate-a-(?:solution-analysis|work-order-status)|gate-a0-(?:fast-chat|context-cancel))\.spec\.ts/u, use: {
      ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 },
      trace: { mode: 'on', sources: false },
    } },
    { name: 'gate-a-recovery', dependencies: ['gate-a-browser-egress'],
      testMatch: /gate-a-recovery\.spec\.ts/u, use: {
      ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 },
      trace: { mode: 'on', sources: false },
    } },
  ],
  webServer: syntheticProductionBrief ? [{
    command: `cd .. && exec env -i PATH="$PATH" HOME=${shellQuote(stackHome)} TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" COREPACK_ENABLE_NETWORK=0 npm_config_offline=true PNPM_CONFIG_OFFLINE=true bash scripts/with-postgres.sh node scripts/run-synthetic-production-brief.mjs`,
    url: 'http://127.0.0.1:3200/work-orders/mock',
    timeout: 90_000,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 15_000 },
    reuseExistingServer: false,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  }] : [
    {
      command: `cd .. && exec env -u GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE -u GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE -u GENEWAY_GATE_A_PARSER_BUILD_JSON -u GENEWAY_GATE02B_EGRESS_GUARD -u GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY -u GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE -u GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_TOKEN_FILE GENEWAY_STORAGE_TARGET_ROLE=control-plane GENEWAY_START_STORAGE_RECONCILER=1 PORT=${String(controlPlanePort)} GENEWAY_WEB_PORT=${String(webPort)} bash scripts/with-storage.sh env GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT=${String(controlPlaneSupervisorPort)} GENEWAY_WORKER_SOCKET_PATH=${workerSocketPath} GENEWAY_WORKER_TOKEN_FILE=${workerTokenFile} GENEWAY_WORKER_LEASE_MS=1000 GENEWAY_E2E_HOOK_URL=http://127.0.0.1:${String(workerHealthPort)} GENEWAY_E2E_HOOK_TOKEN_FILE=${workerTokenFile}${controlPlaneGatewayEnvironment} ./node_modules/.bin/tsx scripts/e2e/start-e2e-control-plane.ts`,
      url: `http://127.0.0.1:${String(controlPlaneSupervisorPort)}/health`,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `cd .. && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_RUN_ID=${runId} GENEWAY_WORKER_HEALTH_PORT=${String(workerHealthPort)} GENEWAY_WORKER_SOCKET_PATH=${workerSocketPath} GENEWAY_WORKER_TOKEN_FILE=${workerTokenFile} GENEWAY_WORKER_INSTANCE_ID=${workerInstanceId} GENEWAY_WORKER_CONSUMER=gate0.2a-worker GENEWAY_WORKER_DEPLOYMENT=gate0.2a-local${workerGatewayEnvironment}${gateALive ? ' GENEWAY_GATE_A_LIVE_ENABLED=1' : ''} ./node_modules/.bin/tsx scripts/e2e/start-e2e-worker.ts`,
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
      command: `cd .. && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_RUN_ID=${shellQuote(runId)} GENEWAY_WORKER_TOKEN_FILE=${shellQuote(workerTokenFile)} GENEWAY_MODEL_GATEWAY_SUPERVISOR_PORT=${String(modelGatewaySupervisorPort)} GENEWAY_E2E_SECRET_CANARY=${shellQuote(e2eSecretCanary ?? '')} GENEWAY_MODEL_GATEWAY_PORT=${String(modelGatewayPort)} GENEWAY_CONTROL_PLANE_URL=${shellQuote(`http://127.0.0.1:${String(controlPlanePort)}`)} GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(modelGatewayServiceTokenFile ?? '')} GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE=${shellQuote(modelGatewayInvocationSecretFile ?? '')}${gateALive ? ` GENEWAY_MODEL_GATEWAY_WORK_ORDER_RECEIPT_SECRET_FILE=${shellQuote(modelGatewayWorkOrderReceiptSecretFile ?? '')}` : ''} GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE=${shellQuote(codexSubscriptionAuthFile ?? '')} GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE=${shellQuote(modelGatewayConformanceFile ?? '')} ./node_modules/.bin/tsx scripts/e2e/start-e2e-model-gateway.ts`,
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
    ...(gateALive ? [{
      command: `cd .. && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_RUN_ID=${shellQuote(runId)} GENEWAY_CONNECTOR_GATEWAY_PORT=${String(connectorGatewayPort)} GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_PORT=${String(connectorGatewaySupervisorPort)} GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_TOKEN_FILE=${shellQuote(connectorGatewaySupervisorTokenFile ?? '')} GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(connectorGatewayServiceTokenFile ?? '')} GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE=${shellQuote(connectorGatewayInvocationSecretFile ?? '')} GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE=${shellQuote(connectorGatewayReceiptSecretFile ?? '')} GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE=${shellQuote(gearJobServiceCredentialFile ?? '')} GENEWAY_CONTROL_PLANE_URL=${shellQuote(`http://127.0.0.1:${String(controlPlanePort)}`)} GENEWAY_GEARJOB_FACADE_URL=${shellQuote(gearJobFacadeUrl ?? '')} ./node_modules/.bin/tsx scripts/e2e/start-e2e-connector-gateway.ts`,
      url: `http://127.0.0.1:${String(connectorGatewayPort)}/health`,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 30_000 },
      reuseExistingServer: false,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    }, {
      command: `cd .. && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_RUN_ID=${shellQuote(runId)} DATABASE_URL=${shellQuote(process.env.DATABASE_URL ?? '')} GENEWAY_GATE_A_RELEASE_PORT=${String(gateAReleasePort)} GENEWAY_GATE_A_NOT_OPEN_MARKER_REQUIRED=1 GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE=${shellQuote(codexSubscriptionAuthFile ?? '')} GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE=${shellQuote(modelGatewayConformanceFile ?? '')} GENEWAY_GATE_A_PARSER_IMAGE=${shellQuote(gateAParserImage ?? '')} GENEWAY_GATE_A_PARSER_BUILD_JSON=${shellQuote(gateAParserBuildJson ?? '')} GENEWAY_GATE_A_PARSER_APPROVAL_JSON=${shellQuote(gateAParserApprovalJson ?? '')} ./node_modules/.bin/tsx scripts/e2e/start-gate-a-release.ts`,
      url: `http://127.0.0.1:${String(gateAReleasePort)}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    }, {
      command: `cd .. && exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${process.env.TMPDIR ?? '/tmp'}" LANG="${process.env.LANG ?? 'C.UTF-8'}" NODE_ENV=test GENEWAY_GATE_A3_VALIDATION_RUN_ID=${shellQuote(gateA3ValidationRunId ?? '')} DATABASE_URL=${shellQuote(process.env.DATABASE_URL ?? '')} GENEWAY_CONTROL_PLANE_URL=${shellQuote(`http://127.0.0.1:${String(controlPlanePort)}`)} GENEWAY_GATE_A3_RELEASE_PORT=${String(gateA3ReleasePort)} GENEWAY_GATE_A3_APPROVED_PREFLIGHT_FILE=${shellQuote(gateA3ApprovedPreflightFile ?? '')} GENEWAY_GATE_A3_CONTROLLER_ADMISSION_FILE=${shellQuote(gateA3ControllerAdmissionFile ?? '')} GENEWAY_GATE_A3_INTERNAL_VALIDATION_ADMISSION_FILE=${shellQuote(gateA3InternalValidationAdmissionFile ?? '')} GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE=${shellQuote(connectorGatewayServiceTokenFile ?? '')} GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE=${shellQuote(connectorGatewayInvocationSecretFile ?? '')} GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE=${shellQuote(connectorGatewayReceiptSecretFile ?? '')} GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE=${shellQuote(modelGatewayInvocationSecretFile ?? '')} GENEWAY_MODEL_GATEWAY_WORK_ORDER_RECEIPT_SECRET_FILE=${shellQuote(modelGatewayWorkOrderReceiptSecretFile ?? '')} ./node_modules/.bin/tsx scripts/e2e/start-gate-a3-release.ts`,
      url: `http://127.0.0.1:${String(gateA3ReleasePort)}/health`,
      timeout: 90_000,
      gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 30_000 },
      reuseExistingServer: false,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    }] : []),
  ],
});
