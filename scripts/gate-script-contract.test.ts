import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Gate 0.2A executable script contract', () => {
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
});
