import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import {
  GenewayError,
  SIMULATION_ENVELOPE,
  attemptOutputCandidatePayloadSchema,
  resolvedTaskInputRefSchema,
  taskResultSchema,
  workerCommandResponseSchema,
  workerCommandSchema,
  type AttemptOutputCandidatePayload,
  type ResolvedTaskInputRef,
  type WorkerCommand,
  type WorkerCommandResponse,
  type WorkerDelivery,
} from '@geneway/contracts';
import {
  DEMO_DOCUMENT_SNAPSHOT_SHA256,
  DEMO_EVIDENCE_END_BYTE_EXCLUSIVE,
  DEMO_EVIDENCE_EXCERPT_SHA256,
  DEMO_EVIDENCE_START_BYTE,
  FIXTURE_CONTENT_HASH,
  FIXTURE_EXCERPT,
  FIXTURE_REF,
  FIXTURE_SOURCE_ID,
  POSITIVE_CLAIM_TEXT,
  REPORT_TEMPLATE_ID,
  REPORT_TEMPLATE_SHA256,
  UNSUPPORTED_CLAIM_TEXT,
  extractVerifiedDocumentEvidence,
  renderReport,
  sha256TextBytes,
} from '@geneway/evidence';
import { StorageObjectAlreadyExistsError, type ObjectStorage } from '@geneway/storage';
import { hashCanonical, readStoredWorkflowVersion } from '@geneway/workflow';
import { buildApprovalSubject, type ControlPlaneRepository } from './repository.js';

const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
const CONSUMER = 'gate0.2a-worker' as const;
const DEPLOYMENT = 'gate0.2a-local' as const;
const MAX_OBJECT_BYTES = 1_048_576;

type AttemptContext = Readonly<{
  tenantId: string;
  taskId: string;
  conversationId: string;
  requesterId: string;
  workflowVersionId: string;
  workflowHash: string;
  inputRef: ResolvedTaskInputRef;
  eventId: string;
  deliveryId: string;
  attemptId: string;
  executionVersion: number;
  fencingToken: number;
  workerInstanceId: string;
}>;

type ReportIntent = Readonly<{
  id: string;
  artifactId: string;
  manifestId: string;
  storageBucket: string;
  storageKey: string;
}>;

type IdempotentWorkerCommand =
  | Extract<WorkerCommand, { command: 'claim_step' }>
  | Extract<WorkerCommand, { command: 'complete_step' }>
  | Extract<WorkerCommand, { command: 'fail_delivery' }>;

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

export class WorkerCommandService {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(command: WorkerCommand): Promise<WorkerCommandResponse> {
    switch (command.command) {
      case 'session':
        return workerCommandResponseSchema.parse({ command: 'session', ok: true, result: { authenticated: true } });
      case 'claim_delivery':
        return workerCommandResponseSchema.parse({ command: 'claim_delivery', ok: true, result: await this.claimDelivery(command.workerInstanceId) });
      case 'read_input':
        return workerCommandResponseSchema.parse({ command: 'read_input', ok: true, result: await this.readInput(command) });
      case 'claim_step':
        return workerCommandResponseSchema.parse({ command: 'claim_step', ok: true, result: await this.claimStep(command) });
      case 'complete_step':
        await this.completeStep(command);
        return workerCommandResponseSchema.parse({ command: 'complete_step', ok: true, result: { accepted: true } });
      case 'submit_candidate':
        await this.submitCandidate(command);
        return workerCommandResponseSchema.parse({ command: 'submit_candidate', ok: true, result: { accepted: true } });
      case 'fail_delivery':
        await this.fail(command);
        return workerCommandResponseSchema.parse({ command: 'fail_delivery', ok: true, result: { accepted: true } });
    }
  }

  private async claimDelivery(workerInstanceId: string): Promise<WorkerDelivery | null> {
    return this.withTransaction(async (client) => {
      const selected = await client.query<{
        tenant_id: string;
        event_id: string;
        business_task_id: string;
        execution_version: string;
        execution_fencing_token: string;
        input_snapshot: unknown;
        workflow_version_id: string;
        workflow_hash: string;
        canonicalization_version: 'RFC8785/JCS-1';
        canonical_json: unknown;
      }>(`SELECT o.tenant_id,o.event_id,o.business_task_id,t.execution_version::text,t.execution_fencing_token::text,
        t.input_snapshot,t.workflow_version_id,t.workflow_hash,w.canonicalization_version,w.canonical_json
        FROM outbox_events o JOIN business_tasks t ON t.tenant_id=o.tenant_id AND t.id=o.business_task_id
        JOIN workflow_versions w ON w.tenant_id=t.tenant_id AND w.id=t.workflow_version_id
        WHERE o.event_type='workflow.execute.requested' AND t.status='queued'
          AND EXISTS (
            SELECT 1 FROM approval_versions approval
            WHERE approval.tenant_id=t.tenant_id AND approval.business_task_id=t.id
              AND approval.status='approved' AND approval.expires_at>now()
              AND approval.version=(SELECT max(latest.version) FROM approval_versions latest
                WHERE latest.tenant_id=t.tenant_id AND latest.business_task_id=t.id)
          )
          AND EXISTS (
            SELECT 1 FROM delegated_capabilities capability
            WHERE capability.tenant_id=t.tenant_id AND capability.business_task_id=t.id
              AND capability.principal_id=t.requester_id AND capability.expires_at>now()
          )
          AND NOT EXISTS (SELECT 1 FROM outbox_deliveries d WHERE d.tenant_id=o.tenant_id AND d.consumer=$1 AND d.event_id=o.event_id)
        ORDER BY o.created_at,o.event_id FOR UPDATE OF o,t SKIP LOCKED LIMIT 1`, [CONSUMER]);
      const row = selected.rows[0];
      if (row === undefined) return null;
      await this.assertTaskExecutionAuthority(client, row.tenant_id, row.business_task_id, {
        inputRef: resolvedTaskInputRefSchema.parse(row.input_snapshot),
        workflowVersionId: row.workflow_version_id,
        workflowHash: row.workflow_hash,
      });
      const attemptId = id('attempt');
      const deliveryId = id('delivery');
      const fencingToken = Number(row.execution_fencing_token) + 1;
      const executionVersion = Number(row.execution_version);
      if (!Number.isSafeInteger(executionVersion) || executionVersion < 1) throw new GenewayError('EXECUTION_VERSION_INVALID', 'Queued task has no valid execution version', 500);
      await client.query(`INSERT INTO execution_attempts
        (tenant_id,id,business_task_id,execution_version,source_event_id,consumer,deployment_id,worker_instance_id,status,fencing_token,lease_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now()+interval '5 minutes')`, [
        row.tenant_id, attemptId, row.business_task_id, executionVersion, row.event_id, CONSUMER, DEPLOYMENT,
        workerInstanceId, fencingToken,
      ]);
      await client.query(`INSERT INTO outbox_deliveries
        (tenant_id,id,business_task_id,consumer,deployment_id,event_id,status,execution_attempt_id,worker_instance_id,fencing_token,lease_until)
        VALUES ($1,$2,$3,$4,$5,$6,'leased',$7,$8,$9,now()+interval '5 minutes')`, [
        row.tenant_id, deliveryId, row.business_task_id, CONSUMER, DEPLOYMENT, row.event_id,
        attemptId, workerInstanceId, fencingToken,
      ]);
      await client.query(`INSERT INTO inbox_events
        (tenant_id,consumer,deployment_id,event_id,delivery_id,business_task_id,execution_attempt_id,
         worker_instance_id,fencing_token,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'received')`, [
        row.tenant_id, CONSUMER, DEPLOYMENT, row.event_id, deliveryId, row.business_task_id,
        attemptId, workerInstanceId, fencingToken,
      ]);
      const updated = await client.query(`UPDATE business_tasks SET current_execution_attempt_id=$3,
        execution_fencing_token=$4,status='running',updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='queued' AND execution_version=$5`, [
        row.tenant_id, row.business_task_id, attemptId, fencingToken, executionVersion,
      ]);
      if (updated.rowCount !== 1) throw new GenewayError('DELIVERY_CLAIM_CONFLICT', 'Queued task changed before delivery claim', 409);
      await this.appendEvent(client, row.tenant_id, row.business_task_id, 'workflow.run_started', {
        attemptId,
        workerInstanceId,
        executionVersion,
        fencingToken,
      });
      return {
        tenantId: row.tenant_id,
        taskId: row.business_task_id,
        consumer: CONSUMER,
        deploymentId: DEPLOYMENT,
        workerInstanceId,
        lease: { eventId: row.event_id, deliveryId, attemptId, fencingToken },
        inputRef: resolvedTaskInputRefSchema.parse(row.input_snapshot),
        workflow: {
          id: row.workflow_version_id,
          hash: row.workflow_hash,
          canonicalizationVersion: row.canonicalization_version,
          canonicalPayload: row.canonical_json,
        },
      };
    });
  }

