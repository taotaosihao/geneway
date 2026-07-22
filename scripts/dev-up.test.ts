import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseLanHosts, readConfiguration } from './dev-up.mjs';

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

  it('builds 192.168/16 and 10/8 Web entries while keeping Control Plane on loopback', () => {
    expect(readConfiguration({
      GENEWAY_WEB_PORT: '4320',
      GENEWAY_CONTROL_PLANE_PORT: '4310',
    }, ['192.168.10.25', '10.20.30.40'])).toEqual({
      lanHosts: ['192.168.10.25', '10.20.30.40'],
      webBindHosts: ['192.168.10.25', '10.20.30.40'],
      webPort: 4320,
      controlPlaneBindHost: '127.0.0.1',
      controlPlanePort: 4310,
      allowedWebOrigins: [
        'http://localhost:4320',
        'http://127.0.0.1:4320',
        'http://192.168.10.25:4320',
        'http://10.20.30.40:4320',
      ],
      publicUrls: [
        'http://192.168.10.25:4320/conversations/new?capability=solution.analysis.v1',
        'http://10.20.30.40:4320/conversations/new?capability=solution.analysis.v1',
      ],
    });
  });

  it('discovers physical and WireGuard LAN addresses while excluding virtual bridges', () => {
    expect(parseLanHosts(`
3: wlp129s0f0    inet 192.168.0.104/24 scope global wlp129s0f0
5: tailscale0    inet 100.64.0.5/32 scope global tailscale0
6: wg0    inet 10.0.0.8/32 scope global wg0
11: docker0    inet 10.1.0.1/16 scope global docker0
20: br-example    inet 192.168.64.1/20 scope global br-example
21: vmnet1    inet 192.168.228.1/24 scope global vmnet1
22: eno1    inet 8.8.8.8/24 scope global eno1
`)).toEqual(['192.168.0.104', '10.0.0.8']);
  });

  it('fails when no active 192.168/16 or 10/8 address is available', () => {
    expect(() => parseLanHosts('5: tailscale0 inet 100.64.0.5/32 scope global tailscale0\n')).toThrow(
      'No usable 192.168/16 or 10/8 address found',
    );
  });

  it('rejects conflicting Web and Control Plane ports', () => {
    const environment = { GENEWAY_WEB_PORT: '3100', GENEWAY_CONTROL_PLANE_PORT: '3100' };
    const result = runDevUp(['--print-config'], environment);
    expect(result.status).not.toBe(0);
  });
});
