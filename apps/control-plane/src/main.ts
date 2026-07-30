import { constants } from 'node:fs';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { gateAParserStartupApprovalSchema } from '@geneway/contracts';
import { GateADocumentParserSandboxCandidate, type GateAParsedDocumentCandidate } from '@geneway/ingestion';
import { parseE2eHookEndpoint, postE2eHook } from './e2e-hook-client.js';
import { createControlPlane } from './index.js';
import { GATE_A_APPROVED_C1_TEST_MATERIAL_SHA256 } from './artifact-service.js';
import { readAllowedWebOrigins } from './server-config.js';
import { createWorkerCommandApp } from './worker-command-server.js';
import {
  assertGateA3ControlPlaneAuthorityCurrent,
  readGateA3ControlPlaneAuthorityBundle,
} from './gate-a3-prelaunch-authority.js';
import { startGateA3LoopbackProxy, type GateA3LoopbackProxy } from './gate-a3-loopback-proxy.js';
import { createProductionCapabilityHttpClient } from './production-work-order-equipment-brief.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const webPort = Number(process.env.GENEWAY_WEB_PORT ?? 3200);
if (!Number.isInteger(webPort)) throw new Error('GENEWAY_WEB_PORT must be an integer');
const workerSocketPath = process.env.GENEWAY_WORKER_SOCKET_PATH;
const workerTokenFile = process.env.GENEWAY_WORKER_TOKEN_FILE;
if ((workerSocketPath === undefined) !== (workerTokenFile === undefined)) {
  throw new Error('Worker socket path and token file must be configured together');
}

let workerToken: string | null = null;
if (workerSocketPath !== undefined && workerTokenFile !== undefined) {
  if (!isAbsolute(workerSocketPath) || workerSocketPath.includes('\0') || Buffer.byteLength(workerSocketPath) > 100) {
    throw new Error('Worker socket path must be a short absolute Unix-domain socket path');
  }
  if (!isAbsolute(workerTokenFile)) throw new Error('Worker token file path must be absolute');
  const tokenStat = await lstat(workerTokenFile);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.uid !== process.getuid?.()
    || (tokenStat.mode & 0o777) !== 0o600 || tokenStat.size < 32 || tokenStat.size > 4_096) {
    throw new Error('Worker token file must be an owned regular 0600 file with a bounded secret');
  }
  const tokenHandle = await open(workerTokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    workerToken = (await tokenHandle.readFile('utf8')).trim();
  } finally {
    await tokenHandle.close();
  }
  if (workerToken.length < 32 || /\s/u.test(workerToken)) throw new Error('Worker token must be a non-whitespace secret');
}

async function readOwnedSecretFile(filePath: string, label: string): Promise<string> {
  if (!isAbsolute(filePath)) throw new Error(`${label} path must be absolute`);
  const secretStat = await lstat(filePath);
  if (!secretStat.isFile() || secretStat.isSymbolicLink() || secretStat.uid !== process.getuid?.()
    || (secretStat.mode & 0o777) !== 0o600 || secretStat.size < 32 || secretStat.size > 4_096) {
    throw new Error(`${label} must be an owned regular 0600 file with a bounded secret`);
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const secret = (await handle.readFile('utf8')).trim();
    if (secret.length < 32 || /\s/u.test(secret)) throw new Error(`${label} must be a non-whitespace secret`);
    return secret;
  } finally {
    await handle.close();
  }
}

