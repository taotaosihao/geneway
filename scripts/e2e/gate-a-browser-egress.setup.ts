import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const runId = process.env.GENEWAY_RUN_ID;
if (runId === undefined || process.env.GENEWAY_GATE_A_LIVE !== '1'
  || process.env.GENEWAY_GATE02B_EGRESS_GUARD !== 'required'
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
  throw new Error('gate-a-browser-egress requires the guarded disposable Gate A live harness');
}

function forbiddenPorts(): number[] {
  const names = [
    'GENEWAY_CONTROL_PLANE_PORT', 'GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT', 'GENEWAY_POSTGRES_PORT',
    'GENEWAY_S3_PORT', 'GENEWAY_STORAGE_ADAPTER_PORT', 'GENEWAY_RECONCILIATION_ADAPTER_PORT',
    'GENEWAY_WORKER_HEALTH_PORT', 'GENEWAY_MODEL_GATEWAY_PORT', 'GENEWAY_MODEL_GATEWAY_SUPERVISOR_PORT',
    'GENEWAY_CONNECTOR_GATEWAY_PORT', 'GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_PORT',
    'GENEWAY_GATE_A0_RELEASE_PORT', 'GENEWAY_GATE_A_RELEASE_PORT', 'GENEWAY_GATE_A3_RELEASE_PORT',
  ] as const;
  const ports = [...names.map((name) => Number(process.env[name])), 8_100];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('Gate A browser forbidden-port matrix is incomplete');
  }
  return [...new Set(ports)];
}

test('kernel boundary 仅允许浏览器连接 Web port，并拒绝全部内部服务端口', async ({ page }) => {
  const response = await page.goto('/health', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  const ports = forbiddenPorts();
  const results = await page.evaluate(async (targets) => Promise.all(targets.map(async (port) => {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/__geneway_browser_egress_probe__`, {
        cache: 'no-store', mode: 'no-cors', redirect: 'manual',
      });
      return { port, denied: false };
    } catch {
      return { port, denied: true };
    }
  })), ports);
  expect(results).toEqual(ports.map((port) => ({ port, denied: true })));

  const evidenceDirectory = `/tmp/geneway-runs/${runId}/process-boundaries`;
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await chmod(evidenceDirectory, 0o700);
  await writeFile(`${evidenceDirectory}/browser-egress-conformance.json`, `${JSON.stringify({
    schemaVersion: 'geneway-gate-a-browser-egress-conformance/1',
    runId,
    passed: true,
    allowedWebPort: Number(process.env.GENEWAY_WEB_PORT),
    deniedPorts: ports,
    deniedPortCount: ports.length,
    businessTaskCreated: false,
    syntheticResponseUsed: false,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
});
