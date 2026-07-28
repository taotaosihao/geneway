import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { gateA3PublicTaskSnapshotSchema } from '@geneway/contracts';
import pg from 'pg';
import {
  finishZeroWriteOracle,
  startZeroWriteOracle,
  type GearJobZeroWriteOracle,
} from './gearjob-zero-write-oracle.js';

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const runId = process.env.GENEWAY_RUN_ID;
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
if (runId === undefined || databaseUrl === undefined || process.env.GENEWAY_GATE_A_LIVE !== '1'
  || process.env.GENEWAY_GATE_A3_WORK_ORDER_ENABLED !== '1'
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
  throw new Error('gate-a-work-order-status requires the disposable Gate A live harness');
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const evidenceDirectory = `/tmp/geneway-runs/${runId}/gate-a`;
const workOrderRef = 'WO-GATE-A3-READABLE';
const receiverPath = '/api/method/gearjob.api.work_order.get_work_order_status';
const receiverContainer = 'gearjob_dev-frappe-1';

async function dockerOutput(arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', [...arguments_], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return `${result.stdout}${result.stderr}`.trim();
}

function forbiddenBrowserPorts(): number[] {
  const names = [
    'GENEWAY_CONTROL_PLANE_PORT', 'GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT', 'GENEWAY_POSTGRES_PORT',
    'GENEWAY_S3_PORT', 'GENEWAY_STORAGE_ADAPTER_PORT', 'GENEWAY_RECONCILIATION_ADAPTER_PORT',
    'GENEWAY_WORKER_HEALTH_PORT', 'GENEWAY_MODEL_GATEWAY_PORT', 'GENEWAY_MODEL_GATEWAY_SUPERVISOR_PORT',
    'GENEWAY_CONNECTOR_GATEWAY_PORT', 'GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_PORT',
    'GENEWAY_GATE_A0_RELEASE_PORT', 'GENEWAY_GATE_A_RELEASE_PORT', 'GENEWAY_GATE_A3_RELEASE_PORT',
  ] as const;
  const ports = [...names.map((name) => Number(process.env[name])), 8_100];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('Gate A browser forbidden-port matrix is incomplete');
  }
  return [...new Set(ports)];
}

