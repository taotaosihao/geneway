#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const runner = join(scriptDirectory, 'run-backup-restore.mjs');
const cases = [
  { name: 'success', expectedExit: 0, expectedOutcome: 'passed' },
  { name: 'missing-object', expectedExit: 'nonzero', expectedOutcome: 'expected-integrity-failure' },
  { name: 'manifest-mismatch', expectedExit: 'nonzero', expectedOutcome: 'expected-integrity-failure' },
];

function assertClosedGate(receipts, label) {
  const worker = receipts.worker ?? receipts.workerClaim;
  const checks = [receipts.download, receipts.approval, receipts.execute, worker?.claim, worker?.publish];
  if (checks.some((receipt) => receipt?.status !== 503)
    || receipts.download?.code !== 'RESTORE_READ_GATE_ACTIVE'
    || checks.slice(1).some((receipt) => receipt?.code !== 'RESTORE_PLATFORM_GATE_ACTIVE')) {
    throw new Error(`${label} did not fail closed for download/approval/execute/claim/publish: ${JSON.stringify(receipts)}`);
  }
}

async function run(testCase) {
  const runId = `backup-restore-suite-${testCase.name}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [runner, testCase.name], {
      cwd: resolve(scriptDirectory, '..'),
      env: { ...process.env, GENEWAY_RUN_ID: runId },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) => resolveExit(code ?? 1));
  });
  if (testCase.expectedExit === 0 ? exitCode !== 0 : exitCode === 0) {
    throw new Error(`${testCase.name} returned unexpected exit code ${String(exitCode)}`);
  }
  const root = join('/tmp/geneway-runs', runId, 'backup-restore');
  const projectSuffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const summary = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'));
  if (summary.case !== testCase.name || summary.outcome !== testCase.expectedOutcome
    || summary.exitCode !== exitCode || summary.sourceDestroyedBeforeTargetRestore !== true
    || summary.targetDestroyedAfterVerification !== true) {
    throw new Error(`${testCase.name} summary does not prove the expected destructive rehearsal: ${JSON.stringify(summary)}`);
  }
  const boundaryDirectory = join(root, 'process-boundaries');
  const boundaryFiles = (await readdir(boundaryDirectory)).filter((name) => name.endsWith('.json'));
  const boundaries = await Promise.all(boundaryFiles.map(async (name) =>
    JSON.parse(await readFile(join(boundaryDirectory, name), 'utf8'))));
  const requiredRoles = ['coordinator', 'provision', 'online', 'backup', 'worker-command',
    'online-storage', 'control-plane', 'worker', 'worker-network', 'backup-network'];
  if (process.env.GENEWAY_GATE02B_EGRESS_GUARD === 'required') requiredRoles.push('provision-docker');
  if (testCase.name === 'missing-object') requiredRoles.push('oracle');
  const observedRoles = new Set(boundaries.map((receipt) => receipt.role));
  if (boundaries.length === 0 || boundaries.some((receipt) => receipt.checked !== true
    || !Array.isArray(receipt.forbiddenNamesPresent) || receipt.forbiddenNamesPresent.length !== 0)
    || requiredRoles.some((role) => !observedRoles.has(role))) {
    throw new Error(`${testCase.name} lacks clean process-role boundary receipts`);
  }
  const expectedBackupNetworks = new Set(['source', 'target'].map((label) =>
    `geneway-br-${label}-${projectSuffix}_default`));
  const backupContainers = boundaries.filter((receipt) =>
    receipt.schemaVersion === 'geneway-backup-container-boundary/1' && receipt.role === 'backup');
  if (backupContainers.length === 0 || backupContainers.some((receipt) =>
    !expectedBackupNetworks.has(receipt.networkMode) || receipt.networkMode === 'host')) {
    throw new Error(`${testCase.name} ran a backup role outside its PostgreSQL/S3-only data network`);
  }
  const backupNetworkProofs = boundaries.filter((receipt) =>
    receipt.schemaVersion === 'geneway-backup-online-route-boundary/1');
  if (backupNetworkProofs.length !== 2
    || new Set(backupNetworkProofs.map((receipt) => receipt.stack)).size !== 2
    || backupNetworkProofs.some((receipt) =>
      !expectedBackupNetworks.has(receipt.networkMode)
      || receipt.controlPlaneObservedOnlineByCoordinator !== true
      || receipt.directRouteSucceeded !== false)) {
    throw new Error(`${testCase.name} lacks source/target proof that backup cannot reach an online Control Plane`);
  }
  for (const path of [join('/tmp/gw-br-secrets', projectSuffix), join('/tmp/gw-br-runtime', projectSuffix)]) {
    try {
      await access(path);
      throw new Error(`${testCase.name} retained isolated runtime state at ${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const targetDestruction = JSON.parse(await readFile(join(root, 'target-destruction.json'), 'utf8'));
  const cleanup = JSON.parse(await readFile(join(root, 'process-cleanup.json'), 'utf8'));
  if (targetDestruction.destroyed !== true || targetDestruction.remainingContainerIds.length !== 0
    || targetDestruction.remainingVolumeNames.length !== 0 || targetDestruction.remainingNetworkIds.length !== 0
    || cleanup.clean !== true || cleanup.activeServiceHandles !== 0 || cleanup.activeChildProcesses !== 0
    || cleanup.residualRoleContainers.length !== 0 || cleanup.problems.length !== 0) {
    throw new Error(`${testCase.name} left process/container/volume/network residue`);
  }
  for (const restoreState of ['restoring', 'verifying']) {
    const gate = JSON.parse(await readFile(join(root, 'verification', `target-${restoreState}-gate.json`), 'utf8'));
    assertClosedGate(gate.receipts, `${testCase.name}/${restoreState}`);
  }
  if (testCase.name === 'success') {
    if (summary.targetIntegrityClean !== true) throw new Error('success did not complete a clean bidirectional scan');
    const open = JSON.parse(await readFile(join(root, 'verification', 'open-served-chain.json'), 'utf8'));
    if (open.claims !== 2 || open.evidence !== 1 || open.lineage < 7) {
      throw new Error(`success lost the served Claim/Evidence/Lineage chain: ${JSON.stringify(open)}`);
    }
  } else {
    if (summary.targetIntegrityClean !== false || summary.error !== `NEGATIVE_CASE_DETECTED:${testCase.name}`) {
      throw new Error(`${testCase.name} was nonzero for the wrong reason: ${JSON.stringify(summary)}`);
    }
    const failedGate = JSON.parse(await readFile(join(root, 'verification', 'target-failed-gate.json'), 'utf8'));
    if (failedGate.status !== 'failed') {
      throw new Error(`${testCase.name} did not remain fail closed: ${JSON.stringify(failedGate)}`);
    }
    assertClosedGate(failedGate, `${testCase.name}/failed`);
    const findingCodes = new Set(summary.integrityFindings.map((finding) => finding.code));
    if (testCase.name === 'missing-object' && !findingCodes.has('PG_OBJECT_MISSING_IN_S3')) {
      throw new Error('missing-object did not prove a PostgreSQL-authoritative object gap');
    }
    if (testCase.name === 'manifest-mismatch'
      && (!findingCodes.has('DB_HASH_MISMATCH') || !findingCodes.has('OBJECT_HASH_MISMATCH'))) {
      throw new Error('manifest-mismatch did not prove both database and object hash divergence');
    }
  }
  return { case: testCase.name, runId, exitCode, outcome: summary.outcome, artifactRoot: root };
}

const results = [];
for (const testCase of cases) results.push(await run(testCase));
process.stdout.write(`${JSON.stringify({ outcome: 'passed', results })}\n`);
