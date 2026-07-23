import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const jointBaseSha = '37378056b29c73470813e59497175e62b1cfd35e';

export const requiredGate02bSteps = Object.freeze([
  { phase: 'V2', name: 'lint', command: ['pnpm', 'lint'] },
  { phase: 'V2', name: 'typecheck', command: ['pnpm', 'typecheck'] },
  { phase: 'V2', name: 'unit', command: ['pnpm', 'test'] },
  { phase: 'V2', name: 'worker-runtime-allowlist-tests', command: ['pnpm', 'exec', 'vitest', 'run', 'apps/worker/src/worker-loop.test.ts', 'packages/runtime/src/runtime.test.ts'] },
  { phase: 'V2', name: 'build', command: ['pnpm', 'build'] },
  { phase: 'V2', name: 'contracts', command: ['pnpm', 'test:contracts'] },
  { phase: 'V3', name: 'integration', command: ['pnpm', 'test:integration'], expectedWithStorageInvocations: 1, expectedStorageInvocations: 1, expectedE2eInvocations: 0 },
  { phase: 'V4', name: 'security', command: ['pnpm', 'test:security'], expectedWithStorageInvocations: 1, expectedStorageInvocations: 1, expectedE2eInvocations: 0 },
  { phase: 'V5', name: 'gate0.2b.2', command: ['pnpm', 'verify:gate0.2b.2'], expectedWithStorageInvocations: 4, expectedStorageInvocations: 2, expectedE2eInvocations: 2 },
  { phase: 'V6', name: 'gate0.2b.3', command: ['pnpm', 'verify:gate0.2b.3'], expectedWithStorageInvocations: 16, expectedStorageInvocations: 7, expectedE2eInvocations: 9, expectedBackupCases: 3 },
  { phase: 'V7', name: 'gate0.2a-baseline', command: ['pnpm', 'verify:gate0.2a'], inheritRunId: false, expectedWithStorageInvocations: 7, expectedStorageInvocations: 3, expectedE2eInvocations: 4, expectedBackupCases: 3 },
  { phase: 'V7', name: 'gate0.2b.1-baseline', command: ['pnpm', 'verify:gate0.2b.1'], expectedWithStorageInvocations: 3, expectedStorageInvocations: 2, expectedE2eInvocations: 1 },
  { phase: 'V7', name: 'local-a0-no-business-objects', command: ['pnpm', 'test:e2e', '--', '--project=gate0.2b-fast-chat-local'], expectedWithStorageInvocations: 1, expectedStorageInvocations: 0, expectedE2eInvocations: 1 },
]);

const forbiddenCommandPatterns = [
  /verify:gate-a0/iu,
  /gate-a0-live/iu,
  /gate-a0:lan/iu,
  /(?:start-e2e-model-gateway|start-gate-a0-release|run-gate-a0-lan)/iu,
  /(?:^|\s)(?:pnpm\s+)?(?:test:model-gateway|model-gateway:conformance)(?:\s|$)/iu,
  /(?:^|\s)(?:node|tsx|vitest)(?:\s|$)[^\n]*(?:services\/model-gateway|start-e2e-model-gateway)/iu,
  /(?:^|\s)provider(?:\s|$)/iu,
  /auth\.json/iu,
];
const strippedCredentialEnvironmentNames = [
  'GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE',
  'GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE',
  'GENEWAY_MODEL_GATEWAY_URL',
  'GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE',
  'GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE',
  'GENEWAY_GATE_A0_LIVE',
  'GENEWAY_GATE_A0_RELEASE_PORT',
  'GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CODEX_API_KEY',
];
const forbiddenPathPrefixes = [
  'services/model-gateway',
  'connectors/gearjob',
  'infra/hatchet',
  'apps/channel-gateway',
  'packages/evidence',
  'packages/authorization',
  'packages/storage',
];
const workerRuntimeAllowlist = new Set([
  'apps/worker/src/worker-loop.ts',
  'apps/worker/src/interpreter.ts',
  'apps/worker/src/worker-loop.test.ts',
  'packages/runtime/src/index.ts',
  'packages/runtime/src/runtime.test.ts',
]);
const ownedPathPrefixes = [
  'apps/control-plane', 'apps/web', 'packages/contracts', 'packages/ui', 'packages/workflow',
  'migrations', 'scripts',
  'doc/plans/atlas-workflow/20260723-022-geneway-gate-a-gate-0-2b-2-0-2b-3',
];
const ownedExactPaths = new Set(['package.json', 'pnpm-lock.yaml', 'README.md', 'AGENTS.md', ...workerRuntimeAllowlist]);
const safeChildEnvironmentNames = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'CI', 'NO_COLOR', 'FORCE_COLOR',
  'XDG_RUNTIME_DIR',
];
export const gate02bDockerIsolationEnvironment = Object.freeze({
  GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL: 'true',
  GENEWAY_GATE02B_COMPOSE_STORAGE_INTERNAL: 'true',
  GENEWAY_GATE02B_EGRESS_GUARD: 'required',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
});
const gate02bRequiredImages = [
  'postgres:17-alpine',
  'ghcr.io/versity/versitygw@sha256:7d56e0a6c246f00e2385ba4fe84065981959be1d822648f88a155c82e0e0652d',
  'node@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c',
  'geneway-backup-role:d993ca8c0a94f57d',
];
const credentialPayloadPatterns = [
  ['private-key', new RegExp(`BEGIN ${'PRIVATE'} KEY`, 'u')],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}/u],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/u],
];
const gate02bComposeServiceAllowlist = new Set([
  'postgres', 'versitygw', 'storage-adapter', 'storage-reconciliation-adapter', 'storage-reconciler',
  'storage-oracle', 'storage-provisioner',
]);
const procNetRetrySignal = new Int32Array(new SharedArrayBuffer(4));

function safeEnvironment() {
  const environment = {};
  for (const name of safeChildEnvironmentNames) {
    if (Object.hasOwn(process.env, name)) environment[name] = process.env[name];
  }
  environment.DOCKER_HOST = 'unix:///var/run/docker.sock';
  return environment;
}

export function findForbiddenEnvironmentNames(environmentNames) {
  return environmentNames.filter((name) => strippedCredentialEnvironmentNames.includes(name)
    || name.startsWith('GENEWAY_LAN_') || name.startsWith('GENEWAY_MODEL_GATEWAY_')
    || name.startsWith('GENEWAY_GATE_A0_RELEASE_')).sort();
}

function capture(command, options = {}) {
  return spawnSync(command[0], command.slice(1), {
    cwd: repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? safeEnvironment(),
  });
}

function successfulLines(command, label) {
  const result = capture(command);
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error(`Unable to capture ${label} receipt`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

export function validateGate02bStepPlan(steps) {
  const expected = requiredGate02bSteps.map((step) => ({
    phase: step.phase,
    name: step.name,
    command: [...step.command],
    inheritRunId: step.inheritRunId !== false,
    expectedWithStorageInvocations: step.expectedWithStorageInvocations ?? 0,
    expectedStorageInvocations: step.expectedStorageInvocations ?? 0,
    expectedE2eInvocations: step.expectedE2eInvocations ?? 0,
    expectedBackupCases: step.expectedBackupCases ?? 0,
  }));
  const actual = steps.map((step) => ({
    phase: step.phase,
    name: step.name,
    command: [...step.command],
    inheritRunId: step.inheritRunId !== false,
    expectedWithStorageInvocations: step.expectedWithStorageInvocations ?? 0,
    expectedStorageInvocations: step.expectedStorageInvocations ?? 0,
    expectedE2eInvocations: step.expectedE2eInvocations ?? 0,
    expectedBackupCases: step.expectedBackupCases ?? 0,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Gate 0.2B V2-V7 command membership or order changed');
  }
  validateGate02bCommandSafety(actual);
  return true;
}

export function validateGate02bCommandSafety(steps) {
  const forbidden = steps.flatMap((step) => {
    const rendered = step.command.join(' ');
    return forbiddenCommandPatterns.some((pattern) => pattern.test(rendered)) ? [rendered] : [];
  });
  if (forbidden.length > 0) throw new Error(`Gate 0.2B forbidden live/auth command detected:\n${forbidden.join('\n')}`);
  return true;
}

export function extractNestedVerifierCommands(source) {
  const start = source.indexOf('const steps = [');
  const end = source.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('Gate 0.2B nested verifier step list is missing');
  return [...source.slice(start, end).matchAll(/\[\s*'[^']+'\s*,\s*\[([^\]]+)\]\s*\]/gu)].map((match) => {
    const words = [...match[1].matchAll(/'([^']+)'/gu)].map((word) => word[1]);
    if (words.length === 0) throw new Error('Gate 0.2B nested verifier command is empty');
    return words.join(' ');
  });
}

export function collectReachableCommandStrings(packageScripts, rootCommands, nestedVerifierSources = {}) {
  const commands = [];
  const visitedScripts = new Set();
  const visit = (command) => {
    for (const segment of command.split(/\s*&&\s*/u).filter(Boolean)) {
      commands.push(segment);
      const scriptName = segment.match(/^pnpm\s+(?:run\s+)?([^\s]+)(?:\s|$)/u)?.[1];
      if (scriptName !== undefined && !['exec', 'run'].includes(scriptName)
        && Object.hasOwn(packageScripts, scriptName) && !visitedScripts.has(scriptName)) {
        visitedScripts.add(scriptName);
        visit(packageScripts[scriptName]);
      }
      const nodePath = segment.match(/^node\s+([^\s]+\.mjs)(?:\s|$)/u)?.[1];
      const nestedSource = nodePath === undefined ? undefined : nestedVerifierSources[nodePath];
      if (nestedSource !== undefined) for (const nestedCommand of extractNestedVerifierCommands(nestedSource)) visit(nestedCommand);
    }
  };
  for (const command of rootCommands) visit(command);
  return [...new Set(commands)];
}

export function gate02bInvocationTopology(packageScripts, steps, nestedVerifierSources = {}) {
  const terminalStorageScripts = new Set(['test:integration', 'test:storage', 'test:security']);
  const terminalE2eScripts = new Set(['test:e2e', 'test:recovery']);
  const expand = (command, stack = []) => {
    const total = { storage: 0, e2e: 0, backupCases: 0 };
    for (const segment of command.split(/\s*&&\s*/u).filter(Boolean)) {
      const scriptName = segment.match(/^pnpm\s+(?:run\s+)?([^\s]+)(?:\s|$)/u)?.[1];
      if (scriptName !== undefined && terminalStorageScripts.has(scriptName)) total.storage += 1;
      else if (scriptName !== undefined && terminalE2eScripts.has(scriptName)) total.e2e += 1;
      else if (scriptName === 'test:backup-restore') total.backupCases += 3;
      else if (scriptName !== undefined && !['exec', 'run'].includes(scriptName) && Object.hasOwn(packageScripts, scriptName)) {
        if (stack.includes(scriptName)) throw new Error(`Gate 0.2B package script recursion detected: ${scriptName}`);
        const nested = expand(packageScripts[scriptName], [...stack, scriptName]);
        total.storage += nested.storage; total.e2e += nested.e2e; total.backupCases += nested.backupCases;
      }
      const nodePath = segment.match(/^node\s+([^\s]+\.mjs)(?:\s|$)/u)?.[1];
      const nestedSource = nodePath === undefined ? undefined : nestedVerifierSources[nodePath];
      if (nestedSource !== undefined) for (const nestedCommand of extractNestedVerifierCommands(nestedSource)) {
        const nested = expand(nestedCommand, stack);
        total.storage += nested.storage; total.e2e += nested.e2e; total.backupCases += nested.backupCases;
      }
    }
    return total;
  };
  return steps.map((step) => {
    const total = expand(step.command.join(' '));
    return { phase: step.phase, name: step.name, storage: total.storage, e2e: total.e2e,
      withStorage: total.storage + total.e2e, backupCases: total.backupCases };
  });
}

export function validateGate02bInvocationTopology(packageScripts, steps, nestedVerifierSources = {}) {
  const topology = gate02bInvocationTopology(packageScripts, steps, nestedVerifierSources);
  for (const [index, item] of topology.entries()) {
    const step = steps[index];
    if (item.withStorage !== (step.expectedWithStorageInvocations ?? 0)
      || item.storage !== (step.expectedStorageInvocations ?? 0)
      || item.e2e !== (step.expectedE2eInvocations ?? 0)
      || item.backupCases !== (step.expectedBackupCases ?? 0)) {
      throw new Error(`Gate 0.2B invocation topology drifted for ${step.name}`);
    }
  }
  return topology;
}

function validateCommandStrings(commands) {
  validateGate02bCommandSafety(commands.map((command) => ({ command: command.split(/\s+/u) })));
  validateDockerIsolationCommandSafety(commands);
  return commands;
}

export function validateDockerIsolationCommandSafety(commands) {
  const overrides = commands.filter((command) => command.includes('GENEWAY_GATE02B_'));
  if (overrides.length > 0) throw new Error(`Gate 0.2B Docker isolation environment override/removal detected:\n${overrides.join('\n')}`);
  return true;
}

function prepareDockerIsolation(outputRoot) {
  const images = gate02bRequiredImages.map((reference) => {
    const inspected = capture(['docker', 'image', 'inspect', reference, '--format', '{{.Id}}']);
    if (inspected.status !== 0 || typeof inspected.stdout !== 'string' || inspected.stdout.trim() === '') {
      throw new Error(`Gate 0.2B required offline image is missing: ${reference}`);
    }
    return { reference, id: inspected.stdout.trim() };
  });
  const libraryPath = `${outputRoot}/gate02b-egress-guard.so`;
  const compiled = capture(['cc', '-std=gnu17', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-ldl',
    '-o', libraryPath, 'scripts/backup-restore/gate02b-egress-guard.c']);
  if (compiled.status !== 0) throw new Error('Gate 0.2B egress guard compilation failed');
  return { checked: true, passed: true, pullPolicy: 'never', images, libraryPath };
}

export function validateDockerStructuralIsolationReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object' || receipt.checked !== true || receipt.eventMonitor?.checked !== true
    || receipt.eventMonitor?.passed !== true || !Array.isArray(receipt.observedContainers)
    || !Array.isArray(receipt.observedNetworks) || !Array.isArray(receipt.violations) || receipt.violations.length > 0
    || receipt.passed !== true) {
    throw new Error('Gate 0.2B Docker structural isolation receipt is missing or failed');
  }
  return true;
}

export function sourceBindingsMatch(initial, final) {
  return initial.head === final.head
    && initial.workspaceSha256 === final.workspaceSha256
    && initial.fileCount === final.fileCount;
}

export function validateCleanupReceipt(receipt) {
  const categories = ['processes', 'listeners', 'globalListeners', 'egress', 'containers', 'workerSockets'];
  if (receipt === null || typeof receipt !== 'object' || receipt.checked !== true) {
    throw new Error('Gate 0.2B cleanup receipt is missing');
  }
  for (const category of categories) {
    const item = receipt[category];
    if (item === null || typeof item !== 'object' || item.checked !== true || item.passed !== true
      || !Array.isArray(item.added)) {
      throw new Error(`Gate 0.2B cleanup receipt is incomplete for ${category}`);
    }
  }
  return true;
}

export function validateProcessLifecycleReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object' || receipt.checked !== true || receipt.passed !== true
    || !Array.isArray(receipt.identities) || !Array.isArray(receipt.survivors) || receipt.survivors.length > 0
    || !Array.isArray(receipt.addedEndpoints) || receipt.addedEndpoints.length > 0
    || !Array.isArray(receipt.sampleErrors) || receipt.sampleErrors.length > 0
    || !Array.isArray(receipt.beforeGlobalListeners) || !Array.isArray(receipt.afterGlobalListeners)) {
    throw new Error('Gate 0.2B process/listener lifecycle receipt is missing or failed');
  }
  return true;
}