const modelGatewayUrl = process.env.GENEWAY_MODEL_GATEWAY_URL;
const modelGatewayServiceTokenFile = process.env.GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE;
const modelGatewayInvocationSecretFile = process.env.GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE;
const modelGatewayWorkOrderReceiptSecretFile = process.env.GENEWAY_MODEL_GATEWAY_WORK_ORDER_RECEIPT_SECRET_FILE;
const gateA3ControlPlaneBundleFile = process.env.GENEWAY_GATE_A3_CONTROL_PLANE_BUNDLE_FILE;
const gateA3ControlPlaneBundleSha256 = process.env.GENEWAY_GATE_A3_CONTROL_PLANE_BUNDLE_SHA256;
const connectorGatewayServiceTokenFile = process.env.GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE;
const connectorGatewayUrl = process.env.GENEWAY_CONNECTOR_GATEWAY_URL;
const connectorInvocationSecretFile = process.env.GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE;
const connectorGatewayReceiptSecretFile = process.env.GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE;
const liveValidationRunId = process.env.GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID;
const gateALiveValidationRunId = process.env.GENEWAY_GATE_A_LIVE_VALIDATION_RUN_ID;
const syntheticProductionGatewayUrl = process.env.GENEWAY_SYNTHETIC_PRODUCTION_GATEWAY_URL;
const syntheticProductionServiceTokenFile = process.env.GENEWAY_SYNTHETIC_PRODUCTION_SERVICE_TOKEN_FILE;
if ((syntheticProductionGatewayUrl === undefined) !== (syntheticProductionServiceTokenFile === undefined)) {
  throw new Error('Synthetic production gateway URL and service token file must be configured together');
}
const gateAParserImage = process.env.GENEWAY_GATE_A_PARSER_IMAGE;
const gateAParserApprovalJson = process.env.GENEWAY_GATE_A_PARSER_APPROVAL_JSON;
if (liveValidationRunId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(liveValidationRunId)) {
  throw new Error('GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID is invalid');
}
if (gateALiveValidationRunId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(gateALiveValidationRunId)) {
  throw new Error('GENEWAY_GATE_A_LIVE_VALIDATION_RUN_ID is invalid');
}
if ((gateAParserImage === undefined) !== (gateAParserApprovalJson === undefined)) {
  throw new Error('Gate A parser image and approval JSON must be configured together');
}
if (gateAParserImage !== undefined && gateALiveValidationRunId === undefined) {
  throw new Error('Gate A parser authority requires GENEWAY_GATE_A_LIVE_VALIDATION_RUN_ID');
}
let gateAParserSandbox: Readonly<{
  parse(bytes: Uint8Array): Promise<GateAParsedDocumentCandidate>;
  parseDocument(input: Readonly<{ fileName: string; mediaType: string; bytes: Uint8Array }>): Promise<GateAParsedDocumentCandidate>;
}> | undefined;
if (gateAParserImage !== undefined && gateAParserApprovalJson !== undefined && gateALiveValidationRunId !== undefined) {
  if (Buffer.byteLength(gateAParserApprovalJson, 'utf8') > 16_384) throw new Error('Gate A parser approval JSON is too large');
  let rawApproval: unknown;
  try {
    rawApproval = JSON.parse(gateAParserApprovalJson) as unknown;
  } catch {
    throw new Error('GENEWAY_GATE_A_PARSER_APPROVAL_JSON must be valid JSON');
  }
  const approval = gateAParserStartupApprovalSchema.parse(rawApproval);
  if (approval.runId !== gateALiveValidationRunId || approval.image !== gateAParserImage
    || Date.parse(approval.approvedAt) > Date.now()) {
    throw new Error('Gate A parser approval is stale or does not bind the configured run and image');
  }
  const sandbox = new GateADocumentParserSandboxCandidate(gateAParserImage, approval);
  const startupAuthority = await sandbox.resolveAuthority();
  if (startupAuthority.imageId !== approval.imageId
    || startupAuthority.executableDigest !== approval.executableDigest
    || startupAuthority.packageDigest !== approval.packageDigest
    || startupAuthority.runtimeClosureDigest !== approval.runtimeClosureDigest
    || startupAuthority.dependencyInventoryDigest !== approval.dependencyInventoryDigest
    || Object.entries(startupAuthority.manifests).some(([format, manifest]) =>
      manifest.manifestDigest !== approval.formatManifestDigests[format as 'txt' | 'pdf' | 'docx'])
    || Date.parse(approval.expiresAt) <= Date.now()) {
    throw new Error('Gate A parser startup bytes do not match the approved authority');
  }
  gateAParserSandbox = {
    parse: (bytes) => sandbox.parse({ fileName: 'source.txt', mediaType: 'text/plain', bytes }),
    parseDocument: (input) => sandbox.parse(input),
  };
}
const additionalApprovedC1Hashes = process.env.GENEWAY_GATE_A_APPROVED_C1_SHA256;
if (additionalApprovedC1Hashes !== undefined && gateALiveValidationRunId === undefined) {
  throw new Error('Gate A approved C1 hashes require GENEWAY_GATE_A_LIVE_VALIDATION_RUN_ID');
}
if (additionalApprovedC1Hashes !== undefined && Buffer.byteLength(additionalApprovedC1Hashes, 'utf8') > 4_096) {
  throw new Error('GENEWAY_GATE_A_APPROVED_C1_SHA256 is too large');
}
const approvedGateAC1Hashes = new Set([GATE_A_APPROVED_C1_TEST_MATERIAL_SHA256]);
if (additionalApprovedC1Hashes !== undefined) {
  for (const approvedHash of additionalApprovedC1Hashes.split(',')) {
    if (!/^[a-f0-9]{64}$/u.test(approvedHash)) {
      throw new Error('GENEWAY_GATE_A_APPROVED_C1_SHA256 must contain comma-separated lowercase SHA-256 values');
    }
    approvedGateAC1Hashes.add(approvedHash);
  }
}
const modelGatewayValues = [modelGatewayUrl, modelGatewayServiceTokenFile, modelGatewayInvocationSecretFile];
if (modelGatewayValues.some((value) => value === undefined) && modelGatewayValues.some((value) => value !== undefined)) {
  throw new Error('Model Gateway URL and authority files must be configured together');
}
let modelGatewayServiceToken: string | null = null;
let modelGatewayInvocationSecret: string | null = null;
let modelGatewayWorkOrderReceiptSecret: string | null = null;
if (modelGatewayUrl !== undefined && modelGatewayServiceTokenFile !== undefined && modelGatewayInvocationSecretFile !== undefined) {
  const parsed = new URL(modelGatewayUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/') {
    throw new Error('Model Gateway URL must be an unauthenticated loopback HTTP origin');
  }
  modelGatewayServiceToken = await readOwnedSecretFile(modelGatewayServiceTokenFile, 'Model Gateway service token file');
  modelGatewayInvocationSecret = await readOwnedSecretFile(modelGatewayInvocationSecretFile, 'Model Gateway invocation secret file');
}
const gateA3Values = [gateA3ControlPlaneBundleFile, gateA3ControlPlaneBundleSha256,
  connectorGatewayUrl, connectorGatewayServiceTokenFile, connectorInvocationSecretFile, connectorGatewayReceiptSecretFile,
  modelGatewayWorkOrderReceiptSecretFile];
