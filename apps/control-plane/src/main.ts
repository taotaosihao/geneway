import { constants } from 'node:fs';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseE2eHookEndpoint, postE2eHook } from './e2e-hook-client.js';
import { createControlPlane } from './index.js';
import { readAllowedWebOrigins } from './server-config.js';
import { createWorkerCommandApp } from './worker-command-server.js';

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
const liveValidationRunId = process.env.GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID;
if (liveValidationRunId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(liveValidationRunId)) {
  throw new Error('GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID is invalid');
}
const modelGatewayValues = [modelGatewayUrl, modelGatewayServiceTokenFile, modelGatewayInvocationSecretFile];
if (modelGatewayValues.some((value) => value === undefined) && modelGatewayValues.some((value) => value !== undefined)) {
  throw new Error('Model Gateway URL and authority files must be configured together');
}
let modelGatewayServiceToken: string | null = null;
let modelGatewayInvocationSecret: string | null = null;
if (modelGatewayUrl !== undefined && modelGatewayServiceTokenFile !== undefined && modelGatewayInvocationSecretFile !== undefined) {
  const parsed = new URL(modelGatewayUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/') {
    throw new Error('Model Gateway URL must be an unauthenticated loopback HTTP origin');
  }
  modelGatewayServiceToken = await readOwnedSecretFile(modelGatewayServiceTokenFile, 'Model Gateway service token file');
  modelGatewayInvocationSecret = await readOwnedSecretFile(modelGatewayInvocationSecretFile, 'Model Gateway invocation secret file');
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

const { app, repository, artifactService, chatRepository } = await createControlPlane({
  databaseUrl,
  logger: true,
  allowedOrigins: readAllowedWebOrigins(process.env, webPort),
  chatRouteAvailable,
  ...(liveValidationRunId === undefined ? {} : { liveValidationRunId }),
  ...(modelGatewayServiceToken === null || modelGatewayInvocationSecret === null ? {} : {
    modelGatewayAuthority: {
      serviceToken: modelGatewayServiceToken,
      invocationTokenSecret: modelGatewayInvocationSecret,
    },
  }),
  ...(e2eHookEndpoint === null ? {} : {
    artifactServiceHooks: {
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
    },
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
