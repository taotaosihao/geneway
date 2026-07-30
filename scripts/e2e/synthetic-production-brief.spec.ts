import { expect, test } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';

test('serves SCN-NORMAL through Vite /api and shows the server decision trace', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { requests.push(request.url()); });
  await page.goto('http://127.0.0.1:3200/work-orders/mock');
  await expect(page.getByTestId('production-synthetic-boundary')).toContainText('全合成业务演示');
  const responsePromise = page.waitForResponse((response) => response.url() === 'http://127.0.0.1:3200/api/production/work-order-equipment-brief');
  await page.getByTestId('run-production-brief').click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.getByTestId('production-brief-result')).toContainText('NO_ACTION');
  await expect(page.getByTestId('production-server-trace').locator('li')).toHaveCount(5);
  await expect(page.getByTestId('production-brief-result')).toContainText('CURRENT');
  await expect(page.getByTestId('production-brief-result')).toContainText('COMPLETE');
  expect(requests.length).toBeGreaterThan(2);
  expect(requests.every((url) => new URL(url).origin === 'http://127.0.0.1:3200')).toBe(true);
  expect(requests.some((url) => url.includes(':3100') || url.includes(':3165'))).toBe(false);
  const runId = process.env.GENEWAY_RUN_ID;
  expect(runId).toMatch(/^synthetic-production-brief-/u);
  const outputRoot = `/tmp/geneway-runs/${runId ?? ''}`;
  const boundary = JSON.parse(readFileSync(`${outputRoot}/process-boundaries/browser.json`, 'utf8')) as {
    home: string; egressGuard: { required: boolean; allowedPorts: number[]; receipt: string };
  };
  expect(boundary.egressGuard).toMatchObject({ required: true, allowedPorts: [3200] });
  expect(boundary.home).toBe(`${outputRoot}/home/browser`);
  expect(boundary.home).not.toBe(process.env.HOME);
  expect(statSync(boundary.home).mode & 0o777).toBe(0o700);
  const kernelReceipt = readFileSync(boundary.egressGuard.receipt, 'utf8');
  expect(kernelReceipt).toContain('BROWSER_KERNEL ');
  expect(kernelReceipt).toContain('status=ENFORCED');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
