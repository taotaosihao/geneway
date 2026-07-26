import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SIMULATION_ENVELOPE,
  workerCommandResponseSchema,
  type AttemptOutputCandidatePayload,
  type WorkerCommand,
  type WorkerDelivery,
} from '@geneway/contracts';
import {
  DEMO_EVIDENCE_END_BYTE_EXCLUSIVE,
  DEMO_EVIDENCE_START_BYTE,
  POSITIVE_CLAIM_TEXT,
  UNSUPPORTED_CLAIM_TEXT,
} from '@geneway/evidence';
import { createObjectStorageFromEnv, type ObjectStorage } from '@geneway/storage';
import { createControlPlane, createWorkerCommandApp, type ControlPlane } from './index.js';

const configuredDatabaseUrl = process.env.DATABASE_URL;
if (configuredDatabaseUrl === undefined) throw new Error('DATABASE_URL is required for recovery integration tests');
const databaseUrl: string = configuredDatabaseUrl;
const configuredStorage = createObjectStorageFromEnv();
if (configuredStorage === null) throw new Error('Recovery integration tests require the real storage adapter');
const realStorage: ObjectStorage = configuredStorage;

const requiredCaseIds = [
  'after_intent_commit_before_s3_put',
  'after_s3_put_before_db_finalize',
  'put_response_lost',
  'after_outbox_commit_before_worker_claim',
  'after_inbox_insert_before_step_execution',
  'after_step_side_effect_before_completion',
  'after_report_put_before_db_publish',
  'stale_attempt_completion',
  'cancel_vs_publish',
  'sse_snapshot_subscribe_gap',
  'control_plane_restart',
  'worker_restart',
] as const;
type FaultCaseId = typeof requiredCaseIds[number];
type CaseResult = Readonly<{
  case_id: FaultCaseId;
  fault_triggered: true;
  trigger: Readonly<Record<string, unknown>>;
  entity_ids: Readonly<Record<string, string | readonly string[]>>;
  final: Readonly<Record<string, string | number | boolean | null>>;
}>;

const workerToken = 'recovery-worker-token-0000000000000000000000001';
const runId = process.env.GENEWAY_RUN_ID ?? `recovery-integration-${String(process.pid)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is not a safe path segment');
const summaryPath = `/tmp/geneway-runs/${runId}/recovery/recovery-summary.json`;
const requestHeaders = (key: string) => ({ origin: 'http://localhost:3200', 'idempotency-key': key });
const principal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' } as const;
const results: CaseResult[] = [];

let fixtureBytes: Buffer;
let controlPlane: ControlPlane;
let workerApp: ReturnType<typeof createWorkerCommandApp>;
let serverUrl = '';

function key(caseId: FaultCaseId, suffix: string): string {
  return `${caseId}-${suffix}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(result: CaseResult): void {
  expect(result.fault_triggered).toBe(true);
  expect(results.some((candidate) => candidate.case_id === result.case_id)).toBe(false);
  expect(Object.values(result.entity_ids).every((value) => Array.isArray(value) ? value.length > 0 : value.length > 0)).toBe(true);
  expect(Number(result.final.publishedClaims ?? 0)).toBeLessThanOrEqual(1);
  expect(Number(result.final.reportArtifacts ?? 0)).toBeLessThanOrEqual(1);
  results.push(result);
}

async function closeApps(): Promise<void> {
  await workerApp?.close();
  await controlPlane?.app.close();
}

async function startControlPlane(storage: ObjectStorage = realStorage): Promise<void> {
  controlPlane = await createControlPlane({ databaseUrl, objectStorage: storage });
  serverUrl = await controlPlane.app.listen({ host: '127.0.0.1', port: 0 });
  workerApp = createWorkerCommandApp({
    repository: controlPlane.repository,
    storage,
    token: workerToken,
    leaseDurationMs: 5_000,
  });
}

async function restartControlPlane(storage: ObjectStorage = realStorage): Promise<void> {
  await closeApps();
  await startControlPlane(storage);
}

async function restartWorker(workerStorage: ObjectStorage = controlPlane.artifactService?.storage ?? realStorage): Promise<void> {
  await workerApp.close();
  workerApp = createWorkerCommandApp({
    repository: controlPlane.repository,
    storage: workerStorage,
    token: workerToken,
    leaseDurationMs: 5_000,
  });
}

