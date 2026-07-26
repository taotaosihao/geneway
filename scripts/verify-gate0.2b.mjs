import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  buildAmbientRygelListenerProof,
  buildPreGateRygelProcessProof,
  parseSsListenerRow,
  tryParseSsListenerRow,
} from './gate02b-ambient-listener-proof.mjs';
import { dockerTeardownProofReceipt } from './gate02b-docker-teardown-proof.mjs';

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

function globalListenerSnapshot() {
  const raw = detailedGlobalListenerSnapshot();
  const lines = raw.map((line) => {
    const parsed = parseSocketLine(line, 'listener');
    return `${parsed.local} pids=${parsed.pids.sort((left, right) => left - right).join(',')}`;
  }).sort();
  return { raw, lines };
}

function globalListenerLines() {
  return globalListenerSnapshot().lines;
}

function detailedGlobalListenerSnapshot() {
  const result = capture(['ss', '-H', '-O', '-ltnpe']);
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('Unable to capture detailed global listener receipt');
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

function ambientListenerProofHooks(initialSnapshot = null) {
  const pendingSnapshots = initialSnapshot === null ? []
    : Array.isArray(initialSnapshot[0]) ? [...initialSnapshot] : [initialSnapshot];
  return {
    readProcessStat: (pid) => readFileSync(`/proc/${String(pid)}/stat`, 'utf8'),
    readCmdline: (pid) => readFileSync(`/proc/${String(pid)}/cmdline`),
    readExecutableIdentity: (pid) => {
      const path = readlinkSync(`/proc/${String(pid)}/exe`);
      const stat = statSync(`/proc/${String(pid)}/exe`);
      return { path, dev: stat.dev, inode: stat.ino };
    },
    readCgroup: (pid) => readFileSync(`/proc/${String(pid)}/cgroup`, 'utf8'),
    readNetns: (pid) => readlinkSync(`/proc/${String(pid)}/ns/net`),
    readFdLink: (pid, fd) => readlinkSync(`/proc/${String(pid)}/fd/${String(fd)}`),
    readSsSnapshot: () => {
      const snapshot = pendingSnapshots.shift() ?? detailedGlobalListenerSnapshot();
      return `${snapshot.join('\n')}\n`;
    },
  };
}

function preGateAmbientRygelProofs() {
  const pids = [...new Set(detailedGlobalListenerSnapshot().flatMap((line) => {
    const parsed = tryParseSsListenerRow(line);
    return parsed.ok && parsed.value.owner === 'rygel' ? [parsed.value.pid] : [];
  }))].sort((left, right) => left - right);
  const proofs = new Map();
  for (const pid of pids) {
    try {
      const proof = buildPreGateRygelProcessProof(pid, ambientListenerProofHooks());
      if (/\/rygel\.service$/u.test(proof.cgroup)) proofs.set(pid, proof);
    } catch {
      // An incomplete or unstable ambient process never enters the pre-Gate trust set.
    }
  }
  return proofs;
}

export function parseOwnerlessAmbientEnvelope(raw) {
  if (typeof raw !== 'string' || /users:\(|pid=|fd=/u.test(raw)) return null;
  const columns = raw.trim().match(/^LISTEN\s+[0-9]+\s+[0-9]+\s+(\S+)\s+(\S+)\s+(.+)$/u);
  if (columns === null) return null;
  const ipv4 = columns[1].match(/^(\d+\.\d+\.\d+\.\d+):([1-9][0-9]{0,4})$/u);
  const ipv6 = columns[1].match(/^\[([0-9a-f:]+)\]%([A-Za-z0-9_.-]+):([1-9][0-9]{0,4})$/iu);
  const family = ipv4 === null ? 'ipv6' : 'ipv4';
  const address = ipv4?.[1] ?? ipv6?.[1]?.toLowerCase();
  const scope = ipv6?.[2] ?? null;
  const port = Number(ipv4?.[2] ?? ipv6?.[3] ?? 0);
  if (address === undefined || !Number.isInteger(port) || port < 1 || port > 65_535
    || [3150, 3450].includes(port) || columns[2] !== (family === 'ipv4' ? '0.0.0.0:*' : '[::]:*')) return null;
  const cgroup = [...columns[3].matchAll(/(?:^|\s)cgroup:(\/\S*)(?=\s|$)/gu)];
  const uid = [...columns[3].matchAll(/(?:^|\s)uid:([0-9]+)(?=\s|$)/gu)];
  const inode = [...columns[3].matchAll(/(?:^|\s)ino:([1-9][0-9]*)(?=\s|$)/gu)];
  const sk = [...columns[3].matchAll(/(?:^|\s)sk:([0-9a-f]+)(?=\s|$)/giu)];
  if (cgroup.length !== 1 || uid.length !== 1 || inode.length !== 1 || sk.length !== 1) return null;
  return { family, address, scope, port, endpoint: columns[1], uid: Number(uid[0][1]),
    socketInode: inode[0][1], sk: sk[0][1].toLowerCase(), cgroup: cgroup[0][1], raw };
}

function immutableAmbientWitness(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') immutableAmbientWitness(child);
  }
  return Object.freeze(value);
}

function ambientOwnershipSources(proxyRunRoot, knownPolicyPaths = []) {
  const byNetworkName = new Map();
  const byNetworkId = new Map();
  for (const [directoryName, schemaVersion] of [
    ['invocations', 'geneway-gate02b-storage-invocation/1'],
    ['backup-invocations', 'geneway-gate02b-backup-invocation/1'],
  ]) {
    const invocationRoot = resolve(proxyRunRoot, directoryName);
    if (!existsSync(invocationRoot)) continue;
    for (const name of readdirSync(invocationRoot).sort()) {
      const path = resolve(invocationRoot, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) continue;
      const bytes = readFileSync(path);
      const manifest = JSON.parse(bytes.toString('utf8'));
      const source = { kind: 'invocation-manifest', ref: path,
        sha256: createHash('sha256').update(bytes).digest('hex') };
      if (schemaVersion === 'geneway-gate02b-storage-invocation/1') {
        if (manifest?.schemaVersion !== schemaVersion || typeof manifest.project !== 'string'
          || name !== `${manifest.project}.json`) continue;
        for (const networkName of Object.values(manifest.networks ?? {})) {
          if (typeof networkName === 'string') byNetworkName.set(networkName, { project: manifest.project, source });
        }
      } else {
        if (manifest?.schemaVersion !== schemaVersion || name !== `${manifest.runId}.json`
          || !/^backup-restore-suite-[A-Za-z0-9._-]+$/u.test(manifest.runId ?? '')
          || manifest.childProxyRoot !== `/tmp/geneway-runs/${manifest.runId}-proxies`
          || !Array.isArray(manifest.projects) || manifest.projects.length !== 2
          || !Array.isArray(manifest.networks) || manifest.networks.length !== 2) continue;
        for (const [index, networkName] of manifest.networks.entries()) {
          const project = manifest.projects[index];
          if (networkName === `${project}_default`) byNetworkName.set(networkName, { project, source });
        }
      }
    } catch {
      // Invalid manifests cannot establish ambient listener ownership.
    }
    }
  }
  for (const path of [...new Set(knownPolicyPaths)]) {
    try {
      const policy = validateProxyPolicy(JSON.parse(readFileSync(path, 'utf8')), dirname(dirname(path)));
      byNetworkId.set(policy.target.networkId, { project: policy.target.project,
        source: { kind: 'proxy-policy', ref: path, sha256: policy.policyHash } });
    } catch {
      // Invalid or disappearing policy evidence cannot establish ownership.
    }
  }
  return { byNetworkName, byNetworkId };
}

