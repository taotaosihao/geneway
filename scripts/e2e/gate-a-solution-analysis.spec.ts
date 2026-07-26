/**
 * Gate A.1 served acceptance dependencies (all are public/authority surfaces):
 * - GET /api/capabilities/solution.analysis.v1 returns gateACapabilityRouteProjectionSchema.
 * - DocumentSnapshot list projects gateADocumentExecutionEligibilitySchema per item.
 * - BusinessTask create/read/events, Workflow read and Evidence read return the
 *   strict live variants from packages/contracts/src/gate-a-public.ts.
 * - The disposable Gate A live project boots an internal release whose evidence
 *   runId equals GENEWAY_RUN_ID, a registered C1 text parser, the real Worker and
 *   the loopback Model Gateway. This spec never reads provider credentials.
 * - Postgres migration 0008 is the correlation authority for live task,
 *   invocation, result, claim/evidence/link and analysis_report records.
 *
 * These are deliberate executable dependencies. A missing endpoint, legacy
 * projection, unknown discriminator or absent correlation must fail this spec;
 * no route stub, synthetic SSE, FakeRuntime or browser-side provider call is
 * permitted as a substitute.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Download, type Locator, type Page } from '@playwright/test';
import {
  gateACapabilityRouteProjectionSchema,
  gateALiveEvidenceProjectionSchema,
  gateALiveTaskCreateResponseSchema,
  gateALiveTaskEventListResponseSchema,
  gateALiveTaskSnapshotSchema,
  gateALiveWorkflowDetailProjectionSchema,
  type GateALiveTaskSnapshot,
} from '@geneway/contracts';
import pg from 'pg';
import {
  gateACancelMaterialBytes,
  gateANegativeMaterialBytes,
  gateAReauthorizationMaterialBytes,
  gateARevokedSourceMaterialBytes,
  loadGateADocumentFixture,
} from './gate-a-c1-materials.js';

const { Pool } = pg;
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
const runId = process.env.GENEWAY_RUN_ID;
const modelGatewaySupervisorPort = Number(process.env.GENEWAY_MODEL_GATEWAY_SUPERVISOR_PORT);
const workerTokenFile = process.env.GENEWAY_WORKER_TOKEN_FILE;
if (databaseUrl === undefined || runId === undefined || workerTokenFile === undefined
  || !Number.isInteger(modelGatewaySupervisorPort) || process.env.GENEWAY_GATE_A_LIVE !== '1') {
  throw new Error('gate-a-live requires disposable Postgres and the explicit real-provider Gate A harness');
}
const pool = new Pool({ connectionString: databaseUrl });
const forbiddenFallbackPattern = /FakeRuntime|runtimeMode["'=:\s]+fake|simulation["'=:\s]+true|providerApiKey|authorization:\s*Bearer/iu;

type ChatSnapshot = Readonly<{
  latestTaskId: string | null;
  latestModelInvocation: Readonly<{
    id: string;
    assistantMessageId: string;
    status: string;
  }> | null;
  messages: readonly Readonly<{
    id: string;
    author: string;
    body: string;
    status: string;
  }>[];
}>;

type ProcessIdentity = Readonly<{
  pid: number;
  procStartTicks: string;
  generation: number;
}>;

type UploadedMaterial = Readonly<{
  card: Locator;
  artifactId: string;
  snapshotId: string;
  contentSha256: string;
}>;

type SuccessfulRun = Readonly<{
  task: GateALiveTaskSnapshot;
  create: ReturnType<typeof gateALiveTaskCreateResponseSchema.parse>;
  material: UploadedMaterial;
  reportBytes: Buffer;
}>;

let successfulRun: SuccessfulRun | undefined;
let canceledRun: Readonly<{ taskId: string; conversationId: string }> | undefined;
let failedRun: Readonly<{ taskId: string; conversationId: string }> | undefined;

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function supervisorRequest<T>(
  route: string,
  body: unknown,
): Promise<Readonly<{ status: number; body: T }>> {
  const token = (await readFile(workerTokenFile ?? '', 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${String(modelGatewaySupervisorPort)}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as T };
}

async function waitModelGatewaySupervisorReady(): Promise<void> {
  await expect.poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${String(modelGatewaySupervisorPort)}/health`)).ok; }
    catch { return false; }
  }, { timeout: 20_000, intervals: [25, 50, 100] }).toBe(true);
}

async function resumeModelGatewaySupervisor(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const resumed = await supervisorRequest<Readonly<{ error?: string; restartScheduled?: boolean }>>(
      '/test/resume-model-gateway',
      {},
    );
    if (resumed.status === 202 && resumed.body.restartScheduled === true) return;
    if (resumed.status !== 409 || resumed.body.error !== 'E2E_MODEL_GATEWAY_NOT_PAUSED') {
      throw new Error('Run-bound Model Gateway supervisor rejected resume', { cause: resumed });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Run-bound Model Gateway did not reach a resumable stopped state');
}

async function downloadBytes(page: Page, trigger: Locator): Promise<Readonly<{ download: Download; bytes: Buffer }>> {
  const pending = page.waitForEvent('download');
  await trigger.click();
  const download = await pending;
  const downloadPath = await download.path();
  if (downloadPath === null) throw new Error('Browser did not retain the downloaded Gate A Artifact');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    createReadStream(downloadPath)
      .on('data', (chunk) => { chunks.push(Buffer.from(chunk)); })
      .once('end', () => resolve(Buffer.concat(chunks)))
      .once('error', reject);
  });
  return { download, bytes };
}

async function waitForChat(
  request: APIRequestContext,
  conversationId: string,
  invocationId: string,
  status: 'completed' | 'canceled',
): Promise<ChatSnapshot> {
  let latest: ChatSnapshot | undefined;
  await expect.poll(async () => {
    const response = await request.get(`/api/conversations/${conversationId}`);
    expect(response.ok()).toBe(true);
    latest = await response.json() as ChatSnapshot;
    return latest.latestModelInvocation?.id === invocationId
      ? latest.latestModelInvocation.status
      : undefined;
  }, { timeout: 120_000, intervals: [50, 100, 200] }).toBe(status);
  if (latest === undefined) throw new Error('Fast Chat authority snapshot did not materialize');
  return latest;
}

async function sendChat(page: Page, conversationId: string, content: string): Promise<string> {
  await page.getByLabel('给小纬发消息').fill(content);
  const pending = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/conversations/${conversationId}/chat-runs`);
  await page.getByRole('button', { name: '发送' }).click();
  const response = await pending;
  const body = await response.json() as Readonly<{ modelInvocationId?: string; error?: unknown }>;
  expect(response.status(), JSON.stringify(body)).toBe(202);
  expect(body.modelInvocationId).toMatch(/^model_invocation_/u);
  if (body.modelInvocationId === undefined) throw new Error('Fast Chat create response omitted ModelInvocationId');
  return body.modelInvocationId;
}

async function enterLiveAnalysis(page: Page, request: APIRequestContext): Promise<string> {
  const documentResponse = await page.goto('/conversations/new');
  expect(documentResponse?.status()).toBe(200);
  const chat = page.getByTestId('geneway-fast-chat');
  await expect(chat).toBeVisible();
  await expect.poll(() => chat.getAttribute('data-conversation-id')).toMatch(/^conversation_/u);
  const conversationId = await chat.getAttribute('data-conversation-id');
  if (conversationId === null) throw new Error('Default Fast Chat did not expose ConversationId');

  const capabilityResponse = await request.get('/api/capabilities/solution.analysis.v1');
  expect(capabilityResponse.ok()).toBe(true);
  const capability = gateACapabilityRouteProjectionSchema.parse(await capabilityResponse.json());
  expect(capability).toMatchObject({
    capabilityId: 'solution.analysis.v1',
    status: 'internal',
    executionRoute: 'live',
    availableExpertModes: ['auto'],
    simulation: false,
    runtimeMode: 'model_gateway',
    businessDecisionAllowed: false,
    internalAcceptance: true,
  });

  await page.getByTestId('material-analysis-link').click();
  await expect(page).toHaveURL(new RegExp(
    `/conversations/${conversationId.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\?capability=solution\\.analysis\\.v1$`,
    'u',
  ));
  await expect(page.getByTestId('geneway-app')).toBeVisible();
  await expect(page.getByTestId('internal-acceptance-notice')).toContainText('runtimeMode=model_gateway');
  await expect(page.getByLabel('专家路线').locator('option[value="expert.solution.architect"]'))
    .toHaveAttribute('disabled', '');
  await expect(page.getByLabel('专家路线').locator('option[value="team.solution.core"]'))
    .toHaveAttribute('disabled', '');
  await expect(page.getByLabel('专家路线')).toHaveValue('auto');
  return conversationId;
}

async function uploadLiveMaterial(page: Page, name: string, bytes: Buffer): Promise<UploadedMaterial> {
  const expectedHash = sha256(bytes);
  const mimeType = name.endsWith('.pdf') ? 'application/pdf'
    : name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/plain';
  await page.getByTestId('artifact-upload-input').setInputFiles({
    name,
    mimeType,
    buffer: bytes,
  });
  const card = page.getByTestId('artifact-card').filter({ hasText: name });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-execution-route', 'live');
  await expect(card).toHaveAttribute('data-media-type', mimeType);
  await expect(card.getByTestId('artifact-hash')).toHaveText(`sha256:${expectedHash}`);
  await expect(card.getByTestId('artifact-eligibility')).toContainText('可用于真实分析');
  await expect(card.getByTestId('snapshot-execution-route')).toContainText('Parser');
  const artifactId = await card.getAttribute('data-artifact-id');
  const snapshotId = await card.getAttribute('data-snapshot-id');
  if (artifactId === null || snapshotId === null) throw new Error('Live material card omitted authority identifiers');
  await card.getByRole('button', { name: '选择用于分析' }).click();
  await expect(card.getByRole('button', { name: '已选择用于本次任务' })).toBeVisible();
  return { card, artifactId, snapshotId, contentSha256: expectedHash };
}

async function createTaskFromUi(page: Page, prompt: string) {
  await page.getByLabel('给小纬发消息').fill(prompt);
  const pending = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/business-tasks');
  await page.getByRole('button', { name: '发送' }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  return gateALiveTaskCreateResponseSchema.parse(await response.json());
}

async function waitForTask(
  request: APIRequestContext,
  taskId: string,
  expected: 'completed' | 'failed' | 'canceled',
): Promise<GateALiveTaskSnapshot> {
  let latest: GateALiveTaskSnapshot | undefined;
  await expect.poll(async () => {
    const response = await request.get(`/api/business-tasks/${taskId}`);
    expect(response.ok()).toBe(true);
    latest = gateALiveTaskSnapshotSchema.parse(await response.json());
    return latest.status;
  }, { timeout: 180_000, intervals: [100, 200, 500] }).toBe(expected);
  if (latest === undefined) throw new Error('Gate A TaskSnapshot did not materialize');
  return latest;
}

async function createAndStartLiveTask(
  page: Page,
  request: APIRequestContext,
  name: string,
  bytes: Buffer,
  prompt: string,
): Promise<Readonly<{
  conversationId: string;
  material: UploadedMaterial;
  create: ReturnType<typeof gateALiveTaskCreateResponseSchema.parse>;
}>> {
  const conversationId = await enterLiveAnalysis(page, request);
  const material = await uploadLiveMaterial(page, name, bytes);
  const create = await createTaskFromUi(page, prompt);
  const taskCard = page.getByTestId('task-card');
  await expect(taskCard).toHaveAttribute('data-task-id', create.taskId);
  await expect(taskCard).toHaveAttribute('data-record-variant', 'business-task.live/1');
  await expect(taskCard).toContainText('可信本机内部验收');
  await expect(page.getByTestId('workflow-graph').locator('.react-flow__node')).toHaveCount(7);
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '批准并运行真实分析' }).click();
  return { conversationId, material, create };
}

test.describe.serial('Gate A.1 real served material analysis', () => {
  test.afterAll(async () => pool.end());

  test('默认 Fast Chat 首问、追问、停止与刷新保持零 BusinessTask', async ({ page, request }) => {
    test.setTimeout(300_000);
    const response = await page.goto('/conversations/new');
    expect(response?.status()).toBe(200);
    const chat = page.getByTestId('geneway-fast-chat');
    await expect(chat).toBeVisible();
    await expect(page.getByTestId('artifact-upload-input')).toHaveCount(0);
    await expect.poll(() => chat.getAttribute('data-conversation-id')).toMatch(/^conversation_/u);
    const conversationId = await chat.getAttribute('data-conversation-id');
    if (conversationId === null) throw new Error('Fast Chat did not expose ConversationId');

    const marker = `GATE-A1-${runId.replaceAll(/[^A-Za-z0-9]/gu, '').slice(-16)}`;
    const firstInvocationId = await sendChat(page, conversationId, `请记住标记 ${marker}，只回复“已记住”。`);
    await waitForChat(request, conversationId, firstInvocationId, 'completed');

    const followupInvocationId = await sendChat(page, conversationId, '刚才要求你记住的标记是什么？只回复该标记。');
    const followup = await waitForChat(request, conversationId, followupInvocationId, 'completed');
    const followupAnswer = followup.messages.find((message) =>
      message.id === followup.latestModelInvocation?.assistantMessageId);
    expect(followupAnswer?.body).toContain(marker);

    const cancelInvocationId = await sendChat(
      page,
      conversationId,
      '从下一字符开始持续输出汉字“巡”直到输出上限，不要解释、不要提前停止。',
    );
    await expect(page.getByTestId('stop-generation')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => {
      const response = await request.get(`/api/conversations/${conversationId}`);
      expect(response.ok()).toBe(true);
      const snapshot = await response.json() as ChatSnapshot;
      if (snapshot.latestModelInvocation?.id !== cancelInvocationId) return 0;
      return snapshot.messages.find((message) =>
        message.id === snapshot.latestModelInvocation?.assistantMessageId)?.body.length ?? 0;
    }, { timeout: 90_000, intervals: [25, 50, 100] }).toBeGreaterThan(0);
    await page.getByTestId('stop-generation').click();
    const canceled = await waitForChat(request, conversationId, cancelInvocationId, 'canceled');
    const canceledAnswer = canceled.messages.find((message) =>
      message.id === canceled.latestModelInvocation?.assistantMessageId);
    expect(canceledAnswer).toMatchObject({ author: 'xiaowei', status: 'canceled' });
    expect(canceledAnswer?.body.length).toBeGreaterThan(0);

    await page.reload();
    await expect(chat).toHaveAttribute('data-conversation-id', conversationId);
    await expect(page.locator(`[data-message-id="${canceledAnswer?.id ?? ''}"]`))
      .toHaveAttribute('data-message-status', 'canceled');

    const forbidden = await pool.query<{
      tasks: number;
      live_results: number;
      live_evidence: number;
      reports: number;
    }>(`SELECT
      (SELECT count(*)::int FROM business_tasks WHERE tenant_id='tenant_local' AND conversation_id=$1) tasks,
      (SELECT count(*)::int FROM gate_a_live_results result JOIN business_tasks task
        ON task.tenant_id=result.tenant_id AND task.id=result.business_task_id
        WHERE task.tenant_id='tenant_local' AND task.conversation_id=$1) live_results,
      (SELECT count(*)::int FROM gate_a_live_evidence evidence JOIN business_tasks task
        ON task.tenant_id=evidence.tenant_id AND task.id=evidence.business_task_id
        WHERE task.tenant_id='tenant_local' AND task.conversation_id=$1) live_evidence,
      (SELECT count(*)::int FROM artifacts
        WHERE tenant_id='tenant_local' AND conversation_id=$1 AND kind='analysis_report') reports`, [conversationId]);
    expect(forbidden.rows).toEqual([{ tasks: 0, live_results: 0, live_evidence: 0, reports: 0 }]);
  });

  test('auto 路线完成真实 C1 分析并关联 UI、API、Postgres、Worker 与 Gateway receipt', async ({ page, request }) => {
    test.setTimeout(300_000);
    const sourceBytes = await loadGateADocumentFixture('chrome-production.pdf.gz.b64');

    const started = await createAndStartLiveTask(
      page,
      request,
      'gate-a1-c1-material.pdf',
      sourceBytes,
      '请小纬自动安排方案专家，严格分别输出事实、推断、建议和未知项；每个事实必须引用材料 Evidence。',
    );
    const task = await waitForTask(request, started.create.taskId, 'completed');
    expect(task).toMatchObject({
      id: started.create.taskId,
      conversationId: started.conversationId,
      recordVariant: 'business-task.live/1',
      status: 'completed',
      inputRef: {
        kind: 'live_document_snapshot',
        documentSnapshotId: started.material.snapshotId,
        artifactId: started.material.artifactId,
        artifactSha256: started.material.contentSha256,
        mediaType: 'application/pdf',
        extractionVersion: 'canonical-text/pdf-pages-utf8/1',
        dataClass: 'C1',
        trust: 'untrusted_text',
      },
      workflowVersion: {
        id: started.create.workflowVersion.id,
        hash: started.create.workflowVersion.hash,
      },
      approval: {
        id: started.create.approvalId,
        status: 'approved',
        subjectDigest: started.create.approvalSubjectDigest,
      },
      expertTarget: {
        requested: { mode: 'auto' },
        resolved: { mode: 'expert', resolution: 'automatic' },
      },
      simulation: false,
      runtimeMode: 'model_gateway',
      businessDecisionAllowed: false,
      internalAcceptance: true,
    });
    expect(task.modelInvocation).toMatchObject({ status: 'completed' });
    expect(task.result).not.toBeNull();
    const statements = task.result?.statements ?? [];
    expect(new Set(statements.map((statement) => statement.kind)))
      .toEqual(new Set(['fact', 'inference', 'recommendation', 'unknown']));
    const publishedFacts = statements.filter((statement) =>
      statement.kind === 'fact' && statement.status === 'published');
    expect(publishedFacts.length).toBeGreaterThan(0);
    for (const fact of publishedFacts) {
      expect(fact.evidenceRefIds.length).toBeGreaterThan(0);
      for (const evidenceId of fact.evidenceRefIds) {
        expect(task.evidence.some((evidence) => evidence.id === evidenceId
          && evidence.statementId === fact.id)).toBe(true);
      }
    }

    await expect(page.getByTestId('result-card')).toBeVisible();
    for (const kind of ['fact', 'inference', 'recommendation', 'unknown'] as const) {
      await expect(page.getByTestId(`analysis-statement-${kind}`).first()).toBeVisible();
    }
    await expect(page.getByTestId('task-model-invocation-id')).toHaveText(task.modelInvocation?.id ?? '');
    const firstFact = publishedFacts[0];
    if (firstFact === undefined) throw new Error('Completed live analysis omitted a published fact');
    const firstEvidenceId = firstFact.evidenceRefIds[0];
    if (firstEvidenceId === undefined) throw new Error('Published fact omitted Evidence');
    const factCard = page.locator(`[data-statement-id="${firstFact.id}"]`);
    await factCard.getByTestId('statement-evidence-link').filter({ hasText: firstEvidenceId }).click();
    const drawer = page.getByTestId('evidence-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('evidence-locator-kind'))
      .toHaveText('canonical_page_span');
    await expect(drawer.getByTestId('evidence-canonical-span')).toContainText('（右开）');
    await expect(drawer.getByTestId('evidence-page-index')).toHaveText(/^\d+$/u);
    await expect(drawer.getByTestId('evidence-excerpt-sha256')).toContainText('excerpt sha256:');

    const evidenceResponse = await request.get(`/api/evidence/${firstEvidenceId}`);
    expect(evidenceResponse.ok()).toBe(true);
    const evidence = gateALiveEvidenceProjectionSchema.parse(await evidenceResponse.json());
    expect(evidence).toMatchObject({
      id: firstEvidenceId,
      businessTaskId: task.id,
      statementId: firstFact.id,
      recordVariant: 'evidence.live/1',
      dataClass: 'C1',
      audience: { kind: 'private-conversation', conversationId: task.conversationId },
    });
    expect(evidence.source.documentSnapshotId).toBe(started.material.snapshotId);
    expect(evidence.source.sourceArtifactId).toBe(started.material.artifactId);
    expect(evidence.source.kind).toBe('canonical_page_span');
    expect(evidence.source.startByte).toBeLessThan(evidence.source.endByteExclusive);
    expect(evidence.source.excerptByteLength)
      .toBe(evidence.source.endByteExclusive - evidence.source.startByte);
    await drawer.getByRole('button', { name: '关闭' }).click();

    const workflowResponse = await request.get(`/api/workflow-versions/${task.workflowVersion.id}`);
    expect(workflowResponse.ok()).toBe(true);
    const workflow = gateALiveWorkflowDetailProjectionSchema.parse(await workflowResponse.json());
    expect(workflow).toMatchObject({
      id: task.workflowVersion.id,
      hash: task.workflowVersion.hash,
      recordVariant: 'workflow-read-model.live/1',
      templateId: 'workflow-template.solution-live/1',
      simulation: false,
      runtimeMode: 'model_gateway',
      internalAcceptance: true,
    });

    const eventsResponse = await request.get(`/api/business-tasks/${task.id}/events?after=0`);
    expect(eventsResponse.ok()).toBe(true);
    const events = gateALiveTaskEventListResponseSchema.parse(await eventsResponse.json()).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.recordVariant === 'business-task-event.live/1'
      && event.simulation === false && event.runtimeMode === 'model_gateway')).toBe(true);
    expect(events.some((event) => event.eventType === 'business_task.completed')).toBe(true);

    const report = task.artifacts.find((artifact) => artifact.kind === 'analysis_report');
    expect(report).toMatchObject({
      recordVariant: 'artifact.analysis-report.live/1',
      internalAcceptance: true,
    });
    if (report === undefined) throw new Error('Completed live analysis omitted analysis_report');
    const reportItem = page.locator(`[data-artifact-id="${report.id}"]`);
    await expect(reportItem).toHaveAttribute('data-content-sha256', report.contentSha256);
    const downloaded = await downloadBytes(page, reportItem.getByRole('link', { name: '下载内部验收报告' }));
    expect(sha256(downloaded.bytes)).toBe(report.contentSha256);
    expect(downloaded.bytes.toString('utf8')).toContain('内部验收');

    const correlated = await pool.query<{
      task_variant: string;
      task_status: string;
      result_variant: string;
      workflow_id: string;
      workflow_hash: string;
      workflow_variant: string;
      approval_id: string;
      approval_digest: string;
      model_invocation_id: string;
      invocation_status: string;
      invocation_workflow_id: string;
      invocation_workflow_hash: string;
      invocation_approval_digest: string;
      receipt_attested: boolean;
      gateway_receipt_jti: string;
      gateway_receipt_digest: string;
      worker_instance_id: string;
      result_model_invocation_id: string;
      report_artifact_id: string;
      report_hash: string;
      report_model_invocation_id: string;
      published_facts: number;
      supporting_links: number;
      evidence_count: number;
    }>(`SELECT task.record_variant task_variant,task.status task_status,
      task.result_record_variant result_variant,workflow.id workflow_id,
      workflow.workflow_hash workflow_hash,workflow.record_variant workflow_variant,
      approval.id approval_id,approval.subject_digest approval_digest,
      invocation.id model_invocation_id,invocation.status invocation_status,
      invocation.workflow_version_id invocation_workflow_id,
      invocation.workflow_hash invocation_workflow_hash,
      invocation.approval_subject_digest invocation_approval_digest,
      invocation.receipt_attested,invocation.gateway_receipt_jti::text,
      invocation.gateway_receipt_digest,attempt.worker_instance_id,
      result.model_invocation_id result_model_invocation_id,
      report.artifact_id report_artifact_id,artifact.content_sha256 report_hash,
      report.model_invocation_id report_model_invocation_id,
      (SELECT count(*)::int FROM gate_a_live_claims claim
        WHERE claim.tenant_id=task.tenant_id AND claim.business_task_id=task.id
          AND claim.statement_kind='fact' AND claim.status='published') published_facts,
      (SELECT count(*)::int FROM gate_a_live_evidence_links link
        WHERE link.tenant_id=task.tenant_id AND link.business_task_id=task.id
          AND link.relation='supports') supporting_links,
      (SELECT count(*)::int FROM gate_a_live_evidence evidence_row
        WHERE evidence_row.tenant_id=task.tenant_id
          AND evidence_row.business_task_id=task.id) evidence_count
      FROM business_tasks task
      JOIN workflow_versions workflow ON workflow.tenant_id=task.tenant_id
        AND workflow.id=task.workflow_version_id
      JOIN approval_versions approval ON approval.tenant_id=task.tenant_id
        AND approval.business_task_id=task.id AND approval.id=$2
      JOIN gate_a_model_invocations invocation ON invocation.tenant_id=task.tenant_id
        AND invocation.business_task_id=task.id
      JOIN execution_attempts attempt ON attempt.tenant_id=task.tenant_id
        AND attempt.id=invocation.execution_attempt_id
      JOIN gate_a_live_results result ON result.tenant_id=task.tenant_id
        AND result.business_task_id=task.id
      JOIN gate_a_live_reports report ON report.tenant_id=task.tenant_id
        AND report.business_task_id=task.id
      JOIN artifacts artifact ON artifact.tenant_id=report.tenant_id
        AND artifact.id=report.artifact_id
      WHERE task.tenant_id='tenant_local' AND task.id=$1
        AND invocation.step_id='solution_design'`, [task.id, task.approval.id]);
    expect(correlated.rows).toEqual([{
      task_variant: 'business-task.live/1',
      task_status: 'completed',
      result_variant: 'business-task-result.live/1',
      workflow_id: task.workflowVersion.id,
      workflow_hash: task.workflowVersion.hash,
      workflow_variant: 'workflow-read-model.live/1',
      approval_id: task.approval.id,
      approval_digest: task.approval.subjectDigest,
      model_invocation_id: task.modelInvocation?.id,
      invocation_status: 'completed',
      invocation_workflow_id: task.workflowVersion.id,
      invocation_workflow_hash: task.workflowVersion.hash,
      invocation_approval_digest: task.approval.subjectDigest,
      receipt_attested: true,
      gateway_receipt_jti: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      gateway_receipt_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      worker_instance_id: expect.stringMatching(/^e2e-worker-/u),
      result_model_invocation_id: task.modelInvocation?.id,
      report_artifact_id: report.id,
      report_hash: report.contentSha256,
      report_model_invocation_id: task.modelInvocation?.id,
      published_facts: publishedFacts.length,
      supporting_links: expect.any(Number),
      evidence_count: task.evidence.length,
    }]);
    expect(correlated.rows[0]?.supporting_links).toBeGreaterThanOrEqual(publishedFacts.length);
    expect(correlated.rows[0]?.evidence_count).toBeGreaterThanOrEqual(publishedFacts.length);

    const agentInvocations = await pool.query<{
      id: string;
      step_id: string;
      status: string;
      step_attempt_id: string;
      task_fence: string;
      step_fence: string;
      agent_registry_reference: string;
      output_schema_version: string;
      prior_step_outputs_digest: string;
      gateway_receipt_jti: string;
      gateway_receipt_digest: string;
      deadline: string;
      task_deadline_ms: number;
      max_output_tokens: number;
    }>(`SELECT invocation.id,invocation.step_id,invocation.status,invocation.step_attempt_id,
      invocation.task_fence::text,invocation.step_fence::text,
      invocation.agent_registry_reference,invocation.output_schema_version,invocation.prior_step_outputs_digest,
      invocation.gateway_receipt_jti::text,invocation.gateway_receipt_digest,
      invocation.deadline::text,
      round(extract(epoch FROM (invocation.deadline-attempt.started_at))*1000)::int task_deadline_ms,
      invocation.max_output_tokens
      FROM gate_a_model_invocations invocation
      JOIN execution_attempts attempt ON attempt.tenant_id=invocation.tenant_id
        AND attempt.id=invocation.execution_attempt_id
      WHERE invocation.tenant_id='tenant_local' AND invocation.business_task_id=$1
      ORDER BY CASE invocation.step_id
        WHEN 'requirement_extract' THEN 1
        WHEN 'contradiction_check' THEN 2
        WHEN 'solution_design' THEN 3
        ELSE 99 END`, [task.id]);
    expect(agentInvocations.rows.map((invocation) => ({
      step_id: invocation.step_id,
      status: invocation.status,
      agent_registry_reference: invocation.agent_registry_reference,
      output_schema_version: invocation.output_schema_version,
      task_deadline_ms: invocation.task_deadline_ms,
      max_output_tokens: invocation.max_output_tokens,
    }))).toEqual([
      {
        step_id: 'requirement_extract', status: 'completed',
        agent_registry_reference: 'agent.solution.requirement/live-1',
        output_schema_version: 'analysis.requirement-candidates/1',
        task_deadline_ms: 300_000, max_output_tokens: 1_024,
      },
      {
        step_id: 'contradiction_check', status: 'completed',
        agent_registry_reference: 'agent.solution.contradiction/live-1',
        output_schema_version: 'analysis.contradiction/1',
        task_deadline_ms: 300_000, max_output_tokens: 1_024,
      },
      {
        step_id: 'solution_design', status: 'completed',
        agent_registry_reference: 'agent.solution.architect/live-1',
        output_schema_version: 'analysis.result-candidate/1',
        task_deadline_ms: 300_000, max_output_tokens: 2_048,
      },
    ]);
    expect(new Set(agentInvocations.rows.map((invocation) => invocation.id)).size).toBe(3);
    expect(new Set(agentInvocations.rows.map((invocation) => invocation.step_attempt_id)).size).toBe(3);
    expect(new Set(agentInvocations.rows.map((invocation) => invocation.step_fence)).size).toBe(3);
    expect(new Set(agentInvocations.rows.map((invocation) => invocation.task_fence)).size).toBe(1);
    expect(new Set(agentInvocations.rows.map((invocation) => invocation.deadline)).size).toBe(1);
    expect(new Set(agentInvocations.rows.map((invocation) => invocation.gateway_receipt_jti)).size).toBe(3);
    for (const invocation of agentInvocations.rows) {
      expect(invocation.prior_step_outputs_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(invocation.gateway_receipt_jti).toMatch(/^[0-9a-f-]{36}$/u);
      expect(invocation.gateway_receipt_digest).toMatch(/^[a-f0-9]{64}$/u);
    }

    await page.reload();
    await expect(page.getByTestId('task-card')).toHaveAttribute('data-task-id', task.id);
    await expect(page.getByTestId('task-model-invocation-id')).toHaveText(task.modelInvocation?.id ?? '');
    await expect(page.getByTestId('analysis-result')).toContainText(task.result?.summary ?? '');
    await expect(page.locator(`[data-artifact-id="${report.id}"]`))
      .toHaveAttribute('data-content-sha256', report.contentSha256);
    successfulRun = { task, create: started.create, material: started.material, reportBytes: downloaded.bytes };
  });

  test('真实 DOCX 经同一 Parser authority 形成可选 C1 live snapshot', async ({ page, request }) => {
    test.setTimeout(120_000);
    const conversationId = await enterLiveAnalysis(page, request);
    const bytes = await loadGateADocumentFixture('pandoc-production.docx.gz.b64');
    const material = await uploadLiveMaterial(page, 'gate-a1-pandoc-material.docx', bytes);
    await expect(material.card).toHaveAttribute('data-extraction-version', 'canonical-text/docx-pages-utf8/1');
    const authority = await pool.query<{
      media_type: string;
      extraction_version: string;
      canonical_page_index_sha256: string;
      page_schema: string;
      page_count: number;
      tasks: number;
    }>(`SELECT snapshot.media_type,canonical.extraction_version,canonical.canonical_page_index_sha256,
      canonical.canonical_page_index->>'schemaVersion' page_schema,
      jsonb_array_length(canonical.canonical_page_index->'pages') page_count,
      (SELECT count(*)::int FROM business_tasks task
        WHERE task.tenant_id=snapshot.tenant_id AND task.conversation_id=$2) tasks
      FROM document_snapshots snapshot
      JOIN document_snapshot_canonical_representations canonical
        ON canonical.tenant_id=snapshot.tenant_id AND canonical.document_snapshot_id=snapshot.id
      WHERE snapshot.tenant_id='tenant_local' AND snapshot.id=$1`, [material.snapshotId, conversationId]);
    expect(authority.rows).toEqual([{
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extraction_version: 'canonical-text/docx-pages-utf8/1',
      canonical_page_index_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      page_schema: 'canonical-page-index/1',
      page_count: 1,
      tasks: 0,
    }]);
  });

  test('已批准 authority 在执行前过期时原 task 生成 v2 pending 并可再次批准', async ({ page, request }) => {
    test.setTimeout(180_000);
    const conversationId = await enterLiveAnalysis(page, request);
    const material = await uploadLiveMaterial(
      page,
      'gate-a1-reauthorization-material.txt',
      gateAReauthorizationMaterialBytes(),
    );
    const created = await createTaskFromUi(page, '请复核材料约束并生成只读方案；执行前必须验证当前 approval authority。');

    const approvedV1 = await request.post(`/api/approvals/${created.approvalId}/decisions`, {
      headers: { 'idempotency-key': `gate-a1-approve-v1-${runId}` },
      data: { decision: 'approved' },
    });
    expect(approvedV1.ok(), await approvedV1.text()).toBe(true);
    const expiredApproval = await pool.query(`UPDATE approval_versions SET expires_at=now()-interval '1 second'
      WHERE tenant_id='tenant_local' AND id=$1`, [created.approvalId]);
    const expiredDelegation = await pool.query(`UPDATE delegated_capabilities SET expires_at=now()-interval '1 second'
      WHERE tenant_id='tenant_local' AND business_task_id=$1`, [created.taskId]);
    expect(expiredApproval.rowCount).toBe(1);
    expect(expiredDelegation.rowCount).toBe(1);

    const staleExecute = await request.post(`/api/business-tasks/${created.taskId}/execute`, {
      headers: { 'idempotency-key': `gate-a1-expired-execute-${runId}` },
      data: {
        expectedApprovalVersion: 1,
        expectedApprovalSubjectDigest: created.approvalSubjectDigest,
      },
    });
    const staleBody = await staleExecute.json() as Readonly<{
      error?: Readonly<{ code?: string; details?: Readonly<{
        currentApprovalId?: string;
        version?: number;
        digest?: string;
      }> }>;
    }>;
    expect(staleExecute.status(), JSON.stringify(staleBody)).toBe(409);
    expect(staleBody).toMatchObject({ error: {
      code: 'APPROVAL_SUBJECT_CHANGED',
      details: { version: 2, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    } });

    const pendingResponse = await request.get(`/api/business-tasks/${created.taskId}`);
    expect(pendingResponse.ok()).toBe(true);
    const pendingV2 = gateALiveTaskSnapshotSchema.parse(await pendingResponse.json());
    expect(pendingV2).toMatchObject({
      id: created.taskId,
      conversationId,
      status: 'awaiting_approval',
      approval: {
        id: staleBody.error?.details?.currentApprovalId,
        version: 2,
        status: 'pending',
        subjectDigest: staleBody.error?.details?.digest,
      },
      result: null,
      evidence: [],
      artifacts: [],
    });
    expect(pendingV2.inputRef).toMatchObject({
      kind: 'live_document_snapshot',
      documentSnapshotId: material.snapshotId,
    });

    await page.reload();
    await expect(page.getByTestId('task-card')).toHaveAttribute('data-task-id', created.taskId);
    await expect(page.getByTestId('task-card')).toContainText('awaiting_approval');
    await expect(page.getByTestId('workflow-graph').locator('.react-flow__node')).toHaveCount(7);
    await page.getByRole('button', { name: '关闭' }).click();
    await expect(page.getByRole('button', { name: '批准并运行真实分析' })).toBeVisible();

    const approvedV2 = await request.post(`/api/approvals/${pendingV2.approval.id}/decisions`, {
      headers: { 'idempotency-key': `gate-a1-approve-v2-${runId}` },
      data: { decision: 'approved' },
    });
    expect(approvedV2.ok(), await approvedV2.text()).toBe(true);
    const approvedResponse = await request.get(`/api/business-tasks/${created.taskId}`);
    expect(approvedResponse.ok()).toBe(true);
    const approvedTask = gateALiveTaskSnapshotSchema.parse(await approvedResponse.json());
    expect(approvedTask).toMatchObject({
      id: created.taskId,
      status: 'approved',
      approval: { id: pendingV2.approval.id, version: 2, status: 'approved' },
    });

    const cleanup = await request.post(`/api/business-tasks/${created.taskId}/cancel`, {
      headers: { 'idempotency-key': `gate-a1-reauthorization-cleanup-${runId}` },
    });
    expect(cleanup.ok(), await cleanup.text()).toBe(true);
    await waitForTask(request, created.taskId, 'canceled');
  });

  test('取消 live task 后不发布 result、Evidence、analysis_report 或伪 completed', async ({ page, request }) => {
    test.setTimeout(240_000);
    const executionResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && /\/api\/business-tasks\/[^/]+\/execute$/u.test(new URL(response.url()).pathname));
    const started = await createAndStartLiveTask(
      page,
      request,
      'gate-a1-cancel-material.txt',
      gateACancelMaterialBytes(),
      '请逐条分析材料中的追溯要求并生成完整结构化结果；在完成前保持任务可取消。',
    );
    expect((await executionResponse).ok()).toBe(true);
    const cancelResponse = await page.evaluate(async ({ taskId, key }) => {
      const response = await fetch(`/api/business-tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers: { 'idempotency-key': key },
      });
      return { status: response.status, body: await response.text() };
    }, { taskId: started.create.taskId, key: `gate-a1-browser-cancel-${runId}` });
    expect(cancelResponse.status, cancelResponse.body).toBe(200);
    const task = await waitForTask(request, started.create.taskId, 'canceled');
    expect(task).toMatchObject({
      id: started.create.taskId,
      status: 'canceled',
      result: null,
      evidence: [],
      artifacts: [],
      simulation: false,
      runtimeMode: 'model_gateway',
      internalAcceptance: true,
    });
    expect(task.modelInvocation?.status === 'canceled' || task.modelInvocation === null).toBe(true);
    await expect(page.getByTestId('canceled-task-state')).toContainText('分析任务已取消');
    await expect(page.getByTestId('analysis-result')).toHaveCount(0);
    await expect(page.getByTestId('report-artifact-item')).toHaveCount(0);

    const eventsResponse = await request.get(`/api/business-tasks/${task.id}/events?after=0`);
    const events = gateALiveTaskEventListResponseSchema.parse(await eventsResponse.json()).events;
    expect(events.some((event) => event.eventType === 'business_task.canceled')).toBe(true);
    expect(events.some((event) => event.eventType === 'business_task.completed')).toBe(false);

    const counts = await pool.query<{
      results: number;
      evidence: number;
      reports: number;
      completed_invocations: number;
      fake_tasks: number;
    }>(`SELECT
      (SELECT count(*)::int FROM gate_a_live_results WHERE tenant_id='tenant_local' AND business_task_id=$1) results,
      (SELECT count(*)::int FROM gate_a_live_evidence WHERE tenant_id='tenant_local' AND business_task_id=$1) evidence,
      (SELECT count(*)::int FROM gate_a_live_reports WHERE tenant_id='tenant_local' AND business_task_id=$1) reports,
      (SELECT count(*)::int FROM gate_a_model_invocations
        WHERE tenant_id='tenant_local' AND business_task_id=$1 AND status='completed') completed_invocations,
      (SELECT count(*)::int FROM business_tasks
        WHERE tenant_id='tenant_local' AND id=$1
          AND (simulation OR runtime_mode='fake' OR business_decision_allowed)) fake_tasks`, [task.id]);
    expect(counts.rows).toEqual([{
      results: 0,
      evidence: 0,
      reports: 0,
      completed_invocations: 0,
      fake_tasks: 0,
    }]);

    await page.reload();
    await expect(page.getByTestId('task-card')).toHaveAttribute('data-task-id', task.id);
    await expect(page.getByTestId('canceled-task-state')).toBeVisible();
    canceledRun = { taskId: task.id, conversationId: task.conversationId };
  });

  test('execution 已开始后来源撤销稳定失败且刷新保持零发布', async ({ page, request }) => {
    test.setTimeout(300_000);
    const started = await createAndStartLiveTask(
      page,
      request,
      'gate-a1-revoked-source-material.txt',
      gateARevokedSourceMaterialBytes(),
      '请严格分析材料中的来源撤销边界；只有完成全部 authority 复核后才能发布任何结果。',
    );

    await expect.poll(async () => {
      const execution = await pool.query<{ running: number }>(`SELECT count(*)::int running
        FROM execution_attempts WHERE tenant_id='tenant_local' AND business_task_id=$1 AND status='running'`, [
        started.create.taskId,
      ]);
      return execution.rows[0]?.running ?? 0;
    }, { timeout: 60_000, intervals: [25, 50, 100] }).toBe(1);
    const revoked = await pool.query(`UPDATE artifact_states SET availability='missing',state_version=state_version+1
      WHERE tenant_id='tenant_local' AND artifact_id=$1 AND availability='active'`, [started.material.artifactId]);
    expect(revoked.rowCount).toBe(1);

    const task = await waitForTask(request, started.create.taskId, 'failed');
    expect(task).toMatchObject({
      id: started.create.taskId,
      conversationId: started.conversationId,
      status: 'failed',
      errorClass: 'DATA_ROUTE_NOT_ALLOWED',
      result: null,
      evidence: [],
      artifacts: [],
      simulation: false,
      runtimeMode: 'model_gateway',
      businessDecisionAllowed: false,
      internalAcceptance: true,
    });
    const failedEventsResponse = await request.get(`/api/business-tasks/${task.id}/events?after=0`);
    expect(failedEventsResponse.ok()).toBe(true);
    const failedEvents = gateALiveTaskEventListResponseSchema.parse(await failedEventsResponse.json()).events;
    expect(failedEvents).toContainEqual(expect.objectContaining({
      eventType: 'business_task.failed',
      payload: expect.objectContaining({ phase: 'authority_revalidation', errorClass: 'DATA_ROUTE_NOT_ALLOWED' }),
    }));

    const publications = await pool.query<{
      results: number;
      claims: number;
      evidence: number;
      reports: number;
      report_artifacts: number;
      task_publication: number;
    }>(`SELECT
      (SELECT count(*)::int FROM gate_a_live_results
        WHERE tenant_id='tenant_local' AND business_task_id=$1) results,
      (SELECT count(*)::int FROM gate_a_live_claims
        WHERE tenant_id='tenant_local' AND business_task_id=$1) claims,
      (SELECT count(*)::int FROM gate_a_live_evidence
        WHERE tenant_id='tenant_local' AND business_task_id=$1) evidence,
      (SELECT count(*)::int FROM gate_a_live_reports
        WHERE tenant_id='tenant_local' AND business_task_id=$1) reports,
      (SELECT count(*)::int FROM artifacts
        WHERE tenant_id='tenant_local' AND business_task_id=$1 AND kind='analysis_report') report_artifacts,
      (SELECT CASE WHEN result IS NULL AND result_record_variant IS NULL THEN 0 ELSE 1 END
        FROM business_tasks WHERE tenant_id='tenant_local' AND id=$1) task_publication`, [task.id]);
    expect(publications.rows).toEqual([{
      results: 0,
      claims: 0,
      evidence: 0,
      reports: 0,
      report_artifacts: 0,
      task_publication: 0,
    }]);

    await expect(page.getByTestId('failed-task-state')).toBeVisible();
    await expect(page.getByTestId('failed-task-error-class')).toHaveText('DATA_ROUTE_NOT_ALLOWED');
    await expect(page.getByTestId('analysis-result')).toHaveCount(0);
    await expect(page.getByTestId('report-artifact-item')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('task-card')).toHaveAttribute('data-task-id', task.id);
    await expect(page.getByTestId('failed-task-state')).toBeVisible();
    await expect(page.getByTestId('failed-task-error-class')).toHaveText('DATA_ROUTE_NOT_ALLOWED');
    failedRun = { taskId: task.id, conversationId: task.conversationId };
  });

  test('Model Gateway readiness 临时不可用时既有终态仍可恢复且禁止新建', async ({ page, request }) => {
    test.setTimeout(180_000);
    if (successfulRun === undefined || failedRun === undefined || canceledRun === undefined) {
      throw new Error('Terminal Gate A task fixtures were not created by the serial acceptance run');
    }
    const releaseAuthorityBefore = await pool.query<{
      release_id: string;
      pointer_version: string;
      state: string;
    }>(`SELECT active.release_id,active.pointer_version::text,release.state
      FROM capability_active_releases active
      JOIN capability_release_records release ON release.tenant_id=active.tenant_id AND release.id=active.release_id
      WHERE active.tenant_id='tenant_local' AND active.capability_id='solution.analysis.v1'`);
    expect(releaseAuthorityBefore.rows).toEqual([{
      release_id: expect.stringMatching(/^release_solution_analysis_v1_internal_/u),
      pointer_version: expect.stringMatching(/^\d+$/u),
      state: 'internal',
    }]);
    const gatewayIdentity = JSON.parse(await readFile(
      `/tmp/geneway-runs/${runId}/process-boundaries/model-gateway.json`,
      'utf8',
    )) as ProcessIdentity;
    let gatewayPaused = false;
    let restorationFailure: unknown;
    let acceptanceFailure: unknown;
    try {
      const killed = await supervisorRequest<Readonly<{ restartScheduled?: boolean }>>(
        '/test/kill-model-gateway',
        { ...gatewayIdentity, restart: false },
      );
      gatewayPaused = killed.status === 202;
      expect(killed).toMatchObject({ status: 202, body: { restartScheduled: false } });
      await expect.poll(async () => {
        const capabilityResponse = await request.get('/api/capabilities/solution.analysis.v1');
        if (!capabilityResponse.ok()) return `HTTP_${String(capabilityResponse.status())}`;
        const capability = gateACapabilityRouteProjectionSchema.parse(await capabilityResponse.json());
        return `${capability.status}:${capability.status === 'NOT_OPEN' ? capability.reason : 'available'}`;
      }, { timeout: 10_000, intervals: [25, 50, 100] }).toBe('NOT_OPEN:MODEL_ROUTE_UNAVAILABLE');
      const releaseAuthorityDuringFault = await pool.query<{
        release_id: string;
        pointer_version: string;
        state: string;
      }>(`SELECT active.release_id,active.pointer_version::text,release.state
        FROM capability_active_releases active
        JOIN capability_release_records release ON release.tenant_id=active.tenant_id AND release.id=active.release_id
        WHERE active.tenant_id='tenant_local' AND active.capability_id='solution.analysis.v1'`);
      expect(releaseAuthorityDuringFault.rows).toEqual(releaseAuthorityBefore.rows);

      const terminals = [
        {
          taskId: successfulRun.task.id,
          conversationId: successfulRun.task.conversationId,
          selector: 'result-card',
        },
        { ...failedRun, selector: 'failed-task-state' },
        { ...canceledRun, selector: 'canceled-task-state' },
      ] as const;
      for (const terminal of terminals) {
        const deepLink = await page.goto(`/conversations/${terminal.conversationId}`);
        expect(deepLink?.status()).toBe(200);
        await expect(page.getByTestId('task-card')).toHaveAttribute('data-task-id', terminal.taskId);
        await expect(page.getByTestId(terminal.selector)).toBeVisible();

        await page.goto('/conversations/new?capability=solution.analysis.v1');
        await expect(page.getByTestId('task-card')).toHaveAttribute('data-task-id', terminal.taskId);
        await expect(page.getByTestId(terminal.selector)).toBeVisible();
      }

      await page.evaluate(() => {
        localStorage.removeItem('geneway.solution-analysis.taskId');
        localStorage.removeItem('geneway.solution-analysis.cursor');
        localStorage.removeItem('geneway.gate02a.taskId');
        localStorage.removeItem('geneway.gate02a.cursor');
      });
      await page.goto('/conversations/new?capability=solution.analysis.v1');
      await expect(page.getByTestId('not-open')).toBeVisible();
      await expect(page.getByTestId('artifact-upload-input')).toHaveCount(0);

      const forbiddenCreate = await request.post('/api/business-tasks', {
        headers: { 'idempotency-key': `gate-a1-not-open-create-${runId}` },
        data: {
          conversationId: successfulRun.task.conversationId,
          capabilityId: 'solution.analysis.v1',
          inputRef: {
            kind: 'document_snapshot',
            documentSnapshotId: successfulRun.material.snapshotId,
          },
          expertTarget: { mode: 'auto' },
        },
      });
      const forbiddenBody = await forbiddenCreate.json() as unknown;
      expect(forbiddenCreate.status()).toBeGreaterThanOrEqual(400);
      expect(forbiddenBody).toMatchObject({ error: { code: 'NOT_OPEN' } });
      expect(JSON.stringify(forbiddenBody)).not.toMatch(forbiddenFallbackPattern);
    } catch (cause) {
      acceptanceFailure = cause;
    } finally {
      if (gatewayPaused) {
        try {
          await resumeModelGatewaySupervisor();
        } catch (cause) {
          restorationFailure = cause;
        }
      }
    }
    if (restorationFailure !== undefined) {
      throw new Error('Failed to resume the run-bound Model Gateway after NOT_OPEN acceptance', {
        cause: restorationFailure,
      });
    }
    await waitModelGatewaySupervisorReady();
    await expect.poll(async () => {
      const restoredCapability = await request.get('/api/capabilities/solution.analysis.v1');
      if (!restoredCapability.ok()) return `HTTP_${String(restoredCapability.status())}`;
      const capability = gateACapabilityRouteProjectionSchema.parse(await restoredCapability.json());
      return `${capability.status}:${capability.executionRoute}`;
    }, { timeout: 10_000, intervals: [25, 50, 100] }).toBe('internal:live');
    const releaseAuthorityAfter = await pool.query<{
      release_id: string;
      pointer_version: string;
      state: string;
    }>(`SELECT active.release_id,active.pointer_version::text,release.state
      FROM capability_active_releases active
      JOIN capability_release_records release ON release.tenant_id=active.tenant_id AND release.id=active.release_id
      WHERE active.tenant_id='tenant_local' AND active.capability_id='solution.analysis.v1'`);
    expect(releaseAuthorityAfter.rows).toEqual(releaseAuthorityBefore.rows);
    if (acceptanceFailure instanceof Error) throw acceptanceFailure;
    if (acceptanceFailure !== undefined) {
      throw new Error('Gate A NOT_OPEN recovery acceptance failed', { cause: acceptanceFailure });
    }
  });

  test('非 auto 与输入失败均 fail closed 且不回退 FakeRuntime', async ({ page, request }) => {
    test.setTimeout(120_000);
    const conversationId = await enterLiveAnalysis(page, request);
    const material = await uploadLiveMaterial(
      page,
      'gate-a1-negative-material.txt',
      gateANegativeMaterialBytes(),
    );
    const before = await pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM business_tasks
       WHERE tenant_id='tenant_local' AND conversation_id=$1`,
      [conversationId],
    );

    const nonAuto = await request.post('/api/business-tasks', {
      headers: { 'idempotency-key': `gate-a1-non-auto-${runId}` },
      data: {
        conversationId,
        capabilityId: 'solution.analysis.v1',
        inputRef: { kind: 'document_snapshot', documentSnapshotId: material.snapshotId },
        expertTarget: { mode: 'expert', expertId: 'expert.solution.architect' },
      },
    });
    const nonAutoBody = await nonAuto.json() as unknown;
    expect(nonAuto.status()).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(nonAutoBody)).toMatch(/NOT_OPEN|EXPERT|AUTO/iu);
    expect(JSON.stringify(nonAutoBody)).not.toMatch(forbiddenFallbackPattern);

    await page.getByTestId('artifact-upload-input').setInputFiles({
      name: 'gate-a1-unsupported.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# unsupported live media type', 'utf8'),
    });
    const unsupportedCard = page.getByTestId('artifact-card').filter({ hasText: 'gate-a1-unsupported.md' });
    await expect(unsupportedCard).toHaveCount(1);
    await expect(unsupportedCard).toHaveAttribute('data-execution-route', 'not_open');
    await expect(unsupportedCard).toHaveAttribute('data-media-type', 'text/markdown');
    await expect(unsupportedCard.getByTestId('artifact-eligibility')).toContainText('当前服务端通道未开放此材料');
    await expect(unsupportedCard.getByRole('button', { name: '不可执行' })).toBeDisabled();
    await expect(unsupportedCard).not.toContainText(forbiddenFallbackPattern);

    const afterFailures = await pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM business_tasks
       WHERE tenant_id='tenant_local' AND conversation_id=$1`,
      [conversationId],
    );
    expect(afterFailures.rows).toEqual(before.rows);


    const finalCounts = await pool.query<{
      tasks: number;
      model_invocations: number;
      live_results: number;
      reports: number;
    }>(`SELECT
      (SELECT count(*)::int FROM business_tasks
        WHERE tenant_id='tenant_local' AND conversation_id=$1) tasks,
      (SELECT count(*)::int FROM gate_a_model_invocations invocation JOIN business_tasks task
        ON task.tenant_id=invocation.tenant_id AND task.id=invocation.business_task_id
        WHERE task.tenant_id='tenant_local' AND task.conversation_id=$1) model_invocations,
      (SELECT count(*)::int FROM gate_a_live_results result JOIN business_tasks task
        ON task.tenant_id=result.tenant_id AND task.id=result.business_task_id
        WHERE task.tenant_id='tenant_local' AND task.conversation_id=$1) live_results,
      (SELECT count(*)::int FROM gate_a_live_reports report JOIN business_tasks task
        ON task.tenant_id=report.tenant_id AND task.id=report.business_task_id
        WHERE task.tenant_id='tenant_local' AND task.conversation_id=$1) reports`, [conversationId]);
    expect(finalCounts.rows).toEqual([{ tasks: 0, model_invocations: 0, live_results: 0, reports: 0 }]);
    expect(successfulRun?.task.status).toBe('completed');
    expect(successfulRun?.reportBytes.length).toBeGreaterThan(0);
  });
});
