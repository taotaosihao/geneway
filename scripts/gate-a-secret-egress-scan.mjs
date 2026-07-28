import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/u;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const repositoryRoot = realpathSync(process.cwd());
const runId = process.env.GENEWAY_RUN_ID;
const aggregateRunId = process.env.GENEWAY_GATE_A_AGGREGATE_RUN_ID;
if (runId === undefined || aggregateRunId === undefined || !SAFE_RUN_ID.test(runId)
  || !SAFE_RUN_ID.test(aggregateRunId) || runId !== `${aggregateRunId}-v7-scan`) {
  throw new Error('Gate A secret/egress scan requires the exact aggregate-bound V7 scan run ID');
}

const childRunIds = Object.freeze({
  preflight: `${aggregateRunId}-v5-preflight`,
  connector: `${aggregateRunId}-v5-connector`,
  live: `${aggregateRunId}-v6-live`,
  recovery: `${aggregateRunId}-v7-recovery`,
  lan: `${aggregateRunId}-v7-lan`,
});
if (Object.values(childRunIds).some((value) => !SAFE_RUN_ID.test(value))) {
  throw new Error('Gate A secret/egress scan child run ID is unsafe');
}

const outputRoot = `/tmp/geneway-runs/${runId}`;
const evidenceDirectory = `${outputRoot}/gate-a`;
const sourceCredentialPatterns = [
  /["'](?:access_token|refresh_token|id_token)["']\s*:\s*["'][^"']{8,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /authorization\s*:\s*bearer\s+[A-Za-z0-9._~-]{16,}/iu,
  /geneway-secret-canary-[a-f0-9]{48}/u,
];
const publicEvidencePatterns = [
  ...sourceCredentialPatterns,
  /["'](?:api_key|apiKey|client_secret|clientSecret|password|service_credential|serviceCredential)["']\s*:\s*["'](?!\[REDACTED)[^"']{8,}/u,
  /\/home\/gewu\/\.codex\/auth\.json/u,
  /\/home\/gewu\/work\/gearjob\/development\/frappe-bench\/sites\/dev\.localhost\/private\/geneway-gate-a3(?:\/[^\s"']+)?/u,
  /\/tmp\/(?:gw-(?:a3|mgw|uds)|geneway-dev)-[A-Za-z0-9._-]{4,}(?:\/[^\s"']+)?/u,
  /GENEWAY_(?:CODEX_SUBSCRIPTION_AUTH_FILE|E2E_SECRET_CANARY|WORKER_TOKEN_FILE|MODEL_GATEWAY_(?:SERVICE_TOKEN_FILE|INVOCATION_SECRET_FILE|WORK_ORDER_RECEIPT_SECRET_FILE)|CONNECTOR_GATEWAY_(?:SERVICE_TOKEN_FILE|INVOCATION_SECRET_FILE|RECEIPT_SECRET_FILE|SUPERVISOR_TOKEN_FILE)|GEARJOB_SERVICE_CREDENTIAL_FILE)/u,
];

const report = {
  schemaVersion: 'geneway-gate-a-secret-egress-scan/1',
  runId,
  aggregateRunId,
  checked: true,
  passed: false,
  validatedReceipts: [],
  sourceFilesScanned: 0,
  publicArtifactRootsScanned: 0,
  publicArtifactFilesScanned: 0,
  archiveFilesScanned: 0,
  archiveEntriesScanned: 0,
  textPayloadsScanned: 0,
  binaryPayloadsChecked: 0,
  binaryExclusions: [],
  excludedGuardLibraries: [],
  privateSecretFilesRead: 0,
};

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function ownedRegularFile(path, requiredMode = 0o600) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
    || metadata.nlink !== 1 || (metadata.mode & 0o777) !== requiredMode || realpathSync(path) !== path) {
    throw new Error(`Gate A secret/egress receipt is not an owned regular ${requiredMode.toString(8)} file: ${path}`);
  }
  return metadata;
}

function secureRunRoot(childRunId) {
  const root = `/tmp/geneway-runs/${childRunId}`;
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
    || (metadata.mode & 0o777) !== 0o700 || realpathSync(root) !== root) {
    throw new Error(`Gate A public evidence root is unsafe: ${root}`);
  }
  return root;
}

function readJsonReceipt(path, expectedRunId, schemaVersion) {
  const metadata = ownedRegularFile(path);
  if (metadata.size === 0 || metadata.size > MAX_FILE_BYTES) throw new Error(`Gate A receipt size is invalid: ${path}`);
  const value = object(JSON.parse(readFileSync(path, 'utf8')), path);
  if (value.schemaVersion !== schemaVersion || value.runId !== expectedRunId) {
    throw new Error(`Gate A receipt schema or run binding is invalid: ${path}`);
  }
  report.validatedReceipts.push(relative('/tmp/geneway-runs', path));
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is not sha256`);
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) throw new Error(`${label} is not a safe identifier`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is not a positive integer`);
}

function validateZeroWrite(value, label) {
  const zeroWrite = object(value, label);
  const redisMutationDelta = object(zeroWrite.redisMutationDelta, `${label} Redis mutation delta`);
  const redisBefore = object(zeroWrite.redisStateBeforeSha256, `${label} Redis state before`);
  const redisAfter = object(zeroWrite.redisStateAfterSha256, `${label} Redis state after`);
  const expectedRedisContainers = ['gearjob_dev-redis-cache-1', 'gearjob_dev-redis-queue-1'];
  if (JSON.stringify(Object.keys(redisBefore).sort()) !== JSON.stringify(expectedRedisContainers)
    || JSON.stringify(Object.keys(redisAfter).sort()) !== JSON.stringify(expectedRedisContainers)) {
    throw new Error(`${label} Redis state container coverage is incomplete`);
  }
  assertSha256(zeroWrite.mariaStateBeforeSha256, `${label} MariaDB state before`);
  assertSha256(zeroWrite.mariaStateAfterSha256, `${label} MariaDB state after`);
  assertPositiveInteger(zeroWrite.mariaSchemaCount, `${label} MariaDB schema count`);
  for (const container of expectedRedisContainers) {
    assertSha256(redisBefore[container], `${label} ${container} state before`);
    assertSha256(redisAfter[container], `${label} ${container} state after`);
  }
  if (zeroWrite.mariaMutatingStatementCount !== 0 || zeroWrite.mariaStateUnchanged !== true
    || zeroWrite.mariaStateBeforeSha256 !== zeroWrite.mariaStateAfterSha256
    || zeroWrite.redisMutatingCommandCount !== 0 || Object.keys(redisMutationDelta).length !== 0
    || zeroWrite.redisStateUnchanged !== true
    || expectedRedisContainers.some((container) => redisBefore[container] !== redisAfter[container])) {
    throw new Error(`${label} did not prove GearJob MariaDB and Redis zero-write state`);
  }
  return zeroWrite;
}

function validateV5() {
  const preflightRoot = secureRunRoot(childRunIds.preflight);
  const preflight = readJsonReceipt(join(preflightRoot, 'gate-a/gearjob-preflight.json'), childRunIds.preflight,
    'geneway-gate-a3-gearjob-preflight-verification/1');
  const authority = object(preflight.authority, 'V5 preflight authority');
  const source = object(preflight.source, 'V5 preflight source');
  const nestedAppCommits = object(source.nestedAppCommits, 'V5 nested GearJob app commits');
  const runtime = object(preflight.runtime, 'V5 preflight runtime');
  const boundary = object(preflight.credentialBoundary, 'V5 preflight credential boundary');
  assertSha256(authority.approvedPreflightDigest, 'V5 approved preflight digest');
  assertSha256(authority.internalValidationAdmissionDigest, 'V5 internal admission digest');
  assertSha256(source.runtimeAuthorityDigest, 'V5 runtime authority digest');
  assertSha256(source.dynamicAuthorityDigest, 'V5 dynamic authority digest');
  if (preflight.ok !== true || authority.admissionSignatureVerified !== true
    || typeof source.gearjobCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(source.gearjobCommit)
    || JSON.stringify(Object.keys(nestedAppCommits).sort()) !== JSON.stringify(['erpnext', 'frappe', 'hrms', 'print_designer'])
    || Object.values(nestedAppCommits).some((commit) => typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit))
    || typeof source.runtimeImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(source.runtimeImageId)
    || runtime.exactSignedImage !== true || runtime.fullVerificationPassed !== true
    || runtime.liveVerificationPassed !== true || runtime.exactFourServiceInternalTopology !== true
    || runtime.zeroPublishedHostPorts !== true || boundary.serviceCredentialReadByConnectorGatewayOnly !== true
    || boundary.preflightReceiptContainsCredentialMaterial !== false) {
    throw new Error('Gate A V5 preflight receipt is incomplete or failed');
  }

  const connectorRoot = secureRunRoot(childRunIds.connector);
  const connector = readJsonReceipt(join(connectorRoot, 'gate-a/connector-gateway.json'), childRunIds.connector,
    'geneway-gate-a3-connector-profile-verification/1');
  const targeted = object(connector.targeted, 'V5 connector targeted result');
  const freshRepository = object(connector.freshRepository, 'V5 connector fresh repository result');
  if (connector.ok !== true || connector.profile !== 'gearjob-work-order-status'
    || connector.profileArgumentValidated !== true || targeted.exitCode !== 0 || freshRepository.exitCode !== 0) {
    throw new Error('Gate A V5 Connector Gateway receipt is incomplete or failed');
  }
  return { roots: [preflightRoot, connectorRoot], approvedPreflightDigest: authority.approvedPreflightDigest };
}

function validateBrowserKernel(root, expectedRunId) {
  const boundary = readJsonReceipt(join(root, 'process-boundaries/browser-egress.json'), expectedRunId,
    'geneway-browser-egress-boundary/1');
  const conformance = readJsonReceipt(join(root, 'process-boundaries/browser-egress-conformance.json'), expectedRunId,
    'geneway-gate-a-browser-egress-conformance/1');
  assertSha256(boundary.policyHash, 'browser egress policy hash');
  assertSha256(boundary.rawSha256, 'browser egress raw receipt hash');
  assertSha256(boundary.guardLibrarySha256, 'browser egress guard hash');
  assertPositiveInteger(boundary.allowedWebPort, 'browser egress allowed Web port');
  const sameNumberSet = (left, right) => Array.isArray(left) && Array.isArray(right)
    && JSON.stringify([...new Set(left)].sort((a, b) => a - b))
      === JSON.stringify([...new Set(right)].sort((a, b) => a - b));
  if (boundary.checked !== true || boundary.passed !== true || boundary.conformanceRequired !== true
    || boundary.conformancePassed !== true || boundary.missingDeniedPorts?.length !== 0
    || boundary.unexpectedAllows?.length !== 0 || boundary.unboundEvents?.length !== 0
    || boundary.unknownLines?.length !== 0 || boundary.identityConflicts?.length !== 0
    || !Array.isArray(boundary.forbiddenPorts) || boundary.forbiddenPorts.length < 10
    || boundary.forbiddenPorts.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)
    || new Set(boundary.forbiddenPorts).size !== boundary.forbiddenPorts.length
    || !Array.isArray(boundary.deniedPorts)
    || boundary.deniedPorts.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)
    || !sameNumberSet(boundary.deniedPorts, boundary.forbiddenPorts)
    || conformance.passed !== true || conformance.businessTaskCreated !== false
    || conformance.syntheticResponseUsed !== false
    || conformance.allowedWebPort !== boundary.allowedWebPort
    || !sameNumberSet(conformance.deniedPorts, boundary.forbiddenPorts)
    || !Number.isSafeInteger(conformance.deniedPortCount)
    || conformance.deniedPortCount !== boundary.forbiddenPorts.length) {
    throw new Error(`Gate A browser kernel conformance receipt failed for ${expectedRunId}`);
  }
  const rawPath = join(root, 'process-boundaries/browser-egress.raw');
  if (boundary.rawReceipt !== rawPath) throw new Error('Gate A browser raw receipt path is not run-bound');
  ownedRegularFile(rawPath);
  if (createHash('sha256').update(readFileSync(rawPath)).digest('hex') !== boundary.rawSha256) {
    throw new Error('Gate A browser raw receipt digest changed');
  }
  const guardPath = join(root, 'browser-egress-guard.so');
  if (boundary.guardLibrary !== guardPath) throw new Error('Gate A browser guard path is not run-bound');
  const guardMetadata = ownedRegularFile(guardPath, 0o555);
  if (guardMetadata.size === 0
    || createHash('sha256').update(readFileSync(guardPath)).digest('hex') !== boundary.guardLibrarySha256) {
    throw new Error('Gate A browser guard digest changed');
  }
  report.excludedGuardLibraries.push(relative('/tmp/geneway-runs', guardPath));
  return guardPath;
}

