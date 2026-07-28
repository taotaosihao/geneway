import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { readApprovedGateA3Authority } from './dev-up.mjs';
import {
  createDisposablePostgresLifecycleObserver,
  validateDisposablePostgresInspection,
} from './gate-a3-stack-lifecycle.mjs';
import {
  assertNoSensitiveWorkOrderProjection,
  gateA3TaskSqlLiteral,
  servedTaskTerminalFailure,
} from './gate-a3-served-task-state.mjs';
import { finishZeroWriteOracle, startZeroWriteOracle } from './e2e/gearjob-zero-write-oracle.ts';

const repositoryRoot = new URL('..', import.meta.url);
const basePort = 18_000 + Math.floor(Math.random() * 8_000);
const ports = { controlPlane: basePort, modelGateway: basePort + 1, web: basePort + 2 };
const verificationRunId = process.env.GENEWAY_RUN_ID ?? `gate-a3-${String(Date.now())}-${String(process.pid)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(verificationRunId)) throw new Error('GENEWAY_RUN_ID is invalid');
const evidenceDirectory = `/tmp/geneway-runs/${verificationRunId}/gate-a`;
const summaryPath = `${evidenceDirectory}/served-ui-summary.json`;
const subprocessLogPath = `${evidenceDirectory}/subprocess.redacted.log`;
const logs = [];
const postgresLifecycle = createDisposablePostgresLifecycleObserver();
const execFileAsync = promisify(execFile);
const providerAuthFile = process.env.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE;
const providerConformanceFile = process.env.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE;

function redactText(text) {
  let redacted = text;
  if (providerAuthFile !== undefined) redacted = redacted.replaceAll(providerAuthFile, '[REDACTED AUTH FILE]');
  if (providerConformanceFile !== undefined) {
    redacted = redacted.replaceAll(providerConformanceFile, '[REDACTED CONFORMANCE FILE]');
  }
  return redacted.split('\n').map((line) => {
    if (/authorization|bearer|credential|secret|raw[\s_-]*receipt/iu.test(line)) {
      return '[REDACTED SENSITIVE LOG LINE]';
    }
    return line;
  }).join('\n');
}

function record(chunk, stream) {
  const text = chunk.toString('utf8');
  postgresLifecycle.record(text);
  logs.push(text);
  if (logs.join('').length > 80_000) logs.splice(0, Math.max(1, Math.floor(logs.length / 2)));
  stream.write(redactText(text));
}

function redactedSubprocessLog() {
  return redactText(logs.join(''));
}

function advertisedLanUrls() {
  return [...logs.join('').matchAll(/^\s+(http:\/\/(?:(?:192\.168)|10\.)[^\s]+\/conversations\/new)\s*$/gmu)]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
}

function isExpectedLanUrl(value) {
  const url = new URL(value);
  const octets = url.hostname.split('.').map(Number);
  const privateLan = octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && (octets[0] === 10 || (octets[0] === 192 && octets[1] === 168));
  return url.protocol === 'http:' && privateLan && url.port === String(ports.web)
    && url.pathname === '/conversations/new' && url.search === '' && url.hash === '';
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} public keys changed: ${JSON.stringify(actual)}`);
  }
}

function assertNoInternalProjection(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInternalProjection(item, `${path}[${String(index)}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/endpoint|profile|credential|receipt|base_?url|principal_?id|tenant_?id|invocation/i.test(key)) {
      throw new Error(`strict public snapshot exposed internal field at ${path}.${key}`);
    }
    assertNoInternalProjection(child, `${path}.${key}`);
  }
}

function browserTargetIsAllowed(rawUrl, webOrigin) {
  const target = new URL(rawUrl);
  if (target.protocol === 'ws:' || target.protocol === 'wss:') {
    const websocketOrigin = `${target.protocol === 'ws:' ? 'http:' : 'https:'}//${target.host}`;
    return websocketOrigin === webOrigin;
  }
  return target.origin === webOrigin;
}

function browserViolation(rawUrl, kind) {
  const target = new URL(rawUrl);
  return { kind, protocol: target.protocol, origin: target.origin };
}

async function dockerOutput(arguments_) {
  const { stdout } = await execFileAsync('docker', arguments_, { encoding: 'utf8', maxBuffer: 1_000_000 });
  return stdout.trim();
}

async function freezeDisposablePostgresIdentity() {
  const project = postgresLifecycle.freezeProject();
  const containerName = `${project}-postgres-1`;
  const raw = await dockerOutput(['inspect', containerName]);
  return validateDisposablePostgresInspection(project, JSON.parse(raw));
}

