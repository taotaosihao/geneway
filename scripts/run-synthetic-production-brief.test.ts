import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('synthetic production stack runner', () => {
  it('declares only the three admitted loopback services with stripped credential environment', () => {
    const raw = execFileSync(process.execPath, ['scripts/run-synthetic-production-brief.mjs', '--print-plan'], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgres://geneway:geneway@127.0.0.1:54321/geneway_test', AWS_SECRET_ACCESS_KEY: 'ambient-canary', GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE: '/forbidden' },
    });
    const plan = JSON.parse(raw) as Array<{ role: string; health: string; home: string; environmentNames: string[] }>;
    expect(plan.map(({ role }) => role)).toEqual(['synthetic-connector-gateway', 'control-plane', 'vite-web']);
    expect(plan.every(({ health }) => new URL(health).hostname === '127.0.0.1')).toBe(true);
    expect(plan.flatMap(({ environmentNames }) => environmentNames)).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(plan.flatMap(({ environmentNames }) => environmentNames)).not.toContain('GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE');
    expect(plan.every(({ home }) => home === '/tmp/task-owned/home')).toBe(true);
    expect(plan.every(({ home }) => home !== process.env.HOME)).toBe(true);
  });

  it('routes only the synthetic project to its bounded harness', () => {
    const route = (args: string[]) => execFileSync(process.execPath,
      ['scripts/run-synthetic-production-brief.mjs', '--print-e2e-route', '--', ...args],
      { cwd: process.cwd(), encoding: 'utf8' }).trim();
    expect(route(['--project=synthetic-production-brief', 'synthetic-production-brief.spec.ts'])).toBe('synthetic');
    expect(route(['--project=gate0.1', 'gate-0.1.spec.ts'])).toBe('legacy');
  });

  it('resolves the installed Chromium before replacing HOME', () => {
    const executable = execFileSync(process.execPath,
      ['scripts/run-synthetic-production-brief.mjs', '--print-browser-executable'],
      { cwd: process.cwd(), encoding: 'utf8', env: process.env }).trim();
    const stat = lstatSync(executable);
    expect(executable.startsWith('/')).toBe(true);
    expect(realpathSync(executable)).toBe(executable);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.uid).toBe(process.getuid?.());
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it('preserves the pre-router HOME and environment only for the legacy route', () => {
    const inspect = (route: 'legacy' | 'synthetic') => JSON.parse(execFileSync(process.execPath,
      ['scripts/run-synthetic-production-brief.mjs', '--print-e2e-environment', route], {
        cwd: process.cwd(), encoding: 'utf8', env: {
          ...process.env, HOME: '/tmp/geneway-legacy-home-canary', GENEWAY_LEGACY_ENV_CANARY: 'preserved',
        },
      })) as { home: string; canary?: string };
    expect(inspect('legacy')).toEqual({ home: '/tmp/geneway-legacy-home-canary', canary: 'preserved' });
    expect(inspect('synthetic')).toEqual({ home: '/tmp/task-owned/home' });
  });
});