function exactAmbientOwnedInterfaceWitness(row, dockerObservation, proxyRunRoot, knownPolicyPaths = []) {
  const ownership = ambientOwnershipSources(proxyRunRoot, knownPolicyPaths);
  const candidates = [];
  for (const observed of dockerObservation.networks.values()) {
    if (observed.lastLiveGeneration !== dockerObservation.observationGeneration
      || observed.inspectObserved !== true || observed.internal !== true || observed.driver !== 'bridge'
      || observed.identityConflict === true || typeof observed.name !== 'string'
      || typeof observed.project !== 'string' || typeof observed.bridgeName !== 'string'
      || observed.bridgeIdentity === undefined) continue;
    const owned = ownership.byNetworkName.get(observed.name) ?? ownership.byNetworkId.get(observed.id);
    if (owned === undefined || owned.project !== observed.project) continue;
    const matchedIdentity = row.family === 'ipv4' ? observed.bridgeIdentity
      : row.scope === observed.bridgeName ? observed.bridgeIdentity : observed.memberIdentities?.get(row.scope);
    const interfaceName = row.family === 'ipv4' ? observed.bridgeName : row.scope;
    const addresses = row.family === 'ipv4' || row.scope === observed.bridgeName
      ? observed.bridgeAddresses : observed.memberAddresses?.get(row.scope);
    if (matchedIdentity === undefined || interfaceName === null || !addresses?.has(row.address)) continue;
    candidates.push(immutableAmbientWitness({
      schemaVersion: 'geneway-gate02b-internal-docker-test-interface/1', repositoryOwned: true,
      internal: true, testOnly: true, driver: 'bridge', composeProject: observed.project,
      networkId: observed.id, networkName: observed.name, interfaceName,
      interfaceMac: matchedIdentity.address, ifindex: matchedIdentity.ifindex,
      netns: readlinkSync('/proc/self/ns/net'), addresses: [row.address],
      bridge: { name: observed.bridgeName, ifindex: observed.bridgeIdentity.ifindex,
        mac: observed.bridgeIdentity.address }, source: owned.source,
      observationBasis: 'PRE_LISTENER_FROZEN_LIVE_IDENTITY',
    }));
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return null;
  for (const observed of dockerObservation.networks.values()) {
    const inspectedResult = dockerJson(['docker', 'network', 'inspect', observed.id]);
    const network = Array.isArray(inspectedResult) ? inspectedResult[0] : undefined;
    if (network?.Id !== observed.id || network.Internal !== true || network.Driver !== 'bridge'
      || !isRepositoryDockerScope(network.Name, network.Labels ?? {})) continue;
    const owned = ownership.byNetworkName.get(network.Name) ?? ownership.byNetworkId.get(network.Id);
    const project = network.Labels?.['com.docker.compose.project'];
    if (owned === undefined || owned.project !== project) continue;
    const configuredBridge = network.Options?.['com.docker.network.bridge.name'];
    const bridgeName = typeof configuredBridge === 'string' && configuredBridge.length > 0
      ? configuredBridge : `br-${network.Id.slice(0, 12)}`;
    const bridgeResult = capture(['ip', '-j', 'address', 'show', 'dev', bridgeName]);
    if (bridgeResult.status !== 0 || typeof bridgeResult.stdout !== 'string') continue;
    let bridge;
    try { [bridge] = JSON.parse(bridgeResult.stdout); } catch { continue; }
    if (bridge?.ifname !== bridgeName || !Number.isInteger(bridge.ifindex) || typeof bridge.address !== 'string'
      || JSON.stringify({ ifindex: bridge.ifindex, address: bridge.address }) !== JSON.stringify(observed.bridgeIdentity)) continue;
    let matched = bridge;
    if (row.family === 'ipv4') {
      const gateways = (network.IPAM?.Config ?? []).flatMap((config) => typeof config.Gateway === 'string' ? [config.Gateway] : []);
      const assigned = (bridge.addr_info ?? []).some((address) => address.local === row.address);
      if (!gateways.includes(row.address) || !assigned) continue;
    } else {
      const interfaceResult = capture(['ip', '-j', 'address', 'show', 'dev', row.scope]);
      if (interfaceResult.status !== 0 || typeof interfaceResult.stdout !== 'string') continue;
      try { [matched] = JSON.parse(interfaceResult.stdout); } catch { continue; }
      const cachedMember = observed.memberIdentities?.get(row.scope);
      const exactBridge = row.scope === bridgeName && matched?.ifindex === bridge.ifindex && matched?.address === bridge.address;
      const exactMember = cachedMember !== undefined && matched?.ifindex === cachedMember.ifindex
        && matched?.address === cachedMember.address && matched?.master === bridgeName;
      if ((!exactBridge && !exactMember) || !(matched.addr_info ?? []).some((address) => address.local === row.address)) continue;
    }
    candidates.push(immutableAmbientWitness({
      schemaVersion: 'geneway-gate02b-internal-docker-test-interface/1', repositoryOwned: true,
      internal: true, testOnly: true, driver: 'bridge', composeProject: project,
      networkId: network.Id, networkName: network.Name, interfaceName: matched.ifname,
      interfaceMac: matched.address, ifindex: matched.ifindex, netns: readlinkSync('/proc/self/ns/net'),
      addresses: [row.address],
      bridge: { name: bridgeName, ifindex: bridge.ifindex, mac: bridge.address }, source: owned.source,
    }));
  }
  if (candidates.length === 0) {
    const linksResult = capture(['ip', '-j', 'address', 'show']);
    let liveLinks = null;
    try { if (linksResult.status === 0 && typeof linksResult.stdout === 'string') liveLinks = JSON.parse(linksResult.stdout); } catch { liveLinks = null; }
    for (const observed of dockerObservation.networks.values()) {
      if (observed.inspectObserved !== true || observed.internal !== true || observed.driver !== 'bridge'
        || observed.identityConflict === true || typeof observed.name !== 'string'
        || typeof observed.project !== 'string' || typeof observed.bridgeName !== 'string'
        || observed.bridgeIdentity === undefined) continue;
      const owned = ownership.byNetworkName.get(observed.name) ?? ownership.byNetworkId.get(observed.id);
      if (owned === undefined || owned.project !== observed.project) continue;
      const cachedIdentity = row.family === 'ipv4' ? observed.bridgeIdentity
        : row.scope === observed.bridgeName ? observed.bridgeIdentity : observed.memberIdentities?.get(row.scope);
      const interfaceName = row.family === 'ipv4' ? observed.bridgeName : row.scope;
      if (cachedIdentity === undefined || (row.family === 'ipv4' && !observed.gatewayAddresses?.has(row.address))) continue;
      const live = liveLinks?.find((link) => link.ifname === interfaceName && link.ifindex === cachedIdentity.ifindex
        && link.address === cachedIdentity.address);
      const liveExact = live !== undefined && (live.addr_info ?? []).some((address) => address.local === row.address);
      const identityOrAddressReused = liveLinks?.some((link) => link.ifname === interfaceName
        || link.ifindex === cachedIdentity.ifindex || link.address === cachedIdentity.address
        || (link.addr_info ?? []).some((address) => address.local === row.address)) ?? true;
      const teardownExact = !identityOrAddressReused && exactNetworkRemovalObserved(observed.id);
      if (!liveExact && !teardownExact) continue;
      candidates.push(immutableAmbientWitness({
        schemaVersion: 'geneway-gate02b-internal-docker-test-interface/1', repositoryOwned: true,
        internal: true, testOnly: true, driver: 'bridge', composeProject: observed.project,
        networkId: observed.id, networkName: observed.name, interfaceName, interfaceMac: cachedIdentity.address,
        ifindex: cachedIdentity.ifindex, netns: readlinkSync('/proc/self/ns/net'), addresses: [row.address],
        bridge: { name: observed.bridgeName, ifindex: observed.bridgeIdentity.ifindex, mac: observed.bridgeIdentity.address },
        source: owned.source, observationBasis: liveExact ? 'CACHED_IDENTITY_RECONFIRMED_LIVE' : 'EXACT_TEARDOWN_NO_REUSE',
      }));
    }
  }
  const unique = [...new Map(candidates.map((candidate) =>
    [`${candidate.networkId}:${candidate.interfaceName}:${String(candidate.ifindex)}`, candidate])).values()];
  return unique.length === 1 ? unique[0] : null;
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

export function ownerlessEnvelopeMatchesReleasedProof(receipt, state) {
  const envelope = receipt?.envelope;
  const proof = state?.proof;
  const listener = proof?.listener;
  return receipt?.schemaVersion === 'geneway-gate02b-ownerless-ambient-pending/1'
    && ['RELEASED', 'GONE'].includes(state?.status)
    && envelope?.endpoint === listener?.endpoint && envelope?.uid === listener?.uid
    && envelope?.socketInode === listener?.socketInode && envelope?.sk === listener?.sk
    && envelope?.cgroup === listener?.cgroup
    && receipt.processProof?.processInstanceKey === proof?.process?.processInstanceKey
    && receipt.interfaceWitness?.networkId === proof?.interfaceWitness?.networkId
    && receipt.interfaceWitness?.networkName === proof?.interfaceWitness?.networkName
    && receipt.interfaceWitness?.interfaceName === proof?.interfaceWitness?.interfaceName
    && receipt.interfaceWitness?.ifindex === proof?.interfaceWitness?.ifindex
    && receipt.interfaceWitness?.interfaceMac === proof?.interfaceWitness?.interfaceMac
    && receipt.interfaceWitness?.source?.sha256 === proof?.interfaceWitness?.source?.sha256;
}

function ownerlessEnvelopeMatchesTransientRelease(receipt, release) {
  const envelope = receipt?.envelope;
  const listener = release?.listener;
  return receipt?.schemaVersion === 'geneway-gate02b-ownerless-ambient-pending/1'
    && release?.schemaVersion === 'geneway-gate02b-owned-ambient-transient-release/1'
    && release?.status === 'RELEASED_DURING_OWNER_TEARDOWN' && release?.consecutiveAbsenceSnapshots >= 2
    && envelope?.endpoint === listener?.endpoint && envelope?.uid === listener?.uid
    && envelope?.socketInode === listener?.socketInode && envelope?.sk === listener?.sk
    && envelope?.cgroup === listener?.cgroup
    && receipt.processProof?.processInstanceKey === release?.processProof?.processInstanceKey
    && receipt.interfaceWitness?.networkId === release?.interfaceWitness?.networkId
    && receipt.interfaceWitness?.networkName === release?.interfaceWitness?.networkName
    && receipt.interfaceWitness?.interfaceName === release?.interfaceWitness?.interfaceName
    && receipt.interfaceWitness?.ifindex === release?.interfaceWitness?.ifindex
    && receipt.interfaceWitness?.interfaceMac === release?.interfaceWitness?.interfaceMac
    && receipt.interfaceWitness?.source?.sha256 === release?.interfaceWitness?.source?.sha256;
}

export function unresolvedUnsafeListeners(observations, terminalStates = [], transientReleases = []) {
  return [...new Set(observations.flatMap((observation) => observation.unsafe.filter((line) => {
    if (observation.unsafeSources?.descendants?.includes(line)) return true;
    const receipts = (observation.unsafeReceipts ?? []).filter((receipt) => receipt.line === line);
    return !receipts.some((receipt) => terminalStates.some((state) => ownerlessEnvelopeMatchesReleasedProof(receipt, state))
      || transientReleases.some((release) => ownerlessEnvelopeMatchesTransientRelease(receipt, release)));
  })))].sort();
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
    lifecycleEvents: [], lifecycleEventKeys: new Set(), monitorStarted: false, eventBoundaryMs: Date.now(),
    observationGeneration: 0 };
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

function observeDockerNetwork(state, identity, generation = state.observationGeneration) {
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
  existing.subnets = (network.IPAM?.Config ?? []).flatMap((config) => typeof config.Subnet === 'string' ? [config.Subnet] : []).sort();
  const observedBridgeAddresses = new Set();
  const observedMemberAddresses = new Map();
  let bridgeObservedThisGeneration = false;
  for (const config of network.IPAM?.Config ?? []) {
    if (typeof config.Gateway === 'string') existing.gatewayAddresses.add(config.Gateway);
  }
  if (existing.internal && existing.driver === 'bridge') {
    const configuredBridge = network.Options?.['com.docker.network.bridge.name'];
    const bridgeName = typeof configuredBridge === 'string' && configuredBridge.length > 0
      ? configuredBridge : `br-${id.slice(0, 12)}`;
    existing.bridgeName = bridgeName;
    for (const [index, command] of [['ip', '-j', 'address', 'show', 'dev', bridgeName],
      ['ip', '-j', 'address', 'show', 'master', bridgeName]].entries()) {
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
            bridgeObservedThisGeneration = true;
            for (const address of link.addr_info ?? []) {
              if (typeof address.local === 'string') observedBridgeAddresses.add(address.local);
            }
          } else if (index === 1) {
            const prior = existing.memberIdentities.get(link.ifname);
            if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(linkIdentity)) {
              existing.identityConflict = true;
              continue;
            }
            existing.memberIdentities.set(link.ifname, linkIdentity);
            const addresses = observedMemberAddresses.get(link.ifname) ?? new Set();
            for (const address of link.addr_info ?? []) {
              if (typeof address.local === 'string') addresses.add(address.local);
            }
            observedMemberAddresses.set(link.ifname, addresses);
          }
          existing.interfaceNames.add(link.ifname);
        }
      } catch {
        // A partial link snapshot cannot add trusted interface evidence.
      }
    }
    if (bridgeObservedThisGeneration) {
      existing.bridgeAddresses = observedBridgeAddresses;
      existing.memberAddresses = observedMemberAddresses;
      existing.lastLiveGeneration = generation;
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
  const observeNetworkNamespace = dependencies.observeNetworkNamespace ?? ((candidate) => {
    try { return { status: 'present', identity: readlinkSync(`/proc/${String(candidate)}/ns/net`) }; } catch (cause) {
      return cause?.code === 'ENOENT' ? { status: 'released' } : { status: 'error', failure: cause };
    }
  });
  const wait = dependencies.wait ?? (() => Atomics.wait(procNetRetrySignal, 0, 0, 1));
  const identityDisposition = (identity) => {
    if (identity?.status === 'missing' || (identity?.status === 'present' && identity.state?.startsWith('Z'))) return 'exited';
    if (!/^[1-9][0-9]*$/u.test(expectedStartTicks ?? '') || identity?.status === 'error') return 'error';
    if (identity?.status === 'present' && identity.startTicks !== expectedStartTicks) return 'exited';
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
      if (attempt === 3) {
        const namespace = observeNetworkNamespace(pid);
        const finalIdentity = identityDisposition(observeIdentity(pid));
        if (finalIdentity === 'exited') return { text: null, failure: null, exited: true, attempts: attempt };
        if (finalIdentity !== 'bound') return { text: null, failure: identityFailure(), exited: false, attempts: attempt };
        if (namespace?.status === 'released') {
          return { text: null, failure: null, exited: false, released: true, attempts: attempt };
        }
        if (namespace?.status === 'error') {
          return { text: null, failure: namespace.failure ?? new Error('proc-net namespace identity could not be read'),
            exited: false, attempts: attempt };
        }
        return { text: null, failure, exited: false, attempts: attempt };
      }
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
    existing.netnsReleaseTransitions ??= [];
    for (const [protocol, file] of [['tcp', 'tcp'], ['tcp6', 'tcp6'], ['udp', 'udp'], ['udp6', 'udp6']]) {
      const path = `/proc/${String(container.State.Pid)}/net/${file}`;
      const snapshot = readProcNetSnapshot(path, container.State.Pid, existing.pidStartTicks);
      if (snapshot.text !== null) {
        try { existing.netnsSockets.push(...parseProcNetSockets(snapshot.text, protocol)); } catch (cause) {
          existing.netnsErrors.push(`${protocol}:${cause instanceof Error ? cause.message : String(cause)}`);
        }
      } else if (snapshot.released) {
        existing.netnsReleaseTransitions.push({ protocol, pid: container.State.Pid, pidStartTicks: existing.pidStartTicks });
      } else if (!snapshot.exited) {
        existing.netnsErrors.push(`${protocol}:${snapshot.failure instanceof Error ? snapshot.failure.message : String(snapshot.failure)}`);
      }
    }
  }
  storeObservedDockerContainer(state, existing);
}

function observeDockerResources(state) {
  state.observationGeneration = (state.observationGeneration ?? 0) + 1;
  const generation = state.observationGeneration;
  const containers = successfulLines(['docker', 'ps', '-a', '--format', '{{.ID}} {{.Names}}'], 'runtime containers');
  for (const line of containers) {
    const [id, name] = line.split(/\s+/u);
    if (id !== undefined) observeDockerContainer(state, id, name);
  }
  const networks = successfulLines(['docker', 'network', 'ls', '--format', '{{.ID}} {{.Name}}'], 'runtime networks');
  for (const line of networks) {
    const [id, name] = line.split(/\s+/u);
    if (id !== undefined) observeDockerNetwork(state, id, generation);
  }
}

