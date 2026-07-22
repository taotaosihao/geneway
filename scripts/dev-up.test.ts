import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('..', import.meta.url);

function runDevUp(arguments_: readonly string[], environment: Readonly<Record<string, string>>) {
  return spawnSync(process.execPath, ['scripts/dev-up.mjs', ...arguments_], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      ...environment,
    },
    encoding: 'utf8',
  });
}

describe('dev-up command contract', () => {
  it('is exposed as the root dev-up command', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
    }>;
    expect(manifest.scripts?.['dev-up']).toBe('node scripts/dev-up.mjs');
  });

  it('builds a LAN-only public Web configuration while keeping Control Plane on loopback', () => {
    const result = runDevUp(['--print-config'], {
      GENEWAY_DEV_LAN_HOST: '192.168.10.25',
      GENEWAY_WEB_PORT: '4320',
      GENEWAY_CONTROL_PLANE_PORT: '4310',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      lanHost: '192.168.10.25',
      webBindHost: '192.168.10.25',
      webPort: 4320,
      controlPlaneBindHost: '127.0.0.1',
      controlPlanePort: 4310,
      allowedWebOrigins: [
        'http://localhost:4320',
        'http://127.0.0.1:4320',
        'http://192.168.10.25:4320',
      ],
      publicUrl: 'http://192.168.10.25:4320/conversations/new?capability=solution.analysis.v1',
    });
  });

  it.each([
    { GENEWAY_DEV_LAN_HOST: '127.0.0.1' },
    { GENEWAY_DEV_LAN_HOST: 'not-an-ip' },
    { GENEWAY_DEV_LAN_HOST: '8.8.8.8' },
    { GENEWAY_DEV_LAN_HOST: '100.64.0.5' },
    { GENEWAY_DEV_LAN_HOST: '192.168.1.20', GENEWAY_WEB_PORT: '3100', GENEWAY_CONTROL_PLANE_PORT: '3100' },
  ])('rejects unsafe or conflicting configuration: %j', (environment) => {
    const result = runDevUp(['--print-config'], environment);
    expect(result.status).not.toBe(0);
  });
});
