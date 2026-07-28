import { WorkerCommandClient, readWorkerToken } from './command-client.js';
import { ChatRuntimeAdapter, parseE2eHookEndpoint, postE2eHook } from '@geneway/runtime';
import { ChatWorkerCommandClient } from './chat-command-client.js';
import {
  GateAAnalysisRuntimeAdapter,
  GateAAnalysisWorkerCommandClient,
} from './gate-a-live-runtime.js';
import {
  GateA3ConnectorRuntimeAdapter,
  GateA3WorkOrderModelRuntimeAdapter,
  GateA3WorkOrderWorkerCommandClient,
} from './gate-a3-work-order-runtime.js';
import { createWorkerProcessReceipt, readWorkerProcessConfiguration } from './process-receipt.js';
import { runWorkerLoop } from './worker-loop.js';

const configuration = readWorkerProcessConfiguration(process.env);
const processReceipt = await createWorkerProcessReceipt(configuration);
const token = await readWorkerToken(configuration.tokenFile);
const client = new WorkerCommandClient(configuration.socketPath, token, configuration.identity);
const modelGatewayUrl = process.env.GENEWAY_MODEL_GATEWAY_URL;
const modelGatewayServiceTokenFile = process.env.GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE;
if ((modelGatewayUrl === undefined) !== (modelGatewayServiceTokenFile === undefined)) {
  throw new Error('Model Gateway URL and service token file must be configured together');
}
const modelGatewayServiceToken = modelGatewayServiceTokenFile === undefined
  ? undefined : await readWorkerToken(modelGatewayServiceTokenFile);
const chat = modelGatewayUrl === undefined || modelGatewayServiceToken === undefined ? undefined : {
  client: new ChatWorkerCommandClient(configuration.socketPath, token, configuration.identity.workerInstanceId),
  runtime: new ChatRuntimeAdapter(modelGatewayUrl, modelGatewayServiceToken),
};
const gateALiveEnabled = process.env.GENEWAY_GATE_A_LIVE_ENABLED;
if (gateALiveEnabled !== undefined && gateALiveEnabled !== '1') {
  throw new Error('GENEWAY_GATE_A_LIVE_ENABLED must be 1 when configured');
}
const analysis = gateALiveEnabled !== '1' || modelGatewayUrl === undefined || modelGatewayServiceToken === undefined
  ? undefined
  : {
      port: new GateAAnalysisWorkerCommandClient(configuration.socketPath, token, configuration.identity.workerInstanceId),
      runtime: new GateAAnalysisRuntimeAdapter(modelGatewayUrl, modelGatewayServiceToken),
    };
const gateA3WorkOrderEnabled = process.env.GENEWAY_GATE_A3_WORK_ORDER_ENABLED;
if (gateA3WorkOrderEnabled !== undefined && gateA3WorkOrderEnabled !== '1') {
  throw new Error('GENEWAY_GATE_A3_WORK_ORDER_ENABLED must be 1 when configured');
}
const connectorGatewayUrl = process.env.GENEWAY_CONNECTOR_GATEWAY_URL;
const connectorGatewayServiceTokenFile = process.env.GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE;
if ((connectorGatewayUrl === undefined) !== (connectorGatewayServiceTokenFile === undefined)) {
  throw new Error('Connector Gateway URL and service token file must be configured together');
}
const connectorGatewayServiceToken = connectorGatewayServiceTokenFile === undefined
  ? undefined : await readWorkerToken(connectorGatewayServiceTokenFile);
if (gateA3WorkOrderEnabled === '1' && (
  modelGatewayUrl === undefined || modelGatewayServiceToken === undefined
  || connectorGatewayUrl === undefined || connectorGatewayServiceToken === undefined
)) {
  throw new Error('Gate A.3 work-order execution requires both Model and Connector Gateway configuration');
}
const workOrder = gateA3WorkOrderEnabled !== '1'
  || modelGatewayUrl === undefined || modelGatewayServiceToken === undefined
  || connectorGatewayUrl === undefined || connectorGatewayServiceToken === undefined
  ? undefined
  : {
      port: new GateA3WorkOrderWorkerCommandClient(configuration.socketPath, token, configuration.identity.workerInstanceId),
      connectorRuntime: new GateA3ConnectorRuntimeAdapter(connectorGatewayUrl, connectorGatewayServiceToken),
      modelRuntime: new GateA3WorkOrderModelRuntimeAdapter(modelGatewayUrl, modelGatewayServiceToken),
    };
const e2eHookUrl = process.env.GENEWAY_E2E_HOOK_URL;
const e2eHookTokenFile = process.env.GENEWAY_E2E_HOOK_TOKEN_FILE;
if ((e2eHookUrl === undefined) !== (e2eHookTokenFile === undefined)) throw new Error('E2E hook URL and token file must be configured together');
const e2eHookEndpoint = e2eHookUrl === undefined || e2eHookTokenFile === undefined
  ? null
  : parseE2eHookEndpoint({
      url: e2eHookUrl,
      nodeEnvironment: process.env.NODE_ENV,
      tokenFile: e2eHookTokenFile,
      expectedTokenFile: configuration.tokenFile,
    });

async function reachE2eHook(payload: Readonly<Record<string, unknown>>): Promise<void> {
  if (e2eHookEndpoint === null) return;
  await postE2eHook(e2eHookEndpoint, token, payload);
}
const shutdown = new AbortController();
const stop = (): void => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await runWorkerLoop(client, {
    signal: shutdown.signal,
    stepPacingMs: configuration.stepDelayMs,
    ...(chat === undefined ? {} : { chat }),
    ...(analysis === undefined ? {} : { analysis }),
    ...(workOrder === undefined ? {} : { workOrder }),
    onReady: async () => {
      await processReceipt.markReady();
      process.stdout.write(`GENEWAY_WORKER_READY pid=${String(process.pid)} instance=${configuration.identity.workerInstanceId} consumer=${configuration.identity.consumer} deployment=${configuration.identity.deploymentId}\n`);
    },
    onDeliveryAbandoned: (delivery, error) => {
      process.stderr.write(`${JSON.stringify({
        event: 'worker.delivery_abandoned',
        taskId: delivery.taskId,
        attemptId: delivery.lease.attemptId,
        code: error.code,
      })}\n`);
    },
    onLaneFailure: (lane, failure) => {
      process.stderr.write(`${JSON.stringify({
        event: 'worker.lane_failure',
        lane,
        code: failure.code,
        retryDelayMs: failure.retryDelayMs,
      })}\n`);
    },
    onAfterDeliveryClaim: (delivery) => reachE2eHook({
      protocolVersion: 'geneway-e2e-hook/1',
      hook: 'worker.after_delivery_claim',
      taskId: delivery.taskId,
      workerInstanceId: delivery.workerInstanceId,
      deliveryId: delivery.lease.deliveryId,
      eventId: delivery.lease.eventId,
      executionAttemptId: delivery.lease.attemptId,
      fencingToken: delivery.lease.fencingToken,
    }),
    onBeforeCompleteStep: (delivery, step) => reachE2eHook({
      protocolVersion: 'geneway-e2e-hook/1',
      hook: 'worker.before_complete_step',
      taskId: delivery.taskId,
      workerInstanceId: delivery.workerInstanceId,
      deliveryId: delivery.lease.deliveryId,
      eventId: delivery.lease.eventId,
      executionAttemptId: delivery.lease.attemptId,
      fencingToken: delivery.lease.fencingToken,
      stepId: step.stepId,
      stepAttemptId: step.stepAttemptId,
      stepFencingToken: step.lease.fencingToken,
    }),
  });
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