function validateV6(expectedPreflightDigest) {
  const root = secureRunRoot(childRunIds.live);
  const provider = readJsonReceipt(join(root, 'gate-a/provider-egress-oracle.json'), childRunIds.live,
    'geneway-gate-a1-provider-egress-oracle/1');
  const readiness = object(provider.providerReadiness, 'V6 provider readiness');
  const receiver = object(provider.receiver, 'V6 provider receiver');
  assertSha256(readiness.providerManifestDigest, 'V6 provider manifest digest');
  assertSha256(readiness.conformanceDigest, 'V6 provider conformance digest');
  const processRoles = Array.isArray(provider.processBoundaries)
    ? provider.processBoundaries.map((entry) => entry?.role).sort() : [];
  if (provider.route !== 'model_gateway' || readiness.routeProfile !== 'codex_subscription_dev'
    || provider.providerCredentialOutsideBrowserControlPlaneWorker !== true
    || receiver.kind !== 'signed-model-gateway-receipt' || !Number.isInteger(receiver.invocationCount)
    || receiver.invocationCount < 1 || receiver.receiptAttestedCount !== receiver.invocationCount
    || receiver.uniqueReceiptJtiCount !== receiver.invocationCount
    || provider.toolChoiceNoneCount !== receiver.invocationCount
    || !Array.isArray(provider.processBoundaries) || provider.processBoundaries.length !== 4
    || JSON.stringify(processRoles) !== JSON.stringify(['browser', 'control-plane', 'model-gateway', 'worker'])
    || provider.processBoundaries.some((entry) => entry.checked !== true
      || entry.forbiddenNamesPresent?.length !== 0 || (entry.role !== 'browser' && entry.ready !== true))) {
    throw new Error('Gate A V6 provider egress receipt is incomplete or failed');
  }

  const workOrder = readJsonReceipt(join(root, 'gate-a/work-order-correlation-summary.json'), childRunIds.live,
    'geneway-gate-a-work-order-correlation/1');
  const task = object(workOrder.task, 'V6 Work Order task');
  const gearJobReceiver = object(workOrder.receiver, 'V6 GearJob receiver');
  const connectorEgress = object(workOrder.connectorEgress, 'V6 connector egress');
  const release = object(workOrder.releaseAuthority, 'V6 release authority');
  validateZeroWrite(workOrder.zeroWrite, 'V6 GearJob zero-write');
  const browser = object(workOrder.browser, 'V6 Work Order browser');
  for (const [value, label] of [
    [task.id, 'V6 task ID'],
    [task.workflowVersionId, 'V6 WorkflowVersion ID'],
    [task.approvalId, 'V6 Approval ID'],
    [task.connectorQuerySpecId, 'V6 ConnectorQuerySpec ID'],
    [task.connectorInvocationId, 'V6 ConnectorInvocation ID'],
    [task.connectorSourceSnapshotId, 'V6 ConnectorSourceSnapshot ID'],
    [task.modelInvocationId, 'V6 ModelInvocation ID'],
    [task.resultId, 'V6 result ID'],
    [release.releaseRecordId, 'V6 release record ID'],
    [release.activeReleaseId, 'V6 active release ID'],
    [release.authorityStageId, 'V6 authority stage ID'],
  ]) assertIdentifier(value, label);
  for (const [value, label] of [
    [task.workflowHash, 'V6 Workflow hash'],
    [task.approvalSubjectDigest, 'V6 Approval subject digest'],
    [task.connectorQuerySpecHash, 'V6 ConnectorQuerySpec hash'],
    [task.cardHash, 'V6 Work Order card hash'],
    [release.approvedPreflightDigest, 'V6 approved preflight digest'],
    [release.taskAuthorityDigest, 'V6 task authority digest'],
    [release.currentAuthorityDigest, 'V6 current authority digest'],
  ]) assertSha256(value, label);
  assertPositiveInteger(release.releasePointerVersion, 'V6 release pointer version');
  assertPositiveInteger(release.authorityPointerVersion, 'V6 authority pointer version');
  if (workOrder.passed !== true || task.workflowNodeCount !== 6 || task.evidenceCount !== 10
    || task.wholeEvidenceCount !== 1 || task.fieldEvidenceCount !== 9 || task.resultCount !== 1
    || task.publicCardEvidenceReferenceCount !== 4
    || gearJobReceiver.origin !== 'http://127.0.0.1:8100' || gearJobReceiver.hostHeader !== 'dev.localhost'
    || gearJobReceiver.endpoint !== '/api/method/gearjob.api.work_order.get_work_order_status'
    || gearJobReceiver.method !== 'GET' || gearJobReceiver.preApprovalRequestCount !== 0
    || gearJobReceiver.exactSuccessfulRequestCount !== 1
    || gearJobReceiver.unexpectedRequestCount !== 0 || gearJobReceiver.redirectCount !== 0
    || gearJobReceiver.responseRefMatched !== true || connectorEgress.connectAddress !== '127.0.0.1'
    || connectorEgress.connectPort !== 8100 || connectorEgress.hostHeader !== 'dev.localhost'
    || connectorEgress.method !== 'GET'
    || connectorEgress.endpoint !== '/api/method/gearjob.api.work_order.get_work_order_status'
    || connectorEgress.successfulRequestCount !== 1 || connectorEgress.redirectCount !== 0
    || connectorEgress.unexpectedRequestCount !== 0 || connectorEgress.exactSingleObjectResponseMatched !== true
    || release.releaseRecordId !== 'release_production_work_order_status_v1_internal'
    || release.releaseRecordId !== release.activeReleaseId || release.authorityStageState !== 'internal'
    || release.taskAuthorityDigest !== release.currentAuthorityDigest
    || release.approvedPreflightDigest !== expectedPreflightDigest
    || browser.applicationExternalHttpOrWebSocketRequestCount !== 0
    || browser.kernelGuardRequired !== true || !Number.isSafeInteger(browser.kernelForbiddenPortProbeCount)
    || browser.kernelForbiddenPortProbeCount < 10
    || browser.secretCanaryAbsent !== true || browser.internalCredentialOrRouteMaterialAbsent !== true
    || browser.reloadRecoveredIdenticalTask !== true) {
    throw new Error('Gate A V6 Work Order correlation or GearJob zero-write receipt failed');
  }
  const guardPath = validateBrowserKernel(root, childRunIds.live);
  return { roots: [root], guardPaths: [guardPath] };
}

