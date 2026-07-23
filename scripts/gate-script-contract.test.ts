import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isVisiblePersistedStreamingCheckpoint } from './e2e/gate-a0-chat-observability.js';
import { modelGatewayWorkerEnvironment } from './e2e/model-gateway-worker-environment.js';

interface GateStep { phase: string; name: string; command: readonly string[]; inheritRunId?: boolean }
interface Gate02bModule {
  backupArtifactRoots: (results: readonly unknown[]) => string[];
  childEnvironment: (runId: string, step: GateStep) => { environment: Readonly<Record<string, string>>; dockerIsolationEnvironment: Readonly<Record<string, string>> };
  collectReachableCommandStrings: (scripts: Readonly<Record<string, string>>, roots: readonly string[], sources?: Readonly<Record<string, string>>) => string[];
  extractNestedVerifierCommands: (source: string) => string[];
  extractStructuredBackupRunIds: (log: string, required: boolean) => string[];
  findForbiddenEnvironmentNames: (names: readonly string[]) => string[];
  gate02bDockerIsolationEnvironment: Readonly<Record<string, string>>;
  gate02bAggregatePassed: (input: Readonly<Record<string, unknown>>) => boolean;
  gateAuthorityRootNames: (entries: readonly string[]) => string[];
  isForbiddenRuntimeCommandLine: (commandLine: string) => boolean;
  isGateAuthorityPath: (path: string) => boolean;
  isRepositoryDockerScope: (name: string, labels?: Readonly<Record<string, string>>) => boolean;
  dockerStructuralIsolationReceipt: (state: unknown) => { passed: boolean; violations: string[] };
  parseSocketLine: (line: string, kind: 'listener' | 'egress') => { local: string; peer: string; pids: number[] };
  parseBackupRawReceipt: (raw: string, containerId: string, role: string, action: string, allowedPorts: readonly string[]) => {
    passed: boolean; reloadCount: number; unknownLines: string[]; unexpected: string[];
  };
  requiredGate02bSteps: readonly GateStep[];
  sourceBindingsMatch: (initial: Readonly<Record<string, unknown>>, final: Readonly<Record<string, unknown>>) => boolean;
  validateArtifactRoots: (roots: unknown) => string[];
  validateCleanupReceipt: (receipt: unknown) => boolean;
  validateGate02bCommandSafety: (steps: readonly { command: readonly string[] }[]) => boolean;
  validateGate02bStepPlan: (steps: readonly GateStep[]) => boolean;
  validateDockerIsolationCommandSafety: (commands: readonly string[]) => boolean;
  validateDockerStructuralIsolationReceipt: (receipt: unknown) => boolean;
  validateProcessLifecycleReceipt: (receipt: unknown) => boolean;
}
const {
  backupArtifactRoots, childEnvironment, collectReachableCommandStrings, dockerStructuralIsolationReceipt, extractNestedVerifierCommands,
  extractStructuredBackupRunIds,
  findForbiddenEnvironmentNames, gate02bAggregatePassed, gate02bDockerIsolationEnvironment, gateAuthorityRootNames,
  isForbiddenRuntimeCommandLine, isGateAuthorityPath,
  isRepositoryDockerScope, parseBackupRawReceipt, parseSocketLine, requiredGate02bSteps,
  sourceBindingsMatch, validateArtifactRoots, validateCleanupReceipt, validateGate02bCommandSafety,
  validateDockerIsolationCommandSafety, validateDockerStructuralIsolationReceipt, validateGate02bStepPlan,
  validateProcessLifecycleReceipt,
// @ts-expect-error The executable is native ESM; this test supplies its complete public contract above.
} = await import('./verify-gate0.2b.mjs') as unknown as Gate02bModule;

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

  it('keeps the Gate A0.2 live context/cancel oracle and post-run secret scan executable', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
    }>;
    expect(manifest.scripts?.['verify:gate-a0.2']?.split(' && ').slice(-2)).toEqual([
      'pnpm test:e2e -- --project=gate-a0-live gate-a0-context-cancel.spec.ts',
      'pnpm gate-a0:secret-scan',
    ]);
  });

  it('keeps the Gate A0 aggregate, actual dev-up LAN oracle, baseline regression and deferred scan executable', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
    }>;
    expect(manifest.scripts?.['verify:gate-a0']).toBe('node scripts/verify-gate-a0.mjs');
    expect(manifest.scripts?.['gate-a0:lan']).toBe('node scripts/run-gate-a0-lan.mjs');
    expect(manifest.scripts?.['gate-a0:deferred-scan']).toBe('node scripts/gate-a0-deferred-scan.mjs');
    const aggregate = await readFile(new URL('./verify-gate-a0.mjs', import.meta.url), 'utf8');
    expect(aggregate).toContain("command: ['pnpm', 'test:e2e', '--', '--project=gate-a0-live']");
    expect(aggregate).toContain("command: ['pnpm', 'gate-a0:lan']");
    expect(aggregate).toContain("command: ['pnpm', 'verify:gate0.2b.1']");
    expect(aggregate).toContain("command: ['pnpm', 'gate-a0:deferred-scan']");
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