async function createConversation(caseId: FaultCaseId): Promise<string> {
  const response = await controlPlane.app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers: requestHeaders(key(caseId, 'conversation')),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function upload(conversationId: string, caseId: FaultCaseId) {
  const form = new FormData();
  form.set('file', new Blob([fixtureBytes], { type: 'text/plain' }), 'solution-analysis-demo-v2.txt');
  return fetch(new URL(`/api/conversations/${conversationId}/uploads`, serverUrl), {
    method: 'POST',
    headers: requestHeaders(key(caseId, 'upload')),
    body: form,
  });
}

async function loadIntent(caseId: FaultCaseId) {
  const result = await controlPlane.repository.pool.query<{
    id: string;
    artifact_id: string;
    document_snapshot_id: string;
    storage_key: string;
    status: string;
  }>(`SELECT id,artifact_id,document_snapshot_id,storage_key,status FROM artifact_ingest_intents
    WHERE tenant_id='tenant_local' AND idempotency_key=$1`, [key(caseId, 'upload')]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Fault case ${caseId} did not persist an ingest intent`);
  return row;
}

async function ingestCounts(intentId: string) {
  const result = await controlPlane.repository.pool.query<{
    status: string;
    intent_etag_observed: string | null;
    state_etag_observed: string | null;
    artifacts: string;
    manifests: string;
    ready_snapshots: string;
  }>(`SELECT intent.status,intent.etag_observed intent_etag_observed,
      (SELECT state.etag_observed FROM artifact_states state
        WHERE state.tenant_id=intent.tenant_id AND state.artifact_id=intent.artifact_id) state_etag_observed,
      (SELECT count(*)::text FROM artifacts artifact WHERE artifact.tenant_id=intent.tenant_id AND artifact.id=intent.artifact_id) artifacts,
      (SELECT count(*)::text FROM artifact_manifests manifest WHERE manifest.tenant_id=intent.tenant_id AND manifest.id=intent.manifest_id) manifests,
      (SELECT count(*)::text FROM document_snapshots snapshot WHERE snapshot.tenant_id=intent.tenant_id AND snapshot.id=intent.document_snapshot_id) ready_snapshots
    FROM artifact_ingest_intents intent WHERE intent.tenant_id='tenant_local' AND intent.id=$1`, [intentId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Ingest intent ${intentId} disappeared`);
  return {
    intentStatus: row.status,
    intentETagObserved: row.intent_etag_observed,
    stateETagObserved: row.state_etag_observed,
    artifacts: Number(row.artifacts),
    manifests: Number(row.manifests),
    readySnapshots: Number(row.ready_snapshots),
    publishedClaims: 0,
    reportArtifacts: 0,
  };
}

async function createPendingTask(caseId: FaultCaseId) {
  const conversationId = await createConversation(caseId);
  const uploaded = await upload(conversationId, caseId);
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
  const projection = await uploaded.json() as { documentSnapshot: { id: string }; artifact: { id: string } };
  const created = await controlPlane.app.inject({
    method: 'POST',
    url: '/api/business-tasks',
    headers: requestHeaders(key(caseId, 'task')),
    payload: {
      conversationId,
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'document_snapshot', documentSnapshotId: projection.documentSnapshot.id },
      expertTarget: { mode: 'team', teamId: 'team.solution.core' },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return {
    conversationId,
    snapshotId: projection.documentSnapshot.id,
    sourceArtifactId: projection.artifact.id,
    ...created.json<{ taskId: string; approvalId: string }>(),
  };
}

async function createApprovedTask(caseId: FaultCaseId) {
  const task = await createPendingTask(caseId);
  const approved = await controlPlane.app.inject({
    method: 'POST',
    url: `/api/approvals/${task.approvalId}/decisions`,
    headers: requestHeaders(key(caseId, 'approve')),
    payload: { decision: 'approved' },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return task;
}

async function enqueue(taskId: string, caseId: FaultCaseId): Promise<void> {
  const task = await controlPlane.app.inject({ method: 'GET', url: `/api/business-tasks/${taskId}` });
  expect(task.statusCode, task.body).toBe(200);
  const approval = task.json<{ approval: { version: number; subjectDigest: string } }>().approval;
  const response = await controlPlane.app.inject({
    method: 'POST',
    url: `/api/business-tasks/${taskId}/execute`,
    headers: requestHeaders(key(caseId, 'execute')),
    payload: { expectedApprovalVersion: approval.version, expectedApprovalSubjectDigest: approval.subjectDigest },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ taskId, status: 'accepted' });
}

async function injectWorker(command: WorkerCommand) {
  return workerApp.inject({
    method: 'POST',
    url: '/internal/worker/v1/commands',
    headers: { authorization: `Bearer ${workerToken}` },
    payload: command,
  });
}

async function sendWorker(command: WorkerCommand) {
  const response = await injectWorker(command);
  expect(response.statusCode, response.body).toBe(200);
  return workerCommandResponseSchema.parse(response.json());
}

async function claimDelivery(workerInstanceId: string): Promise<WorkerDelivery> {
  await sendWorker({
    command: 'session',
    protocolVersion: 'gate0.2a-worker-command/1',
    workerInstanceId,
    consumer: 'gate0.2a-worker',
    deploymentId: 'gate0.2a-local',
  });
  const claimed = await sendWorker({
    command: 'claim_delivery',
    protocolVersion: 'gate0.2a-worker-command/1',
    workerInstanceId,
    consumer: 'gate0.2a-worker',
    deploymentId: 'gate0.2a-local',
  });
  if (claimed.command !== 'claim_delivery' || claimed.result === null) throw new Error('Expected a Worker delivery');
  return claimed.result;
}

function commandBase(delivery: WorkerDelivery) {
  return {
    protocolVersion: 'gate0.2a-worker-command/1' as const,
    workerInstanceId: delivery.workerInstanceId,
    deliveryId: delivery.lease.deliveryId,
    eventId: delivery.lease.eventId,
    attemptId: delivery.lease.attemptId,
    fencingToken: delivery.lease.fencingToken,
  };
}

function candidateFor(delivery: WorkerDelivery): AttemptOutputCandidatePayload {
  const nodes = (delivery.workflow.canonicalPayload as { nodes: Array<{ id: string }> }).nodes;
  return {
    evidence: [{
      kind: 'document_snapshot',
      candidateKey: 'primary-source',
      documentSnapshotId: delivery.inputRef.kind === 'document_snapshot' ? delivery.inputRef.documentSnapshotId : 'invalid',
      startByte: DEMO_EVIDENCE_START_BYTE,
      endByteExclusive: DEMO_EVIDENCE_END_BYTE_EXCLUSIVE,
    }],
    claims: [
      { candidateKey: 'supported-requirement', text: POSITIVE_CLAIM_TEXT, evidenceCandidateKey: 'primary-source' },
      { candidateKey: 'unsupported-device-control', text: UNSUPPORTED_CLAIM_TEXT, evidenceCandidateKey: null },
    ],
    result: {
      kind: 'completed',
      summary: '恢复测试模拟方案分析已完成',
      stepSummaries: nodes.map((node) => `已完成 ${node.id}`),
      ...SIMULATION_ENVELOPE,
    },
  };
}

async function readInput(delivery: WorkerDelivery): Promise<void> {
  const response = await sendWorker({ command: 'read_input', ...commandBase(delivery) });
  expect(response).toMatchObject({ command: 'read_input', result: { kind: 'document_snapshot' } });
}

async function claimStep(delivery: WorkerDelivery, stepId: string, index: number) {
  const response = await sendWorker({
    command: 'claim_step',
    ...commandBase(delivery),
    stepId,
    stepAttemptId: `step-${delivery.lease.attemptId}-${String(index)}`,
    idempotencyKey: `claim-${delivery.lease.attemptId}-${String(index)}`,
  });
  if (response.command !== 'claim_step') throw new Error('Unexpected claim_step response');
  return response.result;
}

async function completeClaimedStep(delivery: WorkerDelivery, stepId: string, index: number, claim: Readonly<{ state: 'claimed'; stepAttemptId: string; fencingToken: number }>): Promise<void> {
  await sendWorker({
    command: 'complete_step',
    ...commandBase(delivery),
    stepId,
    stepAttemptId: claim.stepAttemptId,
    stepFencingToken: claim.fencingToken,
    output: { summary: `已完成 ${stepId}` },
    idempotencyKey: `complete-${delivery.lease.attemptId}-${String(index)}`,
  });
}

async function completeSteps(delivery: WorkerDelivery, startAt = 0): Promise<void> {
  const nodes = (delivery.workflow.canonicalPayload as { nodes: Array<{ id: string }> }).nodes;
  for (const [index, node] of nodes.entries()) {
    if (index < startAt) continue;
    const claim = await claimStep(delivery, node.id, index);
    if (claim.state === 'claimed') await completeClaimedStep(delivery, node.id, index, claim);
  }
}

async function submitCandidate(delivery: WorkerDelivery) {
  return injectWorker({
    command: 'submit_candidate',
    ...commandBase(delivery),
    candidate: candidateFor(delivery),
    idempotencyKey: `submit-${delivery.lease.attemptId}`,
  });
}

async function finishDelivery(delivery: WorkerDelivery): Promise<void> {
  await readInput(delivery);
  await completeSteps(delivery);
  const response = await submitCandidate(delivery);
  expect(response.statusCode, response.body).toBe(200);
}

async function expireDelivery(delivery: WorkerDelivery): Promise<void> {
  const client = await controlPlane.repository.pool.connect();
  const expiredAt = new Date(Date.now() - 10_000);
  try {
    await client.query('BEGIN');
    const attempt = await client.query(`UPDATE execution_attempts SET lease_until=$2
      WHERE tenant_id='tenant_local' AND id=$1 AND status='running'`, [delivery.lease.attemptId, expiredAt]);
    const outboxDelivery = await client.query(`UPDATE outbox_deliveries SET lease_until=$2
      WHERE tenant_id='tenant_local' AND id=$1 AND status='leased'`, [delivery.lease.deliveryId, expiredAt]);
    expect(attempt.rowCount).toBe(1);
    expect(outboxDelivery.rowCount).toBe(1);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function taskFinal(taskId: string) {
  const result = await controlPlane.repository.pool.query<{
    status: string;
    attempts: string;
    current_attempts: string;
    deliveries: string;
    inboxes: string;
    candidates: string;
    claims: string;
    published_claims: string;
    claim_duplicates: string;
    evidence: string;
    report_artifacts: string;
    report_intents: string;
    ready_snapshots: string;
    events: string;
  }>(`SELECT task.status,
      (SELECT count(*)::text FROM execution_attempts attempt WHERE attempt.tenant_id=task.tenant_id AND attempt.business_task_id=task.id) attempts,
      (SELECT count(*)::text FROM execution_attempts attempt WHERE attempt.tenant_id=task.tenant_id AND attempt.id=task.current_execution_attempt_id) current_attempts,
      (SELECT count(*)::text FROM outbox_deliveries delivery WHERE delivery.tenant_id=task.tenant_id AND delivery.business_task_id=task.id) deliveries,
      (SELECT count(*)::text FROM inbox_events inbox WHERE inbox.tenant_id=task.tenant_id AND inbox.business_task_id=task.id) inboxes,
      (SELECT count(*)::text FROM attempt_output_candidates candidate WHERE candidate.tenant_id=task.tenant_id AND candidate.business_task_id=task.id) candidates,
      (SELECT count(*)::text FROM claims claim WHERE claim.tenant_id=task.tenant_id AND claim.business_task_id=task.id) claims,
      (SELECT count(*)::text FROM claims claim WHERE claim.tenant_id=task.tenant_id AND claim.business_task_id=task.id AND claim.status='published') published_claims,
      (SELECT count(*)::text FROM (SELECT text FROM claims claim WHERE claim.tenant_id=task.tenant_id AND claim.business_task_id=task.id GROUP BY text HAVING count(*)>1) duplicate) claim_duplicates,
      (SELECT count(*)::text FROM evidence_items evidence WHERE evidence.tenant_id=task.tenant_id AND evidence.business_task_id=task.id) evidence,
      (SELECT count(*)::text FROM artifacts artifact WHERE artifact.tenant_id=task.tenant_id AND artifact.business_task_id=task.id AND artifact.kind='simulation_report') report_artifacts,
      (SELECT count(*)::text FROM report_publish_intents intent WHERE intent.tenant_id=task.tenant_id AND intent.business_task_id=task.id) report_intents,
      (SELECT count(*)::text FROM document_snapshots snapshot WHERE snapshot.tenant_id=task.tenant_id AND snapshot.id=task.input_snapshot->>'documentSnapshotId') ready_snapshots,
      (SELECT count(*)::text FROM business_task_events event WHERE event.tenant_id=task.tenant_id AND event.business_task_id=task.id) events
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
    claims: Number(row.claims),
    publishedClaims: Number(row.published_claims),
    duplicateClaims: Number(row.claim_duplicates),
    evidence: Number(row.evidence),
    reportArtifacts: Number(row.report_artifacts),
    reportIntents: Number(row.report_intents),
    readySnapshots: Number(row.ready_snapshots),
    events: Number(row.events),
  };
}

async function expectCompletedOnce(taskId: string) {
  const final = await taskFinal(taskId);
  expect(final).toMatchObject({
    taskStatus: 'completed',
    currentAttempts: 1,
    deliveries: 1,
    inboxes: 1,
    claims: 2,
    publishedClaims: 1,
    duplicateClaims: 0,
    evidence: 1,
    reportArtifacts: 1,
    reportIntents: 1,
    readySnapshots: 1,
  });
  return final;
}

beforeAll(async () => {
  fixtureBytes = await readFile(new URL('../../../scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt', import.meta.url));
});

beforeEach(async () => {
  await startControlPlane();
  await controlPlane.repository.resetForTest();
});

afterEach(async () => closeApps());

afterAll(async () => {
  const observed = new Set(results.map((result) => result.case_id));
  const missing = requiredCaseIds.filter((caseId) => !observed.has(caseId));
  const duplicates = requiredCaseIds.filter((caseId) => results.filter((result) => result.case_id === caseId).length !== 1);
  const untriggered = results.filter((result) => result.fault_triggered !== true).map((result) => result.case_id);
  const duplicateOutputs = results.filter((result) => Number(result.final.publishedClaims ?? 0) > 1
    || Number(result.final.reportArtifacts ?? 0) > 1).map((result) => result.case_id);
  const summary = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    required_case_ids: requiredCaseIds,
    cases: results,
    missing_case_ids: missing,
    duplicate_case_ids: duplicates,
    untriggered_case_ids: untriggered,
    duplicate_output_case_ids: duplicateOutputs,
    passed: missing.length === 0 && duplicates.length === 0 && untriggered.length === 0 && duplicateOutputs.length === 0,
  };
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  expect(summary.missing_case_ids).toEqual([]);
  expect(summary.duplicate_case_ids).toEqual([]);
  expect(summary.untriggered_case_ids).toEqual([]);
  expect(summary.duplicate_output_case_ids).toEqual([]);
});

describe.sequential('Gate 0.2A required recovery fault matrix', () => {
  it('after_intent_commit_before_s3_put', async () => {
    const caseId = 'after_intent_commit_before_s3_put';
    let faultTriggered = false;
    const storage: ObjectStorage = {
      bucket: realStorage.bucket,
      putCreateOnly() {
        faultTriggered = true;
        return Promise.reject(new Error('FAULT_AFTER_INTENT_BEFORE_PUT'));
      },
      head: (objectKey) => realStorage.head(objectKey),
      getBytes: (objectKey, maximum) => realStorage.getBytes(objectKey, maximum),
    };
    await restartControlPlane(storage);
    const conversationId = await createConversation(caseId);
    const response = await upload(conversationId, caseId);
    expect(response.status).toBe(502);
    const intent = await loadIntent(caseId);
    const final = await ingestCounts(intent.id);
    expect(faultTriggered).toBe(true);
    expect(final).toMatchObject({ intentStatus: 'reconcile_required', artifacts: 0, manifests: 0, readySnapshots: 0 });
    record({
      case_id: caseId,
      fault_triggered: true,
      trigger: { boundary: 'intent committed; first storage PUT rejected before delegation' },
      entity_ids: { conversationId, intentId: intent.id, artifactId: intent.artifact_id },
      final,
    });
  }, 30_000);

  it('after_s3_put_before_db_finalize', async () => {
    const caseId = 'after_s3_put_before_db_finalize';
    let sourcePut = false;
    let faultTriggered = false;
    const storage: ObjectStorage = {
      bucket: realStorage.bucket,
      async putCreateOnly(input) {
        const result = await realStorage.putCreateOnly(input);
        sourcePut = true;
        return result;
      },
      async head(objectKey) {
        if (sourcePut && !faultTriggered) {
          faultTriggered = true;
          throw new Error('FAULT_AFTER_PUT_BEFORE_FINALIZE');
        }
        return realStorage.head(objectKey);
      },
      getBytes: (objectKey, maximum) => realStorage.getBytes(objectKey, maximum),
    };
    await restartControlPlane(storage);
    const conversationId = await createConversation(caseId);
    const interrupted = await upload(conversationId, caseId);
    expect(interrupted.status).toBe(502);
    const intent = await loadIntent(caseId);
    expect(intent.status).toBe('reconcile_required');
    const recovered = await upload(conversationId, caseId);
    expect(recovered.status, await recovered.clone().text()).toBe(201);
    const final = await ingestCounts(intent.id);
    expect(final).toMatchObject({ intentStatus: 'ready', artifacts: 1, manifests: 1, readySnapshots: 1 });
    expect(typeof final.intentETagObserved).toBe('string');
    expect(typeof final.stateETagObserved).toBe('string');
    expect(final.intentETagObserved).toBe(final.stateETagObserved);
    record({
      case_id: caseId,
      fault_triggered: true,
      trigger: { boundary: 'S3 PUT committed; first verification HEAD failed' },
      entity_ids: { conversationId, intentId: intent.id, artifactId: intent.artifact_id, snapshotId: intent.document_snapshot_id },
      final,
    });
  }, 30_000);

  it('put_response_lost', async () => {
    const caseId = 'put_response_lost';
    let faultTriggered = false;
    const storage: ObjectStorage = {
      bucket: realStorage.bucket,
      async putCreateOnly(input) {
        const result = await realStorage.putCreateOnly(input);
        if (!faultTriggered) {
          faultTriggered = true;
          throw new Error('FAULT_PUT_RESPONSE_LOST');
        }
        return result;
      },
      head: (objectKey) => realStorage.head(objectKey),
      getBytes: (objectKey, maximum) => realStorage.getBytes(objectKey, maximum),
    };
    await restartControlPlane(storage);
    const conversationId = await createConversation(caseId);
    const interrupted = await upload(conversationId, caseId);
    expect(interrupted.status).toBe(502);
    const intent = await loadIntent(caseId);
    expect(intent.status).toBe('reconcile_required');
    const recovered = await upload(conversationId, caseId);
    expect(recovered.status, await recovered.clone().text()).toBe(201);
    const final = await ingestCounts(intent.id);
    expect(final).toMatchObject({ intentStatus: 'ready', artifacts: 1, manifests: 1, readySnapshots: 1 });
    expect(typeof final.intentETagObserved).toBe('string');
    expect(typeof final.stateETagObserved).toBe('string');
    expect(final.intentETagObserved).toBe(final.stateETagObserved);
    record({
      case_id: caseId,
      fault_triggered: true,
      trigger: { boundary: 'S3 PUT committed; caller observed a lost response' },
      entity_ids: { conversationId, intentId: intent.id, artifactId: intent.artifact_id, snapshotId: intent.document_snapshot_id },
      final,
    });
  }, 30_000);

  it('after_outbox_commit_before_worker_claim', async () => {
    const caseId = 'after_outbox_commit_before_worker_claim';
    const task = await createApprovedTask(caseId);
    await enqueue(task.taskId, caseId);
    const boundary = await controlPlane.repository.pool.query<{ outboxes: string; deliveries: string }>(`SELECT
      (SELECT count(*)::text FROM outbox_events WHERE business_task_id=$1 AND event_type='workflow.execute.requested') outboxes,
      (SELECT count(*)::text FROM outbox_deliveries WHERE business_task_id=$1) deliveries`, [task.taskId]);
    expect(boundary.rows[0]).toEqual({ outboxes: '1', deliveries: '0' });
    const delivery = await claimDelivery(`worker-${caseId}`);
    await finishDelivery(delivery);
    const final = await expectCompletedOnce(task.taskId);
    record({ case_id: caseId, fault_triggered: true,
      trigger: { boundary: 'outbox committed with no delivery', ...boundary.rows[0] },
      entity_ids: { taskId: task.taskId, eventId: delivery.lease.eventId, attemptId: delivery.lease.attemptId }, final });
  }, 30_000);

  it('after_inbox_insert_before_step_execution', async () => {
    const caseId = 'after_inbox_insert_before_step_execution';
    const task = await createApprovedTask(caseId);
    await enqueue(task.taskId, caseId);
    const first = await claimDelivery(`worker-${caseId}-old`);
    const inbox = await controlPlane.repository.pool.query<{ status: string }>(`SELECT status FROM inbox_events
      WHERE business_task_id=$1 AND execution_attempt_id=$2`, [task.taskId, first.lease.attemptId]);
    expect(inbox.rows).toEqual([{ status: 'received' }]);
    await expireDelivery(first);
    await restartWorker();
    const replacement = await claimDelivery(`worker-${caseId}-new`);
    expect(replacement.lease.attemptId).not.toBe(first.lease.attemptId);
    await finishDelivery(replacement);
    const final = await expectCompletedOnce(task.taskId);
    expect(final.attempts).toBe(2);
    record({ case_id: caseId, fault_triggered: true,
      trigger: { boundary: 'inbox received persisted before read_input or step execution' },
      entity_ids: { taskId: task.taskId, attemptIds: [first.lease.attemptId, replacement.lease.attemptId] }, final });
  }, 30_000);

  it('after_step_side_effect_before_completion', async () => {
    const caseId = 'after_step_side_effect_before_completion';
    const task = await createApprovedTask(caseId);
    await enqueue(task.taskId, caseId);
    const first = await claimDelivery(`worker-${caseId}-old`);
    await readInput(first);
    const firstNode = (first.workflow.canonicalPayload as { nodes: Array<{ id: string }> }).nodes[0];
    if (firstNode === undefined) throw new Error('Workflow has no first node');
    const claimed = await claimStep(first, firstNode.id, 0);
    expect(claimed.state).toBe('claimed');
    const computedButUnacknowledged = { summary: `已完成 ${firstNode.id}` };
    await expireDelivery(first);
    await restartWorker();
    const replacement = await claimDelivery(`worker-${caseId}-new`);
    await finishDelivery(replacement);
    const final = await expectCompletedOnce(task.taskId);
    expect(final.attempts).toBe(2);
    record({ case_id: caseId, fault_triggered: true,
      trigger: { boundary: 'step output computed after claim but before complete_step', computedButUnacknowledged },
      entity_ids: { taskId: task.taskId, stepId: firstNode.id, attemptIds: [first.lease.attemptId, replacement.lease.attemptId] }, final });
  }, 30_000);

  it('after_report_put_before_db_publish', async () => {
    const caseId = 'after_report_put_before_db_publish';
    let reportPut = false;
    let faultTriggered = false;
    const storage: ObjectStorage = {
      bucket: realStorage.bucket,
      async putCreateOnly(input) {
        const result = await realStorage.putCreateOnly(input);
        if (input.key.endsWith('/report.md')) reportPut = true;
        return result;
      },
      async head(objectKey) {
        if (reportPut && objectKey.endsWith('/report.md') && !faultTriggered) {
          faultTriggered = true;
          throw new Error('FAULT_AFTER_REPORT_PUT_BEFORE_DB_PUBLISH');
        }
        return realStorage.head(objectKey);
      },
      getBytes: (objectKey, maximum) => realStorage.getBytes(objectKey, maximum),
    };
    await restartControlPlane(storage);
    const task = await createApprovedTask(caseId);
    await enqueue(task.taskId, caseId);
    const first = await claimDelivery(`worker-${caseId}-old`);
    await readInput(first);
    await completeSteps(first);
    const interrupted = await submitCandidate(first);
    expect(interrupted.statusCode).toBe(500);
    const prepared = await controlPlane.repository.pool.query<{ id: string; storage_key: string; status: string }>(`SELECT id,storage_key,status
      FROM report_publish_intents WHERE business_task_id=$1`, [task.taskId]);
    expect(prepared.rows).toHaveLength(1);
    expect(prepared.rows[0]?.status).toBe('reconcile_required');
    await expect(realStorage.head(prepared.rows[0]?.storage_key ?? 'missing')).resolves.toMatchObject({ contentType: 'text/markdown' });
    await expireDelivery(first);
    await restartWorker(realStorage);
    const replacement = await claimDelivery(`worker-${caseId}-new`);
    await finishDelivery(replacement);
    const final = await expectCompletedOnce(task.taskId);
    expect(final.attempts).toBe(2);
    expect(final.candidates).toBe(2);
    record({ case_id: caseId, fault_triggered: true,
      trigger: { boundary: 'report object exists while report intent is durably marked reconcile_required', reportIntentStatus: prepared.rows[0]?.status },
      entity_ids: { taskId: task.taskId, reportIntentId: prepared.rows[0]?.id ?? '', attemptIds: [first.lease.attemptId, replacement.lease.attemptId] }, final });
  }, 30_000);

  it('stale_attempt_completion', async () => {
    const caseId = 'stale_attempt_completion';
    const task = await createApprovedTask(caseId);
    await enqueue(task.taskId, caseId);
    const first = await claimDelivery(`worker-${caseId}-old`);
    await readInput(first);
    const firstNode = (first.workflow.canonicalPayload as { nodes: Array<{ id: string }> }).nodes[0];
    if (firstNode === undefined) throw new Error('Workflow has no first node');
    const oldClaim = await claimStep(first, firstNode.id, 0);
    if (oldClaim.state !== 'claimed') throw new Error('Expected first attempt to claim the first step');
    await expireDelivery(first);
    await restartWorker();
    const replacement = await claimDelivery(`worker-${caseId}-new`);
    const stale = await injectWorker({
      command: 'complete_step',
      ...commandBase(first),
      stepId: firstNode.id,
      stepAttemptId: oldClaim.stepAttemptId,
      stepFencingToken: oldClaim.fencingToken,
      output: { summary: '迟到的旧 attempt 完成' },
      idempotencyKey: `stale-complete-${first.lease.attemptId}`,
    });
    expect(stale.statusCode).toBe(409);
    await finishDelivery(replacement);
    const final = await expectCompletedOnce(task.taskId);
    expect(final.attempts).toBe(2);
    record({ case_id: caseId, fault_triggered: true,
      trigger: { boundary: 'old fenced attempt submitted complete_step after reclaim', staleStatusCode: stale.statusCode },
      entity_ids: { taskId: task.taskId, stepId: firstNode.id, attemptIds: [first.lease.attemptId, replacement.lease.attemptId] }, final });
  }, 30_000);

  it('cancel_vs_publish', async () => {
    const caseId = 'cancel_vs_publish';
    let releaseReportHead = () => {};
    let reportHeadReachedResolve = () => {};
    const release = new Promise<void>((resolve) => { releaseReportHead = resolve; });
    const reportHeadReached = new Promise<void>((resolve) => { reportHeadReachedResolve = resolve; });
    let faultTriggered = false;
    const storage: ObjectStorage = {
      bucket: realStorage.bucket,
      putCreateOnly: (input) => realStorage.putCreateOnly(input),
      async head(objectKey) {
        if (objectKey.endsWith('/report.md') && !faultTriggered) {
          faultTriggered = true;
          reportHeadReachedResolve();
          await release;
        }
        return realStorage.head(objectKey);
      },
      getBytes: (objectKey, maximum) => realStorage.getBytes(objectKey, maximum),
    };
    await restartControlPlane(storage);
    const task = await createApprovedTask(caseId);
    await enqueue(task.taskId, caseId);
    const delivery = await claimDelivery(`worker-${caseId}`);
    await readInput(delivery);
    await completeSteps(delivery);
    const publishing = submitCandidate(delivery);
    await Promise.race([
      reportHeadReached,
      delay(5_000).then(() => { throw new Error('Report publish did not reach the injected boundary'); }),
    ]);
    const canceled = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/business-tasks/${task.taskId}/cancel`,
      headers: requestHeaders(key(caseId, 'cancel')),
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json()).toEqual({ taskId: task.taskId, status: 'canceled' });
    releaseReportHead();
    const latePublish = await publishing;
    expect(latePublish.statusCode).toBe(409);
    const final = await taskFinal(task.taskId);
    expect(final).toMatchObject({ taskStatus: 'canceled', claims: 0, publishedClaims: 0, reportArtifacts: 0, reportIntents: 1 });
    record({ case_id: caseId, fault_triggered: true,
      trigger: { boundary: 'cancel committed while report HEAD was blocked after object PUT', latePublishStatusCode: latePublish.statusCode },
      entity_ids: { taskId: task.taskId, attemptId: delivery.lease.attemptId }, final });
  }, 30_000);

  it('sse_snapshot_subscribe_gap', async () => {
    const caseId = 'sse_snapshot_subscribe_gap';
    const task = await createPendingTask(caseId);
    const snapshot = await controlPlane.app.inject({ method: 'GET', url: `/api/business-tasks/${task.taskId}` });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    const watermark = snapshot.json<{ eventWatermark: number }>().eventWatermark;
    const approved = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${task.approvalId}/decisions`,
      headers: requestHeaders(key(caseId, 'approve-after-snapshot')),
      payload: { decision: 'approved' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const sse = await controlPlane.app.inject({
      method: 'GET',
      url: `/api/business-tasks/${task.taskId}/events?after=${String(watermark)}`,
      headers: { accept: 'text/event-stream' },
    });
    expect(sse.statusCode, sse.body).toBe(200);
    const ids = [...sse.body.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));
    const authoritative = await controlPlane.repository.getEvents(principal, task.taskId, watermark);
    const authoritativeIds = authoritative.map((event) => Number(event.cursor));
    expect(ids).toEqual(authoritativeIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((cursor) => cursor > watermark)).toBe(true);
    const final = await taskFinal(task.taskId);
    record({ case_id: caseId, fault_triggered: true,
      trigger: { boundary: 'approval event committed between snapshot watermark and SSE subscribe', watermark, resumedEventIds: ids },
      entity_ids: { taskId: task.taskId, approvalId: task.approvalId, eventIds: ids.map(String) }, final });
  }, 30_000);

  it('control_plane_restart', async () => {
    const caseId = 'control_plane_restart';
    const task = await createApprovedTask(caseId);
    await enqueue(task.taskId, caseId);
    const before = await controlPlane.repository.pool.query<{ count: string }>(`SELECT count(*)::text count FROM outbox_events
      WHERE business_task_id=$1 AND event_type='workflow.execute.requested'`, [task.taskId]);
    expect(before.rows).toEqual([{ count: '1' }]);
    await restartControlPlane();
    const delivery = await claimDelivery(`worker-${caseId}`);
    await finishDelivery(delivery);
    const final = await expectCompletedOnce(task.taskId);
    record({ case_id: caseId, fault_triggered: true,
      trigger: { boundary: 'Control Plane Fastify app and PostgreSQL pool closed after outbox commit, then recreated' },
      entity_ids: { taskId: task.taskId, attemptId: delivery.lease.attemptId }, final });
  }, 30_000);

  it('worker_restart', async () => {
    const caseId = 'worker_restart';
    const task = await createApprovedTask(caseId);
    await enqueue(task.taskId, caseId);
    const first = await claimDelivery(`worker-${caseId}-old`);
    await readInput(first);
    const nodes = (first.workflow.canonicalPayload as { nodes: Array<{ id: string }> }).nodes;
    for (const [index, node] of nodes.slice(0, 2).entries()) {
      const claim = await claimStep(first, node.id, index);
      if (claim.state === 'claimed') await completeClaimedStep(first, node.id, index, claim);
    }
    const checkpoint = await controlPlane.repository.pool.query<{ count: string }>(`SELECT count(*)::text count FROM business_task_steps
      WHERE business_task_id=$1 AND status='completed'`, [task.taskId]);
    expect(checkpoint.rows).toEqual([{ count: '2' }]);
    await workerApp.close();
    await expireDelivery(first);
    workerApp = createWorkerCommandApp({ repository: controlPlane.repository, storage: realStorage, token: workerToken, leaseDurationMs: 5_000 });
    const replacement = await claimDelivery(`worker-${caseId}-new`);
    await finishDelivery(replacement);
    const final = await expectCompletedOnce(task.taskId);
    expect(final.attempts).toBe(2);
    record({ case_id: caseId, fault_triggered: true,
      trigger: { boundary: 'Worker command Fastify app closed after two durable checkpoints, then recreated' },
      entity_ids: { taskId: task.taskId, attemptIds: [first.lease.attemptId, replacement.lease.attemptId] }, final });
  }, 30_000);

  it('closes an expired-authority delivery instead of leaving it permanently unclaimable', async () => {
    const caseId = 'worker_restart';
    const task = await createApprovedTask(caseId);
    await enqueue(task.taskId, caseId);
    const delivery = await claimDelivery('worker-expired-authority-old');
    await expireDelivery(delivery);
    await controlPlane.repository.pool.query(
      `UPDATE approval_versions SET expires_at=now()-interval '1 second'
       WHERE tenant_id='tenant_local' AND business_task_id=$1`,
      [task.taskId],
    );
    await controlPlane.repository.pool.query(
      `UPDATE delegated_capabilities SET expires_at=now()-interval '1 second'
       WHERE tenant_id='tenant_local' AND business_task_id=$1`,
      [task.taskId],
    );

    await sendWorker({
      command: 'session',
      protocolVersion: 'gate0.2a-worker-command/1',
      workerInstanceId: 'worker-expired-authority-new',
      consumer: 'gate0.2a-worker',
      deploymentId: 'gate0.2a-local',
    });
    const claim = await sendWorker({
      command: 'claim_delivery',
      protocolVersion: 'gate0.2a-worker-command/1',
      workerInstanceId: 'worker-expired-authority-new',
      consumer: 'gate0.2a-worker',
      deploymentId: 'gate0.2a-local',
    });
    expect(claim).toEqual({ command: 'claim_delivery', ok: true, result: null });

    const final = await taskFinal(task.taskId);
    expect(final.taskStatus).toBe('failed');
    const persisted = await controlPlane.repository.pool.query<{
      attempt_status: string;
      delivery_status: string;
      inbox_status: string;
      task_result: { code?: string } | null;
      expiry_events: string;
    }>(`SELECT attempt.status attempt_status,delivery.status delivery_status,inbox.status inbox_status,
        task.result task_result,
        (SELECT count(*)::text FROM business_task_events event
         WHERE event.tenant_id=task.tenant_id AND event.business_task_id=task.id
           AND event.payload->>'code'='EXECUTION_AUTHORITY_EXPIRED') expiry_events
      FROM business_tasks task
      JOIN execution_attempts attempt ON attempt.tenant_id=task.tenant_id AND attempt.id=$2
      JOIN outbox_deliveries delivery ON delivery.tenant_id=task.tenant_id AND delivery.id=$3
      JOIN inbox_events inbox ON inbox.tenant_id=task.tenant_id AND inbox.business_task_id=task.id
      WHERE task.tenant_id='tenant_local' AND task.id=$1`, [
      task.taskId, delivery.lease.attemptId, delivery.lease.deliveryId,
    ]);
    const persistedRow = persisted.rows[0];
    expect(persistedRow).toMatchObject({
      attempt_status: 'failed',
      delivery_status: 'failed',
      inbox_status: 'failed',
      expiry_events: '1',
    });
    expect(persistedRow?.task_result?.code).toBe('EXECUTION_AUTHORITY_EXPIRED');
    const secondClaim = await sendWorker({
      command: 'claim_delivery',
      protocolVersion: 'gate0.2a-worker-command/1',
      workerInstanceId: 'worker-expired-authority-new',
      consumer: 'gate0.2a-worker',
      deploymentId: 'gate0.2a-local',
    });
    expect(secondClaim).toEqual({ command: 'claim_delivery', ok: true, result: null });
  }, 30_000);
});
