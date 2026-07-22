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

function storageOracle(action: 'get', key: string): Readonly<{ bytesBase64?: string; contentSha256?: string | null }> {
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
  return JSON.parse(executed.stdout) as Readonly<{ bytesBase64?: string; contentSha256?: string | null }>;
}

test('served UI uploads, verifies, recovers and downloads one private source artifact', async ({ page, request }) => {
  for (const role of ['browser', 'control-plane', 'vite'] as const) {
    const receipt = JSON.parse(await readFile(`/tmp/geneway-runs/${runId}/process-boundaries/${role}.json`, 'utf8')) as unknown;
    expect(receipt).toEqual(expect.objectContaining({ role, checked: true, forbiddenNamesPresent: [] }));
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
  await expect(card).toContainText('已校验');
  await expect(page.getByTestId('artifact-size')).toHaveText('180 bytes');
  await expect(page.getByTestId('artifact-hash')).toHaveText(`sha256:${expectedHash}`);
  await expect(page.getByTestId('artifact-eligibility')).toContainText('可用于模拟分析');
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
      (SELECT count(*)::text FROM artifacts scoped_artifact
        WHERE scoped_artifact.tenant_id=a.tenant_id AND scoped_artifact.id=a.id) artifact_count,
      (SELECT count(*)::text FROM business_tasks scoped_task
        WHERE scoped_task.tenant_id=a.tenant_id AND scoped_task.conversation_id=$2) task_count,
      (SELECT count(*)::text FROM outbox_events scoped_outbox
        JOIN business_tasks scoped_task ON scoped_task.tenant_id=scoped_outbox.tenant_id
          AND scoped_task.id=scoped_outbox.business_task_id
        WHERE scoped_task.tenant_id=a.tenant_id AND scoped_task.conversation_id=$2) outbox_count
      FROM artifacts a JOIN artifact_manifests m ON m.tenant_id=a.tenant_id AND m.artifact_id=a.id
      JOIN document_snapshots d ON d.tenant_id=a.tenant_id AND d.artifact_id=a.id
      WHERE a.tenant_id='tenant_local' AND a.id=$1`, [ids.artifactId, conversationId]);
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
    createReadStream(downloadPath).on('data', (chunk) => { chunks.push(Buffer.from(chunk)); }).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
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
