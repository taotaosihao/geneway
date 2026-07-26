import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { gateACapabilityRouteProjectionSchema } from '@geneway/contracts';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
const runId = process.env.GENEWAY_RUN_ID;
if (databaseUrl === undefined || runId === undefined || process.env.GENEWAY_GATE_A_LIVE !== '1'
  || process.env.GENEWAY_GATE_A_NOT_OPEN_MARKER_REQUIRED !== '1'
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
  throw new Error('gate-a-not-open requires the disposable Gate A live harness and run-bound marker gate');
}
const pool = new Pool({ connectionString: databaseUrl });
const forbiddenFallbackPattern = /FakeRuntime|runtimeMode["'=:\s]+fake|simulation["'=:\s]+true|providerApiKey|authorization:\s*Bearer/iu;

test.afterAll(async () => pool.end());

test('internal release 前 public capability、UI 与数据库均保持 NOT_OPEN', async ({ page, request }) => {
  const capabilityResponse = await request.get('/api/capabilities/solution.analysis.v1');
  expect(capabilityResponse.ok()).toBe(true);
  const capability = gateACapabilityRouteProjectionSchema.parse(await capabilityResponse.json());
  expect(capability).toMatchObject({
    capabilityId: 'solution.analysis.v1',
    status: 'NOT_OPEN',
    executionRoute: 'not_open',
    availableExpertModes: [],
  });
  expect(JSON.stringify(capability)).not.toMatch(forbiddenFallbackPattern);

  await page.goto('/conversations/new?capability=solution.analysis.v1');
  const notOpen = page.getByTestId('not-open');
  await expect(notOpen).toBeVisible();
  await expect(notOpen).toContainText('NOT_OPEN');
  expect(await page.content()).not.toMatch(forbiddenFallbackPattern);

  const counts = await pool.query<{
    business_tasks: number;
    model_invocations: number;
    gateway_receipts: number;
  }>(`SELECT
    (SELECT count(*)::int FROM business_tasks task
      JOIN capability_versions capability
        ON capability.tenant_id=task.tenant_id AND capability.id=task.capability_version_id
      WHERE task.tenant_id='tenant_local' AND task.record_variant='business-task.live/1'
        AND capability.capability_id='solution.analysis.v1') business_tasks,
    (SELECT count(*)::int FROM gate_a_model_invocations
      WHERE tenant_id='tenant_local') model_invocations,
    (SELECT count(*)::int FROM gate_a_model_invocations
      WHERE tenant_id='tenant_local' AND gateway_receipt_jti IS NOT NULL) gateway_receipts`);
  expect(counts.rows).toEqual([{ business_tasks: 0, model_invocations: 0, gateway_receipts: 0 }]);

  const evidenceDirectory = `/tmp/geneway-runs/${runId}/gate-a`;
  const markerPath = `${evidenceDirectory}/not-open-verified.json`;
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await chmod(evidenceDirectory, 0o700);
  await writeFile(markerPath, `${JSON.stringify({
    schemaVersion: 'gate-a-not-open-verified/1',
    runId,
    assertions: {
      publicCapabilityStatus: 'NOT_OPEN',
      publicExecutionRoute: 'not_open',
      uiNotOpenVisible: true,
      businessTaskCount: 0,
      modelInvocationCount: 0,
      gatewayReceiptCount: 0,
    },
    verifiedAt: new Date().toISOString(),
  })}\n`, { flag: 'wx', mode: 0o600 });

  await expect.poll(async () => {
    const response = await request.get('/api/capabilities/solution.analysis.v1');
    if (!response.ok()) return `HTTP_${String(response.status())}`;
    return gateACapabilityRouteProjectionSchema.parse(await response.json()).status;
  }, { timeout: 60_000, intervals: [50, 100, 250] }).toBe('internal');
});
