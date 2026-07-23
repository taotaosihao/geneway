#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSecureRunDirectories, e2eRunIdentity, gate02bEnvironmentNames } from './e2e-run-identity.mjs';

const requiredCaseIds = [
  'after_intent_commit_before_s3_put',
  'after_s3_put_before_db_finalize',
  'put_response_lost',
  'after_outbox_commit_before_worker_claim',
  'after_inbox_insert_before_step_execution',
  'after_step_side_effect_before_completion',
  'complete_step_ack_lost',
  'after_report_put_before_db_publish',
  'stale_attempt_completion',
  'cancel_vs_publish',
  'sse_snapshot_subscribe_gap',
  'control_plane_restart',
  'worker_restart',
];
const controlPlaneRestartCases = new Set([
  'after_intent_commit_before_s3_put',
  'after_s3_put_before_db_finalize',
  'after_report_put_before_db_publish',
  'control_plane_restart',
]);
const workerRestartCases = new Set([
  'after_outbox_commit_before_worker_claim',
  'after_inbox_insert_before_step_execution',
  'after_step_side_effect_before_completion',
  'stale_attempt_completion',
  'worker_restart',
]);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const requestedRunId = process.env.GENEWAY_RUN_ID ?? `gate0.2a-recovery-${Date.now()}-${randomUUID().slice(0, 8)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(requestedRunId)) throw new Error('GENEWAY_RUN_ID must be a safe path segment');
const e2eArguments = ['--project=gate0.2a-recovery-multiprocess'];
const outputRoot = join('/tmp/geneway-runs', requestedRunId, 'recovery');
const summaryPath = join(outputRoot, 'recovery-summary.json');
const invocationResultPath = join(outputRoot, 'e2e-invocation-result.json');

async function run(command, args, environment = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with code ${String(code)} and signal ${String(signal)}`));
    });
  });
}

async function readJson(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid(),
      `Evidence JSON is not a regular owned 0600 file: ${path}`);
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function processIdentity(receipt, role) {
  assert(receipt?.role === role && receipt?.phase === 'ready' && receipt?.ready === true,
    `${role} process evidence is not a ready process receipt`);
  assert(Number.isSafeInteger(receipt.pid) && typeof receipt.procStartTicks === 'string' && /^\d+$/u.test(receipt.procStartTicks),
    `${role} process evidence has no PID/start ticks`);
  assert(Number.isSafeInteger(receipt.generation) && receipt.generation >= 1, `${role} process evidence has no generation`);
  return `${String(receipt.pid)}:${receipt.procStartTicks}`;
}

function validateCase(item, caseId, servedRunId) {
  assert(item?.schemaVersion === 'geneway-multiprocess-recovery-case/1' && item?.runId === servedRunId,
    `${caseId} has invalid multiprocess evidence metadata`);
  assert(item.caseId === caseId && item.faultTriggered === true && item.fault_triggered === true,
    `${caseId} did not trigger its real fault`);
  assert(item.trigger !== null && typeof item.trigger === 'object', `${caseId} has no trigger evidence`);
  assert(item.entityIds !== null && typeof item.entityIds === 'object' && Object.keys(item.entityIds).length > 0,
    `${caseId} has no entity correlation`);
  const beforeControlPlane = processIdentity(item.processBefore?.controlPlane, 'control-plane');
  const beforeWorker = processIdentity(item.processBefore?.worker, 'worker');
  const afterControlPlane = processIdentity(item.processAfter?.controlPlane, 'control-plane');
  const afterWorker = processIdentity(item.processAfter?.worker, 'worker');
  if (controlPlaneRestartCases.has(caseId)) {
    assert(beforeControlPlane !== afterControlPlane, `${caseId} did not prove a real Control Plane replacement`);
  }
  if (workerRestartCases.has(caseId)) {
    assert(beforeWorker !== afterWorker, `${caseId} did not prove a real Worker replacement`);
  }
  assert(item.final !== null && typeof item.final === 'object', `${caseId} has no final entity counts`);
  assert(Number(item.final.readySnapshots ?? 0) === 1, `${caseId} did not converge to exactly one ready snapshot`);
  assert(Number(item.final.publishedClaims ?? 0) <= 1, `${caseId} produced duplicate published Claims`);
  assert(Number(item.final.reportArtifacts ?? 0) <= 1, `${caseId} produced duplicate report Artifacts`);
  return item;
}

