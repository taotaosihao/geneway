import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const executeFile = promisify(execFile);
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
if (databaseUrl === undefined) throw new Error('Gate 0.2B.3 visual oracle requires disposable Postgres');

test('异常列表与详情在固定 viewport 无 body 横向溢出，表格独立滚动', async ({ page }, testInfo) => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`INSERT INTO control_plane_database_metadata (singleton,is_non_production,environment_name)
      VALUES (true,true,'gate02b3-visual') ON CONFLICT (singleton) DO UPDATE SET is_non_production=true`);
    await pool.query(`INSERT INTO resource_scopes (tenant_id,user_id,resource_scope)
      VALUES ('tenant_local','user_local','factory-01/workshop-machining/line-02') ON CONFLICT DO NOTHING`);
    await executeFile(process.execPath, ['--import', 'tsx', 'scripts/seed-gate0.2b-fixtures.ts'], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, GENEWAY_TENANT_ID: 'tenant_local' },
    });
    await page.goto('/exceptions');
    await expect(page.getByTestId('exception-table')).toBeVisible();
    const dimensions = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    const tableScroll = page.locator('.table-scroll');
    await expect(tableScroll).toBeVisible();
    expect(await tableScroll.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(/auto|scroll/u);
    await page.screenshot({ path: testInfo.outputPath(`exceptions-${testInfo.project.name}.png`), fullPage: true });

    const id = await page.getByTestId('exception-table').locator('tbody tr').first().getAttribute('data-exception-id');
    await page.goto(`/exceptions/${encodeURIComponent(id ?? '')}`);
    await expect(page.getByTestId('exception-detail')).toBeVisible();
    const detailDimensions = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(detailDimensions.body).toBeLessThanOrEqual(detailDimensions.viewport);
    await page.screenshot({ path: testInfo.outputPath(`exception-detail-${testInfo.project.name}.png`), fullPage: true });
    await page.goto('/exceptions/exception_missing_visual');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'not-found');
    await page.screenshot({ path: testInfo.outputPath(`not-found-${testInfo.project.name}.png`), fullPage: true });
  } finally {
    await pool.end();
  }
});
