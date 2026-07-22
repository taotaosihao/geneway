import pg from 'pg';
import { HttpObjectReconciliationStorage } from '@geneway/storage';
import { GenewayError } from '@geneway/contracts';
import { StorageReconciler } from '../apps/control-plane/src/storage-reconciler.js';

const databaseUrl = process.env.DATABASE_URL;
const baseUrl = process.env.GENEWAY_RECONCILIATION_ADAPTER_URL;
const token = process.env.GENEWAY_RECONCILIATION_ADAPTER_TOKEN;
const bucket = process.env.GENEWAY_S3_BUCKET;
const allowedPrefix = process.env.GENEWAY_STORAGE_ALLOWED_PREFIX;
const tenantId = process.env.GENEWAY_RECONCILIATION_TENANT_ID ?? 'tenant_local';
const orphanDeleteGraceMs = Number(process.env.GENEWAY_RECONCILIATION_ORPHAN_DELETE_GRACE_MS ?? 30_000);
const staleIngestGraceMs = Number(process.env.GENEWAY_RECONCILIATION_STALE_INGEST_GRACE_MS ?? 30_000);
if (databaseUrl === undefined || baseUrl === undefined || token === undefined
  || bucket === undefined || allowedPrefix === undefined
  || !Number.isSafeInteger(orphanDeleteGraceMs) || orphanDeleteGraceMs < 1_000 || orphanDeleteGraceMs > 86_400_000
  || !Number.isSafeInteger(staleIngestGraceMs) || staleIngestGraceMs < 1_000 || staleIngestGraceMs > 86_400_000) {
  throw new Error('Storage reconciler environment is incomplete');
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const storage = new HttpObjectReconciliationStorage({ baseUrl, token, bucket, allowedPrefix });
const reconciler = new StorageReconciler(pool, storage, tenantId, allowedPrefix);
const controller = new AbortController();
const orphanFirstObservedAt = new Map<string, number>();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

try {
  while (!controller.signal.aborted) {
    let reconciliationFailed = false;
    const staleBefore = new Date(Date.now() - staleIngestGraceMs);
    const staleIngests = await pool.query<{ id: string }>(`SELECT id FROM artifact_ingest_intents
      WHERE tenant_id=$1 AND status='put_inflight' AND updated_at<=$2
      ORDER BY updated_at,id LIMIT 10`, [tenantId, staleBefore]);
    for (const row of staleIngests.rows) {
      try {
        await reconciler.reconcileStaleIngestIntent(tenantId, row.id, staleBefore);
      } catch (error) {
        reconciliationFailed = true;
        if (!(error instanceof GenewayError && error.code === 'BACKUP_BARRIER_ACTIVE')) {
          process.stderr.write(`stale ingest reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        }
      }
    }
    const pending = await pool.query<{ id: string }>(`SELECT intent.id
      FROM report_publish_intents intent
      JOIN business_tasks task ON task.tenant_id=intent.tenant_id AND task.id=intent.business_task_id
      WHERE intent.tenant_id=$1 AND task.status IN ('canceled','failed')
        AND intent.status IN ('reconcile_required','put_failed_confirmed','integrity_error','delete_pending')
      ORDER BY intent.updated_at,intent.id LIMIT 10`, [tenantId]);
    for (const row of pending.rows) {
      try {
        await reconciler.reconcileReportIntent(tenantId, row.id);
      } catch (error) {
        reconciliationFailed = true;
        if (!(error instanceof GenewayError && error.code === 'BACKUP_BARRIER_ACTIVE')) {
          process.stderr.write(`storage reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        }
      }
    }
    try {
      const scan = await reconciler.scan();
      const currentOrphans = new Set(scan.findings
        .filter((finding) => finding.kind === 's3_object_orphan')
        .map((finding) => finding.key));
      const now = Date.now();
      for (const [key] of orphanFirstObservedAt) {
        if (!currentOrphans.has(key)) orphanFirstObservedAt.delete(key);
      }
      for (const key of currentOrphans) {
        const firstObservedAt = orphanFirstObservedAt.get(key);
        if (firstObservedAt === undefined) {
          orphanFirstObservedAt.set(key, now);
        } else if (now - firstObservedAt >= orphanDeleteGraceMs) {
          await reconciler.deleteUnreferencedObject(key);
          orphanFirstObservedAt.delete(key);
        }
      }
    } catch (error) {
      reconciliationFailed = true;
      if (!(error instanceof GenewayError && error.code === 'BACKUP_BARRIER_ACTIVE')) {
        process.stderr.write(`storage inventory reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      }
    }
    await wait(reconciliationFailed || (pending.rowCount === 0 && staleIngests.rowCount === 0) ? 250 : 10);
  }
} finally {
  await pool.end();
}
