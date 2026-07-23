import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isVisiblePersistedStreamingCheckpoint } from './e2e/gate-a0-chat-observability.js';
import { modelGatewayWorkerEnvironment } from './e2e/model-gateway-worker-environment.js';

interface GateStep { phase: string; name: string; command: readonly string[]; inheritRunId?: boolean;
  expectedWithStorageInvocations?: number; expectedStorageInvocations?: number;
  expectedE2eInvocations?: number; expectedBackupCases?: number }
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
  isInternalDockerAdapterListener: (line: string, context: { gatewayAddresses: string[]; interfaceNames: string[] },
    commandLines: ReadonlyMap<number, string> | Readonly<Record<string, string>>) => boolean;
  internalDockerListenerBinding: (policy: unknown, container: unknown, network: unknown,
    bridgeSnapshot: unknown, memberLinks: unknown) => { gatewayAddresses: string[]; interfaceNames: string[] } | null;
  isGateAuthorityPath: (path: string) => boolean;
  isRepositoryDockerScope: (name: string, labels?: Readonly<Record<string, string>>) => boolean;
  dockerStructuralIsolationReceipt: (state: unknown, backupRunIds?: string[], proxyRoots?: string[], expectation?: unknown) => {
    passed: boolean; violations: string[];
  };
  parseSocketLine: (line: string, kind: 'listener' | 'egress') => { local: string; peer: string; pids: number[] };
  parseProcNetSockets: (text: string, protocol: string) => Array<{ protocol: string; remoteAddress: string; remotePort: number; state: string }>;
  procNetReadErrorIsExitRace: (errorCode: string, expectedStartTicks: string,
    identity: { status: string; state?: string; startTicks?: string }) => boolean;
  parseBackupRawReceipt: (raw: string, containerId: string, role: string, action: string, allowedPorts: readonly string[],
    allowedUnix?: readonly string[]) => {
    passed: boolean; reloadCount: number; unknownLines: string[]; unexpected: string[];
  };
  proxyTargetBindingMatches: (policy: unknown, container: unknown, network: unknown) => boolean;
  proxyPolicyPathFromCommandLine: (commandLine: string) => string | null;
  networkAttachmentsAfterInspect: (previous: unknown[], container: unknown) => unknown[];
  validateProxyPolicy: (policy: unknown, expectedRoot: string) => unknown;
  validateProxyInventory: (inventory: string[]) => string[];
  validateProxyIdentityChain: (policy: unknown, ready: unknown, summary: unknown) => boolean;
  validateProxyRawReceipt: (policy: unknown, summary: unknown, raw: string, attempts?: string) => boolean;
  validateGate02bInvocationTopology: (packageScripts: Readonly<Record<string, string>>, steps: readonly GateStep[],
    nestedSources?: Readonly<Record<string, string>>) => readonly unknown[];
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
  internalDockerListenerBinding, isForbiddenRuntimeCommandLine, isGateAuthorityPath, isInternalDockerAdapterListener,
  isRepositoryDockerScope, parseBackupRawReceipt, parseProcNetSockets, parseSocketLine, proxyPolicyPathFromCommandLine,
  networkAttachmentsAfterInspect, procNetReadErrorIsExitRace, proxyTargetBindingMatches, requiredGate02bSteps,
  sourceBindingsMatch, validateArtifactRoots, validateCleanupReceipt, validateGate02bCommandSafety,
  validateDockerIsolationCommandSafety, validateDockerStructuralIsolationReceipt, validateGate02bStepPlan,
  validateGate02bInvocationTopology, validateProcessLifecycleReceipt, validateProxyIdentityChain, validateProxyInventory, validateProxyPolicy,
  validateProxyRawReceipt,