function validateV7() {
  const recoveryRoot = secureRunRoot(childRunIds.recovery);
  const recovery = readJsonReceipt(join(recoveryRoot, 'gate-a/recovery-summary.json'), childRunIds.recovery,
    'geneway-gate-a-recovery/1');
  const firstTask = object(recovery.firstTask, 'V7 recovery first task');
  const processes = object(recovery.processRecovery, 'V7 process recovery');
  const connector = object(processes.connectorGateway, 'V7 Connector recovery');
  const controlPlane = object(processes.controlPlane, 'V7 Control Plane recovery');
  const worker = object(processes.worker, 'V7 Worker recovery');
  const release = object(recovery.releaseAuthority, 'V7 release authority');
  const receiver = object(recovery.receiver, 'V7 recovery receiver');
  validateZeroWrite(recovery.zeroWrite, 'V7 recovery zero-write');
  const secondTask = object(recovery.secondTask, 'V7 recovery second task');
  const browser = object(recovery.browser, 'V7 recovery browser');
  assertSha256(firstTask.terminalAuthoritySha256, 'V7 terminal authority digest');
  assertSha256(release.authorityDigest, 'V7 task authority digest');
  assertSha256(release.currentAuthorityDigest, 'V7 current authority digest');
  for (const [value, label] of [
    [firstTask.id, 'V7 first task ID'],
    [secondTask.id, 'V7 second task ID'],
    [release.releaseRecordId, 'V7 release record ID'],
    [release.activeReleaseId, 'V7 active release ID'],
    [release.authorityStageId, 'V7 authority stage ID'],
    [worker.initialInstanceId, 'V7 initial Worker instance ID'],
    [worker.recoveredInstanceId, 'V7 recovered Worker instance ID'],
  ]) assertIdentifier(value, label);
  for (const [value, label] of [
    [connector.initialGeneration, 'V7 initial Connector generation'],
    [connector.recoveredGeneration, 'V7 recovered Connector generation'],
    [controlPlane.initialGeneration, 'V7 initial Control Plane generation'],
    [controlPlane.recoveredGeneration, 'V7 recovered Control Plane generation'],
    [worker.initialGeneration, 'V7 initial Worker generation'],
    [worker.recoveredGeneration, 'V7 recovered Worker generation'],
    [release.releasePointerVersion, 'V7 release pointer version'],
    [release.authorityPointerVersion, 'V7 authority pointer version'],
  ]) assertPositiveInteger(value, label);
  if (recovery.passed !== true || firstTask.status !== 'completed' || firstTask.publicSnapshotIdentical !== true
    || firstTask.terminalPointerEvidenceIdentical !== true || firstTask.evidenceCount !== 10
    || connector.paused !== true || connector.resumed !== true
    || connector.recoveredGeneration <= connector.initialGeneration
    || controlPlane.paused !== true || controlPlane.resumed !== true || controlPlane.restarted !== true
    || controlPlane.browserFailureObserved !== true
    || controlPlane.recoveredGeneration <= controlPlane.initialGeneration
    || worker.paused !== true || worker.resumed !== true || worker.restarted !== true
    || worker.recoveredGeneration <= worker.initialGeneration
    || worker.recoveredInstanceId === worker.initialInstanceId || secondTask.id === firstTask.id
    || release.releaseRecordId !== 'release_production_work_order_status_v1_internal'
    || release.releaseRecordId !== release.activeReleaseId || release.authorityStageState !== 'internal'
    || release.authorityDigest !== release.currentAuthorityDigest
    || release.secondTaskSameReleaseAndAuthority !== true
    || receiver.origin !== 'http://127.0.0.1:8100' || receiver.hostHeader !== 'dev.localhost'
    || receiver.endpoint !== '/api/method/gearjob.api.work_order.get_work_order_status'
    || receiver.method !== 'GET'
    || receiver.firstTaskRequestCountBeforeRecovery !== 1 || receiver.firstTaskRequestCountAfterRecovery !== 1
    || receiver.totalSuccessfulRequestCount !== 2 || receiver.unexpectedRequestCount !== 0
    || secondTask.status !== 'completed' || secondTask.succeededAfterRecovery !== true
    || browser.sameOriginOnly !== true || browser.reconnectFailureObserved !== true
    || browser.secretCanaryAbsent !== true || browser.internalCredentialOrRouteMaterialAbsent !== true) {
    throw new Error('Gate A V7 recovery receipt is incomplete or failed');
  }
  const guardPath = validateBrowserKernel(recoveryRoot, childRunIds.recovery);

  const lanRoot = secureRunRoot(childRunIds.lan);
  const lan = readJsonReceipt(join(lanRoot, 'gate-a/lan-summary.json'), childRunIds.lan,
    'geneway-gate-a-lan-verification/1');
  const trust = object(lan.sharedTrustModel, 'V7 LAN trust model');
  const network = object(lan.networkBoundary, 'V7 LAN network boundary');
  const fastChat = object(lan.fastChat, 'V7 LAN Fast Chat');
  const workOrder = object(lan.workOrder, 'V7 LAN Work Order');
  assertPositiveInteger(network.advertisedLanHostCount, 'V7 advertised LAN host count');
  if (lan.checked !== true || lan.passed !== true || trust.tenantId !== 'tenant_local'
    || trust.userId !== 'user_local' || trust.pairingCodeRequired !== false
    || trust.perBrowserPrincipal !== false
    || network.wildcardListenerObserved !== false || network.internalServicesLoopbackOrUds !== true
    || network.browserExternalRequestCount !== 0 || fastChat.contexts !== 2 || fastChat.sharedConversation !== true
    || fastChat.sharedContext !== true || fastChat.canceledByOtherBrowser !== true
    || fastChat.materialEntryExplicit !== true || workOrder.servedFromActualLanOrigin !== true
    || workOrder.reloadRecoveredIdenticalTask !== true || workOrder.evidenceRevocationFailClosed !== true
    || workOrder.mariaMutatingStatementCount !== 0 || workOrder.redisMutatingCommandCount !== 0
    || !Array.isArray(lan.childRuns) || lan.childRuns.length !== 2) {
    throw new Error('Gate A V7 LAN receipt is incomplete or failed');
  }
  const expectedLanChildren = new Map([
    ['shared LAN Fast Chat, context, cancel, and explicit material gate', `${childRunIds.lan}-a0`],
    ['single Work Order served LAN, immutable Evidence, revoke, and zero-write', `${childRunIds.lan}-a3`],
  ]);
  const childRoots = lan.childRuns.map((child, index) => {
    const value = object(child, `V7 LAN child ${String(index)}`);
    const expectedChildRunId = expectedLanChildren.get(value.name);
    if (typeof value.runId !== 'string' || !SAFE_RUN_ID.test(value.runId)
      || !value.runId.startsWith(`${childRunIds.lan}-`) || value.runId !== expectedChildRunId) {
      throw new Error('Gate A V7 LAN child run binding is invalid');
    }
    expectedLanChildren.delete(value.name);
    return secureRunRoot(value.runId);
  });
  if (expectedLanChildren.size !== 0) throw new Error('Gate A V7 LAN child role coverage is incomplete');
  return { roots: [recoveryRoot, lanRoot, ...childRoots], guardPaths: [guardPath] };
}

