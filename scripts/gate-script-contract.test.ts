import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  backupContainerBoundaryReceipts: (expectedRunIds: string[]) => unknown[];
  backupInvocationManifests: (runRoot: string, expectedRunIds?: string[], enforceExpectedCardinality?: boolean) => unknown[];
  childEnvironment: (runId: string, step: GateStep) => { environment: Readonly<Record<string, string>>; dockerIsolationEnvironment: Readonly<Record<string, string>> };
  collectReachableCommandStrings: (scripts: Readonly<Record<string, string>>, roots: readonly string[], sources?: Readonly<Record<string, string>>) => string[];
  extractNestedVerifierCommands: (source: string) => string[];
  extractStructuredBackupRunIds: (log: string, required: boolean) => string[];
  exactDockerEventTimeNano: (rawLine: string, event?: Readonly<Record<string, unknown>>) => string | null;
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
    passed: boolean; violations: string[]; observedContainers: Array<Record<string, unknown>>;
  };
  parseSocketLine: (line: string, kind: 'listener' | 'egress') => { local: string; peer: string; pids: number[] };
  parseOwnerlessAmbientEnvelope: (line: string) => { family: string; endpoint: string; uid: number;
    socketInode: string; sk: string; cgroup: string } | null;
  parseProcNetSockets: (text: string, protocol: string) => Array<{ protocol: string; remoteAddress: string; remotePort: number; state: string }>;
  parseBackupRawReceipt: (raw: string, containerId: string, role: string, action: string, allowedPorts: readonly string[],
    allowedUnix?: readonly string[]) => {
    passed: boolean; reloadCount: number; unknownLines: string[]; unexpected: string[];
  };
  proxyTargetBindingMatches: (policy: unknown, container: unknown, network: unknown) => boolean;
  promoteProxyNetworkEvidence: (state: { networks: Map<string, Record<string, unknown>>; lifecycleEvents: unknown[] },
    receipts: unknown[]) => void;
  publishedPortsAfterInspect: (previous: unknown[], container: unknown) => unknown[];
  proxyPolicyPathFromCommandLine: (commandLine: string) => string | null;
  networkAttachmentsAfterInspect: (previous: unknown[], container: unknown) => unknown[];
  observedDockerContainer: (containers: ReadonlyMap<string, { id: string; name: string }>, observedId: string,
    name?: string) => { id: string; name: string } | undefined;
  ownerlessEnvelopeMatchesReleasedProof: (receipt: unknown, state: unknown) => boolean;
  readProcNetSnapshot: (path: string, pid: number, expectedStartTicks: string, dependencies: {
    read: (path: string) => string; observeIdentity: (pid: number) => { status: string; state?: string; startTicks?: string };
    observeNetworkNamespace?: (pid: number) => { status: string; identity?: string; failure?: unknown }; wait: () => void;
  }) => { text: string | null; failure: unknown; exited: boolean; released?: boolean; attempts: number };
  unresolvedUnsafeListeners: (observations: Array<{ sample: number; unsafe: string[]; validated: string[];
    unsafeSources?: { descendants?: string[] }; unsafeReceipts?: unknown[] }>, terminalStates?: unknown[],
    transientReleases?: unknown[]) => string[];
  unreachableCachedDockerNetworkContext: (network: {
    bridgeName: string; bridgeIdentity: { ifindex: number; address: string }; gatewayAddresses: Set<string>;
    memberIdentities: Map<string, { ifindex: number; address: string }>;
  }, liveLinks: Array<{ ifname: string; ifindex: number; address: string; addr_info?: Array<{ local?: string }> }>) => {
    gatewayAddresses: string[]; interfaceNames: string[];
  };
  stableProcessCommandLine: (pid: number, dependencies: {
    observeIdentity: (pid: number) => { status: string; state?: string; startTicks?: string };
    readCommandLine: (pid: number) => string | null; readExecutable: (pid: number) => string;
  }) => { commandLine: string; startTicks: string } | null;
  processIdentityMatchesProof: (proof: { commandLine: string; startTicks: string } | null,
    observation: { status: string; state?: string; startTicks?: string }) => boolean;
  storeObservedDockerContainer: (state: { containers: Map<string, { id: string; name: string }> },
    container: { id: string; name: string }) => void;
  validateProxyPolicy: (policy: unknown, expectedRoot: string) => unknown;
  validateProxyInventory: (inventory: string[]) => string[];
  validateProxyIdentityChain: (policy: unknown, identity: unknown, ready: unknown, summary: unknown) => boolean;
  validateProxyRawReceipt: (policy: unknown, summary: unknown, raw: string, attempts?: string) => boolean;
  validateGate02bInvocationTopology: (packageScripts: Readonly<Record<string, string>>, steps: readonly GateStep[],
    nestedSources?: Readonly<Record<string, string>>) => readonly unknown[];
  requiredGate02bSteps: readonly GateStep[];
  sourceBindingsMatch: (initial: Readonly<Record<string, unknown>>, final: Readonly<Record<string, unknown>>) => boolean;
  storageInvocationManifests: (runRoot: string, expectation?: {
    expectedWithStorageInvocations?: number; expectedStorageInvocations?: number;
    expectedE2eInvocations?: number; enforceExpectedCardinality?: boolean;
  }) => unknown[];
  validateArtifactRoots: (roots: unknown) => string[];
  validateCleanupReceipt: (receipt: unknown) => boolean;
  validateGate02bCommandSafety: (steps: readonly { command: readonly string[] }[]) => boolean;
  validateGate02bStepPlan: (steps: readonly GateStep[]) => boolean;
  validateDockerIsolationCommandSafety: (commands: readonly string[]) => boolean;
  validateDockerStructuralIsolationReceipt: (receipt: unknown) => boolean;
  validateProcessLifecycleReceipt: (receipt: unknown) => boolean;
}
const {
  backupArtifactRoots, backupContainerBoundaryReceipts, backupInvocationManifests, childEnvironment, collectReachableCommandStrings,
  dockerStructuralIsolationReceipt, extractNestedVerifierCommands,
  exactDockerEventTimeNano, extractStructuredBackupRunIds,
  findForbiddenEnvironmentNames, gate02bAggregatePassed, gate02bDockerIsolationEnvironment, gateAuthorityRootNames,
  internalDockerListenerBinding, isForbiddenRuntimeCommandLine, isGateAuthorityPath, isInternalDockerAdapterListener,
  isRepositoryDockerScope, parseBackupRawReceipt, parseOwnerlessAmbientEnvelope, parseProcNetSockets, parseSocketLine,
  proxyPolicyPathFromCommandLine,
  networkAttachmentsAfterInspect, observedDockerContainer, ownerlessEnvelopeMatchesReleasedProof, processIdentityMatchesProof,
  promoteProxyNetworkEvidence, proxyTargetBindingMatches, publishedPortsAfterInspect,
  readProcNetSnapshot, requiredGate02bSteps, unresolvedUnsafeListeners,
  stableProcessCommandLine, storeObservedDockerContainer, unreachableCachedDockerNetworkContext,
  sourceBindingsMatch, storageInvocationManifests, validateArtifactRoots, validateCleanupReceipt, validateGate02bCommandSafety,
  validateDockerIsolationCommandSafety, validateDockerStructuralIsolationReceipt, validateGate02bStepPlan,
  validateGate02bInvocationTopology, validateProcessLifecycleReceipt, validateProxyIdentityChain, validateProxyInventory, validateProxyPolicy,
  validateProxyRawReceipt,
// @ts-expect-error The executable is native ESM; this test supplies its complete public contract above.
} = await import('./verify-gate0.2b.mjs') as unknown as Gate02bModule;
// @ts-expect-error The executable is native ESM; this test consumes its exported pure invocation builder.
const { controlledDockerInvocation, validateProxyPolicy: validateLoopbackProxyPolicy } = await import('./gate02b-loopback-proxy.mjs') as unknown as {
  controlledDockerInvocation: (args: string[], configPath: string) => {
    command: string; args: string[]; options: { timeout: number; killSignal: string; env: Record<string, string | undefined> };
  };
  validateProxyPolicy: (policy: unknown, expectedRoot: string) => unknown;
};
// @ts-expect-error The executable helper is native ESM; this test consumes its pure identity function.
const { assertSecureRunDirectories, e2eProjectSelection, e2eRunIdentity } = await import('./e2e-run-identity.mjs') as unknown as {
  assertSecureRunDirectories: (paths: string[]) => void;
  e2eProjectSelection: (forwarded: string[]) => {
    selectedProjects: string[]; allProjects: boolean; gateALive: boolean; gateA0Live: boolean;
  };
  e2eRunIdentity: (parentRunId: string, forwarded: string[], guarded: boolean) => { runId: string; selectedProjects: string[] };
};
// @ts-expect-error The executable helper is native ESM; this test consumes its pure receipt parser.
const { parseBrowserEgressReceipt } = await import('./browser-egress-receipt.mjs') as unknown as {
  parseBrowserEgressReceipt: (raw: string, expected: { webPort: number; forbiddenPorts: number[]; policyHash: string;
    requireForbiddenDenials?: boolean; browserExecutableIdentities: Array<{ device: number; inode: number }>;
    guardLibraryDevice: number; guardLibraryInode: number }) => {
    passed: boolean; unknownLines: string[]; missingDeniedPorts: number[]; unexpectedAllows: string[];
    sharedNetworkIdentities: string[];
  };
};