// @ts-expect-error The executable is native ESM; this test supplies its complete public contract above.
} = await import('./verify-gate0.2b.mjs') as unknown as Gate02bModule;
// @ts-expect-error The executable is native ESM; this test consumes its exported pure invocation builder.
const { controlledDockerInvocation } = await import('./gate02b-loopback-proxy.mjs') as unknown as {
  controlledDockerInvocation: (args: string[], configPath: string) => {
    command: string; args: string[]; options: { timeout: number; killSignal: string; env: Record<string, string | undefined> };
  };
};

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
    for (const name of ['GENEWAY_GATE02B_EGRESS_GUARD', 'GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY',
      'GENEWAY_GATE02B_PROXY_RUN_ROOT', 'GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL',
      'GENEWAY_GATE02B_COMPOSE_STORAGE_INTERNAL']) expect(runner).toContain(name);
    expect(runner).toContain('Gate 0.2B E2E environment tuple is incomplete');
    const partial = spawnSync(process.execPath, ['scripts/run-e2e.mjs'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GENEWAY_GATE02B_EGRESS_GUARD: 'required' },
    });
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain('Gate 0.2B E2E environment tuple is incomplete');
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
    expect(requiredGate02bSteps.slice(6).map((step) => [step.name, step.expectedWithStorageInvocations,
      step.expectedStorageInvocations, step.expectedE2eInvocations, step.expectedBackupCases ?? 0])).toEqual([
      ['integration', 1, 1, 0, 0], ['security', 1, 1, 0, 0], ['gate0.2b.2', 4, 2, 2, 0],
      ['gate0.2b.3', 16, 7, 9, 3], ['gate0.2a-baseline', 7, 3, 4, 3],
      ['gate0.2b.1-baseline', 3, 2, 1, 0], ['local-a0-no-business-objects', 1, 0, 1, 0],
    ]);
    const metadataDrift = requiredGate02bSteps.map((step) => ({ ...step }));
    metadataDrift[8] = { ...metadataDrift[8]!, expectedWithStorageInvocations: 3 };
    expect(() => validateGate02bStepPlan(metadataDrift)).toThrow('membership or order');
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

  it('derives the 33 storage invocations and six backup cases from the executable call graph', async () => {
    const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const nestedPath = 'scripts/verify-gate0.2b.3.mjs';
    const nestedSource = await readFile(new URL('./verify-gate0.2b.3.mjs', import.meta.url), 'utf8');
    const topology = validateGate02bInvocationTopology(packageManifest.scripts, requiredGate02bSteps,
      { [nestedPath]: nestedSource }) as Array<{ withStorage: number; backupCases: number }>;
    expect(topology.reduce((sum, item) => sum + item.withStorage, 0)).toBe(33);
    expect(topology.reduce((sum, item) => sum + item.backupCases, 0)).toBe(6);
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
    const proxyRunner = await readFile(new URL('./gate02b-loopback-proxy.mjs', import.meta.url), 'utf8');
    const e2eRunner = await readFile(new URL('./run-e2e.mjs', import.meta.url), 'utf8');
    const guard = await readFile(new URL('./backup-restore/gate02b-egress-guard.c', import.meta.url), 'utf8');
    const verifier = await readFile(new URL('./verify-gate0.2b.mjs', import.meta.url), 'utf8');
    expect(compose).toContain('internal: ${GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL:-false}');
    expect(compose).toContain('internal: ${GENEWAY_GATE02B_COMPOSE_STORAGE_INTERNAL:-true}');
    expect(backupCompose).toContain('internal: ${GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL:-false}');
    expect(backupRunner).toContain("gate02bGuardRequired ? ['--pull', 'never'] : []");
    expect(backupRunner).toContain('Gate 0.2B required offline role image is missing');
    expect(backupRunner).toContain("child.stdin.end('shutdown\\n')");
    expect(backupRunner).toContain("{ controlPipe: true }");
    expect(backupRunner).toContain('ignored its private shutdown pipe');
    expect(backupRunner).toContain('children.set(child, { controlPipe: options.controlPipe === true })');
    expect(backupRunner).toContain('if (lifecycle.controlPipe) {');
    expect(backupRunner).toContain('abandonUnresponsiveControlPipeChild(child)');
    expect(backupRunner).toContain('control-pipe-process-remains');
    expect(storageRunner).toContain('if [[ "${GENEWAY_GATE02B_EGRESS_GUARD:-}" == "required" ]]');
    expect(storageRunner.match(/"\$\{pull_policy\[@\]\}"/gu)).toHaveLength(3);
    expect(storageRunner).toContain("schemaVersion: 'geneway-gate02b-storage-invocation/1'");
    expect(storageRunner).toContain("writeFileSync(env.GENEWAY_INVOCATION_PATH");
    expect(storageRunner.indexOf('writeFileSync(env.GENEWAY_INVOCATION_PATH')).toBeLessThan(storageRunner.indexOf('up -d --wait'));
    expect(proxyRunner).toContain("['--host', localDockerHost, ...args]");
    expect(proxyRunner).toContain("timeout: 2_000");
    expect(proxyRunner).toContain("DOCKER_CONFIG: configPath");
    expect(proxyRunner).not.toContain('DOCKER_CONTEXT:');
    expect(e2eRunner).toContain("JSON.stringify({ parentRunId, forwarded, selectedProjects })");
    expect(e2eRunner).toContain('const runId = gate02bGuarded');
    expect(e2eRunner).toContain('parentRunId,\n    forwarded,\n    selectedProjects,');
    expect(verifier).toContain("['cc', '-std=gnu17', '-shared', '-fPIC'");
    for (const call of ['connect(', 'sendto(', 'sendmsg(', 'sendmmsg(']) expect(guard).toContain(call);
    expect(guard).toContain('== 0x7f000001U');
    expect(guard).toContain('offsetof(struct sockaddr_un, sun_path)');
    expect(guard).toContain('GENEWAY_GATE02B_EGRESS_ALLOWED_TARGET_IPV4');
    expect(guard).toContain('GENEWAY_GATE02B_EGRESS_ALLOWED_TARGET_PORT');
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
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    });
    const child = childEnvironment('contract-run', requiredGate02bSteps[0]!);
    expect(child.dockerIsolationEnvironment).toMatchObject(gate02bDockerIsolationEnvironment);
    expect(child.dockerIsolationEnvironment.GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY).toContain('/tmp/geneway-runs/contract/');
    expect(child.environment).toMatchObject(gate02bDockerIsolationEnvironment);
    expect(child.environment.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
    const v7WithoutRunId = childEnvironment('contract-run', requiredGate02bSteps.find((step) => step.name === 'gate0.2a-baseline')!);
    expect(v7WithoutRunId.environment.GENEWAY_RUN_ID).toBeUndefined();
    expect(v7WithoutRunId.environment.GENEWAY_GATE02B_PROXY_RUN_ROOT).toBe(
      '/tmp/geneway-runs/contract-run-v7-gate0.2a-baseline-proxies',
    );
    expect(validateDockerIsolationCommandSafety(['pnpm test:integration'])).toBe(true);
    expect(() => validateDockerIsolationCommandSafety(['GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL=false pnpm test'])).toThrow(
      'override/removal',
    );
    expect(() => validateDockerIsolationCommandSafety(['env -u GENEWAY_GATE02B_COMPOSE_STORAGE_INTERNAL pnpm test'])).toThrow(
      'override/removal',
    );
  });

  it('shuts controllers down only through an unlinked private control pipe', async () => {
    const storageRunner = await readFile(new URL('./with-storage.sh', import.meta.url), 'utf8');
    const functionStart = storageRunner.indexOf('stop_proxies() {');
    const functionEnd = storageRunner.indexOf('\n\ncompose=(', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const probeRoot = await mkdtemp(join(tmpdir(), 'geneway-gate02b-control-pipe-'));
    try {
      const probe = spawnSync('bash', ['-c', `
set -uo pipefail
${storageRunner.slice(functionStart, functionEnd)}
fifo="$1/control"
mkfifo -m 0600 "$fifo"
bash -c 'IFS= read -r command; [[ "$command" == shutdown ]]' <"$fifo" &
controller=$!
exec {control_fd}>"$fifo"
unlink "$fifo"
for _ in $(seq 1 100); do
  controller_ppid="$(ps -o ppid= -p "$controller" | tr -d ' ')"
  [[ "$controller_ppid" == "$$" ]] && break
  sleep 0.01
done
proxy_pids=("$controller")
proxy_start_ticks=("$(awk '{print $22}' "/proc/$controller/stat")")
proxy_pgids=("$(ps -o pgid= -p "$controller" | tr -d ' ')")
proxy_sids=("$(ps -o sid= -p "$controller" | tr -d ' ')")
proxy_control_fds=("$control_fd")
proxy_logs=()
stop_proxies

fifo="$1/already-exited-control"
mkfifo -m 0600 "$fifo"
bash -c ':' <"$fifo" &
exited_controller=$!
exec {closed_control_fd}>"$fifo"
unlink "$fifo"
wait "$exited_controller"
proxy_pids=("$exited_controller")
proxy_start_ticks=('1')
proxy_pgids=('1')
proxy_sids=('1')
proxy_control_fds=("$closed_control_fd")
proxy_logs=()
set +e
stop_proxies
closed_status=$?
set -e
[[ "$closed_status" -eq 1 ]]
`, 'gate02b-control-pipe-probe', probeRoot], { encoding: 'utf8', timeout: 15_000 });
      expect(probe.status, `${probe.stdout}\n${probe.stderr}\n${String(probe.error)} signal=${String(probe.signal)}`).toBe(0);
      expect(storageRunner).toContain('mkfifo -m 0600 "$control_fifo"');
      expect(storageRunner).toContain('unlink "$control_fifo"');
      expect(storageRunner).toContain("printf 'shutdown\\n' >&\"$control_fd\"");
      expect(storageRunner).not.toMatch(/kill -(?:TERM|KILL)/u);
      expect(storageRunner).not.toContain('signal_verified_controller');
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  });

  it('abandons an unresponsive backup proxy without a numeric signal fallback', async () => {
    const backupRunner = await readFile(new URL('./run-backup-restore.mjs', import.meta.url), 'utf8');
    const functionStart = backupRunner.indexOf('function abandonUnresponsiveControlPipeChild(child) {');
    const functionEnd = backupRunner.indexOf('\n\nfunction isolatedRoleMounts', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
${backupRunner.slice(functionStart, functionEnd)}
const calls = [];
const stream = (name) => ({ destroy: () => calls.push(name) });
abandonUnresponsiveControlPipeChild({ stdin: stream('stdin'), stdout: stream('stdout'), stderr: stream('stderr'),
  unref: () => calls.push('unref') });
if (JSON.stringify(calls) !== JSON.stringify(['stdin','stdout','stderr','unref'])) process.exit(1);
`], { encoding: 'utf8', timeout: 5_000 });
    expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
    const branchStart = backupRunner.indexOf('if (lifecycle.controlPipe) {');
    const branchEnd = backupRunner.indexOf('\n      try {', branchStart);
    const controlPipeBranch = backupRunner.slice(branchStart, branchEnd);
    expect(controlPipeBranch).not.toContain('kill(');
    expect(controlPipeBranch).not.toContain('process.kill');
    expect(controlPipeBranch).toContain('children.delete(child)');
  });

  it('binds loopback proxy policy, Docker target and raw receipt exactly', () => {
    const runRoot = '/tmp/geneway-runs/proxy-contract';
    const target = {
      containerId: 'a'.repeat(64), project: 'geneway-e2e-proxy-contract', service: 'postgres',
      networkName: 'geneway-e2e-proxy-contract_default', networkId: 'b'.repeat(64), networkInternal: true,
      ip: '172.30.0.2', port: 5432, containerPort: 5432,
    };
    const stem = `${target.project}-postgres`;
    const unhashedPolicy = { schemaVersion: 'geneway-gate02b-loopback-proxy/1', name: stem,
      dockerHost: 'unix:///var/run/docker.sock', dockerConfigPath: `${runRoot}/docker-client`,
      policyPath: `${runRoot}/loopback-proxies/${stem}.policy.json`,
      rawPath: `${runRoot}/loopback-proxies/${stem}.raw`, readyPath: `${runRoot}/loopback-proxies/${stem}.ready.json`,
      attemptsPath: `${runRoot}/loopback-proxies/${stem}.attempts.jsonl`,
      controller: { pid: 1, parentPid: 2, startTicks: '42', processGroupId: 1, sessionId: 1, hostname: 'host' },
      listen: { host: '127.0.0.1', port: 55433 }, target };
    const policy = { ...unhashedPolicy, policyHash: createHash('sha256').update(JSON.stringify(unhashedPolicy)).digest('hex') };
    expect(validateProxyPolicy(policy, runRoot)).toEqual(policy);
    const container = { Id: target.containerId, Config: { Labels: {
      'com.docker.compose.project': target.project, 'com.docker.compose.service': target.service,
    } }, NetworkSettings: { Networks: { [target.networkName]: { NetworkID: target.networkId, IPAddress: target.ip } } } };
    const network = { Id: target.networkId, Name: target.networkName, Internal: true,
      Labels: { 'com.docker.compose.project': target.project } };
    expect(proxyTargetBindingMatches(policy, container, network)).toBe(true);
    expect(proxyTargetBindingMatches(policy, { ...container, Id: 'c'.repeat(64) }, network)).toBe(false);
    expect(proxyTargetBindingMatches(policy, container, { ...network, Internal: false })).toBe(false);
    expect(proxyTargetBindingMatches(policy, container, { ...network,
      Labels: { 'com.docker.compose.project': 'geneway-e2e-wrong' } })).toBe(false);
    expect(proxyTargetBindingMatches({ ...policy, target: { ...target, port: 7070, containerPort: 7070 } }, container, network)).toBe(false);
    const raw = `START pid=1 startTicks=42 hostname=host\nALLOW attempt=1 call=connect family=2 address=${target.ip} port=5432\n`;
    const attempts = `${JSON.stringify({ seq: 1, schemaVersion: policy.schemaVersion, policyHash: policy.policyHash,
      serve: { pid: 1, startTicks: '42', hostname: 'host' }, binding: { ...target, running: true } })}\n`;
    const summary = { passed: true, rawSha256: createHash('sha256').update(raw).digest('hex'), rawLineCount: 2,
      attemptsSha256: createHash('sha256').update(attempts).digest('hex'), attemptLineCount: 1,
      denyLines: [], unknownLines: [],
      startIdentities: [{ pid: 1, startTicks: '42', hostname: 'host' }],
      readyIdentity: { pid: 1, startTicks: '42', hostname: 'host' },
      exit: { status: 0, signal: null } };
    expect(validateProxyRawReceipt(policy, summary, raw, attempts)).toBe(true);
    expect(validateProxyRawReceipt(policy, summary, `${raw}DENY call=connect family=2 address=8.8.8.8 port=53\n`, attempts)).toBe(false);
    expect(validateProxyRawReceipt(policy, summary, `${raw}UNKNOWN payload\n`, attempts)).toBe(false);
    expect(validateProxyRawReceipt(policy, summary, `START pid=1 startTicks=42 hostname=host\n${raw}`, attempts)).toBe(false);
    expect(validateProxyRawReceipt(policy, summary, raw.replace('family=2', 'family=10'), attempts)).toBe(false);
    expect(validateProxyRawReceipt(policy, summary, raw.replace('call=connect', 'call=sendmsg'), attempts)).toBe(false);
    expect(validateProxyRawReceipt(policy, summary, raw, `${attempts}${attempts}`)).toBe(false);
    const receiptFor = (attemptText: string, rawText = raw) => ({ ...summary,
      rawSha256: createHash('sha256').update(rawText).digest('hex'),
      rawLineCount: rawText.trim().split('\n').filter(Boolean).length,
      attemptsSha256: createHash('sha256').update(attemptText).digest('hex'),
      attemptLineCount: attemptText.trim().split('\n').filter(Boolean).length,
    });
    const attemptObject = JSON.parse(attempts) as Record<string, unknown>;
    for (const invalid of [
      { ...attemptObject, seq: 0 }, { ...attemptObject, seq: 2 },
      { ...attemptObject, seq: Number.MAX_SAFE_INTEGER + 1 },
      { ...attemptObject, schemaVersion: 'wrong' },
      { ...attemptObject, serve: { pid: 1, startTicks: '42', hostname: 'wrong' } },
      { ...attemptObject, serve: { pid: 1, startTicks: '42', hostname: 'host', extra: true } },
      { ...attemptObject, extra: true },
    ]) {
      const text = `${JSON.stringify(invalid)}\n`;
      expect(validateProxyRawReceipt(policy, receiptFor(text), raw, text)).toBe(false);
    }
    const nonCanonical = attempts.replace('"seq":1', '"seq": 1');
    expect(validateProxyRawReceipt(policy, receiptFor(nonCanonical), raw, nonCanonical)).toBe(false);
    const rawLeadingZero = raw.replace('attempt=1', 'attempt=01');
    expect(validateProxyRawReceipt(policy, receiptFor(attempts, rawLeadingZero), rawLeadingZero, attempts)).toBe(false);
    const connectedBeforeAttempt = `START pid=1 startTicks=42 hostname=host\nALLOW call=sendmsg family=CONNECTED\n${raw.split('\n')[1]}\n`;
    expect(validateProxyRawReceipt(policy, receiptFor(attempts, connectedBeforeAttempt), connectedBeforeAttempt, attempts)).toBe(false);
    expect(validateProxyRawReceipt(policy, { ...summary, readyIdentity: { pid: 2, startTicks: '42', hostname: 'host' } }, raw, attempts)).toBe(false);
    const ready = { schemaVersion: policy.schemaVersion, policyPath: policy.policyPath, policyHash: policy.policyHash,
      pid: 1, startTicks: '42', hostname: 'host' };
    const identitySummary = { readyIdentity: ready, stdoutReady: { ready: true, ...ready },
      spawnIdentity: { pid: 1, startTicks: '42', hostname: 'host' } };
    expect(validateProxyIdentityChain(policy, ready, identitySummary)).toBe(true);
    expect(validateProxyIdentityChain(policy, ready, { ...identitySummary,
      stdoutReady: { ...identitySummary.stdoutReady, pid: 2 } })).toBe(false);
    expect(validateProxyIdentityChain(policy, ready, { ...identitySummary,
      spawnIdentity: { ...identitySummary.spawnIdentity, startTicks: '43' } })).toBe(false);
    expect(() => validateProxyPolicy({ ...policy, policyPath: '/tmp/escape.policy.json' }, runRoot)).toThrow('unsafe');
    expect(proxyPolicyPathFromCommandLine(
      `node /home/gewu/work/geneway/scripts/gate02b-loopback-proxy.mjs --serve ${policy.policyPath}`,
    )).toBe(policy.policyPath);
    expect(proxyPolicyPathFromCommandLine(`node scripts/not-proxy.mjs --serve ${policy.policyPath}`)).toBeNull();
    expect(proxyPolicyPathFromCommandLine(
      `node /home/gewu/work/geneway/scripts/gate02b-loopback-proxy.mjs --serve ${policy.policyPath} extra`,
    )).toBeNull();
    const files = (stem: string) => [`${stem}.policy.json`, `${stem}.raw`, `${stem}.ready.json`,
      `${stem}.attempts.jsonl`, `${stem}.json`, `${stem}.controller.log`];
    const twoProjects = [...files('geneway-e2e-one-postgres'), ...files('geneway-e2e-two-postgres')];
    expect(validateProxyInventory(twoProjects)).toEqual([
      'geneway-e2e-one-postgres.policy.json', 'geneway-e2e-two-postgres.policy.json',
    ]);
    expect(() => validateProxyInventory(twoProjects.slice(1))).toThrow('incomplete');
    expect(() => validateProxyInventory([...twoProjects, 'orphan.raw'])).toThrow('orphan');
    const backupFiles = files('geneway-br-source-abcdef123456-postgres').filter((name) => !name.endsWith('.controller.log'));
    expect(validateProxyInventory(backupFiles)).toEqual(['geneway-br-source-abcdef123456-postgres.policy.json']);
    expect(() => validateProxyInventory([...backupFiles, 'geneway-br-source-abcdef123456-postgres.controller.log'])).toThrow('orphan');
  });

  it('pins every proxy Docker lookup to the local Unix daemon and an empty bounded client home', () => {
    const invocation = controlledDockerInvocation(['inspect', 'a'.repeat(64)], '/tmp/geneway-runs/proxy-contract/docker-client');
    expect(invocation.command).toBe('docker');
    expect(invocation.args).toEqual(['--host', 'unix:///var/run/docker.sock', 'inspect', 'a'.repeat(64)]);
    expect(invocation.options).toMatchObject({ timeout: 2_000, killSignal: 'SIGKILL' });
    expect(invocation.options.env).toMatchObject({
      HOME: '/tmp/geneway-runs/proxy-contract/docker-client',
      DOCKER_CONFIG: '/tmp/geneway-runs/proxy-contract/docker-client',
    });
    for (const ambient of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'SSH_AUTH_SOCK']) {
      expect(invocation.options.env).not.toHaveProperty(ambient);
    }
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
    expect(dockerStructuralIsolationReceipt({ ...cleanState, monitorExit: { status: 0, signal: null } }, [], [],
      { expectedWithStorageInvocations: 1 }).passed).toBe(false);
  });

  it('requires exact structured backup child run membership', () => {
    const runs = ['success', 'missing-object', 'manifest-mismatch'].map((name, index) => {
      const runId = `backup-restore-suite-${name}-123-${String(index)}`;
      const projectSuffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
      return { schemaVersion: 'geneway-backup-restore-summary/1', case: name, runId,
        projectSuffix, sourceProject: `geneway-br-source-${projectSuffix}`,
        targetProject: `geneway-br-target-${projectSuffix}`, exitCode: name === 'success' ? 0 : 1,
        outcome: name === 'success' ? 'passed' : 'expected-integrity-failure',
        artifactRoot: `/tmp/geneway-runs/${runId}/backup-restore` };
    });
    const log = `${JSON.stringify({ outcome: 'passed', results: [
      ...runs,
    ] })}\n`;
    expect(extractStructuredBackupRunIds(log, true)).toEqual(runs.map((item) => item.runId));
    expect(() => extractStructuredBackupRunIds('{"outcome":"passed","results":[]}\n', true)).toThrow('missing or duplicated');
    expect(() => extractStructuredBackupRunIds(`${log}${log}`, true)).toThrow('missing or duplicated');
    expect(() => extractStructuredBackupRunIds(JSON.stringify({ outcome: 'passed', results: [
      runs[1], runs[0], runs[2],
    ] }), true)).toThrow('invalid for success');
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
    const hostname = 'abcdef123456';
    const raw = [
      'START pid=1 startTicks=42 hostname=abcdef123456',
      'START pid=1 startTicks=42 hostname=abcdef123456',
      'ALLOW call=connect family=2 address=127.0.0.1 port=3100',
    ].join('\n');
    expect(parseBackupRawReceipt(raw, hostname, 'online', 'open', ['3100'])).toMatchObject({
      passed: true, reloadCount: 1, unknownLines: [], unexpected: [],
    });
    expect(parseBackupRawReceipt(`${raw}\nALLOW call=connect family=AF_UNIX path=/tmp/tsx-1000/18.pipe`,
      hostname, 'online', 'open', ['3100'], ['tsx-pipe:/tmp/tsx-1000']).passed).toBe(true);
    expect(parseBackupRawReceipt(`${raw}\nALLOW call=connect family=AF_UNIX path=/var/run/docker.sock`,
      hostname, 'online', 'open', ['3100'], ['tsx-pipe:/tmp/tsx-1000']).passed).toBe(false);
    expect(parseBackupRawReceipt(`${raw}\nDENY call=connect family=2 address=127.0.0.2 port=3100`, hostname, 'online', 'open', ['3100']).passed).toBe(false);
    expect(parseBackupRawReceipt(`${raw}\nUNKNOWN payload`, hostname, 'online', 'open', ['3100']).passed).toBe(false);
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

  it('normalizes IPv4-mapped IPv6 container peers before internal-subnet checks', () => {
    const procNet = [
      'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode',
      '0: 00000000000000000000000000000000:0000 0000000000000000FFFF00000460A8C0:E5AA 01 0:0 0:0 0 0 0',
    ].join('\n');
    expect(parseProcNetSockets(procNet, 'tcp6')).toEqual([
      { protocol: 'tcp6', remoteAddress: '192.168.96.4', remotePort: 58_794, state: '01' },
    ]);
  });

  it('ignores a proc-net ENOENT only after the original process identity is proven gone', () => {
    expect(procNetReadErrorIsExitRace('ENOENT', '42', { status: 'missing' })).toBe(true);
    expect(procNetReadErrorIsExitRace('ENOENT', '42', { status: 'present', state: 'Z', startTicks: '42' })).toBe(true);
    expect(procNetReadErrorIsExitRace('ENOENT', '42', { status: 'present', state: 'S', startTicks: '43' })).toBe(true);
    expect(procNetReadErrorIsExitRace('ENOENT', '42', { status: 'present', state: 'S', startTicks: '42' })).toBe(false);
    expect(procNetReadErrorIsExitRace('ENOENT', '42', { status: 'error' })).toBe(false);
    expect(procNetReadErrorIsExitRace('EACCES', '42', { status: 'missing' })).toBe(false);
    expect(procNetReadErrorIsExitRace('ENOENT', '', { status: 'missing' })).toBe(false);
  });

  it('retains the last inspected network attachments when a later inspect disappears', () => {
    const attachments = networkAttachmentsAfterInspect([], { NetworkSettings: { Networks: {
      'geneway-storage-test_storage': { NetworkID: 'network-id', IPAddress: '192.168.96.4' },
    } } });
    expect(attachments).toEqual([
      { name: 'geneway-storage-test_storage', id: 'network-id', ip: '192.168.96.4' },
    ]);
    expect(networkAttachmentsAfterInspect(attachments, undefined)).toBe(attachments);
  });

  it('exempts only exact rygel listeners on interfaces proven to belong to current internal Docker networks', () => {
    const context = { gatewayAddresses: ['192.168.96.1'], interfaceNames: ['br-f093b06b9760', 'veth7783ad3'] };
    const commands = new Map([[2448240, '/usr/bin/rygel']]);
    expect(isInternalDockerAdapterListener('192.168.96.1:48343 pids=2448240', context, commands)).toBe(true);
    expect(isInternalDockerAdapterListener(
      '[fe80::109b:abff:fe5d:ef7b]%veth7783ad3:58346 pids=2448240', context, commands,
    )).toBe(true);
    for (const line of [
      '192.168.0.104:48343 pids=2448240',
      '0.0.0.0:48343 pids=2448240',
      '192.168.96.1:3150 pids=2448240',
      '192.168.96.1:3450 pids=2448240',
      '[fe80::1]%wlp129s0f0:58346 pids=2448240',
      '192.168.96.1:48343 pids=2448240,2448241',
    ]) expect(isInternalDockerAdapterListener(line, context, commands)).toBe(false);
    expect(isInternalDockerAdapterListener('192.168.96.1:48343 pids=2448240', context,
      new Map([[2448240, '/usr/bin/not-rygel']]))).toBe(false);
    expect(isInternalDockerAdapterListener('192.168.96.1:48343 pids=2448240', context,
      new Map([[2448240, '/usr/bin/rygel --flag']]))).toBe(false);
  });

  it('derives the rygel exception context only from an exact live internal bridge binding', () => {
    const project = 'geneway-storage-test';
    const networkId = 'f'.repeat(64);
    const networkName = `${project}_storage`;
    const bridgeName = `br-${networkId.slice(0, 12)}`;
    const policy = { target: { project, service: 'versitygw', port: 7070, containerPort: 7070,
      containerId: 'a'.repeat(64), networkId, networkName, ip: '192.168.96.4' } };
    const container = { Id: policy.target.containerId, Config: { Labels: {
      'com.docker.compose.project': project, 'com.docker.compose.service': 'versitygw',
    } }, NetworkSettings: { Networks: { [networkName]: { NetworkID: networkId, IPAddress: policy.target.ip } } } };
    const network = { Id: networkId, Name: networkName, Internal: true, Driver: 'bridge',
      Labels: { 'com.docker.compose.project': project }, IPAM: { Config: [{ Gateway: '192.168.96.1' }] } };
    const bridge = [{ ifname: bridgeName }];
    const members = [{ ifname: 'veth7783ad3', master: bridgeName }];
    expect(internalDockerListenerBinding(policy, container, network, bridge, members)).toEqual({
      gatewayAddresses: ['192.168.96.1'], interfaceNames: [bridgeName, 'veth7783ad3'].sort(),
    });
    const invalidBindings: Array<[unknown, unknown, unknown, unknown, unknown]> = [
      [{ target: { ...policy.target, containerId: 'b'.repeat(64) } }, container, network, bridge, members],
      [policy, undefined, network, bridge, members],
      [policy, container, { ...network, Internal: false }, bridge, members],
      [policy, container, { ...network, Driver: 'overlay' }, bridge, members],
      [policy, container, network, [], members],
      [policy, container, network, bridge, []],
      [policy, container, network, bridge, [{ ifname: 'veth7783ad3', master: 'docker0' }]],
      [policy, container, { ...network, IPAM: { Config: [] } }, bridge, members],
    ];
    for (const args of invalidBindings) {
      expect(internalDockerListenerBinding(args[0], args[1], args[2], args[3], args[4])).toBeNull();
    }
  });

  it('keeps provisioner containers inspectable until the bounded Compose cleanup', async () => {
    const source = await readFile(new URL('./with-storage.sh', import.meta.url), 'utf8');
    expect(source).not.toContain('run --rm -T storage-provisioner');
    expect(source.match(/run -T storage-provisioner/gu)).toHaveLength(2);
    expect(source.match(/\[\[ "\$state" != Z\*/gu)).toHaveLength(3);
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