let stage = 'multiprocess-recovery';
try {
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  assertSecureRunDirectories([
    '/tmp/geneway-runs',
    join('/tmp/geneway-runs', requestedRunId),
    outputRoot,
  ]);
  await run('node', ['scripts/check-e2e-authenticity.mjs']);
  await run('node', ['scripts/run-e2e.mjs', ...e2eArguments], {
    GENEWAY_RUN_ID: requestedRunId,
    GENEWAY_E2E_INVOCATION_RESULT_PATH: invocationResultPath,
  });

  stage = 'evidence-validation';
  const invocation = await readJson(invocationResultPath);
  assert(invocation?.schemaVersion === 'geneway-e2e-invocation-result/1'
    && invocation.parentRunId === requestedRunId
    && typeof invocation.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(invocation.runId)
    && invocation.artifactRoot === `/tmp/geneway-runs/${invocation.runId}`
    && JSON.stringify(invocation.forwarded) === JSON.stringify(e2eArguments)
    && JSON.stringify(invocation.selectedProjects) === JSON.stringify(['gate0.2a-recovery-multiprocess'])
    && invocation.status === 0 && invocation.signal === null && invocation.cleanupPassed === true
    && invocation.reportGatePassed === true && invocation.passed === true,
  'E2E invocation result does not bind a passing recovery served run');
  const servedRunId = invocation.runId;
  const servedArtifactRoot = invocation.artifactRoot;
  const gate02bGuarded = gate02bEnvironmentNames.every((name) => process.env[name] !== undefined);
  assert(e2eRunIdentity(requestedRunId, e2eArguments, gate02bGuarded).runId === servedRunId,
    'E2E invocation result does not match the canonical served run identity');
  assertSecureRunDirectories([servedArtifactRoot]);
  const sourceBinding = await readJson(join(servedArtifactRoot, 'source-binding.json'));
  assert(sourceBinding?.runId === servedRunId && sourceBinding.parentRunId === requestedRunId
    && JSON.stringify(sourceBinding.forwarded) === JSON.stringify(e2eArguments)
    && JSON.stringify(sourceBinding.selectedProjects) === JSON.stringify(['gate0.2a-recovery-multiprocess']),
  'E2E source binding does not match the invocation result');
  const casesRoot = join(servedArtifactRoot, 'recovery', 'cases');
  const caseFileNames = (await readdir(casesRoot)).filter((name) => name.endsWith('.json')).sort();
  const expectedFileNames = requiredCaseIds.map((caseId) => `${caseId}.json`).sort();
  assert(JSON.stringify(caseFileNames) === JSON.stringify(expectedFileNames),
    `Recovery case files drifted; expected ${expectedFileNames.join(', ')}, observed ${caseFileNames.join(', ')}`);
  const cases = [];
  for (const caseId of requiredCaseIds) {
    cases.push(validateCase(await readJson(join(casesRoot, `${caseId}.json`)), caseId, servedRunId));
  }

  const cleanupPath = join(servedArtifactRoot, 'worker-authority-cleanup.json');
  const hooksPath = join(servedArtifactRoot, 'process-boundaries', 'e2e-hooks.json');
  const cleanup = await readJson(cleanupPath);
  const hooks = await readJson(hooksPath);
  assert(cleanup.workerReceiptFound === true && cleanup.workerGenerationCount >= 6 && cleanup.workerGenerationsExited === true,
    'Worker generation lifecycle evidence is incomplete');
  assert(cleanup.controlPlaneReceiptFound === true && cleanup.controlPlaneGenerationCount >= 5
    && cleanup.controlPlaneGenerationsExited === true, 'Control Plane generation lifecycle evidence is incomplete');
  assert(cleanup.authorityCleaned === true && cleanup.tokenRemoved === true && cleanup.socketRemoved === true,
    'Worker authority was not fully removed');
  assert(hooks.schemaVersion === 'geneway-e2e-hooks/1' && hooks.runId === servedRunId && Array.isArray(hooks.hooks),
    'Hook supervisor evidence is invalid');

  const observed = cases.map((item) => item.caseId);
  const missingCaseIds = requiredCaseIds.filter((caseId) => !observed.includes(caseId));
  const duplicateCaseIds = requiredCaseIds.filter((caseId) => observed.filter((candidate) => candidate === caseId).length !== 1);
  const untriggeredCaseIds = cases
    .filter((item) => item.faultTriggered !== true || item.fault_triggered !== true)
    .map((item) => item.caseId);
  const summary = {
    schemaVersion: 'geneway-gate0.2a-multiprocess-recovery/1',
    runId: requestedRunId,
    servedRunId,
    servedArtifactRoot,
    invocationResultPath,
    generatedAt: new Date().toISOString(),
    requiredCaseIds,
    cases: cases.map((item) => ({ ...item, fault_triggered: true })),
    missingCaseIds,
    duplicateCaseIds,
    untriggeredCaseIds,
    processEvidence: {
      cleanupPath,
      hooksPath,
      controlPlaneGenerationCount: cleanup.controlPlaneGenerationCount,
      workerGenerationCount: cleanup.workerGenerationCount,
      allGenerationsExited: cleanup.controlPlaneGenerationsExited === true && cleanup.workerGenerationsExited === true,
    },
    passed: missingCaseIds.length === 0 && duplicateCaseIds.length === 0 && untriggeredCaseIds.length === 0,
  };
  assert(summary.passed, 'Multiprocess recovery summary did not pass');
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`geneway Gate 0.2A multiprocess recovery evidence: ${summaryPath}\n`);
} catch (error) {
  const failure = {
    schemaVersion: 'geneway-gate0.2a-multiprocess-recovery/1',
    runId: requestedRunId,
    generatedAt: new Date().toISOString(),
    passed: false,
    failedStage: stage,
    error: error instanceof Error ? error.message : String(error),
  };
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write(`geneway Gate 0.2A recovery failed at ${stage}; evidence: ${summaryPath}\n`);
  throw error;
}
