import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  workerCommandSchema,
  type WorkerCommand,
  type WorkerDelivery,
} from '@geneway/contracts';
import { compileWorkflow, createSolutionAnalysisDraft } from '@geneway/workflow';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerCommandClient, readWorkerToken } from './command-client.js';

const TOKEN = 'worker-test-token-0123456789';
const identity = {
  workerInstanceId: 'worker-test-1',
  consumer: 'gate0.2a-worker',
  deploymentId: 'gate0.2a-local',
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'geneway-worker-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureDelivery(): WorkerDelivery {
  const workflow = compileWorkflow(createSolutionAnalysisDraft());
  return {
    tenantId: 'tenant-test',
    taskId: 'task-test',
    consumer: identity.consumer,
    deploymentId: identity.deploymentId,
    workerInstanceId: identity.workerInstanceId,
    lease: {
      eventId: 'event-test',
      deliveryId: 'delivery-test',
      attemptId: 'attempt-test',
      fencingToken: 7,
    },
    inputRef: {
      kind: 'fixture',
      fixtureRef: 'fixture:solution-analysis:v1',
      fixtureVersion: 1,
    },
    workflow: {
      id: workflow.id,
      hash: workflow.hash,
      canonicalizationVersion: workflow.canonicalizationVersion,
      canonicalPayload: workflow.payload,
    },
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Expected request bytes');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function send(response: ServerResponse, command: WorkerCommand['command'], result: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ command, ok: true, result }));
}

describe('worker command client', () => {
  it('reads only a private, owner-bound token file', async () => {
    const directory = await temporaryDirectory();
    const tokenFile = join(directory, 'token');
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    await expect(readWorkerToken(tokenFile)).resolves.toBe(TOKEN);

    await chmod(tokenFile, 0o640);
    await expect(readWorkerToken(tokenFile)).rejects.toMatchObject({ code: 'WORKER_TOKEN_FILE_PERMISSIONS' });
    await chmod(tokenFile, 0o400);
    await expect(readWorkerToken(tokenFile)).rejects.toMatchObject({ code: 'WORKER_TOKEN_FILE_PERMISSIONS' });
  });

  it('authenticates over the UDS and binds all commands to the claimed delivery', async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'commands.sock');
    const delivery = fixtureDelivery();
    const received: WorkerCommand[] = [];
    const serverErrors: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        expect(request.url).toBe('/internal/worker/v1/commands');
        expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
        const command = workerCommandSchema.parse(await readJson(request));
        received.push(command);
        switch (command.command) {
          case 'session': send(response, command.command, { authenticated: true }); break;
          case 'claim_delivery': send(response, command.command, delivery); break;
          case 'read_input': send(response, command.command, { kind: 'fixture', inputRef: delivery.inputRef }); break;
          case 'claim_step': send(response, command.command, { state: 'claimed', stepAttemptId: command.stepAttemptId, fencingToken: 11 }); break;
          case 'complete_step':
          case 'submit_candidate':
          case 'fail_delivery':
            send(response, command.command, { accepted: true });
            break;
        }
      })().catch((error: unknown) => {
        serverErrors.push(error);
        response.destroy(error instanceof Error ? error : new Error('Test command server failed'));
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));

    try {
      const client = new WorkerCommandClient(socketPath, TOKEN, identity);
      await client.authenticate();
      const claimed = await client.claimDelivery();
      expect(claimed).toEqual(delivery);
      if (claimed === null) throw new Error('Expected a delivery');
      await expect(client.readInput(claimed)).resolves.toEqual({ kind: 'fixture', inputRef: delivery.inputRef });

      const port = client.bind(claimed);
      const lease = await port.claimStep('document_ingest', 'step-attempt-1');
      expect(lease).toEqual({ state: 'claimed', lease: { attemptId: 'step-attempt-1', fencingToken: 11 } });
      if (lease.state !== 'claimed') throw new Error('Expected a claimed step');
      await port.completeStep('document_ingest', lease.lease, { summary: 'ok' });
      await port.submitCandidate({
        evidence: [{
          kind: 'legacy_fixture',
          candidateKey: 'source',
          fixtureRef: 'fixture:solution-analysis:v1',
          fixtureVersion: 1,
          sourceId: 'source-1',
        }],
        claims: [{ candidateKey: 'claim', text: 'claim', evidenceCandidateKey: 'source' }],
        result: {
          kind: 'completed',
          summary: 'done',
          stepSummaries: ['done'],
          simulation: true,
          runtimeMode: 'fake',
          businessDecisionAllowed: false,
        },
      }, 'candidate-idempotency-1');

      const executionCommands = received.filter((command) => 'deliveryId' in command);
      expect(executionCommands).toHaveLength(4);
      for (const command of executionCommands) {
        expect(command).toMatchObject({
          workerInstanceId: identity.workerInstanceId,
          deliveryId: delivery.lease.deliveryId,
          eventId: delivery.lease.eventId,
          attemptId: delivery.lease.attemptId,
          fencingToken: delivery.lease.fencingToken,
        });
        expect(command).not.toHaveProperty('tenantId');
        expect(command).not.toHaveProperty('taskId');
      }
      expect(serverErrors).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('retries an outcome-uncertain mutation with byte-identical semantics and the same idempotency key', async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'commands.sock');
    const delivery = fixtureDelivery();
    const received: WorkerCommand[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const command = workerCommandSchema.parse(await readJson(request));
        received.push(command);
        if (received.length === 1) {
          request.socket.destroy();
          return;
        }
        send(response, command.command, { accepted: true });
      })();
    });
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));

    try {
      const port = new WorkerCommandClient(socketPath, TOKEN, identity).bind(delivery);
      await port.completeStep('document_ingest', { attemptId: 'step-attempt-ack', fencingToken: 12 }, { summary: 'ok' });
      expect(received).toHaveLength(2);
      expect(received[1]).toEqual(received[0]);
      const retried = received[0];
      if (retried?.command !== 'complete_step') throw new Error('Expected complete_step to be retried');
      expect(typeof retried.idempotencyKey).toBe('string');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('retries when a successful response is aborted after headers and a partial body', async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'partial-response.sock');
    const delivery = fixtureDelivery();
    const received: WorkerCommand[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const command = workerCommandSchema.parse(await readJson(request));
        received.push(command);
        if (received.length === 1) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{"command":');
          response.destroy();
          return;
        }
        send(response, command.command, { accepted: true });
      })();
    });
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));

    try {
      const port = new WorkerCommandClient(socketPath, TOKEN, identity).bind(delivery);
      await port.completeStep('document_ingest', { attemptId: 'step-attempt-partial', fencingToken: 15 }, { summary: 'ok' });
      expect(received).toHaveLength(2);
      expect(received[1]).toEqual(received[0]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('bounds transport retries at three identical attempts and never retries a semantic 4xx', async () => {
    const directory = await temporaryDirectory();
    const uncertainSocketPath = join(directory, 'uncertain.sock');
    const semanticSocketPath = join(directory, 'semantic.sock');
    const delivery = fixtureDelivery();
    const uncertainCommands: WorkerCommand[] = [];
    const semanticCommands: WorkerCommand[] = [];
    const uncertainServer = createServer((request) => {
      void (async () => {
        uncertainCommands.push(workerCommandSchema.parse(await readJson(request)));
        request.socket.destroy();
      })();
    });
    const semanticServer = createServer((request, response) => {
      void (async () => {
        semanticCommands.push(workerCommandSchema.parse(await readJson(request)));
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'STALE_STEP_COMPLETION', message: 'stale' } }));
      })();
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => uncertainServer.listen(uncertainSocketPath, resolve).once('error', reject)),
      new Promise<void>((resolve, reject) => semanticServer.listen(semanticSocketPath, resolve).once('error', reject)),
    ]);

    try {
      const uncertainPort = new WorkerCommandClient(uncertainSocketPath, TOKEN, identity).bind(delivery);
      await expect(uncertainPort.completeStep(
        'document_ingest',
        { attemptId: 'step-attempt-uncertain', fencingToken: 13 },
        { summary: 'uncertain' },
      )).rejects.toMatchObject({ code: 'WORKER_COMMAND_OUTCOME_UNCERTAIN' });
      expect(uncertainCommands).toHaveLength(3);
      expect(uncertainCommands[1]).toEqual(uncertainCommands[0]);
      expect(uncertainCommands[2]).toEqual(uncertainCommands[0]);

      const semanticPort = new WorkerCommandClient(semanticSocketPath, TOKEN, identity).bind(delivery);
      await expect(semanticPort.completeStep(
        'document_ingest',
        { attemptId: 'step-attempt-stale', fencingToken: 14 },
        { summary: 'stale' },
      )).rejects.toMatchObject({ code: 'STALE_STEP_COMPLETION', statusCode: 409 });
      expect(semanticCommands).toHaveLength(1);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) => uncertainServer.close((error) => error === undefined ? resolve() : reject(error))),
        new Promise<void>((resolve, reject) => semanticServer.close((error) => error === undefined ? resolve() : reject(error))),
      ]);
    }
  });
});