async function waitForDockerBoundaryQuiescence(state) {
  let last = [];
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    observeDockerResources(state);
    last = repositoryDockerBoundaryResources();
    if (last.length === 0) return { checked: true, attempts: attempt, passed: true };
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Gate 0.2B Docker resources did not quiesce: ${last.join(', ')}`);
}

export function exactDockerEventTimeNano(rawLine, event = {}) {
  const exact = typeof rawLine === 'string'
    ? rawLine.match(/"(?:timeNano|TimeNano)"\s*:\s*([0-9]+)/u)?.[1] : undefined;
  if (exact !== undefined && /^[0-9]+$/u.test(exact)) return exact;
  const fallback = event.timeNano ?? event.TimeNano;
  return Number.isSafeInteger(fallback) && fallback >= 0 ? String(fallback) : null;
}

function recordDockerEvent(state, event, rawLine = '') {
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
  const trackedAction = (type === 'container' && ['create', 'start', 'die', 'destroy'].includes(action))
    || (type === 'network' && ['create', 'connect', 'disconnect', 'destroy'].includes(action));
  if (trackedAction && isRepositoryDockerScope(name, attributes)) {
    const timeNano = exactDockerEventTimeNano(rawLine, event);
    const eventKey = JSON.stringify([timeNano, type, action, identity ?? null, attributes.container ?? null, name ?? null]);
    if (!state.lifecycleEventKeys.has(eventKey)) state.lifecycleEvents.push({
      sequence: state.lifecycleEvents.length + 1, timeNano,
      receivedMonotonicNs: process.hrtime.bigint().toString(),
      type,
      action,
      actorId: identity ?? null,
      name: name ?? null,
      containerId: attributes.container ?? (type === 'container' ? identity ?? null : null),
      containerName: attributes.container_name ?? (type === 'container' ? name ?? null : null),
      networkId: type === 'network' ? identity ?? null : null,
      networkName: type === 'network' ? name ?? null : null,
      networkDriver: type === 'network' ? attributes.type ?? null : null,
      project: attributes['com.docker.compose.project'] ?? null,
    });
    state.lifecycleEventKeys.add(eventKey);
  }
  if (type === 'container' && trackedAction && isRepositoryDockerScope(name, attributes)) {
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
  }
  if (type === 'network' && trackedAction && isRepositoryDockerScope(name, attributes)) {
    if (typeof identity === 'string' && identity.length > 0) {
      const observedNetwork = state.networks.get(identity)
        ?? { id: identity, gatewayAddresses: new Set(), interfaceNames: new Set(), memberIdentities: new Map(), inspectObserved: false };
      observedNetwork.name = name ?? observedNetwork.name ?? identity;
      observedNetwork.project = attributes['com.docker.compose.project'] ?? observedNetwork.project ?? null;
      observedNetwork.eventObserved = true;
      state.networks.set(identity, observedNetwork);
    }
    const containerId = attributes.container;
    if (['connect', 'disconnect'].includes(action) && typeof containerId === 'string') {
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

function ipv4Integer(value) {
  if (typeof value !== 'string') return null;
  const matched = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value);
  if (matched === null) return null;
  const octets = matched.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.reduce((total, octet) => (total << 8) + octet, 0) >>> 0;
}

function validIpv4Cidr(cidr) {
  if (typeof cidr !== 'string') return false;
  const matched = /^(.+)\/(\d|[12]\d|3[0-2])$/u.exec(cidr);
  return matched !== null && ipv4Integer(matched[1]) !== null;
}

function ipv4InCidr(address, cidr) {
  const addressInteger = ipv4Integer(address);
  if (addressInteger === null || !validIpv4Cidr(cidr)) return false;
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (addressInteger & mask) === (ipv4Integer(network) & mask);
}

function startDockerEventMonitor(state, eventPath) {
  const since = String(Math.floor(Date.now() / 1000) - 1);
  state.eventSince = since;
  state.eventPath = eventPath;
  const eventDescriptor = openSync(eventPath, 'w', 0o600);
  const monitor = spawn('docker', ['events', '--since', since, '--format', '{{json .}}'], {
    cwd: repositoryRoot, env: safeEnvironment(), stdio: ['ignore', eventDescriptor, 'pipe'],
  });
  closeSync(eventDescriptor);
  state.monitorStarted = true;
  state.monitorClosed = new Promise((resolveClose) => monitor.once('close', (status, signal) => resolveClose({ status, signal })));
  monitor.once('error', (error) => state.monitorErrors.push(error.message));
  let stderr = '';
  monitor.stderr.setEncoding('utf8');
  monitor.stderr.on('data', (chunk) => { stderr += chunk; });
  monitor.once('close', () => {
    if (stderr.trim().length > 0) state.monitorErrors.push(`stream:${stderr.trim().slice(0, 500)}`);
  });
  try {
    state.startSentinel = emitDockerEventSentinel(state, 'start');
  } catch (cause) {
    try { monitor.kill('SIGTERM'); } catch { /* The original readiness failure remains authoritative. */ }
    throw cause;
  }
  return monitor;
}

const dockerEventSentinelSignal = new Int32Array(new SharedArrayBuffer(4));

function rawDockerEventObjects(path, tolerateTrailingPartial = false) {
  const text = readFileSync(path, 'utf8');
  const rawLines = text.split('\n');
  const trailing = rawLines.pop() ?? '';
  if (!tolerateTrailingPartial && trailing.length > 0) throw new Error('Docker event raw ledger has a truncated final line');
  const records = [];
  for (const [index, line] of rawLines.entries()) {
    if (line.length === 0) continue;
    try { records.push({ rawSequence: index + 1, raw: line, event: JSON.parse(line) }); } catch {
      if (tolerateTrailingPartial && index === rawLines.length - 1) break;
      throw new Error('Docker event raw ledger contains malformed JSON');
    }
  }
  return records;
}

function exactSentinelRecords(records, name) {
  return records.filter(({ event }) => event?.Type === 'volume' && event?.Actor?.ID === name
    && ['create', 'destroy'].includes(event?.Action));
}

function emitDockerEventSentinel(state, stage) {
  const token = createHash('sha256').update(`${state.eventPath}:${stage}:${String(process.pid)}:${String(Date.now())}`)
    .digest('hex').slice(0, 24);
  const name = `geneway-gate02b-event-${stage}-${token}`;
  const absentBefore = capture(['docker', 'volume', 'inspect', name]);
  if (absentBefore.status === 0) throw new Error('Docker event sentinel unexpectedly existed before creation');
  const created = capture(['docker', 'volume', 'create', '--label', `geneway.gate02b.event-sentinel=${token}`, name]);
  if (created.status !== 0 || created.stdout.trim() !== name) throw new Error('Docker event sentinel creation failed');
  const removed = capture(['docker', 'volume', 'rm', name]);
  if (removed.status !== 0 || removed.stdout.trim() !== name) throw new Error('Docker event sentinel removal failed');
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const records = rawDockerEventObjects(state.eventPath, true);
    const matches = exactSentinelRecords(records, name);
    if (matches.length === 2 && matches[0].event.Action === 'create' && matches[1].event.Action === 'destroy') {
      const createTimeNano = exactDockerEventTimeNano(matches[0].raw, matches[0].event);
      const destroyTimeNano = exactDockerEventTimeNano(matches[1].raw, matches[1].event);
      if (createTimeNano === null || destroyTimeNano === null || BigInt(createTimeNano) >= BigInt(destroyTimeNano)) {
        throw new Error('Docker event sentinel timestamps are missing or out of order');
      }
      const absentAfter = capture(['docker', 'volume', 'inspect', name]);
      if (absentAfter.status === 0) throw new Error('Docker event sentinel remained after removal');
      return { checked: true, passed: true, stage, name, token,
        createRawSequence: matches[0].rawSequence, destroyRawSequence: matches[1].rawSequence,
        createTimeNano, destroyTimeNano };
    }
    Atomics.wait(dockerEventSentinelSignal, 0, 0, 20);
  }
  throw new Error(`Docker event ${stage} sentinel was not observed by the live raw ledger`);
}

function parseAuthoritativeDockerEventLedger(state) {
  const stat = lstatSync(state.eventPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Docker event raw ledger is unsafe');
  }
  const records = rawDockerEventObjects(state.eventPath);
  const start = exactSentinelRecords(records, state.startSentinel.name);
  const end = exactSentinelRecords(records, state.endSentinel.name);
  if (start.length !== 2 || end.length !== 2 || start[0].event.Action !== 'create'
    || start[1].event.Action !== 'destroy' || end[0].event.Action !== 'create'
    || end[1].event.Action !== 'destroy' || start[1].rawSequence >= end[0].rawSequence) {
    throw new Error('Docker event sentinel boundary is incomplete or out of order');
  }
  const authoritative = records.filter((record) => record.rawSequence > start[1].rawSequence
    && record.rawSequence < end[0].rawSequence);
  for (const record of authoritative) recordDockerEvent(state, record.event, record.raw);
  const bytes = readFileSync(state.eventPath);
  state.authoritativeEventLedger = { checked: true, passed: true, source: 'live-raw-file', path: state.eventPath,
    mode: stat.mode & 0o777, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
    start: state.startSentinel, end: state.endSentinel, recordCount: authoritative.length };
  return { records, authoritative };
}

async function stopDockerEventMonitor(monitor, state) {
  state.endSentinel = emitDockerEventSentinel(state, 'end');
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
  let liveLedger;
  try { liveLedger = parseAuthoritativeDockerEventLedger(state); } catch (cause) {
    state.monitorErrors.push(`stream-file:${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const catchup = capture(['docker', 'events', '--since', state.eventSince,
    '--until', String(Math.ceil(Date.now() / 1000)), '--format', '{{json .}}']);
  if (catchup.status !== 0 || typeof catchup.stdout !== 'string') {
    state.monitorErrors.push('catchup:Docker event ledger read failed');
  } else {
    const catchupLines = catchup.stdout.split('\n').filter(Boolean);
    const liveKeys = new Set((liveLedger?.authoritative ?? []).map(({ event, raw }) => {
      const actor = event.Actor ?? event.actor ?? {};
      const attributes = actor.Attributes ?? actor.attributes ?? {};
      return JSON.stringify([exactDockerEventTimeNano(raw, event), event.Type ?? event.type, event.Action ?? event.action,
        actor.ID ?? actor.id ?? null, attributes.container ?? null, attributes.name ?? null]);
    }));
    let missing = 0;
    for (const line of catchupLines) try {
      const event = JSON.parse(line);
      const timeNano = exactDockerEventTimeNano(line, event);
      const withinBoundary = timeNano !== null && BigInt(timeNano) > BigInt(state.startSentinel.destroyTimeNano)
        && BigInt(timeNano) < BigInt(state.endSentinel.createTimeNano);
      const type = event.Type ?? event.type;
      const action = event.Action ?? event.action;
      const actor = event.Actor ?? event.actor ?? {};
      const attributes = actor.Attributes ?? actor.attributes ?? {};
      const tracked = (type === 'container' && ['create', 'start', 'die', 'destroy'].includes(action))
        || (type === 'network' && ['create', 'connect', 'disconnect', 'destroy'].includes(action));
      const key = JSON.stringify([timeNano, type, action, actor.ID ?? actor.id ?? null,
        attributes.container ?? null, attributes.name ?? null]);
      if (withinBoundary && tracked && isRepositoryDockerScope(attributes.name, attributes) && !liveKeys.has(key)) missing += 1;
    } catch { state.monitorErrors.push('catchup:Docker event audit parse failed'); }
    state.catchupAudit = { checked: true, authoritative: false, eventCount: catchupLines.length,
      missingAuthoritativeLifecycleEvents: missing, passed: missing === 0 };
    if (missing > 0) state.monitorErrors.push('catchup:authoritative live ledger missed lifecycle events');
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
  const enforceExpectedCardinality = expectation.enforceExpectedCardinality !== false;
  if (!existsSync(directory)) {
    if (enforceExpectedCardinality && expectedTotal !== 0) throw new Error('Gate 0.2B storage invocation manifests are missing');
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
    const exactKeys = ['schemaVersion', 'kind', 'parentRunId', 'runId', 'project', 'networks', 'services', 'runtimeServices'];
    const validServices = Array.isArray(manifest.services) && manifest.services.length === 4
      && manifest.services.every((service, index) => {
        const [serviceName, network, targetPort] = expectedServices[index];
        return JSON.stringify(Object.keys(service)) === JSON.stringify(['name', 'network', 'listenPort', 'targetPort', 'stem'])
          && service.name === serviceName && service.network === network
          && Number.isInteger(service.listenPort) && service.listenPort >= 1 && service.listenPort <= 65_535
          && service.targetPort === targetPort && service.stem === `${manifest.project}-${serviceName}`;
      });
    const safeRunId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u.test(value);
    const validRuntimeServices = JSON.stringify(manifest.runtimeServices) === JSON.stringify([
      { name: 'postgres', network: 'default' },
      { name: 'versitygw', network: 'storage' },
      { name: 'storage-adapter', network: 'storage' },
      { name: 'storage-reconciliation-adapter', network: 'storage' },
      { name: 'storage-reconciler', network: 'default' },
      { name: 'storage-oracle', network: 'storage' },
      { name: 'storage-provisioner', network: 'storage' },
    ]);
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
      }) || !validServices || !validRuntimeServices) {
      throw new Error(`Gate 0.2B storage invocation manifest is invalid: ${name}`);
    }
    return manifest;
  });
  const storageCount = manifests.filter((manifest) => manifest.kind === 'storage').length;
  const e2eCount = manifests.filter((manifest) => manifest.kind === 'e2e').length;
  if (enforceExpectedCardinality && (manifests.length !== expectedTotal || storageCount !== (expectation.expectedStorageInvocations ?? 0)
    || e2eCount !== (expectation.expectedE2eInvocations ?? 0))) {
    throw new Error('Gate 0.2B storage invocation manifest membership does not match the step plan');
  }
  return manifests;
}