async function databaseCorrelation(taskId, authority, postgresIdentity) {
  const taskIdSql = gateA3TaskSqlLiteral(taskId);
  const sql = `SELECT json_build_object(
    'taskCount',(SELECT count(*) FROM business_tasks WHERE id=${taskIdSql} AND record_variant='business-task.work-order.live/1'),
    'approvedCount',(SELECT count(*) FROM approval_versions WHERE business_task_id=${taskIdSql} AND status='approved'),
    'completedStepCount',(SELECT count(*) FROM business_task_steps WHERE business_task_id=${taskIdSql} AND status='completed'),
    'connectorInvocationCount',(SELECT count(*) FROM gate_a3_connector_invocations WHERE business_task_id=${taskIdSql} AND status='completed' AND response_ref_matched),
    'sourceSnapshotCount',(SELECT count(*) FROM gate_a3_connector_source_snapshots WHERE business_task_id=${taskIdSql} AND response_ref_matched),
    'modelInvocationCount',(SELECT count(*) FROM gate_a3_model_invocations WHERE business_task_id=${taskIdSql} AND status='completed'),
    'evidenceCount',(SELECT count(*) FROM gate_a3_connector_evidence WHERE business_task_id=${taskIdSql} AND accessible),
    'wholeEvidenceCount',(SELECT count(*) FROM gate_a3_connector_evidence WHERE business_task_id=${taskIdSql}
      AND accessible AND locator_kind='connector_snapshot_whole'),
    'fieldEvidenceCount',(SELECT count(*) FROM gate_a3_connector_evidence WHERE business_task_id=${taskIdSql}
      AND accessible AND locator_kind='connector_snapshot_field'),
    'distinctEvidenceFieldCount',(SELECT count(DISTINCT field_name) FROM gate_a3_connector_evidence
      WHERE business_task_id=${taskIdSql} AND accessible AND locator_kind='connector_snapshot_field'),
    'evidenceSnapshotIdentityCount',(SELECT count(DISTINCT connector_source_snapshot_id)
      FROM gate_a3_connector_evidence WHERE business_task_id=${taskIdSql} AND accessible),
    'evidenceInvocationIdentityCount',(SELECT count(DISTINCT connector_invocation_id)
      FROM gate_a3_connector_evidence WHERE business_task_id=${taskIdSql} AND accessible),
    'evidenceEffectIdentityCount',(SELECT count(DISTINCT effect_id)
      FROM gate_a3_connector_evidence WHERE business_task_id=${taskIdSql} AND accessible),
    'sourceRevocationCount',(SELECT count(*) FROM gate_a3_connector_source_revocations WHERE business_task_id=${taskIdSql}),
    'resultCount',(SELECT count(*) FROM gate_a3_work_order_results WHERE business_task_id=${taskIdSql}),
    'currentAuthorityCount',(SELECT count(*) FROM gate_a3_authority_current current
      JOIN gate_a3_authority_stages stage ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
      JOIN gate_a3_authority_envelopes envelope ON envelope.tenant_id=stage.tenant_id
        AND envelope.authority_digest=stage.authority_digest
      WHERE current.tenant_id='tenant_local' AND current.capability_id='production.work-order-status.v1'
        AND stage.state='internal' AND envelope.expires_at>now()
        AND NOT EXISTS (SELECT 1 FROM gate_a3_authority_revocations revoked
          WHERE revoked.tenant_id=envelope.tenant_id AND revoked.authority_digest=envelope.authority_digest)),
    'taskCurrentAuthorityCount',(SELECT count(*) FROM business_tasks task
      JOIN gate_a3_authority_current current ON current.tenant_id=task.tenant_id
        AND current.capability_id='production.work-order-status.v1'
      JOIN gate_a3_authority_stages stage ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
      WHERE task.id=${taskIdSql} AND task.gate_a3_authority_digest=stage.authority_digest),
    'approvedPreflightDigest',(SELECT envelope.approved_preflight_digest FROM gate_a3_authority_current current
      JOIN gate_a3_authority_stages stage ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
      JOIN gate_a3_authority_envelopes envelope ON envelope.tenant_id=stage.tenant_id
        AND envelope.authority_digest=stage.authority_digest
      WHERE current.tenant_id='tenant_local' AND current.capability_id='production.work-order-status.v1'),
    'internalAdmissionDigest',(SELECT envelope.internal_admission_digest FROM gate_a3_authority_current current
      JOIN gate_a3_authority_stages stage ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
      JOIN gate_a3_authority_envelopes envelope ON envelope.tenant_id=stage.tenant_id
        AND envelope.authority_digest=stage.authority_digest
      WHERE current.tenant_id='tenant_local' AND current.capability_id='production.work-order-status.v1'))::text`;
  const output = await dockerOutput(['exec', postgresIdentity.containerId, 'psql', '-U', 'geneway', '-d', 'geneway_test',
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  const correlation = JSON.parse(output);
  const expected = { taskCount: 1, approvedCount: 1, completedStepCount: 6, connectorInvocationCount: 1,
    sourceSnapshotCount: 1, modelInvocationCount: 1, evidenceCount: 10,
    wholeEvidenceCount: 1, fieldEvidenceCount: 9, distinctEvidenceFieldCount: 9,
    evidenceSnapshotIdentityCount: 1, evidenceInvocationIdentityCount: 1,
    evidenceEffectIdentityCount: 1, sourceRevocationCount: 0, resultCount: 1,
    currentAuthorityCount: 1, taskCurrentAuthorityCount: 1 };
  for (const [key, value] of Object.entries(expected)) {
    if (correlation[key] !== value) throw new Error(`Gate A.3 database correlation failed for ${key}`);
  }
  if (correlation.approvedPreflightDigest !== authority.approvedPreflightDigest
    || correlation.internalAdmissionDigest !== authority.internalValidationAdmissionDigest) {
    throw new Error('Gate A.3 database current-authority tuple differs from the canonical artifact chain');
  }
  return correlation;
}

async function databaseRevocationCorrelation(taskId, postgresIdentity) {
  const taskIdSql = gateA3TaskSqlLiteral(taskId);
  const sql = `SELECT json_build_object(
    'sourceRevocationCount',(SELECT count(*) FROM gate_a3_connector_source_revocations WHERE business_task_id=${taskIdSql}),
    'retainedEvidenceCount',(SELECT count(*) FROM gate_a3_connector_evidence WHERE business_task_id=${taskIdSql}),
    'retainedResultCount',(SELECT count(*) FROM gate_a3_work_order_results WHERE business_task_id=${taskIdSql}),
    'retainedCompletedTaskCount',(SELECT count(*) FROM business_tasks WHERE id=${taskIdSql} AND status='completed'))::text`;
  const output = await dockerOutput(['exec', postgresIdentity.containerId, 'psql', '-U', 'geneway', '-d', 'geneway_test',
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  const correlation = JSON.parse(output);
  const expected = { sourceRevocationCount: 1, retainedEvidenceCount: 10,
    retainedResultCount: 1, retainedCompletedTaskCount: 1 };
  for (const [key, value] of Object.entries(expected)) {
    if (correlation[key] !== value) throw new Error(`Gate A.3 revocation correlation failed for ${key}`);
  }
  return correlation;
}

async function requestJson(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${String(ports.controlPlane)}${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(10_000), ...options,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} failed with ${String(response.status)}: ${JSON.stringify(body)}`);
  return body;
}

async function requestExpectedStatus(path, expectedStatus, options = {}) {
  const response = await fetch(`http://127.0.0.1:${String(ports.controlPlane)}${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(10_000), ...options,
  });
  const body = await response.json().catch(() => null);
  if (response.status !== expectedStatus) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${String(response.status)}, expected ${String(expectedStatus)}: ${JSON.stringify(body)}`);
  }
  return body;
}

class ServedTaskTerminalError extends Error {
  constructor(readonlyFailure) {
    super(`served Work Order task reached ${readonlyFailure.status}: ${readonlyFailure.code}`);
    this.name = 'ServedTaskTerminalError';
    this.failure = readonlyFailure;
  }
}

async function waitForTerminalTaskFailure(taskId, signal) {
  while (!signal.aborted) {
    const snapshot = await requestJson(`/api/business-tasks/${encodeURIComponent(taskId)}`);
    const terminal = servedTaskTerminalFailure(snapshot);
    if (terminal !== null) throw new ServedTaskTerminalError(terminal);
    await new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, 200);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

async function waitForStack(child) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('dev-up exited before Gate A.3 verification');
    if (logs.join('').includes('✓ geneway 开发环境已启动')) {
      const urls = advertisedLanUrls();
      if (urls.length > 0) {
        if (!urls.every(isExpectedLanUrl)) throw new Error(`dev-up advertised an unexpected Gate A.3 Web URL`);
        return urls[0];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for the disposable Gate A.3 stack');
}

async function stopStack(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGINT');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 30_000)),
  ]);
  if (timedOut) {
    child.kill('SIGTERM');
    await exited;
  }
}

const environment = { ...process.env };
for (const name of [
  'GENEWAY_GATE_A0_RELEASE_PORT', 'GENEWAY_GATE_A_RELEASE_PORT',
]) delete environment[name];
Object.assign(environment, {
  GENEWAY_GATE_A3_REQUIRED: '1',
  GENEWAY_CONTROL_PLANE_PORT: String(ports.controlPlane),
  GENEWAY_MODEL_GATEWAY_PORT: String(ports.modelGateway),
  GENEWAY_WEB_PORT: String(ports.web),
});

let authority;
let child;
let browser;
let page;
let browserTaskId;
let zeroWriteOracle;
let zeroWriteResult;
let authorityCorrelation;
let revocationCorrelation;
let publicEvidenceReadSummary;
let disposablePostgresIdentity;
let verificationStage = 'starting_disposable_stack';
try {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  if (providerAuthFile === undefined || providerConformanceFile === undefined) {
    throw new Error('Real Gate A.3 verification requires the existing authorized provider auth and conformance file pair');
  }
  authority = readApprovedGateA3Authority();
  child = spawn(process.execPath, ['scripts/dev-up.mjs'], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => record(chunk, process.stdout));
  child.stderr.on('data', (chunk) => record(chunk, process.stderr));
  const advertisedUrl = await waitForStack(child);
  if (advertisedUrl === undefined) throw new Error('dev-up did not advertise a LAN Web URL');
  disposablePostgresIdentity = await freezeDisposablePostgresIdentity();
  const webOrigin = new URL(advertisedUrl).origin;
  const route = await requestJson('/api/capabilities/production.work-order-status.v1');
  if (route.status !== 'internal' || route.executionRoute !== 'live'
    || route.internalAcceptance !== true || route.businessDecisionAllowed !== false) {
    throw new Error('Gate A.3 capability route is not open for the approved internal acceptance run');
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1100 } });
  page = await context.newPage();
  const blockedBrowserRequests = [];
  const pageErrors = [];
  page.on('request', (request) => {
    if (!browserTargetIsAllowed(request.url(), webOrigin)) {
      blockedBrowserRequests.push(browserViolation(request.url(), request.resourceType()));
    }
  });
  page.on('websocket', (socket) => {
    if (!browserTargetIsAllowed(socket.url(), webOrigin)) {
      blockedBrowserRequests.push(browserViolation(socket.url(), 'websocket'));
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${webOrigin}/work-orders/new`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  verificationStage = 'creating_work_order_via_served_ui';
  const workOrderInput = page.getByTestId('work-order-ref');
  await workOrderInput.waitFor({ state: 'visible', timeout: 30_000 });
  await workOrderInput.fill('WO-GATE-A3-READABLE');
  const createButton = page.getByRole('button', { name: '创建查询任务', exact: true });
  await Promise.all([
    page.waitForURL((url) => url.origin === webOrigin
      && /^\/work-orders\/task_[A-Za-z0-9._:-]+$/u.test(url.pathname), { timeout: 30_000 }),
    createButton.click(),
  ]);
  const taskUrl = new URL(page.url());
  const taskId = decodeURIComponent(taskUrl.pathname.slice('/work-orders/'.length));
  if (!/^task_[A-Za-z0-9._:-]+$/u.test(taskId)) {
    throw new Error('served UI did not bind one opaque public task ID into its URL');
  }
  browserTaskId = taskId;

  verificationStage = 'awaiting_ui_approval';
  const approvalButton = page.getByTestId('work-order-approve-execute');
  await approvalButton.waitFor({ state: 'visible', timeout: 30_000 });
  const workflowSteps = page.locator('[data-testid="work-order-workflow"] li');
  if (await workflowSteps.count() !== 6) throw new Error('served UI did not render the frozen six-node Workflow before approval');
  const expectedSteps = [
    'validate_work_order_ref', 'fetch_authorized_status', 'compute_progress',
    'explain_status', 'evidence_verify', 'publish_status_card',
  ];
  const beforeExecutionSteps = await workflowSteps.allTextContents();
  expectedSteps.forEach((step, index) => {
    if (!beforeExecutionSteps[index]?.includes(step)) throw new Error(`served Workflow node ${String(index + 1)} is not ${step}`);
  });
  await page.screenshot({ path: `${evidenceDirectory}/work-order-awaiting-approval.png`, fullPage: true });
  await chmod(`${evidenceDirectory}/work-order-awaiting-approval.png`, 0o600);

  zeroWriteOracle = await startZeroWriteOracle();
  await approvalButton.click();
  verificationStage = 'waiting_for_publication';
  const statusCard = page.getByTestId('work-order-status-card');
  const terminalWatcherAbort = new AbortController();
  try {
    await Promise.race([
      statusCard.waitFor({ state: 'visible', timeout: 120_000 }),
      waitForTerminalTaskFailure(taskId, terminalWatcherAbort.signal),
    ]);
  } finally {
    terminalWatcherAbort.abort();
  }
  const explanation = page.getByTestId('work-order-explanation');
  await explanation.waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('heading', { name: '小纬说明', exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  if (await statusCard.getAttribute('data-read-only') !== 'true') throw new Error('served WorkOrderStatusCard is not marked read-only');
  if (!await statusCard.getByText('只读', { exact: true }).isVisible()) throw new Error('served WorkOrderStatusCard omitted its read-only badge');
  if (await workflowSteps.count() !== 6) throw new Error('served UI changed the frozen six-node Workflow after execution');
  const completedSteps = await workflowSteps.allTextContents();
  expectedSteps.forEach((step, index) => {
    const text = completedSteps[index];
    if (text === undefined || !text.includes(step) || !text.includes('completed')) {
      throw new Error(`served Workflow node ${step} did not reach completed`);
    }
  });
  await page.screenshot({ path: `${evidenceDirectory}/work-order-completed.png`, fullPage: true });
  await chmod(`${evidenceDirectory}/work-order-completed.png`, 0o600);

  const snapshot = await requestJson(`/api/business-tasks/${encodeURIComponent(taskId)}`);
  assertExactKeys(snapshot, [
    'schemaVersion', 'recordVariant', 'taskId', 'conversationId', 'capabilityId', 'status', 'inputRef',
    'workflowVersionId', 'workflowHash', 'workflow', 'approval', 'connectorQuerySpecHash', 'result',
    'createdAt', 'updatedAt',
  ], 'Gate A.3 task snapshot');
  assertNoInternalProjection(snapshot);
  if (snapshot.status !== 'completed'
    || snapshot.schemaVersion !== 'gate-a3-public-task-snapshot/1'
    || snapshot.recordVariant !== 'business-task.work-order.live/1'
    || snapshot.taskId !== taskId
    || snapshot.result?.kind !== 'work_order_status'
    || snapshot.result.card?.schemaVersion !== 'WorkOrderStatusCard/1'
    || snapshot.result.card?.workOrderRef !== 'WO-GATE-A3-READABLE'
    || snapshot.result.card?.readOnly !== true
    || snapshot.result.explanation?.schemaVersion !== 'work-order.explanation/1'
    || snapshot.workflow?.steps?.length !== 6
    || snapshot.workflow.steps.some((step, index) => step.id !== expectedSteps[index] || step.status !== 'completed')) {
    throw new Error(`Gate A.3 real Work Order flow did not complete with the strict public result: ${JSON.stringify(snapshot)}`);
  }
  const expectedPublicSummary = `工单 ${snapshot.result.card.workOrderRef} 当前状态为“${snapshot.result.card.status}”；${snapshot.result.card.progressPct === null
    ? '基于已验证数量，确定性进度暂不可计算。'
    : `基于已验证数量，确定性进度为 ${String(snapshot.result.card.progressPct)}%。`}`;
  if (snapshot.result.explanation.summary !== expectedPublicSummary) {
    throw new Error('Gate A.3 public explanation summary is not the deterministic server projection');
  }

  verificationStage = 'refetching_public_evidence';
  const publicEvidenceIds = [...new Set(Object.values(snapshot.result.card.evidenceRefs))];
  if (publicEvidenceIds.length !== 4) {
    throw new Error(`WorkOrderStatusCard did not retain the exact four unique public Evidence references: ${JSON.stringify(publicEvidenceIds)}`);
  }
  const stableEvidence = new Map();
  for (let round = 1; round <= 5; round += 1) {
    for (const evidenceId of publicEvidenceIds) {
      const projection = await requestJson(`/api/evidence/${encodeURIComponent(evidenceId)}`);
      assertExactKeys(projection, [
        'id', 'kind', 'fieldName', 'value', 'sourceRevision', 'sourceAsOf', 'dataClass', 'readOnly',
      ], `Gate A.3 public Evidence ${evidenceId}`);
      assertNoInternalProjection(projection);
      if (projection.id !== evidenceId || projection.kind !== 'connector_snapshot_field'
        || projection.readOnly !== true) {
        throw new Error(`Gate A.3 public Evidence ${evidenceId} did not retain its strict read-only identity`);
      }
      const canonicalProjection = JSON.stringify(projection);
      const previous = stableEvidence.get(evidenceId);
      if (previous !== undefined && previous !== canonicalProjection) {
        throw new Error(`Gate A.3 public Evidence ${evidenceId} drifted during refetch round ${String(round)}`);
      }
      stableEvidence.set(evidenceId, canonicalProjection);
    }
  }
  const evidenceProjections = [...stableEvidence.values()].map((value) => JSON.parse(value));
  if (new Set(evidenceProjections.map((projection) => projection.sourceRevision)).size !== 1
    || new Set(evidenceProjections.map((projection) => projection.sourceAsOf)).size !== 1) {
    throw new Error('Gate A.3 public Evidence references did not resolve to one immutable source identity');
  }
  publicEvidenceReadSummary = {
    uniqueReferenceCount: publicEvidenceIds.length,
    refetchRounds: 5,
    stableProjectionCount: stableEvidence.size,
    oneSourceRevision: true,
    oneSourceAsOf: true,
  };

  verificationStage = 'reloading_completed_task';
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByTestId('work-order-status-card').waitFor({ state: 'visible', timeout: 30_000 });
  const reloadedSnapshot = await requestJson(`/api/business-tasks/${encodeURIComponent(taskId)}`);
  if (JSON.stringify(reloadedSnapshot) !== JSON.stringify(snapshot)) {
    throw new Error('served UI reload did not recover the identical immutable Work Order task/result');
  }
  await page.screenshot({ path: `${evidenceDirectory}/work-order-reloaded.png`, fullPage: true });
  await chmod(`${evidenceDirectory}/work-order-reloaded.png`, 0o600);
  zeroWriteResult = await finishZeroWriteOracle(zeroWriteOracle);
  verificationStage = 'validating_authority_correlation';
  authorityCorrelation = await databaseCorrelation(taskId, authority, disposablePostgresIdentity);
  verificationStage = 'validating_gearjob_zero_write';
  if (zeroWriteResult.mariaMutatingStatementCount !== 0
    || zeroWriteResult.redisMutatingCommandCount !== 0
    || !zeroWriteResult.mariaStateUnchanged
    || !zeroWriteResult.redisStateUnchanged) {
    throw new Error('fresh served Work Order run violated the GearJob zero-write oracle');
  }

  verificationStage = 'validating_public_projection';
  assertNoSensitiveWorkOrderProjection({
    visibleText: await page.locator('body').innerText(),
    serializedDom: await page.content(),
  });
  if (blockedBrowserRequests.length > 0) {
    throw new Error(`served UI attempted requests outside its Web origin: ${JSON.stringify(blockedBrowserRequests)}`);
  }
  if (pageErrors.length > 0) throw new Error(`served UI raised browser errors: ${JSON.stringify(pageErrors)}`);

  verificationStage = 'revoking_public_evidence_source';
  const revocationEvidenceId = publicEvidenceIds[0];
  if (revocationEvidenceId === undefined) throw new Error('Gate A.3 revocation requires one public Evidence reference');
  const revocationRequest = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `gate-a3-revoke-${verificationRunId}` },
    body: JSON.stringify({ reasonCode: 'user_requested' }),
  };
  const firstRevocation = await requestJson(
    `/api/evidence/${encodeURIComponent(revocationEvidenceId)}/revoke`, revocationRequest,
  );
  const replayedRevocation = await requestJson(
    `/api/evidence/${encodeURIComponent(revocationEvidenceId)}/revoke`, revocationRequest,
  );
  if (JSON.stringify(firstRevocation) !== '{"revoked":true}'
    || JSON.stringify(replayedRevocation) !== '{"revoked":true}') {
    throw new Error('Gate A.3 Evidence source revocation did not return the strict idempotent response');
  }
  for (const evidenceId of publicEvidenceIds) {
    const unavailableEvidence = await requestExpectedStatus(
      `/api/evidence/${encodeURIComponent(evidenceId)}`, 404,
    );
    if (unavailableEvidence?.error?.code !== 'EVIDENCE_NOT_FOUND') {
      throw new Error(`revoked Evidence ${evidenceId} did not fail closed with EVIDENCE_NOT_FOUND`);
    }
  }
  const unavailableTask = await requestExpectedStatus(
    `/api/business-tasks/${encodeURIComponent(taskId)}`, 404,
  );
  if (unavailableTask?.error?.code !== 'TASK_NOT_FOUND') {
    throw new Error('revoked Work Order task did not fail closed with TASK_NOT_FOUND');
  }
  revocationCorrelation = await databaseRevocationCorrelation(taskId, disposablePostgresIdentity);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByTestId('route-not-found').waitFor({ state: 'visible', timeout: 30_000 });
  if (await page.getByTestId('work-order-status-card').count() !== 0) {
    throw new Error('served UI retained the WorkOrderStatusCard after source revocation');
  }
  await page.screenshot({ path: `${evidenceDirectory}/work-order-revoked.png`, fullPage: true });
  await chmod(`${evidenceDirectory}/work-order-revoked.png`, 0o600);
  const summary = {
    schemaVersion: 'geneway-gate-a3-served-ui-verification/1',
    ok: true,
    verificationRunId,
    authorityArtifactId: authority.artifactId,
    approvedPreflightDigest: authority.approvedPreflightDigest,
    admissionRootKeyId: authority.admissionRootKeyId,
    admissionSignatureVerified: authority.admissionSignatureVerified,
    servedUi: {
      entryPath: '/work-orders/new',
      finalPath: taskUrl.pathname,
      browserEngine: 'chromium',
      externalRequestCount: 0,
      httpAndWebSocketSameOrigin: true,
      sensitiveDomFindingCount: 0,
      screenshotDirectory: evidenceDirectory,
      redactedSubprocessLog: subprocessLogPath,
      reloadRecoveredIdenticalTask: true,
      sourceRevocationRenderedNotFound: true,
    },
    taskId: snapshot.taskId,
    workOrderRef: snapshot.result.card.workOrderRef,
    status: snapshot.result.card.status,
    progressPct: snapshot.result.card.progressPct,
    readOnly: snapshot.result.card.readOnly,
    workflowNodeCount: snapshot.workflow.steps.length,
    customerVisibleAuthor: '小纬',
    authorityCorrelation: {
      controlPlaneTaskCount: authorityCorrelation.taskCount,
      approvedApprovalCount: authorityCorrelation.approvedCount,
      completedWorkflowStepCount: authorityCorrelation.completedStepCount,
      completedConnectorInvocationCount: authorityCorrelation.connectorInvocationCount,
      connectorSourceSnapshotCount: authorityCorrelation.sourceSnapshotCount,
      completedModelInvocationCount: authorityCorrelation.modelInvocationCount,
      evidenceCount: authorityCorrelation.evidenceCount,
      wholeEvidenceCount: authorityCorrelation.wholeEvidenceCount,
      fieldEvidenceCount: authorityCorrelation.fieldEvidenceCount,
      distinctEvidenceFieldCount: authorityCorrelation.distinctEvidenceFieldCount,
      publishedResultCount: authorityCorrelation.resultCount,
      currentAuthorityCount: authorityCorrelation.currentAuthorityCount,
      taskCurrentAuthorityCount: authorityCorrelation.taskCurrentAuthorityCount,
    },
    publicEvidence: publicEvidenceReadSummary,
    sourceRevocation: {
      requestReplayWasIdempotent: true,
      allPublicEvidenceReturned404: true,
      taskReturned404: true,
      retainedImmutableEvidenceCount: revocationCorrelation.retainedEvidenceCount,
      retainedImmutableResultCount: revocationCorrelation.retainedResultCount,
      retainedCompletedTaskCount: revocationCorrelation.retainedCompletedTaskCount,
      appendOnlyRevocationCount: revocationCorrelation.sourceRevocationCount,
    },
    zeroWrite: zeroWriteResult,
  };
  await writeFile(subprocessLogPath, redactedSubprocessLog(), { mode: 0o600 });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  if (zeroWriteOracle !== undefined && zeroWriteResult === undefined) {
    zeroWriteResult = await finishZeroWriteOracle(zeroWriteOracle).catch(() => undefined);
  }
  if (page !== undefined) {
    await page.screenshot({ path: `${evidenceDirectory}/work-order-failure.png`, fullPage: true }).catch(() => undefined);
    await chmod(`${evidenceDirectory}/work-order-failure.png`, 0o600).catch(() => undefined);
  }
  const stackOutput = logs.join('');
  const failureSnapshot = browserTaskId === undefined
    ? null
    : await requestJson(`/api/business-tasks/${encodeURIComponent(browserTaskId)}`).catch(() => null);
  const failureSteps = failureSnapshot !== null && typeof failureSnapshot === 'object'
    && 'workflow' in failureSnapshot && failureSnapshot.workflow !== null
    && typeof failureSnapshot.workflow === 'object' && 'steps' in failureSnapshot.workflow
    && Array.isArray(failureSnapshot.workflow.steps) ? failureSnapshot.workflow.steps : [];
  const runningStep = failureSteps.find((step) => step !== null && typeof step === 'object'
    && 'status' in step && step.status === 'running');
  const failedStep = failureSteps.find((step) => step !== null && typeof step === 'object'
    && 'status' in step && step.status === 'failed');
  const completedWorkflowSteps = failureSteps.filter((step) => step !== null && typeof step === 'object'
    && 'status' in step && step.status === 'completed').length;
  if (runningStep !== undefined && 'id' in runningStep && typeof runningStep.id === 'string') {
    verificationStage = `waiting_for_publication.${runningStep.id}`;
  }
  if (failedStep !== undefined && 'id' in failedStep && typeof failedStep.id === 'string') {
    verificationStage = `waiting_for_publication.${failedStep.id}.failed`;
  }
  const publicTaskFailure = servedTaskTerminalFailure(failureSnapshot);
  const modelErrorMatch = stackOutput.match(/"errorClass"\s*:\s*"([A-Z0-9_]+)"/u);
  const controlPlaneCodeMatch = stackOutput.match(/"code"\s*:\s*"([A-Z0-9_]+)"/u);
  const failureClass = (zeroWriteResult?.mariaMutatingStatementCount ?? 0) > 0
    || (zeroWriteResult?.redisMutatingCommandCount ?? 0) > 0
    ? 'GEARJOB_ZERO_WRITE_VIOLATION'
    : error instanceof ServedTaskTerminalError
      ? 'SERVED_TASK_FAILED'
      : stackOutput.includes('Worker exited unexpectedly')
        ? 'WORKER_EXITED_UNEXPECTEDLY'
        : stackOutput.includes('Control Plane exited unexpectedly')
          ? 'CONTROL_PLANE_EXITED_UNEXPECTEDLY'
          : error instanceof Error && error.name === 'TimeoutError'
            ? 'SERVED_UI_TIMEOUT'
            : 'GATE_A3_VERIFICATION_FAILED';
  const failureSummary = {
    schemaVersion: 'geneway-gate-a3-served-ui-verification/1',
    ok: false,
    verificationRunId,
    authorityArtifactId: authority?.artifactId ?? null,
    approvedPreflightDigest: authority?.approvedPreflightDigest ?? null,
    internalValidationAdmissionDigest: authority?.internalValidationAdmissionDigest ?? null,
    admissionRootKeyId: authority?.admissionRootKeyId ?? null,
    admissionSignatureVerified: authority?.admissionSignatureVerified ?? false,
    stage: verificationStage,
    failure: {
      class: failureClass,
      browserErrorName: error instanceof Error ? error.name : 'UnknownError',
      modelGatewayHttpStatus: /"statusCode"\s*:\s*502/u.test(stackOutput) ? 502 : null,
      modelGatewayErrorClass: publicTaskFailure?.code.startsWith('MODEL_') === true
        ? publicTaskFailure.code
        : modelErrorMatch?.[1] ?? 'NOT_EMITTED_IN_REDACTED_PROCESS_LOG',
      controlPlaneCommandHttpStatus: /gate-a3-work-order-commands[\s\S]{0,1000}"statusCode"\s*:\s*500/u.test(stackOutput)
        ? 500 : null,
      controlPlaneRedactedErrorCode: publicTaskFailure?.code
        ?? controlPlaneCodeMatch?.[1] ?? 'NOT_EMITTED_IN_REDACTED_PROCESS_LOG',
      workerCommand: stackOutput.includes('gate_a3_work_order_terminal') ? 'gate_a3_work_order_terminal' : null,
      workerStep: failedStep !== undefined && 'id' in failedStep && typeof failedStep.id === 'string'
        ? failedStep.id
        : runningStep !== undefined && 'id' in runningStep && typeof runningStep.id === 'string'
          ? runningStep.id : null,
    },
    servedUi: {
      entryPath: '/work-orders/new',
      browserEngine: 'chromium',
      taskId: browserTaskId ?? null,
      approvalCompleted: failureSnapshot !== null && typeof failureSnapshot === 'object'
        && 'approval' in failureSnapshot && failureSnapshot.approval !== null
        && typeof failureSnapshot.approval === 'object' && 'status' in failureSnapshot.approval
        && failureSnapshot.approval.status === 'approved',
      completedWorkflowSteps,
      runningWorkflowStep: runningStep !== undefined && 'id' in runningStep && typeof runningStep.id === 'string'
        ? runningStep.id : null,
      zeroWrite: zeroWriteResult ?? null,
      authorityCorrelation: authorityCorrelation ?? null,
    },
    artifacts: {
      awaitingApprovalScreenshot: `${evidenceDirectory}/work-order-awaiting-approval.png`,
      failureScreenshot: `${evidenceDirectory}/work-order-failure.png`,
      redactedSubprocessLog: subprocessLogPath,
    },
  };
  await writeFile(subprocessLogPath, redactedSubprocessLog(), { mode: 0o600 }).catch(() => undefined);
  await writeFile(summaryPath, `${JSON.stringify(failureSummary, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
  process.stderr.write(`${JSON.stringify(failureSummary)}\n`);
  const tail = redactedSubprocessLog().slice(-8_000);
  throw new Error(`Gate A.3 verification failed. Last stack output:\n${tail}`, { cause: error });
} finally {
  await browser?.close();
  if (child !== undefined) await stopStack(child);
}
