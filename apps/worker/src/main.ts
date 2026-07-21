import { WorkerCommandClient, readWorkerToken } from './command-client.js';
import { createWorkerProcessReceipt, readWorkerProcessConfiguration } from './process-receipt.js';
import { runWorkerLoop } from './worker-loop.js';

const configuration = readWorkerProcessConfiguration(process.env);
const processReceipt = await createWorkerProcessReceipt(configuration);
const token = await readWorkerToken(configuration.tokenFile);
const client = new WorkerCommandClient(configuration.socketPath, token, configuration.identity);
const shutdown = new AbortController();
const stop = (): void => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await runWorkerLoop(client, {
    signal: shutdown.signal,
    onReady: async () => {
      await processReceipt.markReady();
      process.stdout.write(`GENEWAY_WORKER_READY pid=${String(process.pid)} instance=${configuration.identity.workerInstanceId} consumer=${configuration.identity.consumer} deployment=${configuration.identity.deploymentId}\n`);
    },
  });
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