export function backupInvocationManifests(runRoot, expectedRunIds = [], enforceExpectedCardinality = true) {
  const directory = resolve(runRoot, 'backup-invocations');
  const expected = [...expectedRunIds].sort();
  if (!existsSync(directory)) {
    if (enforceExpectedCardinality && expected.length > 0) throw new Error('Gate 0.2B backup invocation manifests are missing');
    return [];
  }
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700) {
    throw new Error('Gate 0.2B backup invocation manifest directory is unsafe');
  }
  const names = readdirSync(directory).sort();
  if (names.some((name) => !/^backup-restore-suite-[A-Za-z0-9._-]+\.json$/u.test(name))) {
    throw new Error('Gate 0.2B backup invocation manifest inventory is unsafe');
  }
  const manifests = names.map((name) => {
    const path = resolve(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw new Error('Gate 0.2B backup invocation manifest is unsafe');
    }
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const suffix = typeof manifest.runId === 'string'
      ? createHash('sha256').update(manifest.runId).digest('hex').slice(0, 12) : '';
    const projects = [`geneway-br-source-${suffix}`, `geneway-br-target-${suffix}`];
    const networks = projects.map((project) => `${project}_default`);
    if (JSON.stringify(Object.keys(manifest)) !== JSON.stringify([
      'schemaVersion', 'runId', 'childProxyRoot', 'projects', 'networks',
    ]) || manifest.schemaVersion !== 'geneway-gate02b-backup-invocation/1'
      || name !== `${manifest.runId}.json`
      || !/^backup-restore-suite-[A-Za-z0-9._-]+$/u.test(manifest.runId ?? '')
      || manifest.childProxyRoot !== `/tmp/geneway-runs/${manifest.runId}-proxies`
      || JSON.stringify(manifest.projects) !== JSON.stringify(projects)
      || JSON.stringify(manifest.networks) !== JSON.stringify(networks)) {
      throw new Error(`Gate 0.2B backup invocation manifest is invalid: ${name}`);
    }
    return manifest;
  });
  const actual = manifests.map((manifest) => manifest.runId).sort();
  if (enforceExpectedCardinality && JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Gate 0.2B backup invocation manifest membership does not match the step output');
  }
  return manifests;
}

export function backupContainerBoundaryReceipts(expectedRunIds) {
  const receipts = [];
  for (const runId of [...expectedRunIds].sort()) {
    if (!/^backup-restore-suite-[A-Za-z0-9._-]+$/u.test(runId)) {
      throw new Error('Gate 0.2B backup container boundary run ID is unsafe');
    }
    const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
    const projects = new Set([`geneway-br-source-${suffix}`, `geneway-br-target-${suffix}`]);
    const networks = new Set([...projects].map((project) => `${project}_default`));
    const directory = `/tmp/geneway-runs/${runId}/backup-restore/process-boundaries`;
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700) {
      throw new Error('Gate 0.2B backup container boundary directory is unsafe');
    }
    const names = readdirSync(directory).filter((name) => name.startsWith('container-')).sort();
    if (names.length === 0 || names.some((name) => !/^container-geneway-br-[A-Za-z0-9._-]+\.json$/u.test(name))) {
      throw new Error('Gate 0.2B backup container boundary inventory is unsafe');
    }
    for (const name of names) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('Gate 0.2B backup container boundary file is unsafe');
      }
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      const attachment = receipt.networkAttachment;
      const network = receipt.networkInspection;
      const dataNetwork = networks.has(receipt.networkMode);
      const networkEvidenceValid = dataNetwork
        ? attachment !== null && typeof attachment === 'object'
          && network !== null && typeof network === 'object'
          && /^[a-f0-9]{64}$/u.test(attachment.id ?? '') && attachment.name === receipt.networkMode
          && isIP(attachment.ipAddress ?? '') > 0
          && /^[a-f0-9]{64}$/u.test(network.id ?? '') && network.id === attachment.id
          && network.name === attachment.name && network.internal === true && network.driver === 'bridge'
          && projects.has(network.project) && network.name === `${network.project}_default`
        : ['none', 'host'].includes(receipt.networkMode) && attachment === null && network === null;
      if (JSON.stringify(Object.keys(receipt)) !== JSON.stringify([
        'schemaVersion', 'role', 'action', 'containerName', 'mounts', 'dockerAuthority', 'forbiddenNamesPresent',
        'containerId', 'networkMode', 'networkAttachment', 'networkInspection', 'checked',
      ]) || receipt.schemaVersion !== 'geneway-backup-container-boundary/1' || receipt.checked !== true
        || !/^[a-f0-9]{64}$/u.test(receipt.containerId ?? '')
        || name !== `container-${receipt.containerName}.json`
        || !new RegExp(`^geneway-br-(?:(?:source|target)-)?${suffix}-[A-Za-z0-9._-]+$`, 'u').test(receipt.containerName ?? '')
        || typeof receipt.role !== 'string' || typeof receipt.action !== 'string'
        || !Array.isArray(receipt.mounts) || !Array.isArray(receipt.forbiddenNamesPresent)
        || receipt.forbiddenNamesPresent.length !== 0 || receipt.dockerAuthority?.passed !== true
        || !networkEvidenceValid) {
        throw new Error(`Gate 0.2B backup container boundary is invalid: ${name}`);
      }
      let egressPolicy = null;
      if (receipt.networkMode === 'host') {
        const egressRoot = `/tmp/geneway-runs/${runId}/backup-restore/egress-boundaries`;
        const policyPath = resolve(egressRoot, `${receipt.containerName}.policy.json`);
        const summaryPath = resolve(egressRoot, `${receipt.containerName}.json`);
        const policyStat = lstatSync(policyPath);
        const summaryStat = lstatSync(summaryPath);
        if (!policyStat.isFile() || policyStat.isSymbolicLink() || (policyStat.mode & 0o777) !== 0o600
          || !summaryStat.isFile() || summaryStat.isSymbolicLink() || (summaryStat.mode & 0o777) !== 0o600) {
          throw new Error('Gate 0.2B backup egress boundary files are unsafe');
        }
        const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
        if (policy.schemaVersion !== 'geneway-backup-egress-boundary/1' || policy.runId !== runId
          || policy.containerId !== receipt.containerId || policy.pidStartTicks !== null
          || policy.role !== receipt.role || policy.action !== receipt.action || policy.networkMode !== 'host'
          || !Array.isArray(policy.allowedPorts) || policy.allowedPorts.length === 0
          || policy.allowedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
          || JSON.stringify(policy.allowedUnix) !== JSON.stringify([`tsx-pipe:/tmp/tsx-${String(process.getuid?.() ?? 1000)}`])
          || policy.rawReceipt !== resolve(egressRoot, `${receipt.containerName}.raw`)
          || policy.hostname !== receipt.containerName || policy.policyComplete !== true) {
          throw new Error('Gate 0.2B backup egress policy is invalid');
        }
        egressPolicy = { path: policyPath, summaryPath, allowedPorts: policy.allowedPorts.map(String) };
      }
      receipts.push({ ...receipt, runId, path, egressPolicy });
    }
  }
  if (new Set(receipts.map((receipt) => receipt.containerId)).size !== receipts.length
    || new Set(receipts.map((receipt) => receipt.containerName)).size !== receipts.length) {
    throw new Error('Gate 0.2B backup container boundary identity is duplicated');
  }
  return receipts;
}

export function promoteProxyNetworkEvidence(state, proxyReceipts) {
  for (const receipt of proxyReceipts.flatMap((item) => item.proxies ?? [])) {
    if (receipt.intrinsicValid !== true) continue;
    const target = receipt.target;
    const targetSubnets = Array.isArray(target.networkSubnets) ? [...target.networkSubnets].sort() : [];
    const existingSubnets = Array.isArray(state.networks.get(target.networkId)?.subnets) ? [...state.networks.get(target.networkId).subnets].sort() : [];
    const creates = (state.lifecycleEvents ?? []).filter((event) => event.type === 'network'
      && event.action === 'create' && event.networkId === target.networkId
      && event.networkName === target.networkName && event.networkDriver === 'bridge');
    if (creates.length !== 1) continue;
    const existing = state.networks.get(target.networkId)
      ?? { id: target.networkId, gatewayAddresses: new Set(), interfaceNames: new Set(), memberIdentities: new Map(), inspectObserved: false };
    const conflicting = (typeof existing.name === 'string' && existing.name !== target.networkName)
      || (typeof existing.project === 'string' && existing.project !== target.project)
      || existing.internal === false || (typeof existing.driver === 'string' && existing.driver !== 'bridge')
      || targetSubnets.length === 0 || new Set(targetSubnets).size !== targetSubnets.length
      || targetSubnets.some((subnet) => !validIpv4Cidr(subnet))
      || !targetSubnets.some((subnet) => ipv4InCidr(target.ip, subnet))
      || (existingSubnets.length > 0 && JSON.stringify(existingSubnets) !== JSON.stringify(targetSubnets))
      || existing.identityConflict === true;
    if (conflicting) {
      existing.identityConflict = true;
      state.networks.set(target.networkId, existing);
      continue;
    }
    existing.name = target.networkName;
    existing.project = target.project;
    existing.internal = true;
    existing.driver = 'bridge';
    existing.subnets = targetSubnets;
    existing.artifactProofObserved = true;
    existing.artifactProofs ??= [];
    if (!existing.artifactProofs.some((proof) => proof.policyPath === receipt.policyPath)) {
      existing.artifactProofs.push({ schemaVersion: 'geneway-gate02b-proxy-network-proof/1',
        policyPath: receipt.policyPath, containerId: target.containerId, project: target.project,
        service: target.service, networkId: target.networkId, networkName: target.networkName, subnets: targetSubnets,
        internal: true, driver: 'bridge', createEventSequence: creates[0].sequence,
        createEventTimeNano: creates[0].timeNano });
    }
    state.networks.set(target.networkId, existing);
  }
}

export function backupArtifactRoots(results) {
  const runIds = [...new Set(results.flatMap((result) => result.runtimeBoundary?.structuralIsolation?.expectedBackupRunIds ?? []))].sort();
  if (runIds.some((runId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId))) throw new Error('Gate 0.2B backup artifact run ID is unsafe');
  return runIds.map((runId) => `/tmp/geneway-runs/${runId}/backup-restore`);
}

