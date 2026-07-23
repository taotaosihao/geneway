import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
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
  { phase: 'V3', name: 'integration', command: ['pnpm', 'test:integration'] },
  { phase: 'V4', name: 'security', command: ['pnpm', 'test:security'] },
  { phase: 'V5', name: 'gate0.2b.2', command: ['pnpm', 'verify:gate0.2b.2'] },
  { phase: 'V6', name: 'gate0.2b.3', command: ['pnpm', 'verify:gate0.2b.3'] },
  { phase: 'V7', name: 'gate0.2a-baseline', command: ['pnpm', 'verify:gate0.2a'], inheritRunId: false },
  { phase: 'V7', name: 'gate0.2b.1-baseline', command: ['pnpm', 'verify:gate0.2b.1'] },
  { phase: 'V7', name: 'local-a0-no-business-objects', command: ['pnpm', 'test:e2e', '--', '--project=gate0.2b-fast-chat-local'] },
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

function safeEnvironment() {
  const environment = {};
  for (const name of safeChildEnvironmentNames) {
    if (Object.hasOwn(process.env, name)) environment[name] = process.env[name];
  }
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
  }));
  const actual = steps.map((step) => ({
    phase: step.phase,
    name: step.name,
    command: [...step.command],
    inheritRunId: step.inheritRunId !== false,
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
  const compiled = capture(['cc', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-ldl',
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
  state.networks.set(network.Id ?? identity, { id: network.Id ?? identity, name: name ?? identity, internal: network.Internal === true,
    inspectObserved: true, project: network.Labels?.['com.docker.compose.project'] ?? null,
    subnets: (network.IPAM?.Config ?? []).flatMap((config) => typeof config.Subnet === 'string' ? [config.Subnet] : []) });
}

function observeDockerContainer(state, identity, fallbackName) {
  const inspected = dockerJson(['docker', 'container', 'inspect', identity]);
  const container = Array.isArray(inspected) ? inspected[0] : undefined;
  const name = typeof container?.Name === 'string' ? container.Name.replace(/^\//u, '') : fallbackName;
  if (!isRepositoryDockerScope(name, container?.Config?.Labels ?? {})) return;
  const existing = state.containers.get(container?.Id ?? identity) ?? { id: container?.Id ?? identity, name, networkIds: new Set(), networkNames: new Set(), inspectObserved: false };
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
    try {
      const procStat = readFileSync(`/proc/${String(container.State.Pid)}/stat`, 'utf8');
      existing.pidStartTicks = procStat.slice(procStat.lastIndexOf(')') + 1).trim().split(/\s+/u)[19] ?? null;
    } catch { existing.pidStartTicks = null; }
  }
  existing.publishedPorts = Object.values(container?.NetworkSettings?.Ports ?? {}).flatMap((bindings) => Array.isArray(bindings)
    ? bindings.map((binding) => ({ hostIp: binding.HostIp, hostPort: binding.HostPort })) : []);
  for (const [networkName, attachment] of Object.entries(container?.NetworkSettings?.Networks ?? {})) {
    existing.networkNames.add(networkName);
    if (typeof attachment?.NetworkID === 'string' && attachment.NetworkID.length > 0) existing.networkIds.add(attachment.NetworkID);
    observeDockerNetwork(state, attachment?.NetworkID || networkName);
  }
  if (container?.State?.Running === true && Number.isInteger(container.State.Pid) && container.State.Pid > 0) {
    existing.netnsAttempted = true;
    existing.netnsSockets ??= [];
    existing.netnsErrors ??= [];
    for (const [protocol, file] of [['tcp', 'tcp'], ['tcp6', 'tcp6'], ['udp', 'udp'], ['udp6', 'udp6']]) {
      try {
        const text = readFileSync(`/proc/${String(container.State.Pid)}/net/${file}`, 'utf8');
        existing.netnsSockets.push(...parseProcNetSockets(text, protocol));
      } catch (cause) {
        existing.netnsErrors.push(`${protocol}:${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  state.containers.set(existing.id, existing);
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
    const existing = state.containers.get(identity) ?? { id: identity, name, networkIds: new Set(), networkNames: new Set(), inspectObserved: false };
    existing.repositoryScoped = true;
    existing.eventObserved = true;
    existing.service = attributes['com.docker.compose.service'] ?? existing.service ?? null;
    existing.project = attributes['com.docker.compose.project'] ?? existing.project ?? null;
    existing.backupRun = attributes['geneway.backup.run'] ?? existing.backupRun ?? null;
    existing.backupRole = attributes['geneway.backup.role'] ?? existing.backupRole ?? null;
    existing.backupAction = attributes['geneway.backup.action'] ?? existing.backupAction ?? null;
    existing.egressReceiptPath = attributes['geneway.gate02b.egress_receipt'] ?? existing.egressReceiptPath ?? null;
    if (action === 'die') existing.exitCode = attributes.exitCode ?? null;
    state.containers.set(identity, existing);
    if (action !== 'destroy') observeDockerContainer(state, identity, name);
  }
  if (type === 'network' && isRepositoryDockerScope(name, attributes)) {
    if (action !== 'destroy') observeDockerNetwork(state, identity || name);
    const containerId = attributes.container;
    if (action === 'connect' && typeof containerId === 'string') {
      const container = state.containers.get(containerId) ?? { id: containerId, name: attributes.container_name ?? 'unknown', networkIds: new Set(), networkNames: new Set(), inspectObserved: false };
      container.networkIds.add(identity);
      container.networkNames.add(name);
      state.containers.set(containerId, container);
    }
  }
}

function parseProcNetIpv4(hex) {
  if (!/^[0-9A-F]{8}$/iu.test(hex)) throw new Error(`invalid IPv4 socket address: ${hex}`);
  return [6, 4, 2, 0].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join('.');
}

function parseProcNetSockets(text, protocol) {
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
      remoteAddress = /^0+$/u.test(normalized) ? '::' : /^0{31}1$/u.test(normalized) ? '::1' : normalized;
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
  monitor.kill('SIGTERM');
  const forcedKill = setTimeout(() => monitor.kill('SIGKILL'), 2_000);
  const result = await state.monitorClosed;
  clearTimeout(forcedKill);
  state.monitorExit = result;
}

function minimumBackupStartIdentities(role, action) {
  if (role === 'provision') return action === 'source' ? 3 : 2;
  return ['online-storage', 'control-plane'].includes(role) ? 2 : 1;
}

export function parseBackupRawReceipt(rawText, containerId, role, action, allowedPorts) {
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
    if (detail !== 'family=CONNECTED' && (inet === null || !allowedPorts.includes(inet[2]))) unknownLines.push(line);
    attempted.push(line);
  }
  const uniqueIdentities = [...new Map(starts.map((identity) => [`${String(identity.pid)}:${identity.pidStartTicks}`, identity])).values()];
  const identitiesValid = uniqueIdentities.length >= minimumBackupStartIdentities(role, action)
    && new Set(uniqueIdentities.map((identity) => identity.pid)).size === uniqueIdentities.length
    && starts.every((identity) => identity.pid > 0 && identity.hostname === containerId.slice(0, 12));
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
    const raw = parseBackupRawReceipt(rawBytes.toString('utf8'), container.id, container.backupRole,
      container.backupAction, container.egressAllowedPorts);
    const passed = receipt.schemaVersion === 'geneway-backup-egress-boundary/1' && receipt.passed === true
      && receipt.runId === container.backupRun && receipt.containerId === container.id
      && receipt.role === container.backupRole && receipt.action === container.backupAction
      && receipt.networkMode === container.networkMode && receipt.policyComplete === true
      && Array.isArray(receipt.startIdentities) && receipt.startIdentities.length > 0
      && receipt.startIdentities.every((identity) => Number.isInteger(identity.pid) && identity.pid > 0
        && typeof identity.pidStartTicks === 'string' && identity.pidStartTicks !== 'unknown'
        && identity.hostname === container.id.slice(0, 12))
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

export function extractStructuredBackupRunIds(logText, required) {
  const candidates = logText.split('\n').flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.outcome === 'passed' && Array.isArray(parsed.results)
        && parsed.results.length === 3 && parsed.results.every((result) => typeof result.runId === 'string')
        ? [parsed.results.map((result) => result.runId)] : [];
    } catch { return []; }
  });
  if (!required) return [];
  if (candidates.length !== 1 || new Set(candidates[0]).size !== 3) throw new Error('Gate 0.2B structured backup child run IDs are missing or duplicated');
  if (candidates[0].some((runId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId))) {
    throw new Error('Gate 0.2B structured backup child run ID is unsafe');
  }
  return [...candidates[0]].sort();
}

export function backupArtifactRoots(results) {
  const runIds = [...new Set(results.flatMap((result) => result.runtimeBoundary?.structuralIsolation?.expectedBackupRunIds ?? []))].sort();
  if (runIds.some((runId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId))) throw new Error('Gate 0.2B backup artifact run ID is unsafe');
  return runIds.map((runId) => `/tmp/geneway-runs/${runId}/backup-restore`);
}

export function dockerStructuralIsolationReceipt(state, expectedBackupRunIds = []) {
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
  })).sort((left, right) => left.name.localeCompare(right.name));
  const networks = [...state.networks.values()].sort((left, right) => left.name.localeCompare(right.name));
  const internalIdentities = new Set(networks.filter((network) => network.internal).flatMap((network) => [network.id, network.name]));
  const internalSubnets = networks.filter((network) => network.internal).flatMap((network) => network.subnets);
  const violations = [];
  for (const network of networks) {
    if (!network.internal) violations.push(`non-internal-network:${network.name}:${network.id}`);
    if (!network.inspectObserved) violations.push(`network-inspect-missing:${network.name}:${network.id}`);
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
  const eventMonitor = { checked: true, started: state.monitorStarted === true, eventCount: state.eventCount,
    parseErrors: state.eventParseErrors, errors: state.monitorErrors, exit: state.monitorExit ?? null,
    passed: state.monitorStarted === true && state.eventParseErrors.length === 0 && state.monitorErrors.length === 0
      && (state.monitorExit?.signal === 'SIGTERM' || state.monitorExit?.status === 0) };
  return { checked: true, eventMonitor, backupRunIds, expectedBackupRunIds, observedContainers: containers, observedNetworks: networks,
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

function runtimeBoundarySample(rootPid, initialGlobalListeners) {
  const descendants = descendantProcesses(rootPid);
  const listeners = socketLinesForProcesses(['ss', '-H', '-ltnp'], descendants, 'listener');
  const egress = socketLinesForProcesses(['ss', '-H', '-tnp', 'state', 'established'], descendants, 'egress');
  const addedGlobalListeners = additions(initialGlobalListeners, globalListenerLines());
  const forbiddenRuntimePattern = /(?:start-e2e-model-gateway|start-gate-a0-release|run-gate-a0-lan|services\/model-gateway|gate-a0-live|GENEWAY_LAN_|GENEWAY_MODEL_GATEWAY_|(?:^|\s)provider(?:\s|$))/iu;
  const forbiddenProcesses = descendants.filter((item) => forbiddenRuntimePattern.test(item.commandLine))
    .map((item) => ({ pid: item.pid, command: item.command, identity: item.commandLine.split(/\s+/u).slice(0, 4).join(' ') }));
  const unsafeListeners = [...listeners, ...addedGlobalListeners].filter((line) => {
    const local = line.split(/\s+/u)[0] ?? '';
    return (!local.startsWith('127.0.0.1:') && !local.startsWith('[::1]:'))
      || /:(?:3150|3450)(?:\s|$)/u.test(local);
  });
  const nonLoopbackEgress = egress.filter((line) => {
    const connection = line.split(/\s+/u)[0] ?? '';
    const peer = connection.split('->')[1] ?? '';
    return !peer.startsWith('127.0.0.1:') && !peer.startsWith('[::1]:');
  });
  return {
    descendantCount: descendants.length,
    identities: descendants.map((item) => ({ pid: item.pid, startTicks: item.startTicks, command: item.command,
      listenerEndpoints: listeners.filter((line) => line.endsWith(`pid=${String(item.pid)}`)) })),
    addedGlobalListeners,
    forbiddenProcesses,
    unsafeListeners,
    nonLoopbackEgress,
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
  const strippedPresentNames = findForbiddenEnvironmentNames(Object.keys(process.env));
  if (step.inheritRunId === false) delete environment.GENEWAY_RUN_ID;
  else environment.GENEWAY_RUN_ID = `${runId}-${step.phase.toLowerCase()}-${step.name}`;
  return { environment, strippedPresentNames, dockerIsolationEnvironment: {
    ...gate02bDockerIsolationEnvironment, GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY: guardLibraryPath,
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
  const runtimeReceipt = { checked: true, sampleCount: 0, maxDescendantCount: 0, unsafeListeners: [], nonLoopbackEgress: [], forbiddenProcesses: [], sampleErrors: [] };
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
          const observed = runtimeBoundarySample(child.pid ?? -1, stepGlobalListenerBaseline);
          runtimeReceipt.sampleCount += 1;
          runtimeReceipt.maxDescendantCount = Math.max(runtimeReceipt.maxDescendantCount, observed.descendantCount);
          runtimeReceipt.addedGlobalListeners ??= [];
          runtimeReceipt.addedGlobalListeners.push(...observed.addedGlobalListeners);
          runtimeReceipt.unsafeListeners.push(...observed.unsafeListeners);
          runtimeReceipt.nonLoopbackEgress.push(...observed.nonLoopbackEgress);
          runtimeReceipt.forbiddenProcesses.push(...observed.forbiddenProcesses);
          for (const identity of observed.identities) observedIdentities.set(`${String(identity.pid)}:${identity.startTicks}`, identity);
          observeDockerResources(dockerObservation);
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
  runtimeReceipt.unsafeListeners = [...new Set(runtimeReceipt.unsafeListeners)].sort();
  runtimeReceipt.addedGlobalListeners = [...new Set(runtimeReceipt.addedGlobalListeners ?? [])].sort();
  runtimeReceipt.nonLoopbackEgress = [...new Set(runtimeReceipt.nonLoopbackEgress)].sort();
  runtimeReceipt.forbiddenProcesses = [...new Map(runtimeReceipt.forbiddenProcesses.map((item) => [`${String(item.pid)}:${item.identity}`, item])).values()];
  const backupRunsRequired = ['gate0.2b.3', 'gate0.2a-baseline'].includes(step.name);
  const expectedBackupRunIds = extractStructuredBackupRunIds(readFileSync(logPath, 'utf8'), backupRunsRequired);
  runtimeReceipt.structuralIsolation = dockerStructuralIsolationReceipt(dockerObservation, expectedBackupRunIds);
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
  const v5Path = `/tmp/geneway-runs/${runId}-v5-gate0.2b.2/e2e-report-gate.json`;
  const gate02b1Path = `/tmp/geneway-runs/${runId}-v7-gate0.2b.1-baseline/e2e-report-gate.json`;
  const localRoutePath = `/tmp/geneway-runs/${runId}-v7-local-a0-no-business-objects/e2e-report-gate.json`;
  const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
  const v6Binding = aggregate.sourceBinding;
  const gate02aResult = results.find((result) => result.name === 'gate0.2a-baseline');
  if (gate02aResult === undefined) throw new Error('Gate 0.2A baseline result is missing');
  const gate02aLog = readFileSync(gate02aResult.logPath, 'utf8');
  const v6Result = results.find((result) => result.name === 'gate0.2b.3');
  if (v6Result === undefined) throw new Error('Gate 0.2B.3 result is missing');
  const v6Log = readFileSync(v6Result.logPath, 'utf8');
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
  const reports = {
    v5: readPassingE2eReceipt(v5Path, [
      'gate0.2b-success\u0000gate-0.2b-exception-flow.spec.ts\u0000真实异常纵切关联 served UI、API、Postgres、Worker 与 S3 Artifact',
    ]),
    gate02a: gate02aReceipts,
    gate02b1: readPassingE2eReceipt(gate02b1Path, [
      'gate0.2b-success\u0000gate-0.2b-task-workflow-routes.spec.ts\u0000真实任务可从六条 served 路由恢复，并与 API、Postgres 和 Worker 保持同一关联',
    ]),
    localA0: readPassingE2eReceipt(localRoutePath, [
      'gate0.2b-fast-chat-local\u0000gate-0.2b-fast-chat-local.spec.ts\u0000默认 Fast Chat 无需材料且不创建 Gate 0.2B 业务对象',
    ]),
  };
  const everyStepBound = results.every((result) => result.sourceBinding?.stable === true);
  const passed = aggregate.passed === true && aggregate.sourceStable === true
    && sourceBindingsMatch(aggregateBinding, v6Binding) && everyStepBound;
  if (!passed) throw new Error('Gate 0.2B child evidence or local A0 served routing receipt is incomplete');
  const artifactRoots = [
    dirname(aggregatePath), dirname(v5Path), dirname(gate02b1Path), dirname(localRoutePath),
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
    reachableCommands = validateCommandStrings(collectReachableCommandStrings(
      manifest.scripts ?? {}, requiredGate02bSteps.map((step) => step.command.join(' ')),
      { [nestedVerifierPath]: readFileSync(resolve(repositoryRoot, nestedVerifierPath), 'utf8') },
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
