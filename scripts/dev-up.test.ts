import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseLanHosts, readConfiguration } from './dev-up.mjs';

type Environment = Readonly<Record<string, string | undefined>>;
type InternalConfiguration = ReturnType<typeof readConfiguration> & Readonly<{
  modelGatewayBindHost: '127.0.0.1';
  modelGatewayPort: number;
  releaseHelperBindHost: '127.0.0.1';
  releaseHelperPort: number;
}>;
type ControlPlaneStackPlan = Readonly<{ arguments: readonly string[]; releaseHealthUrl: string | null }>;
const devUpInternals = await import('./dev-up.mjs') as unknown as Readonly<{
  buildControlPlaneStackPlan: (input: Readonly<{
    configuration: InternalConfiguration;
    runId: string;
    socketPath: string;
    tokenFile: string;
    gatewayServiceTokenFile: string;
    gatewayInvocationSecretFile: string;
    liveProvider?: Readonly<{ authFilePath: string; conformanceFilePath: string }>;
  }>) => ControlPlaneStackPlan;
  controlPlaneEnvironment: (environment?: Environment) => Readonly<Record<string, string | undefined>>;
  minimalEnvironment: (environment?: Environment) => Readonly<Record<string, string>>;
  modelGatewayProviderEnvironment: (environment?: Environment) => Readonly<Record<string, string>>;
}>;
const {
  buildControlPlaneStackPlan, controlPlaneEnvironment, minimalEnvironment, modelGatewayProviderEnvironment,
} = devUpInternals;

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

  it('builds exact query-free 192.168/16 and 10/8 entries while keeping internal listeners on loopback', () => {
    const configuration = readConfiguration({
      GENEWAY_WEB_PORT: '4320',
      GENEWAY_CONTROL_PLANE_PORT: '4310',
      GENEWAY_GATE_A0_RELEASE_PORT: '4360',
    }, ['192.168.10.25', '10.20.30.40']) as InternalConfiguration;
    expect(configuration).toEqual({
      lanHosts: ['192.168.10.25', '10.20.30.40'],
      webBindHosts: ['192.168.10.25', '10.20.30.40'],
      webPort: 4320,
      controlPlaneBindHost: '127.0.0.1',
      controlPlanePort: 4310,
      modelGatewayBindHost: '127.0.0.1',
      modelGatewayPort: 3150,
      releaseHelperBindHost: '127.0.0.1',
      releaseHelperPort: 4360,
      allowedWebOrigins: [
        'http://localhost:4320',
        'http://127.0.0.1:4320',
        'http://192.168.10.25:4320',
        'http://10.20.30.40:4320',
      ],
      publicUrls: [
        'http://192.168.10.25:4320/conversations/new',
        'http://10.20.30.40:4320/conversations/new',
      ],
    });
    expect(configuration.webBindHosts).not.toContain('0.0.0.0');
    expect(configuration.publicUrls.map((value) => {
      const url = new URL(value);
      return { pathname: url.pathname, search: url.search };
    })).toEqual([
      { pathname: '/conversations/new', search: '' },
      { pathname: '/conversations/new', search: '' },
    ]);
  });

  it('binds the disposable release helper to the same run and keeps Worker authority on UDS', () => {
    const configuration = readConfiguration({}, ['192.168.0.104', '10.0.0.8']) as InternalConfiguration;
    const plan = buildControlPlaneStackPlan({
      configuration,
      runId: 'dev-123-456',
      socketPath: '/tmp/geneway-dev-test/worker.sock',
      tokenFile: '/tmp/geneway-dev-test/worker.token',
      gatewayServiceTokenFile: '/tmp/geneway-dev-test/model-gateway-service.token',
      gatewayInvocationSecretFile: '/tmp/geneway-dev-test/model-gateway-invocation.token',
      liveProvider: {
        authFilePath: '/home/gewu/.codex/auth.json',
        conformanceFilePath: '/tmp/geneway-conformance.json',
      },
    });
    expect(plan.releaseHealthUrl).toBe('http://127.0.0.1:3160/health');
    expect(plan.arguments).toContain('GENEWAY_RUN_ID=dev-123-456');
    expect(plan.arguments).toContain('GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID=dev-123-456');
    expect(plan.arguments).toContain('GENEWAY_GATE_A0_RELEASE_PORT=3160');
    expect(plan.arguments).toContain('GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE=/home/gewu/.codex/auth.json');
    expect(plan.arguments).toContain('GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE=/tmp/geneway-conformance.json');
    expect(plan.arguments).toContain('GENEWAY_WORKER_SOCKET_PATH=/tmp/geneway-dev-test/worker.sock');
    const stackCommand = plan.arguments.at(-1);
    expect(stackCommand).toContain('scripts/e2e/start-gate-a0-release.ts');
    expect(stackCommand).toContain('env -u GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE');
    expect(stackCommand).not.toContain('0.0.0.0');
  });

  it('projects provider credential paths only to Model Gateway and the release helper', () => {
    const environment = {
      PATH: '/usr/bin',
      HOME: '/home/example',
      GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE: '/home/gewu/.codex/auth.json',
      GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE: '/tmp/geneway-conformance.json',
    };
    expect(modelGatewayProviderEnvironment(environment)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/example',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE: '/home/gewu/.codex/auth.json',
      GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE: '/tmp/geneway-conformance.json',
    });
    expect(minimalEnvironment(environment)).not.toHaveProperty('GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE');
    expect(controlPlaneEnvironment(environment)).not.toHaveProperty('GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE');
    expect(controlPlaneEnvironment(environment)).not.toHaveProperty('GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE');
    expect(() => modelGatewayProviderEnvironment({
      GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE: '/home/gewu/.codex/auth.json',
    })).toThrow('must be configured together');
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