export function dockerStructuralIsolationReceipt(state, expectedBackupRunIds = [], proxyRunRoot = null, proxyExpectation = {}) {
  const enforceExpectedCardinality = proxyExpectation.enforceExpectedCardinality !== false;
  const containers = [...state.containers.values()].filter((container) => container.repositoryScoped === true).map((container) => ({
    id: container.id, name: container.name, project: container.project ?? null, service: container.service ?? null,
    backupRun: container.backupRun ?? null, backupRole: container.backupRole ?? null, backupAction: container.backupAction ?? null,
    egressReceiptPath: container.egressReceiptPath ?? null, pid: container.pid ?? null, pidStartTicks: container.pidStartTicks ?? null,
    egressAllowedPorts: container.egressAllowedPorts ?? [],
    exitCode: container.exitCode ?? null, networkMode: container.networkMode ?? null,
    inspectObserved: container.inspectObserved === true, eventObserved: container.eventObserved === true,
    extraHosts: container.extraHosts ?? [], publishedPorts: container.publishedPorts ?? [], netnsAttempted: container.netnsAttempted === true,
    netnsErrors: [...new Set(container.netnsErrors ?? [])],
    netnsReleaseTransitions: [...new Map((container.netnsReleaseTransitions ?? [])
      .map((transition) => [JSON.stringify(transition), transition])).values()],
    netnsSockets: [...new Map((container.netnsSockets ?? []).map((socket) => [JSON.stringify(socket), socket])).values()],
    networkIds: [...container.networkIds].sort(), networkNames: [...container.networkNames].sort(),
    networkAttachments: container.networkAttachments ?? [],
    lifecycleActions: (state.lifecycleEvents ?? []).filter((event) => event.type === 'container' && event.containerId === container.id)
      .map((event) => event.action),
  })).sort((left, right) => left.name.localeCompare(right.name));
  const proxyRoots = proxyRunRoot === null ? [] : [...new Set(Array.isArray(proxyRunRoot) ? proxyRunRoot : [proxyRunRoot])];
  const storageManifests = proxyRoots.length === 0 ? [] : storageInvocationManifests(proxyRoots[0], proxyExpectation);
  const backupManifests = proxyRoots.length === 0 ? []
    : backupInvocationManifests(proxyRoots[0], expectedBackupRunIds, enforceExpectedCardinality);
  const invocationManifests = [...storageManifests, ...backupManifests];
  const backupBoundaryReceipts = expectedBackupRunIds.length === 0 ? []
    : backupContainerBoundaryReceipts(expectedBackupRunIds);
  const backupBoundaryById = new Map(backupBoundaryReceipts.map((receipt) => [receipt.containerId, receipt]));
  for (const container of containers.filter((item) => item.backupRun !== null)) {
    const receipt = backupBoundaryById.get(container.id);
    if (receipt === undefined || receipt.containerName !== container.name || receipt.runId !== container.backupRun
      || receipt.role !== container.backupRole || receipt.action !== container.backupAction) continue;
    container.boundaryReceipt = receipt;
    container.networkMode = receipt.networkMode;
    if (receipt.egressPolicy !== null) {
      container.egressAllowedPorts = receipt.egressPolicy.allowedPorts;
      container.egressReceiptPath = receipt.egressPolicy.summaryPath;
    }
    if (receipt.networkAttachment !== null) {
      container.networkAttachments = [{ name: receipt.networkAttachment.name, id: receipt.networkAttachment.id,
        ip: receipt.networkAttachment.ipAddress }];
      container.networkIds = [...new Set([...container.networkIds, receipt.networkAttachment.id])].sort();
      container.networkNames = [...new Set([...container.networkNames, receipt.networkAttachment.name])].sort();
    }
  }
  if (enforceExpectedCardinality && (backupBoundaryReceipts.some((receipt) =>
    !containers.some((container) => container.id === receipt.containerId && container.name === receipt.containerName))
    || containers.some((container) => container.backupRun !== null && container.boundaryReceipt === undefined))) {
    throw new Error('Gate 0.2B backup container boundary membership does not match Docker lifecycle evidence');
  }
  const preliminaryProxyReceipts = proxyRoots.map((root) => loopbackProxyArtifactReceipt(root, state, invocationManifests));
  promoteProxyNetworkEvidence(state, preliminaryProxyReceipts);
  const networks = [...state.networks.values()].map((network) => ({
    id: network.id, name: network.name, internal: network.internal, driver: network.driver,
    inspectObserved: network.inspectObserved, artifactProofObserved: network.artifactProofObserved === true,
    artifactProofs: network.artifactProofs ?? [], project: network.project, subnets: network.subnets ?? [],
    bridgeName: network.bridgeName ?? null, gatewayAddresses: [...(network.gatewayAddresses ?? [])].sort(),
    interfaceNames: [...(network.interfaceNames ?? [])].sort(),
    bridgeIdentity: network.bridgeIdentity ?? null, identityConflict: network.identityConflict === true,
    memberIdentities: [...(network.memberIdentities ?? [])].map(([name, identity]) => ({ name, ...identity }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  })).sort((left, right) => left.name.localeCompare(right.name));
  const proxyReceipts = proxyRoots.map((root) => loopbackProxyArtifactReceipt(root, state, invocationManifests));
  const teardownReceipts = new Map(proxyReceipts.flatMap((receipt) => receipt.proxies)
    .filter((proxy) => proxy.teardownReceipt?.passed === true)
    .map((proxy) => [proxy.target.containerId, proxy.teardownReceipt]));
  for (const container of containers.filter((item) => item.inspectObserved !== true && item.backupRun === null
    && !teardownReceipts.has(item.id))) {
    const invocationManifest = invocationManifests.find((manifest) => manifest.project === container.project
      || manifest.projects?.includes(container.project));
    if (invocationManifest === undefined) continue;
    const receipt = dockerTeardownProofReceipt({
      container: { id: container.id, name: container.name, project: container.project, service: container.service },
      lifecycleEvents: state.lifecycleEvents,
      inspectedNetworks: networks.map((network) => ({ ...network })),
      invocationManifest,
      proxyBacked: false,
    });
    if (receipt.passed === true) teardownReceipts.set(container.id, receipt);
  }
  const internalIdentities = new Set(networks.filter((network) => network.internal).flatMap((network) => [network.id, network.name]));
  const networksByIdentity = new Map(networks.flatMap((network) => [[network.id, network], [network.name, network]]));
  const violations = [];
  for (const network of networks) {
    if (!network.internal) violations.push(`non-internal-network:${network.name}:${network.id}`);
    if (!network.inspectObserved && !network.artifactProofObserved) {
      violations.push(`network-exact-proof-missing:${network.name}:${network.id}`);
    }
    if (network.subnets.length === 0) violations.push(`network-subnet-proof-missing:${network.name}:${network.id}`);
    else if (new Set(network.subnets).size !== network.subnets.length
      || network.subnets.some((subnet) => !validIpv4Cidr(subnet))) {
      violations.push(`network-subnet-proof-invalid:${network.name}:${network.id}`);
    }
    if (network.identityConflict) violations.push(`network-link-identity-conflict:${network.name}:${network.id}`);
    if (typeof network.project !== 'string' || !/^geneway-(?:storage|e2e|br)-[A-Za-z0-9._-]+$/u.test(network.project)) {
      violations.push(`network-project-forbidden:${network.name}:${String(network.project)}`);
    }
  }
  for (const container of containers) {
    const teardownReceipt = teardownReceipts.get(container.id) ?? null;
    container.teardownReceipt = teardownReceipt;
    if (!container.eventObserved && !container.inspectObserved) violations.push(`container-observation-missing:${container.name}:${container.id}`);
    if (!container.inspectObserved && teardownReceipt?.passed !== true && container.boundaryReceipt?.checked !== true) {
      violations.push(`container-inspect-or-teardown-proof-missing:${container.name}:${container.id}`);
    }
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
    const attachmentNetworks = [...new Set([...container.networkIds, ...container.networkNames]
      .map((identity) => networksByIdentity.get(identity)).filter((network) => network !== undefined))];
    const attachmentSubnets = attachmentNetworks.filter((network) => network.internal === true)
      .flatMap((network) => network.subnets);
    for (const socket of container.netnsSockets) {
      const allowed = socket.remoteAddress === '::1' || socket.remoteAddress.startsWith('127.')
        || (/^\d+\.\d+\.\d+\.\d+$/u.test(socket.remoteAddress)
          && attachmentSubnets.some((subnet) => ipv4InCidr(socket.remoteAddress, subnet)));
      if (!allowed) violations.push(`container-netns-endpoint-forbidden:${container.name}:${socket.protocol}:${socket.remoteAddress}:${String(socket.remotePort)}`);
    }
    if (container.networkIds.length + container.networkNames.length === 0) violations.push(`container-network-evidence-missing:${container.name}:${container.id}`);
    for (const identity of [...container.networkIds, ...container.networkNames]) {
      if (!internalIdentities.has(identity)) violations.push(`container-network-not-proven-internal:${container.name}:${identity}`);
    }
  }
  const backupRunIds = [...new Set(containers.flatMap((container) => typeof container.backupRun === 'string' ? [container.backupRun] : []))].sort();
  if (enforceExpectedCardinality
    && JSON.stringify(backupRunIds) !== JSON.stringify(expectedBackupRunIds)) violations.push('backup-run-membership-mismatch');
  const loopbackProxies = { checked: true, count: proxyReceipts.reduce((sum, item) => sum + item.count, 0),
    proxies: proxyReceipts.flatMap((item) => item.proxies), passed: proxyReceipts.every((item) => item.passed) };
  const expectedProxyNames = [
    ...invocationManifests.flatMap((manifest) => Array.isArray(manifest.services)
      ? manifest.services.map((service) => service.stem) : []),
    ...(proxyExpectation.expectedBackupProjects ?? []).flatMap((project) => ['postgres', 'versitygw']
      .map((service) => `${project}-${service}`)),
  ].sort();
  const actualProxyNames = loopbackProxies.proxies.map((proxy) => proxy.name).sort();
  loopbackProxies.expectedNames = expectedProxyNames;
  loopbackProxies.passed &&= JSON.stringify(actualProxyNames) === JSON.stringify(expectedProxyNames);
  const expectedProxyCount = enforceExpectedCardinality
    ? (proxyExpectation.expectedWithStorageInvocations ?? 0) * 4 + (proxyExpectation.expectedBackupCases ?? 0) * 4
    : expectedProxyNames.length;
  loopbackProxies.expectedCount = expectedProxyCount;
  loopbackProxies.passed &&= loopbackProxies.count === expectedProxyCount;
  if (!loopbackProxies.passed) violations.push('loopback-proxy-boundary-failed');
  const requestedSigtermExit = state.monitorStop?.requested === true && state.monitorStop?.signal === 'SIGTERM'
    && state.monitorStop?.requestSucceeded === true
    && state.monitorStop?.exit?.status === 143 && state.monitorStop?.exit?.signal === null
    && state.monitorExit?.status === 143 && state.monitorExit?.signal === null;
  const eventMonitor = { checked: true, started: state.monitorStarted === true, eventCount: state.eventCount,
    lifecycleEvents: state.lifecycleEvents, parseErrors: state.eventParseErrors, errors: state.monitorErrors,
    stop: state.monitorStop ?? null, exit: state.monitorExit ?? null,
    authoritativeLedger: state.authoritativeEventLedger ?? null, catchupAudit: state.catchupAudit ?? null,
    passed: state.monitorStarted === true && state.eventParseErrors.length === 0 && state.monitorErrors.length === 0
      && state.authoritativeEventLedger?.passed === true && state.catchupAudit?.passed === true
      && ((state.monitorExit?.status === null && state.monitorExit?.signal === 'SIGTERM')
        || (state.monitorExit?.status === 0 && state.monitorExit?.signal === null) || requestedSigtermExit) };
  return { checked: true, eventMonitor, invocationManifests, backupBoundaryReceipts, loopbackProxies,
    backupRunIds, expectedBackupRunIds, observedContainers: containers, observedNetworks: networks,
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
    || !Array.isArray(policy.target?.networkSubnets) || policy.target.networkSubnets.length === 0
    || JSON.stringify(policy.target.networkSubnets) !== JSON.stringify([...policy.target.networkSubnets].sort())
    || new Set(policy.target.networkSubnets).size !== policy.target.networkSubnets.length
    || policy.target.networkSubnets.some((subnet) => !validIpv4Cidr(subnet))
    || !policy.target.networkSubnets.some((subnet) => ipv4InCidr(policy.target.ip, subnet))
    || !/^\d+\.\d+\.\d+\.\d+$/u.test(policy.target?.ip ?? '')
    || servicePorts[policy.target?.service] !== policy.target?.port
    || policy.target.port !== policy.target.containerPort || policy.policyHash !== expectedHash
    || policy.dockerHost !== 'unix:///var/run/docker.sock'
    || resolve(policy.dockerConfigPath) !== resolve(expectedRoot, 'docker-client')
    || resolve(policy.rawPath) !== resolve(expectedRoot, 'loopback-proxies', `${policy.name}.raw`)
    || resolve(policy.identityPath) !== resolve(expectedRoot, 'loopback-proxies', `${policy.name}.identity.json`)
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
  const networkSubnets = (network?.IPAM?.Config ?? []).flatMap((config) =>
    typeof config?.Subnet === 'string' ? [config.Subnet] : []).sort();
  return servicePorts[policy?.target?.service] === policy?.target?.port
    && policy?.target?.containerPort === policy?.target?.port
    && labels['com.docker.compose.project'] === policy?.target?.project
    && labels['com.docker.compose.service'] === policy?.target?.service
    && container?.Id === policy?.target?.containerId && attachment?.NetworkID === policy?.target?.networkId
    && attachment?.IPAddress === policy?.target?.ip && network?.Id === policy?.target?.networkId
    && network?.Name === policy?.target?.networkName && network?.Internal === true
    && JSON.stringify(networkSubnets) === JSON.stringify(policy?.target?.networkSubnets)
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

export function validateProxyIdentityChain(policy, identity, ready, summary) {
  const keys = JSON.stringify(['schemaVersion', 'policyPath', 'policyHash', 'pid', 'startTicks', 'hostname']);
  return JSON.stringify(Object.keys(identity ?? {})) === keys
    && JSON.stringify(Object.keys(ready ?? {})) === keys
    && JSON.stringify(Object.keys(summary?.spawnIdentity ?? {})) === JSON.stringify(['pid', 'startTicks', 'hostname'])
    && JSON.stringify(identity) === JSON.stringify(ready)
    && Number.isSafeInteger(ready?.pid) && ready.pid >= 1 && /^[1-9][0-9]*$/u.test(ready?.startTicks ?? '')
    && typeof ready?.hostname === 'string' && ready.hostname.length > 0
    && ready?.schemaVersion === policy?.schemaVersion && ready?.policyPath === policy?.policyPath
    && ready?.policyHash === policy?.policyHash && JSON.stringify(summary?.readyIdentity) === JSON.stringify(ready)
    && summary?.identityPath === policy?.identityPath && JSON.stringify(summary?.identity) === JSON.stringify(identity)
    && JSON.stringify(summary?.stdoutReady) === JSON.stringify({ ready: true, ...ready })
    && summary?.spawnIdentity?.pid === ready?.pid && summary?.spawnIdentity?.startTicks === ready?.startTicks
    && summary?.spawnIdentity?.hostname === ready?.hostname;
}

function loopbackProxyArtifactReceipt(runRoot, state, invocationManifests = []) {
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
    return [`${stem}.policy.json`, `${stem}.raw`, `${stem}.identity.json`, `${stem}.ready.json`, `${stem}.attempts.jsonl`, `${stem}.json`, `${stem}.controller.log`];
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
    const identityPath = resolve(root, `${stem}.identity.json`);
    const attemptsPath = resolve(root, `${stem}.attempts.jsonl`);
    const readyPath = resolve(root, `${stem}.ready.json`);
    const summaryPath = resolve(root, `${stem}.json`);
    for (const path of [policyPath, rawPath, identityPath, readyPath, attemptsPath, summaryPath]) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error(`Gate 0.2B loopback proxy artifact is unsafe: ${path}`);
      }
    }
    const policy = validateProxyPolicy(JSON.parse(readFileSync(policyPath, 'utf8')), runRoot);
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
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
    const observedTargetBinding = proxyTargetBindingMatches(policy, container, network);
    const rawGuardValid = validateProxyRawReceipt(policy, summary, raw, attempts);
    const intrinsicValid = policy.name === stem && policy.name === `${policy.target.project}-${policy.target.service}`
      && policy.policyPath === policyPath && policy.rawPath === rawPath && policy.identityPath === identityPath
      && policy.readyPath === readyPath && policy.attemptsPath === attemptsPath
      && summary.name === stem && summary.policyPath === policyPath && summary.rawPath === rawPath && summary.identityPath === identityPath
      && summary.readyPath === readyPath && summary.attemptsPath === attemptsPath
      && ready.policyPath === policyPath
      && JSON.stringify(summary.target) === JSON.stringify(policy.target)
      && JSON.stringify(summary.listen) === JSON.stringify(policy.listen)
      && summary.policyHash === policy.policyHash && ready.policyHash === policy.policyHash
      && JSON.stringify(summary.control) === JSON.stringify({ shutdownRequests: 1, failure: null })
      && validateProxyIdentityChain(policy, identity, ready, summary)
      && summary.readyPath === readyPath && summary.finalBinding?.running === true
      && JSON.stringify(summary.finalBinding) === JSON.stringify({ ...policy.target, running: true })
      && summary.attemptsPath === attemptsPath && rawGuardValid;
    const invocationManifest = invocationManifests.find((manifest) => manifest.project === policy.target.project
      || manifest.projects?.includes(policy.target.project));
    const teardownReceipt = containerState === undefined || invocationManifest === undefined
      ? { checked: true, passed: false, reason: 'TEARDOWN_INPUT_MISSING' }
      : dockerTeardownProofReceipt({
        container: { id: containerState.id, name: containerState.name, project: containerState.project,
          service: containerState.service },
        lifecycleEvents: state.lifecycleEvents,
        inspectedNetworks: [...state.networks.values()].map((item) => ({
          id: item.id, name: item.name, project: item.project, inspectObserved: item.inspectObserved === true,
          artifactProofObserved: item.artifactProofObserved === true,
          internal: item.internal === true, driver: item.driver, identityConflict: item.identityConflict === true,
        })),
        invocationManifest,
        proxyBacked: true,
        proxyReceipt: { intrinsicValid, target: policy.target, finalBinding: summary.finalBinding,
          rawGuard: { passed: rawGuardValid, unexpected: rawGuardValid ? [] : ['RAW_GUARD_REJECTED'], unknownLines: [] } },
      });
    const passed = intrinsicValid && (observedTargetBinding || teardownReceipt.passed === true);
    return { name: stem, policyPath, rawPath, identityPath, readyPath, summaryPath, target: policy.target,
      intrinsicValid, observedTargetBinding, teardownReceipt, passed };
  });
  return { checked: true, count: proxies.length, proxies, passed: proxies.every((proxy) => proxy.passed) };
}

