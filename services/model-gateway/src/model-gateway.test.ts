import { createHmac, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelGatewayReceiptSchema } from '@geneway/contracts';
import { createModelGateway, mapProviderError, redactedProviderFailure } from './index.js';
import {
  assertLockfilePackageIntegrity, verifyOwnedPrivateFile, verifyProviderAuthFile, verifyProviderManifest,
} from './provider-manifest.js';

const serviceToken = 'model-gateway-service-token-00000000000000000001';
const invocationSecret = 'model-gateway-invocation-token-000000000000000001';
const invocationToken = (overrides: Readonly<Record<string, unknown>> = {}) => {
  const now = Math.floor(Date.now() / 1_000);
  const claims = {
    iss: 'geneway-control-plane',
    aud: 'local-model-gateway',
    tenantId: 'tenant_local',
    principalId: 'user_local',
    conversationId: 'conversation-receipt-test',
    modelInvocationId: 'model-invocation-receipt-test',
    logicalModelPolicy: 'general.chat.standard',
    dataClass: 'C0',
    maxOutputTokens: 128,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    fence: 1,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${encoded}.${createHmac('sha256', invocationSecret).update(encoded, 'utf8').digest('base64url')}`;
};
const streamBody = (token: string, overrides: Readonly<Record<string, unknown>> = {}) => ({
  invocationToken: token,
  conversationId: 'conversation-receipt-test',
  modelInvocationId: 'model-invocation-receipt-test',
  fence: 1,
  logicalModelPolicy: 'general.chat.standard',
  promptPolicyVersion: 'xiaowei.chat.system/1',
  systemPrompt: 'test',
  messages: [{ messageId: 'message-test', author: 'user', content: 'hello' }],
  toolChoice: 'none',
  ...overrides,
});
const conformance = (manifestDigest: string, expired = false) => {
  const now = Date.now();
  const passedAt = new Date(now - (expired ? 3 * 60_000 : 1_000));
  const deadline = new Date(now + (expired ? -2 * 60_000 : 30 * 60_000));
  const expiresAt = new Date(now + (expired ? -60_000 : 60 * 60_000));
  return {
    schemaVersion: 'geneway-live-conformance/1',
    profile: 'codex_subscription_dev',
    manifestDigest,
    providerModel: 'gpt-5.4-mini',
    passedAt: passedAt.toISOString(),
    deadline: deadline.toISOString(),
    expiresAt: expiresAt.toISOString(),
    checks: {
      stream: true,
      cancel: true,
      usage: true,
      toolChoiceNone: true,
      localFaultMapping: {
        mode: 'synthetic-local-faults', quota: 'MODEL_QUOTA', authentication: 'MODEL_AUTH_FAILED',
        timeout: 'MODEL_TIMEOUT', protocol: 'MODEL_PROTOCOL_VIOLATION', unknown: 'MODEL_STREAM_INTERRUPTED',
      },
      secretRedaction: {
        mode: 'synthetic-canary', canarySha256: 'a'.repeat(64),
        publicErrorSerialization: true, auditSerialization: true,
      },
    },
  };
};

describe('codex_subscription_dev provider boundary', () => {
  it('matches immutable package bytes and lockfile integrity', async () => {
    const verified = await verifyProviderManifest();
    expect(verified.manifest.packages).toHaveLength(7);
    expect(verified.manifest.approval.authorizationRef).toBe('source-thread:019f880e-bac8-7412-a129-68db9bf6506a');
    expect(verified.manifest.credentialBoundary.authorizedOverride).toMatchObject({
      authFilePath: '/home/gewu/.codex/auth.json',
      parentDirectory: '/home/gewu/.codex',
      parentMode: '0775',
      owner: 'current-process-uid',
      symlinksAllowed: false,
      scope: 'trusted-local development only',
    });
    expect(verified.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(verified.manifest.packages.every((entry) =>
      entry.reviewedProvenance.assurance === 'reviewed-not-machine-attested-from-package-bytes')).toBe(true);
    const lockfile = await readFile(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8');
    const first = verified.manifest.packages[0];
    if (first === undefined) throw new Error('Provider manifest unexpectedly has no packages');
    expect(() => assertLockfilePackageIntegrity(lockfile, { ...first, integrity: 'sha512-deliberate-mismatch' }))
      .toThrow(`Provider package lockfile integrity mismatch: ${first.name}`);
  });

  it('keeps the default credential boundary at owned non-symlink 0700/0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-auth-boundary-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    await writeFile(authFile, '{}', { mode: 0o600 });
    await expect(verifyOwnedPrivateFile(authFile, 'test auth')).resolves.toBeUndefined();
    await chmod(directory, 0o775);
    await expect(verifyOwnedPrivateFile(authFile, 'test auth')).rejects.toThrow('0700');
  });

  it('accepts 0775 only for the manifest-bound trusted-local auth path and still rejects unsafe files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-authorized-auth-boundary-'));
    await chmod(directory, 0o775);
    const authFile = join(directory, 'auth.json');
    await writeFile(authFile, '{}', { mode: 0o600 });
    const verified = await verifyProviderManifest();
    const manifest = {
      ...verified.manifest,
      credentialBoundary: {
        ...verified.manifest.credentialBoundary,
        authorizedOverride: {
          ...verified.manifest.credentialBoundary.authorizedOverride,
          authFilePath: authFile,
          parentDirectory: directory,
        },
      },
    } as unknown as Parameters<typeof verifyProviderAuthFile>[1];

    await expect(verifyProviderAuthFile(authFile, manifest, 'test auth')).resolves.toBeUndefined();
    await expect(verifyProviderAuthFile(authFile, verified.manifest, 'test auth')).rejects.toThrow('0700');

    await chmod(authFile, 0o644);
    await expect(verifyProviderAuthFile(authFile, manifest, 'test auth')).rejects.toThrow('0600');
    await chmod(authFile, 0o600);
    const authLink = join(directory, 'auth-link.json');
    await symlink(authFile, authLink);
    const symlinkManifest = {
      ...manifest,
      credentialBoundary: {
        ...manifest.credentialBoundary,
        authorizedOverride: { ...manifest.credentialBoundary.authorizedOverride, authFilePath: authLink },
      },
    } as unknown as Parameters<typeof verifyProviderAuthFile>[1];
    await expect(verifyProviderAuthFile(authLink, symlinkManifest, 'test auth')).rejects.toThrow('non-symlink');
  });

  it('stays NOT_OPEN without conformance and credential gates and maps errors stably', async () => {
    const app = await createModelGateway({
      serviceToken, invocationSecret, controlPlaneUrl: 'http://127.0.0.1:3100',
    });
    try {
      const readiness = await app.inject({
        method: 'GET', url: '/internal/model-gateway/v1/readiness', headers: { authorization: `Bearer ${serviceToken}` },
      });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toEqual({ ready: false, profile: 'codex_subscription_dev', reason: 'provider gates not satisfied' });
      expect(mapProviderError(new Error('quota 429'))).toEqual({ errorClass: 'MODEL_QUOTA' });
      expect(mapProviderError(new Error('auth 401'))).toEqual({ errorClass: 'MODEL_AUTH_FAILED' });
      expect(mapProviderError(new Error('tool call'))).toEqual({ errorClass: 'MODEL_PROTOCOL_VIOLATION' });
      const canary = 'synthetic-secret-canary-do-not-leak';
      expect(JSON.stringify(redactedProviderFailure(new Error(`auth 401 ${canary}`)))).not.toContain(canary);
    } finally {
      await app.close();
    }
  });

  it('revalidates conformance expiry and credential metadata before readiness and stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-dynamic-readiness-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    const conformanceFile = join(directory, 'conformance.json');
    const verified = await verifyProviderManifest();
    await writeFile(authFile, '{}', { mode: 0o600 });
    await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
    const app = await createModelGateway({
      serviceToken, invocationSecret, controlPlaneUrl: 'http://127.0.0.1:3100',
      authFilePath: authFile, conformanceFilePath: conformanceFile,
    });
    const readiness = () => app.inject({
      method: 'GET', url: '/internal/model-gateway/v1/readiness', headers: { authorization: `Bearer ${serviceToken}` },
    });
    const stream = () => app.inject({
      method: 'POST', url: '/internal/model-gateway/v1/stream', headers: { authorization: `Bearer ${serviceToken}` }, payload: {},
    });
    try {
      expect((await readiness()).statusCode).toBe(200);
      await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest, true)), { mode: 0o600 });
      expect((await readiness()).statusCode).toBe(503);
      expect((await stream()).json()).toEqual({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
      await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
      expect((await readiness()).statusCode).toBe(200);
      await chmod(authFile, 0o644);
      expect((await readiness()).statusCode).toBe(503);
      expect((await stream()).json()).toEqual({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
    } finally {
      await app.close();
    }
  });

  it('rejects invalid or consumed invocation authority before the provider callback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-provider-counter-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    const conformanceFile = join(directory, 'conformance.json');
    const verified = await verifyProviderManifest();
    await writeFile(authFile, '{}', { mode: 0o600 });
    await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
    let providerCalls = 0;
    const consumed = new Set<string>();
    const app = await createModelGateway({
      serviceToken, invocationSecret, controlPlaneUrl: 'http://127.0.0.1:3100', authFilePath: authFile,
      conformanceFilePath: conformanceFile,
      authorizeInvocationForTest: (claims) => {
        if (consumed.has(claims.jti)) return Promise.resolve(false);
        consumed.add(claims.jti);
        return Promise.resolve(true);
      },
      providerCallForTest: () => {
        providerCalls += 1;
        return Promise.resolve({
          deltas: ['真实回调'], providerRevision: 'test-provider/1', modelRevision: 'test-model/1',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, pricing: 'unpriced' },
        });
      },
    });
    const invokeStream = (payload: Readonly<Record<string, unknown>>) => app.inject({
      method: 'POST', url: '/internal/model-gateway/v1/stream',
      headers: { authorization: `Bearer ${serviceToken}` }, payload,
    });
    try {
      const validToken = invocationToken();
      const success = await invokeStream(streamBody(validToken));
      expect(success.statusCode, success.body).toBe(200);
      expect(success.body).toContain('"type":"completed"');
      expect(success.body).toContain('"issuer":"geneway-model-gateway"');
      expect(providerCalls).toBe(1);

      expect((await invokeStream(streamBody(validToken))).statusCode).toBe(401);
      const now = Math.floor(Date.now() / 1_000);
      const invalidRequests = [
        streamBody(invocationToken({ iat: now - 60, exp: now - 10 })),
        streamBody(invocationToken(), { modelInvocationId: 'cross-invocation' }),
        streamBody(invocationToken({ iss: 'wrong-issuer' })),
        streamBody(invocationToken({ aud: 'wrong-audience' })),
        streamBody(invocationToken(), { fence: 2 }),
      ];
      for (const requestBody of invalidRequests) expect((await invokeStream(requestBody)).statusCode).toBe(401);
      expect(providerCalls).toBe(1);
      expect((await invokeStream(streamBody(invocationToken()))).statusCode).toBe(200);
      expect(providerCalls).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('atomically reserves the single active slot before asynchronous authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-single-active-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    const conformanceFile = join(directory, 'conformance.json');
    const verified = await verifyProviderManifest();
    await writeFile(authFile, '{}', { mode: 0o600 });
    await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
    let releaseAuthorization = (): void => { throw new Error('Authorization gate was not initialized'); };
    const authorizationGate = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    let markAuthorizationEntered = (): void => { throw new Error('Authorization entry gate was not initialized'); };
    const authorizationEntered = new Promise<void>((resolve) => { markAuthorizationEntered = resolve; });
    let authorizationCalls = 0;
    let providerCalls = 0;
    const app = await createModelGateway({
      serviceToken, invocationSecret, controlPlaneUrl: 'http://127.0.0.1:3100', authFilePath: authFile,
      conformanceFilePath: conformanceFile,
      authorizeInvocationForTest: async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 1) {
          markAuthorizationEntered();
          await authorizationGate;
        }
        return true;
      },
      providerCallForTest: () => {
        providerCalls += 1;
        return Promise.resolve({
          deltas: ['真实回调'], providerRevision: 'test-provider/1', modelRevision: 'test-model/1',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, pricing: 'unpriced' },
        });
      },
    });
    const invoke = (modelInvocationId: string) => app.inject({
      method: 'POST', url: '/internal/model-gateway/v1/stream',
      headers: { authorization: `Bearer ${serviceToken}` },
      payload: streamBody(invocationToken({ modelInvocationId }), { modelInvocationId }),
    });
    try {
      const first = invoke('model-invocation-concurrent-1');
      await authorizationEntered;
      const competing = await invoke('model-invocation-concurrent-2');
      expect(competing.statusCode).toBe(409);
      const busyReceipt = modelGatewayReceiptSchema.parse(competing.json<{ receipt: unknown }>().receipt);
      expect(busyReceipt.payload).toMatchObject({
        conversationId: 'conversation-receipt-test',
        modelInvocationId: 'model-invocation-concurrent-2',
        fence: 1,
        outcome: 'CHAT_BUSY',
        providerRevision: null,
        modelRevision: null,
        usage: null,
      });
      expect(busyReceipt.signature).toBe(createHmac('sha256', invocationSecret)
        .update(JSON.stringify(busyReceipt.payload), 'utf8').digest('base64url'));
      expect(authorizationCalls).toBe(1);
      expect(providerCalls).toBe(0);

      releaseAuthorization();
      expect((await first).statusCode).toBe(200);
      expect(authorizationCalls).toBe(1);
      expect(providerCalls).toBe(1);

      expect((await invoke('model-invocation-after-release')).statusCode).toBe(200);
      expect(authorizationCalls).toBe(2);
      expect(providerCalls).toBe(2);
    } finally {
      releaseAuthorization();
      await app.close();
    }
  });
});