function assertNoPatterns(bytes, label, patterns) {
  const text = bytes.toString('utf8');
  for (const pattern of patterns) {
    if (pattern.test(text)) throw new Error(`Gate A secret/egress scan found forbidden material in ${label}`);
  }
}

function binaryKind(bytes, label) {
  const extension = extname(label).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.webm', '.mp4', '.woff', '.woff2', '.pdf'].includes(extension)) {
    return extension.slice(1);
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if (bytes.subarray(0, 4).toString('ascii') === 'wOFF' || bytes.subarray(0, 4).toString('ascii') === 'wOF2') return 'font';
  if (bytes.byteLength >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (bytes.subarray(0, 4).toString('binary') === 'PK\u0003\u0004') return 'nested-zip';
  return null;
}

function validPublicBoundaryOracle(root) {
  try {
    const path = join(root, 'secret-oracles/browser-public-boundary.json');
    ownedRegularFile(path);
    const oracle = object(JSON.parse(readFileSync(path, 'utf8')), path);
    return oracle.schemaVersion === 'geneway-browser-secret-oracle/1'
      && oracle.checked === true && oracle.publicResponseAndDomClean === true
      && oracle.browserReconnectFaultInjected === true
      && typeof oracle.canarySha256 === 'string' && /^[a-f0-9]{64}$/u.test(oracle.canarySha256);
  } catch { /* Fall through to the served LAN Work Order boundary. */ }
  try {
    const path = join(root, 'gate-a/served-ui-summary.json');
    ownedRegularFile(path);
    const summary = object(JSON.parse(readFileSync(path, 'utf8')), path);
    const servedUi = object(summary.servedUi, `${path}.servedUi`);
    return summary.schemaVersion === 'geneway-gate-a3-served-ui-verification/1' && summary.ok === true
      && servedUi.httpAndWebSocketSameOrigin === true && servedUi.externalRequestCount === 0
      && servedUi.sensitiveDomFindingCount === 0 && servedUi.reloadRecoveredIdenticalTask === true;
  } catch {
    return false;
  }
}

function scanPayload(bytes, label, patterns, boundary, root) {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`Gate A secret scan refuses oversized payload ${label}`);
  assertNoPatterns(bytes, label, patterns);
  const kind = binaryKind(bytes, label);
  let validUtf8Text = false;
  try {
    validUtf8Text = !utf8Decoder.decode(bytes).includes('\0');
  } catch { /* Non-UTF-8 payloads must satisfy a known binary boundary below. */ }
  if (kind === null && validUtf8Text) {
    report.textPayloadsScanned += 1;
    return;
  }
  if (kind === null) throw new Error(`Gate A secret scan cannot safely classify binary public evidence ${label}`);
  if (kind === 'nested-zip') throw new Error(`Gate A secret scan refuses nested public evidence archive ${label}`);
  report.binaryPayloadsChecked += 1;
  if (boundary === 'artifact') {
    if (!validPublicBoundaryOracle(root)) {
      throw new Error(`Gate A binary public evidence lacks a run-bound browser public-boundary oracle: ${label}`);
    }
    report.binaryExclusions.push({ label: relative('/tmp/geneway-runs', label), kind,
      equivalentOracle: 'run-bound-browser-public-boundary-canary' });
  }
}

