import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const gearJobRoot = '/home/gewu/work/gearjob';
const authorityRoots = Object.freeze([
  '/home/gewu/.codex/workflow/artifacts/20260723-002-geneway-fast-chat/team/sdd/slices/gate-a0-fast-chat',
  '/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp',
  '/home/gewu/.codex/workflow/artifacts/20260723-022-geneway-gate-a-gate-0-2b-2-0-2b-3/team/sdd/slices/gate-0-2b-2-3-restoration',
]);

export const requiredGateASteps = Object.freeze([
  { phase: 'V1', name: 'authority-contract', command: ['pnpm', 'verify:gate-a-contract'], runIdSuffix: 'v1-contract' },
  { phase: 'V2', name: 'lint', command: ['pnpm', 'lint'], runIdSuffix: 'v2-quality' },
  { phase: 'V2', name: 'typecheck', command: ['pnpm', 'typecheck'], runIdSuffix: 'v2-quality' },
  { phase: 'V2', name: 'unit', command: ['pnpm', 'test'], runIdSuffix: 'v2-quality' },
  { phase: 'V2', name: 'contracts', command: ['pnpm', 'test:contracts'], runIdSuffix: 'v2-quality' },
  { phase: 'V2', name: 'build', command: ['pnpm', 'build'], runIdSuffix: 'v2-quality' },
  { phase: 'V3', name: 'integration', command: ['pnpm', 'test:integration'], runIdSuffix: 'v3-data' },
  { phase: 'V3', name: 'storage', command: ['pnpm', 'test:storage'], runIdSuffix: 'v3-data' },
  { phase: 'V3', name: 'security', command: ['pnpm', 'test:security'], runIdSuffix: 'v3-data' },
  { phase: 'V4', name: 'model-gateway', command: ['pnpm', 'test:model-gateway'], runIdSuffix: 'v4-model' },
  { phase: 'V4', name: 'gate-a-runtime', command: ['pnpm', 'test:gate-a-runtime'], runIdSuffix: 'v4-model' },
  { phase: 'V5', name: 'gearjob-preflight', command: ['pnpm', 'verify:gearjob-preflight'], runIdSuffix: 'v5-preflight' },
  {
    phase: 'V5',
    name: 'connector-gateway',
    command: ['pnpm', 'test:connector-gateway', '--', '--profile=gearjob-work-order-status'],
    runIdSuffix: 'v5-connector',
  },
  {
    phase: 'V6',
    name: 'served-live-product',
    command: ['pnpm', 'test:e2e', '--', '--project=gate-a-live'],
    runIdSuffix: 'v6-live',
  },
  {
    phase: 'V7',
    name: 'fault-restart-matrix',
    command: ['pnpm', 'test:e2e', '--', '--project=gate-a-recovery'],
    runIdSuffix: 'v7-recovery',
  },
  { phase: 'V7', name: 'actual-lan', command: ['pnpm', 'gate-a:lan'], runIdSuffix: 'v7-lan' },
  { phase: 'V7', name: 'gate-a0-regression', command: ['pnpm', 'verify:gate-a0'], runIdSuffix: 'v7-a0' },
  { phase: 'V7', name: 'gate0.2a-regression', command: ['pnpm', 'verify:gate0.2a'], runIdSuffix: 'v7-02a' },
  { phase: 'V7', name: 'gate0.2b-regression', command: ['pnpm', 'verify:gate0.2b'], runIdSuffix: 'v7-02b' },
  {
    phase: 'V7',
    name: 'secret-egress-zero-write-scan',
    command: ['pnpm', 'gate-a:secret-egress-scan'],
    runIdSuffix: 'v7-scan',
  },
]);