async function proveBrowserKernelDenials(page: Page): Promise<number> {
  const ports = forbiddenBrowserPorts();
  const results = await page.evaluate(async (targets) => Promise.all(targets.map(async (port) => {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/__geneway_browser_egress_probe__`, {
        cache: 'no-store', mode: 'no-cors', redirect: 'manual',
      });
      return { port, denied: false };
    } catch {
      return { port, denied: true };
    }
  })), ports);
  expect(results).toEqual(ports.map((port) => ({ port, denied: true })));
  return ports.length;
}

async function authorityCorrelation(taskId: string) {
  const joined = await pool.query<{
    task_id: string;
    workflow_version_id: string;
    workflow_hash: string;
    approval_id: string;
    approval_subject_digest: string;
    connector_query_spec_id: string;
    connector_query_spec_hash: string;
    release_record_id: string;
    approved_preflight_digest: string;
    gate_a3_authority_digest: string;
    active_release_id: string;
    release_pointer_version: number;
    authority_stage_id: string;
    authority_stage_state: string;
    authority_pointer_version: number;
    current_authority_digest: string;
    base_url: string;
    endpoint_path: string;
    method: string;
    connector_invocation_id: string;
    connector_invocation_status: string;
    response_ref_matched: boolean;
    source_snapshot_id: string;
    model_invocation_id: string;
    model_invocation_status: string;
    result_id: string;
    card_hash: string;
  }>(`SELECT task.id task_id,task.workflow_version_id,task.workflow_hash,
      approval.id approval_id,approval.subject_digest approval_subject_digest,
      spec.id connector_query_spec_id,spec.spec_hash connector_query_spec_hash,
      spec.release_record_id,spec.approved_preflight_digest,task.gate_a3_authority_digest,
      active.release_id active_release_id,active.pointer_version::int release_pointer_version,
      current.stage_id authority_stage_id,current.pointer_version::int authority_pointer_version,
      stage.state authority_stage_state,stage.authority_digest current_authority_digest,
      spec.base_url,spec.endpoint_path,spec.method,
      connector.id connector_invocation_id,connector.status connector_invocation_status,
      connector.response_ref_matched,snapshot.id source_snapshot_id,
      model.id model_invocation_id,model.status model_invocation_status,
      result.id result_id,result.card_hash
    FROM business_tasks task
    JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
    JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=task.tenant_id AND spec.business_task_id=task.id
    JOIN gate_a3_connector_invocations connector ON connector.tenant_id=task.tenant_id AND connector.business_task_id=task.id
    JOIN gate_a3_connector_source_snapshots snapshot ON snapshot.tenant_id=task.tenant_id AND snapshot.business_task_id=task.id
    JOIN gate_a3_model_invocations model ON model.tenant_id=task.tenant_id AND model.business_task_id=task.id
    JOIN gate_a3_work_order_results result ON result.tenant_id=task.tenant_id AND result.business_task_id=task.id
    JOIN capability_active_releases active ON active.tenant_id=task.tenant_id
      AND active.capability_id='production.work-order-status.v1'
    JOIN gate_a3_authority_current current ON current.tenant_id=task.tenant_id
      AND current.capability_id='production.work-order-status.v1'
    JOIN gate_a3_authority_stages stage ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
    WHERE task.tenant_id='tenant_local' AND task.id=$1 AND task.record_variant='business-task.work-order.live/1'
      AND task.status='completed' AND approval.status='approved'`, [taskId]);
  expect(joined.rowCount).toBe(1);
  const row = joined.rows[0];
  if (row === undefined) throw new Error('Gate A.3 authority correlation row is missing');
  expect(row).toMatchObject({
    base_url: 'http://127.0.0.1:8100',
    endpoint_path: receiverPath,
    method: 'GET',
    connector_invocation_status: 'completed',
    response_ref_matched: true,
    model_invocation_status: 'completed',
    release_record_id: 'release_production_work_order_status_v1_internal',
    active_release_id: 'release_production_work_order_status_v1_internal',
    authority_stage_state: 'internal',
  });
  expect(row.release_record_id).toBe(row.active_release_id);
  expect(row.gate_a3_authority_digest).toBe(row.current_authority_digest);
  expect(row.release_pointer_version).toBeGreaterThan(0);
  expect(row.authority_pointer_version).toBeGreaterThan(0);
  expect(row.approved_preflight_digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(row.gate_a3_authority_digest).toMatch(/^[a-f0-9]{64}$/u);
  const counts = await pool.query<{
    completed_steps: number;
    evidence_count: number;
    whole_evidence_count: number;
    field_evidence_count: number;
    result_count: number;
  }>(`SELECT
      (SELECT count(*)::int FROM business_task_steps WHERE tenant_id='tenant_local'
        AND business_task_id=$1 AND status='completed') completed_steps,
      (SELECT count(*)::int FROM gate_a3_connector_evidence WHERE tenant_id='tenant_local'
        AND business_task_id=$1 AND accessible) evidence_count,
      (SELECT count(*)::int FROM gate_a3_connector_evidence WHERE tenant_id='tenant_local'
        AND business_task_id=$1 AND accessible AND locator_kind='connector_snapshot_whole') whole_evidence_count,
      (SELECT count(*)::int FROM gate_a3_connector_evidence WHERE tenant_id='tenant_local'
        AND business_task_id=$1 AND accessible AND locator_kind='connector_snapshot_field') field_evidence_count,
      (SELECT count(*)::int FROM gate_a3_work_order_results WHERE tenant_id='tenant_local'
        AND business_task_id=$1) result_count`, [taskId]);
  expect(counts.rows).toEqual([{
    completed_steps: 6,
    evidence_count: 10,
    whole_evidence_count: 1,
    field_evidence_count: 9,
    result_count: 1,
  }]);
  return { ...row, ...counts.rows[0] };
}

function receiverRequests(logs: string): readonly Readonly<{
  method: string;
  path: string;
  status: number;
}>[] {
  return logs.split('\n').flatMap((line) => {
    const match = line.match(/"([A-Z]+) ([^ ]+) HTTP\/1\.[01]" (\d{3})/u);
    return match?.[1] === undefined || match[2] === undefined || match[3] === undefined
      ? [] : [{ method: match[1], path: match[2], status: Number(match[3]) }];
  });
}

test.afterAll(async () => pool.end());

test('真实单工单 served flow 关联 immutable authority、10 Evidence 与 GearJob 零写边界', async ({ page, request }) => {
  test.setTimeout(210_000);
  let zeroWriteOracle: GearJobZeroWriteOracle | undefined;
  let zeroWrite: Awaited<ReturnType<typeof finishZeroWriteOracle>> | undefined;
  try {
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await chmod(evidenceDirectory, 0o700);

    const response = await page.goto('/conversations/new', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('geneway-fast-chat')).toBeVisible();
    await expect(page.getByTestId('work-order-entry-link')).toBeVisible();
    const browserDenialProbeCount = await proveBrowserKernelDenials(page);

    const externalApplicationRequests: string[] = [];
    const webOrigin = new URL(page.url()).origin;
    page.on('request', (observed) => {
      const target = new URL(observed.url());
      if ((target.protocol === 'http:' || target.protocol === 'https:') && target.origin !== webOrigin) {
        externalApplicationRequests.push(target.origin);
      }
    });
    page.on('websocket', (socket) => {
      const target = new URL(socket.url());
      const origin = `${target.protocol === 'ws:' ? 'http:' : 'https:'}//${target.host}`;
      if (origin !== webOrigin) externalApplicationRequests.push(origin);
    });

    const routeResponse = await request.get('/api/capabilities/production.work-order-status.v1');
    expect(routeResponse.ok()).toBe(true);
    expect(await routeResponse.json()).toMatchObject({
      capabilityId: 'production.work-order-status.v1',
      status: 'internal',
      executionRoute: 'live',
      internalAcceptance: true,
      businessDecisionAllowed: false,
    });

    const receiverSince = new Date().toISOString();
    zeroWriteOracle = await startZeroWriteOracle();
    await page.getByTestId('work-order-entry-link').click();
    await expect(page).toHaveURL(/\/work-orders\/new$/u);
    await expect(page.getByTestId('work-order-create')).toBeVisible();
    await page.getByTestId('work-order-ref').fill(workOrderRef);
    await page.getByRole('button', { name: '创建查询任务', exact: true }).click();
    await expect(page).toHaveURL(/\/work-orders\/task_[A-Za-z0-9._:-]+$/u);
    const taskId = decodeURIComponent(new URL(page.url()).pathname.slice('/work-orders/'.length));
    expect(taskId).toMatch(/^task_[A-Za-z0-9._:-]+$/u);

    const workflow = page.getByTestId('work-order-workflow');
    await expect(workflow.locator('li')).toHaveCount(6);
    const expectedSteps = [
      'validate_work_order_ref', 'fetch_authorized_status', 'compute_progress',
      'explain_status', 'evidence_verify', 'publish_status_card',
    ];
    for (const [index, step] of expectedSteps.entries()) await expect(workflow.locator('li').nth(index)).toContainText(step);
    await expect(page.getByTestId('work-order-approve-execute')).toBeVisible();
    await page.screenshot({ path: `${evidenceDirectory}/work-order-awaiting-approval.png`, fullPage: true });
    await chmod(`${evidenceDirectory}/work-order-awaiting-approval.png`, 0o600);
    const preApprovalRequests = receiverRequests(
      await dockerOutput(['logs', '--since', receiverSince, receiverContainer]),
    );
    expect(preApprovalRequests).toEqual([]);

    await page.getByTestId('work-order-approve-execute').click();
    await expect(page.getByTestId('work-order-status-card')).toBeVisible({ timeout: 150_000 });
    await expect(page.getByTestId('work-order-status-card')).toHaveAttribute('data-read-only', 'true');
    await expect(page.getByTestId('work-order-explanation')).toBeVisible();
    await expect(page.getByRole('heading', { name: '小纬说明', exact: true })).toBeVisible();
    await expect(workflow.locator('li')).toHaveCount(6);
    for (const [index, step] of expectedSteps.entries()) {
      await expect(workflow.locator('li').nth(index)).toContainText(step);
      await expect(workflow.locator('li').nth(index)).toContainText('completed');
    }
    await expect(page.getByTestId('work-order-public-evidence')).toHaveCount(4);

    const taskResponse = await request.get(`/api/business-tasks/${encodeURIComponent(taskId)}`);
    expect(taskResponse.ok()).toBe(true);
    const task = gateA3PublicTaskSnapshotSchema.parse(await taskResponse.json());
    expect(task).toMatchObject({
      taskId,
      status: 'completed',
      recordVariant: 'business-task.work-order.live/1',
      result: { kind: 'work_order_status', card: { workOrderRef, readOnly: true } },
    });
    if (task.result?.kind !== 'work_order_status') throw new Error('Work Order public result was not published');
    const expectedSummary = `工单 ${task.result.card.workOrderRef} 当前状态为“${task.result.card.status}”；${task.result.card.progressPct === null
      ? '基于已验证数量，确定性进度暂不可计算。'
      : `基于已验证数量，确定性进度为 ${String(task.result.card.progressPct)}%。`}`;
    expect(task.result.explanation.summary).toBe(expectedSummary);

    const evidenceIds = [...new Set(Object.values(task.result.card.evidenceRefs))];
    expect(evidenceIds).toHaveLength(4);
    for (const evidenceId of evidenceIds) {
      const evidenceResponse = await request.get(`/api/evidence/${encodeURIComponent(evidenceId)}`);
      expect(evidenceResponse.ok()).toBe(true);
      expect(await evidenceResponse.json()).toMatchObject({ id: evidenceId, kind: 'connector_snapshot_field', readOnly: true });
    }

    const beforeReload = JSON.stringify(task);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('work-order-status-card')).toBeVisible();
    const reloadedResponse = await request.get(`/api/business-tasks/${encodeURIComponent(taskId)}`);
    expect(reloadedResponse.ok()).toBe(true);
    expect(JSON.stringify(gateA3PublicTaskSnapshotSchema.parse(await reloadedResponse.json()))).toBe(beforeReload);
    await page.screenshot({ path: `${evidenceDirectory}/work-order-completed.png`, fullPage: true });
    await chmod(`${evidenceDirectory}/work-order-completed.png`, 0o600);

    const correlation = await authorityCorrelation(taskId);
    zeroWrite = await finishZeroWriteOracle(zeroWriteOracle);
    zeroWriteOracle = undefined;
    expect(zeroWrite).toMatchObject({
      mariaMutatingStatementCount: 0,
      mariaStateUnchanged: true,
      redisMutatingCommandCount: 0,
      redisStateUnchanged: true,
    });

    const receiverLog = await dockerOutput(['logs', '--since', receiverSince, receiverContainer]);
    const observedReceiverRequests = receiverRequests(receiverLog);
    const actualRequests = observedReceiverRequests.filter((entry) => {
      const url = new URL(entry.path, 'http://dev.localhost');
      return url.pathname === receiverPath && url.searchParams.get('work_order_ref') === workOrderRef;
    });
    expect(actualRequests).toEqual([{ method: 'GET', path: `${receiverPath}?work_order_ref=${workOrderRef}`, status: 200 }]);
    const unexpectedReceiverRequests = observedReceiverRequests.filter((entry) => {
      const url = new URL(entry.path, 'http://dev.localhost');
      return entry.method !== 'GET' || entry.status !== 200 || url.pathname !== receiverPath
        || url.searchParams.get('work_order_ref') !== workOrderRef
        || [...url.searchParams.keys()].length !== 1;
    });
    expect(unexpectedReceiverRequests).toEqual([]);

    const dom = await page.content();
    const secretCanary = process.env.GENEWAY_E2E_SECRET_CANARY;
    expect(secretCanary).toMatch(/^geneway-secret-canary-[a-f0-9]{48}$/u);
    expect(dom).not.toContain(secretCanary);
    expect(dom).not.toMatch(/authorization|bearer\s+|apiSecret|apiKey|credential|receipt|Connector Gateway|\/api\/method\/gearjob/iu);
    expect(externalApplicationRequests).toEqual([]);

    const summary = {
      schemaVersion: 'geneway-gate-a-work-order-correlation/1',
      runId,
      passed: true,
      task: {
        id: correlation.task_id,
        workflowVersionId: correlation.workflow_version_id,
        workflowHash: correlation.workflow_hash,
        approvalId: correlation.approval_id,
        approvalSubjectDigest: correlation.approval_subject_digest,
        connectorQuerySpecId: correlation.connector_query_spec_id,
        connectorQuerySpecHash: correlation.connector_query_spec_hash,
        connectorInvocationId: correlation.connector_invocation_id,
        connectorSourceSnapshotId: correlation.source_snapshot_id,
        modelInvocationId: correlation.model_invocation_id,
        resultId: correlation.result_id,
        cardHash: correlation.card_hash,
        workflowNodeCount: correlation.completed_steps,
        evidenceCount: correlation.evidence_count,
        wholeEvidenceCount: correlation.whole_evidence_count,
        fieldEvidenceCount: correlation.field_evidence_count,
        resultCount: correlation.result_count,
        publicCardEvidenceReferenceCount: evidenceIds.length,
      },
      receiver: {
        origin: correlation.base_url,
        hostHeader: 'dev.localhost',
        endpoint: correlation.endpoint_path,
        method: correlation.method,
        preApprovalRequestCount: preApprovalRequests.length,
        exactSuccessfulRequestCount: actualRequests.length,
        unexpectedRequestCount: unexpectedReceiverRequests.length,
        redirectCount: 0,
        responseRefMatched: correlation.response_ref_matched,
      },
      connectorEgress: {
        connectAddress: '127.0.0.1',
        connectPort: 8_100,
        hostHeader: 'dev.localhost',
        method: 'GET',
        endpoint: receiverPath,
        successfulRequestCount: actualRequests.length,
        redirectCount: 0,
        unexpectedRequestCount: unexpectedReceiverRequests.length,
        exactSingleObjectResponseMatched: correlation.response_ref_matched,
      },
      releaseAuthority: {
        releaseRecordId: correlation.release_record_id,
        activeReleaseId: correlation.active_release_id,
        releasePointerVersion: correlation.release_pointer_version,
        approvedPreflightDigest: correlation.approved_preflight_digest,
        taskAuthorityDigest: correlation.gate_a3_authority_digest,
        currentAuthorityDigest: correlation.current_authority_digest,
        authorityStageId: correlation.authority_stage_id,
        authorityStageState: correlation.authority_stage_state,
        authorityPointerVersion: correlation.authority_pointer_version,
      },
      zeroWrite,
      browser: {
        applicationExternalHttpOrWebSocketRequestCount: externalApplicationRequests.length,
        kernelForbiddenPortProbeCount: browserDenialProbeCount,
        kernelGuardRequired: process.env.GENEWAY_GATE02B_EGRESS_GUARD === 'required',
        secretCanaryAbsent: true,
        internalCredentialOrRouteMaterialAbsent: true,
        reloadRecoveredIdenticalTask: true,
      },
    };
    await writeFile(`${evidenceDirectory}/work-order-correlation-summary.json`, `${JSON.stringify(summary, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
  } finally {
    if (zeroWriteOracle !== undefined && zeroWrite === undefined) {
      await finishZeroWriteOracle(zeroWriteOracle).catch(() => undefined);
    }
  }
});
