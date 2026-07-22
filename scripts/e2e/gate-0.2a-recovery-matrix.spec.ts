import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import pg from 'pg';
import {
  readProcessPair,
  readProcessReceipt,
  sameProcess,
  waitUntil,
  writeRecoveryCase,
  type ProcessReceipt,
  type RecoveryCaseId,
} from './recovery-matrix-support.js';

const { Pool } = pg;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const runId = required('GENEWAY_RUN_ID');
const databaseUrl = required('GENEWAY_E2E_DATABASE_URL');
const webPort = Number(required('GENEWAY_WEB_PORT'));
const controlPlanePort = Number(required('GENEWAY_CONTROL_PLANE_PORT'));
const controlPlaneSupervisorPort = Number(required('GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT'));
const workerHealthPort = Number(required('GENEWAY_WORKER_HEALTH_PORT'));
const workerTokenFile = required('GENEWAY_WORKER_TOKEN_FILE');
const workerSocketPath = required('GENEWAY_WORKER_SOCKET_PATH');
if (![webPort, controlPlanePort, controlPlaneSupervisorPort, workerHealthPort]
  .every((port) => Number.isInteger(port) && port > 0 && port <= 65_535)) throw new Error('Recovery matrix ports are invalid');

const controlPlaneUrl = `http://127.0.0.1:${String(controlPlanePort)}`;
const origin = `http://localhost:${String(webPort)}`;
const fixturePath = path.resolve(process.cwd(), 'scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt');
const hookReceiptPath = `/tmp/geneway-runs/${runId}/process-boundaries/e2e-hooks.json`;
const pool = new Pool({ connectionString: databaseUrl });

type HookName =
  | 'worker.after_delivery_claim'
  | 'worker.before_complete_step'
  | 'control-plane.after_complete_step_committed_before_response'
  | 'control-plane.after_ingest_intent_put_authority_committed'
  | 'control-plane.after_source_object_put'
  | 'control-plane.after_report_object_verified';
type HookState = Readonly<{
  armId: string;
  hook: HookName;
  taskId: string | null;
  idempotencyKey: string | null;
  stepId?: string;
  state: 'armed' | 'triggered' | 'released' | 'worker_killed' | 'control_plane_killed' | 'error_injected';
  faultTriggered: boolean;
  triggerId: string | null;
  action: string | null;
  payload: Readonly<Record<string, unknown>> | null;
}>;

function key(caseId: RecoveryCaseId, suffix: string): string {
  return `${caseId}-${suffix}-${runId}`.slice(0, 190);
}

function processIdentityMatches(receipt: ProcessReceipt): boolean {
  try {
    const raw = readFileSync(`/proc/${String(receipt.pid)}/stat`, 'utf8');
    const closingParenthesis = raw.lastIndexOf(')');
    return closingParenthesis > 0 && raw.slice(closingParenthesis + 1).trim().split(/\s+/u)[19] === receipt.procStartTicks;
  } catch { return false; }
}