export function gate02bAggregatePassed({ results, sourceStable, cleanupReceipts, childEvidencePassed, secretReceiptsPassed }) {
  try {
    for (const receipt of cleanupReceipts) validateCleanupReceipt(receipt);
  } catch {
    return false;
  }
  return sourceStable === true
    && childEvidencePassed === true
    && secretReceiptsPassed === true
    && results.length === requiredGate02bSteps.length
    && cleanupReceipts.length === requiredGate02bSteps.length + 1
    && results.every((result) => result.status === 0 && result.signal === null
      && result.sourceBinding?.stable === true && result.runtimeBoundary?.passed === true
      && result.runtimeBoundary?.structuralIsolation?.passed === true
      && result.runtimeBoundary?.processLifecycle?.passed === true
      && result.credentialBoundary?.checked === true && result.credentialBoundary?.passed === true
      && result.credentialBoundary?.forbiddenNamesPassed?.length === 0
      && result.dockerIsolationEnvironment?.passed === true);
}

function sourceBinding() {
  const listed = capture(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'buffer' });
  if (listed.status !== 0 || !Buffer.isBuffer(listed.stdout)) throw new Error('Unable to enumerate Gate 0.2B source files');
  const files = listed.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const file of files) {
    const absolute = resolve(repositoryRoot, file);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Gate 0.2B source candidate is not a regular file: ${file}`);
    const bytes = readFileSync(absolute);
    digest.update(`${Buffer.byteLength(file, 'utf8')}:${file}:${String(bytes.byteLength)}:`);
    digest.update(bytes);
  }
  const head = capture(['git', 'rev-parse', 'HEAD']);
  if (head.status !== 0 || typeof head.stdout !== 'string') throw new Error('Unable to resolve Gate 0.2B source HEAD');
  return { head: head.stdout.trim(), workspaceSha256: digest.digest('hex'), fileCount: files.length };
}

function changedPathAudit() {
  const baseExists = capture(['git', 'cat-file', '-e', `${jointBaseSha}^{commit}`]);
  const baseIsAncestor = capture(['git', 'merge-base', '--is-ancestor', jointBaseSha, 'HEAD']);
  if (baseExists.status !== 0 || baseIsAncestor.status !== 0) {
    throw new Error(`Gate 0.2B joint base is missing or is not an ancestor of HEAD: ${jointBaseSha}`);
  }
  const diff = capture(['git', 'diff', '--name-only', jointBaseSha, '--']);
  const untracked = capture(['git', 'ls-files', '--others', '--exclude-standard']);
  if (diff.status !== 0 || untracked.status !== 0 || typeof diff.stdout !== 'string' || typeof untracked.stdout !== 'string') {
    throw new Error('Unable to enumerate Gate 0.2B changed paths');
  }
  const changedPaths = [...new Set(`${diff.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean))].sort();
  const outsideOwnedPaths = changedPaths.filter((file) => !ownedExactPaths.has(file)
    && !ownedPathPrefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
  const forbiddenChangedPaths = changedPaths.filter((file) =>
    forbiddenPathPrefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
    || ((file.startsWith('apps/worker/') || file.startsWith('packages/runtime/')) && !workerRuntimeAllowlist.has(file)));
  if (outsideOwnedPaths.length > 0 || forbiddenChangedPaths.length > 0) {
    throw new Error(`Gate 0.2B path authority diff detected from ${jointBaseSha}:\n${[...outsideOwnedPaths, ...forbiddenChangedPaths].join('\n')}`);
  }
  return { baseSha: jointBaseSha, baseExists: true, baseIsAncestor: true, changedPaths, outsideOwnedPaths,
    forbiddenChangedPaths, workerRuntimeAllowlist: [...workerRuntimeAllowlist].sort(), passed: true };
}

function secretScan(paths) {
  const findings = [];
  for (const path of paths) {
    const absolute = resolve(repositoryRoot, path);
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Gate 0.2B secret-scan candidate is not a regular file: ${path}`);
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const [kind, pattern] of credentialPayloadPatterns) if (pattern.test(text)) findings.push({ path, kind });
  }
  if (findings.length > 0) throw new Error(`Gate 0.2B candidate secret scan failed:\n${findings.map((item) => `${item.path}:${item.kind}`).join('\n')}`);
  return { checked: true, authContentRead: false, scannedPaths: paths, findings, passed: true };
}

export function validateArtifactRoots(roots) {
  if (!Array.isArray(roots)) throw new Error('Gate 0.2B artifact roots must be an array');
  const normalized = [...new Set(roots.map((root) => resolve(root)))].sort((left, right) => left.length - right.length);
  if (normalized.length === 0 || normalized.some((root) => root === '/tmp/geneway-runs' || !root.startsWith('/tmp/geneway-runs/'))) {
    throw new Error('Gate 0.2B artifact root is outside the bounded run directory');
  }
  return normalized.filter((root, index) => !normalized.some((parent, parentIndex) => parentIndex < index && root.startsWith(`${parent}/`)));
}

function runArtifactSecretScan(roots) {
  const boundedRoots = validateArtifactRoots(roots);
  const findings = [];
  const scannedPaths = [];
  const exclusions = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Gate 0.2B run artifact symlink detected: ${path}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(resolve(path, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`Gate 0.2B run artifact is not a regular file: ${path}`);
    if (stat.size > 64 * 1024 * 1024) { exclusions.push({ path, reason: 'size-over-64MiB' }); return; }
    const bytes = readFileSync(path);
    if (bytes.includes(0)) { exclusions.push({ path, reason: 'binary' }); return; }
    scannedPaths.push(path);
    const text = bytes.toString('utf8');
    for (const [kind, pattern] of credentialPayloadPatterns) if (pattern.test(text)) findings.push({ path, kind });
  };
  for (const root of boundedRoots) visit(root);
  if (findings.length > 0) throw new Error(`Gate 0.2B run artifact secret scan failed:\n${findings.map((item) => `${item.path}:${item.kind}`).join('\n')}`);
  return { checked: true, authPathAccessed: false, roots: boundedRoots, scannedPaths: scannedPaths.sort(), exclusions, findings, passed: true };
}

function ancestorPids() {
  const ancestors = new Set();
  let pid = process.pid;
  while (pid > 1 && !ancestors.has(pid)) {
    ancestors.add(pid);
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u);
      pid = Number(fields[1] ?? '0');
    } catch {
      break;
    }
  }
  return ancestors;
}

export function isGateAuthorityPath(path) {
  return /^\/tmp\/gw-(?:uds|mgw)-[^/]+(?:\/[^/]+)?$/u.test(path);
}

export function gateAuthorityRootNames(entries) {
  return entries.filter((name) => /^gw-(?:uds|mgw)-[^/]+$/u.test(name)).sort();
}

function gateAuthorityPaths() {
  const roots = gateAuthorityRootNames(readdirSync('/tmp')).map((name) => resolve('/tmp', name));
  const paths = [];
  for (const root of roots) {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`Gate 0.2B worker authority root is unsafe: ${root}`);
    }
    paths.push(root);
    for (const name of readdirSync(root)) {
      const child = resolve(root, name);
      if (dirname(child) !== root || !isGateAuthorityPath(child)) {
        throw new Error(`Gate 0.2B worker authority child escaped its root: ${child}`);
      }
      const childStat = lstatSync(child);
      if (childStat.isSymbolicLink()) throw new Error(`Gate 0.2B worker authority child is a symlink: ${child}`);
      paths.push(child);
    }
  }
  return paths.sort();
}

function repositoryProcesses() {
  const ancestors = ancestorPids();
  const found = [];
  for (const entry of readdirSync('/proc').filter((name) => /^\d+$/u.test(name))) {
    const pid = Number(entry);
    if (ancestors.has(pid)) continue;
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      if (cwd !== repositoryRoot && !cwd.startsWith(`${repositoryRoot}/`)) continue;
      const command = readFileSync(`/proc/${entry}/comm`, 'utf8').trim();
      found.push({ pid, command });
    } catch {
      // Processes can exit between /proc enumeration and inspection.
    }
  }
  return found.sort((left, right) => left.pid - right.pid);
}

function processTable() {
  const table = [];
  for (const entry of readdirSync('/proc').filter((name) => /^\d+$/u.test(name))) {
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u);
      const commandLine = readFileSync(`/proc/${entry}/cmdline`).toString('utf8').split('\0').filter(Boolean).join(' ');
      table.push({ pid: Number(entry), parentPid: Number(fields[1] ?? '0'), startTicks: fields[19] ?? 'unknown',
        command: readFileSync(`/proc/${entry}/comm`, 'utf8').trim(), commandLine });
    } catch {
      // Processes can exit while the descendant table is sampled.
    }
  }
  return table;
}

function descendantProcesses(rootPid) {
  const table = processTable();
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of table) if (descendants.has(item.parentPid) && !descendants.has(item.pid)) {
      descendants.add(item.pid);
      changed = true;
    }
  }
  return table.filter((item) => descendants.has(item.pid));
}

export function parseSocketLine(line, kind) {
  const fields = line.trim().split(/\s+/u);
  const localIndex = kind === 'egress' ? 2 : 3;
  const peerIndex = kind === 'egress' ? 3 : 4;
  return {
    local: fields[localIndex] ?? 'unknown-local',
    peer: fields[peerIndex] ?? 'unknown-peer',
    pids: [...line.matchAll(/pid=(\d+)/gu)].map((match) => Number(match[1])),
  };
}

function socketLinesForProcesses(command, processes, kind) {
  const processIds = new Set(processes.map((item) => item.pid));
  return successfulLines(command, kind).flatMap((line) => {
    const parsed = parseSocketLine(line, kind);
    const pids = parsed.pids.filter((pid) => processIds.has(pid));
    if (pids.length === 0) return [];
    return pids.map((pid) => `${parsed.local}${kind === 'egress' ? `->${parsed.peer}` : ''} pid=${String(pid)}`);
  }).sort();
}

function globalListenerLines() {
  return successfulLines(['ss', '-H', '-ltnp'], 'global listener').map((line) => {
    const parsed = parseSocketLine(line, 'listener');
    return `${parsed.local} pids=${parsed.pids.sort((left, right) => left - right).join(',')}`;
  }).sort();
}

function processCommandLine(pid) {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`).toString('utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return null;
  }
}

export function stableProcessCommandLine(pid, dependencies = {}) {
  const observeIdentity = dependencies.observeIdentity ?? processIdentityObservation;
  const readCommandLine = dependencies.readCommandLine ?? processCommandLine;
  const readExecutable = dependencies.readExecutable ?? ((candidate) => readlinkSync(`/proc/${String(candidate)}/exe`));
  const before = observeIdentity(pid);
  if (before?.status !== 'present' || before.state?.startsWith('Z')) return null;
  try {
    const commandLine = readCommandLine(pid);
    const executable = readExecutable(pid);
    const after = observeIdentity(pid);
    if (after?.status !== 'present' || after.state?.startsWith('Z') || after.startTicks !== before.startTicks
      || executable !== '/usr/bin/rygel' || commandLine !== '/usr/bin/rygel') return null;
    return { commandLine, startTicks: before.startTicks };
  } catch {
    return null;
  }
}

export function processIdentityMatchesProof(proof, observation) {
  return proof?.commandLine === '/usr/bin/rygel' && /^[1-9][0-9]*$/u.test(proof.startTicks ?? '')
    && observation?.status === 'present' && !observation.state?.startsWith('Z')
    && observation.startTicks === proof.startTicks;
}

export function isInternalDockerAdapterListener(line, context, commandLines) {
  const match = line.match(/^(\S+) pids=([1-9][0-9]*)$/u);
  if (match === null) return false;
  const pid = Number(match[2]);
  const commandLine = commandLines instanceof Map ? commandLines.get(pid) : commandLines?.[String(pid)];
  if (commandLine !== '/usr/bin/rygel') return false;
  const ipv4 = match[1].match(/^(\d+\.\d+\.\d+\.\d+):([1-9][0-9]*)$/u);
  const scopedIpv6 = match[1].match(/^\[(fe80:[0-9a-f:]+)\]%([A-Za-z0-9_.-]+):([1-9][0-9]*)$/iu);
  const port = Number(ipv4?.[2] ?? scopedIpv6?.[3] ?? 0);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || [3150, 3450].includes(port)) return false;
  if (ipv4 !== null) return context.gatewayAddresses.includes(ipv4[1]);
  return scopedIpv6 !== null && context.interfaceNames.includes(scopedIpv6[2]);
}

export function unreachableCachedDockerNetworkContext(network, liveLinks) {
  const assignedAddresses = new Set(liveLinks.flatMap((link) => (link.addr_info ?? [])
    .flatMap((address) => typeof address.local === 'string' ? [address.local] : [])));
  const identityIsAbsent = (name, identity) => identity !== undefined && !liveLinks.some((link) =>
    link.ifname === name || link.ifname === `if${String(identity.ifindex)}`
      || link.ifindex === identity.ifindex || link.address === identity.address);
  const gatewayAddresses = [...(network.gatewayAddresses ?? [])]
    .filter((gateway) => !assignedAddresses.has(gateway));
  const interfaceNames = [];
  if (typeof network.bridgeName === 'string' && identityIsAbsent(network.bridgeName, network.bridgeIdentity)) {
    interfaceNames.push(network.bridgeName, `if${String(network.bridgeIdentity.ifindex)}`);
  }
  for (const [name, identity] of network.memberIdentities ?? []) {
    if (identityIsAbsent(name, identity)) interfaceNames.push(name, `if${String(identity.ifindex)}`);
  }
  return { gatewayAddresses: [...new Set(gatewayAddresses)].sort(), interfaceNames: [...new Set(interfaceNames)].sort() };
}

export function unresolvedUnsafeListeners(observations) {
  return [...new Set(observations.flatMap((observation) => observation.unsafe))].sort();
}

