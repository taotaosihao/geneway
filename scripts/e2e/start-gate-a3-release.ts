import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { GateA3WorkOrderRepository } from '../../apps/control-plane/src/gate-a3-work-order-repository.js';
import {
  assertGateA3ControlPlaneAuthorityCurrent,
  readGateA3ControlPlaneAuthorityBundle,
} from '../../apps/control-plane/src/gate-a3-prelaunch-authority.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

async function readSecret(name: string): Promise<string> {
  const filePath = required(name);
  if (!isAbsolute(filePath)) throw new Error(`${name} must be an absolute path`);
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.()
    || (before.mode & 0o777) !== 0o600 || before.size < 32 || before.size > 4_096) {
    throw new Error(`${name} must refer to an owned regular 0600 secret file`);
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${name} changed while opening`);
    const secret = (await handle.readFile('utf8')).trim();
    if (secret.length < 32 || /\s/u.test(secret)) throw new Error(`${name} contains an invalid secret`);
    return secret;
  } finally {
    await handle.close();
  }
}

const bundle = await readGateA3ControlPlaneAuthorityBundle({
  bundleFile: required('GENEWAY_GATE_A3_CONTROL_PLANE_BUNDLE_FILE'),
  expectedRawSha256: required('GENEWAY_GATE_A3_CONTROL_PLANE_BUNDLE_SHA256'),
});
const envelope = bundle.envelope;
const databaseUrl = required('DATABASE_URL');
const runId = bundle.acceptanceAdmission.runId;
const controlPlaneUrl = new URL(required('GENEWAY_CONTROL_PLANE_URL'));
const releasePort = Number(required('GENEWAY_GATE_A3_RELEASE_PORT'));
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
  throw new Error('GENEWAY_GATE_A3_VALIDATION_RUN_ID is invalid');
}
if (controlPlaneUrl.protocol !== 'http:' || controlPlaneUrl.hostname !== '127.0.0.1'
  || controlPlaneUrl.username !== '' || controlPlaneUrl.password !== '' || controlPlaneUrl.pathname !== '/'
  || controlPlaneUrl.search !== '' || controlPlaneUrl.hash !== '') {
  throw new Error('GENEWAY_CONTROL_PLANE_URL must be an exact credential-free IPv4 loopback origin');
}
if (!Number.isInteger(releasePort) || releasePort < 1 || releasePort > 65_535) {
  throw new Error('GENEWAY_GATE_A3_RELEASE_PORT is invalid');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const repository = new GateA3WorkOrderRepository(pool, {
  envelope,
  validationRunId: runId,
  connectorGatewayServiceToken: await readSecret('GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE'),
  connectorInvocationTokenSecret: await readSecret('GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE'),
  connectorGatewayReceiptSecret: await readSecret('GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE'),
  modelInvocationTokenSecret: await readSecret('GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE'),
  modelGatewayReceiptSecret: await readSecret('GENEWAY_MODEL_GATEWAY_WORK_ORDER_RECEIPT_SECRET_FILE'),
  controlPlaneAuthorityBundle: bundle,
  assertRuntimeAuthority: async () => {
    assertGateA3ControlPlaneAuthorityCurrent(bundle);
  },
});

async function waitForControlPlane(): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const response = await fetch(new URL('/health', controlPlaneUrl), {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The disposable stack starts all services concurrently.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Control Plane did not become ready for Gate A.3 release');
}

async function waitForPublicInternalRoute(): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const response = await fetch(new URL('/api/capabilities/production.work-order-status.v1', controlPlaneUrl), {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) {
        const body = await response.json() as Readonly<Record<string, unknown>>;
        if (body.status === 'internal' && body.executionRoute === 'live'
          && body.internalAcceptance === true && body.businessDecisionAllowed === false) return;
      }
    } catch {
      // Both Gateways may still be proving their run-bound readiness.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Gate A.3 validation-only route did not become ready on the immutable shadow overlay');
}

try {
  await waitForControlPlane();
  assertGateA3ControlPlaneAuthorityCurrent(bundle);
  await repository.activateAuthorityEnvelope();
  assertGateA3ControlPlaneAuthorityCurrent(bundle);
  await repository.promoteAuthority('shadow');
  await waitForPublicInternalRoute();
} finally {
  await pool.end();
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      ready: true,
      state: 'shadow-acceptance-overlay',
      capabilityId: 'production.work-order-status.v1',
      authorityDigest: envelope.authorityDigest,
    }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(releasePort, '127.0.0.1', resolve);
});
const stop = (): void => { void new Promise<void>((resolve) => server.close(() => resolve())); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