function commandText(command) {
  return command.map((part) => /[\s"']/u.test(part) ? JSON.stringify(part) : part).join(' ');
}

export function validateGateAStepPlan(steps) {
  const comparable = (step) => ({
    phase: step.phase,
    name: step.name,
    command: [...step.command],
    runIdSuffix: step.runIdSuffix,
  });
  if (JSON.stringify(steps.map(comparable)) !== JSON.stringify(requiredGateASteps.map(comparable))) {
    throw new Error('Gate A V1-V7 command membership or order changed');
  }
  const phases = steps.map((step) => Number(step.phase.slice(1)));
  if (phases.some((phase, index) => index > 0 && phase < (phases[index - 1] ?? phase))) {
    throw new Error('Gate A validation phases are not monotonic');
  }
  for (const step of steps) {
    const rendered = step.command.join(' ');
    if (/\bverify:gate-a\b/u.test(rendered) && !/\bverify:gate-a(?:0|-contract)\b/u.test(rendered)) {
      throw new Error(`Gate A aggregate recursion detected in ${step.name}`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(step.runIdSuffix)) {
      throw new Error(`Gate A child run ID suffix is invalid for ${step.name}`);
    }
  }
  return true;
}

function capture(executable, arguments_, cwd = repositoryRoot) {
  const result = spawnSync(executable, arguments_, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/home/gewu',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error(`${executable} ${arguments_.join(' ')} failed while binding Gate A source`);
  }
  return result.stdout;
}

function hashFileSet(root, paths) {
  const digest = createHash('sha256');
  for (const path of [...paths].sort()) {
    const absolute = resolve(root, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Gate A source binding refuses non-file ${absolute}`);
    const bytes = readFileSync(absolute);
    digest.update(`${Buffer.byteLength(path, 'utf8')}:${path}:${String(bytes.byteLength)}:`);
    digest.update(bytes);
  }
  return { sha256: digest.digest('hex'), fileCount: paths.length };
}

function repositoryBinding(root, includeUntracked) {
  const arguments_ = includeUntracked
    ? ['ls-files', '-co', '--exclude-standard', '-z']
    : ['ls-files', '-z'];
  const files = capture('git', arguments_, root).split('\0').filter(Boolean);
  const head = capture('git', ['rev-parse', 'HEAD'], root).trim();
  const trackedStatusSha256 = createHash('sha256').update(
    capture('git', ['status', '--porcelain=v1', '-z', '--untracked-files=no'], root),
  ).digest('hex');
  return { root, head, ...hashFileSet(root, files), trackedStatusSha256 };
}

function collectAuthorityFiles(root) {
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Gate A authority binding refuses symlink ${current}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) pending.push(join(current, entry));
    } else if (stat.isFile()) {
      files.push(relative(root, current));
    }
  }
  return hashFileSet(root, files);
}

function nestedGearJobCommits() {
  const apps = ['frappe', 'erpnext', 'hrms', 'print_designer'];
  return Object.fromEntries(apps.map((app) => {
    const path = `${gearJobRoot}/development/frappe-bench/apps/${app}`;
    return [app, capture('git', ['rev-parse', 'HEAD'], path).trim()];
  }));
}

export function gateASourceBinding() {
  return {
    geneway: repositoryBinding(repositoryRoot, true),
    gearjob: {
      ...repositoryBinding(gearJobRoot, false),
      nestedAppCommits: nestedGearJobCommits(),
    },
    authority: Object.fromEntries(authorityRoots.map((root) => [basename(root), collectAuthorityFiles(root)])),
  };
}

function bindingsMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeRunId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error('GENEWAY_RUN_ID is invalid');
  return value;
}

export function runGateAVerification({
  runId = safeRunId(process.env.GENEWAY_RUN_ID ?? `gate-a-${String(Date.now())}-${String(process.pid)}`),
  steps = requiredGateASteps,
} = {}) {
  safeRunId(runId);
  if (runId.length > 96) throw new Error('GENEWAY_RUN_ID is too long for independent Gate A child run IDs');
  validateGateAStepPlan(steps);
  const outputRoot = `/tmp/geneway-runs/${runId}`;
  const evidenceDirectory = `${outputRoot}/gate-a`;
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputRoot, 0o700);
  chmodSync(evidenceDirectory, 0o700);
  const initialSourceBinding = gateASourceBinding();
  const results = [];
  let failed = null;

  for (const step of steps) {
    const childRunId = safeRunId(`${runId}-${step.runIdSuffix}`);
    const startedAt = new Date().toISOString();
    const result = spawnSync(step.command[0], step.command.slice(1), {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GENEWAY_RUN_ID: childRunId,
        GENEWAY_GATE_A_AGGREGATE_RUN_ID: runId,
      },
      stdio: 'inherit',
    });
    const record = {
      phase: step.phase,
      name: step.name,
      command: commandText(step.command),
      runId: childRunId,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: result.status,
      signal: result.signal,
    };
    results.push(record);
    if (result.error !== undefined || result.status !== 0) {
      failed = { ...record, error: result.error?.message ?? null };
      break;
    }
  }

  const finalSourceBinding = gateASourceBinding();
  const sourceStable = bindingsMatch(initialSourceBinding, finalSourceBinding);
  const passed = failed === null && results.length === steps.length && sourceStable;
  const summary = {
    schemaVersion: 'geneway-gate-a-aggregate/1',
    runId,
    checked: true,
    passed,
    requiredOrder: steps.map((step) => ({ phase: step.phase, name: step.name })),
    results,
    failed,
    sourceStable,
    initialSourceBinding,
    finalSourceBinding,
    conclusion: passed ? 'Gate A ready for trusted-local internal acceptance' : 'Gate A not complete',
  };
  const summaryPath = `${evidenceDirectory}/aggregate.json`;
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (!passed) throw new Error(`geneway Gate A aggregate failed: ${summaryPath}`);
  process.stdout.write(`geneway Gate A aggregate passed: ${summaryPath}\n`);
  return summary;
}

const invokedPath = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) runGateAVerification();
