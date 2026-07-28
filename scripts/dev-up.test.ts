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
  gateAReleaseHelperBindHost: '127.0.0.1';
  gateAReleaseHelperPort: number;
  gateA3ReleaseHelperBindHost: '127.0.0.1';
  gateA3ReleaseHelperPort: number;
}>;
type ControlPlaneStackPlan = Readonly<{
  arguments: readonly string[];
  releaseHealthUrl: string | null;
  gateAReleaseHealthUrl: string | null;
}>;
const devUpInternals = await import('./dev-up.mjs') as unknown as Readonly<{
  GATE_A3_STARTUP_ORDER: readonly string[];
  assertGateA3FullRuntimeReceipt: (authority: unknown, receipt: unknown) => void;
  assertGateA3LiveRuntimeReceipt: (authority: unknown, receipt: unknown) => void;
  buildControlPlaneStackPlan: (input: Readonly<{
    configuration: InternalConfiguration;
    runId: string;
    socketPath: string;
    tokenFile: string;
    gatewayServiceTokenFile: string;
    gatewayInvocationSecretFile: string;
    liveProvider?: Readonly<{ authFilePath: string; conformanceFilePath: string }>;
    parserBuild?: Readonly<{
      image: string;
      imageSourceDigest: string;
      packageDigest: string;
      pdfjsInventoryDigest: string;
    }>;
    parserApproval?: Readonly<{
      schemaVersion: 'gate-a-parser-startup-approval/2';
      runId: string;
      image: string;
      imageId: string;
      imageSourceDigest: string;
      executableDigest: string;
      packageDigest: string;
      runtimeClosureDigest: string;
      dependencyInventoryDigest: string;
      formatManifestDigests: Readonly<{ txt: string; pdf: string; docx: string }>;
      approvedBy: string;
      approvedAt: string;
      expiresAt: string;
    }>;
    approvedC1Sha256?: string;
    gateA3?: Readonly<{
      approvedPreflightFile: string;
      controllerAdmissionFile: string;
      internalValidationAdmissionFile: string;
      connectorGatewayUrl: string;
      connectorGatewayServiceTokenFile: string;
      connectorGatewayInvocationSecretFile: string;
      connectorGatewayReceiptSecretFile: string;
      modelGatewayWorkOrderReceiptSecretFile: string;
    }>;
  }>) => ControlPlaneStackPlan;
  buildGateA3RuntimePlan: (authority: Readonly<{
    runtimeImageId: string;
    runtimeAuthorityDigest: string;
    dynamicAuthorityDigest: string;
    gearjobCommit: string;
    nestedAppCommits: Readonly<Record<'frappe' | 'erpnext' | 'hrms' | 'print_designer', string>>;
  }>, imagePresent: boolean) => Readonly<{
    executable: string;
    environment: Readonly<Record<string, string>>;
    buildArguments: readonly string[] | null;
    upArguments: readonly string[];
    retainedOnCleanup: boolean;
  }>;
  deriveApprovedGateA3Authority: (input: Readonly<{
    preflight: unknown;
    admission: unknown;
    validationAdmission: unknown;
  }>, now?: Date) => unknown;
  controlPlaneEnvironment: (environment?: Environment) => Readonly<Record<string, string | undefined>>;
  minimalEnvironment: (environment?: Environment) => Readonly<Record<string, string>>;
  modelGatewayProviderEnvironment: (environment?: Environment) => Readonly<Record<string, string>>;
}>;
const {
  GATE_A3_STARTUP_ORDER, assertGateA3FullRuntimeReceipt, assertGateA3LiveRuntimeReceipt,
  buildControlPlaneStackPlan, buildGateA3RuntimePlan,
  controlPlaneEnvironment, deriveApprovedGateA3Authority, minimalEnvironment, modelGatewayProviderEnvironment,
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
      gateAReleaseHelperBindHost: '127.0.0.1',
      gateAReleaseHelperPort: 3170,
      gateA3ReleaseHelperBindHost: '127.0.0.1',
      gateA3ReleaseHelperPort: 3175,
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
    expect(plan.gateAReleaseHealthUrl).toBeNull();
    expect(plan.arguments).toContain('GENEWAY_GATE_A0_RELEASE_PORT=3160');
    expect(plan.arguments).toContain('GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE=/home/gewu/.codex/auth.json');
    expect(plan.arguments).toContain('GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE=/tmp/geneway-conformance.json');
    expect(plan.arguments).toContain('GENEWAY_WORKER_SOCKET_PATH=/tmp/geneway-dev-test/worker.sock');
    const stackCommand = plan.arguments.at(-1);
    expect(stackCommand).toContain('scripts/e2e/start-gate-a0-release.ts');
    expect(stackCommand).toContain('env -u GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE');
    expect(stackCommand).not.toContain('0.0.0.0');
  });

  it('passes owned authority files and uses an explicit Gate A.3 release helper instead of startup promotion', () => {
    const configuration = readConfiguration({}, ['192.168.0.104']) as InternalConfiguration;
    const plan = buildControlPlaneStackPlan({
      configuration,
      runId: 'dev-a3-authority',
      socketPath: '/tmp/geneway-dev-test/worker.sock',
      tokenFile: '/tmp/geneway-dev-test/worker.token',
      gatewayServiceTokenFile: '/tmp/geneway-dev-test/model-gateway-service.token',
      gatewayInvocationSecretFile: '/tmp/geneway-dev-test/model-gateway-invocation.token',
      liveProvider: {
        authFilePath: '/approved/dev/provider-auth.json',
        conformanceFilePath: '/approved/dev/provider-conformance.json',
      },
      gateA3: {
        approvedPreflightFile: '/authority/preflight.json',
        controllerAdmissionFile: '/authority/controller.json',
        internalValidationAdmissionFile: '/authority/internal.json',
        connectorGatewayUrl: 'http://127.0.0.1:3155',
        connectorGatewayServiceTokenFile: '/tmp/geneway-dev-test/connector-service.token',
        connectorGatewayInvocationSecretFile: '/gearjob/invocation.secret',
        connectorGatewayReceiptSecretFile: '/tmp/geneway-dev-test/connector-receipt.secret',
        modelGatewayWorkOrderReceiptSecretFile: '/tmp/geneway-dev-test/model-receipt.secret',
      },
    });
    expect(plan.arguments).toContain('GENEWAY_GATE_A3_APPROVED_PREFLIGHT_FILE=/authority/preflight.json');
    expect(plan.arguments).toContain('GENEWAY_GATE_A3_CONTROLLER_ADMISSION_FILE=/authority/controller.json');
    expect(plan.arguments).toContain('GENEWAY_GATE_A3_INTERNAL_VALIDATION_ADMISSION_FILE=/authority/internal.json');
    expect(plan.arguments).toContain('GENEWAY_CONTROL_PLANE_URL=http://127.0.0.1:3100');
    expect(plan.arguments).toContain('GENEWAY_GATE_A3_RELEASE_PORT=3175');
    expect(plan.arguments.join('\n')).not.toContain('GENEWAY_GATE_A3_APPROVED_PREFLIGHT_DIGEST=');
    expect(plan.arguments.at(-1)).toContain('scripts/e2e/start-gate-a3-release.ts');
    expect(plan.arguments.at(-1)).toContain('route remains NOT_OPEN while the base stack continues');
  });

  it('never admits Gate A.3 without the live provider authority', () => {
    const configuration = readConfiguration({}, ['192.168.0.104']) as InternalConfiguration;
    expect(() => buildControlPlaneStackPlan({
      configuration,
      runId: 'dev-a3-no-provider',
      socketPath: '/tmp/geneway-dev-test/worker.sock',
      tokenFile: '/tmp/geneway-dev-test/worker.token',
      gatewayServiceTokenFile: '/tmp/geneway-dev-test/model-gateway-service.token',
      gatewayInvocationSecretFile: '/tmp/geneway-dev-test/model-gateway-invocation.token',
      gateA3: {
        approvedPreflightFile: '/authority/preflight.json',
        controllerAdmissionFile: '/authority/controller.json',
        internalValidationAdmissionFile: '/authority/internal.json',
        connectorGatewayUrl: 'http://127.0.0.1:3155',
        connectorGatewayServiceTokenFile: '/tmp/geneway-dev-test/connector-service.token',
        connectorGatewayInvocationSecretFile: '/gearjob/invocation.secret',
        connectorGatewayReceiptSecretFile: '/tmp/geneway-dev-test/connector-receipt.secret',
        modelGatewayWorkOrderReceiptSecretFile: '/tmp/geneway-dev-test/model-receipt.secret',
      },
    })).toThrow('requires the configured live model provider authority');
  });

  it('fails closed through the canonical strict A.3 authority schemas before deriving any runtime tuple', () => {
    expect(() => deriveApprovedGateA3Authority({
      preflight: { schema_version: 'geneway.gearjob-preflight/1' },
      admission: {},
      validationAdmission: {},
    })).toThrow('failed strict canonical schema validation');
  });

  it('uses a fixed sanitized Docker lifecycle and retains the GearJob runtime and volumes', () => {
    const digest = (value: string) => value.repeat(64);
    const commit = (value: string) => value.repeat(40);
    const authority = {
      runtimeImageId: `sha256:${digest('a')}`,
      runtimeAuthorityDigest: digest('b'),
      dynamicAuthorityDigest: digest('c'),
      gearjobCommit: commit('d'),
      nestedAppCommits: {
        frappe: commit('e'),
        erpnext: commit('f'),
        hrms: commit('1'),
        print_designer: commit('2'),
      },
    };
    const missingImage = buildGateA3RuntimePlan(authority, false);
    expect(missingImage.executable).toBe('/usr/bin/docker');
    expect(missingImage.environment).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      GENEWAY_GATE_A3_RUNTIME_IMAGE_ID: authority.runtimeImageId,
      GENEWAY_GATE_A3_RUNTIME_AUTHORITY_SHA256: authority.runtimeAuthorityDigest,
      GENEWAY_GATE_A3_DYNAMIC_AUTHORITY_SHA256: authority.dynamicAuthorityDigest,
      GEARJOB_GATE_A3_GEARJOB_COMMIT: authority.gearjobCommit,
      GEARJOB_GATE_A3_FRAPPE_COMMIT: authority.nestedAppCommits.frappe,
      GEARJOB_GATE_A3_ERPNEXT_COMMIT: authority.nestedAppCommits.erpnext,
      GEARJOB_GATE_A3_HRMS_COMMIT: authority.nestedAppCommits.hrms,
      GEARJOB_GATE_A3_PRINT_DESIGNER_COMMIT: authority.nestedAppCommits.print_designer,
    });
    expect(missingImage.buildArguments).toContain('gate-a3-runtime-build');
    expect(missingImage.upArguments.slice(-4)).toEqual(['mariadb', 'redis-cache', 'redis-queue', 'frappe']);
    expect(missingImage.upArguments).toContain('--no-build');
    expect(missingImage.upArguments.join(' ')).not.toMatch(/\b(?:down|rm|volume|--volumes)\b/u);
    expect(missingImage.retainedOnCleanup).toBe(true);
    expect(buildGateA3RuntimePlan(authority, true).buildArguments).toBeNull();
  });

  it('starts Control Plane before Connector Gateway and performs A.3 readiness before Worker', () => {
    expect(GATE_A3_STARTUP_ORDER).toEqual([
      'model-gateway', 'control-plane', 'connector-gateway', 'gate-a3-readiness', 'worker', 'web',
    ]);
  });

  it('requires full and live runtime receipts to retain the signed topology digest', () => {
    const authority = {
      runtimeImageId: `sha256:${'a'.repeat(64)}`,
      runtimeAuthorityDigest: 'b'.repeat(64),
      dynamicAuthorityDigest: 'c'.repeat(64),
      runtimeAuthority: { runtimeTopologyDigest: 'd'.repeat(64) },
    };
    const full = {
      schemaVersion: 'gearjob-gate-a3-runtime-verification/1',
      runtimeAuthorityDigest: authority.runtimeAuthorityDigest,
      runtimeImageId: authority.runtimeImageId,
      runtimeTopologyDigest: authority.runtimeAuthority.runtimeTopologyDigest,
      verified: true,
    };
    const live = {
      schemaVersion: 'gearjob-gate-a3-live-verification/1',
      dynamicAuthorityDigest: authority.dynamicAuthorityDigest,
      runtimeImageId: authority.runtimeImageId,
      runtimeTopologyDigest: authority.runtimeAuthority.runtimeTopologyDigest,
      verified: true,
    };
    expect(() => assertGateA3FullRuntimeReceipt(authority, full)).not.toThrow();
    expect(() => assertGateA3LiveRuntimeReceipt(authority, live)).not.toThrow();
    expect(() => assertGateA3FullRuntimeReceipt(authority, {
      ...full, runtimeTopologyDigest: 'e'.repeat(64),
    })).toThrow('not bound to the signed authority');
    const { runtimeTopologyDigest: _omitted, ...liveWithoutTopology } = live;
    void _omitted;
    expect(() => assertGateA3LiveRuntimeReceipt(authority, liveWithoutTopology))
      .toThrow('not bound to the signed authority');
  });

  it('starts the Gate A helper only with source-bound parser approval and keeps provider authority out of Control Plane', () => {
    const configuration = readConfiguration({}, ['192.168.0.104']) as InternalConfiguration;
    const digest = 'a'.repeat(64);
    const packageDigest = 'b'.repeat(64);
    const parserBuild = {
      image: `geneway-document-parser:${digest.slice(0, 16)}`,
      imageSourceDigest: digest,
      packageDigest,
      pdfjsInventoryDigest: 'c'.repeat(64),
    };
    const parserApproval = {
      schemaVersion: 'gate-a-parser-startup-approval/2' as const,
      runId: 'dev-gate-a-123',
      image: parserBuild.image,
      imageId: `sha256:${'d'.repeat(64)}`,
      imageSourceDigest: digest,
      executableDigest: 'e'.repeat(64),
      packageDigest,
      runtimeClosureDigest: 'f'.repeat(64),
      dependencyInventoryDigest: '1'.repeat(64),
      formatManifestDigests: { txt: '2'.repeat(64), pdf: '3'.repeat(64), docx: '4'.repeat(64) },
      approvedBy: 'user_local',
      approvedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const plan = buildControlPlaneStackPlan({
      configuration,
      runId: 'dev-gate-a-123',
      socketPath: '/tmp/geneway-dev-test/worker.sock',
      tokenFile: '/tmp/geneway-dev-test/worker.token',
      gatewayServiceTokenFile: '/tmp/geneway-dev-test/model-gateway-service.token',
      gatewayInvocationSecretFile: '/tmp/geneway-dev-test/model-gateway-invocation.token',
      liveProvider: {
        authFilePath: '/approved/dev/provider-auth.json',
        conformanceFilePath: '/approved/dev/provider-conformance.json',
      },
      parserBuild,
      parserApproval,
      approvedC1Sha256: `${'5'.repeat(64)},${'6'.repeat(64)}`,
    });
    expect(plan.releaseHealthUrl).toBe('http://127.0.0.1:3160/health');
    expect(plan.gateAReleaseHealthUrl).toBe('http://127.0.0.1:3170/health');
    expect(plan.arguments).toContain('GENEWAY_GATE_A_RELEASE_PORT=3170');
    expect(plan.arguments).toContain('GENEWAY_GATE_A_LIVE_VALIDATION_RUN_ID=dev-gate-a-123');
    expect(plan.arguments).toContain(`GENEWAY_GATE_A_PARSER_IMAGE=${parserBuild.image}`);
    expect(plan.arguments).toContain(`GENEWAY_GATE_A_PARSER_BUILD_JSON=${JSON.stringify(parserBuild)}`);
    expect(plan.arguments).toContain(`GENEWAY_GATE_A_PARSER_APPROVAL_JSON=${JSON.stringify(parserApproval)}`);
    expect(plan.arguments).toContain(`GENEWAY_GATE_A_APPROVED_C1_SHA256=${'5'.repeat(64)},${'6'.repeat(64)}`);
    const stackCommand = plan.arguments.at(-1);
    expect(stackCommand).toContain('scripts/e2e/start-gate-a-release.ts');
    expect(stackCommand).toContain('env -u GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE');
    expect(stackCommand).toContain('-u GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE');
    expect(stackCommand).toContain('-u GENEWAY_GATE_A_PARSER_BUILD_JSON');
    expect(stackCommand).not.toContain('/approved/dev/provider-auth.json');
    expect(stackCommand).not.toContain('/approved/dev/provider-conformance.json');
    expect(stackCommand).not.toContain('0.0.0.0');
    expect(() => buildControlPlaneStackPlan({
      configuration,
      runId: 'dev-gate-a-invalid-c1',
      socketPath: '/tmp/geneway-dev-test/worker.sock',
      tokenFile: '/tmp/geneway-dev-test/worker.token',
      gatewayServiceTokenFile: '/tmp/geneway-dev-test/model-gateway-service.token',
      gatewayInvocationSecretFile: '/tmp/geneway-dev-test/model-gateway-invocation.token',
      liveProvider: {
        authFilePath: '/approved/dev/provider-auth.json',
        conformanceFilePath: '/approved/dev/provider-conformance.json',
      },
      parserBuild,
      parserApproval,
      approvedC1Sha256: 'not-a-digest',
    })).toThrow('comma-separated lowercase SHA-256');
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
