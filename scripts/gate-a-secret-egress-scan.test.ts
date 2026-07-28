import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function createRoot(runId: string): Promise<string> {
  const root = `/tmp/geneway-runs/${runId}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return root;
}

async function createBrowserReceipts(root: string, runId: string): Promise<void> {
  const boundaryDirectory = join(root, 'process-boundaries');
  await mkdir(boundaryDirectory, { recursive: true, mode: 0o700 });
  await chmod(boundaryDirectory, 0o700);
  const raw = 'BROWSER_KERNEL_AND_DENY_RECEIPT\n';
  const guard = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]);
  const guardPath = join(root, 'browser-egress-guard.so');
  const rawPath = join(boundaryDirectory, 'browser-egress.raw');
  await writeFile(guardPath, guard, { mode: 0o555 });
  await chmod(guardPath, 0o555);
  await writeFile(rawPath, raw, { mode: 0o600 });
  await chmod(rawPath, 0o600);
  const ports = Array.from({ length: 15 }, (_, index) => 20_000 + index);
  await writeJson(join(boundaryDirectory, 'browser-egress.json'), {
    schemaVersion: 'geneway-browser-egress-boundary/1', runId, checked: true, passed: true,
    policyHash: 'a'.repeat(64), rawSha256: createHash('sha256').update(raw).digest('hex'),
    guardLibrarySha256: createHash('sha256').update(guard).digest('hex'),
    rawReceipt: rawPath, guardLibrary: guardPath, allowedWebPort: 19_999,
    conformanceRequired: true, conformancePassed: true, forbiddenPorts: ports,
    deniedPorts: [...ports].reverse(), missingDeniedPorts: [], unexpectedAllows: [], unboundEvents: [],
    unknownLines: [], identityConflicts: [],
  });
  await writeJson(join(boundaryDirectory, 'browser-egress-conformance.json'), {
    schemaVersion: 'geneway-gate-a-browser-egress-conformance/1', runId, passed: true,
    allowedWebPort: 19_999, deniedPorts: ports, deniedPortCount: ports.length,
    businessTaskCreated: false, syntheticResponseUsed: false,
  });
  const oracleDirectory = join(root, 'secret-oracles');
  await mkdir(oracleDirectory, { recursive: true, mode: 0o700 });
  await chmod(oracleDirectory, 0o700);
  await writeJson(join(oracleDirectory, 'browser-public-boundary.json'), {
    schemaVersion: 'geneway-browser-secret-oracle/1', checked: true,
    publicResponseAndDomClean: true, browserReconnectFaultInjected: true, canarySha256: 'b'.repeat(64),
  });
}

function zeroWriteReceipt(): Readonly<Record<string, unknown>> {
  const mariaDigest = 'c'.repeat(64);
  const redisState = {
    'gearjob_dev-redis-cache-1': 'd'.repeat(64),
    'gearjob_dev-redis-queue-1': 'e'.repeat(64),
  };
  return {
    mariaMutatingStatementCount: 0,
    mariaSchemaCount: 1,
    mariaStateBeforeSha256: mariaDigest,
    mariaStateAfterSha256: mariaDigest,
    mariaStateUnchanged: true,
    redisMutatingCommandCount: 0,
    redisMutationDelta: {},
    redisStateBeforeSha256: redisState,
    redisStateAfterSha256: redisState,
    redisStateUnchanged: true,
  };
}

type Fixture = Readonly<{
  aggregateRunId: string;
  scanRunId: string;
  roots: readonly string[];
  privateDirectory: string;
  workOrderReceiptPath: string;
}>;

async function createFixture(): Promise<Fixture> {
  const aggregateRoot = await mkdtemp('/tmp/geneway-runs/gate-a-scan-fixture-');
  await chmod(aggregateRoot, 0o700);
  const aggregateRunId = basename(aggregateRoot);
  const ids = {
    preflight: `${aggregateRunId}-v5-preflight`, connector: `${aggregateRunId}-v5-connector`,
    live: `${aggregateRunId}-v6-live`, recovery: `${aggregateRunId}-v7-recovery`,
    lan: `${aggregateRunId}-v7-lan`, scan: `${aggregateRunId}-v7-scan`,
    lanA0: `${aggregateRunId}-v7-lan-a0`, lanA3: `${aggregateRunId}-v7-lan-a3`,
  };
  const roots = await Promise.all(Object.values(ids).map(createRoot));
  const [preflightRoot, connectorRoot, liveRoot, recoveryRoot, lanRoot] = roots;
  if (preflightRoot === undefined || connectorRoot === undefined || liveRoot === undefined
    || recoveryRoot === undefined || lanRoot === undefined) throw new Error('fixture roots are missing');
  for (const root of [preflightRoot, connectorRoot, liveRoot, recoveryRoot, lanRoot]) {
    await mkdir(join(root, 'gate-a'), { recursive: true, mode: 0o700 });
    await chmod(join(root, 'gate-a'), 0o700);
  }

  await writeJson(join(preflightRoot, 'gate-a/gearjob-preflight.json'), {
    schemaVersion: 'geneway-gate-a3-gearjob-preflight-verification/1', runId: ids.preflight, ok: true,
    authority: { approvedPreflightDigest: '1'.repeat(64), internalValidationAdmissionDigest: '2'.repeat(64),
      admissionSignatureVerified: true },
    source: { gearjobCommit: 'a'.repeat(40),
      nestedAppCommits: { frappe: 'b'.repeat(40), erpnext: 'c'.repeat(40), hrms: 'd'.repeat(40),
        print_designer: 'e'.repeat(40) },
      runtimeAuthorityDigest: 'f'.repeat(64), dynamicAuthorityDigest: '0'.repeat(64),
      runtimeImageId: `sha256:${'1'.repeat(64)}` },
    runtime: { exactSignedImage: true, fullVerificationPassed: true, liveVerificationPassed: true,
      exactFourServiceInternalTopology: true, zeroPublishedHostPorts: true },
    credentialBoundary: { serviceCredentialReadByConnectorGatewayOnly: true,
      preflightReceiptContainsCredentialMaterial: false },
  });
  await writeJson(join(connectorRoot, 'gate-a/connector-gateway.json'), {
    schemaVersion: 'geneway-gate-a3-connector-profile-verification/1', runId: ids.connector, ok: true,
    profile: 'gearjob-work-order-status', profileArgumentValidated: true,
    targeted: { exitCode: 0 }, freshRepository: { exitCode: 0 },
  });

  await createBrowserReceipts(liveRoot, ids.live);
  await writeJson(join(liveRoot, 'gate-a/provider-egress-oracle.json'), {
    schemaVersion: 'geneway-gate-a1-provider-egress-oracle/1', runId: ids.live, route: 'model_gateway',
    providerReadiness: { providerManifestDigest: '3'.repeat(64), conformanceDigest: '4'.repeat(64),
      routeProfile: 'codex_subscription_dev' },
    receiver: { kind: 'signed-model-gateway-receipt', invocationCount: 3,
      receiptAttestedCount: 3, uniqueReceiptJtiCount: 3 },
    toolChoiceNoneCount: 3,
    processBoundaries: ['browser', 'control-plane', 'worker', 'model-gateway'].map((role) => ({
      role, checked: true, ready: role === 'browser' ? null : true, forbiddenNamesPresent: [],
    })),
    providerCredentialOutsideBrowserControlPlaneWorker: true,
  });
  const workOrderReceiptPath = join(liveRoot, 'gate-a/work-order-correlation-summary.json');
  await writeJson(workOrderReceiptPath, {
    schemaVersion: 'geneway-gate-a-work-order-correlation/1', runId: ids.live, passed: true,
    task: { id: 'task_fixture_live', workflowVersionId: 'workflow_fixture_live', workflowHash: '7'.repeat(64),
      approvalId: 'approval_fixture_live', approvalSubjectDigest: '8'.repeat(64),
      connectorQuerySpecId: 'query_spec_fixture_live', connectorQuerySpecHash: '9'.repeat(64),
      connectorInvocationId: 'connector_invocation_fixture_live',
      connectorSourceSnapshotId: 'connector_snapshot_fixture_live', modelInvocationId: 'model_fixture_live',
      resultId: 'result_fixture_live', cardHash: 'a'.repeat(64), workflowNodeCount: 6, evidenceCount: 10,
      wholeEvidenceCount: 1, fieldEvidenceCount: 9, resultCount: 1, publicCardEvidenceReferenceCount: 4 },
    receiver: { origin: 'http://127.0.0.1:8100', hostHeader: 'dev.localhost', method: 'GET',
      endpoint: '/api/method/gearjob.api.work_order.get_work_order_status',
      preApprovalRequestCount: 0, exactSuccessfulRequestCount: 1,
      unexpectedRequestCount: 0, redirectCount: 0, responseRefMatched: true },
    connectorEgress: { connectAddress: '127.0.0.1', connectPort: 8100,
      hostHeader: 'dev.localhost', method: 'GET', endpoint: '/api/method/gearjob.api.work_order.get_work_order_status',
      successfulRequestCount: 1, redirectCount: 0, unexpectedRequestCount: 0, exactSingleObjectResponseMatched: true },
    releaseAuthority: { releaseRecordId: 'release_production_work_order_status_v1_internal',
      activeReleaseId: 'release_production_work_order_status_v1_internal', releasePointerVersion: 1,
      approvedPreflightDigest: '1'.repeat(64), taskAuthorityDigest: 'f'.repeat(64),
      currentAuthorityDigest: 'f'.repeat(64), authorityStageId: 'authority_stage_fixture_live',
      authorityStageState: 'internal', authorityPointerVersion: 1 },
    zeroWrite: zeroWriteReceipt(),
    browser: { applicationExternalHttpOrWebSocketRequestCount: 0, kernelGuardRequired: true,
      kernelForbiddenPortProbeCount: 15, secretCanaryAbsent: true,
      internalCredentialOrRouteMaterialAbsent: true, reloadRecoveredIdenticalTask: true },
  });

  await createBrowserReceipts(recoveryRoot, ids.recovery);
  await writeJson(join(recoveryRoot, 'gate-a/recovery-summary.json'), {
    schemaVersion: 'geneway-gate-a-recovery/1', runId: ids.recovery, passed: true,
    firstTask: { id: 'task_fixture_recovery_first', status: 'completed', terminalAuthoritySha256: '5'.repeat(64), publicSnapshotIdentical: true,
      terminalPointerEvidenceIdentical: true, evidenceCount: 10 },
    processRecovery: {
      connectorGateway: { paused: true, resumed: true, initialGeneration: 1, recoveredGeneration: 2 },
      controlPlane: { paused: true, resumed: true, restarted: true, browserFailureObserved: true,
        initialGeneration: 1, recoveredGeneration: 2 },
      worker: { paused: true, resumed: true, restarted: true, initialGeneration: 1, recoveredGeneration: 2,
        initialInstanceId: 'worker-1', recoveredInstanceId: 'worker-2' },
    },
    releaseAuthority: { releaseRecordId: 'release_production_work_order_status_v1_internal',
      activeReleaseId: 'release_production_work_order_status_v1_internal',
      releasePointerVersion: 1, authorityDigest: '6'.repeat(64), currentAuthorityDigest: '6'.repeat(64),
      authorityStageId: 'authority_stage_fixture', authorityStageState: 'internal', authorityPointerVersion: 1,
      secondTaskSameReleaseAndAuthority: true },
    receiver: { origin: 'http://127.0.0.1:8100', hostHeader: 'dev.localhost',
      endpoint: '/api/method/gearjob.api.work_order.get_work_order_status', method: 'GET',
      firstTaskRequestCountBeforeRecovery: 1, firstTaskRequestCountAfterRecovery: 1,
      totalSuccessfulRequestCount: 2, unexpectedRequestCount: 0 },
    zeroWrite: zeroWriteReceipt(),
    secondTask: { id: 'task_fixture_recovery_second', status: 'completed', succeededAfterRecovery: true },
    browser: { sameOriginOnly: true, reconnectFailureObserved: true, secretCanaryAbsent: true,
      internalCredentialOrRouteMaterialAbsent: true },
  });

  await writeJson(join(lanRoot, 'gate-a/lan-summary.json'), {
    schemaVersion: 'geneway-gate-a-lan-verification/1', runId: ids.lan, checked: true, passed: true,
    sharedTrustModel: { tenantId: 'tenant_local', userId: 'user_local', pairingCodeRequired: false,
      perBrowserPrincipal: false },
    networkBoundary: { advertisedLanHostCount: 1, wildcardListenerObserved: false,
      internalServicesLoopbackOrUds: true, browserExternalRequestCount: 0 },
    fastChat: { contexts: 2, sharedConversation: true, sharedContext: true, canceledByOtherBrowser: true,
      materialEntryExplicit: true },
    workOrder: { servedFromActualLanOrigin: true, reloadRecoveredIdenticalTask: true,
      evidenceRevocationFailClosed: true, mariaMutatingStatementCount: 0, redisMutatingCommandCount: 0 },
    childRuns: [
      { name: 'shared LAN Fast Chat, context, cancel, and explicit material gate', runId: ids.lanA0 },
      { name: 'single Work Order served LAN, immutable Evidence, revoke, and zero-write', runId: ids.lanA3 },
    ],
  });

  const privateDirectory = await mkdtemp('/tmp/gw-a3-secret-scan-proof-');
  const privateField = ['access', 'token'].join('_');
  await writeJson(join(privateDirectory, 'connector-service-token'), {
    [privateField]: 'private-temp-secret-content-must-never-be-read',
  });
  return { aggregateRunId, scanRunId: ids.scan, roots: [aggregateRoot, ...roots],
    privateDirectory, workOrderReceiptPath };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await Promise.all([...fixture.roots].reverse().map((root) => rm(root, { recursive: true, force: true })));
  await rm(fixture.privateDirectory, { recursive: true, force: true });
}

async function runScan(fixture: Fixture): Promise<void> {
  await execute(process.execPath, ['scripts/gate-a-secret-egress-scan.mjs'], {
    cwd: repositoryRoot,
    env: { ...process.env, GENEWAY_RUN_ID: fixture.scanRunId,
      GENEWAY_GATE_A_AGGREGATE_RUN_ID: fixture.aggregateRunId },
  });
}

describe('Gate A aggregate secret/egress scan', () => {
  it('validates V5-V7 public receipts without opening private temporary secret files', async () => {
    const fixture = await createFixture();
    try {
      await runScan(fixture);
      const summary = JSON.parse(await readFile(
        `/tmp/geneway-runs/${fixture.scanRunId}/gate-a/secret-egress-scan.json`, 'utf8',
      )) as { passed: boolean; validatedReceipts: unknown[]; privateSecretFilesRead: number };
      expect(summary.passed).toBe(true);
      expect(summary.validatedReceipts.length).toBeGreaterThanOrEqual(9);
      expect(summary.privateSecretFilesRead).toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it('fails closed when public evidence leaks a sensitive authority environment name', async () => {
    const fixture = await createFixture();
    try {
      const receipt = JSON.parse(await readFile(fixture.workOrderReceiptPath, 'utf8')) as Record<string, unknown>;
      const leakedName = ['GENEWAY', 'GEARJOB', 'SERVICE', 'CREDENTIAL', 'FILE'].join('_');
      receipt.publicLeak = leakedName;
      await writeJson(fixture.workOrderReceiptPath, receipt);
      await expect(runScan(fixture)).rejects.toThrow();
    } finally {
      await cleanup(fixture);
    }
  });

  it('fails closed when a required V7 recovery receipt is absent', async () => {
    const fixture = await createFixture();
    try {
      await rm(`/tmp/geneway-runs/${fixture.aggregateRunId}-v7-recovery/gate-a/recovery-summary.json`);
      await expect(runScan(fixture)).rejects.toThrow();
    } finally {
      await cleanup(fixture);
    }
  });

  it('fails closed when V6 Work Order authority is not bound to the V5 approved preflight', async () => {
    const fixture = await createFixture();
    try {
      const receipt = JSON.parse(await readFile(fixture.workOrderReceiptPath, 'utf8')) as Record<string, unknown>;
      const releaseAuthority = receipt.releaseAuthority as Record<string, unknown>;
      releaseAuthority.approvedPreflightDigest = '2'.repeat(64);
      await writeJson(fixture.workOrderReceiptPath, receipt);
      await expect(runScan(fixture)).rejects.toThrow();
    } finally {
      await cleanup(fixture);
    }
  });

  it('fails closed when a GearJob state digest changes despite zero mutation counters', async () => {
    const fixture = await createFixture();
    try {
      const receipt = JSON.parse(await readFile(fixture.workOrderReceiptPath, 'utf8')) as Record<string, unknown>;
      const zeroWrite = receipt.zeroWrite as Record<string, unknown>;
      zeroWrite.mariaStateAfterSha256 = 'd'.repeat(64);
      await writeJson(fixture.workOrderReceiptPath, receipt);
      await expect(runScan(fixture)).rejects.toThrow();
    } finally {
      await cleanup(fixture);
    }
  });

  it.each([
    ['V6 task authority differs from current authority', (receipt: Record<string, unknown>) => {
      const releaseAuthority = receipt.releaseAuthority as Record<string, unknown>;
      releaseAuthority.taskAuthorityDigest = '0'.repeat(64);
    }],
    ['V6 release differs from the authoritative internal release', (receipt: Record<string, unknown>) => {
      const releaseAuthority = receipt.releaseAuthority as Record<string, unknown>;
      releaseAuthority.releaseRecordId = 'release_production_work_order_status_v1_shadow';
    }],
    ['Redis state digest changes despite zero mutation counters', (receipt: Record<string, unknown>) => {
      const zeroWrite = receipt.zeroWrite as Record<string, unknown>;
      const redisAfter = zeroWrite.redisStateAfterSha256 as Record<string, unknown>;
      redisAfter['gearjob_dev-redis-cache-1'] = '0'.repeat(64);
    }],
    ['zero-write unchanged flags are false', (receipt: Record<string, unknown>) => {
      const zeroWrite = receipt.zeroWrite as Record<string, unknown>;
      zeroWrite.mariaStateUnchanged = false;
      zeroWrite.redisStateUnchanged = false;
    }],
  ])('fails closed when %s', async (_label, tamper) => {
    const fixture = await createFixture();
    try {
      const receipt = JSON.parse(await readFile(fixture.workOrderReceiptPath, 'utf8')) as Record<string, unknown>;
      tamper(receipt);
      await writeJson(fixture.workOrderReceiptPath, receipt);
      await expect(runScan(fixture)).rejects.toThrow();
    } finally {
      await cleanup(fixture);
    }
  });

  it('fails closed when a V7 recovery generation is omitted instead of relying on numeric coercion', async () => {
    const fixture = await createFixture();
    try {
      const path = `/tmp/geneway-runs/${fixture.aggregateRunId}-v7-recovery/gate-a/recovery-summary.json`;
      const receipt = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const processRecovery = receipt.processRecovery as Record<string, unknown>;
      const connectorGateway = processRecovery.connectorGateway as Record<string, unknown>;
      delete connectorGateway.recoveredGeneration;
      await writeJson(path, receipt);
      await expect(runScan(fixture)).rejects.toThrow();
    } finally {
      await cleanup(fixture);
    }
  });
});