async function supervisorRequest<T>(port: number, method: 'GET' | 'POST', route: string, body?: unknown) {
  const token = (await readFileAsync(workerTokenFile, 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${String(port)}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json() as T;
  return { status: response.status, body: payload } as const;
}

async function armHook(input: Readonly<{ hook: HookName; taskId?: string; idempotencyKey?: string; stepId?: string }>): Promise<HookState> {
  const response = await supervisorRequest<HookState>(workerHealthPort, 'POST', '/test/hooks/arm', input);
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({ hook: input.hook, state: 'armed', faultTriggered: false });
  return response.body;
}

async function hookState(armId: string): Promise<HookState> {
  const response = await supervisorRequest<HookState>(workerHealthPort, 'GET', `/test/hooks/state?armId=${encodeURIComponent(armId)}`);
  expect(response.status).toBe(200);
  return response.body;
}

async function waitHook(arm: HookState): Promise<HookState> {
  return waitUntil(async () => {
    const state = await hookState(arm.armId);
    return state.state === 'triggered' && state.triggerId !== null ? state : undefined;
  }, 20_000, `${arm.hook} trigger`);
}

async function releaseHook(hook: HookState, action: 'continue' | 'inject_error' = 'continue'): Promise<HookState> {
  const response = await supervisorRequest<HookState>(workerHealthPort, 'POST', '/test/hooks/release', {
    armId: hook.armId,
    triggerId: hook.triggerId,
    action,
  });
  expect(response.status).toBe(200);
  return response.body;
}

async function releaseIfBlocked(arm: HookState | undefined): Promise<void> {
  if (arm === undefined) return;
  try {
    const state = await hookState(arm.armId);
    if (state.state === 'triggered') await releaseHook(state);
  } catch { /* Best-effort teardown for a failed case. */ }
}

async function killControlPlane(receipt: ProcessReceipt) {
  const response = await supervisorRequest<{
    killed: { pid: number; procStartTicks: string; generation: number };
    nextGeneration: number;
  }>(controlPlaneSupervisorPort, 'POST', '/test/kill-control-plane', {
    pid: receipt.pid,
    procStartTicks: receipt.procStartTicks,
    generation: receipt.generation,
  });
  expect(response.status).toBe(202);
  expect(response.body.killed).toMatchObject({ pid: receipt.pid, procStartTicks: receipt.procStartTicks, generation: receipt.generation });
  return response.body;
}

async function waitControlPlaneRestart(previous: ProcessReceipt): Promise<ProcessReceipt> {
  return waitUntil(async () => {
    try {
      const health = await fetch(`http://127.0.0.1:${String(controlPlaneSupervisorPort)}/health`);
      if (!health.ok) return undefined;
      const receipt = await readProcessReceipt('control-plane');
      return !sameProcess(previous, receipt) && processIdentityMatches(receipt) ? receipt : undefined;
    } catch { return undefined; }
  }, 20_000, 'replacement Control Plane generation');
}

async function killWorker(receipt: ProcessReceipt, restart = true) {
  const response = await supervisorRequest<{
    killed: { pid: number; procStartTicks: string; workerInstanceId: string; generation: number };
    restartScheduled: boolean;
    nextGeneration: number | null;
  }>(workerHealthPort, 'POST', '/test/kill-worker', {
    pid: receipt.pid,
    procStartTicks: receipt.procStartTicks,
    workerInstanceId: receipt.workerInstanceId,
    restart,
  });
  expect(response.status).toBe(202);
  expect(response.body.restartScheduled).toBe(restart);
  return response.body;
}

async function resumeWorker(): Promise<void> {
  const response = await supervisorRequest<{ restartScheduled: boolean; nextGeneration: number }>(
    workerHealthPort, 'POST', '/test/resume-worker', {},
  );
  expect(response.status).toBe(202);
}

async function waitWorkerRestart(previous: ProcessReceipt): Promise<ProcessReceipt> {
  return waitUntil(async () => {
    try {
      const health = await fetch(`http://127.0.0.1:${String(workerHealthPort)}/health`);
      if (!health.ok) return undefined;
      const receipt = await readProcessReceipt('worker');
      return !sameProcess(previous, receipt) && processIdentityMatches(receipt) ? receipt : undefined;
    } catch { return undefined; }
  }, 20_000, 'replacement Worker generation');
}

async function createConversation(request: APIRequestContext, caseId: RecoveryCaseId): Promise<string> {
  const response = await request.post('/api/conversations', { headers: { origin, 'idempotency-key': key(caseId, 'conversation') } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function upload(conversationId: string, caseId: RecoveryCaseId): Promise<Response> {
  const bytes = await readFileAsync(fixturePath);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'text/plain' }), 'solution-analysis-demo-v2.txt');
  return fetch(`${controlPlaneUrl}/api/conversations/${conversationId}/uploads`, {
    method: 'POST', headers: { origin, 'idempotency-key': key(caseId, 'upload') }, body: form,
  });
}

async function createPendingTask(request: APIRequestContext, caseId: RecoveryCaseId) {
  const conversationId = await createConversation(request, caseId);
  const uploaded = await upload(conversationId, caseId);
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
  const source = await uploaded.json() as { documentSnapshot: { id: string }; artifact: { id: string } };
  const response = await request.post('/api/business-tasks', {
    headers: { origin, 'idempotency-key': key(caseId, 'task') },
    data: {
      conversationId,
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'document_snapshot', documentSnapshotId: source.documentSnapshot.id },
      expertTarget: { mode: 'team', teamId: 'team.solution.core' },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return {
    conversationId,
    snapshotId: source.documentSnapshot.id,
    artifactId: source.artifact.id,
    ...await response.json() as { taskId: string; approvalId: string },
  };
}

async function approve(request: APIRequestContext, caseId: RecoveryCaseId, approvalId: string): Promise<void> {
  const response = await request.post(`/api/approvals/${approvalId}/decisions`, {
    headers: { origin, 'idempotency-key': key(caseId, 'approve') }, data: { decision: 'approved' },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function execute(request: APIRequestContext, caseId: RecoveryCaseId, taskId: string): Promise<void> {
  const response = await request.post(`/api/business-tasks/${taskId}/execute`, {
    headers: { origin, 'idempotency-key': key(caseId, 'execute') },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function createApprovedTask(request: APIRequestContext, caseId: RecoveryCaseId) {
  const task = await createPendingTask(request, caseId);
  await approve(request, caseId, task.approvalId);
  return task;
}

async function taskFinal(taskId: string) {
  const result = await pool.query<{
    status: string; attempts: string; current_attempts: string; deliveries: string; inboxes: string;
    candidates: string; published_claims: string; report_artifacts: string; ready_snapshots: string;
  }>(`SELECT task.status,
    (SELECT count(*)::text FROM execution_attempts a WHERE a.tenant_id=task.tenant_id AND a.business_task_id=task.id) attempts,
    (SELECT count(*)::text FROM execution_attempts a WHERE a.tenant_id=task.tenant_id AND a.id=task.current_execution_attempt_id) current_attempts,
    (SELECT count(*)::text FROM outbox_deliveries d WHERE d.tenant_id=task.tenant_id AND d.business_task_id=task.id) deliveries,
    (SELECT count(*)::text FROM inbox_events i WHERE i.tenant_id=task.tenant_id AND i.business_task_id=task.id) inboxes,
    (SELECT count(*)::text FROM attempt_output_candidates c WHERE c.tenant_id=task.tenant_id AND c.business_task_id=task.id) candidates,
    (SELECT count(*)::text FROM claims c WHERE c.tenant_id=task.tenant_id AND c.business_task_id=task.id AND c.status='published') published_claims,
    (SELECT count(*)::text FROM artifacts a WHERE a.tenant_id=task.tenant_id AND a.business_task_id=task.id AND a.kind='simulation_report') report_artifacts,
    (SELECT count(*)::text FROM document_snapshots s WHERE s.tenant_id=task.tenant_id AND s.id=task.input_snapshot->>'documentSnapshotId') ready_snapshots
    FROM business_tasks task WHERE task.tenant_id='tenant_local' AND task.id=$1`, [taskId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Task ${taskId} disappeared`);
  return {
    taskStatus: row.status,
    attempts: Number(row.attempts),
    currentAttempts: Number(row.current_attempts),
    deliveries: Number(row.deliveries),
    inboxes: Number(row.inboxes),
    candidates: Number(row.candidates),
    publishedClaims: Number(row.published_claims),
    reportArtifacts: Number(row.report_artifacts),
    readySnapshots: Number(row.ready_snapshots),
  };
}

async function waitCompleted(taskId: string) {
  return waitUntil(async () => {
    const final = await taskFinal(taskId);
    return final.taskStatus === 'completed' ? final : undefined;
  }, 45_000, `task ${taskId} completion`);
}

async function ingestFinal(idempotencyKey: string) {
  const result = await pool.query<{
    id: string; artifact_id: string; document_snapshot_id: string; storage_key: string; status: string;
    artifacts: string; snapshots: string;
  }>(`SELECT intent.id,intent.artifact_id,intent.document_snapshot_id,intent.storage_key,intent.status,
    (SELECT count(*)::text FROM artifacts a WHERE a.tenant_id=intent.tenant_id AND a.id=intent.artifact_id) artifacts,
    (SELECT count(*)::text FROM document_snapshots s WHERE s.tenant_id=intent.tenant_id AND s.id=intent.document_snapshot_id) snapshots
    FROM artifact_ingest_intents intent WHERE intent.tenant_id='tenant_local' AND intent.idempotency_key=$1`, [idempotencyKey]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Ingest intent ${idempotencyKey} disappeared`);
  return {
    intentId: row.id,
    artifactId: row.artifact_id,
    snapshotId: row.document_snapshot_id,
    storageKey: row.storage_key,
    intentStatus: row.status,
    artifacts: Number(row.artifacts),
    readySnapshots: Number(row.snapshots),
    publishedClaims: 0,
    reportArtifacts: 0,
  };
}

async function retryUploadUntilReady(conversationId: string, caseId: RecoveryCaseId): Promise<void> {
  await waitUntil(async () => {
    try {
      const response = await upload(conversationId, caseId);
      if (response.status === 201) return true;
      if ([409, 502, 503].includes(response.status)) return undefined;
      throw new Error(`Unexpected upload recovery response ${String(response.status)}: ${await response.text()}`);
    } catch { return undefined; }
  }, 30_000, `${caseId} upload recovery`);
}

async function sendWorkerCommand(payload: Readonly<Record<string, unknown>>): Promise<Readonly<{ status: number; body: unknown }>> {
  const token = (await readFileAsync(workerTokenFile, 'utf8')).trim();
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: workerSocketPath,
      path: '/internal/worker/v1/commands',
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }); }
        catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('Worker command timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

test.afterAll(async () => pool.end());
test.describe.configure({ mode: 'serial' });

for (const sourceCase of [
  'after_intent_commit_before_s3_put',
  'after_s3_put_before_db_finalize',
] as const) {
  test(sourceCase, async ({ request }) => {
    test.setTimeout(90_000);
    const processBefore = await readProcessPair();
    const conversationId = await createConversation(request, sourceCase);
    const idempotencyKey = key(sourceCase, 'upload');
    const hookName = sourceCase === 'after_intent_commit_before_s3_put'
      ? 'control-plane.after_ingest_intent_put_authority_committed' as const
      : 'control-plane.after_source_object_put' as const;
    const arm = await armHook({ hook: hookName, idempotencyKey });
    try {
      const uploading = upload(conversationId, sourceCase)
        .then((response) => ({ status: response.status, error: null }))
        .catch((error: unknown) => ({ status: 0, error: String(error) }));
      const triggered = await waitHook(arm);
      const killed = await killControlPlane(processBefore.controlPlane);
      await waitUntil(() => processIdentityMatches(processBefore.controlPlane) ? undefined : true, 5_000, 'killed Control Plane exit');
      const replacement = await waitControlPlaneRestart(processBefore.controlPlane);
      const interrupted = await uploading;
      expect(interrupted.status).toBe(0);
      await waitUntil(async () => (await hookState(arm.armId)).state === 'control_plane_killed' ? true : undefined,
        5_000, 'Control Plane kill hook receipt');
      await retryUploadUntilReady(conversationId, sourceCase);
      const final = await ingestFinal(idempotencyKey);
      expect(final).toMatchObject({ intentStatus: 'ready', artifacts: 1, readySnapshots: 1 });
      const processAfter = await readProcessPair();
      await writeRecoveryCase({
        caseId: sourceCase,
        faultTriggered: true,
        trigger: { hook: hookName, action: 'control_plane_sigkill', triggerId: triggered.triggerId, killed, replacement },
        entityIds: { conversationId, intentId: final.intentId, artifactId: final.artifactId, snapshotId: final.snapshotId },
        processBefore, processAfter, final,
        evidenceRefs: [hookReceiptPath, `/tmp/geneway-runs/${runId}/process-boundaries/control-plane-generation-${String(replacement.generation)}.json`],
      });
    } finally { await releaseIfBlocked(arm); }
  });
}

test('put_response_lost', async ({ request }) => {
  test.setTimeout(60_000);
  const caseId = 'put_response_lost';
  const processBefore = await readProcessPair();
  const conversationId = await createConversation(request, caseId);
  const idempotencyKey = key(caseId, 'upload');
  const arm = await armHook({ hook: 'control-plane.after_source_object_put', idempotencyKey });
  try {
    const uploading = upload(conversationId, caseId);
    const triggered = await waitHook(arm);
    const released = await releaseHook(triggered, 'inject_error');
    expect(released).toMatchObject({ state: 'error_injected', action: 'inject_error', faultTriggered: true });
    const interrupted = await uploading;
    expect(interrupted.status, await interrupted.clone().text()).toBe(502);
    await retryUploadUntilReady(conversationId, caseId);
    const final = await ingestFinal(idempotencyKey);
    expect(final).toMatchObject({ intentStatus: 'ready', artifacts: 1, readySnapshots: 1 });
    await writeRecoveryCase({
      caseId, faultTriggered: true,
      trigger: { hook: arm.hook, action: 'inject_error', triggerId: triggered.triggerId, code: 'E2E_PUT_RESPONSE_LOST' },
      entityIds: { conversationId, intentId: final.intentId, artifactId: final.artifactId, snapshotId: final.snapshotId },
      processBefore, processAfter: await readProcessPair(), final, evidenceRefs: [hookReceiptPath],
    });
  } finally { await releaseIfBlocked(arm); }
});

test('after_outbox_commit_before_worker_claim', async ({ request }) => {
  test.setTimeout(90_000);
  const caseId = 'after_outbox_commit_before_worker_claim';
  const task = await createApprovedTask(request, caseId);
  const processBefore = await readProcessPair();
  const stopped = await killWorker(processBefore.worker, false);
  await waitUntil(() => processIdentityMatches(processBefore.worker) ? undefined : true, 5_000, 'paused Worker exit');
  await execute(request, caseId, task.taskId);
  const boundary = await pool.query<{ outboxes: string; deliveries: string }>(`SELECT
    (SELECT count(*)::text FROM outbox_events WHERE tenant_id='tenant_local' AND business_task_id=$1 AND event_type='workflow.execute.requested') outboxes,
    (SELECT count(*)::text FROM outbox_deliveries WHERE tenant_id='tenant_local' AND business_task_id=$1) deliveries`, [task.taskId]);
  expect(boundary.rows).toEqual([{ outboxes: '1', deliveries: '0' }]);
  await resumeWorker();
  const replacement = await waitWorkerRestart(processBefore.worker);
  const final = await waitCompleted(task.taskId);
  expect(final).toMatchObject({ currentAttempts: 1, publishedClaims: 1, reportArtifacts: 1, readySnapshots: 1 });
  await writeRecoveryCase({
    caseId, faultTriggered: true,
    trigger: { boundary: boundary.rows[0], action: 'worker_unavailable_across_outbox_commit', stopped, replacement },
    entityIds: { taskId: task.taskId, approvalId: task.approvalId },
    processBefore, processAfter: await readProcessPair(), final,
    evidenceRefs: [`/tmp/geneway-runs/${runId}/process-boundaries/worker-supervisor.jsonl`],
  });
});

test('after_inbox_insert_before_step_execution', async ({ request }) => {
  test.setTimeout(90_000);
  const caseId = 'after_inbox_insert_before_step_execution';
  const task = await createApprovedTask(request, caseId);
  const processBefore = await readProcessPair();
  const arm = await armHook({ hook: 'worker.after_delivery_claim', taskId: task.taskId });
  try {
    await execute(request, caseId, task.taskId);
    const triggered = await waitHook(arm);
    const payload = triggered.payload ?? {};
    const inbox = await pool.query<{ status: string }>(`SELECT status FROM inbox_events
      WHERE tenant_id='tenant_local' AND business_task_id=$1 AND execution_attempt_id=$2`, [task.taskId, payload.executionAttemptId]);
    expect(inbox.rows).toEqual([{ status: 'received' }]);
    const killed = await killWorker(processBefore.worker);
    const replacement = await waitWorkerRestart(processBefore.worker);
    const final = await waitCompleted(task.taskId);
    expect(final).toMatchObject({ attempts: 2, currentAttempts: 1, publishedClaims: 1, reportArtifacts: 1, readySnapshots: 1 });
    await writeRecoveryCase({
      caseId, faultTriggered: true,
      trigger: { hook: arm.hook, action: 'worker_sigkill', triggerId: triggered.triggerId, inboxStatus: 'received', killed, replacement },
      entityIds: {
        taskId: task.taskId,
        deliveryId: String(payload.deliveryId),
        attemptId: String(payload.executionAttemptId),
      },
      processBefore, processAfter: await readProcessPair(), final, evidenceRefs: [hookReceiptPath],
    });
  } finally { await releaseIfBlocked(arm); }
});

test('complete_step_ack_lost', async ({ request }) => {
  test.setTimeout(60_000);
  const caseId = 'complete_step_ack_lost';
  const task = await createApprovedTask(request, caseId);
  const processBefore = await readProcessPair();
  const arm = await armHook({
    hook: 'control-plane.after_complete_step_committed_before_response',
    taskId: task.taskId,
    stepId: 'contradiction_check',
  });
  try {
    await execute(request, caseId, task.taskId);
    const triggered = await waitHook(arm);
    const payload = triggered.payload ?? {};
    const released = await releaseHook(triggered, 'inject_error');
    expect(released).toMatchObject({ state: 'error_injected', action: 'inject_error', faultTriggered: true });
    const final = await waitCompleted(task.taskId);
    expect(final).toMatchObject({
      attempts: 1,
      currentAttempts: 1,
      deliveries: 1,
      inboxes: 1,
      publishedClaims: 1,
      reportArtifacts: 1,
      readySnapshots: 1,
    });
    const processAfter = await readProcessPair();
    expect(sameProcess(processBefore.controlPlane, processAfter.controlPlane)).toBe(true);
    expect(sameProcess(processBefore.worker, processAfter.worker)).toBe(true);
    const replay = await pool.query<{ receipts: string; step_events: string; failure_events: string }>(`SELECT
      (SELECT count(*)::text FROM worker_command_receipts receipt
        WHERE receipt.tenant_id='tenant_local' AND receipt.execution_attempt_id=$2
          AND receipt.command_type='complete_step' AND receipt.idempotency_key=$3) receipts,
      (SELECT count(*)::text FROM business_task_events event
        WHERE event.tenant_id='tenant_local' AND event.business_task_id=$1
          AND event.event_type='workflow.step_completed' AND event.payload->>'stepId'=$4) step_events,
      (SELECT count(*)::text FROM business_task_events event
        WHERE event.tenant_id='tenant_local' AND event.business_task_id=$1
          AND event.event_type='business_task.failed') failure_events`, [
      task.taskId,
      payload.executionAttemptId,
      payload.idempotencyKey,
      payload.stepId,
    ]);
    expect(replay.rows).toEqual([{ receipts: '1', step_events: '1', failure_events: '0' }]);
    await writeRecoveryCase({
      caseId,
      faultTriggered: true,
      trigger: {
        hook: arm.hook,
        action: 'inject_error',
        code: 'E2E_COMPLETE_STEP_ACK_LOST',
        triggerId: triggered.triggerId,
        receiptReplay: replay.rows[0],
      },
      entityIds: {
        taskId: task.taskId,
        attemptId: String(payload.executionAttemptId),
        stepId: String(payload.stepId),
        stepAttemptId: String(payload.stepAttemptId),
        idempotencyKey: String(payload.idempotencyKey),
      },
      processBefore,
      processAfter,
      final,
      evidenceRefs: [hookReceiptPath],
    });
  } finally { await releaseIfBlocked(arm); }
});

test('after_report_put_before_db_publish', async ({ request }) => {
  test.setTimeout(90_000);
  const caseId = 'after_report_put_before_db_publish';
  const task = await createApprovedTask(request, caseId);
  const processBefore = await readProcessPair();
  const arm = await armHook({ hook: 'control-plane.after_report_object_verified', taskId: task.taskId });
  try {
    await execute(request, caseId, task.taskId);
    const triggered = await waitHook(arm);
    const payload = triggered.payload ?? {};
    const intent = await pool.query<{ status: string }>(`SELECT status FROM report_publish_intents
      WHERE tenant_id='tenant_local' AND id=$1`, [payload.reportIntentId]);
    expect(intent.rows).toEqual([{ status: 'object_verified' }]);
    const killed = await killControlPlane(processBefore.controlPlane);
    const replacement = await waitControlPlaneRestart(processBefore.controlPlane);
    await waitUntil(async () => (await hookState(arm.armId)).state === 'control_plane_killed' ? true : undefined,
      5_000, 'report hook Control Plane kill receipt');
    const final = await waitCompleted(task.taskId);
    expect(final).toMatchObject({ currentAttempts: 1, publishedClaims: 1, reportArtifacts: 1, readySnapshots: 1 });
    await writeRecoveryCase({
      caseId, faultTriggered: true,
      trigger: { hook: arm.hook, action: 'control_plane_sigkill', triggerId: triggered.triggerId, reportIntentStatus: 'object_verified', killed, replacement },
      entityIds: { taskId: task.taskId, reportIntentId: String(payload.reportIntentId), artifactId: String(payload.artifactId) },
      processBefore, processAfter: await readProcessPair(), final, evidenceRefs: [hookReceiptPath],
    });
  } finally { await releaseIfBlocked(arm); }
});

test('stale_attempt_completion', async ({ request }) => {
  test.setTimeout(90_000);
  const caseId = 'stale_attempt_completion';
  const task = await createApprovedTask(request, caseId);
  const processBefore = await readProcessPair();
  const arm = await armHook({ hook: 'worker.before_complete_step', taskId: task.taskId, stepId: 'contradiction_check' });
  try {
    await execute(request, caseId, task.taskId);
    const triggered = await waitHook(arm);
    const payload = triggered.payload ?? {};
    await killWorker(processBefore.worker);
    const replacement = await waitWorkerRestart(processBefore.worker);
    await waitUntil(async () => {
      const attempts = await pool.query<{ current_attempt: string; attempt_count: string }>(`SELECT current_execution_attempt_id current_attempt,
        (SELECT count(*)::text FROM execution_attempts a WHERE a.tenant_id=t.tenant_id AND a.business_task_id=t.id) attempt_count
        FROM business_tasks t WHERE t.tenant_id='tenant_local' AND t.id=$1`, [task.taskId]);
      const row = attempts.rows[0];
      return row?.attempt_count === '2' && row.current_attempt !== payload.executionAttemptId ? row : undefined;
    }, 20_000, 'replacement execution attempt');
    const stale = await sendWorkerCommand({
      command: 'complete_step',
      protocolVersion: 'gate0.2a-worker-command/1',
      workerInstanceId: payload.workerInstanceId,
      deliveryId: payload.deliveryId,
      eventId: payload.eventId,
      attemptId: payload.executionAttemptId,
      fencingToken: payload.fencingToken,
      stepId: payload.stepId,
      stepAttemptId: payload.stepAttemptId,
      stepFencingToken: payload.stepFencingToken,
      output: { summary: '迟到的旧 attempt 完成' },
      idempotencyKey: key(caseId, 'stale-complete'),
    });
    expect(stale.status).toBe(409);
    const final = await waitCompleted(task.taskId);
    expect(final).toMatchObject({ attempts: 2, currentAttempts: 1, publishedClaims: 1, reportArtifacts: 1, readySnapshots: 1 });
    await writeRecoveryCase({
      caseId, faultTriggered: true,
      trigger: { hook: arm.hook, action: 'stale_complete_step', triggerId: triggered.triggerId, staleStatus: stale.status, replacement },
      entityIds: { taskId: task.taskId, attemptId: String(payload.executionAttemptId), stepAttemptId: String(payload.stepAttemptId) },
      processBefore, processAfter: await readProcessPair(), final, evidenceRefs: [hookReceiptPath],
    });
  } finally { await releaseIfBlocked(arm); }
});

test('sse_snapshot_subscribe_gap', async ({ request }) => {
  test.setTimeout(60_000);
  const caseId = 'sse_snapshot_subscribe_gap';
  const processBefore = await readProcessPair();
  const task = await createPendingTask(request, caseId);
  const snapshotResponse = await request.get(`/api/business-tasks/${task.taskId}`);
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot = await snapshotResponse.json() as { eventWatermark: number };
  await approve(request, caseId, task.approvalId);
  const eventsResponse = await request.get(`/api/business-tasks/${task.taskId}/events?afterCursor=${String(snapshot.eventWatermark)}`, {
    headers: { accept: 'text/event-stream' },
  });
  expect(eventsResponse.ok()).toBe(true);
  const body = await eventsResponse.text();
  const cursors = [...body.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));
  expect(cursors.length).toBeGreaterThan(0);
  expect(new Set(cursors).size).toBe(cursors.length);
  expect(cursors.every((cursor) => cursor > snapshot.eventWatermark)).toBe(true);
  const final = await taskFinal(task.taskId);
  await writeRecoveryCase({
    caseId, faultTriggered: true,
    trigger: { action: 'approval_committed_between_snapshot_and_subscribe', watermark: snapshot.eventWatermark, resumedCursors: cursors },
    entityIds: { taskId: task.taskId, approvalId: task.approvalId, eventIds: cursors.map(String) },
    processBefore, processAfter: await readProcessPair(), final, evidenceRefs: [],
  });
});

test('control_plane_restart', async ({ request }) => {
  test.setTimeout(90_000);
  const caseId = 'control_plane_restart';
  const task = await createApprovedTask(request, caseId);
  const processBefore = await readProcessPair();
  await killWorker(processBefore.worker, false);
  await waitUntil(() => processIdentityMatches(processBefore.worker) ? undefined : true, 5_000, 'paused Worker exit');
  await execute(request, caseId, task.taskId);
  const outbox = await pool.query<{ count: string }>(`SELECT count(*)::text count FROM outbox_events
    WHERE tenant_id='tenant_local' AND business_task_id=$1 AND event_type='workflow.execute.requested'`, [task.taskId]);
  expect(outbox.rows).toEqual([{ count: '1' }]);
  const killed = await killControlPlane(processBefore.controlPlane);
  const replacement = await waitControlPlaneRestart(processBefore.controlPlane);
  await resumeWorker();
  await waitWorkerRestart(processBefore.worker);
  const final = await waitCompleted(task.taskId);
  expect(final).toMatchObject({ currentAttempts: 1, publishedClaims: 1, reportArtifacts: 1, readySnapshots: 1 });
  await writeRecoveryCase({
    caseId, faultTriggered: true,
    trigger: { action: 'control_plane_sigkill_after_outbox_commit', outboxCount: 1, killed, replacement },
    entityIds: { taskId: task.taskId, approvalId: task.approvalId },
    processBefore, processAfter: await readProcessPair(), final,
    evidenceRefs: [`/tmp/geneway-runs/${runId}/process-boundaries/control-plane-supervisor.jsonl`],
  });
});

test('worker_restart', async ({ request }) => {
  test.setTimeout(90_000);
  const caseId = 'worker_restart';
  const task = await createApprovedTask(request, caseId);
  const processBefore = await readProcessPair();
  const arm = await armHook({ hook: 'worker.before_complete_step', taskId: task.taskId, stepId: 'result_quality_check' });
  try {
    await execute(request, caseId, task.taskId);
    const triggered = await waitHook(arm);
    const completed = await pool.query<{ count: string }>(`SELECT count(*)::text count FROM business_task_steps
      WHERE tenant_id='tenant_local' AND business_task_id=$1 AND status='completed'`, [task.taskId]);
    expect(Number(completed.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(4);
    const killed = await killWorker(processBefore.worker);
    const replacement = await waitWorkerRestart(processBefore.worker);
    const final = await waitCompleted(task.taskId);
    expect(final).toMatchObject({ attempts: 2, currentAttempts: 1, publishedClaims: 1, reportArtifacts: 1, readySnapshots: 1 });
    await writeRecoveryCase({
      caseId, faultTriggered: true,
      trigger: { hook: arm.hook, action: 'worker_sigkill_after_multiple_checkpoints', triggerId: triggered.triggerId, completedBeforeKill: completed.rows[0]?.count, killed, replacement },
      entityIds: { taskId: task.taskId, attemptId: String(triggered.payload?.executionAttemptId), stepId: 'result_quality_check' },
      processBefore, processAfter: await readProcessPair(), final, evidenceRefs: [hookReceiptPath],
    });
  } finally { await releaseIfBlocked(arm); }
});