if (gateA3Values.some((value) => value === undefined) && gateA3Values.some((value) => value !== undefined)) {
  throw new Error('Gate A.3 authority, Connector Gateway files, and Model receipt file must be configured together');
}
let gateA3Authority: Parameters<typeof createControlPlane>[0]['gateA3Authority'];
let gateA3LoopbackProxy: GateA3LoopbackProxy | null = null;
if (gateA3ControlPlaneBundleFile !== undefined && gateA3ControlPlaneBundleSha256 !== undefined
  && connectorGatewayUrl !== undefined && connectorGatewayServiceTokenFile !== undefined && connectorInvocationSecretFile !== undefined
  && connectorGatewayReceiptSecretFile !== undefined && modelGatewayWorkOrderReceiptSecretFile !== undefined) {
  const connectorOrigin = new URL(connectorGatewayUrl);
  if (connectorOrigin.protocol !== 'http:' || connectorOrigin.hostname !== '127.0.0.1'
    || connectorOrigin.username !== '' || connectorOrigin.password !== '' || connectorOrigin.pathname !== '/'
    || connectorOrigin.search !== '' || connectorOrigin.hash !== '') {
    throw new Error('Connector Gateway URL must be an exact credential-free IPv4 loopback origin');
  }
  if (modelGatewayInvocationSecret === null || modelGatewayServiceToken === null || workerToken === null) {
    throw new Error('Gate A.3 requires configured Model Gateway and Worker authority');
  }
  modelGatewayWorkOrderReceiptSecret = await readOwnedSecretFile(
    modelGatewayWorkOrderReceiptSecretFile, 'Model Gateway Work Order receipt secret file',
  );
  const gateA3Bundle = await readGateA3ControlPlaneAuthorityBundle({
    bundleFile: gateA3ControlPlaneBundleFile,
    expectedRawSha256: gateA3ControlPlaneBundleSha256,
  });
  gateA3LoopbackProxy = await startGateA3LoopbackProxy(gateA3Bundle.prelaunchReceipt.runtimeIpv4);
  gateA3Authority = {
    envelope: gateA3Bundle.envelope,
    validationRunId: gateA3Bundle.acceptanceAdmission.runId,
    connectorGatewayServiceToken: await readOwnedSecretFile(
      connectorGatewayServiceTokenFile, 'Connector Gateway service token file',
    ),
    connectorInvocationTokenSecret: await readOwnedSecretFile(
      connectorInvocationSecretFile, 'Connector invocation secret file',
    ),
    connectorGatewayReceiptSecret: await readOwnedSecretFile(
      connectorGatewayReceiptSecretFile, 'Connector Gateway receipt secret file',
    ),
    modelInvocationTokenSecret: modelGatewayInvocationSecret,
    modelGatewayReceiptSecret: modelGatewayWorkOrderReceiptSecret,
    controlPlaneAuthorityBundle: gateA3Bundle,
    assertRuntimeAuthority: () => {
      try {
        assertGateA3ControlPlaneAuthorityCurrent(gateA3Bundle);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  const distinctSecrets = new Set([gateA3Authority.connectorGatewayServiceToken,
    gateA3Authority.connectorInvocationTokenSecret, gateA3Authority.connectorGatewayReceiptSecret,
    gateA3Authority.modelInvocationTokenSecret, gateA3Authority.modelGatewayReceiptSecret]);
  if (distinctSecrets.size !== 5) throw new Error('Gate A.3 authority secrets must be pairwise distinct');
}

async function gateA3RouteAvailable(): Promise<boolean> {
  if (gateA3Authority === undefined || connectorGatewayUrl === undefined
    || modelGatewayUrl === undefined || modelGatewayServiceToken === null) return false;
  try {
    await gateA3Authority.assertRuntimeAuthority();
    const [connectorReady, modelReady] = await Promise.all([
      fetch(new URL('/internal/connector-gateway/v1/readiness', connectorGatewayUrl), {
        headers: { authorization: `Bearer ${gateA3Authority.connectorGatewayServiceToken}` },
        signal: AbortSignal.timeout(1_500),
      }),
      fetch(new URL('/internal/model-gateway/v1/work-order-readiness', modelGatewayUrl), {
        headers: { authorization: `Bearer ${modelGatewayServiceToken}` },
        signal: AbortSignal.timeout(1_500),
      }),
    ]);
    if (!connectorReady.ok || !modelReady.ok) return false;
    const [connectorBody, modelBody] = await Promise.all([
      connectorReady.json() as Promise<{ ready?: unknown; profile?: unknown; receiver?: unknown }>,
      modelReady.json() as Promise<{ ready?: unknown; profile?: unknown; route?: unknown }>,
    ]);
    return connectorBody.ready === true
      && connectorBody.profile === 'gearjob-work-order-status-dev/1'
      && connectorBody.receiver === 'invocation-authority-required'
      && modelBody.ready === true
      && modelBody.profile === 'codex_subscription_dev'
      && modelBody.route === 'work-order-explanation/1';
  } catch {
    return false;
  }
}

async function chatRouteAvailable(): Promise<boolean> {
  if (modelGatewayUrl === undefined || modelGatewayServiceToken === null) return false;
  try {
    const response = await fetch(new URL('/internal/model-gateway/v1/readiness', modelGatewayUrl), {
      headers: { authorization: `Bearer ${modelGatewayServiceToken}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ready?: unknown; profile?: unknown };
    return body.ready === true && body.profile === 'codex_subscription_dev';
  } catch {
    return false;
  }
}

const e2eHookUrl = process.env.GENEWAY_E2E_HOOK_URL;
const e2eHookTokenFile = process.env.GENEWAY_E2E_HOOK_TOKEN_FILE;
if ((e2eHookUrl === undefined) !== (e2eHookTokenFile === undefined)) throw new Error('E2E hook URL and token file must be configured together');
let e2eHookEndpoint: URL | null = null;
if (e2eHookUrl !== undefined && e2eHookTokenFile !== undefined) {
  if (workerToken === null || workerTokenFile === undefined) throw new Error('E2E hook requires Worker authority');
  e2eHookEndpoint = parseE2eHookEndpoint({
    url: e2eHookUrl,
    nodeEnvironment: process.env.NODE_ENV,
    tokenFile: e2eHookTokenFile,
    expectedTokenFile: workerTokenFile,
  });
}

async function reachE2eHook(payload: Readonly<Record<string, unknown>>): Promise<'continue' | 'inject_error'> {
  if (e2eHookEndpoint === null || workerToken === null) return 'continue';
  return postE2eHook(e2eHookEndpoint, workerToken, payload);
}

const artifactServiceHooks = gateAParserSandbox === undefined && e2eHookEndpoint === null
  ? undefined
  : {
      ...(gateAParserSandbox === undefined ? {} : {
        parserSandbox: gateAParserSandbox,
        authorizeLiveC1Upload: (input: Readonly<{ contentSha256: string }>) =>
          approvedGateAC1Hashes.has(input.contentSha256),
      }),
      ...(e2eHookEndpoint === null ? {} : {
        afterIngestIntentPutAuthorityCommitted: (hook: Readonly<Record<string, unknown>>) => reachE2eHook({
          protocolVersion: 'geneway-e2e-hook/1',
          hook: 'control-plane.after_ingest_intent_put_authority_committed',
          ...hook,
        }).then(() => undefined),
        afterSourceObjectPut: (hook: Readonly<Record<string, unknown>>) => reachE2eHook({
          protocolVersion: 'geneway-e2e-hook/1',
          hook: 'control-plane.after_source_object_put',
          ...hook,
        }),
      }),
    };

const { app, repository, artifactService, chatRepository, gateALiveRepository,
  gateA3WorkOrderRepository } = await createControlPlane({
  databaseUrl,
  logger: true,
  allowedOrigins: readAllowedWebOrigins(process.env, webPort),
  chatRouteAvailable,
  ...(liveValidationRunId === undefined ? {} : { liveValidationRunId }),
  ...(gateALiveValidationRunId === undefined ? {} : { gateALiveValidationRunId }),
  ...(modelGatewayServiceToken === null || modelGatewayInvocationSecret === null ? {} : {
    modelGatewayAuthority: {
      serviceToken: modelGatewayServiceToken,
      invocationTokenSecret: modelGatewayInvocationSecret,
    },
  }),
  ...(artifactServiceHooks === undefined ? {} : { artifactServiceHooks }),
  ...(gateA3Authority === undefined ? {} : { gateA3Authority }),
  ...(gateA3Authority === undefined ? {} : { gateA3RouteAvailable }),
  ...(syntheticProductionGatewayUrl === undefined || syntheticProductionServiceTokenFile === undefined ? {} : {
    productionCapabilityPort: createProductionCapabilityHttpClient({
      gatewayUrl: syntheticProductionGatewayUrl,
      serviceToken: await readOwnedSecretFile(
        syntheticProductionServiceTokenFile, 'Synthetic production service token file',
      ),
    }),
  }),
});

let workerApp: ReturnType<typeof createWorkerCommandApp> | null = null;
if (workerSocketPath !== undefined && workerTokenFile !== undefined && workerToken !== null) {
  if (artifactService === null) throw new Error('Worker command service requires configured artifact storage');
  const workerCommandHooks: Parameters<typeof createWorkerCommandApp>[0]['hooks'] = e2eHookEndpoint === null
    ? undefined
    : {
        afterCompleteStepCommitted: async (hook) => {
          const action = await reachE2eHook({
            protocolVersion: 'geneway-e2e-hook/1',
            hook: 'control-plane.after_complete_step_committed_before_response',
            ...hook,
          });
          return action === 'inject_error' ? 'drop_response' : 'continue';
        },
        afterReportObjectVerified: async (hook) => {
          await reachE2eHook({
            protocolVersion: 'geneway-e2e-hook/1',
            hook: 'control-plane.after_report_object_verified',
            ...hook,
          });
        },
      };
  const leaseDurationMs = Number(process.env.GENEWAY_WORKER_LEASE_MS ?? 300_000);
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 250 || leaseDurationMs > 900_000) {
    throw new Error('GENEWAY_WORKER_LEASE_MS must be an integer between 250 and 900000');
  }
  workerApp = createWorkerCommandApp({
    repository,
    storage: artifactService.storage,
    token: workerToken,
    logger: true,
    leaseDurationMs,
    ...(modelGatewayInvocationSecret === null ? {} : { chatRepository, invocationTokenSecret: modelGatewayInvocationSecret }),
    ...(gateALiveRepository === null ? {} : { gateALiveRepository }),
    ...(gateA3WorkOrderRepository === null ? {} : { gateA3WorkOrderRepository }),
    ...(workerCommandHooks === undefined ? {} : { hooks: workerCommandHooks }),
  });
  try {
    await unlink(workerSocketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await workerApp.listen({ path: workerSocketPath });
  await chmod(workerSocketPath, 0o600);
}
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3100) });

const shutdown = async (): Promise<void> => {
  if (workerApp !== null) await workerApp.close();
  await app.close();
  if (gateA3LoopbackProxy !== null) await gateA3LoopbackProxy.close();
  if (workerSocketPath !== undefined) {
    try {
      await unlink(workerSocketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
};

process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
