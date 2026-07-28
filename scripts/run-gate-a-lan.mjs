import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const repositoryRoot = new URL('..', import.meta.url);
const runId = process.env.GENEWAY_RUN_ID ?? `gate-a-lan-${String(Date.now())}-${String(process.pid)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,96}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
if (process.env.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE === undefined
  || process.env.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE === undefined) {
  throw new Error('gate-a:lan requires the authorized provider auth and fresh conformance files');
}
const outputRoot = `/tmp/geneway-runs/${runId}`;
const evidenceDirectory = `${outputRoot}/gate-a`;
mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
chmodSync(outputRoot, 0o700);
chmodSync(evidenceDirectory, 0o700);

function run(name, command, childRunId) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repositoryRoot,
    env: { ...process.env, GENEWAY_RUN_ID: childRunId },
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with exit ${String(result.status ?? 1)}`);
  return { name, command: command.join(' '), runId: childRunId, startedAt, completedAt: new Date().toISOString() };
}

const a0RunId = `${runId}-a0`;
const a3RunId = `${runId}-a3`;
const results = [
  run('shared LAN Fast Chat, context, cancel, and explicit material gate', ['pnpm', 'gate-a0:lan'], a0RunId),
  run('single Work Order served LAN, immutable Evidence, revoke, and zero-write', ['pnpm', 'verify:gate-a3'], a3RunId),
];

const a0 = JSON.parse(readFileSync(`/tmp/geneway-runs/${a0RunId}/gate-a0-lan/browser-db.json`, 'utf8'));
const listeners = JSON.parse(readFileSync(`/tmp/geneway-runs/${a0RunId}/gate-a0-lan/listeners.json`, 'utf8'));
const a3 = JSON.parse(readFileSync(`/tmp/geneway-runs/${a3RunId}/gate-a/served-ui-summary.json`, 'utf8'));
if (a0.schemaVersion !== 'geneway-gate-a0-lan-browser-db/1'
  || a0.contexts !== 2 || a0.sharedPrincipal?.tenantId !== 'tenant_local'
  || a0.sharedPrincipal?.userId !== 'user_local' || a0.canceledByOtherBrowser !== true
  || a0.materialAnalysisVisibleNavigation !== true
  || listeners.schemaVersion !== 'geneway-gate-a0-lan-listeners/1'
  || listeners.wildcardListenerObserved !== false
  || !Array.isArray(listeners.lanHosts) || listeners.lanHosts.length < 1
  || a3.schemaVersion !== 'geneway-gate-a3-served-ui-verification/1'
  || a3.ok !== true || a3.servedUi?.httpAndWebSocketSameOrigin !== true
  || a3.servedUi?.externalRequestCount !== 0 || a3.servedUi?.reloadRecoveredIdenticalTask !== true
  || a3.zeroWrite?.mariaMutatingStatementCount !== 0 || a3.zeroWrite?.redisMutatingCommandCount !== 0
  || a3.sourceRevocation?.appendOnlyRevocationCount !== 1) {
  throw new Error('Gate A actual-LAN receipts are incomplete or failed');
}
const summary = {
  schemaVersion: 'geneway-gate-a-lan-verification/1',
  runId,
  checked: true,
  passed: true,
  sharedTrustModel: {
    tenantId: 'tenant_local',
    userId: 'user_local',
    pairingCodeRequired: false,
    perBrowserPrincipal: false,
  },
  networkBoundary: {
    advertisedLanHostCount: listeners.lanHosts.length,
    wildcardListenerObserved: false,
    internalServicesLoopbackOrUds: true,
    browserExternalRequestCount: 0,
  },
  fastChat: {
    contexts: a0.contexts,
    sharedConversation: true,
    sharedContext: a0.contextMarkerObserved,
    canceledByOtherBrowser: a0.canceledByOtherBrowser,
    materialEntryExplicit: a0.materialAnalysisVisibleNavigation,
  },
  workOrder: {
    servedFromActualLanOrigin: true,
    reloadRecoveredIdenticalTask: a3.servedUi.reloadRecoveredIdenticalTask,
    evidenceRevocationFailClosed: a3.servedUi.sourceRevocationRenderedNotFound,
    mariaMutatingStatementCount: a3.zeroWrite.mariaMutatingStatementCount,
    redisMutatingCommandCount: a3.zeroWrite.redisMutatingCommandCount,
  },
  childRuns: results,
};
writeFileSync(`${evidenceDirectory}/lan-summary.json`, `${JSON.stringify(summary, null, 2)}\n`, {
  flag: 'wx', mode: 0o600,
});
process.stdout.write(`geneway Gate A actual-LAN validation passed: ${evidenceDirectory}/lan-summary.json\n`);
