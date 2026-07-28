import { describe, expect, it } from 'vitest';

// @ts-expect-error The production wrapper is intentionally native ESM; this test pins its exported surface below.
const sandbox = await import('./business-process-sandbox.mjs') as unknown as Readonly<{
  BUSINESS_PROCESS_ROLES: readonly string[];
  CODEX_AUTHORITY_ROOT: string;
  GEARJOB_ROOT: string;
  DOCKER_SOCKET_PATH: string;
  DOCKER_CLI_PATH: string;
  buildBusinessProcessEnvironment: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Readonly<Record<string, string>>;
  buildBusinessProcessSandboxPlan: (input: Readonly<{
    role: string;
    command: string;
    arguments?: readonly string[];
    bwrapPath?: string;
    workingDirectory?: string;
    credentialFile?: string;
    providerCredentialFile?: string;
  }>) => Readonly<{ executable: string; arguments: readonly string[] }>;
  parseBusinessProcessSandboxCli: (arguments_: readonly string[]) => Readonly<{
    role: string | undefined;
    bwrapPath: string;
    workingDirectory: string;
    credentialFile: string | undefined;
    providerCredentialFile: string | undefined;
    command: string;
    arguments: readonly string[];
  }>;
}>;

const {
  BUSINESS_PROCESS_ROLES,
  CODEX_AUTHORITY_ROOT,
  GEARJOB_ROOT,
  DOCKER_SOCKET_PATH,
  DOCKER_CLI_PATH,
  buildBusinessProcessEnvironment,
  buildBusinessProcessSandboxPlan,
  parseBusinessProcessSandboxCli,
} = sandbox;

function build(role: string, credentialFile?: string) {
  return buildBusinessProcessSandboxPlan({
    role,
    command: '/usr/bin/node',
    arguments: ['--version'],
    bwrapPath: '/usr/bin/bwrap',
    workingDirectory: '/home/gewu/work/geneway',
    ...(credentialFile === undefined ? {} : { credentialFile }),
  });
}

function singleArgumentValues(arguments_: readonly string[], option: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < arguments_.length - 1; index += 1) {
    if (arguments_[index] === option) values.push(arguments_[index + 1] ?? '');
  }
  return values;
}

function doubleArgumentValues(
  arguments_: readonly string[],
  option: string,
): readonly (readonly [string, string])[] {
  const values: Array<readonly [string, string]> = [];
  for (let index = 0; index < arguments_.length - 2; index += 1) {
    if (arguments_[index] === option) {
      values.push([arguments_[index + 1] ?? '', arguments_[index + 2] ?? '']);
    }
  }
  return values;
}