function scanZip(path, root) {
  const listing = spawnSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (listing.status !== 0 || typeof listing.stdout !== 'string') {
    throw new Error(`Gate A secret scan could not enumerate archive ${path}`);
  }
  const entries = listing.stdout.split('\n').filter(Boolean);
  if (entries.length === 0 || entries.length > 20_000) throw new Error(`Gate A archive entry count is invalid: ${path}`);
  report.archiveFilesScanned += 1;
  for (const entry of entries) {
    if (entry.endsWith('/')) continue;
    const components = entry.split('/');
    if (entry.startsWith('/') || entry.startsWith('-') || components.includes('..') || entry.includes('\0')) {
      throw new Error(`Gate A secret scan rejected unsafe archive entry ${entry}`);
    }
    const extracted = spawnSync('unzip', ['-p', path, entry], { encoding: 'buffer', maxBuffer: MAX_FILE_BYTES + 1 });
    if (extracted.status !== 0 || !Buffer.isBuffer(extracted.stdout)) {
      throw new Error(`Gate A secret scan could not read archive entry ${path}#${entry}`);
    }
    report.archiveEntriesScanned += 1;
    scanPayload(extracted.stdout, `${path}#${entry}`, publicEvidencePatterns, 'artifact', root);
  }
}

function scanArtifactRoot(root, excludedFiles) {
  const rootDevice = lstatSync(root).dev;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`Gate A secret scan refuses public evidence symlink ${current}`);
    if (metadata.isDirectory()) {
      if (metadata.uid !== process.getuid() || metadata.dev !== rootDevice || (metadata.mode & 0o022) !== 0
        || realpathSync(current) !== current) {
        throw new Error(`Gate A public evidence directory is unsafe: ${current}`);
      }
      for (const entry of readdirSync(current)) pending.push(join(current, entry));
      continue;
    }
    if (!metadata.isFile() || excludedFiles.has(current)
      || current === join(evidenceDirectory, 'secret-egress-scan.json')) continue;
    if (metadata.uid !== process.getuid() || metadata.dev !== rootDevice || metadata.nlink !== 1
      || (metadata.mode & 0o022) !== 0 || realpathSync(current) !== current) {
      throw new Error(`Gate A public evidence file is unsafe: ${current}`);
    }
    if (metadata.size > MAX_FILE_BYTES) throw new Error(`Gate A public evidence file is oversized: ${current}`);
    report.publicArtifactFilesScanned += 1;
    const bytes = readFileSync(current);
    const isZip = current.toLowerCase().endsWith('.zip') || bytes.subarray(0, 4).toString('binary') === 'PK\u0003\u0004';
    if (isZip) scanZip(current, root);
    else scanPayload(bytes, current, publicEvidencePatterns, 'artifact', root);
  }
  report.publicArtifactRootsScanned += 1;
}