  private async readInput(command: Extract<WorkerCommand, { command: 'read_input' }>): Promise<Readonly<Record<string, unknown>>> {
    const context = await this.requireAttempt(command);
    if (context.inputRef.kind === 'fixture') {
      await this.finalizeInputRead(command, context);
      return { kind: 'fixture', inputRef: context.inputRef };
    }
    const source = await this.repository.pool.query<{
      storage_bucket: string;
      storage_key: string;
      size_bytes: string;
      media_type: string;
      content_sha256: string;
      availability: string;
      integrity: string;
      retention_status: string;
      retention_expires_at: Date;
      reconcile_status: string;
    }>(`SELECT m.storage_bucket,m.storage_key,m.size_bytes::text,m.media_type,m.content_sha256,
      s.availability,s.integrity,s.retention_status,s.retention_expires_at,s.reconcile_status
      FROM artifact_manifests m JOIN artifact_states s ON s.tenant_id=m.tenant_id AND s.artifact_id=m.artifact_id
      JOIN document_snapshots d ON d.tenant_id=m.tenant_id AND d.manifest_id=m.id
      WHERE m.tenant_id=$1 AND d.id=$2 AND d.artifact_id=$3 AND m.id=$4`, [
      context.tenantId, context.inputRef.documentSnapshotId, context.inputRef.artifactId, context.inputRef.manifestId,
    ]);
    const row = source.rows[0];
    if (row === undefined || row.storage_bucket !== this.storage.bucket || row.availability !== 'active'
      || row.integrity !== 'verified' || row.retention_status !== 'active' || row.retention_expires_at.getTime() <= Date.now()
      || row.reconcile_status !== 'in_sync') {
      throw new GenewayError('WORKER_INPUT_NOT_READY', 'Frozen document input is not available', 409);
    }
    const maximum = Number(row.size_bytes);
    const head = await this.storage.head(row.storage_key);
    const bytes = await this.storage.getBytes(row.storage_key, maximum);
    if (head.sizeBytes !== maximum || bytes.byteLength !== maximum || head.contentType !== row.media_type
      || head.contentSha256 !== row.content_sha256 || sha256TextBytes(bytes) !== row.content_sha256
      || row.content_sha256 !== context.inputRef.contentSha256) {
      throw new GenewayError('WORKER_INPUT_INTEGRITY_FAILED', 'Frozen document input failed integrity verification', 409);
    }
    await this.finalizeInputRead(command, context);
    return { kind: 'document_snapshot', inputRef: context.inputRef, bytesBase64: Buffer.from(bytes).toString('base64') };
  }

  private async claimStep(command: Extract<WorkerCommand, { command: 'claim_step' }>): Promise<Readonly<{ stepAttemptId: string; fencingToken: number }>> {
    return this.idempotentWorkerMutation(command, async (client) => {
      const context = await this.requireAttempt(command, client);
      await this.lockCurrentAttempt(client, context);
      const workflow = await client.query<{ canonical_json: unknown }>('SELECT canonical_json FROM workflow_versions WHERE tenant_id=$1 AND id=$2', [context.tenantId, context.workflowVersionId]);
      const parsed = readStoredWorkflowVersion({ id: context.workflowVersionId, hash: context.workflowHash, canonicalizationVersion: 'RFC8785/JCS-1', canonicalPayload: workflow.rows[0]?.canonical_json }).payload;
      const nodeIndex = parsed.nodes.findIndex((node) => node.id === command.stepId);
      if (nodeIndex < 0) throw new GenewayError('STEP_NOT_IN_WORKFLOW', 'Step is not part of the approved WorkflowVersion', 422);
      const predecessor = parsed.nodes[nodeIndex - 1];
      if (predecessor !== undefined) {
        const complete = await client.query("SELECT 1 FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3 AND status='completed'", [context.tenantId, context.taskId, predecessor.id]);
        if (complete.rowCount !== 1) throw new GenewayError('STEP_DEPENDENCY_NOT_READY', 'Predecessor is not complete', 409);
      }
      const updated = await client.query<{ fencing_token: string }>(`UPDATE business_task_steps SET status='running',attempt_id=$4,
        fencing_token=fencing_token+1,lease_until=now()+interval '5 minutes',updated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3 AND status='queued' RETURNING fencing_token::text`, [
        context.tenantId, context.taskId, command.stepId, command.stepAttemptId,
      ]);
      const row = updated.rows[0];
      if (row === undefined) throw new GenewayError('STEP_CLAIM_CONFLICT', 'Step cannot be claimed', 409);
      await this.appendEvent(client, context.tenantId, context.taskId, 'workflow.step_started', {
        stepId: command.stepId,
        stepAttemptId: command.stepAttemptId,
        fencingToken: Number(row.fencing_token),
        executionAttemptId: context.attemptId,
      });
      return { stepAttemptId: command.stepAttemptId, fencingToken: Number(row.fencing_token) };
    });
  }