describe('business process bubblewrap boundary', () => {
  it('builds the same network-sharing boundary for every business process role', () => {
    expect(BUSINESS_PROCESS_ROLES).toEqual([
      'web',
      'control-plane',
      'worker',
      'runtime',
      'model-gateway',
      'connector-gateway',
    ]);

    for (const role of BUSINESS_PROCESS_ROLES) {
      const plan = build(role);
      expect(plan.executable).toBe('/usr/bin/bwrap');
      expect(plan.arguments).toContain('--unshare-all');
      expect(plan.arguments).toContain('--share-net');
      expect(plan.arguments).not.toContain('--unshare-net');
      expect(plan.arguments.slice(-3)).toEqual(['--', '/usr/bin/node', '--version']);
    }
  });

  it('fails closed for an unknown role or non-absolute launch inputs', () => {
    expect(() => build('database')).toThrow(/unsupported business process role/u);
    expect(() => buildBusinessProcessSandboxPlan({
      role: 'web',
      command: 'node',
      bwrapPath: '/usr/bin/bwrap',
      workingDirectory: '/home/gewu/work/geneway',
    })).toThrow(/command must be an absolute normalized path/u);
    expect(() => buildBusinessProcessSandboxPlan({
      role: 'web',
      command: '/usr/bin/node',
      bwrapPath: 'bwrap',
      workingDirectory: '/home/gewu/work/geneway',
    })).toThrow(/bwrap path must be an absolute normalized path/u);
  });

  it('masks Codex authority, GearJob, the Docker socket, and the Docker CLI', () => {
    const plan = build('control-plane');
    expect(singleArgumentValues(plan.arguments, '--tmpfs')).toEqual([
      CODEX_AUTHORITY_ROOT,
      GEARJOB_ROOT,
    ]);
    expect(doubleArgumentValues(plan.arguments, '--ro-bind')).toEqual([
      ['/', '/'],
      ['/dev/null', DOCKER_SOCKET_PATH],
      ['/dev/null', DOCKER_CLI_PATH],
    ]);
    expect(plan.arguments).toContain('--disable-userns');
  });

  it('removes Docker, Compose, BuildKit, and container-host environment authority', () => {
    expect(buildBusinessProcessEnvironment({
      PATH: '/usr/bin:/bin',
      SAFE_VALUE: 'preserved',
      DOCKER_HOST: 'unix:///run/docker.sock',
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CONTEXT: 'desktop-linux',
      COMPOSE_FILE: 'compose.yml',
      COMPOSE_PROJECT_NAME: 'unsafe',
      BUILDKIT_HOST: 'tcp://127.0.0.1:1234',
      CONTAINER_HOST: 'unix:///run/podman.sock',
      OMITTED: undefined,
    })).toEqual({
      PATH: '/usr/bin:/bin',
      SAFE_VALUE: 'preserved',
    });
  });

  it('rejects a credential remount for every role except connector-gateway', () => {
    const credentialFile = `${GEARJOB_ROOT}/development/secrets/connector.token`;
    for (const role of BUSINESS_PROCESS_ROLES.filter((value) => value !== 'connector-gateway')) {
      expect(() => build(role, credentialFile)).toThrow(/only connector-gateway/u);
    }
    expect(() => build('connector-gateway', '/tmp/connector.token')).toThrow(
      new RegExp(`contained by ${GEARJOB_ROOT}`, 'u'),
    );
  });

  it('remounts the provider credential only for Model Gateway', () => {
    const providerCredentialFile = `${CODEX_AUTHORITY_ROOT}/auth.json`;
    for (const role of BUSINESS_PROCESS_ROLES.filter((value) => value !== 'model-gateway')) {
      expect(() => buildBusinessProcessSandboxPlan({
        role,
        command: '/usr/bin/node',
        bwrapPath: '/usr/bin/bwrap',
        workingDirectory: '/home/gewu/work/geneway',
        providerCredentialFile,
      })).toThrow(/only model-gateway/u);
    }
    const plan = buildBusinessProcessSandboxPlan({
      role: 'model-gateway',
      command: '/usr/bin/node',
      bwrapPath: '/usr/bin/bwrap',
      workingDirectory: '/home/gewu/work/geneway',
      providerCredentialFile,
    });
    expect(doubleArgumentValues(plan.arguments, '--ro-bind').at(-1))
      .toEqual([providerCredentialFile, providerCredentialFile]);
    expect(() => buildBusinessProcessSandboxPlan({
      role: 'model-gateway',
      command: '/usr/bin/node',
      bwrapPath: '/usr/bin/bwrap',
      workingDirectory: '/home/gewu/work/geneway',
      providerCredentialFile: '/tmp/auth.json',
    })).toThrow(/contained by/u);
  });

  it('recreates only credential parents and remounts the exact credential read-only at the same path', () => {
    const credentialFile = `${GEARJOB_ROOT}/development/secrets/connector.token`;
    const plan = build('connector-gateway', credentialFile);

    expect(singleArgumentValues(plan.arguments, '--dir')).toEqual([
      `${GEARJOB_ROOT}/development`,
      `${GEARJOB_ROOT}/development/secrets`,
    ]);
    const readOnlyBindings = doubleArgumentValues(plan.arguments, '--ro-bind');
    expect(readOnlyBindings.at(-1)).toEqual([credentialFile, credentialFile]);
    expect(readOnlyBindings.flat()).not.toContain(dirnameLikeCredentialSibling(credentialFile));
  });

  it('parses a shell-free CLI with an explicit command separator', () => {
    expect(parseBusinessProcessSandboxCli([
      '--role', 'connector-gateway',
      '--bwrap', '/usr/bin/bwrap',
      '--cwd', '/home/gewu/work/geneway',
      '--credential-file', `${GEARJOB_ROOT}/credential`,
      '--provider-credential-file', `${CODEX_AUTHORITY_ROOT}/auth.json`,
      '--',
      '/usr/bin/node',
      '--import',
      'tsx',
      'services/connector-gateway/src/main.ts',
    ])).toEqual({
      role: 'connector-gateway',
      bwrapPath: '/usr/bin/bwrap',
      workingDirectory: '/home/gewu/work/geneway',
      credentialFile: `${GEARJOB_ROOT}/credential`,
      providerCredentialFile: `${CODEX_AUTHORITY_ROOT}/auth.json`,
      command: '/usr/bin/node',
      arguments: ['--import', 'tsx', 'services/connector-gateway/src/main.ts'],
    });
    expect(() => parseBusinessProcessSandboxCli([
      '--role', 'web',
      '/usr/bin/node',
    ])).toThrow(/invalid sandbox option|separated by/u);
    expect(() => parseBusinessProcessSandboxCli([
      '--role', 'web',
      '--role', 'worker',
      '--',
      '/usr/bin/node',
    ])).toThrow(/duplicate sandbox option/u);
  });
});

function dirnameLikeCredentialSibling(credentialFile: string): string {
  return credentialFile.replace(/connector\.token$/u, 'other.token');
}