function dockerJson(command) {
  const result = capture(command);
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function repositoryDockerBoundaryResources() {
  const resources = [];
  for (const id of successfulLines(['docker', 'ps', '-aq'], 'repository container')) {
    const inspected = dockerJson(['docker', 'container', 'inspect', id]);
    const container = Array.isArray(inspected) ? inspected[0] : undefined;
    const name = typeof container?.Name === 'string' ? container.Name.replace(/^\//u, '') : id;
    if (container !== undefined && isRepositoryDockerScope(name, container.Config?.Labels ?? {})) resources.push(`container:${name}:${container.Id}`);
  }
  for (const id of successfulLines(['docker', 'network', 'ls', '-q'], 'repository network')) {
    const inspected = dockerJson(['docker', 'network', 'inspect', id]);
    const network = Array.isArray(inspected) ? inspected[0] : undefined;
    if (network !== undefined && isRepositoryDockerScope(network.Name, network.Labels ?? {})) resources.push(`network:${network.Name}:${network.Id}`);
  }
  for (const name of successfulLines(['docker', 'volume', 'ls', '-q'], 'repository volume')) {
    const inspected = dockerJson(['docker', 'volume', 'inspect', name]);
    const volume = Array.isArray(inspected) ? inspected[0] : undefined;
    if (volume !== undefined && isRepositoryDockerScope(volume.Name, volume.Labels ?? {})) resources.push(`volume:${volume.Name}`);
  }
  return resources.sort();
}

function createDockerObservation() {
  return { containers: new Map(), networks: new Map(), eventCount: 0, eventParseErrors: [], monitorErrors: [],
    monitorStarted: false, eventBoundaryMs: Date.now() };
}

export function observedDockerContainer(containers, observedId, name) {
  const validId = (value) => typeof value === 'string' && /^(?:[a-f0-9]{12}|[a-f0-9]{64})$/u.test(value);
  if (!validId(observedId)) return undefined;
  const exact = containers.get(observedId);
  if (exact !== undefined && (typeof name !== 'string' || exact.name === name)) return exact;
  if (typeof name !== 'string') return undefined;
  return [...containers.values()].find((container) =>
    (validId(container.id) && container.id.length !== observedId.length
      && (container.id.startsWith(observedId) || observedId.startsWith(container.id)))
    && container.name === name);
}

export function storeObservedDockerContainer(state, container) {
  const occupied = state.containers.get(container.id);
  if (occupied !== undefined && occupied !== container) throw new Error('Docker container identity key conflict');
  const identityKeys = [...state.containers].filter(([, value]) => value === container).map(([key]) => key);
  const candidates = [...new Set([...identityKeys, container.id])];
  const fullIds = candidates.filter((value) => /^[a-f0-9]{64}$/u.test(value));
  if (fullIds.length > 1 || (fullIds.length === 1 && candidates.some((value) =>
    /^[a-f0-9]{12}$/u.test(value) && !fullIds[0].startsWith(value)))) {
    throw new Error('Docker container identity correlation conflict');
  }
  if (fullIds.length === 1) container.id = fullIds[0];
  for (const key of identityKeys) if (key !== container.id) state.containers.delete(key);
  state.containers.set(container.id, container);
}

function scopedDockerName(name) {
  return typeof name === 'string' && name.startsWith('geneway-');
}

export function isRepositoryDockerScope(name, labels = {}) {
  const configFiles = labels['com.docker.compose.project.config_files'];
  const workingDirectory = labels['com.docker.compose.project.working_dir'];
  const composeProject = labels['com.docker.compose.project'];
  const knownDefaultProjects = ['scripts', 'backup-restore'];
  const normalizedRepositoryRoot = resolve(repositoryRoot);
  const withinRepository = (path) => {
    if (!isAbsolute(path)) return false;
    const normalized = resolve(path);
    return normalized === normalizedRepositoryRoot || normalized.startsWith(`${normalizedRepositoryRoot}/`);
  };
  const exactProjectName = typeof name === 'string' && knownDefaultProjects.some((project) =>
    name.startsWith(`${project}_`));
  return scopedDockerName(name) || knownDefaultProjects.includes(composeProject)
    || (typeof composeProject !== 'string' && exactProjectName)
    || (typeof workingDirectory === 'string' && withinRepository(workingDirectory))
    || (typeof configFiles === 'string' && configFiles.split(',').map((path) => path.trim()).filter(Boolean).some(withinRepository));
}

function observeDockerNetwork(state, identity) {
  if (typeof identity !== 'string' || identity.length === 0) return;
  const inspected = dockerJson(['docker', 'network', 'inspect', identity]);
  const network = Array.isArray(inspected) ? inspected[0] : undefined;
  const name = network?.Name;
  if (network === undefined || (!isRepositoryDockerScope(name, network.Labels ?? {}) && !scopedDockerName(identity))) return;
  const id = network.Id ?? identity;
  const existing = state.networks.get(id)
    ?? { id, gatewayAddresses: new Set(), interfaceNames: new Set(), memberIdentities: new Map() };
  existing.name = name ?? identity;
  existing.internal = network.Internal === true;
  existing.driver = network.Driver ?? null;
  existing.inspectObserved = true;
  existing.project = network.Labels?.['com.docker.compose.project'] ?? null;
  existing.subnets = (network.IPAM?.Config ?? []).flatMap((config) => typeof config.Subnet === 'string' ? [config.Subnet] : []);
  for (const config of network.IPAM?.Config ?? []) {
    if (typeof config.Gateway === 'string') existing.gatewayAddresses.add(config.Gateway);
  }
  if (existing.internal && existing.driver === 'bridge') {
    const configuredBridge = network.Options?.['com.docker.network.bridge.name'];
    const bridgeName = typeof configuredBridge === 'string' && configuredBridge.length > 0
      ? configuredBridge : `br-${id.slice(0, 12)}`;
    existing.bridgeName = bridgeName;
    for (const [index, command] of [['ip', '-j', 'link', 'show', 'dev', bridgeName],
      ['ip', '-j', 'link', 'show', 'master', bridgeName]].entries()) {
      const result = capture(command);
      if (result.status !== 0 || typeof result.stdout !== 'string') continue;
      try {
        for (const link of JSON.parse(result.stdout)) {
          if (typeof link.ifname !== 'string' || !Number.isInteger(link.ifindex) || typeof link.address !== 'string') continue;
          const linkIdentity = { ifindex: link.ifindex, address: link.address };
          if (index === 0 && link.ifname === bridgeName) {
            if (existing.bridgeIdentity !== undefined
              && JSON.stringify(existing.bridgeIdentity) !== JSON.stringify(linkIdentity)) {
              existing.identityConflict = true;
              continue;
            }
            existing.bridgeIdentity = linkIdentity;
          } else if (index === 1) {
            const prior = existing.memberIdentities.get(link.ifname);
            if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(linkIdentity)) {
              existing.identityConflict = true;
              continue;
            }
            existing.memberIdentities.set(link.ifname, linkIdentity);
          }
          existing.interfaceNames.add(link.ifname);
        }
      } catch {
        // A partial link snapshot cannot add trusted interface evidence.
      }
    }
  }
  state.networks.set(id, existing);
}

function processIdentityObservation(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u);
    const state = fields[0];
    const startTicks = fields[19];
    if (typeof state !== 'string' || !/^[1-9][0-9]*$/u.test(startTicks ?? '')) return { status: 'error' };
    return { status: 'present', state, startTicks };
  } catch (cause) {
    return cause?.code === 'ENOENT' ? { status: 'missing' } : { status: 'error' };
  }
}

export function readProcNetSnapshot(path, pid, expectedStartTicks, dependencies = {}) {
  const read = dependencies.read ?? ((candidate) => readFileSync(candidate, 'utf8'));
  const observeIdentity = dependencies.observeIdentity ?? processIdentityObservation;
  const wait = dependencies.wait ?? (() => Atomics.wait(procNetRetrySignal, 0, 0, 1));
  const identityDisposition = (identity) => {
    if (!/^[1-9][0-9]*$/u.test(expectedStartTicks ?? '') || identity?.status === 'error') return 'error';
    if (identity?.status === 'missing' || (identity?.status === 'present'
      && (identity.state?.startsWith('Z') || identity.startTicks !== expectedStartTicks))) return 'exited';
    return identity?.status === 'present' ? 'bound' : 'error';
  };
  const identityFailure = () => new Error('proc-net process identity could not be bound');
  let failure;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before = identityDisposition(observeIdentity(pid));
    if (before === 'exited') return { text: null, failure: null, exited: true, attempts: attempt };
    if (before !== 'bound') return { text: null, failure: identityFailure(), exited: false, attempts: attempt };
    try {
      const text = read(path);
      const after = identityDisposition(observeIdentity(pid));
      if (after === 'exited') return { text: null, failure: null, exited: true, attempts: attempt };
      if (after !== 'bound') return { text: null, failure: identityFailure(), exited: false, attempts: attempt };
      return { text, failure: null, exited: false, attempts: attempt };
    } catch (cause) {
      failure = cause;
      if (cause?.code !== 'ENOENT') return { text: null, failure, exited: false, attempts: attempt };
      const after = identityDisposition(observeIdentity(pid));
      if (after === 'exited') return { text: null, failure, exited: true, attempts: attempt };
      if (after !== 'bound') return { text: null, failure: identityFailure(), exited: false, attempts: attempt };
      if (attempt === 3) return { text: null, failure, exited: false, attempts: attempt };
      wait();
    }
  }
  return { text: null, failure, exited: false, attempts: 3 };
}

export function networkAttachmentsAfterInspect(previous, container) {
  if (container === undefined) return previous;
  const entries = Object.entries(container.NetworkSettings?.Networks ?? {});
  if (entries.length === 0) return previous;
  const merged = new Map(previous.map((attachment) => [attachment.name, attachment]));
  for (const [name, attachment] of entries) {
    const prior = merged.get(name);
    merged.set(name, { name, id: attachment?.NetworkID || prior?.id || null, ip: attachment?.IPAddress || prior?.ip || null });
  }
  return [...merged.values()];
}

export function publishedPortsAfterInspect(previous, container) {
  if (container === undefined) return previous;
  const observed = Object.values(container.NetworkSettings?.Ports ?? {}).flatMap((bindings) => Array.isArray(bindings)
    ? bindings.map((binding) => ({ hostIp: binding.HostIp, hostPort: binding.HostPort })) : []);
  return [...new Map([...previous, ...observed].map((binding) => [JSON.stringify(binding), binding])).values()];
}