  private async completeStep(command: Extract<WorkerCommand, { command: 'complete_step' }>): Promise<void> {
    await this.idempotentWorkerMutation(command, async (client) => {
      const context = await this.requireAttempt(command, client);
      await this.lockCurrentAttempt(client, context);
      const updated = await client.query(`UPDATE business_task_steps SET status='completed',output=$7,updated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3 AND status='running'
          AND attempt_id=$4 AND fencing_token=$5 AND lease_until>now()
          AND EXISTS (SELECT 1 FROM execution_attempts a WHERE a.tenant_id=$1 AND a.id=$6 AND a.fencing_token=$8 AND a.worker_instance_id=$9 AND a.status='running')`, [
        context.tenantId, context.taskId, command.stepId, command.stepAttemptId, command.stepFencingToken,
        context.attemptId, command.output, context.fencingToken, context.workerInstanceId,
      ]);
      if (updated.rowCount !== 1) throw new GenewayError('STALE_STEP_COMPLETION', 'Stale step completion was rejected', 409);
      await this.appendEvent(client, context.tenantId, context.taskId, 'workflow.step_completed', {
        stepId: command.stepId,
        stepAttemptId: command.stepAttemptId,
        stepFencingToken: command.stepFencingToken,
        executionAttemptId: context.attemptId,
      });
      return { accepted: true };
    });
  }

  private async submitCandidate(command: Extract<WorkerCommand, { command: 'submit_candidate' }>): Promise<void> {
    const candidate = attemptOutputCandidatePayloadSchema.parse(command.candidate);
    const candidateHash = hashCanonical(candidate);
    const replay = await this.repository.pool.query<{ id: string; payload_sha256: string; idempotency_key: string; task_status: string }>(`SELECT candidate.id,candidate.payload_sha256,candidate.idempotency_key,task.status task_status
      FROM attempt_output_candidates candidate
      JOIN execution_attempts attempt ON attempt.tenant_id=candidate.tenant_id AND attempt.id=candidate.execution_attempt_id
      JOIN outbox_deliveries delivery ON delivery.tenant_id=attempt.tenant_id AND delivery.execution_attempt_id=attempt.id
      JOIN business_tasks task ON task.tenant_id=candidate.tenant_id AND task.id=candidate.business_task_id
      WHERE attempt.id=$1 AND attempt.worker_instance_id=$2 AND attempt.fencing_token=$3
        AND delivery.id=$4 AND delivery.event_id=$5 AND delivery.consumer=$6 AND delivery.deployment_id=$7`, [
      command.attemptId, command.workerInstanceId, command.fencingToken,
      command.deliveryId, command.eventId, CONSUMER, DEPLOYMENT,
    ]);
    const replayRow = replay.rows[0];
    if (replayRow !== undefined) {
      if (replayRow.payload_sha256 !== candidateHash || replayRow.idempotency_key !== command.idempotencyKey) {
        throw new GenewayError('CANDIDATE_CONFLICT', 'Candidate idempotency key or payload changed after submission', 409);
      }
      if (replayRow.task_status === 'completed') return;
      if (replayRow.task_status !== 'running') throw new GenewayError('STALE_EXECUTION_ATTEMPT', 'Candidate belongs to a terminal non-completed task', 409);
    }
    const context = await this.requireAttempt(command);
    const candidateId = await this.withTransaction(async (client) => {
      await this.requireAttempt(command, client);
      const candidateId = id('candidate');
      await client.query(`INSERT INTO attempt_output_candidates
        (tenant_id,id,business_task_id,execution_attempt_id,execution_version,fencing_token,worker_instance_id,payload,payload_sha256,idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id,execution_attempt_id) DO NOTHING`, [
        context.tenantId, candidateId, context.taskId, context.attemptId, context.executionVersion,
        context.fencingToken, context.workerInstanceId, candidate, candidateHash, command.idempotencyKey,
      ]);
      const selected = await client.query<{ id: string; payload_sha256: string; idempotency_key: string }>('SELECT id,payload_sha256,idempotency_key FROM attempt_output_candidates WHERE tenant_id=$1 AND execution_attempt_id=$2', [context.tenantId, context.attemptId]);
      const row = selected.rows[0];
      if (row === undefined || row.payload_sha256 !== candidateHash || row.idempotency_key !== command.idempotencyKey) {
        throw new GenewayError('CANDIDATE_CONFLICT', 'Execution attempt already submitted a different candidate', 409);
      }
      return row.id;
    });
    await this.publishCandidate(context, candidateId, candidate);
  }

