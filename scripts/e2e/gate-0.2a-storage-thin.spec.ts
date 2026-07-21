import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
const composeProject = process.env.COMPOSE_PROJECT_NAME;
const s3Port = process.env.GENEWAY_S3_PORT;
if (databaseUrl === undefined || composeProject === undefined || s3Port === undefined) {
  throw new Error('Gate 0.2A storage thin test requires disposable Postgres and storage orchestration');
}

const expectedHash = '3b5ee113e79ab2afb504898cf962da10f7d31e62ddb89370e645c2d32f48ca06';
const fixturePath = path.resolve(process.cwd(), 'scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt');
const runId = process.env.GENEWAY_RUN_ID;
if (runId === undefined) throw new Error('Gate 0.2A storage thin test requires a run ID');

function storageOracle(action: 'get' | 'delete', key: string): Readonly<{ bytesBase64?: string; contentSha256?: string | null; deleted?: boolean }> {
  const located = spawnSync('docker', [
    'ps', '--filter', `label=com.docker.compose.project=${composeProject}`,
    '--filter', 'label=com.docker.compose.service=storage-oracle', '--format', '{{.ID}}',
  ], { encoding: 'utf8' });
  if (located.status !== 0) throw new Error(`Unable to locate storage oracle container: ${located.stderr}`);
  const containerId = located.stdout.trim();
  if (containerId.length === 0 || containerId.includes('\n')) throw new Error('Storage oracle container is missing or ambiguous');
  const executed = spawnSync('docker', [
    'exec', '-i', containerId, './node_modules/.bin/tsx', 'scripts/storage-oracle-cli.ts', action, key,
  ], { encoding: 'utf8' });
  if (executed.status !== 0) throw new Error(`Storage oracle ${action} failed: ${executed.stderr}`);
  return JSON.parse(executed.stdout) as Readonly<{ bytesBase64?: string; contentSha256?: string | null; deleted?: boolean }>;
}

test('served UI uploads, verifies, recovers and downloads one private source artifact', async ({ page, request }) => {
  for (const role of ['browser', 'control-plane', 'vite'] as const) {
    const receipt = JSON.parse(await readFile(`/tmp/geneway-runs/${runId}/process-boundaries/${role}.json`, 'utf8')) as unknown;
    expect(receipt).toEqual({ role, checked: true, forbiddenNamesPresent: [] });
  }
  const fixture = await readFile(fixturePath);
  expect(fixture).toHaveLength(180);
  await page.goto('/conversations/new?capability=solution.analysis.v1');
  await expect(page.getByTestId('welcome-empty')).toBeVisible();
  await page.getByTestId('artifact-upload-input').setInputFiles({
    name: 'solution-analysis-demo-v2.txt',
    mimeType: 'text/plain',
    buffer: fixture,
  });

  const card = page.getByTestId('artifact-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('完整性已验证');
  await expect(page.getByTestId('artifact-size')).toHaveText('180 bytes');
  await expect(page.getByTestId('artifact-hash')).toHaveText(`sha256:${expectedHash}`);
  await expect(page.getByTestId('artifact-eligibility')).toContainText('任务入口将在下一纵切开放');
  await expect(page.getByTestId('task-card')).toHaveCount(0);

  const ids = await card.evaluate((element) => ({
    artifactId: element.getAttribute('data-artifact-id'),
    manifestId: element.getAttribute('data-manifest-id'),
    snapshotId: element.getAttribute('data-snapshot-id'),
    contentSha256: element.getAttribute('data-content-sha256'),
  }));
  expect(ids).toMatchObject({ contentSha256: expectedHash });
  expect(ids.artifactId).toBeTruthy();
  expect(ids.manifestId).toBeTruthy();
  expect(ids.snapshotId).toBeTruthy();
  const conversationId = await page.evaluate(() => localStorage.getItem('geneway.conversationId'));
  expect(conversationId).toBeTruthy();

  const listResponse = await request.get(`/api/conversations/${conversationId ?? ''}/document-snapshots`);
  expect(listResponse.ok()).toBeTruthy();
  await expect(listResponse.json()).resolves.toEqual({ documentSnapshots: [expect.objectContaining({
    status: 'available',
    documentSnapshot: expect.objectContaining({
      id: ids.snapshotId,
      artifactId: ids.artifactId,
      manifestId: ids.manifestId,
      contentSha256: expectedHash,
      sizeBytes: 180,
      simulationProfile: 'solution-analysis-demo/v2',
    }),
    artifactState: {
      availability: 'active',
      integrity: 'verified',
      retentionStatus: 'active',
      reconcileStatus: 'in_sync',
      stateVersion: 1,
      downloadAllowed: true,
    },
    executionEligibility: { eligible: true },
  })] });

  const pool = new Pool({ connectionString: databaseUrl });
  let storageKey: string;
  try {
    const authority = await pool.query<{
      artifact_id: string; manifest_id: string; snapshot_id: string; storage_key: string; content_sha256: string;
      artifact_count: string; task_count: string; outbox_count: string;
    }>(`SELECT a.id artifact_id,m.id manifest_id,d.id snapshot_id,m.storage_key,a.content_sha256,
      (SELECT count(*)::text FROM artifacts) artifact_count,
      (SELECT count(*)::text FROM business_tasks) task_count,
      (SELECT count(*)::text FROM outbox_events) outbox_count
      FROM artifacts a JOIN artifact_manifests m ON m.tenant_id=a.tenant_id AND m.artifact_id=a.id
      JOIN document_snapshots d ON d.tenant_id=a.tenant_id AND d.artifact_id=a.id
      WHERE a.tenant_id='tenant_local' AND a.id=$1`, [ids.artifactId]);
    expect(authority.rows).toEqual([expect.objectContaining({
      artifact_id: ids.artifactId,
      manifest_id: ids.manifestId,
      snapshot_id: ids.snapshotId,
      content_sha256: expectedHash,
      artifact_count: '1',
      task_count: '0',
      outbox_count: '0',
    })]);
    const key = authority.rows[0]?.storage_key;
    if (key === undefined) throw new Error('Postgres did not resolve the object storage key');
    storageKey = key;
  } finally { await pool.end(); }

  const object = storageOracle('get', storageKey);
  expect(Buffer.from(object.bytesBase64 ?? '', 'base64')).toEqual(fixture);
  expect(object.contentSha256).toBe(expectedHash);

  const apiDownload = await request.get(`/api/artifacts/${ids.artifactId ?? ''}/download`);
  expect(apiDownload.ok()).toBeTruthy();
  expect(await apiDownload.body()).toEqual(fixture);
  const browserDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('artifact-download').click();
  const browserDownload = await browserDownloadPromise;
  expect(browserDownload.suggestedFilename()).toBe('solution-analysis-demo-v2.txt');
  const downloadPath = await browserDownload.path();
  if (downloadPath === null) throw new Error('Browser did not retain the downloaded file');
  const browserBytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    createReadStream(downloadPath).on('data', (chunk: Buffer) => chunks.push(chunk)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
  expect(browserBytes).toEqual(fixture);

  await page.reload();
  await expect(page.getByTestId('artifact-card')).toHaveAttribute('data-artifact-id', ids.artifactId ?? '');
  await expect(page.getByTestId('artifact-hash')).toHaveText(`sha256:${expectedHash}`);
  await expect(page.getByTestId('task-card')).toHaveCount(0);

  const browserCanReachS3 = await page.evaluate(async (port) => {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { mode: 'no-cors', signal: AbortSignal.timeout(1_000) });
      return true;
    } catch { return false; }
  }, s3Port);
  expect(browserCanReachS3).toBe(false);
});

