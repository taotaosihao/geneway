import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const requiredRecoveryCaseIds = [
  'after_intent_commit_before_s3_put',
  'after_s3_put_before_db_finalize',
  'put_response_lost',
  'after_outbox_commit_before_worker_claim',
  'after_inbox_insert_before_step_execution',
  'after_step_side_effect_before_completion',
  'complete_step_ack_lost',
  'after_report_put_before_db_publish',
  'stale_attempt_completion',
  'cancel_vs_publish',
  'sse_snapshot_subscribe_gap',
  'control_plane_restart',
  'worker_restart',
] as const;

export type RecoveryCaseId = typeof requiredRecoveryCaseIds[number];
export type ProcessReceipt = Readonly<{
  role: 'control-plane' | 'worker';
  phase: 'ready';
  ready: true;
  pid: number;
  procStartTicks: string;
  generation: number;
  workerInstanceId?: string;
}>;

export type RecoveryCaseEvidence = Readonly<{
  caseId: RecoveryCaseId;
  faultTriggered: true;
  trigger: Readonly<Record<string, unknown>>;
  entityIds: Readonly<Record<string, string | readonly string[]>>;
  processBefore: Readonly<{ controlPlane: ProcessReceipt; worker: ProcessReceipt }>;
  processAfter: Readonly<{ controlPlane: ProcessReceipt; worker: ProcessReceipt }>;
  final: Readonly<Record<string, string | number | boolean | null>>;
  evidenceRefs: readonly string[];
}>;

function runId(): string {
  const value = process.env.GENEWAY_RUN_ID;
  if (value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error('GENEWAY_RUN_ID is invalid');
  return value;
}

export function recoveryRoot(): string {
  return `/tmp/geneway-runs/${runId()}/recovery`;
}

function validProcessReceipt(value: unknown, role: ProcessReceipt['role']): value is ProcessReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as Partial<ProcessReceipt>;
  return receipt.role === role
    && receipt.phase === 'ready'
    && receipt.ready === true
    && Number.isSafeInteger(receipt.pid)
    && typeof receipt.procStartTicks === 'string'
    && /^\d+$/u.test(receipt.procStartTicks)
    && Number.isSafeInteger(receipt.generation)
    && Number(receipt.generation) >= 1;
}

async function readLiveProcessReceipt(role: ProcessReceipt['role']): Promise<ProcessReceipt | undefined> {
  try {
    const path = `/tmp/geneway-runs/${runId()}/process-boundaries/${role}.json`;
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!validProcessReceipt(parsed, role)) return undefined;
    const raw = await readFile(`/proc/${String(parsed.pid)}/stat`, 'utf8');
    const closingParenthesis = raw.lastIndexOf(')');
    const liveStartTicks = closingParenthesis > 0
      ? raw.slice(closingParenthesis + 1).trim().split(/\s+/u)[19]
      : undefined;
    return liveStartTicks === parsed.procStartTicks ? parsed : undefined;
  } catch {
    // A supervised restart briefly replaces the child-written receipt with its
    // generation-enriched form. Retrying here rejects both partial and stale data.
    return undefined;
  }
}

export async function readProcessReceipt(role: ProcessReceipt['role']): Promise<ProcessReceipt> {
  return waitUntil(() => readLiveProcessReceipt(role), 5_000, `${role} live generation receipt`);
}

export async function readProcessPair(): Promise<Readonly<{ controlPlane: ProcessReceipt; worker: ProcessReceipt }>> {
  const [controlPlane, worker] = await Promise.all([readProcessReceipt('control-plane'), readProcessReceipt('worker')]);
  return { controlPlane, worker };
}

export function sameProcess(left: ProcessReceipt, right: ProcessReceipt): boolean {
  return left.pid === right.pid && left.procStartTicks === right.procStartTicks;
}

export async function waitUntil<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function writeRecoveryCase(evidence: RecoveryCaseEvidence): Promise<string> {
  const expected = new Set<string>(requiredRecoveryCaseIds);
  if (!expected.has(evidence.caseId) || evidence.faultTriggered !== true) throw new Error('Recovery case evidence is invalid');
  const directory = `${recoveryRoot()}/cases`;
  const path = `${directory}/${evidence.caseId}.json`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 'geneway-multiprocess-recovery-case/1',
    runId: runId(),
    recordedAt: new Date().toISOString(),
    fault_triggered: true,
    ...evidence,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}