const sourceCandidates = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
  cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
}).split('\0').filter(Boolean);
for (const path of sourceCandidates) {
  const absolute = resolve(repositoryRoot, path);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink()) throw new Error(`Gate A secret scan refuses candidate source symlink ${path}`);
  if (!metadata.isFile()) continue;
  if (!absolute.startsWith(`${repositoryRoot}/`) || metadata.nlink !== 1 || realpathSync(absolute) !== absolute) {
    throw new Error(`Gate A secret scan refuses unsafe candidate source file ${path}`);
  }
  if (metadata.size > MAX_FILE_BYTES) throw new Error(`Gate A candidate source is oversized: ${path}`);
  scanPayload(readFileSync(absolute), path, sourceCredentialPatterns, 'source', repositoryRoot);
  report.sourceFilesScanned += 1;
}

const v5 = validateV5();
const roots = [...v5.roots];
const v6 = validateV6(v5.approvedPreflightDigest);
const v7 = validateV7();
roots.push(...v6.roots, ...v7.roots);
const excludedFiles = new Set([...v6.guardPaths, ...v7.guardPaths]);
for (const root of new Set(roots)) scanArtifactRoot(root, excludedFiles);

mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
chmodSync(outputRoot, 0o700);
chmodSync(evidenceDirectory, 0o700);
report.passed = true;
writeFileSync(join(evidenceDirectory, 'secret-egress-scan.json'), `${JSON.stringify(report, null, 2)}\n`, {
  flag: 'wx', mode: 0o600,
});
process.stdout.write(`geneway Gate A secret/egress scan passed: ${evidenceDirectory}; receipts=${String(report.validatedReceipts.length)}, publicFiles=${String(report.publicArtifactFilesScanned)}, sourceFiles=${String(report.sourceFilesScanned)}\n`);