describe('Gate 0.2B joint aggregate script contract', () => {
  const cleanReceipt = {
    checked: true,
    processes: { checked: true, passed: true, added: [] },
    listeners: { checked: true, passed: true, added: [] },
    globalListeners: { checked: true, passed: true, added: [] },
    egress: { checked: true, passed: true, added: [] },
    containers: { checked: true, passed: true, added: [] },
    workerSockets: { checked: true, passed: true, added: [] },
  } as const;
  const successfulResults = requiredGate02bSteps.map(() => ({
    status: 0, signal: null,
    sourceBinding: { stable: true },
    runtimeBoundary: { passed: true, structuralIsolation: { passed: true }, processLifecycle: { passed: true } },
    credentialBoundary: { checked: true, passed: true, forbiddenNamesPassed: [] },
    dockerIsolationEnvironment: { passed: true },
  }));

  it('keeps exact V2-V7 command membership and the sole package entrypoint', async () => {
    expect(validateGate02bStepPlan(requiredGate02bSteps)).toBe(true);
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
    }>;
    expect(manifest.scripts?.['verify:gate0.2b']).toBe('node scripts/verify-gate0.2b.mjs');
    expect(requiredGate02bSteps.map((step) => `${step.phase}:${step.command.join(' ')}`)).toEqual([
      'V2:pnpm lint',
      'V2:pnpm typecheck',
      'V2:pnpm test',
      'V2:pnpm exec vitest run apps/worker/src/worker-loop.test.ts packages/runtime/src/runtime.test.ts',
      'V2:pnpm build',
      'V2:pnpm test:contracts',
      'V3:pnpm test:integration',
      'V4:pnpm test:security',
      'V5:pnpm verify:gate0.2b.2',
      'V6:pnpm verify:gate0.2b.3',
      'V7:pnpm verify:gate0.2a',
      'V7:pnpm verify:gate0.2b.1',
      'V7:pnpm test:e2e -- --project=gate0.2b-fast-chat-local',
    ]);
  });

  it('rejects missing command members and forbidden live/auth commands', () => {
    expect(() => validateGate02bStepPlan(requiredGate02bSteps.slice(1))).toThrow('membership or order');
    const unsafe = requiredGate02bSteps.map((step) => ({ ...step, command: [...step.command] }));
    unsafe[0] = { ...unsafe[0]!, command: ['pnpm', 'verify:gate-a0'] };
    expect(() => validateGate02bCommandSafety(unsafe)).toThrow('forbidden live/auth command');
    for (const command of [
      'pnpm test:model-gateway',
      'pnpm model-gateway:conformance',
      'tsx scripts/e2e/start-e2e-model-gateway.ts',
      'vitest run services/model-gateway/src',
      'node scripts/run-gate-a0-lan.mjs',
      'node scripts/start-gate-a0-release.mjs',
      'provider invoke live',
      'node /tmp/auth.json',
    ]) {
      expect(() => validateGate02bCommandSafety([{ command: command.split(/\s+/u) }]), command).toThrow(
        'forbidden live/auth command',
      );
    }
  });

  it('expands nested package and verifier commands before applying command safety', () => {
    const scripts = { outer: 'pnpm inner', inner: 'pnpm verify:gate-a0' };
    const commands = collectReachableCommandStrings(scripts, ['pnpm outer']);
    expect(commands).toContain('pnpm verify:gate-a0');
    expect(() => validateGate02bCommandSafety(commands.map((command) => ({ command: command.split(' ') })))).toThrow(
      'forbidden live/auth command',
    );
    expect(extractNestedVerifierCommands("const steps = [\n  ['lint', ['pnpm', 'lint']],\n];")).toEqual(['pnpm lint']);
  });

  it('allows only static TypeScript project builds to reference the Model Gateway tsconfig at runtime', () => {
    const projects = 'packages/contracts/tsconfig.json services/model-gateway/tsconfig.json apps/worker/tsconfig.json';
    for (const commandLine of [
      `sh -c pnpm exec tsc -b ${projects} --force --pretty false`,
      `node /home/gewu/.nvm/versions/node/v24.15.0/bin/pnpm exec tsc -b ${projects} --force --pretty false`,
      `node ./node_modules/.bin/../typescript/bin/tsc -b ${projects} --force --pretty false`,
    ]) expect(isForbiddenRuntimeCommandLine(commandLine), commandLine).toBe(false);
    for (const commandLine of [
      'node services/model-gateway/dist/index.js',
      'tsx services/model-gateway/src/index.ts',
      'vitest run services/model-gateway/src',
      'node scripts/not-tsc.mjs -b services/model-gateway/tsconfig.json',
      `pnpm exec tsc -b ${projects} & node services/model-gateway/dist/index.js`,
      `pnpm exec tsc -b ${projects} | node services/model-gateway/dist/index.js`,
      `pnpm exec tsc -b ${projects}\nnode services/model-gateway/dist/index.js`,
      `pnpm exec tsc -b ${projects}\rnode services/model-gateway/dist/index.js`,
      'node scripts/e2e/start-e2e-model-gateway.ts',
      'node scripts/start-gate-a0-release.mjs',
      'node scripts/run-gate-a0-lan.mjs',
      'env GENEWAY_MODEL_GATEWAY_URL=http://127.0.0.1:3150 node scripts/safe.mjs',
      'provider invoke live',
    ]) expect(isForbiddenRuntimeCommandLine(commandLine), commandLine).toBe(true);
  });

  it('accepts the actual mandatory static typecheck and build targets after recursive expansion', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
    }>;
    const nestedSource = await readFile(new URL('./verify-gate0.2b.3.mjs', import.meta.url), 'utf8');
    const commands = collectReachableCommandStrings(
      manifest.scripts ?? {},
      requiredGate02bSteps.map((step) => step.command.join(' ')),
      { 'scripts/verify-gate0.2b.3.mjs': nestedSource },
    );
    expect(commands).toContain(manifest.scripts?.typecheck);
    expect(validateGate02bCommandSafety(commands.map((command) => ({ command: command.split(/\s+/u) })))).toBe(true);
  });

  it('forces dedicated internal Compose networks into every child and rejects command overrides', async () => {
    const compose = await readFile(new URL('./docker-compose.yml', import.meta.url), 'utf8');
    const backupCompose = await readFile(new URL('./backup-restore/docker-compose.yml', import.meta.url), 'utf8');
    const backupRunner = await readFile(new URL('./run-backup-restore.mjs', import.meta.url), 'utf8');
    const storageRunner = await readFile(new URL('./with-storage.sh', import.meta.url), 'utf8');
    const guard = await readFile(new URL('./backup-restore/gate02b-egress-guard.c', import.meta.url), 'utf8');
    const verifier = await readFile(new URL('./verify-gate0.2b.mjs', import.meta.url), 'utf8');
    expect(compose).toContain('internal: ${GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL:-false}');
    expect(compose).toContain('internal: ${GENEWAY_GATE02B_COMPOSE_STORAGE_INTERNAL:-true}');
    expect(backupCompose).toContain('internal: ${GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL:-false}');
    expect(backupRunner).toContain("gate02bGuardRequired ? ['--pull', 'never'] : []");
    expect(backupRunner).toContain('Gate 0.2B required offline role image is missing');
    expect(storageRunner).toContain('if [[ "${GENEWAY_GATE02B_EGRESS_GUARD:-}" == "required" ]]');
    expect(storageRunner.match(/"\$\{pull_policy\[@\]\}"/gu)).toHaveLength(3);
    for (const call of ['connect(', 'sendto(', 'sendmsg(', 'sendmmsg(']) expect(guard).toContain(call);
    expect(guard).toContain('== 0x7f000001U');
    expect(guard).toContain('offsetof(struct sockaddr_un, sun_path)');
    expect(guard).toContain("memchr(unix_address->sun_path, '\\0', path_length)");
    expect(backupRunner).toContain('geneway.backup.run=');
    expect(backupRunner).toContain("invokeRole('provision-docker', 'source', sourceStack)");
    expect(backupRunner).toContain("compose: (role === 'provision' && !gate02bGuardRequired) || role === 'provision-docker'");
    expect(backupRunner).not.toContain('GENEWAY_GATE02B_EGRESS_ALLOWED_UNIX=/var/run/docker.sock');
    expect(backupRunner).toContain("gate02bGuardRequired && role === 'provision-docker'");
    expect(backupRunner).toContain('rawReceiptSha256: sha256(rawBytes)');
    expect(verifier).toMatch(/finally \{\s+try \{ await stopDockerEventMonitor\(dockerEventMonitor, dockerObservation\);/u);
    expect(gate02bDockerIsolationEnvironment).toEqual({
      GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL: 'true',
      GENEWAY_GATE02B_COMPOSE_STORAGE_INTERNAL: 'true',
      GENEWAY_GATE02B_EGRESS_GUARD: 'required',
    });
    const child = childEnvironment('contract-run', requiredGate02bSteps[0]!);
    expect(child.dockerIsolationEnvironment).toMatchObject(gate02bDockerIsolationEnvironment);
    expect(child.dockerIsolationEnvironment.GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY).toContain('/tmp/geneway-runs/contract/');
    expect(child.environment).toMatchObject(gate02bDockerIsolationEnvironment);
    expect(validateDockerIsolationCommandSafety(['pnpm test:integration'])).toBe(true);
    expect(() => validateDockerIsolationCommandSafety(['GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL=false pnpm test'])).toThrow(
      'override/removal',
    );
    expect(() => validateDockerIsolationCommandSafety(['env -u GENEWAY_GATE02B_COMPOSE_STORAGE_INTERNAL pnpm test'])).toThrow(
      'override/removal',
    );
  });

  it('fails Docker structural isolation on non-internal networks, forbidden modes, or missing receipts', () => {
    const state = {
      containers: new Map([['container-id', {
        id: 'container-id', name: 'geneway-storage-1-postgres-1', project: 'geneway-storage-1', service: 'postgres',
        repositoryScoped: true,
        networkMode: 'host', inspectObserved: true, eventObserved: true, networkIds: new Set(['network-id']),
        networkNames: new Set(['geneway-storage-1_default']), publishedPorts: [], extraHosts: [],
      }]]),
      networks: new Map([['network-id', {
        id: 'network-id', name: 'geneway-storage-1_default', project: 'geneway-storage-1', internal: false,
        inspectObserved: true, subnets: ['172.30.0.0/16'],
      }]]),
      monitorStarted: true, eventCount: 2, eventParseErrors: [], monitorErrors: [], monitorExit: { signal: 'SIGTERM' },
    };
    const receipt = dockerStructuralIsolationReceipt(state);
    expect(receipt.passed).toBe(false);
    expect(receipt.violations).toEqual(expect.arrayContaining([
      expect.stringContaining('non-internal-network'), expect.stringContaining('container-network-mode-forbidden'),
    ]));
    expect(() => validateDockerStructuralIsolationReceipt(receipt)).toThrow('missing or failed');
    expect(() => validateProcessLifecycleReceipt({ checked: true, passed: false })).toThrow('missing or failed');
    expect(validateProcessLifecycleReceipt({
      checked: true, passed: true, identities: [{ pid: 1, startTicks: '42', listenerEndpoints: [] }],
      survivors: [], addedEndpoints: [], sampleErrors: [], beforeGlobalListeners: [], afterGlobalListeners: [],
    })).toBe(true);
  });

  it('accepts status 143 only after a successful verifier-requested SIGTERM monitor stop', () => {
    const cleanState = {
      containers: new Map(), networks: new Map(), monitorStarted: true, eventCount: 36,
      eventParseErrors: [], monitorErrors: [],
    };
    expect(dockerStructuralIsolationReceipt({
      ...cleanState, monitorExit: { status: 143, signal: null }, monitorStop: {
        requested: true, signal: 'SIGTERM', requestSucceeded: true, exit: { status: 143, signal: null },
      },
    }).passed).toBe(true);
    expect(dockerStructuralIsolationReceipt({
      ...cleanState, monitorExit: { status: 143, signal: null },
    }).passed).toBe(false);
    expect(dockerStructuralIsolationReceipt({
      ...cleanState, monitorExit: { status: 143, signal: 'SIGTERM' }, monitorStop: {
        requested: true, signal: 'SIGTERM', requestSucceeded: true, exit: { status: 143, signal: 'SIGTERM' },
      },
    }).passed).toBe(false);
    expect(dockerStructuralIsolationReceipt({
      ...cleanState, monitorExit: { status: 137, signal: null }, monitorStop: {
        requested: true, signal: 'SIGTERM', requestSucceeded: true, exit: { status: 137, signal: null },
      },
    }).passed).toBe(false);
  });

  it('requires exact structured backup child run membership', () => {
    const log = `${JSON.stringify({ outcome: 'passed', results: [
      { runId: 'backup-success' }, { runId: 'backup-missing' }, { runId: 'backup-mismatch' },
    ] })}\n`;
    expect(extractStructuredBackupRunIds(log, true)).toEqual(['backup-mismatch', 'backup-missing', 'backup-success']);
    expect(() => extractStructuredBackupRunIds('{"outcome":"passed","results":[]}\n', true)).toThrow('missing or duplicated');
    expect(() => extractStructuredBackupRunIds(`${log}${log}`, true)).toThrow('missing or duplicated');
    expect(() => extractStructuredBackupRunIds(JSON.stringify({ outcome: 'passed', results: [
      { runId: '../escape' }, { runId: 'safe-1' }, { runId: 'safe-2' },
    ] }), true)).toThrow('unsafe');
    expect(backupArtifactRoots([{ runtimeBoundary: { structuralIsolation: {
      expectedBackupRunIds: ['backup-success', 'backup-missing', 'backup-mismatch'],
    } } }])).toEqual([
      '/tmp/geneway-runs/backup-mismatch/backup-restore',
      '/tmp/geneway-runs/backup-missing/backup-restore',
      '/tmp/geneway-runs/backup-success/backup-restore',
    ]);
  });

  it('limits environment and UDS authority discovery to forbidden names and dedicated roots', () => {
    expect(findForbiddenEnvironmentNames(['PATH', 'GENEWAY_LAN_HOST', 'GENEWAY_MODEL_GATEWAY_URL'])).toEqual([
      'GENEWAY_LAN_HOST', 'GENEWAY_MODEL_GATEWAY_URL',
    ]);
    expect(isGateAuthorityPath('/tmp/gw-uds-X/token')).toBe(true);
    expect(isGateAuthorityPath('/tmp/gw-mgw-X')).toBe(true);
    expect(isGateAuthorityPath('/tmp/sharp-cell-X/token')).toBe(false);
    expect(gateAuthorityRootNames([
      'fuse', 'sharp-cell-X', 'gw-uds-Z', 'gw-mgw-A', 'gw-uds-', 'gw-uds-X/child',
    ])).toEqual(['gw-mgw-A', 'gw-uds-Z']);
    expect(isRepositoryDockerScope('scripts-postgres-1', {
      'com.docker.compose.project.config_files': '/home/gewu/work/geneway/scripts/docker-compose.yml',
      'com.docker.compose.project.working_dir': '/home/gewu/work/geneway/scripts',
    })).toBe(true);
    expect(isRepositoryDockerScope('nested-versitygw-1', {
      'com.docker.compose.project.config_files': '/tmp/unrelated.yml, /home/gewu/work/geneway/scripts/backup-restore/docker-compose.yml',
      'com.docker.compose.project.working_dir': '/home/gewu/work/geneway/scripts/backup-restore',
    })).toBe(true);
    expect(isRepositoryDockerScope('scripts_default', {
      'com.docker.compose.project': 'scripts',
    })).toBe(true);
    expect(isRepositoryDockerScope('backup-restore_postgres_data', {
      'com.docker.compose.project': 'backup-restore',
    })).toBe(true);
    expect(isRepositoryDockerScope('scripts_default')).toBe(true);
    expect(isRepositoryDockerScope('backup-restore_versity_data')).toBe(true);
    expect(isRepositoryDockerScope('scripts-copy_default', {
      'com.docker.compose.project': 'scripts-copy',
    })).toBe(false);
    expect(isRepositoryDockerScope('backup-restore-copy_postgres_data')).toBe(false);
    expect(isRepositoryDockerScope('unrelated-postgres-1', {
      'com.docker.compose.project.working_dir': '/tmp/unrelated',
    })).toBe(false);
    expect(isRepositoryDockerScope('gearjob-postgres-1', {
      'com.docker.compose.project.config_files': '/home/gewu/work/gearjob/deploy/docker-compose.yml,-',
      'com.docker.compose.project.working_dir': '/home/gewu/work/gearjob/deploy',
    })).toBe(false);
    expect(isRepositoryDockerScope('relative-postgres-1', {
      'com.docker.compose.project.config_files': 'scripts/docker-compose.yml, -, ',
      'com.docker.compose.project.working_dir': 'scripts',
    })).toBe(false);
  });

  it('independently parses raw backup guard identities, reloads, attempts, and violations', () => {
    const id = 'abcdef1234567890';
    const raw = [
      'START pid=1 startTicks=42 hostname=abcdef123456',
      'START pid=1 startTicks=42 hostname=abcdef123456',
      'ALLOW call=connect family=2 address=127.0.0.1 port=3100',
    ].join('\n');
    expect(parseBackupRawReceipt(raw, id, 'online', 'open', ['3100'])).toMatchObject({
      passed: true, reloadCount: 1, unknownLines: [], unexpected: [],
    });
    expect(parseBackupRawReceipt(`${raw}\nDENY call=connect family=2 address=127.0.0.2 port=3100`, id, 'online', 'open', ['3100']).passed).toBe(false);
    expect(parseBackupRawReceipt(`${raw}\nUNKNOWN payload`, id, 'online', 'open', ['3100']).passed).toBe(false);
  });

  it('rejects unbounded or scalar artifact roots', () => {
    expect(() => validateArtifactRoots('/tmp/geneway-runs/x')).toThrow('must be an array');
    expect(() => validateArtifactRoots(['/tmp/geneway-runs'])).toThrow('outside the bounded');
    expect(() => validateArtifactRoots(['/tmp/geneway-runs/x/../..'])).toThrow('outside the bounded');
    expect(validateArtifactRoots(['/tmp/geneway-runs/x', '/tmp/geneway-runs/x/child'])).toEqual(['/tmp/geneway-runs/x']);
  });

  it('parses listener and established socket columns without treating loopback peers as egress', () => {
    expect(parseSocketLine('LISTEN 0 511 127.0.0.1:35927 0.0.0.0:* users:(("node",pid=2185374,fd=21))', 'listener')).toEqual({
      local: '127.0.0.1:35927', peer: '0.0.0.0:*', pids: [2185374],
    });
    expect(parseSocketLine('0 0 127.0.0.1:35927 127.0.0.1:49220 users:(("node",pid=2185374,fd=22))', 'egress')).toEqual({
      local: '127.0.0.1:35927', peer: '127.0.0.1:49220', pids: [2185374],
    });
  });

  it('fails closed on source drift or any child failure', () => {
    const binding = { head: 'head', workspaceSha256: 'digest', fileCount: 1 };
    expect(sourceBindingsMatch(binding, binding)).toBe(true);
    expect(sourceBindingsMatch(binding, { ...binding, workspaceSha256: 'drift' })).toBe(false);
    expect(gate02bAggregatePassed({
      results: successfulResults,
      sourceStable: false,
      cleanupReceipts: [cleanReceipt, ...requiredGate02bSteps.map(() => cleanReceipt)],
      childEvidencePassed: true,
      secretReceiptsPassed: true,
    })).toBe(false);
    expect(gate02bAggregatePassed({
      results: successfulResults.map((result, index) => index === 3 ? { status: 1, signal: null } : result),
      sourceStable: true,
      cleanupReceipts: [cleanReceipt, ...requiredGate02bSteps.map(() => cleanReceipt)],
      childEvidencePassed: true,
      secretReceiptsPassed: true,
    })).toBe(false);
  });

  it('fails closed when cleanup or child evidence receipts are missing', () => {
    expect(validateCleanupReceipt(cleanReceipt)).toBe(true);
    expect(() => validateCleanupReceipt({ ...cleanReceipt, listeners: undefined })).toThrow('listeners');
    expect(gate02bAggregatePassed({
      results: successfulResults,
      sourceStable: true,
      cleanupReceipts: [cleanReceipt, ...requiredGate02bSteps.map(() => cleanReceipt)],
      childEvidencePassed: false,
      secretReceiptsPassed: true,
    })).toBe(false);
    expect(gate02bAggregatePassed({
      results: successfulResults,
      sourceStable: true,
      cleanupReceipts: [],
      childEvidencePassed: true,
      secretReceiptsPassed: true,
    })).toBe(false);
    expect(gate02bAggregatePassed({
      results: successfulResults,
      sourceStable: true,
      cleanupReceipts: [cleanReceipt, ...requiredGate02bSteps.map(() => cleanReceipt)],
      childEvidencePassed: true,
      secretReceiptsPassed: false,
    })).toBe(false);
  });
});