  private async publishCandidate(context: AttemptContext, candidateId: string, candidate: AttemptOutputCandidatePayload): Promise<void> {
    const completedResult = taskResultSchema.parse(candidate.result);
    if (completedResult.kind !== 'completed') throw new GenewayError('CANDIDATE_RESULT_INVALID', 'Terminal candidate must contain a completed result', 422);
    const supported = candidate.claims.find((claim) => claim.text === POSITIVE_CLAIM_TEXT);
    const rejected = candidate.claims.find((claim) => claim.text === UNSUPPORTED_CLAIM_TEXT);
    if (supported?.evidenceCandidateKey === null || supported === undefined || rejected?.evidenceCandidateKey !== null) {
      throw new GenewayError('CANDIDATE_CLAIMS_INVALID', 'Candidate does not contain the fixed supported and rejected claims', 422);
    }
    const locator = candidate.evidence.find((item) => item.candidateKey === supported.evidenceCandidateKey);
    if (locator === undefined) throw new GenewayError('CLAIM_EVIDENCE_REQUIRED', 'Published claim candidate has no evidence locator', 422);

    if (context.inputRef.kind === 'fixture') {
      if (locator.kind !== 'legacy_fixture' || locator.fixtureRef !== FIXTURE_REF || locator.fixtureVersion !== 1 || locator.sourceId !== FIXTURE_SOURCE_ID) {
        throw new GenewayError('LEGACY_EVIDENCE_MISMATCH', 'Legacy evidence locator does not match the frozen fixture', 409);
      }
      await this.publishTerminal({
        context,
        candidateId,
        candidate,
        source: { kind: 'legacy_fixture', fixtureRef: FIXTURE_REF, fixtureVersion: 1, sourceId: FIXTURE_SOURCE_ID, excerptSha256: FIXTURE_CONTENT_HASH },
        excerpt: FIXTURE_EXCERPT,
        excerptSha256: FIXTURE_CONTENT_HASH,
        report: null,
      });
      return;
    }

    if (locator.kind !== 'document_snapshot' || locator.documentSnapshotId !== context.inputRef.documentSnapshotId
      || locator.startByte !== DEMO_EVIDENCE_START_BYTE || locator.endByteExclusive !== DEMO_EVIDENCE_END_BYTE_EXCLUSIVE) {
      throw new GenewayError('DOCUMENT_EVIDENCE_LOCATOR_MISMATCH', 'Evidence locator does not match the approved document snapshot oracle', 409);
    }
    const source = await this.repository.pool.query<{
      storage_bucket: string;
      storage_key: string;
      size_bytes: string;
      media_type: string;
      content_sha256: string;
    }>(`SELECT m.storage_bucket,m.storage_key,m.size_bytes::text,m.media_type,m.content_sha256
      FROM artifact_manifests m JOIN artifact_states s ON s.tenant_id=m.tenant_id AND s.artifact_id=m.artifact_id
      WHERE m.tenant_id=$1 AND m.id=$2 AND m.artifact_id=$3 AND s.availability='active' AND s.integrity='verified'
        AND s.retention_status='active' AND s.retention_expires_at>now() AND s.reconcile_status='in_sync'`, [
      context.tenantId, context.inputRef.manifestId, context.inputRef.artifactId,
    ]);
    const sourceRow = source.rows[0];
    if (sourceRow === undefined || sourceRow.storage_bucket !== this.storage.bucket) throw new GenewayError('EVIDENCE_SOURCE_NOT_READY', 'Evidence source is unavailable', 409);
    const bytes = await this.storage.getBytes(sourceRow.storage_key, Number(sourceRow.size_bytes));
    const verified = extractVerifiedDocumentEvidence({
      rawBytes: bytes,
      snapshotSha256: context.inputRef.contentSha256,
      startByte: locator.startByte,
      endByteExclusive: locator.endByteExclusive,
    });
    if (context.inputRef.contentSha256 !== DEMO_DOCUMENT_SNAPSHOT_SHA256 || verified.excerptSha256 !== DEMO_EVIDENCE_EXCERPT_SHA256) {
      throw new GenewayError('EVIDENCE_ORACLE_MISMATCH', 'Verified evidence does not match the pinned Gate 0.2A oracle', 409);
    }
    const renderInput = {
      templateId: REPORT_TEMPLATE_ID,
      templateSha256: REPORT_TEMPLATE_SHA256,
      taskId: context.taskId,
      workflowVersionId: context.workflowVersionId,
      workflowHash: context.workflowHash,
      documentSnapshotId: context.inputRef.documentSnapshotId,
      contentSha256: context.inputRef.contentSha256,
      claimText: POSITIVE_CLAIM_TEXT,
      startByte: locator.startByte,
      endByteExclusive: locator.endByteExclusive,
      excerptSha256: verified.excerptSha256,
    } as const;
    const reportBytes = renderReport(renderInput);
    const reportSha256 = sha256TextBytes(reportBytes);
    const intent = await this.prepareReportIntent(context, candidateId, reportBytes.byteLength, reportSha256, hashCanonical(renderInput));
    try {
      await this.storage.putCreateOnly({ key: intent.storageKey, bytes: reportBytes, contentType: 'text/markdown', contentSha256: reportSha256 });
    } catch (error) {
      if (!(error instanceof StorageObjectAlreadyExistsError)) throw error;
    }
    const reportHead = await this.storage.head(intent.storageKey);
    const observedReport = await this.storage.getBytes(intent.storageKey, MAX_OBJECT_BYTES);
    if (reportHead.sizeBytes !== reportBytes.byteLength || reportHead.contentType !== 'text/markdown'
      || reportHead.contentSha256 !== reportSha256 || sha256TextBytes(observedReport) !== reportSha256) {
      throw new GenewayError('REPORT_OBJECT_INTEGRITY_FAILED', 'Report object failed immutable verification', 409);
    }
    if (reportHead.eTag === null) throw new GenewayError('REPORT_ETAG_MISSING', 'Storage did not return an observed ETag for the report', 409);
    await this.repository.pool.query(`UPDATE report_publish_intents SET status='object_verified',state_version=state_version+1,
      etag_observed=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='prepared'`, [
      context.tenantId, intent.id, reportHead.eTag,
    ]);
    await this.publishTerminal({
      context,
      candidateId,
      candidate,
      source: {
        kind: 'document_snapshot',
        documentSnapshotId: context.inputRef.documentSnapshotId,
        artifactId: context.inputRef.artifactId,
        startByte: locator.startByte,
        endByteExclusive: locator.endByteExclusive,
        snapshotSha256: context.inputRef.contentSha256,
        excerptSha256: verified.excerptSha256,
        extractionVersion: 'raw-utf8-byte-range/1',
      },
      excerpt: verified.excerpt,
      excerptSha256: verified.excerptSha256,
      report: { intent, bytes: reportBytes, sha256: reportSha256, renderInput },
    });
  }

  private async prepareReportIntent(context: AttemptContext, candidateId: string, sizeBytes: number, contentSha256: string, renderInputSha256: string): Promise<ReportIntent> {
    return this.withTransaction(async (client) => {
      await this.lockCurrentAttempt(client, context);
      const artifactId = id('artifact');
      const intentId = id('report_intent');
      const manifestId = id('manifest');
      const storageKey = `tenants/${context.tenantId}/artifacts/${artifactId}/report.md`;
      await client.query(`INSERT INTO report_publish_intents
        (tenant_id,id,business_task_id,execution_attempt_id,candidate_id,source_document_snapshot_id,root_artifact_id,
         conversation_id,owner_user_id,resource_scope,data_class,audience,artifact_id,manifest_id,storage_bucket,storage_key,
         template_id,template_sha256,render_input_sha256,size_bytes,content_sha256,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'C1',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'prepared')
        ON CONFLICT (tenant_id,business_task_id) DO NOTHING`, [
        context.tenantId, intentId, context.taskId, context.attemptId, candidateId,
        context.inputRef.kind === 'document_snapshot' ? context.inputRef.documentSnapshotId : '',
        context.inputRef.kind === 'document_snapshot' ? context.inputRef.artifactId : '',
        context.conversationId, context.requesterId,
        context.inputRef.kind === 'document_snapshot' ? context.inputRef.resourceScope : '',
        `conversation:${context.conversationId}`, artifactId, manifestId, this.storage.bucket, storageKey,
        REPORT_TEMPLATE_ID, REPORT_TEMPLATE_SHA256, renderInputSha256, sizeBytes, contentSha256,
      ]);
      const selected = await client.query<{ id: string; artifact_id: string; manifest_id: string; storage_bucket: string; storage_key: string; content_sha256: string }>('SELECT id,artifact_id,manifest_id,storage_bucket,storage_key,content_sha256 FROM report_publish_intents WHERE tenant_id=$1 AND business_task_id=$2 FOR UPDATE', [context.tenantId, context.taskId]);
      const row = selected.rows[0];
      if (row === undefined || row.content_sha256 !== contentSha256) throw new GenewayError('REPORT_INTENT_CONFLICT', 'Task already has a different report publish intent', 409);
      return { id: row.id, artifactId: row.artifact_id, manifestId: row.manifest_id, storageBucket: row.storage_bucket, storageKey: row.storage_key };
    });
  }

