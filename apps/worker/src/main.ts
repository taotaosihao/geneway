import { WorkerCommandClient, readWorkerToken } from './command-client.js';
import { parseE2eHookEndpoint, postE2eHook } from '@geneway/runtime';
import { createWorkerProcessReceipt, readWorkerProcessConfiguration } from './process-receipt.js';
import { runWorkerLoop } from './worker-loop.js';

const configuration = readWorkerProcessConfiguration(process.env);
const processReceipt = await createWorkerProcessReceipt(configuration);
const token = await readWorkerToken(configuration.tokenFile);
const client = new WorkerCommandClient(configuration.socketPath, token, configuration.identity);
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
