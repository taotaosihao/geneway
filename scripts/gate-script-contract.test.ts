import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isVisiblePersistedStreamingCheckpoint } from './e2e/gate-a0-chat-observability.js';
import { modelGatewayWorkerEnvironment } from './e2e/model-gateway-worker-environment.js';

describe('Gate 0.2A executable script contract', () => {
  it('accepts a browser projection ahead of a persisted streaming checkpoint', () => {
    expect(isVisiblePersistedStreamingCheckpoint({
      invocationStatus: 'running', persistedStatus: 'streaming', persistedBody: '你好，我', browserText: '你好，我是小纬',
    })).toBe(true);
    expect(isVisiblePersistedStreamingCheckpoint({
      invocationStatus: 'running', persistedStatus: 'streaming', persistedBody: '你好，我是小纬', browserText: '你好，我',
    })).toBe(false);
    expect(isVisiblePersistedStreamingCheckpoint({
      invocationStatus: 'completed', persistedStatus: 'completed', persistedBody: '你好', browserText: '你好',
    })).toBe(false);
  });

  it('keeps V2 through V8 and Gate 0.1 regression in the sole aggregate command', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
    }>;
    expect(manifest.scripts?.['verify:gate0.2a']?.split(' && ')).toEqual([
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm test:contracts',
      'pnpm test:integration',
      'pnpm test:storage',
      'pnpm test:security',
      'pnpm test:recovery',
      'pnpm test:backup-restore',
      'pnpm test:e2e -- --project=gate0.2a-success',
      'pnpm test:e2e -- --project=gate0.2a-negative',
      'pnpm test:e2e -- --project=gate0.1',
    ]);
    expect(manifest.scripts?.['test:recovery']).toBe('node scripts/test-recovery.mjs');
    expect(manifest.scripts?.['test:backup-restore']).toBe('node scripts/test-backup-restore.mjs');
    expect(manifest.scripts?.['test:e2e']).toBe('node scripts/check-e2e-authenticity.mjs && node scripts/run-e2e.mjs');
  });

  it('makes the served E2E runner fail when report membership or no-skip validation fails', async () => {
    const runner = await readFile(new URL('./run-e2e.mjs', import.meta.url), 'utf8');
    expect(runner).toContain('scripts/e2e-report-gate.ts');
    expect(runner).toContain('cleanupFailed || reportGateFailed');
  });

  it('keeps the Gate A0.1 live first-turn oracle in its executable verification command', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
    }>;
    expect(manifest.scripts?.['verify:gate-a0.1']?.split(' && ').at(-1)).toBe(
      'pnpm test:e2e -- --project=gate-a0-live gate-a0-fast-chat.spec.ts',
    );
  });

  it('passes only the loopback Gateway client configuration through the E2E Worker supervisor', async () => {
    expect(modelGatewayWorkerEnvironment({
      GENEWAY_MODEL_GATEWAY_URL: 'http://127.0.0.1:3150',
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: '/tmp/gateway-authority/service-token',
      GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE: '/tmp/gateway-authority/invocation-secret',
      GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE: '/home/gewu/.codex/auth.json',
    })).toEqual({
      GENEWAY_MODEL_GATEWAY_URL: 'http://127.0.0.1:3150',
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: '/tmp/gateway-authority/service-token',
    });
    expect(() => modelGatewayWorkerEnvironment({
      GENEWAY_MODEL_GATEWAY_URL: 'http://127.0.0.1:3150',
    })).toThrow('configured together');
    expect(() => modelGatewayWorkerEnvironment({
      GENEWAY_MODEL_GATEWAY_URL: 'http://192.168.1.20:3150',
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: '/tmp/gateway-authority/service-token',
    })).toThrow('loopback');

    const supervisor = await readFile(new URL('./e2e/start-e2e-worker.ts', import.meta.url), 'utf8');
    expect(supervisor).toContain('...modelGatewayWorkerEnvironment(process.env)');
  });
});