  private async publishTerminal(input: Readonly<{
    context: AttemptContext;
    candidateId: string;
    candidate: AttemptOutputCandidatePayload;
    source: Readonly<Record<string, unknown>>;
    excerpt: string;
    excerptSha256: string;
    report: null | Readonly<{
      intent: ReportIntent;
      bytes: Uint8Array;
      sha256: string;
      renderInput: Readonly<Record<string, unknown>>;
    }>;
  }>): Promise<void> {
    await this.withTransaction(async (client) => {
      const { context } = input;
      await this.lockCurrentAttempt(client, context);
      await this.assertTaskExecutionAuthority(client, context.tenantId, context.taskId, {
        inputRef: context.inputRef,
        workflowVersionId: context.workflowVersionId,
        workflowHash: context.workflowHash,
      });
      const approval = await client.query<{ status: string; subject_digest: string; expires_at: Date; subject: unknown }>('SELECT status,subject_digest,expires_at,subject FROM approval_versions WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE', [context.tenantId, context.taskId]);
      const approvalRow = approval.rows[0];
      if (approvalRow === undefined || approvalRow.status !== 'approved' || approvalRow.expires_at.getTime() <= Date.now()) throw new GenewayError('APPROVAL_REQUIRED', 'Current approval is not valid at terminal publish', 409);
      const task = await client.query<{ status: string; conversation_id: string; requester_id: string; workflow_version_id: string; workflow_hash: string; input_snapshot: unknown; expert_catalog_version_id: string; harness_version_id: string; expert_target: unknown; permission_scope: unknown; audience_scope: unknown; budget: unknown }>('SELECT * FROM business_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [context.tenantId, context.taskId]);
      const taskRow = task.rows[0];
      if (taskRow === undefined || taskRow.status !== 'running') throw new GenewayError('TASK_TERMINAL_CONFLICT', 'Task is no longer publishable', 409);
      const currentInputRef = resolvedTaskInputRefSchema.parse(taskRow.input_snapshot);
      if (taskRow.conversation_id !== context.conversationId || taskRow.requester_id !== context.requesterId
        || taskRow.workflow_version_id !== context.workflowVersionId || taskRow.workflow_hash !== context.workflowHash
        || hashCanonical(currentInputRef) !== hashCanonical(context.inputRef)) {
        throw new GenewayError('EXECUTION_CONTEXT_CHANGED', 'Current task semantics no longer match the claimed execution attempt', 409);
      }
      const expectedApprovalSubject = buildApprovalSubject({
        taskId: context.taskId,
        requesterId: taskRow.requester_id,
        inputSnapshot: currentInputRef,
        expertTarget: taskRow.expert_target as Readonly<Record<string, unknown>>,
        expertCatalogVersionId: taskRow.expert_catalog_version_id,
        harnessVersionId: taskRow.harness_version_id,
        workflowVersionId: taskRow.workflow_version_id,
        workflowHash: taskRow.workflow_hash,
        permissionScope: taskRow.permission_scope as Readonly<Record<string, unknown>>,
        audienceScope: taskRow.audience_scope as Readonly<Record<string, unknown>>,
        budget: taskRow.budget as Readonly<Record<string, unknown>>,
      });
      if (hashCanonical(approvalRow.subject) !== approvalRow.subject_digest
        || hashCanonical(expectedApprovalSubject) !== approvalRow.subject_digest) {
        throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Approved subject no longer matches terminal publish semantics', 409);
      }
      const evidenceId = id('evidence');
      const positiveClaimId = id('claim');
      const rejectedClaimId = id('claim');
      const resourceScope = context.inputRef.kind === 'fixture' ? FIXTURE_REF : context.inputRef.resourceScope;
      const audience = `conversation:${context.conversationId}`;
      await client.query(`INSERT INTO evidence_items
        (tenant_id,id,business_task_id,candidate_id,source_kind,source,source_excerpt,excerpt_sha256,resource_scope,data_class,audience,
         accessible,simulation,runtime_mode,business_decision_allowed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'C1',$10,true,true,'fake',false)`, [
        context.tenantId, evidenceId, context.taskId, input.candidateId, input.source.kind,
        input.source, input.excerpt, input.excerptSha256, resourceScope, audience,
      ]);
      await client.query(`INSERT INTO claims
        (tenant_id,id,business_task_id,candidate_id,text,status,rejection_code,resource_scope,data_class,audience,simulation,runtime_mode,business_decision_allowed)
        VALUES ($1,$2,$3,$4,$5,'published',null,$6,'C1',$7,true,'fake',false),
               ($1,$8,$3,$4,$9,'rejected','CLAIM_EVIDENCE_REQUIRED',$6,'C1',$7,true,'fake',false)`, [
        context.tenantId, positiveClaimId, context.taskId, input.candidateId, POSITIVE_CLAIM_TEXT,
        resourceScope, audience, rejectedClaimId, UNSUPPORTED_CLAIM_TEXT,
      ]);
      await client.query("INSERT INTO evidence_links (tenant_id,id,business_task_id,claim_id,evidence_id,relation) VALUES ($1,$2,$3,$4,$5,'supports')", [
        context.tenantId, id('evidence_link'), context.taskId, positiveClaimId, evidenceId,
      ]);

      const lineage: Array<readonly [string, string, string, string, string, Readonly<Record<string, unknown>>]> = [];
      if (context.inputRef.kind === 'fixture') {
        lineage.push(['legacy_fixture', FIXTURE_SOURCE_ID, 'evidence', evidenceId, 'verified_as', {}]);
      } else {
        lineage.push(['artifact', context.inputRef.artifactId, 'document_snapshot', context.inputRef.documentSnapshotId, 'frozen_as', {}]);
        lineage.push(['document_snapshot', context.inputRef.documentSnapshotId, 'candidate', input.candidateId, 'read_by', {}]);
        lineage.push(['candidate', input.candidateId, 'evidence', evidenceId, 'verified_as', { startByte: DEMO_EVIDENCE_START_BYTE, endByteExclusive: DEMO_EVIDENCE_END_BYTE_EXCLUSIVE }]);
      }
      lineage.push(['evidence', evidenceId, 'claim', positiveClaimId, 'supports', {}]);
      lineage.push(['workflow_version', context.workflowVersionId, 'claim', positiveClaimId, 'produced', { workflowHash: context.workflowHash }]);

      if (input.report !== null && context.inputRef.kind === 'document_snapshot') {
        const report = input.report;
        const intentState = await client.query<{ status: string }>('SELECT status FROM report_publish_intents WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [context.tenantId, report.intent.id]);
        if (intentState.rows[0]?.status !== 'object_verified') throw new GenewayError('REPORT_NOT_VERIFIED', 'Report object has not been verified', 409);
        await client.query(`INSERT INTO artifacts
          (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,content_sha256,business_task_id,
           root_artifact_id,data_class,audience,resource_scope)
          VALUES ($1,$2,$3,$4,'simulation_report','小纬模拟方案分析报告.md','text/markdown',$5,$6,$7,$8,'C1',$9,$10)`, [
          context.tenantId, report.intent.artifactId, context.conversationId, context.requesterId,
          report.bytes.byteLength, report.sha256, context.taskId, context.inputRef.artifactId,
          { kind: 'private-conversation', conversationId: context.conversationId }, context.inputRef.resourceScope,
        ]);
        await client.query(`INSERT INTO artifact_manifests
          (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,content_sha256,retention_policy)
          VALUES ($1,$2,$3,$4,$5,'小纬模拟方案分析报告.md','text/markdown',$6,$7,'gate0.2a-internal/v1')`, [
          context.tenantId, report.intent.manifestId, report.intent.artifactId, report.intent.storageBucket,
          report.intent.storageKey, report.bytes.byteLength, report.sha256,
        ]);
        await client.query(`INSERT INTO artifact_states
          (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,reconcile_status,last_checked_at,last_verified_at)
          VALUES ($1,$2,'active','verified','active',now()+interval '30 days','in_sync',now(),now())`, [context.tenantId, report.intent.artifactId]);
        lineage.push(['claim', positiveClaimId, 'artifact', report.intent.artifactId, 'rendered_into', { renderInput: report.renderInput }]);
        lineage.push(['report_template', REPORT_TEMPLATE_ID, 'artifact', report.intent.artifactId, 'rendered_with', { templateSha256: REPORT_TEMPLATE_SHA256 }]);
        const reportPublished = await client.query("UPDATE report_publish_intents SET status='published',state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='object_verified'", [context.tenantId, report.intent.id]);
        if (reportPublished.rowCount !== 1) throw new GenewayError('REPORT_PUBLISH_CAS_CONFLICT', 'Report publish intent is no longer publishable', 409);
      }

      for (const [fromKind, fromId, toKind, toId, relation, metadata] of lineage) {
        await client.query(`INSERT INTO lineage_records
          (tenant_id,id,business_task_id,from_kind,from_id,to_kind,to_id,relation,metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [context.tenantId, id('lineage'), context.taskId, fromKind, fromId, toKind, toId, relation, metadata]);
      }
      const incomplete = await client.query("SELECT 1 FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$2 AND status<>'completed' LIMIT 1", [context.tenantId, context.taskId]);
      if (incomplete.rowCount !== 0) throw new GenewayError('RESULT_PUBLISH_GUARD', 'All approved workflow steps must complete before terminal publish', 409);
      const attemptCompleted = await client.query("UPDATE execution_attempts SET status='completed',completed_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", [context.tenantId, context.attemptId]);
      const deliveryCompleted = await client.query("UPDATE outbox_deliveries SET status='completed',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='leased'", [context.tenantId, context.deliveryId]);
      const inboxCompleted = await client.query("UPDATE inbox_events SET status='completed',completed_at=now() WHERE tenant_id=$1 AND consumer=$2 AND event_id=$3 AND status IN ('received','processing')", [context.tenantId, CONSUMER, context.eventId]);
      const result = taskResultSchema.parse(input.candidate.result);
      const taskCompleted = await client.query("UPDATE business_tasks SET status='completed',result=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", [context.tenantId, context.taskId, result]);
      if (attemptCompleted.rowCount !== 1 || deliveryCompleted.rowCount !== 1
        || inboxCompleted.rowCount !== 1 || taskCompleted.rowCount !== 1) {
        throw new GenewayError('TERMINAL_PUBLISH_CAS_CONFLICT', 'Terminal publish lost the execution compare-and-set race', 409);
      }
      await client.query("INSERT INTO messages (tenant_id,id,conversation_id,author,body) VALUES ($1,$2,$3,'xiaowei',$4)", [
        context.tenantId, id('message'), context.conversationId, '小纬已完成模拟方案分析。结果仅供演示，不能用于业务决策。',
      ]);
      await this.appendEvent(client, context.tenantId, context.taskId, 'business_task.completed', { result, candidateId: input.candidateId });
    });
  }

  private async fail(command: Extract<WorkerCommand, { command: 'fail_delivery' }>): Promise<void> {
    await this.idempotentWorkerMutation(command, async (client) => {
      const context = await this.requireAttempt(command, client);
      await this.lockCurrentAttempt(client, context);
      const failed = taskResultSchema.parse({ kind: 'failed', code: command.code, message: command.message, ...SIMULATION_ENVELOPE });
      const attempt = await client.query("UPDATE execution_attempts SET status='failed',completed_at=now(),last_error=$3 WHERE tenant_id=$1 AND id=$2 AND status='running'", [context.tenantId, context.attemptId, command.code]);
      const delivery = await client.query("UPDATE outbox_deliveries SET status='failed',last_error=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='leased'", [context.tenantId, context.deliveryId, command.code]);
      const inbox = await client.query("UPDATE inbox_events SET status='failed',processing_at=coalesce(processing_at,now()),completed_at=now(),last_error=$4 WHERE tenant_id=$1 AND consumer=$2 AND event_id=$3 AND status IN ('received','processing')", [context.tenantId, CONSUMER, context.eventId, command.code]);
      const task = await client.query("UPDATE business_tasks SET status='failed',result=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", [context.tenantId, context.taskId, failed]);
      if (attempt.rowCount !== 1 || delivery.rowCount !== 1 || inbox.rowCount !== 1 || task.rowCount !== 1) {
        throw new GenewayError('FAIL_DELIVERY_CAS_CONFLICT', 'Failure lost the terminal compare-and-set race', 409);
      }
      await this.appendEvent(client, context.tenantId, context.taskId, 'business_task.failed', { code: command.code, message: command.message });
      return { accepted: true };
    });
  }

  private async idempotentWorkerMutation<T extends Readonly<Record<string, unknown>>>(
    command: IdempotentWorkerCommand,
    effect: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
        command.attemptId,
        `${command.workerInstanceId}:${command.idempotencyKey}`,
      ]);
      const identity = await client.query<{ tenant_id: string; business_task_id: string; execution_version: string; fencing_token: string }>(`SELECT a.tenant_id,a.business_task_id,a.execution_version::text,a.fencing_token::text
        FROM execution_attempts a JOIN outbox_deliveries d
          ON d.tenant_id=a.tenant_id AND d.execution_attempt_id=a.id AND d.business_task_id=a.business_task_id
        WHERE a.id=$1 AND a.worker_instance_id=$2 AND a.fencing_token=$3
          AND d.id=$4 AND d.event_id=$5 AND d.consumer=$6 AND d.deployment_id=$7`, [
        command.attemptId, command.workerInstanceId, command.fencingToken,
        command.deliveryId, command.eventId, CONSUMER, DEPLOYMENT,
      ]);
      const identityRow = identity.rows[0];
      if (identityRow === undefined || identity.rowCount !== 1) {
        throw new GenewayError('STALE_OR_UNAUTHORIZED_WORKER_COMMAND', 'Worker command does not match a known delivery identity', 409);
      }
      const requestDigest = hashCanonical(command);
      const existing = await client.query<{ command_type: string; request_digest: string; response: T }>(`SELECT command_type,request_digest,response
        FROM worker_command_receipts WHERE tenant_id=$1 AND worker_instance_id=$2 AND idempotency_key=$3`, [
        identityRow.tenant_id, command.workerInstanceId, command.idempotencyKey,
      ]);
      const receipt = existing.rows[0];
      if (receipt !== undefined) {
        if (receipt.command_type !== command.command || receipt.request_digest !== requestDigest) {
          throw new GenewayError('WORKER_IDEMPOTENCY_CONFLICT', 'Worker idempotency key was reused for different command semantics', 409);
        }
        return receipt.response;
      }
      const response = await effect(client);
      await client.query(`INSERT INTO worker_command_receipts
        (tenant_id,execution_attempt_id,business_task_id,execution_version,fencing_token,worker_instance_id,
         command_type,idempotency_key,request_digest,response)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        identityRow.tenant_id, command.attemptId, identityRow.business_task_id,
        Number(identityRow.execution_version), Number(identityRow.fencing_token), command.workerInstanceId,
        command.command, command.idempotencyKey, requestDigest, response,
      ]);
      return response;
    });
  }

  private async requireAttempt(command: Exclude<WorkerCommand, { command: 'session' | 'claim_delivery' }>, client?: PoolClient): Promise<AttemptContext> {
    if (client === undefined) return this.withTransaction((transaction) => this.requireAttempt(command, transaction));
    const result = await client.query<{
      tenant_id: string;
      business_task_id: string;
      conversation_id: string;
      requester_id: string;
      workflow_version_id: string;
      workflow_hash: string;
      input_snapshot: unknown;
      event_id: string;
      delivery_id: string;
      attempt_id: string;
      execution_version: string;
      fencing_token: string;
      worker_instance_id: string;
    }>(`SELECT t.tenant_id,t.id business_task_id,t.conversation_id,t.requester_id,t.workflow_version_id,t.workflow_hash,
      t.input_snapshot,d.event_id,d.id delivery_id,a.id attempt_id,a.execution_version::text,a.fencing_token::text,a.worker_instance_id
      FROM business_tasks t JOIN execution_attempts a ON a.tenant_id=t.tenant_id AND a.id=t.current_execution_attempt_id
      JOIN outbox_deliveries d ON d.tenant_id=a.tenant_id AND d.execution_attempt_id=a.id
      JOIN inbox_events i ON i.tenant_id=d.tenant_id AND i.consumer=d.consumer AND i.event_id=d.event_id
      WHERE d.id=$1 AND d.event_id=$2 AND a.id=$3 AND a.fencing_token=$4 AND a.worker_instance_id=$5
        AND d.consumer=$6 AND d.deployment_id=$7 AND d.status='leased' AND a.status='running'
        AND d.lease_until>now() AND a.lease_until>now()
        AND t.status='running' AND t.execution_fencing_token=$4 AND i.status IN ('received','processing')
        AND EXISTS (
          SELECT 1 FROM approval_versions approval
          WHERE approval.tenant_id=t.tenant_id AND approval.business_task_id=t.id
            AND approval.status='approved' AND approval.expires_at>now()
            AND approval.version=(SELECT max(latest.version) FROM approval_versions latest
              WHERE latest.tenant_id=t.tenant_id AND latest.business_task_id=t.id)
        )
        AND EXISTS (
          SELECT 1 FROM delegated_capabilities capability
          WHERE capability.tenant_id=t.tenant_id AND capability.business_task_id=t.id
            AND capability.principal_id=t.requester_id AND capability.expires_at>now()
        )`, [
      command.deliveryId, command.eventId, command.attemptId, command.fencingToken,
      command.workerInstanceId, CONSUMER, DEPLOYMENT,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new GenewayError('STALE_OR_UNAUTHORIZED_WORKER_COMMAND', 'Worker command does not match the current execution authority', 409);
    const inputRef = resolvedTaskInputRefSchema.parse(row.input_snapshot);
    await this.assertTaskExecutionAuthority(client, row.tenant_id, row.business_task_id, {
      inputRef,
      workflowVersionId: row.workflow_version_id,
      workflowHash: row.workflow_hash,
    });
    return {
      tenantId: row.tenant_id,
      taskId: row.business_task_id,
      conversationId: row.conversation_id,
      requesterId: row.requester_id,
      workflowVersionId: row.workflow_version_id,
      workflowHash: row.workflow_hash,
      inputRef,
      eventId: row.event_id,
      deliveryId: row.delivery_id,
      attemptId: row.attempt_id,
      executionVersion: Number(row.execution_version),
      fencingToken: Number(row.fencing_token),
      workerInstanceId: row.worker_instance_id,
    };
  }

  private async finalizeInputRead(
    command: Exclude<WorkerCommand, { command: 'session' | 'claim_delivery' }>,
    expected: AttemptContext,
  ): Promise<void> {
    await this.withTransaction(async (client) => {
      const current = await this.requireAttempt(command, client);
      if (hashCanonical(current) !== hashCanonical(expected)) {
        throw new GenewayError('EXECUTION_CONTEXT_CHANGED', 'Execution authority changed while Worker input was being read', 409);
      }
      const updated = await client.query(`UPDATE inbox_events SET status='processing',processing_at=coalesce(processing_at,now())
        WHERE tenant_id=$1 AND consumer=$2 AND event_id=$3 AND execution_attempt_id=$4
          AND worker_instance_id=$5 AND fencing_token=$6 AND status IN ('received','processing')`, [
        current.tenantId, CONSUMER, current.eventId, current.attemptId,
        current.workerInstanceId, current.fencingToken,
      ]);
      if (updated.rowCount !== 1) throw new GenewayError('WORKER_INBOX_CAS_CONFLICT', 'Worker input delivery is no longer processable', 409);
    });
  }

  private async assertTaskExecutionAuthority(
    client: PoolClient,
    tenantId: string,
    taskId: string,
    expected: Readonly<{ inputRef: ResolvedTaskInputRef; workflowVersionId: string; workflowHash: string }>,
  ): Promise<void> {
    const authority = await client.query<{
      requester_id: string;
      input_snapshot: unknown;
      expert_target: unknown;
      expert_catalog_version_id: string;
      harness_version_id: string;
      workflow_version_id: string;
      workflow_hash: string;
      permission_scope: unknown;
      audience_scope: unknown;
      budget: unknown;
      approval_status: string;
      approval_subject: unknown;
      approval_subject_digest: string;
      approval_expires_at: Date;
      capability_principal_id: string;
      capability_allowed_actions: unknown;
      capability_resource_scopes: unknown;
      capability_audience_scope: unknown;
      capability_expires_at: Date;
    }>(`SELECT t.requester_id,t.input_snapshot,t.expert_target,t.expert_catalog_version_id,t.harness_version_id,
      t.workflow_version_id,t.workflow_hash,t.permission_scope,t.audience_scope,t.budget,
      approval.status approval_status,approval.subject approval_subject,approval.subject_digest approval_subject_digest,
      approval.expires_at approval_expires_at,capability.principal_id capability_principal_id,
      capability.allowed_actions capability_allowed_actions,capability.resource_scopes capability_resource_scopes,
      capability.audience_scope capability_audience_scope,capability.expires_at capability_expires_at
      FROM business_tasks t
      JOIN approval_versions approval ON approval.tenant_id=t.tenant_id AND approval.business_task_id=t.id
        AND approval.version=(SELECT max(latest.version) FROM approval_versions latest
          WHERE latest.tenant_id=t.tenant_id AND latest.business_task_id=t.id)
      JOIN delegated_capabilities capability ON capability.tenant_id=t.tenant_id AND capability.business_task_id=t.id
      WHERE t.tenant_id=$1 AND t.id=$2
      FOR SHARE OF approval,capability`, [tenantId, taskId]);
    const row = authority.rows[0];
    if (row === undefined || authority.rowCount !== 1) {
      throw new GenewayError('EXECUTION_AUTHORITY_INVALID', 'Task must have exactly one current execution authority', 409);
    }
    const now = Date.now();
    if (row.approval_status !== 'approved' || row.approval_expires_at.getTime() <= now
      || row.capability_principal_id !== row.requester_id || row.capability_expires_at.getTime() <= now) {
      throw new GenewayError('EXECUTION_AUTHORITY_EXPIRED', 'Task approval or delegated capability is no longer valid', 409);
    }
    const inputRef = resolvedTaskInputRefSchema.parse(row.input_snapshot);
    if (hashCanonical(inputRef) !== hashCanonical(expected.inputRef)
      || row.workflow_version_id !== expected.workflowVersionId || row.workflow_hash !== expected.workflowHash) {
      throw new GenewayError('EXECUTION_CONTEXT_CHANGED', 'Task execution context changed after delivery selection', 409);
    }
    const permissionScope = row.permission_scope as Readonly<{ actions?: unknown; resourceScopes?: unknown }>;
    const audienceScope = row.audience_scope as Readonly<{ ids?: unknown }>;
    if (hashCanonical(row.capability_allowed_actions) !== hashCanonical(permissionScope.actions)
      || hashCanonical(row.capability_resource_scopes) !== hashCanonical(permissionScope.resourceScopes)
      || hashCanonical(row.capability_audience_scope) !== hashCanonical(audienceScope.ids)) {
      throw new GenewayError('DELEGATED_CAPABILITY_CHANGED', 'Delegated capability no longer matches task scope', 409);
    }
    const expectedSubject = buildApprovalSubject({
      taskId,
      requesterId: row.requester_id,
      inputSnapshot: inputRef,
      expertTarget: row.expert_target as Readonly<Record<string, unknown>>,
      expertCatalogVersionId: row.expert_catalog_version_id,
      harnessVersionId: row.harness_version_id,
      workflowVersionId: row.workflow_version_id,
      workflowHash: row.workflow_hash,
      permissionScope: row.permission_scope as Readonly<Record<string, unknown>>,
      audienceScope: row.audience_scope as Readonly<Record<string, unknown>>,
      budget: row.budget as Readonly<Record<string, unknown>>,
    });
    if (hashCanonical(row.approval_subject) !== row.approval_subject_digest
      || hashCanonical(expectedSubject) !== row.approval_subject_digest) {
      throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Approved subject no longer matches current execution semantics', 409);
    }
    if (inputRef.kind === 'document_snapshot') {
      const source = await client.query(`SELECT 1 FROM document_snapshots d
        JOIN artifacts a ON a.tenant_id=d.tenant_id AND a.id=d.artifact_id
        JOIN artifact_states s ON s.tenant_id=d.tenant_id AND s.artifact_id=d.artifact_id
        WHERE d.tenant_id=$1 AND d.id=$2 AND d.created_by=$3 AND a.owner_user_id=$3
          AND d.artifact_id=$4 AND d.manifest_id=$5 AND d.content_sha256=$6
          AND d.simulation_profile=$7 AND d.profile_registry_version=$8 AND d.resource_scope=$9
          AND d.data_class=$10 AND ('conversation:' || d.conversation_id)=$11
          AND d.audience=jsonb_build_object('kind','private-conversation','conversationId',d.conversation_id)
          AND s.availability='active' AND s.integrity='verified' AND s.retention_status='active'
          AND s.retention_expires_at>now() AND s.reconcile_status='in_sync'
        FOR SHARE OF d,a,s`, [
        tenantId, inputRef.documentSnapshotId, row.requester_id, inputRef.artifactId, inputRef.manifestId,
        inputRef.contentSha256, inputRef.simulationProfile, inputRef.profileRegistryVersion, inputRef.resourceScope,
        inputRef.dataClass, inputRef.audience,
      ]);
      if (source.rowCount !== 1) {
        throw new GenewayError('WORKER_INPUT_NOT_READY', 'Frozen document input is no longer eligible for Worker access', 409);
      }
    }
  }

  private async lockCurrentAttempt(client: PoolClient, context: AttemptContext): Promise<void> {
    const current = await client.query(`SELECT 1 FROM business_tasks t JOIN execution_attempts a
      ON a.tenant_id=t.tenant_id AND a.id=t.current_execution_attempt_id
      WHERE t.tenant_id=$1 AND t.id=$2 AND t.status='running' AND a.id=$3 AND a.status='running'
        AND a.worker_instance_id=$4 AND a.fencing_token=$5 AND t.execution_fencing_token=$5 FOR UPDATE OF t,a`, [
      context.tenantId, context.taskId, context.attemptId, context.workerInstanceId, context.fencingToken,
    ]);
    if (current.rowCount !== 1) throw new GenewayError('STALE_EXECUTION_ATTEMPT', 'Execution attempt is no longer current', 409);
  }

  private async appendEvent(client: PoolClient, tenantId: string, taskId: string, eventType: string, payload: unknown): Promise<void> {
    const taskUpdate = await client.query<{ aggregate_version: string }>('UPDATE business_tasks SET aggregate_version=aggregate_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING aggregate_version::text', [tenantId, taskId]);
    const aggregateVersion = Number(taskUpdate.rows[0]?.aggregate_version);
    const sequenceResult = await client.query<{ sequence: string }>('SELECT coalesce(max(sequence),0)+1 AS sequence FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2', [tenantId, taskId]);
    const sequence = Number(sequenceResult.rows[0]?.sequence);
    if (!Number.isSafeInteger(aggregateVersion) || !Number.isSafeInteger(sequence)) throw new GenewayError('EVENT_SEQUENCE_INVALID', 'Task event sequence is invalid', 500);
    const eventId = id('event');
    const eventPayload = { ...(typeof payload === 'object' && payload !== null ? payload : { value: payload }), ...SIMULATION_ENVELOPE };
    await client.query(`INSERT INTO business_task_events
      (tenant_id,id,business_task_id,sequence,event_type,aggregate_version,correlation_id,payload,simulation,runtime_mode,business_decision_allowed)
      VALUES ($1,$2,$3,$4,$5,$6,$3,$7,true,'fake',false)`, [tenantId, eventId, taskId, sequence, eventType, aggregateVersion, eventPayload]);
    await client.query('INSERT INTO outbox_events (tenant_id,id,business_task_id,event_id,event_type,payload) VALUES ($1,$2,$3,$4,$5,$6)', [tenantId, id('outbox'), taskId, eventId, eventType, eventPayload]);
  }

  private async withTransaction<T>(effect: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.repository.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await effect(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createWorkerCommandApp(input: Readonly<{
  repository: ControlPlaneRepository;
  storage: ObjectStorage;
  token: string;
  logger?: boolean;
}>): FastifyInstance {
  if (input.token.length < 32) throw new Error('Worker service token must contain at least 32 characters');
  const service = new WorkerCommandService(input.repository, input.storage);
  const app = Fastify({ logger: input.logger ?? false, trustProxy: false, bodyLimit: 256 * 1024 });
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.headers.origin !== undefined) {
      done(new GenewayError('WORKER_BROWSER_ORIGIN_DENIED', 'Browser-originated Worker commands are not allowed', 403));
      return;
    }
    done();
  });
  app.post('/internal/worker/v1/commands', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, input.token)) {
      throw new GenewayError('WORKER_AUTH_REQUIRED', 'Worker service authentication failed', 401);
    }
    const command = workerCommandSchema.parse(request.body);
    if ('consumer' in command && command.consumer !== CONSUMER) throw new GenewayError('WORKER_CONSUMER_DENIED', 'Worker consumer is not allowed', 403);
    if ('deploymentId' in command && command.deploymentId !== DEPLOYMENT) throw new GenewayError('WORKER_DEPLOYMENT_DENIED', 'Worker deployment is not allowed', 403);
    return reply.status(200).send(await service.execute(command));
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GenewayError) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    void reply.status(500).send({ error: { code: 'INTERNAL_WORKER_COMMAND_ERROR', message: 'Worker command failed' } });
  });
  return app;
}