describe('Gate 0.2A executable script contract', () => {
  it('shares the guarded served-run identity with parent evidence validators', () => {
    const parentRunId = 'gate0.2a-recovery-example';
    const forwarded = ['--project=gate0.2a-recovery-multiprocess'];
    const identityHash = createHash('sha256').update(JSON.stringify({
      parentRunId, forwarded, selectedProjects: ['gate0.2a-recovery-multiprocess'],
    })).digest('hex').slice(0, 16);
    expect(e2eRunIdentity(parentRunId, forwarded, true)).toEqual({
      runId: `${parentRunId}-gate0-2a-recovery-multiprocess-${identityHash}`,
      selectedProjects: ['gate0.2a-recovery-multiprocess'],
    });
    expect(e2eRunIdentity(parentRunId, forwarded, false).runId).toBe(parentRunId);
  });

  it('selects live harnesses from Playwright project semantics without burdening legacy projects', () => {
    expect(e2eProjectSelection([])).toEqual({
      selectedProjects: [], allProjects: true, gateALive: false, gateA0Live: false,
    });
    expect(e2eProjectSelection(['--project=gate-a-not-open'])).toEqual({
      selectedProjects: ['gate-a-not-open'], allProjects: false, gateALive: true, gateA0Live: true,
    });
    expect(e2eProjectSelection(['--project', 'gate-a-live'])).toEqual({
      selectedProjects: ['gate-a-live'], allProjects: false, gateALive: true, gateA0Live: true,
    });
    expect(e2eProjectSelection(['--project=gate-a-browser-egress'])).toEqual({
      selectedProjects: ['gate-a-browser-egress'], allProjects: false, gateALive: true, gateA0Live: true,
    });
    expect(e2eProjectSelection(['--project=gate-a-recovery'])).toEqual({
      selectedProjects: ['gate-a-recovery'], allProjects: false, gateALive: true, gateA0Live: true,
    });
    expect(e2eProjectSelection(['--project=gate-a0-live'])).toEqual({
      selectedProjects: ['gate-a0-live'], allProjects: false, gateALive: false, gateA0Live: true,
    });
    expect(e2eProjectSelection(['--project=gate0.2a-success'])).toEqual({
      selectedProjects: ['gate0.2a-success'], allProjects: false, gateALive: false, gateA0Live: false,
    });
  });

  it('rejects a symlink anywhere a recovery evidence directory is required', async () => {
    const root = await mkdtemp(join(tmpdir(), 'geneway-recovery-directory-'));
    try {
      const real = join(root, 'real');
      const linked = join(root, 'linked');
      await mkdir(real, { mode: 0o700 });
      await symlink(real, linked);
      expect(() => assertSecureRunDirectories([root, real])).not.toThrow();
      expect(() => assertSecureRunDirectories([root, linked])).toThrow('Run evidence directory is unsafe');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    const identityHelper = await readFile(new URL('./e2e-run-identity.mjs', import.meta.url), 'utf8');
    const recoveryRunner = await readFile(new URL('./test-recovery.mjs', import.meta.url), 'utf8');
    expect(runner).toContain('scripts/e2e-report-gate.ts');
    expect(runner).toContain('cleanupFailed || reportGateFailed');
    for (const name of ['GENEWAY_GATE02B_EGRESS_GUARD', 'GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY',
      'GENEWAY_GATE02B_PROXY_RUN_ROOT', 'GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL',
      'GENEWAY_GATE02B_COMPOSE_STORAGE_INTERNAL']) expect(`${runner}\n${identityHelper}`).toContain(name);
    expect(runner).toContain('Gate 0.2B E2E environment tuple is incomplete');
    expect(runner).toContain("schemaVersion: 'geneway-e2e-invocation-result/1'");
    expect(runner).toContain("{ flag: 'wx', mode: 0o600 }");
    expect(recoveryRunner).toContain('constants.O_RDONLY | constants.O_NOFOLLOW');
    expect(recoveryRunner).toContain('assertSecureRunDirectories([');
    expect(recoveryRunner).toContain("sourceBinding.parentRunId === requestedRunId");
    const partial = spawnSync(process.execPath, ['scripts/run-e2e.mjs'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GENEWAY_GATE02B_EGRESS_GUARD: 'required' },
    });
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain('Gate 0.2B E2E environment tuple is incomplete');
  });

  it('keeps Gate A public traces enabled without embedding credential-bearing test sources', async () => {
    const [servedConfig, lanConfig] = await Promise.all([
      readFile(new URL('./playwright.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('./playwright.lan.config.ts', import.meta.url), 'utf8'),
    ]);
    expect(servedConfig.match(/trace: \{ mode: 'on', sources: false \}/gu)).toHaveLength(4);
    expect(lanConfig).toContain("trace: { mode: 'on', sources: false }");
    expect(lanConfig).toContain("screenshot: 'only-on-failure'");
    expect(lanConfig).toContain("video: 'retain-on-failure'");
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

  it('binds a resumed Gate A release promotion to the exact additive A.1 then A.2 authority', async () => {
    const helper = await readFile(new URL('./e2e/start-gate-a-release.ts', import.meta.url), 'utf8');
    expect(helper).toContain('gateA2LiveValidationCandidateEvidenceSchema.parse');
    expect(helper).toContain('templateId: SOLUTION_LIVE_V2_TEMPLATE.templateId');
    expect(helper).toContain('expertCatalogDigest: digest(SOLUTION_LIVE_V2_EXPERT_REGISTRY)');
    expect(helper).toContain('availableExpertModes: SOLUTION_LIVE_V2_EXPERT_REGISTRY.modeBindings.map');
    expect(helper).toContain('equalPermissionCeilingDigest: digest(SOLUTION_LIVE_V2_EXPERT_REGISTRY.permissionCeiling)');
    expect(helper).toContain("label: 'A.1', capabilityVersionId, capabilityVersion: 2");
    expect(helper).toContain('expertCatalogVersionId, expertCatalogVersion: 2');
    expect(helper).toContain("label: 'A.2', capabilityVersionId: a2CapabilityVersionId, capabilityVersion: 3");
    expect(helper).toContain("label: 'A.1 internal'");
    expect(helper).toContain("label: 'A.2 draft'");
    expect(helper).toContain('previousReleaseId: null');
    expect(helper).toContain("label: 'A.2 shadow'");
    expect(helper).toContain('previousReleaseId: a2DraftReleaseId');
    expect(helper).toContain("label: 'A.2 internal'");
    expect(helper).toContain('previousReleaseId: a2ShadowReleaseId');
    expect(helper).toContain('INSERT INTO capability_release_activation_records');
    expect(helper).toContain('SET release_id=$2,pointer_version=4,activation_record_id=$3,updated_at=now()');
    expect(helper).toContain('AND release_id=$4 AND pointer_version=3 AND activation_record_id IS NULL');
    expect(helper).toContain("current.pointer_version !== '4'");
  });

  it('keeps every live Gate A entrypoint on the approved multi-format document parser v2 authority', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      scripts?: Readonly<Record<string, string>>;
    }>;
    const [releaseHelper, devUp, runE2e, approvalHelper, c1AllowlistHelper, playwrightConfig, storageAdapter] = await Promise.all([
      readFile(new URL('./e2e/start-gate-a-release.ts', import.meta.url), 'utf8'),
      readFile(new URL('./dev-up.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./run-e2e.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./prepare-gate-a-document-parser-approval.ts', import.meta.url), 'utf8'),
      readFile(new URL('./prepare-gate-a-c1-allowlist.ts', import.meta.url), 'utf8'),
      readFile(new URL('./playwright.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('./storage-adapter.ts', import.meta.url), 'utf8'),
    ]);

    expect(manifest.scripts?.['build:gate-a-parser']).toBe(
      'node scripts/build-gate-a-document-parser-image.mjs',
    );
    for (const requiredIntegration of [
      'packages/contracts/src/gate-a.migration.integration.test.ts',
      'apps/control-plane/src/artifact.gate-a-parser.integration.test.ts',
      'apps/control-plane/src/gate-a-live-repository.integration.test.ts',
    ]) {
      expect(manifest.scripts?.['test:integration']).toContain(requiredIntegration);
    }
    for (const source of [devUp, runE2e]) {
      expect(source).toContain('build-gate-a-document-parser-image.mjs');
      expect(source).toContain('prepare-gate-a-document-parser-approval.ts');
      expect(source).not.toContain('build-gate-a-parser-image.mjs');
      expect(source).not.toContain('geneway-plain-text-parser');
      expect(source).not.toContain('gate-a-parser-startup-approval/1');
    }
    expect(releaseHelper).toContain('GateADocumentParserSandboxCandidate');
    expect(releaseHelper).toContain('gateAParserStartupApprovalSchema.parse');
    expect(releaseHelper).toContain('parserSandbox.resolveAuthority()');
    expect(releaseHelper).toContain("mediaType: 'application/pdf'");
    expect(releaseHelper).toContain(
      "mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'",
    );
    expect(releaseHelper).toContain('parsers: parserEvidence');
    expect(releaseHelper).not.toContain('GateAPlainTextParserSandbox');
    expect(approvalHelper).toContain('gateAParserStartupApprovalSchema.parse');
    expect(approvalHelper).toContain("const runId = required('GENEWAY_RUN_ID')");
    expect(approvalHelper).toContain("if (approvedBy !== 'user_local')");
    expect(runE2e).toContain("['scripts/prepare-gate-a-c1-allowlist.ts']");
    expect(runE2e).toContain('GENEWAY_GATE_A_APPROVED_C1_SHA256: gateAC1Allowlist');
    expect(c1AllowlistHelper).toContain("schemaVersion: 'gate-a-c1-served-allowlist/1'");
    expect(c1AllowlistHelper).toContain('hashes.length !== 6');
    expect(playwrightConfig).toContain('GENEWAY_GATE_A_APPROVED_C1_SHA256=${shellQuote');
    expect(storageAdapter).toContain("'application/pdf'");
    expect(storageAdapter).toContain(
      "'application/vnd.openxmlformats-officedocument.wordprocessingml.document'",
    );
  });

  it('passes only the loopback Gateway client configuration through the E2E Worker supervisor', async () => {
    expect(modelGatewayWorkerEnvironment({
      GENEWAY_MODEL_GATEWAY_URL: 'http://127.0.0.1:3150',
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: '/tmp/gateway-authority/service-token',
      GENEWAY_GATE_A_LIVE_ENABLED: '1',
      GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE: '/tmp/gateway-authority/invocation-secret',
      GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE: '/home/gewu/.codex/auth.json',
    })).toEqual({
      GENEWAY_MODEL_GATEWAY_URL: 'http://127.0.0.1:3150',
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: '/tmp/gateway-authority/service-token',
      GENEWAY_GATE_A_LIVE_ENABLED: '1',
    });
    expect(() => modelGatewayWorkerEnvironment({
      GENEWAY_MODEL_GATEWAY_URL: 'http://127.0.0.1:3150',
    })).toThrow('configured together');
    expect(() => modelGatewayWorkerEnvironment({
      GENEWAY_MODEL_GATEWAY_URL: 'http://192.168.1.20:3150',
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: '/tmp/gateway-authority/service-token',
    })).toThrow('loopback');
    expect(() => modelGatewayWorkerEnvironment({
      GENEWAY_GATE_A_LIVE_ENABLED: '1',
    })).toThrow('requires loopback Model Gateway authority');
    expect(() => modelGatewayWorkerEnvironment({
      GENEWAY_MODEL_GATEWAY_URL: 'http://127.0.0.1:3150',
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: '/tmp/gateway-authority/service-token',
      GENEWAY_GATE_A_LIVE_ENABLED: 'true',
    })).toThrow('must be 1');

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
    const playwrightConfig = await readFile(new URL('./playwright.config.ts', import.meta.url), 'utf8');
    const proxyRunner = await readFile(new URL('./gate02b-loopback-proxy.mjs', import.meta.url), 'utf8');
    const e2eRunner = await readFile(new URL('./run-e2e.mjs', import.meta.url), 'utf8');
    const e2eIdentity = await readFile(new URL('./e2e-run-identity.mjs', import.meta.url), 'utf8');
    const guard = await readFile(new URL('./backup-restore/gate02b-egress-guard.c', import.meta.url), 'utf8');
    const verifier = await readFile(new URL('./verify-gate0.2b.mjs', import.meta.url), 'utf8');
    expect(verifier).toContain('const backupRunsRequired = result.status === 0 && result.signal === null');
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
    expect(storageRunner).toContain('setsid node scripts/gate02b-loopback-proxy.mjs --control');
    expect(storageRunner.match(/"\$pgid" == "\$pid" && "\$sid" == "\$pid" && "\$ppid" == "\$\$"/gu)).toHaveLength(2);
    expect(playwrightConfig.match(/gracefulShutdown: \{ signal: 'SIGTERM', timeout: 30_000 \}/gu)).toHaveLength(1);
    expect(storageRunner.match(/"\$\{pull_policy\[@\]\}"/gu)).toHaveLength(3);
    expect(storageRunner).toContain("schemaVersion: 'geneway-gate02b-storage-invocation/1'");
    expect(storageRunner).toContain("writeFileSync(env.GENEWAY_INVOCATION_PATH");
    expect(storageRunner.indexOf('writeFileSync(env.GENEWAY_INVOCATION_PATH')).toBeLessThan(storageRunner.indexOf('up -d --wait'));
    expect(proxyRunner).toContain("['--host', localDockerHost, ...args]");
    expect(proxyRunner).toContain("timeout: 2_000");
    expect(proxyRunner).toContain("DOCKER_CONFIG: configPath");
    expect(proxyRunner).not.toContain('DOCKER_CONTEXT:');
    expect(e2eIdentity).toContain("JSON.stringify({ parentRunId, forwarded, selectedProjects })");
    expect(e2eRunner).toContain('e2eRunIdentity(parentRunId, forwarded, gate02bGuarded)');
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
    expect(verifier).toContain("stdio: ['ignore', eventDescriptor, 'pipe']");
    expect(verifier).toContain("state.startSentinel = emitDockerEventSentinel(state, 'start')");
    expect(verifier).toContain("state.endSentinel = emitDockerEventSentinel(state, 'end')");
    expect(verifier).toContain("source: 'live-raw-file'");
    expect(verifier).toContain('authoritative: false');
    expect(verifier).not.toMatch(/catchup\.stdout[\s\S]{0,500}recordDockerEvent\(/u);
    const runStepSource = verifier.slice(verifier.indexOf('async function runStep'), verifier.indexOf('\nfunction readPassingE2eReceipt'));
    expect(runStepSource.indexOf('startDockerEventMonitor')).toBeLessThan(runStepSource.indexOf('const child = spawn'));
    expect(runStepSource.indexOf('waitForDockerBoundaryQuiescence')).toBeLessThan(runStepSource.indexOf('stopDockerEventMonitor'));
    const runtimeSampler = verifier.slice(verifier.indexOf('function runtimeBoundarySample'), verifier.indexOf('\nfunction additions'));
    const preListenerDockerRefresh = runtimeSampler.indexOf('observeDockerResources(dockerObservation)');
    const firstListenerSnapshot = runtimeSampler.indexOf('const firstGlobalSnapshot = globalListenerSnapshot()');
    const frozenAmbientWitnesses = runtimeSampler.indexOf('const ambientLiveWitnesses = new Map()', firstListenerSnapshot);
    const secondListenerSnapshot = runtimeSampler.indexOf('const secondGlobalSnapshot = globalListenerSnapshot()', frozenAmbientWitnesses);
    const exactAmbientClassification = runtimeSampler.indexOf('const ambient = classifyAmbientOwnedListeners');
    expect(preListenerDockerRefresh).toBeGreaterThan(0);
    expect(firstListenerSnapshot).toBeGreaterThan(preListenerDockerRefresh);
    expect(firstListenerSnapshot).toBeGreaterThan(0);
    expect(frozenAmbientWitnesses).toBeGreaterThan(firstListenerSnapshot);
    expect(secondListenerSnapshot).toBeGreaterThan(frozenAmbientWitnesses);
    expect(exactAmbientClassification).toBeGreaterThan(secondListenerSnapshot);
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

  it('reserves all four storage proxy ports concurrently so one invocation cannot self-collide', async () => {
    const storageRunner = await readFile(new URL('./with-storage.sh', import.meta.url), 'utf8');
    const functionStart = storageRunner.indexOf('pick_ports() {');
    const functionEnd = storageRunner.indexOf('\n\nrandom_secret() {', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const probe = spawnSync('bash', ['-c', `
set -euo pipefail
${storageRunner.slice(functionStart, functionEnd)}
for _ in $(seq 1 20); do
  read -r first second third fourth < <(pick_ports)
  [[ "$first" =~ ^[1-9][0-9]*$ && "$second" =~ ^[1-9][0-9]*$ \
    && "$third" =~ ^[1-9][0-9]*$ && "$fourth" =~ ^[1-9][0-9]*$ ]]
  [[ "$(printf '%s\n' "$first" "$second" "$third" "$fourth" | sort -u | wc -l)" -eq 4 ]]
  node --input-type=module - "$first" "$second" "$third" "$fourth" <<'NODE'
import net from 'node:net';
const ports = process.argv.slice(2).map(Number);
const servers = ports.map(() => net.createServer());
await Promise.all(servers.map((server, index) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(ports[index], '127.0.0.1', resolve);
})));
await Promise.all(servers.map((server) => new Promise((resolve, reject) =>
  server.close((error) => error === undefined ? resolve() : reject(error)))));
NODE
done
`], { encoding: 'utf8', timeout: 15_000 });
    expect(probe.status, `${probe.stdout}\n${probe.stderr}\n${String(probe.error)} signal=${String(probe.signal)}`).toBe(0);
    expect(storageRunner).not.toContain('pick_port() {');
    expect(storageRunner).not.toContain('$(pick_port)');
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
      networkSubnets: ['172.30.0.0/16'],
      ip: '172.30.0.2', port: 5432, containerPort: 5432,
    };
    const stem = `${target.project}-postgres`;
    const unhashedPolicy = { schemaVersion: 'geneway-gate02b-loopback-proxy/1', name: stem,
      dockerHost: 'unix:///var/run/docker.sock', dockerConfigPath: `${runRoot}/docker-client`,
      policyPath: `${runRoot}/loopback-proxies/${stem}.policy.json`,
      rawPath: `${runRoot}/loopback-proxies/${stem}.raw`, identityPath: `${runRoot}/loopback-proxies/${stem}.identity.json`,
      readyPath: `${runRoot}/loopback-proxies/${stem}.ready.json`,
      attemptsPath: `${runRoot}/loopback-proxies/${stem}.attempts.jsonl`,
      controller: { pid: 1, parentPid: 2, startTicks: '42', processGroupId: 1, sessionId: 1, hostname: 'host' },
      listen: { host: '127.0.0.1', port: 55433 }, target };
    const policy = { ...unhashedPolicy, policyHash: createHash('sha256').update(JSON.stringify(unhashedPolicy)).digest('hex') };
    expect(validateProxyPolicy(policy, runRoot)).toEqual(policy);
    expect(validateLoopbackProxyPolicy(policy, runRoot)).toEqual(policy);
    const policyWithTarget = (changedTarget: Record<string, unknown>) => {
      const changed = { ...unhashedPolicy, target: changedTarget };
      return { ...changed, policyHash: createHash('sha256').update(JSON.stringify(changed)).digest('hex') };
    };
    for (const invalidTarget of [
      { ...target, networkSubnets: [] },
      { ...target, networkSubnets: ['not-a-cidr'] },
      { ...target, networkSubnets: ['192.168.96.0/20'] },
    ]) {
      const invalidPolicy = policyWithTarget(invalidTarget);
      expect(() => validateProxyPolicy(invalidPolicy, runRoot)).toThrow('unsafe');
      expect(() => validateLoopbackProxyPolicy(invalidPolicy, runRoot)).toThrow('invalid policy');
    }
    const container = { Id: target.containerId, Config: { Labels: {
      'com.docker.compose.project': target.project, 'com.docker.compose.service': target.service,
    } }, NetworkSettings: { Networks: { [target.networkName]: { NetworkID: target.networkId, IPAddress: target.ip } } } };
    const network = { Id: target.networkId, Name: target.networkName, Internal: true,
      IPAM: { Config: [{ Subnet: '172.30.0.0/16' }] },
      Labels: { 'com.docker.compose.project': target.project } };
    expect(proxyTargetBindingMatches(policy, container, network)).toBe(true);
    expect(proxyTargetBindingMatches(policy, { ...container, Id: 'c'.repeat(64) }, network)).toBe(false);
    expect(proxyTargetBindingMatches(policy, container, { ...network, Internal: false })).toBe(false);
    expect(proxyTargetBindingMatches(policy, container, { ...network, IPAM: { Config: [] } })).toBe(false);
    expect(proxyTargetBindingMatches(policy, container, { ...network, IPAM: { Config: [{ Subnet: '192.168.96.0/20' }] } })).toBe(false);
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
    expect(validateProxyIdentityChain(policy, ready, ready, { ...identitySummary, identityPath: policy.identityPath, identity: ready })).toBe(true);
    expect(validateProxyIdentityChain(policy, ready, ready, { ...identitySummary, identityPath: policy.identityPath, identity: ready,
      stdoutReady: { ...identitySummary.stdoutReady, pid: 2 } })).toBe(false);
    expect(validateProxyIdentityChain(policy, ready, ready, { ...identitySummary, identityPath: policy.identityPath, identity: ready,
      spawnIdentity: { ...identitySummary.spawnIdentity, startTicks: '43' } })).toBe(false);
    expect(validateProxyIdentityChain(policy, { ...ready, pid: 2 }, ready,
      { ...identitySummary, identityPath: policy.identityPath, identity: ready })).toBe(false);
    expect(() => validateProxyPolicy({ ...policy, policyPath: '/tmp/escape.policy.json' }, runRoot)).toThrow('unsafe');
    expect(() => validateProxyPolicy({ ...policy, identityPath: '/tmp/escape.identity.json' }, runRoot)).toThrow('unsafe');
    expect(proxyPolicyPathFromCommandLine(
      `node /home/gewu/work/geneway/scripts/gate02b-loopback-proxy.mjs --serve ${policy.policyPath}`,
    )).toBe(policy.policyPath);
    expect(proxyPolicyPathFromCommandLine(`node scripts/not-proxy.mjs --serve ${policy.policyPath}`)).toBeNull();
    expect(proxyPolicyPathFromCommandLine(
      `node /home/gewu/work/geneway/scripts/gate02b-loopback-proxy.mjs --serve ${policy.policyPath} extra`,
    )).toBeNull();
    const files = (stem: string) => [`${stem}.policy.json`, `${stem}.raw`, `${stem}.identity.json`, `${stem}.ready.json`,
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
      authoritativeEventLedger: { passed: true }, catchupAudit: { passed: true },
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

  it('records identity-bound namespace release separately while hard proc-net errors still fail closed', () => {
    const project = 'geneway-storage-exit-race';
    const networkId = 'network-id';
    const baseContainer = {
      id: 'container-id', name: `${project}-postgres-1`, project, service: 'postgres', repositoryScoped: true,
      networkMode: `${project}_default`, inspectObserved: true, eventObserved: true,
      networkIds: new Set([networkId]), networkNames: new Set([`${project}_default`]),
      publishedPorts: [], extraHosts: [], netnsAttempted: true, netnsSockets: [], netnsErrors: [],
      netnsReleaseTransitions: [{ protocol: 'udp', pid: 71, pidStartTicks: '42' }],
    };
    const baseState = {
      containers: new Map([['container-id', baseContainer]]),
      networks: new Map([[networkId, {
        id: networkId, name: `${project}_default`, project, internal: true, driver: 'bridge', inspectObserved: true,
        subnets: ['192.168.96.0/20'], networkIds: new Set(), networkNames: new Set(), memberIdentities: new Map(),
      }]]),
      monitorStarted: true, eventCount: 2, eventParseErrors: [], monitorErrors: [], monitorExit: { status: 143, signal: null },
      authoritativeEventLedger: { passed: true }, catchupAudit: { passed: true },
      monitorStop: { requested: true, signal: 'SIGTERM', requestSucceeded: true, exit: { status: 143, signal: null } },
    };
    const released = dockerStructuralIsolationReceipt(baseState);
    expect(released.passed).toBe(true);
    expect(released.observedContainers[0]).toMatchObject({
      netnsErrors: [], netnsReleaseTransitions: [{ protocol: 'udp', pid: 71, pidStartTicks: '42' }],
    });
    const hardFailure = dockerStructuralIsolationReceipt({
      ...baseState,
      containers: new Map([['container-id', { ...baseContainer, netnsErrors: ['udp:EACCES'] }]]),
    });
    expect(hardFailure.passed).toBe(false);
    expect(hardFailure.violations).toContain(`container-netns-read-failed:${project}-postgres-1`);
  });

  const structuralState = (containers: Array<[string, Record<string, unknown>]>,
    networks: Array<[string, Record<string, unknown>]>) => ({
    containers: new Map(containers), networks: new Map(networks),
    monitorStarted: true, eventCount: 2, eventParseErrors: [], monitorErrors: [],
    monitorExit: { status: 143, signal: null }, authoritativeEventLedger: { passed: true }, catchupAudit: { passed: true },
    monitorStop: { requested: true, signal: 'SIGTERM', requestSucceeded: true, exit: { status: 143, signal: null } },
  });

  it('fails at network level when artifact-only evidence has no subnet and no socket is observed', () => {
    const project = 'geneway-storage-artifact-network';
    const networkId = 'network-id';
    const receipt = dockerStructuralIsolationReceipt(structuralState([['container-id', {
      id: 'container-id', name: `${project}-postgres-1`, project, service: 'postgres', repositoryScoped: true,
      networkMode: `${project}_default`, inspectObserved: true, eventObserved: true,
      networkIds: new Set([networkId]), networkNames: new Set([`${project}_default`]),
      publishedPorts: [], extraHosts: [], netnsAttempted: true, netnsErrors: [], netnsSockets: [],
    }]], [[networkId, {
      id: networkId, name: `${project}_default`, project, internal: true, driver: 'bridge',
      inspectObserved: false, artifactProofObserved: true, artifactProofs: [{}],
      gatewayAddresses: new Set(), interfaceNames: new Set(), memberIdentities: new Map(),
    }]]));
    expect(receipt.passed).toBe(false);
    expect(receipt.violations).toContain(`network-subnet-proof-missing:${project}_default:${networkId}`);
  });

  it('does not borrow a CIDR from another internal network for an artifact-only target', () => {
    const project = 'geneway-storage-artifact-network';
    const networkId = 'target-network-id';
    const unrelatedProject = 'geneway-storage-unrelated-network';
    const receipt = dockerStructuralIsolationReceipt(structuralState([['container-id', {
      id: 'container-id', name: `${project}-postgres-1`, project, service: 'postgres', repositoryScoped: true,
      networkMode: `${project}_default`, inspectObserved: true, eventObserved: true,
      networkIds: new Set([networkId]), networkNames: new Set([`${project}_default`]),
      publishedPorts: [], extraHosts: [], netnsAttempted: true, netnsErrors: [],
      netnsSockets: [{ protocol: 'tcp', remoteAddress: '192.168.96.2', remotePort: 5432, state: '01' }],
    }]], [
      [networkId, { id: networkId, name: `${project}_default`, project, internal: true, driver: 'bridge',
        inspectObserved: false, artifactProofObserved: true, artifactProofs: [{}] }],
      ['unrelated-network-id', { id: 'unrelated-network-id', name: `${unrelatedProject}_default`,
        project: unrelatedProject, internal: true, driver: 'bridge', inspectObserved: true, subnets: ['192.168.96.0/20'] }],
    ]));
    expect(receipt.passed).toBe(false);
    expect(receipt.violations).toContain(`network-subnet-proof-missing:${project}_default:${networkId}`);
    expect(receipt.violations).toContain(
      `container-netns-endpoint-forbidden:${project}-postgres-1:tcp:192.168.96.2:5432`,
    );
  });

  it('allows only CIDRs from the same container exact multi-network attachments', () => {
    const project = 'geneway-storage-multi-network';
    const networkA = { id: 'network-a', name: `${project}_default`, project, internal: true, driver: 'bridge',
      inspectObserved: true, subnets: ['172.30.0.0/16'] };
    const networkB = { id: 'network-b', name: `${project}_storage`, project, internal: true, driver: 'bridge',
      inspectObserved: true, subnets: ['192.168.96.0/20'] };
    const otherProject = 'geneway-storage-other-network';
    const networkC = { id: 'network-c', name: `${otherProject}_default`, project: otherProject, internal: true,
      driver: 'bridge', inspectObserved: true, subnets: ['203.0.113.0/24'] };
    const receipt = dockerStructuralIsolationReceipt(structuralState([['container-id', {
      id: 'container-id', name: `${project}-postgres-1`, project, service: 'postgres', repositoryScoped: true,
      networkMode: `${project}_default`, inspectObserved: true, eventObserved: true,
      networkIds: new Set([networkA.id, networkB.id]), networkNames: new Set([networkA.name, networkB.name]),
      publishedPorts: [], extraHosts: [], netnsAttempted: true, netnsErrors: [],
      netnsSockets: [
        { protocol: 'tcp', remoteAddress: '192.168.96.2', remotePort: 5432, state: '01' },
        { protocol: 'tcp', remoteAddress: '203.0.113.7', remotePort: 443, state: '01' },
      ],
    }]], [[networkA.id, networkA], [networkB.id, networkB], [networkC.id, networkC]]));
    expect(receipt.passed).toBe(false);
    expect(receipt.violations).not.toContain(
      `container-netns-endpoint-forbidden:${project}-postgres-1:tcp:192.168.96.2:5432`,
    );
    expect(receipt.violations).toContain(
      `container-netns-endpoint-forbidden:${project}-postgres-1:tcp:203.0.113.7:443`,
    );
  });

  it('accepts status 143 only after a successful verifier-requested SIGTERM monitor stop', () => {
    const cleanState = {
      containers: new Map(), networks: new Map(), monitorStarted: true, eventCount: 36,
      eventParseErrors: [], monitorErrors: [], authoritativeEventLedger: { passed: true }, catchupAudit: { passed: true },
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
    expect(dockerStructuralIsolationReceipt({ ...cleanState, monitorExit: { status: 0, signal: null } }, [], [], {
      expectedWithStorageInvocations: 1,
      expectedStorageInvocations: 1,
      enforceExpectedCardinality: false,
    }).passed).toBe(true);
  });

  it('preserves partial storage invocation evidence for a failed child without relaxing successful-child cardinality', async () => {
    const root = await mkdtemp(join(tmpdir(), 'geneway-partial-invocations-'));
    try {
      const expectation = {
        expectedWithStorageInvocations: 1,
        expectedStorageInvocations: 1,
        expectedE2eInvocations: 0,
      };
      expect(storageInvocationManifests(root, { ...expectation, enforceExpectedCardinality: false })).toEqual([]);
      expect(() => storageInvocationManifests(root, expectation)).toThrow('storage invocation manifests are missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates exact backup invocation membership and derives no authority from a mismatched project tuple', async () => {
    const root = await mkdtemp(join(tmpdir(), 'geneway-backup-invocations-'));
    const directory = join(root, 'backup-invocations');
    const runId = 'backup-restore-suite-success-123-abc';
    const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
    const projects = [`geneway-br-source-${suffix}`, `geneway-br-target-${suffix}`];
    const manifest = { schemaVersion: 'geneway-gate02b-backup-invocation/1', runId,
      childProxyRoot: `/tmp/geneway-runs/${runId}-proxies`, projects,
      networks: projects.map((project) => `${project}_default`) };
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, `${runId}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      expect(backupInvocationManifests(root, [runId], true)).toEqual([manifest]);
      expect(() => backupInvocationManifests(root, ['backup-restore-suite-missing-123'], true))
        .toThrow('membership does not match');
      await writeFile(join(directory, `${runId}.json`), `${JSON.stringify({ ...manifest,
        projects: [...projects].reverse() }, null, 2)}\n`, { mode: 0o600 });
      expect(() => backupInvocationManifests(root, [runId], true)).toThrow('manifest is invalid');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds a backup container boundary receipt to its exact run, full Docker ID, and none network mode', async () => {
    const runId = `backup-restore-suite-contract-${String(process.pid)}-${String(Date.now())}`;
    const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
    const root = join('/tmp/geneway-runs', runId);
    const directory = join(root, 'backup-restore', 'process-boundaries');
    const containerName = `geneway-br-${suffix}-worker-main`;
    const path = join(directory, `container-${containerName}.json`);
    const receipt = { schemaVersion: 'geneway-backup-container-boundary/1', role: 'worker', action: 'service',
      containerName, mounts: [], dockerAuthority: { passed: true }, forbiddenNamesPresent: [],
      containerId: 'a'.repeat(64), networkMode: 'none', networkAttachment: null, networkInspection: null, checked: true };
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      expect(backupContainerBoundaryReceipts([runId])).toEqual([
        expect.objectContaining({ ...receipt, runId, path }),
      ]);
      await writeFile(path, `${JSON.stringify({ ...receipt, containerId: 'short' }, null, 2)}\n`, { mode: 0o600 });
      expect(() => backupContainerBoundaryReceipts([runId])).toThrow('boundary is invalid');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('promotes only a proxy-frozen exact network that has one matching raw bridge-create event', () => {
    const networkId = 'a'.repeat(64);
    const target = { containerId: 'b'.repeat(64), project: 'geneway-storage-proof', service: 'postgres',
      networkId, networkName: 'geneway-storage-proof_default', networkInternal: true, networkSubnets: ['192.168.96.0/20'], ip: '192.168.96.4' };
    const state = { networks: new Map<string, Record<string, unknown>>(), lifecycleEvents: [{
      sequence: 7, timeNano: '1784790123456789123', type: 'network', action: 'create',
      networkId, networkName: target.networkName, networkDriver: 'bridge',
    }] };
    promoteProxyNetworkEvidence(state, [{ proxies: [{ intrinsicValid: true, target, policyPath: '/tmp/policy.json' }] }]);
    expect(state.networks.get(networkId)).toMatchObject({ id: networkId, name: target.networkName,
      project: target.project, internal: true, driver: 'bridge', artifactProofObserved: true,
      subnets: target.networkSubnets, artifactProofs: [{ containerId: target.containerId, subnets: target.networkSubnets, createEventSequence: 7 }] });

    const conflict = { networks: new Map<string, Record<string, unknown>>([
      [networkId, { id: networkId, project: 'geneway-storage-other' }],
    ]),
      lifecycleEvents: state.lifecycleEvents };
    promoteProxyNetworkEvidence(conflict, [{ proxies: [{ intrinsicValid: true, target, policyPath: '/tmp/policy.json' }] }]);
    expect(conflict.networks.get(networkId)).toMatchObject({ identityConflict: true });
    expect(conflict.networks.get(networkId)?.artifactProofObserved).toBeUndefined();

    const missingSubnet = { networks: new Map<string, Record<string, unknown>>(), lifecycleEvents: state.lifecycleEvents };
    promoteProxyNetworkEvidence(missingSubnet, [{ proxies: [{ intrinsicValid: true,
      target: { ...target, networkSubnets: [] }, policyPath: '/tmp/missing-subnet-policy.json' }] }]);
    expect(missingSubnet.networks.get(networkId)).toMatchObject({ identityConflict: true });
    expect(missingSubnet.networks.get(networkId)?.artifactProofObserved).toBeUndefined();
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

  it('binds browser allow and deny events to one kernel-enforced process identity', () => {
    const policyHash = 'a'.repeat(64);
    const expectedIdentity = {
      browserExecutableIdentities: [{ device: 1, inode: 2 }], guardLibraryDevice: 3, guardLibraryInode: 4,
    };
    const raw = [
      'START pid=101 startTicks=42 hostname=browser-host',
      `BROWSER_KERNEL pid=101 ppid=90 startTicks=42 policyHash=${policyHash} exeDev=1 exeIno=2 guardDev=3 guardIno=4 status=ENFORCED landlockAbi=7 tcp=allowlisted udp=blocked`,
      `BROWSER_EVENT pid=101 ppid=90 startTicks=42 policyHash=${policyHash} fd=12 ALLOW call=connect family=2 address=127.0.0.1 port=3200`,
      `BROWSER_EVENT pid=101 ppid=90 startTicks=42 policyHash=${policyHash} fd=13 DENY call=connect family=2 address=127.0.0.1 port=3300`,
      `BROWSER_EVENT pid=101 ppid=90 startTicks=42 policyHash=${policyHash} fd=14 DENY call=connect family=10 address=::1 port=3400`,
    ].join('\n');
    expect(parseBrowserEgressReceipt(raw, {
      webPort: 3200, forbiddenPorts: [3300, 3400], policyHash, requireForbiddenDenials: true, ...expectedIdentity,
    })).toMatchObject({
      passed: true, unknownLines: [], missingDeniedPorts: [], unexpectedAllows: [], sharedNetworkIdentities: ['101:42'],
    });
    expect(parseBrowserEgressReceipt(raw.replace('port=3200', 'port=3300'), {
      webPort: 3200, forbiddenPorts: [3300, 3400], policyHash, requireForbiddenDenials: true, ...expectedIdentity,
    }).passed).toBe(false);
    expect(parseBrowserEgressReceipt(raw.replace(`policyHash=${policyHash} fd=14`, `policyHash=${'b'.repeat(64)} fd=14`), {
      webPort: 3200, forbiddenPorts: [3300, 3400], policyHash, requireForbiddenDenials: true, ...expectedIdentity,
    }).passed).toBe(false);
    expect(parseBrowserEgressReceipt(`${raw}\nMALFORMED`, {
      webPort: 3200, forbiddenPorts: [3300, 3400], policyHash, requireForbiddenDenials: true, ...expectedIdentity,
    }).passed).toBe(false);
    expect(parseBrowserEgressReceipt(raw.replaceAll('pid=101 ppid=90 startTicks=42 policyHash=',
      'pid=101 ppid=90 startTicks=43 policyHash='), {
      webPort: 3200, forbiddenPorts: [3300, 3400], policyHash, requireForbiddenDenials: true, ...expectedIdentity,
    }).passed).toBe(false);
    const forgedChild = `${raw}\nBROWSER_CHILD pid=102 ppid=101 startTicks=50 inheritedFrom=101 inheritedFromStartTicks=999 kernel=inherited policyHash=${policyHash}`
      .replaceAll('BROWSER_EVENT pid=101 ppid=90 startTicks=42', 'BROWSER_EVENT pid=102 ppid=101 startTicks=50');
    expect(parseBrowserEgressReceipt(forgedChild, {
      webPort: 3200, forbiddenPorts: [3300, 3400], policyHash, requireForbiddenDenials: true, ...expectedIdentity,
    }).passed).toBe(false);
  });

  it('enforces the browser TCP allowlist and UDP block against direct kernel syscalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'geneway-browser-egress-kernel-'));
    try {
      await chmod(root, 0o700);
      const guard = join(root, 'guard.so');
      const probe = join(root, 'probe');
      const receipt = join(root, 'receipt.raw');
      await writeFile(receipt, '', { mode: 0o600 });
      const compileGuard = spawnSync('cc', ['-std=gnu17', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-ldl',
        '-o', guard, 'scripts/backup-restore/gate02b-egress-guard.c'], { encoding: 'utf8' });
      expect(compileGuard.status, compileGuard.stderr).toBe(0);
      const compileProbe = spawnSync('cc', ['-std=gnu17', '-O2', '-Wall', '-Wextra', '-Werror', '-o', probe,
        'scripts/e2e/browser-egress-kernel-conformance.c'], { encoding: 'utf8' });
      expect(compileProbe.status, compileProbe.stderr).toBe(0);
      const policyHash = 'c'.repeat(64);
      const executed = spawnSync(probe, ['9', '10'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          LD_PRELOAD: guard,
          GENEWAY_GATE02B_BROWSER_EGRESS_GUARD: 'required',
          GENEWAY_GATE02B_BROWSER_POLICY_HASH: policyHash,
          GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS: '9',
          GENEWAY_GATE02B_EGRESS_RECEIPT: receipt,
        },
      });
      expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
      expect(executed.stdout).toMatch(/allowedErrno=(?:0|111) forbiddenErrno=13 udp4Errno=1 udp6Errno=1 rawErrno=1 seqpacketErrno=1 streamUdpErrno=1/u);
      expect(await readFile(receipt, 'utf8')).toMatch(new RegExp(`policyHash=${policyHash} .*status=ENFORCED`, 'u'));
      await chmod(receipt, 0o644);
      const unsafeReceipt = spawnSync(probe, ['9', '10'], { env: {
        PATH: process.env.PATH, LD_PRELOAD: guard, GENEWAY_GATE02B_BROWSER_EGRESS_GUARD: 'required',
        GENEWAY_GATE02B_BROWSER_POLICY_HASH: policyHash, GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS: '9',
        GENEWAY_GATE02B_EGRESS_RECEIPT: receipt,
      } });
      expect(unsafeReceipt.status).toBe(126);
      await chmod(receipt, 0o600);
      const symlinkReceipt = join(root, 'receipt-link.raw');
      await symlink(receipt, symlinkReceipt);
      const linkedReceipt = spawnSync(probe, ['9', '10'], { env: {
        PATH: process.env.PATH, LD_PRELOAD: guard, GENEWAY_GATE02B_BROWSER_EGRESS_GUARD: 'required',
        GENEWAY_GATE02B_BROWSER_POLICY_HASH: policyHash, GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS: '9',
        GENEWAY_GATE02B_EGRESS_RECEIPT: symlinkReceipt,
      } });
      expect(linkedReceipt.status).toBe(126);
      const missingReceipt = spawnSync(probe, ['9', '10'], { env: {
        PATH: process.env.PATH, LD_PRELOAD: guard, GENEWAY_GATE02B_BROWSER_EGRESS_GUARD: 'required',
        GENEWAY_GATE02B_BROWSER_POLICY_HASH: policyHash, GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS: '9',
      } });
      expect(missingReceipt.status).toBe(126);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it('retains kernel cgroup/inode/sk evidence for an ownerless listener teardown row', () => {
    const cgroup = '/user.slice/user-1000.slice/user@1000.service/app.slice/rygel.service';
    const row = `LISTEN 0 10 [fe80::6879:e1ff:fe13:8591]%vetha065c33:46822 [::]:* uid:1000 ino:951234567 sk:10abcd cgroup:${cgroup} v6only:1 <->`;
    expect(parseOwnerlessAmbientEnvelope(row)).toMatchObject({ family: 'ipv6',
      endpoint: '[fe80::6879:e1ff:fe13:8591]%vetha065c33:46822', uid: 1000,
      socketInode: '951234567', sk: '10abcd', cgroup });
    expect(parseOwnerlessAmbientEnvelope(row.replace(` cgroup:${cgroup}`, ''))).toBeNull();
    expect(parseOwnerlessAmbientEnvelope(row.replace(' uid:1000', ' users:(("rygel",pid=7,fd=3)) uid:1000'))).toBeNull();
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

  it('retries a live-identity proc-net ENOENT but still fails closed after the bounded attempts', () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const liveNamespace = () => ({ status: 'present', identity: 'net:[42]' });
    let reads = 0;
    let waits = 0;
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => { reads += 1; if (reads < 3) throw enoent; return 'snapshot'; },
      observeIdentity: () => ({ status: 'present', state: 'S', startTicks: '42' }),
      wait: () => { waits += 1; },
    })).toEqual({ text: 'snapshot', failure: null, exited: false, attempts: 3 });
    expect(waits).toBe(2);
    reads = 0;
    waits = 0;
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => { reads += 1; throw enoent; },
      observeIdentity: () => ({ status: 'present', state: 'S', startTicks: '42' }),
      observeNetworkNamespace: liveNamespace,
      wait: () => { waits += 1; },
    })).toMatchObject({ text: null, failure: enoent, exited: false, attempts: 3 });
    expect(reads).toBe(3);
    expect(waits).toBe(2);
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => { throw new Error('must not read'); }, observeIdentity: () => ({ status: 'missing' }),
      wait: () => { throw new Error('no wait'); },
    })).toEqual({ text: null, failure: null, exited: true, attempts: 1 });
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, null as unknown as string, {
      read: () => { throw new Error('must not read'); }, observeIdentity: () => ({ status: 'missing' }),
      wait: () => { throw new Error('no wait'); },
    })).toEqual({ text: null, failure: null, exited: true, attempts: 1 });
    for (const startTicks of ['42', '43']) {
      const unboundLiveIdentity = readProcNetSnapshot('/proc/7/net/udp', 7, null as unknown as string, {
        read: () => { throw new Error('must not read'); },
        observeIdentity: () => ({ status: 'present', state: 'S', startTicks }), wait: () => {},
      });
      expect(unboundLiveIdentity).toMatchObject({ text: null, exited: false, attempts: 1 });
      expect(unboundLiveIdentity.failure).toBeInstanceOf(Error);
    }
    const unboundIdentityError = readProcNetSnapshot('/proc/7/net/udp', 7, null as unknown as string, {
      read: () => { throw new Error('must not read'); },
      observeIdentity: () => ({ status: 'error' }), wait: () => {},
    });
    expect(unboundIdentityError).toMatchObject({ text: null, exited: false, attempts: 1 });
    expect(unboundIdentityError.failure).toBeInstanceOf(Error);
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, null as unknown as string, {
      read: () => { throw new Error('must not read'); },
      observeIdentity: () => ({ status: 'present', state: 'Z', startTicks: '42' }), wait: () => {},
    })).toEqual({ text: null, failure: null, exited: true, attempts: 1 });
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => { throw new Error('must not read'); },
      observeIdentity: () => ({ status: 'present', state: 'Z', startTicks: '42' }), wait: () => {},
    })).toEqual({ text: null, failure: null, exited: true, attempts: 1 });
    const identities = [
      { status: 'present', state: 'S', startTicks: '42' },
      { status: 'present', state: 'S', startTicks: '42' },
      { status: 'present', state: 'S', startTicks: '42' },
      { status: 'present', state: 'S', startTicks: '43' },
    ];
    let reuseReads = 0;
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => { reuseReads += 1; if (reuseReads === 1) throw enoent; return 'wrong-process-snapshot'; },
      observeIdentity: () => identities.shift() ?? { status: 'error' }, wait: () => {},
    })).toEqual({ text: null, failure: null, exited: true, attempts: 2 });
    const unreliable = readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => 'snapshot', observeIdentity: () => ({ status: 'error' }), wait: () => {},
    });
    expect(unreliable).toMatchObject({ text: null, exited: false, attempts: 1 });
    expect(unreliable.failure).toBeInstanceOf(Error);
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    let eaccesIdentityChecks = 0;
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => { throw eacces; }, observeIdentity: () => {
        eaccesIdentityChecks += 1;
        return eaccesIdentityChecks === 1 ? { status: 'present', state: 'S', startTicks: '42' } : { status: 'missing' };
      },
      wait: () => { throw new Error('no retry'); },
    })).toMatchObject({ text: null, failure: eacces, exited: false, attempts: 1 });
    expect(eaccesIdentityChecks).toBe(1);
  });

  it('accepts final proc-net ENOENT only when the same process has released its network namespace', () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const boundIdentity = () => ({ status: 'present', state: 'S', startTicks: '42' });
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => { throw enoent; }, observeIdentity: boundIdentity,
      observeNetworkNamespace: () => ({ status: 'released' }), wait: () => {},
    })).toEqual({ text: null, failure: null, exited: false, released: true, attempts: 3 });

    const namespaceDenied = Object.assign(new Error('denied'), { code: 'EACCES' });
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => { throw enoent; }, observeIdentity: boundIdentity,
      observeNetworkNamespace: () => ({ status: 'error', failure: namespaceDenied }), wait: () => {},
    })).toEqual({ text: null, failure: namespaceDenied, exited: false, attempts: 3 });

    let identityChecks = 0;
    expect(readProcNetSnapshot('/proc/7/net/udp', 7, '42', {
      read: () => { throw enoent; },
      observeIdentity: () => {
        identityChecks += 1;
        return identityChecks < 7 ? boundIdentity() : { status: 'present', state: 'S', startTicks: '43' };
      },
      observeNetworkNamespace: () => ({ status: 'released' }), wait: () => {},
    })).toEqual({ text: null, failure: null, exited: true, attempts: 3 });
  });

  it('retains the last inspected network attachments when a later inspect disappears', () => {
    const attachments = networkAttachmentsAfterInspect([], { NetworkSettings: { Networks: {
      'geneway-storage-test_storage': { NetworkID: 'network-id', IPAddress: '192.168.96.4' },
    } } });
    expect(attachments).toEqual([
      { name: 'geneway-storage-test_storage', id: 'network-id', ip: '192.168.96.4' },
    ]);
    expect(networkAttachmentsAfterInspect(attachments, undefined)).toBe(attachments);
    expect(networkAttachmentsAfterInspect(attachments, { NetworkSettings: { Networks: {
      'geneway-storage-test_storage': { NetworkID: '', IPAddress: '' },
    } } })).toEqual(attachments);
    expect(networkAttachmentsAfterInspect(attachments, { NetworkSettings: { Networks: {} } })).toBe(attachments);
    expect(networkAttachmentsAfterInspect([
      ...attachments, { name: 'geneway-storage-test_default', id: 'default-id', ip: '192.168.64.4' },
    ], { NetworkSettings: { Networks: {
      'geneway-storage-test_storage': { NetworkID: 'network-id-2', IPAddress: '192.168.96.5' },
    } } })).toEqual([
      { name: 'geneway-storage-test_storage', id: 'network-id-2', ip: '192.168.96.5' },
      { name: 'geneway-storage-test_default', id: 'default-id', ip: '192.168.64.4' },
    ]);
  });

  it('never erases an observed published port when a later inspect is empty or disappears', () => {
    const observed = publishedPortsAfterInspect([], { NetworkSettings: { Ports: {
      '7400/tcp': [{ HostIp: '0.0.0.0', HostPort: '17400' }],
    } } });
    expect(observed).toEqual([{ hostIp: '0.0.0.0', hostPort: '17400' }]);
    expect(publishedPortsAfterInspect(observed, undefined)).toBe(observed);
    expect(publishedPortsAfterInspect(observed, { NetworkSettings: { Ports: {} } })).toEqual(observed);
  });

  it('correlates short Docker CLI IDs with their full event and inspect identity', () => {
    const full = { id: 'a'.repeat(64), name: 'geneway-storage-test-postgres-1' };
    const containers = new Map([[full.id, full]]);
    expect(observedDockerContainer(containers, 'a'.repeat(12), full.name)).toBe(full);
    expect(observedDockerContainer(containers, full.id, 'geneway-storage-test-other-1')).toBeUndefined();
    expect(observedDockerContainer(containers, full.id)).toBe(full);
    expect(observedDockerContainer(containers, 'a'.repeat(12))).toBeUndefined();
    expect(observedDockerContainer(containers, 'a'.repeat(11), full.name)).toBeUndefined();
    expect(observedDockerContainer(new Map([['a'.repeat(12), { ...full, id: 'a'.repeat(12) }]]), full.id, full.name))
      .toMatchObject({ id: 'a'.repeat(12), name: full.name });
    expect(observedDockerContainer(containers, 'b'.repeat(12), full.name)).toBeUndefined();
    expect(observedDockerContainer(containers, 'b'.repeat(12), 'geneway-storage-test-other-1')).toBeUndefined();
    const short = { ...full, id: 'a'.repeat(12) };
    const state = { containers: new Map([[short.id, short]]) };
    short.id = full.id;
    storeObservedDockerContainer(state, short);
    expect([...state.containers.entries()]).toEqual([[full.id, short]]);
    short.id = 'a'.repeat(12);
    storeObservedDockerContainer(state, short);
    expect(short.id).toBe(full.id);
    expect([...state.containers.entries()]).toEqual([[full.id, short]]);
    expect(() => storeObservedDockerContainer(state, { id: full.id, name: 'conflict' })).toThrow('key conflict');
    const conflictingObject = { id: 'b'.repeat(64), name: short.name };
    const conflictingState = { containers: new Map([[full.id, conflictingObject]]) };
    expect(() => storeObservedDockerContainer(conflictingState, conflictingObject)).toThrow('correlation conflict');
  });

  it('preserves Docker event timeNano without JavaScript number precision loss', () => {
    expect(exactDockerEventTimeNano('{"timeNano":1784790123456789123}', { timeNano: 1784790123456789000 }))
      .toBe('1784790123456789123');
    expect(exactDockerEventTimeNano('', { timeNano: 42 })).toBe('42');
    expect(exactDockerEventTimeNano('', { timeNano: 1784790123456789000 })).toBeNull();
    expect(exactDockerEventTimeNano('{"timeNano":"invalid"}', {})).toBeNull();
  });

  it('never lets a later adapter proof erase an earlier unsafe listener observation', () => {
    expect(unresolvedUnsafeListeners([
      { sample: 1, unsafe: ['lan', 'adapter'], validated: [] },
      { sample: 2, unsafe: [], validated: ['adapter'] },
    ])).toEqual(['adapter', 'lan']);
    expect(unresolvedUnsafeListeners([{ sample: 1, unsafe: ['descendant-only'], validated: [] }]))
      .toEqual(['descendant-only']);
  });

  it('resolves an ownerless observation only through the same released strong socket/process/interface instance', () => {
    const line = '[fe80::1]%br-proof:40202 pids=';
    const envelope = { endpoint: '[fe80::1]%br-proof:40202', uid: 1000, socketInode: '923136226',
      sk: 'fd2d2', cgroup: '/user.slice/rygel.service' };
    const interfaceWitness = { networkId: 'a'.repeat(64), networkName: 'geneway-storage-proof_default',
      interfaceName: 'br-proof', ifindex: 42, interfaceMac: '02:42:ac:16:00:01', source: { sha256: 'b'.repeat(64) } };
    const receipt = { schemaVersion: 'geneway-gate02b-ownerless-ambient-pending/1', line, envelope,
      processProof: { processInstanceKey: 'process-proof' }, interfaceWitness };
    const state = { status: 'RELEASED', proof: { listener: { ...envelope },
      process: { processInstanceKey: 'process-proof' }, interfaceWitness } };
    expect(ownerlessEnvelopeMatchesReleasedProof(receipt, state)).toBe(true);
    expect(unresolvedUnsafeListeners([{ sample: 1, unsafe: [line], validated: [], unsafeSources: { descendants: [] },
      unsafeReceipts: [receipt] }], [state])).toEqual([]);
    expect(unresolvedUnsafeListeners([{ sample: 1, unsafe: [line], validated: [], unsafeSources: { descendants: [line] },
      unsafeReceipts: [receipt] }], [state])).toEqual([line]);
    expect(ownerlessEnvelopeMatchesReleasedProof(receipt, { ...state, proof: { ...state.proof,
      listener: { ...state.proof.listener, socketInode: '923136227' } } })).toBe(false);
    expect(ownerlessEnvelopeMatchesReleasedProof(receipt, { ...state, proof: { ...state.proof,
      interfaceWitness: { ...interfaceWitness, ifindex: 43 } } })).toBe(false);
    const transientRelease = {
      schemaVersion: 'geneway-gate02b-owned-ambient-transient-release/1', status: 'RELEASED_DURING_OWNER_TEARDOWN',
      consecutiveAbsenceSnapshots: 2, listener: { ...envelope }, processProof: { processInstanceKey: 'process-proof' },
      interfaceWitness,
    };
    expect(unresolvedUnsafeListeners([{ sample: 1, unsafe: [line], validated: [], unsafeSources: { descendants: [] },
      unsafeReceipts: [receipt] }], [], [transientRelease])).toEqual([]);
    expect(unresolvedUnsafeListeners([{ sample: 1, unsafe: [line], validated: [], unsafeSources: { descendants: [] },
      unsafeReceipts: [receipt] }], [], [{ ...transientRelease, listener: { ...envelope, sk: 'different' } }]))
      .toEqual([line]);
    expect(unresolvedUnsafeListeners([{ sample: 1, unsafe: [line], validated: [], unsafeSources: { descendants: [line] },
      unsafeReceipts: [receipt] }], [], [transientRelease])).toEqual([line]);
  });

  it('accepts cached Docker endpoints as unreachable only while no live link reuses their identity or address', () => {
    const network = {
      bridgeName: 'br-proof', bridgeIdentity: { ifindex: 40, address: '02:00:00:00:00:40' },
      gatewayAddresses: new Set(['192.168.96.1']),
      memberIdentities: new Map([['veth-proof', { ifindex: 41, address: '02:00:00:00:00:41' }]]),
    };
    expect(unreachableCachedDockerNetworkContext(network, [])).toEqual({
      gatewayAddresses: ['192.168.96.1'], interfaceNames: ['br-proof', 'if40', 'if41', 'veth-proof'],
    });
    expect(unreachableCachedDockerNetworkContext(network, [
      { ifname: 'unrelated', ifindex: 90, address: '02:00:00:00:00:90', addr_info: [{ local: '192.168.96.1' }] },
      { ifname: 'veth-proof', ifindex: 91, address: '02:00:00:00:00:91' },
      { ifname: 'other-bridge', ifindex: 40, address: '02:00:00:00:00:99' },
    ])).toEqual({ gatewayAddresses: [], interfaceNames: [] });
    expect(unreachableCachedDockerNetworkContext(network, [
      { ifname: 'if41', ifindex: 91, address: '02:00:00:00:00:91' },
    ]).interfaceNames).not.toContain('if41');
    expect(unreachableCachedDockerNetworkContext(network, [
      { ifname: 'if40', ifindex: 90, address: '02:00:00:00:00:90' },
    ]).interfaceNames).not.toContain('if40');
  });

  it('accepts rygel only while one process start identity remains bound around command and executable reads', () => {
    const stable = () => ({ status: 'present', state: 'S', startTicks: '42' });
    expect(stableProcessCommandLine(7, {
      observeIdentity: stable, readCommandLine: () => '/usr/bin/rygel', readExecutable: () => '/usr/bin/rygel',
    })).toEqual({ commandLine: '/usr/bin/rygel', startTicks: '42' });
    const reused = [stable(), { status: 'present', state: 'S', startTicks: '43' }];
    expect(stableProcessCommandLine(7, {
      observeIdentity: () => reused.shift() ?? { status: 'error' },
      readCommandLine: () => '/usr/bin/rygel', readExecutable: () => '/usr/bin/rygel',
    })).toBeNull();
    expect(stableProcessCommandLine(7, {
      observeIdentity: stable, readCommandLine: () => '/usr/bin/rygel', readExecutable: () => '/tmp/rygel',
    })).toBeNull();
    const proof = { commandLine: '/usr/bin/rygel', startTicks: '42' };
    expect(processIdentityMatchesProof(proof, stable())).toBe(true);
    expect(processIdentityMatchesProof(proof, { status: 'present', state: 'S', startTicks: '43' })).toBe(false);
    expect(processIdentityMatchesProof(proof, { status: 'missing' })).toBe(false);
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
      containerId: 'a'.repeat(64), networkId, networkName, networkInternal: true, networkSubnets: ['192.168.96.0/20'], ip: '192.168.96.4' } };
    const container = { Id: policy.target.containerId, Config: { Labels: {
      'com.docker.compose.project': project, 'com.docker.compose.service': 'versitygw',
    } }, NetworkSettings: { Networks: { [networkName]: { NetworkID: networkId, IPAddress: policy.target.ip } } } };
    const network = { Id: networkId, Name: networkName, Internal: true, Driver: 'bridge',
      Labels: { 'com.docker.compose.project': project }, IPAM: { Config: [{ Subnet: '192.168.96.0/20', Gateway: '192.168.96.1' }] } };
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
    expect(source).toContain('wait_for_ambient_cleanup_release');
    expect(source).toContain('ambient Rygel listener did not release the disposable Docker interface before address reuse');
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