test('served UI hides metadata and disables use after the backing object disappears', async ({ page, request }) => {
  const fixture = await readFile(fixturePath);
  await page.goto('/conversations/new?capability=solution.analysis.v1');
  await page.getByTestId('artifact-upload-input').setInputFiles({
    name: 'solution-analysis-demo-v2.txt',
    mimeType: 'text/plain',
    buffer: fixture,
  });
  const card = page.getByTestId('artifact-card');
  await expect(card).toHaveCount(1);
  const artifactId = await card.getAttribute('data-artifact-id');
  expect(artifactId).toBeTruthy();

  const pool = new Pool({ connectionString: databaseUrl });
  let storageKey: string;
  try {
    const manifest = await pool.query<{ storage_key: string }>(`SELECT storage_key FROM artifact_manifests
      WHERE tenant_id='tenant_local' AND artifact_id=$1`, [artifactId]);
    const resolved = manifest.rows[0]?.storage_key;
    if (resolved === undefined) throw new Error('Postgres did not resolve the object storage key');
    storageKey = resolved;
  } finally { await pool.end(); }

  expect(storageOracle('delete', storageKey)).toEqual({ deleted: true });
  const failedDownload = await request.get(`/api/artifacts/${artifactId ?? ''}/download`);
  expect(failedDownload.status()).toBe(409);
  await expect(failedDownload.json()).resolves.toMatchObject({ error: { code: 'ARTIFACT_OBJECT_MISSING' } });

  await page.reload();
  const unavailable = page.getByTestId('artifact-unavailable-card');
  await expect(unavailable).toContainText('材料对象不可用或完整性异常');
  await expect(page.getByTestId('snapshot-unavailable-inspector')).toContainText('对象不可用 / 完整性异常');
  await expect(page.getByTestId('artifact-card')).toHaveCount(0);
  await expect(page.getByTestId('artifact-download')).toHaveCount(0);
  await expect(page.getByTestId('artifact-hash')).toHaveCount(0);
  await expect(page.getByTestId('task-card')).toHaveCount(0);

  const conversationId = await page.evaluate(() => localStorage.getItem('geneway.conversationId'));
  const deniedList = await request.get(`/api/conversations/${conversationId ?? ''}/document-snapshots`);
  expect(deniedList.status()).toBe(404);
  const deniedBody = await deniedList.text();
  expect(deniedBody).not.toContain(artifactId ?? 'missing-artifact');
  expect(deniedBody).not.toContain(expectedHash);

  const verificationPool = new Pool({ connectionString: databaseUrl });
  try {
    const state = await verificationPool.query<{ availability: string; integrity: string; reconcile_status: string }>(`SELECT availability,integrity,reconcile_status
      FROM artifact_states WHERE tenant_id='tenant_local' AND artifact_id=$1`, [artifactId]);
    expect(state.rows).toEqual([{ availability: 'missing', integrity: 'failed', reconcile_status: 'required' }]);
    const audit = await verificationPool.query<{ reason_code: string }>(`SELECT reason_code FROM audit_events
      WHERE tenant_id='tenant_local' AND event_type='artifact.snapshot.read.denied' AND resource_id=$1`, [artifactId]);
    expect(audit.rows).toContainEqual({ reason_code: 'ARTIFACT_NOT_AVAILABLE' });
  } finally { await verificationPool.end(); }
});