export function validateProxyInventory(inventory) {
  const policyNames = inventory.filter((name) => name.endsWith('.policy.json')).sort();
  const required = new Set(policyNames.flatMap((name) => {
    const stem = name.slice(0, -'.policy.json'.length);
    return [`${stem}.policy.json`, `${stem}.raw`, `${stem}.identity.json`, `${stem}.ready.json`, `${stem}.attempts.jsonl`, `${stem}.json`,
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
    const identityStat = lstatSync(policy.identityPath);
    if (!identityStat.isFile() || identityStat.isSymbolicLink() || (identityStat.mode & 0o777) !== 0o600) return null;
    const identity = JSON.parse(readFileSync(policy.identityPath, 'utf8'));
    if (JSON.stringify(Object.keys(identity ?? {})) !== JSON.stringify(['schemaVersion', 'policyPath', 'policyHash', 'pid', 'startTicks', 'hostname'])
      || identity.schemaVersion !== policy.schemaVersion || identity.pid !== processItem.pid
      || identity.startTicks !== processItem.startTicks || identity.hostname !== policy.controller.hostname
      || identity.policyPath !== policy.policyPath || identity.policyHash !== policy.policyHash) return null;
    return policy;
  } catch { return null; }
}

export function proxyPolicyPathFromCommandLine(commandLine) {
  const script = resolve(repositoryRoot, 'scripts/gate02b-loopback-proxy.mjs');
  const pattern = new RegExp(`^(?:\\S*/)?node\\s+${script.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s+--serve\\s+(/tmp/geneway-runs/[A-Za-z0-9._-]+/loopback-proxies/[A-Za-z0-9._-]+\\.policy\\.json)$`, 'u');
  return commandLine.match(pattern)?.[1] ?? null;
}

export function proxyEgressMatchesPolicy(processItem, line) {
  return proxyEgressPolicyReceipt(processItem, line) !== null;
}

export function proxyEgressPolicyReceipt(processItem, line) {
  return proxyEgressPolicyDecision(processItem, line, null).receipt;
}

function observedProxyTargetBinding(policy, dockerObservation, localAddress) {
  const container = dockerObservation?.containers?.get(policy.target.containerId);
  const network = dockerObservation?.networks?.get(policy.target.networkId);
  const attachment = container?.networkAttachments?.find((item) => item.name === policy.target.networkName);
  if (container?.inspectObserved !== true || container.project !== policy.target.project
    || container.service !== policy.target.service || attachment?.id !== policy.target.networkId
    || attachment?.ip !== policy.target.ip || network?.inspectObserved !== true
    || network.id !== policy.target.networkId || network.name !== policy.target.networkName
    || network.project !== policy.target.project || network.internal !== true || network.driver !== 'bridge'
    || network.identityConflict === true || !network.gatewayAddresses?.has(localAddress)
    || typeof network.bridgeName !== 'string' || network.bridgeIdentity === undefined) return null;
  return { id: network.id, name: network.name, internal: network.internal, driver: network.driver,
    project: network.project, bridge: { name: network.bridgeName, ifindex: network.bridgeIdentity.ifindex,
      mac: network.bridgeIdentity.address, gateway: localAddress } };
}

function proxyEgressPolicyDecision(processItem, line, dockerObservation) {
  const rejected = (reason) => ({ receipt: null, reason });
  const policy = proxyPolicyForProcess(processItem);
  if (policy === null) return rejected('PROCESS_POLICY_IDENTITY_REJECTED');
  const [local, peer] = (line.split(/\s+/u)[0] ?? '').split('->');
  if (peer !== `${policy.target.ip}:${String(policy.target.port)}` || typeof local !== 'string') return rejected('SOCKET_TARGET_MISMATCH');
  const container = dockerJson(['docker', 'container', 'inspect', policy.target.containerId]);
  const inspected = Array.isArray(container) ? container[0] : undefined;
  const network = dockerJson(['docker', 'network', 'inspect', policy.target.networkId]);
  const inspectedNetwork = Array.isArray(network) ? network[0] : undefined;
  const localAddress = local.slice(0, local.lastIndexOf(':'));
  if (!proxyTargetBindingMatches(policy, inspected, inspectedNetwork) || inspectedNetwork?.Driver !== 'bridge') {
    const observed = observedProxyTargetBinding(policy, dockerObservation, localAddress);
    if (observed === null) return rejected('LIVE_AND_OBSERVED_DOCKER_TARGET_BINDING_REJECTED');
    const identity = JSON.parse(readFileSync(policy.identityPath, 'utf8'));
    return { reason: 'IDENTITY_BOUND_INTERNAL_PROXY_TEARDOWN', receipt: {
      schemaVersion: 'geneway-gate02b-proxy-egress-proof/1', reason: 'IDENTITY_BOUND_INTERNAL_PROXY_TEARDOWN',
      socket: { local, peer, pid: processItem.pid },
      process: { startTicks: processItem.startTicks, commandLine: processItem.commandLine },
      policy: { path: policy.policyPath, hash: policy.policyHash, identityPath: policy.identityPath }, identity,
      target: policy.target, network: observed, bridge: observed.bridge } };
  }
  const gateways = (inspectedNetwork.IPAM?.Config ?? []).flatMap((config) =>
    typeof config.Gateway === 'string' ? [config.Gateway] : []);
  if (!gateways.includes(localAddress)) return rejected('LOCAL_ADDRESS_NOT_EXACT_NETWORK_GATEWAY');
  const configuredBridge = inspectedNetwork.Options?.['com.docker.network.bridge.name'];
  const bridgeName = typeof configuredBridge === 'string' && configuredBridge.length > 0
    ? configuredBridge : `br-${inspectedNetwork.Id.slice(0, 12)}`;
  const bridgeResult = capture(['ip', '-j', 'address', 'show', 'dev', bridgeName]);
  if (bridgeResult.status !== 0 || typeof bridgeResult.stdout !== 'string') return rejected('LIVE_BRIDGE_READ_FAILED');
  let bridge;
  try { [bridge] = JSON.parse(bridgeResult.stdout); } catch { return rejected('LIVE_BRIDGE_PARSE_FAILED'); }
  if (bridge?.ifname !== bridgeName || !Number.isInteger(bridge.ifindex) || typeof bridge.address !== 'string'
    || !(bridge.addr_info ?? []).some((address) => address.local === localAddress)) return rejected('LIVE_BRIDGE_IDENTITY_REJECTED');
  const identity = JSON.parse(readFileSync(policy.identityPath, 'utf8'));
  return { reason: 'IDENTITY_BOUND_INTERNAL_PROXY', receipt: {
    schemaVersion: 'geneway-gate02b-proxy-egress-proof/1', reason: 'IDENTITY_BOUND_INTERNAL_PROXY',
    socket: { local, peer, pid: processItem.pid },
    process: { startTicks: processItem.startTicks, commandLine: processItem.commandLine },
    policy: { path: policy.policyPath, hash: policy.policyHash, identityPath: policy.identityPath }, identity,
    target: policy.target,
    network: { id: inspectedNetwork.Id, name: inspectedNetwork.Name, internal: inspectedNetwork.Internal,
      driver: inspectedNetwork.Driver, project: inspectedNetwork.Labels?.['com.docker.compose.project'] },
    bridge: { name: bridgeName, ifindex: bridge.ifindex, mac: bridge.address, gateway: localAddress } } };
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

function unsafeListenerLine(line) {
  const local = line.split(/\s+/u)[0] ?? '';
  return (!local.startsWith('127.0.0.1:') && !local.startsWith('[::1]:')
      && !local.startsWith('[::ffff:127.0.0.1]:'))
    || /:(?:3150|3450)(?:\s|$)/u.test(local);
}

function exactNetworkRemovalObserved(networkId) {
  const inspected = capture(['docker', 'network', 'inspect', networkId]);
  if (inspected.status === 0) return false;
  const failure = `${String(inspected.stderr ?? '')}\n${String(inspected.stdout ?? '')}`;
  return inspected.status === 1 && /(?:No such network|network .* not found)/iu.test(failure);
}

function frozenAmbientInterfaceGoneWithoutReuse(proof) {
  const witness = proof.interfaceWitness;
  if (!exactNetworkRemovalObserved(witness.networkId)) return false;
  const links = capture(['ip', '-j', 'address', 'show']);
  if (links.status !== 0 || typeof links.stdout !== 'string') return false;
  try {
    const live = JSON.parse(links.stdout);
    const identityReused = live.some((link) => link.ifname === witness.interfaceName
      || link.ifindex === witness.ifindex || link.address === witness.interfaceMac
      || link.ifname === witness.bridge.name || link.ifindex === witness.bridge.ifindex
      || link.address === witness.bridge.mac);
    const addressReused = live.some((link) => (link.addr_info ?? []).some((address) =>
      address.local === proof.listener.address));
    return !identityReused && !addressReused;
  } catch {
    return false;
  }
}

function exactAmbientNetworkDestroyEvent(state, dockerObservation) {
  return dockerObservation.lifecycleEvents.find((event) => event.sequence > state.lastExactEventSequence
    && event.type === 'network' && event.action === 'destroy'
    && event.networkId === state.proof.interfaceWitness.networkId
    && event.networkName === state.proof.interfaceWitness.networkName) ?? null;
}

function classifyAmbientOwnedListeners(input) {
  const { addedGlobalListeners, dockerObservation, preGateProofs, proxyRunRoot, knownPolicyPaths,
    ledger, sample, rawRows, unstableGlobalListeners, liveWitnesses, liveProofs } = input;
  const parsedRows = rawRows.flatMap((raw) => {
    const parsed = tryParseSsListenerRow(raw);
    return parsed.ok ? [{ raw, row: parsed.value, line: `${parsed.value.endpoint} pids=${String(parsed.value.pid)}` }] : [];
  });
  const validated = [];
  const unsafe = [];
  const releasedDuringSample = [];
  const ownerlessReleaseReceipts = [];
  const transientReleaseReceipts = [];
  const unsafeReceipts = [];
  const presentEndpoints = new Set();
  for (const line of unstableGlobalListeners.filter((candidate) => unsafeListenerLine(candidate)
    && !candidate.endsWith(' pids='))) {
    const matches = parsedRows.filter((candidate) => candidate.line === line);
    const row = matches.length === 1 ? matches[0].row : null;
    const preGateProcessProof = row === null ? null : preGateProofs.get(row.pid) ?? null;
    const witness = row === null ? null : liveWitnesses.get(row.endpoint) ?? null;
    let currentProcessProof = null;
    try {
      if (preGateProcessProof !== null && row.owner === 'rygel' && row.cgroup === preGateProcessProof.cgroup) {
        const current = buildPreGateRygelProcessProof(row.pid, ambientListenerProofHooks());
        if (current.processInstanceKey === preGateProcessProof.processInstanceKey) currentProcessProof = current;
      }
    } catch { currentProcessProof = null; }
    const absentAgain = row !== null && !detailedGlobalListenerSnapshot().some((candidate) => {
      const parsed = tryParseSsListenerRow(candidate);
      const ownerless = parseOwnerlessAmbientEnvelope(candidate);
      return (parsed.ok ? parsed.value.endpoint : ownerless?.endpoint) === row.endpoint;
    });
    if (row !== null && currentProcessProof !== null && witness !== null && absentAgain) {
      releasedDuringSample.push(line);
      transientReleaseReceipts.push({ schemaVersion: 'geneway-gate02b-owned-ambient-transient-release/1',
        endpoint: row.endpoint, listener: row, processProof: currentProcessProof, interfaceWitness: witness,
        firstSeenSample: sample, consecutiveAbsenceSnapshots: 2, status: 'RELEASED_DURING_OWNER_TEARDOWN' });
    } else unsafe.push(line);
  }
  for (const line of unstableGlobalListeners.filter((candidate) => unsafeListenerLine(candidate)
    && candidate.endsWith(' pids='))) {
    const endpoint = line.slice(0, -' pids='.length);
    const envelopes = rawRows.map(parseOwnerlessAmbientEnvelope).filter((envelope) => envelope?.endpoint === endpoint);
    const envelope = envelopes.length === 1 ? envelopes[0] : null;
    const matchingProcesses = envelope === null ? [] : [...preGateProofs.values()].filter((proof) =>
      proof.cgroup === envelope.cgroup);
    const witness = liveWitnesses.get(endpoint) ?? null;
    let processProof = matchingProcesses.length === 1 ? matchingProcesses[0] : null;
    try {
      if (processProof !== null) {
        const current = buildPreGateRygelProcessProof(processProof.pid, ambientListenerProofHooks());
        if (current.processInstanceKey !== processProof.processInstanceKey
          || statSync(`/proc/${String(processProof.pid)}`).uid !== envelope.uid) processProof = null;
      }
    } catch { processProof = null; }
    let cgroupReceipt = null;
    if (processProof !== null && /^\/user\.slice\/[A-Za-z0-9@_.\/-]+\/rygel\.service$/u.test(envelope.cgroup)) try {
      const path = resolve('/sys/fs/cgroup', `.${envelope.cgroup}`, 'cgroup.procs');
      const stat = lstatSync(path);
      const pids = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(Number).sort((left, right) => left - right);
      if (stat.isFile() && !stat.isSymbolicLink() && JSON.stringify(pids) === JSON.stringify([processProof.pid])) {
        cgroupReceipt = { path, device: stat.dev, inode: stat.ino, pids };
      }
    } catch { cgroupReceipt = null; }
    const absentAgain = !detailedGlobalListenerSnapshot().some((candidate) => {
      const parsed = tryParseSsListenerRow(candidate);
      const ownerless = parseOwnerlessAmbientEnvelope(candidate);
      return (parsed.ok ? parsed.value.endpoint : ownerless?.endpoint) === endpoint;
    });
    if (envelope !== null && processProof !== null && witness !== null && cgroupReceipt !== null && absentAgain) {
      releasedDuringSample.push(line);
      ownerlessReleaseReceipts.push({ schemaVersion: 'geneway-gate02b-ownerless-ambient-release/1',
        endpoint, envelope, processProof, interfaceWitness: witness, cgroupReceipt,
        firstSeenSample: sample, consecutiveAbsenceSnapshots: 2, status: 'RELEASED_DURING_OWNER_TEARDOWN' });
    } else {
      unsafe.push(line);
      if (envelope !== null && processProof !== null && witness !== null && cgroupReceipt !== null) {
        unsafeReceipts.push({ schemaVersion: 'geneway-gate02b-ownerless-ambient-pending/1', line, endpoint,
          envelope, processProof, interfaceWitness: witness, cgroupReceipt, firstSeenSample: sample,
          status: 'UNRESOLVED_OWNERLESS_STRONG_SOCKET' });
      }
    }
  }
  for (const line of addedGlobalListeners.filter(unsafeListenerLine)) {
    const [coarseEndpoint, coarseOwners = ''] = line.split(' pids=');
    const endpointMatches = parsedRows.filter((candidate) => candidate.row.endpoint === coarseEndpoint);
    const matches = endpointMatches.filter((candidate) => candidate.row.endpoint === coarseEndpoint
      && (coarseOwners === '' || candidate.line === line));
    if (matches.length === 0 && endpointMatches.length === 0) {
      const existing = ledger.get(coarseEndpoint);
      const confirmedAbsent = existing !== undefined && !detailedGlobalListenerSnapshot().some((candidate) => {
        const parsed = tryParseSsListenerRow(candidate);
        return parsed.ok && parsed.value.endpoint === coarseEndpoint;
      });
      if (confirmedAbsent && existing.status === 'PROVEN') {
        existing.status = 'RELEASED'; existing.reason = 'STRONG_INSTANCE_DISAPPEARED_DURING_SAMPLE';
        existing.history.push({ sample, status: existing.status, reason: existing.reason });
        releasedDuringSample.push(line);
        continue;
      }
    }
    if (matches.length !== 1 || [3150, 3450].includes(matches[0]?.row.port)) {
      unsafe.push(line);
      continue;
    }
    const { raw, row } = matches[0];
    const existing = ledger.get(row.endpoint);
    let proof = liveProofs.get(row.endpoint) ?? null;
    let liveWitness = proof?.interfaceWitness
      ?? exactAmbientOwnedInterfaceWitness(row, dockerObservation, proxyRunRoot, knownPolicyPaths);
    if (liveWitness === null && existing === undefined && preGateProofs.has(row.pid)) {
      for (let attempt = 1; attempt <= 5 && liveWitness === null; attempt += 1) {
        observeDockerResources(dockerObservation);
        liveWitness = exactAmbientOwnedInterfaceWitness(row, dockerObservation, proxyRunRoot, knownPolicyPaths);
        if (liveWitness === null && attempt < 5) Atomics.wait(procNetRetrySignal, 0, 0, 20);
      }
    }
    const interfaceWitness = liveWitness ?? existing?.proof?.interfaceWitness ?? null;
    const preGateProcessProof = preGateProofs.get(row.pid);
    try {
      if (interfaceWitness !== null && preGateProcessProof !== undefined) {
        proof ??= buildAmbientRygelListenerProof({ row: raw, preGateProcessProof, interfaceWitness },
          ambientListenerProofHooks(rawRows));
      }
    } catch {
      proof = null;
    }
    if (proof === null) {
      const stillPresent = detailedGlobalListenerSnapshot().some((candidate) => {
        const parsed = tryParseSsListenerRow(candidate);
        return parsed.ok && parsed.value.endpoint === row.endpoint;
      });
      if (existing !== undefined && !stillPresent) {
        continue;
      }
      presentEndpoints.add(row.endpoint);
      if (existing !== undefined) {
        existing.status = 'VIOLATION'; existing.reason = 'STRONG_SOCKET_OR_PROCESS_PROOF_FAILED';
        existing.history.push({ sample, status: existing.status, reason: existing.reason });
      }
      unsafe.push(line);
      continue;
    }
    presentEndpoints.add(row.endpoint);
    if (liveWitness !== null) {
      if (existing === undefined) {
        ledger.set(row.endpoint, { status: 'PROVEN', reason: 'EXACT_LIVE_PROOF', proof,
          lastExactEventSequence: dockerObservation.lifecycleEvents.length,
          history: [{ sample, status: 'PROVEN', reason: 'EXACT_LIVE_PROOF' }] });
      } else if (existing.status === 'PROVEN' && existing.proof.instanceKey === proof.instanceKey) {
        existing.proof = proof;
        existing.reason = 'SAME_INSTANCE_REPROVEN';
        existing.lastExactEventSequence = dockerObservation.lifecycleEvents.length;
        existing.history.push({ sample, status: existing.status, reason: existing.reason });
      } else {
        existing.status = 'VIOLATION'; existing.reason = 'LISTENER_REAPPEARED_OR_IDENTITY_CHANGED';
        existing.history.push({ sample, status: existing.status, reason: existing.reason });
      }
    } else if (existing !== undefined && ['PROVEN', 'TEARDOWN_PENDING'].includes(existing.status)
      && existing.proof.instanceKey === proof.instanceKey && frozenAmbientInterfaceGoneWithoutReuse(proof)) {
      existing.proof = proof;
      existing.status = 'TEARDOWN_PENDING';
      existing.reason = exactAmbientNetworkDestroyEvent(existing, dockerObservation) === null
        ? 'AWAITING_EXACT_NETWORK_DESTROY_EVENT' : 'EXACT_NETWORK_DESTROY_OBSERVED';
      existing.pendingSinceSample ??= sample;
      if (sample - existing.pendingSinceSample > 10) {
        existing.status = 'VIOLATION'; existing.reason = 'TEARDOWN_PENDING_EXCEEDED_ONE_SECOND';
      }
      existing.history.push({ sample, status: existing.status, reason: existing.reason });
    } else if (existing !== undefined) {
      existing.status = 'VIOLATION'; existing.reason = 'TEARDOWN_IDENTITY_OR_LINK_CONTRADICTION';
      existing.history.push({ sample, status: existing.status, reason: existing.reason });
    }
    const current = ledger.get(row.endpoint);
    if (current !== undefined && current.status !== 'VIOLATION') validated.push(line);
    else unsafe.push(line);
  }
  for (const [endpoint, state] of ledger) {
    if (presentEndpoints.has(endpoint) || ['RELEASED', 'VIOLATION'].includes(state.status)) continue;
    if (state.status === 'TEARDOWN_PENDING') {
      state.status = 'GONE_PENDING_EVENT'; state.reason = 'STRONG_INSTANCE_DISAPPEARED_AFTER_NETWORK_REMOVAL';
    } else if (state.status === 'PROVEN') {
      state.status = 'RELEASED'; state.reason = 'STRONG_INSTANCE_DISAPPEARED_WITHOUT_UNSAFE_TRANSITION';
    }
    state.history.push({ sample, status: state.status, reason: state.reason });
  }
  const released = [...ledger.values()].filter((state) => state.status === 'RELEASED').map((state) =>
    `${state.proof.listener.endpoint} pids=${String(state.proof.listener.pid)}`);
  return { validated: [...new Set(validated)].sort(), released: [...new Set([...released, ...releasedDuringSample])].sort(),
    unsafe: [...new Set(unsafe)].sort(), unsafeReceipts, ownerlessReleaseReceipts, transientReleaseReceipts };
}

function finalizeAmbientListenerLedger(ledger, dockerObservation) {
  const failures = [];
  for (const [endpoint, state] of ledger) {
    if (state.status === 'GONE_PENDING_EVENT') {
      const event = exactAmbientNetworkDestroyEvent(state, dockerObservation);
      if (event !== null && frozenAmbientInterfaceGoneWithoutReuse(state.proof)) {
        state.status = 'RELEASED'; state.reason = 'EXACT_TEARDOWN_RELEASED'; state.destroyEvent = event;
      } else {
        state.status = 'VIOLATION'; state.reason = 'EXACT_TEARDOWN_EVENT_MISSING';
      }
      state.history.push({ sample: 'final', status: state.status, reason: state.reason });
    } else if (state.status === 'TEARDOWN_PENDING') {
      state.status = 'VIOLATION'; state.reason = 'LISTENER_PRESENT_AT_FINAL_SAMPLE';
      state.history.push({ sample: 'final', status: state.status, reason: state.reason });
    }
    if (state.status === 'VIOLATION') failures.push(`${endpoint}:${state.reason}`);
  }
  return failures.sort();
}

export function isForbiddenRuntimeCommandLine(commandLine) {
  if (typeof commandLine !== 'string') return false;
  const forbiddenRuntimePattern = /(?:start-e2e-model-gateway|start-gate-a0-release|run-gate-a0-lan|gate-a0-live|GENEWAY_LAN_|GENEWAY_MODEL_GATEWAY_|(?:^|\s)provider(?:\s|$))/iu;
  if (forbiddenRuntimePattern.test(commandLine)) return true;
  return /services\/model-gateway/iu.test(commandLine) && !isModelGatewayTypeScriptProjectBuild(commandLine);
}

function runtimeBoundarySample(rootPid, initialGlobalListeners, knownProxyPolicyPaths = [], dockerObservation,
  ambientBoundary) {
  const descendants = descendantProcesses(rootPid);
  const listeners = socketLinesForProcesses(['ss', '-H', '-ltnp'], descendants, 'listener');
  const egress = socketLinesForProcesses(['ss', '-H', '-tnp', 'state', 'established'], descendants, 'egress');
  observeDockerResources(dockerObservation);
  const firstGlobalSnapshot = globalListenerSnapshot();
  const firstAddedGlobalListeners = additions(initialGlobalListeners, firstGlobalSnapshot.lines);
  const ambientLiveWitnesses = new Map();
  const ambientLiveProofs = new Map();
  for (const raw of firstGlobalSnapshot.raw) {
    const parsed = tryParseSsListenerRow(raw);
    const row = parsed.ok ? parsed.value : parseOwnerlessAmbientEnvelope(raw);
    if (row === null) continue;
    const witness = exactAmbientOwnedInterfaceWitness(row, dockerObservation,
      ambientBoundary.proxyRunRoot, knownProxyPolicyPaths);
    if (witness === null) continue;
    ambientLiveWitnesses.set(row.endpoint, witness);
    if (!parsed.ok) continue;
    const preGateProcessProof = ambientBoundary.preGateProofs.get(parsed.value.pid);
    if (preGateProcessProof === undefined) continue;
    try {
      const proof = buildAmbientRygelListenerProof({ row: raw, preGateProcessProof, interfaceWitness: witness },
        ambientListenerProofHooks(firstGlobalSnapshot.raw));
      ambientLiveProofs.set(parsed.value.endpoint, proof);
    } catch {
      // A listener that cannot be rebound immediately remains unproven.
    }
  }
  const secondGlobalSnapshot = globalListenerSnapshot();
  for (const [endpoint, proof] of ambientLiveProofs) {
    const sameInstance = secondGlobalSnapshot.raw.some((raw) => {
      const parsed = tryParseSsListenerRow(raw);
      if (!parsed.ok) return false;
      const row = parsed.value;
      return row.endpoint === endpoint && row.pid === proof.listener.pid && row.fd === proof.listener.fd
        && row.uid === proof.listener.uid && row.socketInode === proof.listener.socketInode
        && row.sk === proof.listener.sk && row.cgroup === proof.listener.cgroup;
    });
    if (!sameInstance) ambientLiveProofs.delete(endpoint);
  }
  const secondGlobalSet = new Set(secondGlobalSnapshot.lines);
  const addedGlobalListeners = firstAddedGlobalListeners.filter((line) => secondGlobalSet.has(line));
  const unstableGlobalListeners = firstAddedGlobalListeners.filter((line) => !secondGlobalSet.has(line));
  const ambient = classifyAmbientOwnedListeners({ addedGlobalListeners, dockerObservation,
    preGateProofs: ambientBoundary.preGateProofs, proxyRunRoot: ambientBoundary.proxyRunRoot,
    knownPolicyPaths: knownProxyPolicyPaths, ledger: ambientBoundary.ledger, sample: ambientBoundary.sample,
    rawRows: firstGlobalSnapshot.raw, unstableGlobalListeners, liveWitnesses: ambientLiveWitnesses,
    liveProofs: ambientLiveProofs });
  const forbiddenProcesses = descendants.filter((item) => isForbiddenRuntimeCommandLine(item.commandLine))
    .map((item) => ({ pid: item.pid, command: item.command, identity: item.commandLine.split(/\s+/u).slice(0, 4).join(' ') }));
  const ambientValidatedSet = new Set(ambient.validated);
  const ambientReleasedSet = new Set(ambient.released);
  const unsafeListenerSources = {
    descendants: listeners.filter(unsafeListenerLine),
    unstableGlobal: unstableGlobalListeners.filter((line) => unsafeListenerLine(line) && !ambientReleasedSet.has(line)),
    ambientProof: ambient.unsafe,
    stableGlobal: addedGlobalListeners.filter((line) => unsafeListenerLine(line)
      && !ambientValidatedSet.has(line) && !ambientReleasedSet.has(line)),
  };
  const unsafeListeners = Object.values(unsafeListenerSources).flat();
  const proxyEgressReceipts = [];
  const proxyEgressRejections = [];
  const nonLoopbackEgress = egress.filter((line) => {
    const connection = line.split(/\s+/u)[0] ?? '';
    const peer = connection.split('->')[1] ?? '';
    if (peer.startsWith('127.0.0.1:') || peer.startsWith('[::1]:')) return false;
    const pid = Number(line.match(/pid=(\d+)/u)?.[1] ?? 0);
    const processItem = descendants.find((item) => item.pid === pid);
    if (processItem === undefined) return true;
    const decision = proxyEgressPolicyDecision(processItem, line, dockerObservation);
    if (decision.receipt === null) {
      proxyEgressRejections.push({ line, reason: decision.reason });
      return true;
    }
    proxyEgressReceipts.push(decision.receipt);
    return false;
  });
  return {
    descendantCount: descendants.length,
    identities: descendants.map((item) => ({ pid: item.pid, startTicks: item.startTicks, command: item.command,
      listenerEndpoints: listeners.filter((line) => line.endsWith(`pid=${String(item.pid)}`)) })),
    addedGlobalListeners,
    ambientOwnedInterfaceListeners: ambient.validated,
    ownerlessAmbientReleases: ambient.ownerlessReleaseReceipts,
    transientAmbientReleases: ambient.transientReleaseReceipts,
    forbiddenProcesses,
    unsafeListeners,
    unsafeListenerSources,
    unsafeReceipts: ambient.unsafeReceipts,
    nonLoopbackEgress,
    proxyEgressReceipts,
    proxyEgressRejections,
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
  const preGateProofs = preGateAmbientRygelProofs();
  const ambientListenerLedger = new Map();
  const observedIdentities = new Map();
  const runtimeReceipt = { checked: true, sampleCount: 0, maxDescendantCount: 0, unsafeListeners: [],
    ambientOwnedInterfaceListeners: [], ambientPreGateProcesses: [...preGateProofs.values()],
    ambientListenerStates: [], ownerlessAmbientReleases: [], listenerObservations: [],
    transientAmbientReleases: [],
    nonLoopbackEgress: [], forbiddenProcesses: [],
    proxyEgressReceipts: [],
    proxyEgressRejections: [],
    proxyPolicyPaths: [], sampleErrors: [] };
  const dockerObservation = createDockerObservation();
  const dockerEventMonitor = startDockerEventMonitor(dockerObservation,
    `${outputRoot}/${step.phase}-${step.name}.docker-events.jsonl`);
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
            runtimeReceipt.proxyPolicyPaths, dockerObservation, { preGateProofs,
              proxyRunRoot: environment.GENEWAY_GATE02B_PROXY_RUN_ROOT,
              ledger: ambientListenerLedger, sample: runtimeReceipt.sampleCount + 1 });
          runtimeReceipt.sampleCount += 1;
          runtimeReceipt.maxDescendantCount = Math.max(runtimeReceipt.maxDescendantCount, observed.descendantCount);
          runtimeReceipt.addedGlobalListeners ??= [];
          runtimeReceipt.addedGlobalListeners.push(...observed.addedGlobalListeners);
          runtimeReceipt.ambientOwnedInterfaceListeners.push(...observed.ambientOwnedInterfaceListeners);
          runtimeReceipt.ownerlessAmbientReleases.push(...observed.ownerlessAmbientReleases);
          runtimeReceipt.transientAmbientReleases.push(...observed.transientAmbientReleases);
          runtimeReceipt.unsafeListeners.push(...observed.unsafeListeners);
          runtimeReceipt.listenerObservations.push({ sample: runtimeReceipt.sampleCount,
            unsafe: observed.unsafeListeners, unsafeSources: observed.unsafeListenerSources,
            unsafeReceipts: observed.unsafeReceipts,
            validated: observed.ambientOwnedInterfaceListeners });
          runtimeReceipt.nonLoopbackEgress.push(...observed.nonLoopbackEgress);
          runtimeReceipt.proxyEgressReceipts.push(...observed.proxyEgressReceipts);
          runtimeReceipt.proxyEgressRejections.push(...observed.proxyEgressRejections);
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
      try {
        runtimeReceipt.dockerQuiescence = await waitForDockerBoundaryQuiescence(dockerObservation);
      } catch (cause) {
        runtimeReceipt.sampleErrors.push(`final-docker-quiescence:${cause instanceof Error ? cause.message : String(cause)}`);
      }
    } finally {
      try { await stopDockerEventMonitor(dockerEventMonitor, dockerObservation); } catch (cause) {
        dockerObservation.monitorErrors.push(`stop:${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  const ambientFinalFailures = finalizeAmbientListenerLedger(ambientListenerLedger, dockerObservation);
  runtimeReceipt.addedGlobalListeners = [...new Set(runtimeReceipt.addedGlobalListeners ?? [])].sort();
  runtimeReceipt.ambientOwnedInterfaceListeners = [...new Set(runtimeReceipt.ambientOwnedInterfaceListeners)].sort();
  runtimeReceipt.ownerlessAmbientReleases = [...new Map(runtimeReceipt.ownerlessAmbientReleases.map((receipt) =>
    [`${receipt.endpoint}:${String(receipt.firstSeenSample)}`, receipt])).values()];
  runtimeReceipt.transientAmbientReleases = [...new Map(runtimeReceipt.transientAmbientReleases.map((receipt) =>
    [`${receipt.endpoint}:${String(receipt.firstSeenSample)}`, receipt])).values()];
  runtimeReceipt.ambientListenerStates = [...ambientListenerLedger.entries()].map(([endpoint, state]) => ({
    endpoint, status: state.status, reason: state.reason, proof: state.proof, destroyEvent: state.destroyEvent ?? null,
    history: state.history,
  })).sort((left, right) => left.endpoint.localeCompare(right.endpoint));
  runtimeReceipt.unsafeListeners = [...new Set([
    ...unresolvedUnsafeListeners(runtimeReceipt.listenerObservations, [...ambientListenerLedger.values()],
      runtimeReceipt.transientAmbientReleases),
    ...ambientFinalFailures.map((failure) => `ambient-listener:${failure}`),
  ])].sort();
  runtimeReceipt.nonLoopbackEgress = [...new Set(runtimeReceipt.nonLoopbackEgress)].sort();
  runtimeReceipt.proxyEgressReceipts = [...new Map(runtimeReceipt.proxyEgressReceipts.map((receipt) =>
    [JSON.stringify(receipt.socket), receipt])).values()];
  runtimeReceipt.proxyEgressRejections = [...new Map(runtimeReceipt.proxyEgressRejections.map((receipt) =>
    [`${receipt.line}:${receipt.reason}`, receipt])).values()];
  runtimeReceipt.forbiddenProcesses = [...new Map(runtimeReceipt.forbiddenProcesses.map((item) => [`${String(item.pid)}:${item.identity}`, item])).values()];
  const backupRunsRequired = result.status === 0 && result.signal === null
    && ['gate0.2b.3', 'gate0.2a-baseline'].includes(step.name);
  const backupLog = readFileSync(logPath, 'utf8');
  const expectedBackupRuns = extractStructuredBackupRuns(backupLog, backupRunsRequired);
  const expectedBackupRunIds = expectedBackupRuns.map((result) => result.runId).sort();
  const proxyRoots = [...new Set([
    environment.GENEWAY_GATE02B_PROXY_RUN_ROOT,
    ...expectedBackupRunIds.map((runId) => `/tmp/geneway-runs/${runId}-proxies`),
  ])];
  const enforceExpectedCardinality = result.status === 0 && result.signal === null;
  try {
    runtimeReceipt.structuralIsolation = dockerStructuralIsolationReceipt(dockerObservation, expectedBackupRunIds, proxyRoots,
      { ...step, expectedBackupProjects: expectedBackupProxyProjects(expectedBackupRuns), enforceExpectedCardinality });
  } catch (cause) {
    if (enforceExpectedCardinality) throw cause;
    runtimeReceipt.structuralIsolation = {
      checked: true,
      passed: false,
      partialFailureEvidence: true,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
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