function observeDockerContainer(state, identity, fallbackName) {
  const inspected = dockerJson(['docker', 'container', 'inspect', identity]);
  const container = Array.isArray(inspected) ? inspected[0] : undefined;
  const name = typeof container?.Name === 'string' ? container.Name.replace(/^\//u, '') : fallbackName;
  if (!isRepositoryDockerScope(name, container?.Config?.Labels ?? {})) return;
  const observedId = container?.Id ?? identity;
  const existing = observedDockerContainer(state.containers, observedId, name)
    ?? { id: observedId, name, networkIds: new Set(), networkNames: new Set(), inspectObserved: false };
  if (container?.Id !== undefined) existing.id = container.Id;
  existing.repositoryScoped = true;
  existing.inspectObserved ||= container !== undefined;
  existing.service = container?.Config?.Labels?.['com.docker.compose.service'] ?? existing.service ?? null;
  existing.project = container?.Config?.Labels?.['com.docker.compose.project'] ?? existing.project ?? null;
  existing.backupRun = container?.Config?.Labels?.['geneway.backup.run'] ?? existing.backupRun ?? null;
  existing.backupRole = container?.Config?.Labels?.['geneway.backup.role'] ?? existing.backupRole ?? null;
  existing.backupAction = container?.Config?.Labels?.['geneway.backup.action'] ?? existing.backupAction ?? null;
  existing.egressReceiptPath = container?.Config?.Labels?.['geneway.gate02b.egress_receipt'] ?? existing.egressReceiptPath ?? null;
  const allowedPortsEntry = (container?.Config?.Env ?? []).find((entry) => entry.startsWith('GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS='));
  existing.egressAllowedPorts = allowedPortsEntry?.split('=').slice(1).join(',').split(',').filter(Boolean) ?? existing.egressAllowedPorts ?? [];
  existing.networkMode = container?.HostConfig?.NetworkMode ?? existing.networkMode ?? null;
  existing.extraHosts = container?.HostConfig?.ExtraHosts ?? existing.extraHosts ?? [];
  if (container?.State?.Running === true && Number.isInteger(container.State.Pid) && container.State.Pid > 0) {
    existing.pid = container.State.Pid;
    const processIdentity = processIdentityObservation(container.State.Pid);
    existing.pidStartTicks = processIdentity.status === 'present' ? processIdentity.startTicks : null;
  }
  existing.publishedPorts = publishedPortsAfterInspect(existing.publishedPorts ?? [], container);
  if (container !== undefined) {
    existing.networkAttachments = networkAttachmentsAfterInspect(existing.networkAttachments ?? [], container);
    for (const attachment of existing.networkAttachments) {
      existing.networkNames.add(attachment.name);
      if (typeof attachment.id === 'string' && attachment.id.length > 0) existing.networkIds.add(attachment.id);
      observeDockerNetwork(state, attachment.id || attachment.name);
    }
  }
  if (container?.State?.Running === true && Number.isInteger(container.State.Pid) && container.State.Pid > 0) {
    existing.netnsAttempted = true;
    existing.netnsSockets ??= [];
    existing.netnsErrors ??= [];
    for (const [protocol, file] of [['tcp', 'tcp'], ['tcp6', 'tcp6'], ['udp', 'udp'], ['udp6', 'udp6']]) {
      const path = `/proc/${String(container.State.Pid)}/net/${file}`;
      const snapshot = readProcNetSnapshot(path, container.State.Pid, existing.pidStartTicks);
      if (snapshot.text !== null) {
        try { existing.netnsSockets.push(...parseProcNetSockets(snapshot.text, protocol)); } catch (cause) {
          existing.netnsErrors.push(`${protocol}:${cause instanceof Error ? cause.message : String(cause)}`);
        }
      } else if (!snapshot.exited) {
        existing.netnsErrors.push(`${protocol}:${snapshot.failure instanceof Error ? snapshot.failure.message : String(snapshot.failure)}`);
      }
    }
  }
  storeObservedDockerContainer(state, existing);
}

function observeDockerResources(state) {
  const containers = successfulLines(['docker', 'ps', '-a', '--format', '{{.ID}} {{.Names}}'], 'runtime containers');
  for (const line of containers) {
    const [id, name] = line.split(/\s+/u);
    if (id !== undefined) observeDockerContainer(state, id, name);
  }
  const networks = successfulLines(['docker', 'network', 'ls', '--format', '{{.ID}} {{.Name}}'], 'runtime networks');
  for (const line of networks) {
    const [id, name] = line.split(/\s+/u);
    if (id !== undefined) observeDockerNetwork(state, id);
  }
}

function recordDockerEvent(state, event) {
  const eventMs = typeof event.timeNano === 'number' ? event.timeNano / 1_000_000
    : typeof event.TimeNano === 'number' ? event.TimeNano / 1_000_000 : null;
  if (eventMs !== null && eventMs < state.eventBoundaryMs) return;
  state.eventCount += 1;
  const type = event.Type ?? event.type;
  const action = event.Action ?? event.action;
  const actor = event.Actor ?? event.actor ?? {};
  const attributes = actor.Attributes ?? actor.attributes ?? {};
  const identity = actor.ID ?? actor.id;
  const name = attributes.name;
  if (type === 'container' && isRepositoryDockerScope(name, attributes)) {
    const existing = observedDockerContainer(state.containers, identity, name)
      ?? { id: identity, name, networkIds: new Set(), networkNames: new Set(), inspectObserved: false };
    existing.id = identity;
    existing.repositoryScoped = true;
    existing.eventObserved = true;
    existing.service = attributes['com.docker.compose.service'] ?? existing.service ?? null;
    existing.project = attributes['com.docker.compose.project'] ?? existing.project ?? null;
    existing.backupRun = attributes['geneway.backup.run'] ?? existing.backupRun ?? null;
    existing.backupRole = attributes['geneway.backup.role'] ?? existing.backupRole ?? null;
    existing.backupAction = attributes['geneway.backup.action'] ?? existing.backupAction ?? null;
    existing.egressReceiptPath = attributes['geneway.gate02b.egress_receipt'] ?? existing.egressReceiptPath ?? null;
    if (action === 'die') existing.exitCode = attributes.exitCode ?? null;
    storeObservedDockerContainer(state, existing);
    if (action !== 'destroy') observeDockerContainer(state, identity, name);
  }
  if (type === 'network' && isRepositoryDockerScope(name, attributes)) {
    if (action !== 'destroy') observeDockerNetwork(state, identity || name);
    const containerId = attributes.container;
    if (action === 'connect' && typeof containerId === 'string') {
      const observedName = attributes.container_name;
      const existing = observedDockerContainer(state.containers, containerId, observedName);
      if (existing === undefined && observedName === undefined) return;
      const container = existing
        ?? { id: containerId, name: observedName, networkIds: new Set(), networkNames: new Set(), inspectObserved: false };
      container.id = containerId;
      container.networkIds.add(identity);
      container.networkNames.add(name);
      storeObservedDockerContainer(state, container);
    }
  }
}

function parseProcNetIpv4(hex) {
  if (!/^[0-9A-F]{8}$/iu.test(hex)) throw new Error(`invalid IPv4 socket address: ${hex}`);
  return [6, 4, 2, 0].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join('.');
}

export function parseProcNetSockets(text, protocol) {
  const sockets = [];
  for (const line of text.trim().split('\n').slice(1).filter(Boolean)) {
    const fields = line.trim().split(/\s+/u);
    const remote = fields[2];
    const state = fields[3];
    if (remote === undefined || state === undefined || !remote.includes(':')) throw new Error(`invalid ${protocol} socket row`);
    const [remoteHex, portHex] = remote.split(':');
    if (remoteHex === undefined || portHex === undefined || !/^[0-9A-F]{4}$/iu.test(portHex)) throw new Error(`invalid ${protocol} remote endpoint`);
    const remotePort = Number.parseInt(portHex, 16);
    let remoteAddress;
    if (protocol.endsWith('6')) {
      if (!/^[0-9A-F]{32}$/iu.test(remoteHex)) throw new Error(`invalid ${protocol} IPv6 address`);
      const normalized = [...remoteHex.matchAll(/[0-9A-F]{8}/giu)].map((chunk) =>
        [...chunk[0].matchAll(/[0-9A-F]{2}/giu)].map((byte) => byte[0]).reverse().join('')).join('').toUpperCase();
      const mapped = normalized.match(/^0{20}FFFF([0-9A-F]{8})$/u)?.[1];
      remoteAddress = /^0+$/u.test(normalized) ? '::' : /^0{31}1$/u.test(normalized) ? '::1'
        : mapped === undefined ? normalized
          : [0, 2, 4, 6].map((offset) => Number.parseInt(mapped.slice(offset, offset + 2), 16)).join('.');
    } else remoteAddress = parseProcNetIpv4(remoteHex);
    if (state === '01' || (protocol.startsWith('udp') && remotePort !== 0)) sockets.push({ protocol, remoteAddress, remotePort, state });
  }
  return sockets;
}

function ipv4InCidr(address, cidr) {
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (network === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const toInteger = (value) => value.split('.').reduce((total, octet) => (total << 8) + Number(octet), 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (toInteger(address) & mask) === (toInteger(network) & mask);
}

function startDockerEventMonitor(state) {
  const since = String(Math.floor(Date.now() / 1000) - 1);
  const monitor = spawn('docker', ['events', '--since', since, '--format', '{{json .}}'], {
    cwd: repositoryRoot, env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.monitorStarted = true;
  state.monitorClosed = new Promise((resolveClose) => monitor.once('close', (status, signal) => resolveClose({ status, signal })));
  monitor.once('error', (error) => state.monitorErrors.push(error.message));
  let buffer = '';
  monitor.stdout.setEncoding('utf8');
  monitor.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      try { recordDockerEvent(state, JSON.parse(line)); } catch { state.eventParseErrors.push(line.slice(0, 200)); }
    }
  });
  return monitor;
}

async function stopDockerEventMonitor(monitor, state) {
  const stop = { requested: true, signal: 'SIGTERM', requestSucceeded: false, exit: null };
  state.monitorStop = stop;
  stop.requestSucceeded = monitor.kill('SIGTERM');
  if (!stop.requestSucceeded) throw new Error('Docker event monitor rejected SIGTERM request');
  const forcedKill = setTimeout(() => {
    try {
      const requestSucceeded = monitor.kill('SIGKILL');
      stop.forcedKill = { requested: true, signal: 'SIGKILL', requestSucceeded };
      if (!requestSucceeded) state.monitorErrors.push('stop:Docker event monitor rejected SIGKILL request');
    } catch (cause) {
      state.monitorErrors.push(`stop:${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, 2_000);
  try {
    const result = await state.monitorClosed;
    stop.exit = result;
    state.monitorExit = result;
  } finally {
    clearTimeout(forcedKill);
  }
}

function minimumBackupStartIdentities(role, action) {
  if (role === 'provision') return action === 'source' ? 3 : 2;
  return ['online-storage', 'control-plane'].includes(role) ? 2 : 1;
}

export function parseBackupRawReceipt(rawText, expectedHostname, role, action, allowedPorts, allowedUnix = []) {
  const lines = rawText.trim().split('\n').filter(Boolean);
  const starts = [];
  const attempted = [];
  const unexpected = [];
  const unknownLines = [];
  for (const line of lines) {
    const start = line.match(/^START pid=(\d+) startTicks=(\d+) hostname=([A-Za-z0-9._-]+)$/u);
    if (start !== null) {
      starts.push({ pid: Number(start[1]), pidStartTicks: start[2], hostname: start[3] });
      continue;
    }
    if (line.startsWith('DENY ')) { attempted.push(line); unexpected.push(line); continue; }
    const allow = line.match(/^ALLOW call=(connect|sendto|sendmsg|sendmmsg) (.+)$/u);
    if (allow === null) { unknownLines.push(line); continue; }
    const detail = allow[2];
    const inet = detail.match(/^family=\d+ address=(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1) port=(\d+)$/iu);
    const unix = detail.match(/^family=AF_UNIX path=(.+)$/u);
    const unixAllowed = unix !== null && allowedUnix.some((item) => {
      if (!item.startsWith('tsx-pipe:')) return item === unix[1];
      const directory = item.slice('tsx-pipe:'.length).replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return new RegExp(`^${directory}/[1-9][0-9]*\\.pipe$`, 'u').test(unix[1]);
    });
    if (detail !== 'family=CONNECTED' && (inet === null || !allowedPorts.includes(inet[2])) && !unixAllowed) unknownLines.push(line);
    attempted.push(line);
  }
  const uniqueIdentities = [...new Map(starts.map((identity) => [`${String(identity.pid)}:${identity.pidStartTicks}`, identity])).values()];
  const identitiesValid = uniqueIdentities.length >= minimumBackupStartIdentities(role, action)
    && new Set(uniqueIdentities.map((identity) => identity.pid)).size === uniqueIdentities.length
    && starts.every((identity) => identity.pid > 0 && identity.hostname === expectedHostname);
  return { lines, startIdentities: uniqueIdentities, reloadCount: starts.length - uniqueIdentities.length,
    attempted, unexpected, unknownLines, identitiesValid,
    passed: identitiesValid && unexpected.length === 0 && unknownLines.length === 0 };
}

function backupGuardReceipt(container) {
  if (typeof container.egressReceiptPath !== 'string') return { checked: true, passed: false, reason: 'receipt-path-missing' };
  try {
    const stat = lstatSync(container.egressReceiptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return { checked: true, passed: false, reason: 'receipt-file-unsafe' };
    const receipt = JSON.parse(readFileSync(container.egressReceiptPath, 'utf8'));
    const rawPath = receipt.rawReceipt;
    if (typeof rawPath !== 'string' || resolve(rawPath) !== rawPath || rawPath === '/tmp/geneway-runs'
      || !rawPath.startsWith('/tmp/geneway-runs/')) return { checked: true, passed: false, reason: 'raw-receipt-path-unsafe' };
    const rawStat = lstatSync(rawPath);
    if (!rawStat.isFile() || rawStat.isSymbolicLink() || (rawStat.mode & 0o777) !== 0o600) {
      return { checked: true, passed: false, reason: 'raw-receipt-file-unsafe' };
    }
    const rawBytes = readFileSync(rawPath);
    const expectedRoleUnix = `tsx-pipe:/tmp/tsx-${String(process.getuid?.() ?? 1000)}`;
    const raw = parseBackupRawReceipt(rawBytes.toString('utf8'), container.name, container.backupRole,
      container.backupAction, container.egressAllowedPorts, [expectedRoleUnix]);
    const passed = receipt.schemaVersion === 'geneway-backup-egress-boundary/1' && receipt.passed === true
      && receipt.runId === container.backupRun && receipt.containerId === container.id && receipt.hostname === container.name
      && receipt.role === container.backupRole && receipt.action === container.backupAction
      && receipt.networkMode === container.networkMode && receipt.policyComplete === true
      && Array.isArray(receipt.startIdentities) && receipt.startIdentities.length > 0
      && receipt.startIdentities.every((identity) => Number.isInteger(identity.pid) && identity.pid > 0
        && typeof identity.pidStartTicks === 'string' && identity.pidStartTicks !== 'unknown'
        && identity.hostname === container.name)
      && JSON.stringify(receipt.allowedUnix) === JSON.stringify([expectedRoleUnix])
      && JSON.stringify(receipt.allowedIpAddresses) === JSON.stringify(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      && JSON.stringify(receipt.allowed) === JSON.stringify(container.egressAllowedPorts
        .flatMap((port) => [`127.0.0.1:${port}`, `[::1]:${port}`, `[::ffff:127.0.0.1]:${port}`]))
      && Array.isArray(receipt.attempted) && Array.isArray(receipt.unexpected) && receipt.unexpected.length === 0
      && Array.isArray(receipt.unknownLines) && receipt.unknownLines.length === 0
      && Number.isInteger(receipt.exitStatus)
      && receipt.rawReceiptSha256 === createHash('sha256').update(rawBytes).digest('hex')
      && receipt.rawLineCount === raw.lines.length
      && JSON.stringify(receipt.startIdentities) === JSON.stringify(raw.startIdentities)
      && receipt.reloadCount === raw.reloadCount
      && JSON.stringify(receipt.attempted) === JSON.stringify(raw.attempted)
      && JSON.stringify(receipt.unexpected) === JSON.stringify(raw.unexpected)
      && JSON.stringify(receipt.unknownLines) === JSON.stringify(raw.unknownLines)
      && raw.passed;
    return { ...receipt, rawVerified: true, checked: true, passed };
  } catch (cause) {
    return { checked: true, passed: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function extractStructuredBackupRuns(logText, required) {
  const expectedCases = ['success', 'missing-object', 'manifest-mismatch'];
  const candidates = logText.split('\n').flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.outcome === 'passed' && Array.isArray(parsed.results) ? [parsed.results] : [];
    } catch { return []; }
  });
  if (!required) return [];
  if (candidates.length !== 1 || candidates[0].length !== 3) throw new Error('Gate 0.2B structured backup results are missing or duplicated');
  const results = candidates[0];
  for (const [index, expectedCase] of expectedCases.entries()) {
    const result = results[index];
    const expectedOutcome = expectedCase === 'success' ? 'passed' : 'expected-integrity-failure';
    const expectedExit = expectedCase === 'success' ? 0 : 1;
    const suffix = typeof result?.runId === 'string'
      ? createHash('sha256').update(result.runId).digest('hex').slice(0, 12) : '';
    if (result?.case !== expectedCase || typeof result.runId !== 'string'
      || !result.runId.startsWith(`backup-restore-suite-${expectedCase}-`)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result.runId)
      || result.artifactRoot !== `/tmp/geneway-runs/${result.runId}/backup-restore`
      || result.schemaVersion !== 'geneway-backup-restore-summary/1'
      || result.projectSuffix !== suffix
      || result.sourceProject !== `geneway-br-source-${suffix}`
      || result.targetProject !== `geneway-br-target-${suffix}`
      || result.outcome !== expectedOutcome || result.exitCode !== expectedExit) {
      throw new Error(`Gate 0.2B structured backup result is invalid for ${expectedCase}`);
    }
  }
  if (new Set(results.map((result) => result.runId)).size !== 3) throw new Error('Gate 0.2B structured backup run IDs are duplicated');
  return results;
}

export function extractStructuredBackupRunIds(logText, required) {
  return extractStructuredBackupRuns(logText, required).map((result) => result.runId);
}

export function expectedBackupProxyProjects(results) {
  return results.flatMap((result) => {
    const suffix = createHash('sha256').update(result.runId).digest('hex').slice(0, 12);
    return [`geneway-br-source-${suffix}`, `geneway-br-target-${suffix}`];
  });
}

export function storageInvocationManifests(runRoot, expectation = {}) {
  const directory = resolve(runRoot, 'invocations');
  const expectedTotal = expectation.expectedWithStorageInvocations ?? 0;
  if (!existsSync(directory)) {
    if (expectedTotal !== 0) throw new Error('Gate 0.2B storage invocation manifests are missing');
    return [];
  }
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700) {
    throw new Error('Gate 0.2B storage invocation manifest directory is unsafe');
  }
  const names = readdirSync(directory).sort();
  if (names.some((name) => !/^geneway-(?:e2e|storage)-[A-Za-z0-9._-]+\.json$/u.test(name))) {
    throw new Error('Gate 0.2B storage invocation manifest inventory is unsafe');
  }
  const manifests = names.map((name) => {
    const path = resolve(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw new Error('Gate 0.2B storage invocation manifest is unsafe');
    }
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const expectedServices = [
      ['postgres', 'default', 5432], ['versitygw', 'storage', 7070],
      ['storage-adapter', 'storage', 7400], ['storage-reconciliation-adapter', 'storage', 7401],
    ];
    const exactKeys = ['schemaVersion', 'kind', 'parentRunId', 'runId', 'project', 'networks', 'services'];
    const validServices = Array.isArray(manifest.services) && manifest.services.length === 4
      && manifest.services.every((service, index) => {
        const [serviceName, network, targetPort] = expectedServices[index];
        return JSON.stringify(Object.keys(service)) === JSON.stringify(['name', 'network', 'listenPort', 'targetPort', 'stem'])
          && service.name === serviceName && service.network === network
          && Number.isInteger(service.listenPort) && service.listenPort >= 1 && service.listenPort <= 65_535
          && service.targetPort === targetPort && service.stem === `${manifest.project}-${serviceName}`;
      });
    const safeRunId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u.test(value);
    const e2eIdentityValid = manifest.kind !== 'e2e' || (safeRunId(manifest.parentRunId) && safeRunId(manifest.runId)
      && manifest.runId !== manifest.parentRunId
      && manifest.project === `geneway-e2e-${manifest.runId.toLowerCase().replace(/[^a-z0-9_-]/gu, '-')}`);
    if (JSON.stringify(Object.keys(manifest)) !== JSON.stringify(exactKeys)
      || manifest.schemaVersion !== 'geneway-gate02b-storage-invocation/1'
      || !['storage', 'e2e'].includes(manifest.kind)
      || typeof manifest.project !== 'string' || name !== `${manifest.project}.json`
      || (manifest.kind === 'e2e') !== manifest.project.startsWith('geneway-e2e-')
      || (manifest.kind === 'storage') !== manifest.project.startsWith('geneway-storage-')
      || ![null, 'string'].includes(manifest.parentRunId === null ? null : typeof manifest.parentRunId)
      || ![null, 'string'].includes(manifest.runId === null ? null : typeof manifest.runId)
      || !e2eIdentityValid
      || JSON.stringify(manifest.networks) !== JSON.stringify({
        default: `${manifest.project}_default`, storage: `${manifest.project}_storage`,
      }) || !validServices) {
      throw new Error(`Gate 0.2B storage invocation manifest is invalid: ${name}`);
    }
    return manifest;
  });
  const storageCount = manifests.filter((manifest) => manifest.kind === 'storage').length;
  const e2eCount = manifests.filter((manifest) => manifest.kind === 'e2e').length;
  if (manifests.length !== expectedTotal || storageCount !== (expectation.expectedStorageInvocations ?? 0)
    || e2eCount !== (expectation.expectedE2eInvocations ?? 0)) {
    throw new Error('Gate 0.2B storage invocation manifest membership does not match the step plan');
  }
  return manifests;
}

export function backupArtifactRoots(results) {
  const runIds = [...new Set(results.flatMap((result) => result.runtimeBoundary?.structuralIsolation?.expectedBackupRunIds ?? []))].sort();
  if (runIds.some((runId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId))) throw new Error('Gate 0.2B backup artifact run ID is unsafe');
  return runIds.map((runId) => `/tmp/geneway-runs/${runId}/backup-restore`);
}

export function dockerStructuralIsolationReceipt(state, expectedBackupRunIds = [], proxyRunRoot = null, proxyExpectation = {}) {
  const containers = [...state.containers.values()].filter((container) => container.repositoryScoped === true).map((container) => ({
    id: container.id, name: container.name, project: container.project ?? null, service: container.service ?? null,
    backupRun: container.backupRun ?? null, backupRole: container.backupRole ?? null, backupAction: container.backupAction ?? null,
    egressReceiptPath: container.egressReceiptPath ?? null, pid: container.pid ?? null, pidStartTicks: container.pidStartTicks ?? null,
    egressAllowedPorts: container.egressAllowedPorts ?? [],
    exitCode: container.exitCode ?? null, networkMode: container.networkMode ?? null,
    inspectObserved: container.inspectObserved === true, eventObserved: container.eventObserved === true,
    extraHosts: container.extraHosts ?? [], publishedPorts: container.publishedPorts ?? [], netnsAttempted: container.netnsAttempted === true,
    netnsErrors: [...new Set(container.netnsErrors ?? [])],
    netnsSockets: [...new Map((container.netnsSockets ?? []).map((socket) => [JSON.stringify(socket), socket])).values()],
    networkIds: [...container.networkIds].sort(), networkNames: [...container.networkNames].sort(),
    networkAttachments: container.networkAttachments ?? [],
  })).sort((left, right) => left.name.localeCompare(right.name));
  const networks = [...state.networks.values()].map((network) => ({
    id: network.id, name: network.name, internal: network.internal, driver: network.driver,
    inspectObserved: network.inspectObserved, project: network.project, subnets: network.subnets,
    bridgeName: network.bridgeName ?? null, gatewayAddresses: [...(network.gatewayAddresses ?? [])].sort(),
    interfaceNames: [...(network.interfaceNames ?? [])].sort(),
    bridgeIdentity: network.bridgeIdentity ?? null, identityConflict: network.identityConflict === true,
    memberIdentities: [...(network.memberIdentities ?? [])].map(([name, identity]) => ({ name, ...identity }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  })).sort((left, right) => left.name.localeCompare(right.name));
  const internalIdentities = new Set(networks.filter((network) => network.internal).flatMap((network) => [network.id, network.name]));
  const internalSubnets = networks.filter((network) => network.internal).flatMap((network) => network.subnets);
  const violations = [];
  for (const network of networks) {
    if (!network.internal) violations.push(`non-internal-network:${network.name}:${network.id}`);
    if (!network.inspectObserved) violations.push(`network-inspect-missing:${network.name}:${network.id}`);
    if (network.identityConflict) violations.push(`network-link-identity-conflict:${network.name}:${network.id}`);
    if (typeof network.project !== 'string' || !/^geneway-(?:storage|e2e|br)-[A-Za-z0-9._-]+$/u.test(network.project)) {
      violations.push(`network-project-forbidden:${network.name}:${String(network.project)}`);
    }
  }
  for (const container of containers) {
    if (!container.eventObserved) violations.push(`container-event-missing:${container.name}:${container.id}`);
    if (!container.inspectObserved) violations.push(`container-inspect-missing:${container.name}:${container.id}`);
    if (container.backupRun !== null) {
      const noneRoles = (container.backupRole === 'worker' && container.backupAction === 'service')
        || (container.backupRole === 'worker-command' && ['settle', 'target-claim'].includes(container.backupAction))
        || (container.backupRole === 'provision-docker' && ['source', 'target'].includes(container.backupAction));
      const dataRole = container.backupRole === 'backup'
        || (container.backupRole === 'backup-network' && container.backupAction === 'deny-online-control-plane');
      const hostActions = {
        provision: ['source', 'target'],
        online: ['source-main', 'prepare-blocked', 'source-barrier-probe', 'create-probes', 'target-gate', 'open'],
        oracle: ['delete-object'],
        'online-storage': ['service'],
        'control-plane': ['service'],
      };
      const hostRole = Object.hasOwn(hostActions, container.backupRole)
        && hostActions[container.backupRole].includes(container.backupAction);
      if (noneRoles && container.networkMode !== 'none') violations.push(`backup-network-matrix:${container.name}`);
      else if (dataRole && (!container.networkNames.some((name) => name.startsWith('geneway-br-'))
        || container.networkNames.some((name) => !internalIdentities.has(name)))) violations.push(`backup-network-matrix:${container.name}`);
      else if (hostRole && container.networkMode !== 'host') violations.push(`backup-network-matrix:${container.name}`);
      else if (!noneRoles && !dataRole && !hostRole) violations.push(`backup-role-action-forbidden:${container.name}:${container.backupRole}/${container.backupAction}`);
      if (hostRole) {
        const guard = backupGuardReceipt(container);
        container.egressBoundary = guard;
        if (!guard.passed) violations.push(`backup-egress-boundary-failed:${container.name}:${guard.reason ?? 'invalid'}`);
      }
      continue;
    }
    if (!gate02bComposeServiceAllowlist.has(container.service)) violations.push(`container-service-forbidden:${container.name}:${String(container.service)}`);
    if (typeof container.project !== 'string' || !/^geneway-(?:storage|e2e|br)-[A-Za-z0-9._-]+$/u.test(container.project)) {
      violations.push(`container-project-forbidden:${container.name}:${String(container.project)}`);
    }
    if (container.networkMode === 'host' || container.networkMode?.startsWith('container:')) {
      violations.push(`container-network-mode-forbidden:${container.name}:${container.networkMode}`);
    }
    for (const published of container.publishedPorts) if (!['127.0.0.1', '::1'].includes(published.hostIp)) {
      violations.push(`container-published-host-forbidden:${container.name}:${published.hostIp}:${published.hostPort}`);
    }
    if (container.extraHosts.some((entry) => entry.includes('host-gateway'))) violations.push(`container-host-gateway-forbidden:${container.name}`);
    if (container.netnsAttempted && container.netnsErrors.length > 0) violations.push(`container-netns-read-failed:${container.name}`);
    for (const socket of container.netnsSockets) {
      const allowed = socket.remoteAddress === '::1' || socket.remoteAddress.startsWith('127.')
        || (/^\d+\.\d+\.\d+\.\d+$/u.test(socket.remoteAddress)
          && internalSubnets.some((subnet) => ipv4InCidr(socket.remoteAddress, subnet)));
      if (!allowed) violations.push(`container-netns-endpoint-forbidden:${container.name}:${socket.protocol}:${socket.remoteAddress}:${String(socket.remotePort)}`);
    }
    if (container.networkIds.length + container.networkNames.length === 0) violations.push(`container-network-evidence-missing:${container.name}:${container.id}`);
    for (const identity of [...container.networkIds, ...container.networkNames]) {
      if (!internalIdentities.has(identity)) violations.push(`container-network-not-proven-internal:${container.name}:${identity}`);
    }
  }
  const backupRunIds = [...new Set(containers.flatMap((container) => typeof container.backupRun === 'string' ? [container.backupRun] : []))].sort();
  if (JSON.stringify(backupRunIds) !== JSON.stringify(expectedBackupRunIds)) violations.push('backup-run-membership-mismatch');
  const proxyRoots = proxyRunRoot === null ? [] : [...new Set(Array.isArray(proxyRunRoot) ? proxyRunRoot : [proxyRunRoot])];
  const invocationManifests = proxyRoots.length === 0 ? [] : storageInvocationManifests(proxyRoots[0], proxyExpectation);
  const proxyReceipts = proxyRoots.map((root) => loopbackProxyArtifactReceipt(root, state));
  const loopbackProxies = { checked: true, count: proxyReceipts.reduce((sum, item) => sum + item.count, 0),
    proxies: proxyReceipts.flatMap((item) => item.proxies), passed: proxyReceipts.every((item) => item.passed) };
  const expectedProxyNames = [
    ...invocationManifests.flatMap((manifest) => manifest.services.map((service) => service.stem)),
    ...(proxyExpectation.expectedBackupProjects ?? []).flatMap((project) => ['postgres', 'versitygw']
      .map((service) => `${project}-${service}`)),
  ].sort();
  const actualProxyNames = loopbackProxies.proxies.map((proxy) => proxy.name).sort();
  loopbackProxies.expectedNames = expectedProxyNames;
  loopbackProxies.passed &&= JSON.stringify(actualProxyNames) === JSON.stringify(expectedProxyNames);
  const expectedProxyCount = (proxyExpectation.expectedWithStorageInvocations ?? 0) * 4
    + (proxyExpectation.expectedBackupCases ?? 0) * 4;
  loopbackProxies.expectedCount = expectedProxyCount;
  loopbackProxies.passed &&= loopbackProxies.count === expectedProxyCount;
  if (!loopbackProxies.passed) violations.push('loopback-proxy-boundary-failed');
  const requestedSigtermExit = state.monitorStop?.requested === true && state.monitorStop?.signal === 'SIGTERM'
    && state.monitorStop?.requestSucceeded === true
    && state.monitorStop?.exit?.status === 143 && state.monitorStop?.exit?.signal === null
    && state.monitorExit?.status === 143 && state.monitorExit?.signal === null;
  const eventMonitor = { checked: true, started: state.monitorStarted === true, eventCount: state.eventCount,
    parseErrors: state.eventParseErrors, errors: state.monitorErrors, stop: state.monitorStop ?? null, exit: state.monitorExit ?? null,
    passed: state.monitorStarted === true && state.eventParseErrors.length === 0 && state.monitorErrors.length === 0
      && ((state.monitorExit?.status === null && state.monitorExit?.signal === 'SIGTERM')
        || (state.monitorExit?.status === 0 && state.monitorExit?.signal === null) || requestedSigtermExit) };
  return { checked: true, eventMonitor, invocationManifests, loopbackProxies, backupRunIds, expectedBackupRunIds, observedContainers: containers, observedNetworks: networks,
    violations: eventMonitor.passed ? violations : [...violations, 'docker-event-monitor-failed'],
    passed: eventMonitor.passed && violations.length === 0 };
}

function boundarySnapshot() {
  const processes = repositoryProcesses();
  const processLines = processes.map((item) => `pid=${String(item.pid)} command=${item.command}`);
  const listenerLines = socketLinesForProcesses(['ss', '-H', '-ltnp'], processes, 'listener');
  const egressLines = socketLinesForProcesses(['ss', '-H', '-tnp', 'state', 'established'], processes, 'egress')
    .filter((line) => {
      const peer = (line.split(/\s+/u)[0] ?? '').split('->')[1] ?? '';
      return !peer.startsWith('127.0.0.1:') && !peer.startsWith('[::1]:');
    });
  const dockerResources = repositoryDockerBoundaryResources();
  const workerSockets = gateAuthorityPaths();
  return { processLines, listenerLines, globalListenerLines: globalListenerLines(), egressLines,
    containers: dockerResources, workerSockets };
}

export function validateProxyPolicy(policy, expectedRoot) {
  const servicePorts = { postgres: 5432, versitygw: 7070, 'storage-adapter': 7400, 'storage-reconciliation-adapter': 7401 };
  const unhashed = policy === null || typeof policy !== 'object' ? {} : { ...policy };
  delete unhashed.policyHash;
  const expectedHash = createHash('sha256').update(JSON.stringify(unhashed)).digest('hex');
  if (policy?.schemaVersion !== 'geneway-gate02b-loopback-proxy/1' || policy.listen?.host !== '127.0.0.1'
    || !Number.isInteger(policy.controller?.pid) || policy.controller.pid < 1
    || typeof policy.controller?.startTicks !== 'string' || policy.controller.startTicks === 'unknown'
    || !Number.isInteger(policy.controller?.parentPid) || policy.controller.parentPid < 1
    || !Number.isInteger(policy.controller?.processGroupId) || policy.controller.processGroupId < 1
    || !Number.isInteger(policy.controller?.sessionId) || policy.controller.sessionId < 1
    || typeof policy.controller?.hostname !== 'string'
    || !Number.isInteger(policy.listen?.port) || !/^[a-f0-9]{64}$/u.test(policy.target?.containerId ?? '')
    || !/^geneway-(?:e2e|storage|br)-[A-Za-z0-9._-]+$/u.test(policy.target?.project ?? '')
    || !['postgres', 'versitygw', 'storage-adapter', 'storage-reconciliation-adapter'].includes(policy.target?.service)
    || policy.name !== `${policy.target?.project}-${policy.target?.service}`
    || ![`${policy.target?.project}_default`, `${policy.target?.project}_storage`].includes(policy.target?.networkName)
    || !/^[a-f0-9]{64}$/u.test(policy.target?.networkId ?? '') || policy.target?.networkInternal !== true
    || !/^\d+\.\d+\.\d+\.\d+$/u.test(policy.target?.ip ?? '')
    || servicePorts[policy.target?.service] !== policy.target?.port
    || policy.target.port !== policy.target.containerPort || policy.policyHash !== expectedHash
    || policy.dockerHost !== 'unix:///var/run/docker.sock'
    || resolve(policy.dockerConfigPath) !== resolve(expectedRoot, 'docker-client')
    || resolve(policy.rawPath) !== resolve(expectedRoot, 'loopback-proxies', `${policy.name}.raw`)
    || resolve(policy.attemptsPath) !== resolve(expectedRoot, 'loopback-proxies', `${policy.name}.attempts.jsonl`)
    || resolve(policy.readyPath) !== resolve(expectedRoot, 'loopback-proxies', `${policy.name}.ready.json`)
    || resolve(policy.policyPath) !== resolve(expectedRoot, 'loopback-proxies', `${policy.name}.policy.json`)) {
    throw new Error('Gate 0.2B loopback proxy policy is unsafe');
  }
  return policy;
}

export function proxyTargetBindingMatches(policy, container, network) {
  const servicePorts = { postgres: 5432, versitygw: 7070, 'storage-adapter': 7400, 'storage-reconciliation-adapter': 7401 };
  const labels = container?.Config?.Labels ?? {};
  const attachment = container?.NetworkSettings?.Networks?.[policy?.target?.networkName];
  return servicePorts[policy?.target?.service] === policy?.target?.port
    && policy?.target?.containerPort === policy?.target?.port
    && labels['com.docker.compose.project'] === policy?.target?.project
    && labels['com.docker.compose.service'] === policy?.target?.service
    && container?.Id === policy?.target?.containerId && attachment?.NetworkID === policy?.target?.networkId
    && attachment?.IPAddress === policy?.target?.ip && network?.Id === policy?.target?.networkId
    && network?.Name === policy?.target?.networkName && network?.Internal === true
    && network?.Labels?.['com.docker.compose.project'] === policy?.target?.project;
}

export function internalDockerListenerBinding(policy, container, network, bridgeSnapshot, memberLinks) {
  if (!proxyTargetBindingMatches(policy, container, network) || network.Driver !== 'bridge'
    || !Array.isArray(bridgeSnapshot) || bridgeSnapshot.length !== 1 || !Array.isArray(memberLinks)
    || memberLinks.length === 0) return null;
  const configuredBridge = network.Options?.['com.docker.network.bridge.name'];
  const bridgeName = typeof configuredBridge === 'string' && configuredBridge.length > 0
    ? configuredBridge : `br-${network.Id.slice(0, 12)}`;
  if (bridgeSnapshot[0]?.ifname !== bridgeName
    || memberLinks.some((link) => link?.master !== bridgeName || typeof link.ifname !== 'string')) return null;
  const gatewayAddresses = (network.IPAM?.Config ?? []).flatMap((config) =>
    typeof config?.Gateway === 'string' && config.Gateway.length > 0 ? [config.Gateway] : []);
  if (gatewayAddresses.length === 0) return null;
  return { gatewayAddresses: [...new Set(gatewayAddresses)].sort(),
    interfaceNames: [bridgeName, ...new Set(memberLinks.map((link) => link.ifname))].sort() };
}

export function validateProxyRawReceipt(policy, summary, raw, attemptsText = '') {
  const lines = raw.trim().split('\n').filter(Boolean);
  const startPattern = /^START pid=([1-9][0-9]*) startTicks=([1-9][0-9]*) hostname=([^\s]+)$/u;
  const targetPattern = new RegExp(`^ALLOW attempt=([1-9][0-9]*) call=connect family=2 address=${policy.target.ip.replaceAll('.', '\\.')} port=${String(policy.target.port)}$`, 'u');
  const connectedPattern = /^ALLOW call=(sendto|sendmsg|sendmmsg) family=CONNECTED$/u;
  const starts = lines.flatMap((line) => { const match = line.match(startPattern); return match === null ? []
    : [{ pid: Number(match[1]), startTicks: match[2], hostname: match[3] }]; });
  const unknown = lines.filter((line) => !startPattern.test(line) && !targetPattern.test(line)
    && !connectedPattern.test(line) && !line.startsWith('DENY '));
  const deny = lines.filter((line) => line.startsWith('DENY '));
  const identities = summary?.startIdentities;
  const attemptLines = attemptsText.trim().split('\n').filter(Boolean);
  const attempts = attemptLines.map((line) => JSON.parse(line));
  const rawAttempts = lines.flatMap((line) => { const match = line.match(targetPattern); if (match === null) return [];
    const value = Number(match[1]); return Number.isSafeInteger(value) && String(value) === match[1] ? [value] : []; });
  return summary?.passed === true && summary?.rawSha256 === createHash('sha256').update(raw).digest('hex')
    && summary?.rawLineCount === lines.length && summary?.exit?.status === 0 && summary?.exit?.signal === null
    && starts.length === 1
    && Array.isArray(identities) && identities.length === 1 && identities[0]?.pid > 0
    && typeof identities[0]?.startTicks === 'string' && identities[0].startTicks !== 'unknown'
    && typeof identities[0]?.hostname === 'string'
    && identities[0].pid === starts[0].pid && identities[0].startTicks === starts[0].startTicks
    && identities[0].hostname === starts[0].hostname && summary?.readyIdentity?.pid === starts[0].pid
    && summary?.readyIdentity?.startTicks === starts[0].startTicks && summary?.readyIdentity?.hostname === starts[0].hostname
    && attempts.length >= 1 && attempts.every((item, index) => Number.isSafeInteger(item.seq) && item.seq >= 1
      && String(item.seq) === String(index + 1) && item.seq === index + 1
      && JSON.stringify(Object.keys(item)) === JSON.stringify(['seq', 'schemaVersion', 'policyHash', 'serve', 'binding'])
      && JSON.stringify(Object.keys(item.serve ?? {})) === JSON.stringify(['pid', 'startTicks', 'hostname'])
      && item.schemaVersion === policy.schemaVersion && item.policyHash === policy.policyHash
      && item.serve?.pid === starts[0].pid && item.serve?.startTicks === starts[0].startTicks
      && item.serve?.hostname === starts[0].hostname && JSON.stringify(item.binding) === JSON.stringify({ ...policy.target, running: true })
      && attemptLines[index] === JSON.stringify({ seq: item.seq, schemaVersion: item.schemaVersion,
        policyHash: item.policyHash, serve: item.serve, binding: item.binding }))
    && JSON.stringify(rawAttempts) === JSON.stringify(attempts.map((item) => item.seq))
    && lines.every((line, index) => !connectedPattern.test(line)
      || lines.slice(0, index).some((prior) => targetPattern.test(prior)))
    && summary?.attemptsSha256 === createHash('sha256').update(attemptsText).digest('hex')
    && summary?.attemptLineCount === attempts.length
    && JSON.stringify(summary?.denyLines) === JSON.stringify(deny)
    && JSON.stringify(summary?.unknownLines) === JSON.stringify(unknown)
    && deny.length === 0 && unknown.length === 0;
}

export function validateProxyIdentityChain(policy, ready, summary) {
  return JSON.stringify(Object.keys(ready ?? {})) === JSON.stringify(['schemaVersion', 'policyPath', 'policyHash', 'pid', 'startTicks', 'hostname'])
    && JSON.stringify(Object.keys(summary?.spawnIdentity ?? {})) === JSON.stringify(['pid', 'startTicks', 'hostname'])
    && Number.isSafeInteger(ready?.pid) && ready.pid >= 1 && /^[1-9][0-9]*$/u.test(ready?.startTicks ?? '')
    && typeof ready?.hostname === 'string' && ready.hostname.length > 0
    && ready?.schemaVersion === policy?.schemaVersion && ready?.policyPath === policy?.policyPath
    && ready?.policyHash === policy?.policyHash && JSON.stringify(summary?.readyIdentity) === JSON.stringify(ready)
    && JSON.stringify(summary?.stdoutReady) === JSON.stringify({ ready: true, ...ready })
    && summary?.spawnIdentity?.pid === ready?.pid && summary?.spawnIdentity?.startTicks === ready?.startTicks
    && summary?.spawnIdentity?.hostname === ready?.hostname;
}

function loopbackProxyArtifactReceipt(runRoot, state) {
  const root = resolve(runRoot, 'loopback-proxies');
  if (!existsSync(root)) return { checked: true, count: 0, proxies: [], passed: true };
  const dockerConfigRoot = resolve(runRoot, 'docker-client');
  const dockerConfigStat = lstatSync(dockerConfigRoot);
  if (!dockerConfigStat.isDirectory() || dockerConfigStat.isSymbolicLink()
    || (dockerConfigStat.mode & 0o777) !== 0o700 || readdirSync(dockerConfigRoot).length !== 0) {
    throw new Error('Gate 0.2B controlled Docker client configuration is unsafe');
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) {
    throw new Error('Gate 0.2B loopback proxy artifact root is unsafe');
  }
  const inventory = readdirSync(root).sort();
  const policyNames = validateProxyInventory(inventory);
  const allowedInventory = new Set(policyNames.flatMap((name) => {
    const stem = name.slice(0, -'.policy.json'.length);
    return [`${stem}.policy.json`, `${stem}.raw`, `${stem}.ready.json`, `${stem}.attempts.jsonl`, `${stem}.json`, `${stem}.controller.log`];
  }));
  if (inventory.some((name) => !allowedInventory.has(name))) throw new Error('Gate 0.2B loopback proxy artifact inventory contains an orphan');
  for (const policyName of policyNames) {
    const stem = policyName.slice(0, -'.policy.json'.length);
    const hasControllerLog = inventory.includes(`${stem}.controller.log`);
    if (stem.startsWith('geneway-br-') ? hasControllerLog : !hasControllerLog) {
      throw new Error('Gate 0.2B proxy artifact inventory has the wrong main/backup member set');
    }
  }
  for (const name of inventory.filter((item) => item.endsWith('.controller.log'))) {
    const stat = lstatSync(resolve(root, name));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error('Gate 0.2B proxy controller log is unsafe');
  }
  const proxies = policyNames.map((name) => {
    const stem = name.slice(0, -'.policy.json'.length);
    const policyPath = resolve(root, name);
    const rawPath = resolve(root, `${stem}.raw`);
    const attemptsPath = resolve(root, `${stem}.attempts.jsonl`);
    const readyPath = resolve(root, `${stem}.ready.json`);
    const summaryPath = resolve(root, `${stem}.json`);
    for (const path of [policyPath, rawPath, readyPath, attemptsPath, summaryPath]) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error(`Gate 0.2B loopback proxy artifact is unsafe: ${path}`);
      }
    }
    const policy = validateProxyPolicy(JSON.parse(readFileSync(policyPath, 'utf8')), runRoot);
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const raw = readFileSync(rawPath, 'utf8');
    const attempts = readFileSync(attemptsPath, 'utf8');
    const containerState = state.containers.get(policy.target.containerId);
    const networkState = state.networks.get(policy.target.networkId);
    const container = containerState === undefined ? null : { Id: containerState.id,
      Config: { Labels: { 'com.docker.compose.project': containerState.project, 'com.docker.compose.service': containerState.service } },
      NetworkSettings: { Networks: Object.fromEntries((containerState.networkAttachments ?? []).map((item) => [item.name,
        { NetworkID: item.id, IPAddress: item.ip }])) } };
    const network = networkState === undefined ? null : { Id: networkState.id, Name: networkState.name,
      Internal: networkState.internal, Labels: { 'com.docker.compose.project': networkState.project } };
    const passed = policy.name === stem && policy.name === `${policy.target.project}-${policy.target.service}`
      && policy.policyPath === policyPath && policy.rawPath === rawPath
      && policy.readyPath === readyPath && policy.attemptsPath === attemptsPath
      && summary.name === stem && summary.policyPath === policyPath && summary.rawPath === rawPath
      && summary.readyPath === readyPath && summary.attemptsPath === attemptsPath
      && ready.policyPath === policyPath
      && proxyTargetBindingMatches(policy, container, network)
      && JSON.stringify(summary.target) === JSON.stringify(policy.target)
      && JSON.stringify(summary.listen) === JSON.stringify(policy.listen)
      && summary.policyHash === policy.policyHash && ready.policyHash === policy.policyHash
      && JSON.stringify(summary.control) === JSON.stringify({ shutdownRequests: 1, failure: null })
      && validateProxyIdentityChain(policy, ready, summary)
      && summary.readyPath === readyPath && summary.finalBinding?.running === true
      && JSON.stringify(summary.finalBinding) === JSON.stringify({ ...policy.target, running: true })
      && summary.attemptsPath === attemptsPath && validateProxyRawReceipt(policy, summary, raw, attempts);
    return { name: stem, policyPath, rawPath, readyPath, summaryPath, target: policy.target, passed };
  });
  return { checked: true, count: proxies.length, proxies, passed: proxies.every((proxy) => proxy.passed) };
}

export function validateProxyInventory(inventory) {
  const policyNames = inventory.filter((name) => name.endsWith('.policy.json')).sort();
  const required = new Set(policyNames.flatMap((name) => {
    const stem = name.slice(0, -'.policy.json'.length);
    return [`${stem}.policy.json`, `${stem}.raw`, `${stem}.ready.json`, `${stem}.attempts.jsonl`, `${stem}.json`,
      ...(stem.startsWith('geneway-br-') ? [] : [`${stem}.controller.log`])];
  }));
  if ([...required].some((name) => !inventory.includes(name)) || inventory.some((name) => !required.has(name))) {
    throw new Error('Gate 0.2B loopback proxy artifact inventory is incomplete or contains an orphan');
  }
  return policyNames;
}

function proxyPolicyForProcess(processItem) {
  const path = proxyPolicyPathFromCommandLine(processItem.commandLine);
  if (path === null) return null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) return null;
    const runRoot = dirname(dirname(path));
    const policy = validateProxyPolicy(JSON.parse(readFileSync(path, 'utf8')), runRoot);
    const readyStat = lstatSync(policy.readyPath);
    if (!readyStat.isFile() || readyStat.isSymbolicLink() || (readyStat.mode & 0o777) !== 0o600) return null;
    const ready = JSON.parse(readFileSync(policy.readyPath, 'utf8'));
    if (ready.pid !== processItem.pid || ready.startTicks !== processItem.startTicks
      || ready.policyPath !== policy.policyPath || ready.policyHash !== policy.policyHash) return null;
    return policy;
  } catch { return null; }
}

export function proxyPolicyPathFromCommandLine(commandLine) {
  const script = resolve(repositoryRoot, 'scripts/gate02b-loopback-proxy.mjs');
  const pattern = new RegExp(`^(?:\\S*/)?node\\s+${script.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s+--serve\\s+(/tmp/geneway-runs/[A-Za-z0-9._-]+/loopback-proxies/[A-Za-z0-9._-]+\\.policy\\.json)$`, 'u');
  return commandLine.match(pattern)?.[1] ?? null;
}

export function proxyEgressMatchesPolicy(processItem, line) {
  const policy = proxyPolicyForProcess(processItem);
  if (policy === null) return false;
  const peer = (line.split(/\s+/u)[0] ?? '').split('->')[1];
  if (peer !== `${policy.target.ip}:${String(policy.target.port)}`) return false;
  const container = dockerJson(['docker', 'container', 'inspect', policy.target.containerId]);
  const inspected = Array.isArray(container) ? container[0] : undefined;
  const network = dockerJson(['docker', 'network', 'inspect', policy.target.networkId]);
  const inspectedNetwork = Array.isArray(network) ? network[0] : undefined;
  return proxyTargetBindingMatches(policy, inspected, inspectedNetwork);
}

function internalDockerListenerContext(processes, knownPolicyPaths = [], dockerObservation) {
  const gatewayAddresses = new Set();
  const interfaceNames = new Set();
  const allLinkResult = capture(['ip', '-j', 'address', 'show']);
  let allLiveLinks = null;
  if (allLinkResult.status === 0 && typeof allLinkResult.stdout === 'string') {
    try { allLiveLinks = JSON.parse(allLinkResult.stdout); } catch { allLiveLinks = null; }
  }
  for (const network of dockerObservation?.networks?.values() ?? []) {
    if (!network.inspectObserved || !network.internal || network.driver !== 'bridge'
      || typeof network.bridgeName !== 'string' || network.identityConflict) continue;
    const addressResult = capture(['ip', '-j', 'address', 'show', 'dev', network.bridgeName]);
    const memberResult = capture(['ip', '-j', 'link', 'show', 'master', network.bridgeName]);
    if (addressResult.status === 0 && typeof addressResult.stdout === 'string'
      && memberResult.status === 0 && typeof memberResult.stdout === 'string') try {
      const addresses = JSON.parse(addressResult.stdout);
      const members = JSON.parse(memberResult.stdout);
      const bridge = addresses.find((link) => link.ifname === network.bridgeName);
      if (bridge === undefined || !Number.isInteger(bridge.ifindex) || typeof bridge.address !== 'string'
        || JSON.stringify({ ifindex: bridge.ifindex, address: bridge.address }) !== JSON.stringify(network.bridgeIdentity)) continue;
      const liveAddresses = new Set(addresses.flatMap((link) => (link.addr_info ?? [])
        .flatMap((address) => typeof address.local === 'string' ? [address.local] : [])));
      const matchingGateways = [...(network.gatewayAddresses ?? [])].filter((gateway) => liveAddresses.has(gateway));
      if (matchingGateways.length === 0) continue;
      for (const gateway of matchingGateways) gatewayAddresses.add(gateway);
      interfaceNames.add(network.bridgeName);
      for (const link of members) {
        const cached = network.memberIdentities?.get(link.ifname);
        if (cached !== undefined && JSON.stringify(cached) === JSON.stringify({ ifindex: link.ifindex, address: link.address })) {
          interfaceNames.add(link.ifname);
        }
      }
    } catch {
      // Unparseable live link evidence cannot earn an adapter-listener exemption.
    }
    if (allLiveLinks !== null) {
      const unreachable = unreachableCachedDockerNetworkContext(network, allLiveLinks);
      for (const gateway of unreachable.gatewayAddresses) gatewayAddresses.add(gateway);
      for (const name of unreachable.interfaceNames) interfaceNames.add(name);
    }
  }
  const policyPaths = [...new Set([
    ...knownPolicyPaths,
    ...processes.map((item) => proxyPolicyPathFromCommandLine(item.commandLine)).filter(Boolean),
  ])];
  for (const path of policyPaths) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) continue;
      const runRoot = dirname(dirname(path));
      const policy = validateProxyPolicy(JSON.parse(readFileSync(path, 'utf8')), runRoot);
      const containerResult = dockerJson(['docker', 'container', 'inspect', policy.target.containerId]);
      const networkResult = dockerJson(['docker', 'network', 'inspect', policy.target.networkId]);
      const container = Array.isArray(containerResult) ? containerResult[0] : undefined;
      const network = Array.isArray(networkResult) ? networkResult[0] : undefined;
      if (!proxyTargetBindingMatches(policy, container, network) || network.Driver !== 'bridge') continue;
      const configuredBridge = network.Options?.['com.docker.network.bridge.name'];
      const bridgeName = typeof configuredBridge === 'string' && configuredBridge.length > 0
        ? configuredBridge : `br-${network.Id.slice(0, 12)}`;
      const bridgeResult = capture(['ip', '-j', 'link', 'show', 'dev', bridgeName]);
      const memberResult = capture(['ip', '-j', 'link', 'show', 'master', bridgeName]);
      if (bridgeResult.status !== 0 || typeof bridgeResult.stdout !== 'string'
        || memberResult.status !== 0 || typeof memberResult.stdout !== 'string') continue;
      const binding = internalDockerListenerBinding(policy, container, network,
        JSON.parse(bridgeResult.stdout), JSON.parse(memberResult.stdout));
      if (binding === null) continue;
      for (const gateway of binding.gatewayAddresses) gatewayAddresses.add(gateway);
      for (const name of binding.interfaceNames) interfaceNames.add(name);
    } catch {
      // A disappearing policy, container, network, or link cannot earn an adapter-listener exemption.
    }
  }
  return { gatewayAddresses: [...gatewayAddresses].sort(), interfaceNames: [...interfaceNames].sort(), policyPaths };
}

function isModelGatewayTypeScriptProjectBuild(commandLine) {
  if (typeof commandLine !== 'string'
    || !/(?:^|\s)services\/model-gateway\/tsconfig\.json(?:\s|$)/u.test(commandLine)
    || /(?:[&|;`\r\n]|\$\()/u.test(commandLine)) return false;
  const command = commandLine.trim().replace(/^(?:\S*\/)?sh\s+-c\s+/u, '');
  return /^(?:(?:\S*\/)?tsc|(?:\S*\/)?pnpm(?:\.cjs)?\s+(?:exec\s+)?(?:\S*\/)?tsc|(?:\S*\/)?node\s+(?:(?:\S*\/)?pnpm(?:\.cjs)?\s+(?:exec\s+)?(?:\S*\/)?tsc|\S*typescript\/bin\/tsc))\s+-b(?:\s|$)/u.test(command);
}

export function isForbiddenRuntimeCommandLine(commandLine) {
  if (typeof commandLine !== 'string') return false;
  const forbiddenRuntimePattern = /(?:start-e2e-model-gateway|start-gate-a0-release|run-gate-a0-lan|gate-a0-live|GENEWAY_LAN_|GENEWAY_MODEL_GATEWAY_|(?:^|\s)provider(?:\s|$))/iu;
  if (forbiddenRuntimePattern.test(commandLine)) return true;
  return /services\/model-gateway/iu.test(commandLine) && !isModelGatewayTypeScriptProjectBuild(commandLine);
}

function runtimeBoundarySample(rootPid, initialGlobalListeners, knownProxyPolicyPaths = [], dockerObservation) {
  const descendants = descendantProcesses(rootPid);
  const listeners = socketLinesForProcesses(['ss', '-H', '-ltnp'], descendants, 'listener');
  const egress = socketLinesForProcesses(['ss', '-H', '-tnp', 'state', 'established'], descendants, 'egress');
  const firstGlobalListeners = globalListenerLines();
  const firstAddedGlobalListeners = additions(initialGlobalListeners, firstGlobalListeners);
  observeDockerResources(dockerObservation);
  const internalDockerContext = internalDockerListenerContext(descendants, knownProxyPolicyPaths, dockerObservation);
  const listenerProcessIds = [...new Set(firstAddedGlobalListeners.flatMap((line) =>
    [...line.matchAll(/pids=([1-9][0-9]*)/gu)].map((match) => Number(match[1]))))];
  const listenerProcessProofs = new Map(listenerProcessIds.map((pid) => [pid, stableProcessCommandLine(pid)]));
  const secondGlobalListeners = globalListenerLines();
  const listenerCommandLines = new Map([...listenerProcessProofs].map(([pid, proof]) =>
    [pid, processIdentityMatchesProof(proof, processIdentityObservation(pid)) ? proof.commandLine : null]));
  const secondGlobalSet = new Set(secondGlobalListeners);
  const addedGlobalListeners = firstAddedGlobalListeners.filter((line) => secondGlobalSet.has(line));
  const unstableGlobalListeners = firstAddedGlobalListeners.filter((line) => !secondGlobalSet.has(line));
  const internalDockerAdapterListeners = firstAddedGlobalListeners.filter((line) =>
    isInternalDockerAdapterListener(line, internalDockerContext, listenerCommandLines));
  const forbiddenProcesses = descendants.filter((item) => isForbiddenRuntimeCommandLine(item.commandLine))
    .map((item) => ({ pid: item.pid, command: item.command, identity: item.commandLine.split(/\s+/u).slice(0, 4).join(' ') }));
  const listenerIsUnsafe = (line) => {
    const local = line.split(/\s+/u)[0] ?? '';
    return (!local.startsWith('127.0.0.1:') && !local.startsWith('[::1]:'))
      || /:(?:3150|3450)(?:\s|$)/u.test(local);
  };
  const internalDockerAdapterSet = new Set(internalDockerAdapterListeners);
  const unsafeListeners = [...listeners.filter(listenerIsUnsafe),
    ...unstableGlobalListeners.filter((line) => listenerIsUnsafe(line) && !internalDockerAdapterSet.has(line)),
    ...addedGlobalListeners.filter((line) => listenerIsUnsafe(line) && !internalDockerAdapterSet.has(line))];
  const nonLoopbackEgress = egress.filter((line) => {
    const connection = line.split(/\s+/u)[0] ?? '';
    const peer = connection.split('->')[1] ?? '';
    if (peer.startsWith('127.0.0.1:') || peer.startsWith('[::1]:')) return false;
    const pid = Number(line.match(/pid=(\d+)/u)?.[1] ?? 0);
    const processItem = descendants.find((item) => item.pid === pid);
    return processItem === undefined || !proxyEgressMatchesPolicy(processItem, line);
  });
  return {
    descendantCount: descendants.length,
    identities: descendants.map((item) => ({ pid: item.pid, startTicks: item.startTicks, command: item.command,
      listenerEndpoints: listeners.filter((line) => line.endsWith(`pid=${String(item.pid)}`)) })),
    addedGlobalListeners,
    internalDockerAdapterListeners,
    forbiddenProcesses,
    unsafeListeners,
    nonLoopbackEgress,
    proxyPolicyPaths: descendants.map((item) => proxyPolicyPathFromCommandLine(item.commandLine)).filter(Boolean),
  };
}

function additions(initial, final) {
  const initialSet = new Set(initial);
  return final.filter((item) => !initialSet.has(item));
}

function cleanupReceipt(initial, final, stepName) {
  const categories = {
    processes: additions(initial.processLines, final.processLines),
    listeners: additions(initial.listenerLines, final.listenerLines),
    globalListeners: additions(initial.globalListenerLines, final.globalListenerLines),
    egress: additions(initial.egressLines, final.egressLines),
    containers: additions(initial.containers, final.containers),
    workerSockets: additions(initial.workerSockets, final.workerSockets),
  };
  const receipt = { checked: true, stepName };
  for (const [name, added] of Object.entries(categories)) receipt[name] = { checked: true, passed: added.length === 0, added };
  return receipt;
}

function processIdentityStillAlive(identity) {
  try {
    const stat = readFileSync(`/proc/${String(identity.pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u);
    return fields[19] === identity.startTicks;
  } catch {
    return false;
  }
}

export function childEnvironment(runId, step, guardLibraryPath = '/tmp/geneway-runs/contract/gate02b-egress-guard.so') {
  const environment = safeEnvironment();
  Object.assign(environment, gate02bDockerIsolationEnvironment);
  environment.GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY = guardLibraryPath;
  environment.GENEWAY_GATE02B_PROXY_RUN_ROOT = `/tmp/geneway-runs/${runId}-${step.phase.toLowerCase()}-${step.name}-proxies`;
  const strippedPresentNames = findForbiddenEnvironmentNames(Object.keys(process.env));
  if (step.inheritRunId === false) delete environment.GENEWAY_RUN_ID;
  else environment.GENEWAY_RUN_ID = `${runId}-${step.phase.toLowerCase()}-${step.name}`;
  return { environment, strippedPresentNames, dockerIsolationEnvironment: {
    ...gate02bDockerIsolationEnvironment, GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY: guardLibraryPath,
    GENEWAY_GATE02B_PROXY_RUN_ROOT: environment.GENEWAY_GATE02B_PROXY_RUN_ROOT,
  } };
}

async function runStep(step, runId, outputRoot, aggregateBinding, guardLibraryPath) {
  const { environment, strippedPresentNames, dockerIsolationEnvironment } = childEnvironment(runId, step, guardLibraryPath);
  const logPath = `${outputRoot}/${step.phase}-${step.name}.log`;
  const descriptor = openSync(logPath, 'w', 0o600);
  const startedAt = new Date().toISOString();
  const beforeBinding = sourceBinding();
  if (!sourceBindingsMatch(aggregateBinding, beforeBinding)) throw new Error(`Source drift before ${step.name}`);
  const stepGlobalListenerBaseline = globalListenerLines();
  const observedIdentities = new Map();
  const runtimeReceipt = { checked: true, sampleCount: 0, maxDescendantCount: 0, unsafeListeners: [],
    internalDockerAdapterListeners: [], listenerObservations: [], nonLoopbackEgress: [], forbiddenProcesses: [],
    proxyPolicyPaths: [], sampleErrors: [] };
  const dockerObservation = createDockerObservation();
  const dockerEventMonitor = startDockerEventMonitor(dockerObservation);
  let result;
  try {
    const child = spawn(step.command[0], step.command.slice(1), {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', descriptor, descriptor],
    });
    result = await new Promise((resolveChild, rejectChild) => {
      let forcedKillTimer;
      const stopAfterSamplingFailure = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        forcedKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
      };
      const sample = () => {
        try {
          observeDockerResources(dockerObservation);
          const observed = runtimeBoundarySample(child.pid ?? -1, stepGlobalListenerBaseline,
            runtimeReceipt.proxyPolicyPaths, dockerObservation);
          runtimeReceipt.sampleCount += 1;
          runtimeReceipt.maxDescendantCount = Math.max(runtimeReceipt.maxDescendantCount, observed.descendantCount);
          runtimeReceipt.addedGlobalListeners ??= [];
          runtimeReceipt.addedGlobalListeners.push(...observed.addedGlobalListeners);
          runtimeReceipt.internalDockerAdapterListeners.push(...observed.internalDockerAdapterListeners);
          runtimeReceipt.unsafeListeners.push(...observed.unsafeListeners);
          runtimeReceipt.listenerObservations.push({ sample: runtimeReceipt.sampleCount,
            unsafe: observed.unsafeListeners, validated: observed.internalDockerAdapterListeners });
          runtimeReceipt.nonLoopbackEgress.push(...observed.nonLoopbackEgress);
          runtimeReceipt.forbiddenProcesses.push(...observed.forbiddenProcesses);
          runtimeReceipt.proxyPolicyPaths.push(...observed.proxyPolicyPaths);
          for (const identity of observed.identities) observedIdentities.set(`${String(identity.pid)}:${identity.startTicks}`, identity);
        } catch (cause) {
          runtimeReceipt.sampleErrors.push(cause instanceof Error ? cause.message : String(cause));
          stopAfterSamplingFailure();
        }
      };
      sample();
      const timer = setInterval(sample, 100);
      child.once('error', (error) => { clearInterval(timer); if (forcedKillTimer !== undefined) clearTimeout(forcedKillTimer); rejectChild(error); });
      child.once('exit', (status, signal) => {
        clearInterval(timer);
        sample();
        if (forcedKillTimer !== undefined) clearTimeout(forcedKillTimer);
        resolveChild({ status, signal });
      });
    });
  } finally {
    try {
      try { closeSync(descriptor); } catch (cause) {
        runtimeReceipt.sampleErrors.push(`log-close:${cause instanceof Error ? cause.message : String(cause)}`);
      }
      try { observeDockerResources(dockerObservation); } catch (cause) {
        runtimeReceipt.sampleErrors.push(`final-docker-sample:${cause instanceof Error ? cause.message : String(cause)}`);
      }
    } finally {
      try { await stopDockerEventMonitor(dockerEventMonitor, dockerObservation); } catch (cause) {
        dockerObservation.monitorErrors.push(`stop:${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  runtimeReceipt.addedGlobalListeners = [...new Set(runtimeReceipt.addedGlobalListeners ?? [])].sort();
  runtimeReceipt.internalDockerAdapterListeners = [...new Set(runtimeReceipt.internalDockerAdapterListeners)].sort();
  runtimeReceipt.unsafeListeners = unresolvedUnsafeListeners(runtimeReceipt.listenerObservations);
  runtimeReceipt.nonLoopbackEgress = [...new Set(runtimeReceipt.nonLoopbackEgress)].sort();
  runtimeReceipt.forbiddenProcesses = [...new Map(runtimeReceipt.forbiddenProcesses.map((item) => [`${String(item.pid)}:${item.identity}`, item])).values()];
  const backupRunsRequired = ['gate0.2b.3', 'gate0.2a-baseline'].includes(step.name);
  const backupLog = readFileSync(logPath, 'utf8');
  const expectedBackupRuns = extractStructuredBackupRuns(backupLog, backupRunsRequired);
  const expectedBackupRunIds = expectedBackupRuns.map((result) => result.runId);
  const proxyRoots = [...new Set([
    environment.GENEWAY_GATE02B_PROXY_RUN_ROOT,
    ...expectedBackupRunIds.map((runId) => `/tmp/geneway-runs/${runId}-proxies`),
  ])];
  runtimeReceipt.structuralIsolation = dockerStructuralIsolationReceipt(dockerObservation, expectedBackupRunIds, proxyRoots,
    { ...step, expectedBackupProjects: expectedBackupProxyProjects(expectedBackupRuns) });
  const afterGlobalListeners = globalListenerLines();
  const identities = [...observedIdentities.values()].sort((left, right) => left.pid - right.pid);
  const survivors = identities.filter(processIdentityStillAlive);
  const addedEndpoints = additions(stepGlobalListenerBaseline, afterGlobalListeners);
  runtimeReceipt.processLifecycle = { checked: true, beforeGlobalListeners: stepGlobalListenerBaseline,
    afterGlobalListeners, identities, survivors, addedEndpoints, sampleErrors: runtimeReceipt.sampleErrors,
    passed: survivors.length === 0 && addedEndpoints.length === 0 && runtimeReceipt.sampleErrors.length === 0 };
  runtimeReceipt.passed = runtimeReceipt.unsafeListeners.length === 0 && runtimeReceipt.nonLoopbackEgress.length === 0
    && runtimeReceipt.forbiddenProcesses.length === 0 && runtimeReceipt.structuralIsolation.passed
    && runtimeReceipt.processLifecycle.passed;
  const afterBinding = sourceBinding();
  const sourceStable = sourceBindingsMatch(aggregateBinding, afterBinding) && sourceBindingsMatch(beforeBinding, afterBinding);
  return {
    phase: step.phase,
    name: step.name,
    command: step.command.join(' '),
    runId: step.inheritRunId === false ? null : environment.GENEWAY_RUN_ID,
    logPath,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
    sourceBinding: { before: beforeBinding, after: afterBinding, stable: sourceStable },
    runtimeBoundary: runtimeReceipt,
    credentialBoundary: { checked: true, passed: true, valuesRead: false, strippedNames: strippedPresentNames, forbiddenNamesPassed: [] },
    dockerIsolationEnvironment: { checked: true, passed: Object.entries(gate02bDockerIsolationEnvironment)
      .every(([name, value]) => dockerIsolationEnvironment[name] === value), values: dockerIsolationEnvironment },
  };
}

function readPassingE2eReceipt(path, expectedKeys) {
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  const passed = receipt.passed === true && Array.isArray(receipt.testKeys)
    && expectedKeys.every((key) => receipt.testKeys.includes(key));
  if (!passed) throw new Error(`Gate 0.2B E2E receipt is incomplete: ${path}`);
  return { path, passed: true, expectedCount: receipt.expectedCount, observedCount: receipt.observedCount, testKeys: expectedKeys };
}

function collectChildEvidence(runId, aggregateBinding, results) {
  const v6RunId = `${runId}-v6-gate0.2b.3`;
  const aggregatePath = `/tmp/geneway-runs/${v6RunId}/gate0.2b.3-aggregate.json`;
  const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
  const v6Binding = aggregate.sourceBinding;
  const gate02aResult = results.find((result) => result.name === 'gate0.2a-baseline');
  if (gate02aResult === undefined) throw new Error('Gate 0.2A baseline result is missing');
  const gate02aLog = readFileSync(gate02aResult.logPath, 'utf8');
  const v6Result = results.find((result) => result.name === 'gate0.2b.3');
  if (v6Result === undefined) throw new Error('Gate 0.2B.3 result is missing');
  const v6Log = readFileSync(v6Result.logPath, 'utf8');
  const receiptsForStep = (name) => {
    const result = results.find((item) => item.name === name);
    if (result === undefined) throw new Error(`Gate 0.2B result is missing: ${name}`);
    const log = readFileSync(result.logPath, 'utf8');
    const paths = [...new Set([...log.matchAll(/geneway E2E report gate passed: (\/tmp\/geneway-runs\/[^\s]+\/e2e-report-gate\.json)/gu)]
      .flatMap((match) => match[1] === undefined ? [] : [match[1]]))];
    return paths.map((path) => ({ path, receipt: JSON.parse(readFileSync(path, 'utf8')) }));
  };
  const gate02aPaths = [...new Set([...gate02aLog.matchAll(/geneway E2E report gate passed: (\/tmp\/geneway-runs\/[^\s]+\/e2e-report-gate\.json)/gu)]
    .map((match) => match[1]).filter((path) => path !== undefined))];
  const gate02aReceipts = gate02aPaths.map((path) => {
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (receipt.passed !== true || !Array.isArray(receipt.testKeys)) throw new Error(`Gate 0.2A receipt is incomplete: ${path}`);
    return { path, passed: true, testKeys: receipt.testKeys };
  });
  const gate02aTestKeys = gate02aReceipts.flatMap((receipt) => receipt.testKeys);
  if (gate02aReceipts.length < 3
    || !gate02aTestKeys.some((key) => key.startsWith('gate0.1\u0000'))
    || !gate02aTestKeys.some((key) => key.startsWith('gate0.2a-success\u0000'))
    || !gate02aTestKeys.some((key) => key.startsWith('gate0.2a-negative\u0000'))) {
    throw new Error('Gate 0.2A baseline E2E receipt membership is incomplete');
  }
  const v5Receipts = receiptsForStep('gate0.2b.2');
  const v5Keys = v5Receipts.flatMap((item) => item.receipt.testKeys ?? []);
  if (v5Receipts.length !== 2
    || v5Receipts.some((item) => item.receipt.passed !== true || !Array.isArray(item.receipt.testKeys))
    || !v5Keys.some((key) => key.includes('gate-0.2b-task-workflow-routes.spec.ts'))
    || !v5Keys.some((key) => key.includes('gate-0.2b-exception-flow.spec.ts'))) throw new Error('Gate 0.2B.2 requires two distinct E2E reports');
  const gate02b1Receipts = receiptsForStep('gate0.2b.1-baseline');
  const localReceipts = receiptsForStep('local-a0-no-business-objects');
  if (gate02b1Receipts.length !== 1 || localReceipts.length !== 1) throw new Error('Gate 0.2B V7 E2E report cardinality is invalid');
  const reports = {
    v5: v5Receipts.map((item) => ({ path: item.path, passed: item.receipt.passed === true, testKeys: item.receipt.testKeys })),
    gate02a: gate02aReceipts,
    gate02b1: readPassingE2eReceipt(gate02b1Receipts[0].path, [
      'gate0.2b-success\u0000gate-0.2b-task-workflow-routes.spec.ts\u0000真实任务可从六条 served 路由恢复，并与 API、Postgres 和 Worker 保持同一关联',
    ]),
    localA0: readPassingE2eReceipt(localReceipts[0].path, [
      'gate0.2b-fast-chat-local\u0000gate-0.2b-fast-chat-local.spec.ts\u0000默认 Fast Chat 无需材料且不创建 Gate 0.2B 业务对象',
    ]),
  };
  const everyStepBound = results.every((result) => result.sourceBinding?.stable === true);
  const passed = aggregate.passed === true && aggregate.sourceStable === true
    && sourceBindingsMatch(aggregateBinding, v6Binding) && everyStepBound;
  if (!passed) throw new Error('Gate 0.2B child evidence or local A0 served routing receipt is incomplete');
  const artifactRoots = [
    dirname(aggregatePath), ...v5Receipts.map((item) => dirname(item.path)),
    ...gate02b1Receipts.map((item) => dirname(item.path)), ...localReceipts.map((item) => dirname(item.path)),
    ...gate02aPaths.map((path) => dirname(path)),
    ...[...v6Log.matchAll(/\/tmp\/geneway-runs\/[A-Za-z0-9._-]+\/(?:e2e-report-gate|gate0\.2b\.3-aggregate)\.json/gu)]
      .flatMap((match) => match[0] === undefined ? [] : [dirname(match[0])]),
    ...backupArtifactRoots(results),
  ];
  return {
    checked: true,
    passed,
    gate02b3AggregatePath: aggregatePath,
    reports,
    everyStepSourceBound: everyStepBound,
    artifactRoots: [...new Set(artifactRoots)].sort(),
    stepEvidence: results.map((result) => ({ name: result.name, logPath: result.logPath,
      sourceBinding: result.sourceBinding, runtimeBoundary: result.runtimeBoundary, credentialBoundary: result.credentialBoundary })),
    localA0Evidence: {
      servedDefaultFastChatNoMaterial: true,
      noBusinessObjectsCommand: 'pnpm test:e2e -- --project=gate0.2b-fast-chat-local',
    },
  };
}

export async function runGate02bAggregate() {
  const runId = process.env.GENEWAY_RUN_ID ?? `gate0.2b-${Date.now()}-${process.pid}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
  const runRoot = `/tmp/geneway-runs/${runId}`;
  const outputRoot = `${runRoot}/gate-0.2b`;
  if (existsSync(runRoot)) throw new Error(`Gate 0.2B run root already exists: ${runRoot}`);
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const summaryPath = `${outputRoot}/gate0.2b-aggregate.json`;
  const results = [];
  const cleanupReceipts = [];
  let initialBinding;
  let finalBinding;
  let pathAudit;
  let initialBoundary;
  let childEvidence;
  let sourceSecretReceipt;
  let artifactSecretReceipt;
  let dockerIsolationPreparation;
  const forbiddenNamesPresent = findForbiddenEnvironmentNames(Object.keys(process.env));
  let reachableCommands = [];
  let commandSafetyPassed = false;
  let failure = null;
  try {
    validateGate02bStepPlan(requiredGate02bSteps);
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
    const nestedVerifierPath = 'scripts/verify-gate0.2b.3.mjs';
    const nestedVerifierSources = { [nestedVerifierPath]: readFileSync(resolve(repositoryRoot, nestedVerifierPath), 'utf8') };
    validateGate02bInvocationTopology(manifest.scripts ?? {}, requiredGate02bSteps, nestedVerifierSources);
    reachableCommands = validateCommandStrings(collectReachableCommandStrings(
      manifest.scripts ?? {}, requiredGate02bSteps.map((step) => step.command.join(' ')),
      nestedVerifierSources,
    ));
    commandSafetyPassed = true;
    if (forbiddenNamesPresent.length > 0) {
      throw new Error(`Gate 0.2B forbidden credential environment names are present: ${forbiddenNamesPresent.join(', ')}`);
    }
    dockerIsolationPreparation = prepareDockerIsolation(outputRoot);
    pathAudit = changedPathAudit();
    sourceSecretReceipt = secretScan(pathAudit.changedPaths);
    initialBinding = sourceBinding();
    initialBoundary = boundarySnapshot();
    const cleanStateReceipt = cleanupReceipt({
      processLines: [], listenerLines: [], globalListenerLines: initialBoundary.globalListenerLines,
      egressLines: [], containers: [], workerSockets: [],
    }, initialBoundary, 'clean-state-preflight');
    cleanupReceipts.push(cleanStateReceipt);
    validateCleanupReceipt(cleanStateReceipt);
    for (const step of requiredGate02bSteps) {
      const result = await runStep(step, runId, outputRoot, initialBinding, dockerIsolationPreparation.libraryPath);
      results.push(result);
      let currentBoundary;
      try {
        currentBoundary = boundarySnapshot();
      } catch (cause) {
        throw new Error(`Boundary receipt missing after ${step.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const receipt = cleanupReceipt(initialBoundary, currentBoundary, step.name);
      cleanupReceipts.push(receipt);
      validateCleanupReceipt(receipt);
      if (result.status !== 0 || result.signal !== null) throw new Error(`Gate 0.2B child failed: ${step.name}`);
      if (result.sourceBinding.stable !== true) throw new Error(`Gate 0.2B source drift detected in child: ${step.name}`);
      if (result.runtimeBoundary.passed !== true) throw new Error(`Gate 0.2B runtime listener/egress boundary failed: ${step.name}`);
      if (result.dockerIsolationEnvironment.passed !== true) throw new Error(`Gate 0.2B Docker isolation environment missing: ${step.name}`);
    }
    childEvidence = collectChildEvidence(runId, initialBinding, results);
    artifactSecretReceipt = runArtifactSecretScan([outputRoot, ...childEvidence.artifactRoots]);
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  } finally {
    try {
      finalBinding = sourceBinding();
    } catch (cause) {
      failure ??= `Final source receipt missing: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  const sourceStable = initialBinding !== undefined && finalBinding !== undefined
    && sourceBindingsMatch(initialBinding, finalBinding);
  if (!sourceStable && failure === null) failure = 'Gate 0.2B source drift detected';
  const passed = failure === null && gate02bAggregatePassed({
    results,
    sourceStable,
    cleanupReceipts,
    childEvidencePassed: childEvidence?.passed === true,
    secretReceiptsPassed: sourceSecretReceipt?.passed === true && artifactSecretReceipt?.passed === true,
  });
  const aggregate = {
    schemaVersion: 'geneway-gate0.2b-aggregate/1',
    runId,
    passed,
    failure,
    sourceStable,
    sourceBinding: { initial: initialBinding ?? null, final: finalBinding ?? null },
    pathAudit: pathAudit ?? null,
    requiredOrder: requiredGate02bSteps.map((step) => `${step.phase}:${step.name}`),
    commandSafetyReceipt: {
      checked: true,
      passed: commandSafetyPassed,
      commands: reachableCommands,
      forbiddenPatterns: forbiddenCommandPatterns.map((pattern) => pattern.source),
    },
    dockerIsolationPolicy: {
      checked: true,
      environment: gate02bDockerIsolationEnvironment,
      preparation: dockerIsolationPreparation ?? null,
      commandOverrideScanPassed: commandSafetyPassed,
      childReceipts: results.map((result) => ({ name: result.name, environment: result.dockerIsolationEnvironment,
        structuralIsolation: result.runtimeBoundary?.structuralIsolation, processLifecycle: result.runtimeBoundary?.processLifecycle })),
      passed: commandSafetyPassed && results.length === requiredGate02bSteps.length
        && results.every((result) => result.dockerIsolationEnvironment?.passed === true
          && result.runtimeBoundary?.structuralIsolation?.passed === true && result.runtimeBoundary?.processLifecycle?.passed === true),
    },
    credentialReceipt: {
      checked: true,
      passed: forbiddenNamesPresent.length === 0 && results.every((result) => result.credentialBoundary?.passed === true),
      valuesRead: false,
      authPathAccessed: false,
      forbiddenEnvironmentNamesChecked: [
        ...strippedCredentialEnvironmentNames, 'GENEWAY_LAN_*', 'GENEWAY_MODEL_GATEWAY_*', 'GENEWAY_GATE_A0_RELEASE_*',
      ],
      forbiddenEnvironmentNamesPresent: forbiddenNamesPresent,
      childReceipts: results.map((result) => result.credentialBoundary),
    },
    secretReceipt: { source: sourceSecretReceipt ?? null, runArtifacts: artifactSecretReceipt ?? null },
    cleanupReceipts,
    cleanupPolicy: {
      checked: true,
      automaticPreexistingResourceCleanup: false,
      ownedRunCleanupOnly: true,
      ownershipBasis: 'resources must be absent at preflight; post-step receipts reject every newly added process/listener/egress/container/network/volume/UDS entry',
    },
    childEvidence: childEvidence ?? null,
    results,
  };
  writeFileSync(summaryPath, `${JSON.stringify(aggregate, null, 2)}\n`, { mode: 0o600 });
  if (!passed) {
    process.stderr.write(`geneway Gate 0.2B aggregate failed: ${summaryPath}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`geneway Gate 0.2B aggregate passed: ${summaryPath}\n`);
  }
  return aggregate;
}

if (basename(process.argv[1] ?? '') === basename(fileURLToPath(import.meta.url))) await runGate02bAggregate();
