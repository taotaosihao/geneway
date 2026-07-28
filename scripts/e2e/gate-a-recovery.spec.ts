import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gateA3PublicTaskSnapshotSchema, type GateA3PublicTaskSnapshot } from '@geneway/contracts';
import pg from 'pg';
import {
  finishZeroWriteOracle,
  startZeroWriteOracle,
  type GearJobZeroWriteOracle,
} from './gearjob-zero-write-oracle.js';

const { Pool } = pg;
const execFileAsync = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const runId = required('GENEWAY_RUN_ID');
const databaseUrl = required('GENEWAY_E2E_DATABASE_URL');
if (process.env.GENEWAY_GATE_A_LIVE !== '1' || process.env.GENEWAY_GATE_A3_WORK_ORDER_ENABLED !== '1'
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
  throw new Error('gate-a-recovery requires the disposable Gate A live harness');
}

const controlPlaneSupervisorPort = Number(required('GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT'));
const workerSupervisorPort = Number(required('GENEWAY_WORKER_HEALTH_PORT'));
const connectorSupervisorPort = Number(required('GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_PORT'));
const workerTokenFile = required('GENEWAY_WORKER_TOKEN_FILE');
const connectorSupervisorTokenFile = required('GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_TOKEN_FILE');
if ([controlPlaneSupervisorPort, workerSupervisorPort, connectorSupervisorPort]
  .some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
  throw new Error('Gate A recovery supervisor ports are invalid');
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const artifactRoot = `/tmp/geneway-runs/${runId}`;
const evidenceDirectory = `${artifactRoot}/gate-a`;
const receiverPath = '/api/method/gearjob.api.work_order.get_work_order_status';
const workOrderRef = 'WO-GATE-A3-READABLE';
const receiverContainer = 'gearjob_dev-frappe-1';

type ProcessIdentity = Readonly<{ pid: number; procStartTicks: string; generation: number }>;
type WorkerIdentity = Readonly<{
  pid: number;
  procStartTicks: string;
  workerInstanceId: string;
  generation: number;
}>;

async function dockerOutput(arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', [...arguments_], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return `${result.stdout}${result.stderr}`.trim();
}

async function supervisor(
  port: number,
  tokenFile: string,
  route: string,
  body?: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<Response> {
  const token = (await readFile(tokenFile, 'utf8')).trim();
  return fetch(`http://127.0.0.1:${String(port)}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(2_000),
  });
}

async function waitForHealth(
  port: number,
  tokenFile: string,
  expectedStatus: 200 | 503,
  previousGeneration?: number,
): Promise<Readonly<Record<string, unknown>>> {
  let observed: Readonly<Record<string, unknown>> = {};
  await expect.poll(async () => {
    try {
      const response = await supervisor(port, tokenFile, '/health', undefined, 'GET');
      observed = await response.json() as Readonly<Record<string, unknown>>;
      if (response.status !== expectedStatus) return false;
      return previousGeneration === undefined || Number(observed.generation) > previousGeneration;
    } catch {
      return false;
    }
  }, { timeout: 30_000, intervals: [25, 50, 100, 250] }).toBe(true);
  return observed;
}

async function resumeUntilAccepted(port: number, tokenFile: string, route: string): Promise<Response> {
  let accepted: Response | undefined;
  await expect.poll(async () => {
    try {
      accepted = await supervisor(port, tokenFile, route, {});
      return accepted.status;
    } catch {
      return 0;
    }
  }, { timeout: 15_000, intervals: [25, 50, 100] }).toBe(202);
  if (accepted === undefined) throw new Error('Recovery resume response is missing');
  return accepted;
}

async function readReceipt<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(`${artifactRoot}/process-boundaries/${name}.json`, 'utf8')) as T;
}

async function createAndCompleteTask(
  page: Page,
  request: APIRequestContext,
): Promise<Readonly<{ taskId: string; snapshot: GateA3PublicTaskSnapshot }>> {
  const response = await page.goto('/work-orders/new', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('work-order-create')).toBeVisible();
  await page.getByTestId('work-order-ref').fill(workOrderRef);
  await page.getByRole('button', { name: '创建查询任务', exact: true }).click();
  await expect(page).toHaveURL(/\/work-orders\/task_[A-Za-z0-9._:-]+$/u);
  const taskId = decodeURIComponent(new URL(page.url()).pathname.slice('/work-orders/'.length));
  await expect(page.getByTestId('work-order-workflow').locator('li')).toHaveCount(6);
  await page.getByTestId('work-order-approve-execute').click();
  await expect(page.getByTestId('work-order-status-card')).toBeVisible({ timeout: 150_000 });
  const taskResponse = await request.get(`/api/business-tasks/${encodeURIComponent(taskId)}`);
  expect(taskResponse.ok()).toBe(true);
  const snapshot = gateA3PublicTaskSnapshotSchema.parse(await taskResponse.json());
  expect(snapshot).toMatchObject({ taskId, status: 'completed',
    result: { kind: 'work_order_status', card: { workOrderRef, readOnly: true } } });
  return { taskId, snapshot };
}

async function immutableTaskAuthority(taskId: string): Promise<Readonly<{
  text: string;
  value: Readonly<Record<string, unknown>>;
}>> {
  const selected = await pool.query<{ state_text: string }>(`SELECT jsonb_build_object(
      'task',jsonb_build_object('id',task.id,'status',task.status,'result',task.result,
        'resultRecordVariant',task.result_record_variant,'aggregateVersion',task.aggregate_version,
        'executionVersion',task.execution_version,'currentExecutionAttemptId',task.current_execution_attempt_id,
        'executionFencingToken',task.execution_fencing_token,'workflowVersionId',task.workflow_version_id,
        'workflowHash',task.workflow_hash,'authorityDigest',task.gate_a3_authority_digest),
      'querySpec',(SELECT jsonb_build_object('id',spec.id,'specHash',spec.spec_hash,
        'releaseRecordId',spec.release_record_id,'approvedPreflightDigest',spec.approved_preflight_digest)
        FROM gate_a3_connector_query_specs spec WHERE spec.tenant_id=task.tenant_id AND spec.business_task_id=task.id),
      'attempts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',attempt.id,'status',attempt.status,
        'fencingToken',attempt.fencing_token,'workerInstanceId',attempt.worker_instance_id) ORDER BY attempt.id),'[]'::jsonb)
        FROM execution_attempts attempt WHERE attempt.tenant_id=task.tenant_id AND attempt.business_task_id=task.id),
      'steps',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',step.step_id,'status',step.status)
        ORDER BY step.step_id),'[]'::jsonb) FROM business_task_steps step
        WHERE step.tenant_id=task.tenant_id AND step.business_task_id=task.id),
      'connector',(SELECT jsonb_build_object('id',invocation.id,'status',invocation.status,
        'effectId',invocation.effect_id,'specHash',invocation.connector_query_spec_hash,
        'sourceRevision',invocation.source_revision,'responseHash',invocation.response_canonical_hash)
        FROM gate_a3_connector_invocations invocation
        WHERE invocation.tenant_id=task.tenant_id AND invocation.business_task_id=task.id),
      'snapshot',(SELECT jsonb_build_object('id',snapshot.id,'invocationId',snapshot.connector_invocation_id,
        'effectId',snapshot.effect_id,'payloadHash',snapshot.canonical_payload_hash,
        'sourceRevision',snapshot.source_revision) FROM gate_a3_connector_source_snapshots snapshot
        WHERE snapshot.tenant_id=task.tenant_id AND snapshot.business_task_id=task.id),
      'evidence',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',evidence.id,'snapshotId',evidence.connector_source_snapshot_id,
        'invocationId',evidence.connector_invocation_id,'effectId',evidence.effect_id,'kind',evidence.locator_kind,
        'field',evidence.field_name,'fieldHash',evidence.canonical_field_hash,'payloadHash',evidence.canonical_payload_hash,
        'accessible',evidence.accessible) ORDER BY evidence.id),'[]'::jsonb)
        FROM gate_a3_connector_evidence evidence WHERE evidence.tenant_id=task.tenant_id
          AND evidence.business_task_id=task.id),
      'model',(SELECT jsonb_build_object('id',model.id,'status',model.status,'snapshotId',model.connector_source_snapshot_id,
        'effectId',model.effect_id,'inputDigest',model.input_digest,'receiptDigest',model.receipt_digest)
        FROM gate_a3_model_invocations model WHERE model.tenant_id=task.tenant_id AND model.business_task_id=task.id),
      'explanation',(SELECT jsonb_build_object('id',explanation.id,'modelInvocationId',explanation.model_invocation_id,
        'snapshotId',explanation.connector_source_snapshot_id,'hash',explanation.explanation_hash)
        FROM gate_a3_work_order_explanations explanation
        WHERE explanation.tenant_id=task.tenant_id AND explanation.business_task_id=task.id),
      'result',(SELECT jsonb_build_object('id',result.id,'snapshotId',result.connector_source_snapshot_id,
        'invocationId',result.connector_invocation_id,'explanationId',result.explanation_id,
        'effectId',result.effect_id,'cardHash',result.card_hash,'publicResultHash',result.public_result_hash)
        FROM gate_a3_work_order_results result WHERE result.tenant_id=task.tenant_id AND result.business_task_id=task.id),
      'release',(SELECT jsonb_build_object('releaseId',active.release_id,'pointerVersion',active.pointer_version,
        'activationRecordId',active.activation_record_id) FROM capability_active_releases active
        WHERE active.tenant_id=task.tenant_id AND active.capability_id='production.work-order-status.v1'),
      'authority',(SELECT jsonb_build_object('stageId',current.stage_id,'pointerVersion',current.pointer_version,
        'state',stage.state,'authorityDigest',stage.authority_digest) FROM gate_a3_authority_current current
        JOIN gate_a3_authority_stages stage ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
        WHERE current.tenant_id=task.tenant_id AND current.capability_id='production.work-order-status.v1'),
      'events',(SELECT jsonb_build_object('count',count(*),'maxCursor',max(event.cursor))
        FROM business_task_events event WHERE event.tenant_id=task.tenant_id AND event.business_task_id=task.id)
    )::text state_text FROM business_tasks task
    WHERE task.tenant_id='tenant_local' AND task.id=$1
      AND task.record_variant='business-task.work-order.live/1'`, [taskId]);
  const text = selected.rows[0]?.state_text;
  if (text === undefined) throw new Error('Gate A recovery task authority is missing');
  return { text, value: JSON.parse(text) as Readonly<Record<string, unknown>> };
}

function receiverRequests(logs: string): readonly Readonly<{ method: string; path: string; status: number }>[] {
  return logs.split('\n').flatMap((line) => {
    const match = line.match(/"([A-Z]+) ([^ ]+) HTTP\/1\.[01]" (\d{3})/u);
    return match?.[1] === undefined || match[2] === undefined || match[3] === undefined
      ? [] : [{ method: match[1], path: match[2], status: Number(match[3]) }];
  });
}

function exactReceiverRequests(logs: string): readonly Readonly<{ method: string; path: string; status: number }>[] {
  return receiverRequests(logs).filter((entry) => {
    const url = new URL(entry.path, 'http://dev.localhost');
    return entry.method === 'GET' && entry.status === 200 && url.pathname === receiverPath
      && url.searchParams.get('work_order_ref') === workOrderRef
      && [...url.searchParams.keys()].length === 1;
  });
}

test.afterAll(async () => pool.end());

test('Gate A 单工单在 Connector、Control Plane 与 Worker 真实恢复后保持单一终态并可继续新任务', async ({ page, request }) => {
  test.setTimeout(420_000);
  let oracle: GearJobZeroWriteOracle | undefined;
  let connectorPaused = false;
  let controlPlanePaused = false;
  let workerPaused = false;
  const externalBrowserRequests: string[] = [];
  const webOrigin = `http://localhost:${required('GENEWAY_WEB_PORT')}`;
  page.on('request', (observed) => {
    const target = new URL(observed.url());
    if ((target.protocol === 'http:' || target.protocol === 'https:') && target.origin !== webOrigin) {
      externalBrowserRequests.push(target.origin);
    }
  });
  page.on('websocket', (socket) => {
    const target = new URL(socket.url());
    const origin = `${target.protocol === 'ws:' ? 'http:' : 'https:'}//${target.host}`;
    if (origin !== webOrigin) externalBrowserRequests.push(origin);
  });

  try {
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await chmod(evidenceDirectory, 0o700);
    oracle = await startZeroWriteOracle();
    const receiverSince = new Date().toISOString();

    const first = await createAndCompleteTask(page, request);
    const firstPublicBefore = JSON.stringify(first.snapshot);
    const firstAuthorityBefore = await immutableTaskAuthority(first.taskId);
    const firstRequestsBeforeRecovery = exactReceiverRequests(
      await dockerOutput(['logs', '--since', receiverSince, receiverContainer]),
    );
    expect(firstRequestsBeforeRecovery).toHaveLength(1);

    const connectorBefore = await readReceipt<ProcessIdentity>('connector-gateway');
    const connectorKilled = await supervisor(connectorSupervisorPort, connectorSupervisorTokenFile,
      '/test/kill-connector-gateway', { ...connectorBefore, restart: false });
    expect(connectorKilled.status, await connectorKilled.text()).toBe(202);
    connectorPaused = true;
    await waitForHealth(connectorSupervisorPort, connectorSupervisorTokenFile, 503);
    expect((await resumeUntilAccepted(connectorSupervisorPort, connectorSupervisorTokenFile,
      '/test/resume-connector-gateway')).status).toBe(202);
    connectorPaused = false;
    const connectorAfter = await waitForHealth(connectorSupervisorPort, connectorSupervisorTokenFile, 200,
      connectorBefore.generation);

    const controlPlaneBefore = await readReceipt<ProcessIdentity>('control-plane');
    const controlPlaneKilled = await supervisor(controlPlaneSupervisorPort, workerTokenFile,
      '/test/kill-control-plane', { ...controlPlaneBefore, restart: false });
    expect(controlPlaneKilled.status, await controlPlaneKilled.text()).toBe(202);
    controlPlanePaused = true;
    await waitForHealth(controlPlaneSupervisorPort, workerTokenFile, 503);
    await expect.poll(async () => page.evaluate(async () => {
      try { return (await fetch('/api/capabilities/production.work-order-status.v1', { cache: 'no-store' })).ok; }
      catch { return false; }
    }), { timeout: 10_000, intervals: [25, 50, 100] }).toBe(false);
    expect((await resumeUntilAccepted(controlPlaneSupervisorPort, workerTokenFile,
      '/test/resume-control-plane')).status).toBe(202);
    controlPlanePaused = false;
    const controlPlaneAfter = await waitForHealth(controlPlaneSupervisorPort, workerTokenFile, 200,
      controlPlaneBefore.generation);

    const workerBefore = await readReceipt<WorkerIdentity>('worker');
    const workerKilled = await supervisor(workerSupervisorPort, workerTokenFile,
      '/test/kill-worker', { ...workerBefore, restart: false });
    expect(workerKilled.status, await workerKilled.text()).toBe(202);
    workerPaused = true;
    await waitForHealth(workerSupervisorPort, workerTokenFile, 503);
    expect((await resumeUntilAccepted(workerSupervisorPort, workerTokenFile,
      '/test/resume-worker')).status).toBe(202);
    workerPaused = false;
    await waitForHealth(workerSupervisorPort, workerTokenFile, 200, workerBefore.generation);
    await expect.poll(async () => (await readReceipt<WorkerIdentity>('worker')).workerInstanceId,
      { timeout: 30_000, intervals: [25, 50, 100] }).not.toBe(workerBefore.workerInstanceId);
    const workerAfter = await readReceipt<WorkerIdentity>('worker');
    expect(workerAfter.generation).toBeGreaterThan(workerBefore.generation);

    const recoveredResponse = await page.goto(`/work-orders/${encodeURIComponent(first.taskId)}`,
      { waitUntil: 'domcontentloaded' });
    expect(recoveredResponse?.status()).toBe(200);
    await expect(page.getByTestId('work-order-status-card')).toBeVisible();
    const firstPublicAfterResponse = await request.get(`/api/business-tasks/${encodeURIComponent(first.taskId)}`);
    expect(firstPublicAfterResponse.ok()).toBe(true);
    const firstPublicAfter = gateA3PublicTaskSnapshotSchema.parse(await firstPublicAfterResponse.json());
    expect(JSON.stringify(firstPublicAfter)).toBe(firstPublicBefore);
    const firstAuthorityAfter = await immutableTaskAuthority(first.taskId);
    expect(firstAuthorityAfter.text).toBe(firstAuthorityBefore.text);
    const firstRequestsAfterRecovery = exactReceiverRequests(
      await dockerOutput(['logs', '--since', receiverSince, receiverContainer]),
    );
    expect(firstRequestsAfterRecovery).toHaveLength(1);

    const second = await createAndCompleteTask(page, request);
    expect(second.taskId).not.toBe(first.taskId);
    const secondAuthority = await immutableTaskAuthority(second.taskId);
    const firstAuthorityProjection = firstAuthorityAfter.value;
    const secondAuthorityProjection = secondAuthority.value;
    const firstTaskAuthority = firstAuthorityProjection.task as Readonly<Record<string, unknown>>;
    const secondTaskAuthority = secondAuthorityProjection.task as Readonly<Record<string, unknown>>;
    const firstQuerySpec = firstAuthorityProjection.querySpec as Readonly<Record<string, unknown>>;
    const secondQuerySpec = secondAuthorityProjection.querySpec as Readonly<Record<string, unknown>>;
    const firstRelease = firstAuthorityProjection.release as Readonly<Record<string, unknown>>;
    const firstAuthority = firstAuthorityProjection.authority as Readonly<Record<string, unknown>>;
    expect(secondAuthorityProjection.release).toEqual(firstAuthorityProjection.release);
    expect(secondAuthorityProjection.authority).toEqual(firstAuthorityProjection.authority);
    expect(firstRelease.releaseId).toBe('release_production_work_order_status_v1_internal');
    expect(firstAuthority.state).toBe('internal');
    expect(firstQuerySpec.releaseRecordId).toBe(firstRelease.releaseId);
    expect(firstTaskAuthority.authorityDigest).toBe(firstAuthority.authorityDigest);
    expect(secondQuerySpec.releaseRecordId).toBe(firstQuerySpec.releaseRecordId);
    expect(secondQuerySpec.approvedPreflightDigest).toBe(firstQuerySpec.approvedPreflightDigest);
    expect(secondTaskAuthority.authorityDigest).toBe(firstTaskAuthority.authorityDigest);

    const receiverLog = await dockerOutput(['logs', '--since', receiverSince, receiverContainer]);
    const observedReceiverRequests = receiverRequests(receiverLog);
    const actualRequests = exactReceiverRequests(receiverLog);
    expect(actualRequests).toHaveLength(2);
    const unexpectedReceiverRequests = observedReceiverRequests.filter((entry) => {
      const url = new URL(entry.path, 'http://dev.localhost');
      return entry.method !== 'GET' || entry.status !== 200 || url.pathname !== receiverPath
        || url.searchParams.get('work_order_ref') !== workOrderRef
        || [...url.searchParams.keys()].length !== 1;
    });
    expect(unexpectedReceiverRequests).toEqual([]);

    const zeroWrite = await finishZeroWriteOracle(oracle);
    oracle = undefined;
    expect(zeroWrite).toMatchObject({
      mariaMutatingStatementCount: 0,
      mariaStateUnchanged: true,
      redisMutatingCommandCount: 0,
      redisStateUnchanged: true,
    });
    expect(externalBrowserRequests).toEqual([]);
    const secretCanary = required('GENEWAY_E2E_SECRET_CANARY');
    expect(secretCanary).toMatch(/^geneway-secret-canary-[a-f0-9]{48}$/u);
    const publicSurface = `${await page.content()}\n${JSON.stringify(firstPublicAfter)}\n${JSON.stringify(second.snapshot)}`;
    expect(publicSurface).not.toContain(secretCanary);
    expect(publicSurface).not.toMatch(/authorization|bearer\s+|apiSecret|apiKey|credential|receipt|Connector Gateway|\/api\/method\/gearjob/iu);

    const firstEvidence = firstAuthorityProjection.evidence as readonly unknown[];
    const summary = {
      schemaVersion: 'geneway-gate-a-recovery/1',
      runId,
      passed: true,
      firstTask: {
        id: first.taskId,
        status: firstTaskAuthority.status,
        terminalAuthoritySha256: createHash('sha256').update(firstAuthorityAfter.text, 'utf8').digest('hex'),
        publicSnapshotIdentical: true,
        terminalPointerEvidenceIdentical: true,
        evidenceCount: firstEvidence.length,
      },
      processRecovery: {
        connectorGateway: { paused: true, resumed: true, initialGeneration: connectorBefore.generation,
          recoveredGeneration: Number(connectorAfter.generation) },
        controlPlane: { paused: true, resumed: true, restarted: true, initialGeneration: controlPlaneBefore.generation,
          recoveredGeneration: Number(controlPlaneAfter.generation), browserFailureObserved: true },
        worker: { paused: true, resumed: true, restarted: true, initialGeneration: workerBefore.generation,
          recoveredGeneration: workerAfter.generation, initialInstanceId: workerBefore.workerInstanceId,
          recoveredInstanceId: workerAfter.workerInstanceId },
      },
      releaseAuthority: {
        releaseRecordId: firstQuerySpec.releaseRecordId,
        activeReleaseId: firstRelease.releaseId,
        releasePointerVersion: firstRelease.pointerVersion,
        authorityDigest: firstTaskAuthority.authorityDigest,
        currentAuthorityDigest: firstAuthority.authorityDigest,
        authorityStageId: firstAuthority.stageId,
        authorityStageState: firstAuthority.state,
        authorityPointerVersion: firstAuthority.pointerVersion,
        secondTaskSameReleaseAndAuthority: true,
      },
      receiver: {
        origin: 'http://127.0.0.1:8100', hostHeader: 'dev.localhost', endpoint: receiverPath,
        method: 'GET', firstTaskRequestCountBeforeRecovery: firstRequestsBeforeRecovery.length,
        firstTaskRequestCountAfterRecovery: firstRequestsAfterRecovery.length,
        totalSuccessfulRequestCount: actualRequests.length, unexpectedRequestCount: unexpectedReceiverRequests.length,
      },
      zeroWrite,
      secondTask: { id: second.taskId, status: second.snapshot.status, succeededAfterRecovery: true },
      browser: { sameOriginOnly: true, reconnectFailureObserved: true, secretCanaryAbsent: true,
        internalCredentialOrRouteMaterialAbsent: true },
    };
    await writeFile(`${evidenceDirectory}/recovery-summary.json`, `${JSON.stringify(summary, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
    const oracleDirectory = `${artifactRoot}/secret-oracles`;
    await mkdir(oracleDirectory, { recursive: true, mode: 0o700 });
    await chmod(oracleDirectory, 0o700);
    await writeFile(`${oracleDirectory}/browser-public-boundary.json`, `${JSON.stringify({
      schemaVersion: 'geneway-browser-secret-oracle/1', checked: true,
      publicResponseAndDomClean: true, browserReconnectFaultInjected: true,
      canarySha256: createHash('sha256').update(secretCanary, 'utf8').digest('hex'),
      forbiddenMarkerClasses: ['isolated-process-canary', 'private-path', 'authority-env-name', 'token-field-name'],
    })}\n`, { flag: 'wx', mode: 0o600 });
  } finally {
    if (connectorPaused) await resumeUntilAccepted(connectorSupervisorPort, connectorSupervisorTokenFile,
      '/test/resume-connector-gateway').catch(() => undefined);
    if (controlPlanePaused) await resumeUntilAccepted(controlPlaneSupervisorPort, workerTokenFile,
      '/test/resume-control-plane').catch(() => undefined);
    if (workerPaused) await resumeUntilAccepted(workerSupervisorPort, workerTokenFile,
      '/test/resume-worker').catch(() => undefined);
    if (oracle !== undefined) await finishZeroWriteOracle(oracle).catch(() => undefined);
  }
});
