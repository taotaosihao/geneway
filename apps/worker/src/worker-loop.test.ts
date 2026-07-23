import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  workerCommandSchema,
  type WorkerCommand,
  type WorkerDelivery,
} from '@geneway/contracts';
import { compileWorkflow, createSolutionAnalysisDocumentDraft, createSolutionAnalysisDraft } from '@geneway/workflow';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerCommandClient } from './command-client.js';
import type { ChatRuntimeAdapter } from '@geneway/runtime';
import type { ChatWorkerCommandClient, ChatTurnClaim } from './chat-command-client.js';
import { executeChatTurn, runWorkerLoop } from './worker-loop.js';

const TOKEN = 'worker-loop-token-0123456789';
const identity = {
  workerInstanceId: 'worker-loop-test',
  consumer: 'gate0.2a-worker',
  deploymentId: 'gate0.2a-local',
} as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'geneway-worker-loop-'));
  temporaryDirectories.push(directory);
  return directory;
}

function delivery(): WorkerDelivery {
  const workflow = compileWorkflow(createSolutionAnalysisDraft());
  return {
    tenantId: 'tenant-loop',
    taskId: 'task-loop',
    consumer: identity.consumer,
    deploymentId: identity.deploymentId,
    workerInstanceId: identity.workerInstanceId,
    lease: { eventId: 'event-loop', deliveryId: 'delivery-loop', attemptId: 'attempt-loop', fencingToken: 19 },
    inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1', fixtureVersion: 1 },
    workflow: {
      id: workflow.id,
      hash: workflow.hash,
      canonicalizationVersion: workflow.canonicalizationVersion,
      canonicalPayload: workflow.payload,
    },
  };
}

function documentDelivery(): WorkerDelivery {
  const resourceScope = 'project:gate0.2a-worker-test';
  const workflow = compileWorkflow(createSolutionAnalysisDocumentDraft(resourceScope));
  return {
    tenantId: 'tenant-loop',
    taskId: 'task-document-loop',
    consumer: identity.consumer,
    deploymentId: identity.deploymentId,
    workerInstanceId: identity.workerInstanceId,
    lease: { eventId: 'event-document', deliveryId: 'delivery-document', attemptId: 'attempt-document', fencingToken: 23 },
    inputRef: {
      kind: 'document_snapshot',
      documentSnapshotId: 'snapshot-document',
      artifactId: 'artifact-document',
      manifestId: 'manifest-document',
      contentSha256: '0'.repeat(64),
      simulationProfile: 'solution-analysis-demo/v2',
      profileRegistryVersion: 'gate0.2a-profile-registry/1',
      resourceScope,
      dataClass: 'C1',
      audience: 'conversation:worker-test',
    },
    workflow: {
      id: workflow.id,
      hash: workflow.hash,
      canonicalizationVersion: workflow.canonicalizationVersion,
      canonicalPayload: workflow.payload,
    },
  };
}

describe('independent worker loop', () => {
  it('aborts a running Gateway stream and reports canceled with the incremented fence', async () => {
    const lifecycle: string[] = [];
    const claim: ChatTurnClaim = {
      dispatchId: 'dispatch-cancel', conversationId: 'conversation-cancel', modelInvocationId: 'invocation-cancel',
      assistantMessageId: 'message-cancel', attemptId: 'attempt-cancel', fence: 1,
      deadline: new Date(Date.now() + 60_000).toISOString(), invocationToken: 't'.repeat(40),
      logicalModelPolicy: 'general.chat.standard', promptPolicyVersion: 'xiaowei.chat.system/1', systemPrompt: 'test',
      context: [{ messageId: 'message-user', author: 'user', content: 'long answer' }], contextTruncated: false,
    };
    const client = {
      execute: () => { lifecycle.push('execute'); return Promise.resolve(); },
      started: () => { lifecycle.push('started'); return Promise.resolve(); },
      delta: (_claim: ChatTurnClaim, delta: string) => { lifecycle.push(`delta:${delta}`); return Promise.resolve(); },
      completed: () => { lifecycle.push('completed'); return Promise.resolve(); },
      failed: () => { lifecycle.push('failed'); return Promise.resolve(); },
      cancelRequested: () => Promise.resolve(2),
      canceled: (_claim: ChatTurnClaim, fence: number) => { lifecycle.push(`canceled:${String(fence)}`); return Promise.resolve(); },
    } as unknown as ChatWorkerCommandClient;
    const runtime = {
      stream: async (
        _input: unknown,
        onDelta: (delta: string) => Promise<void>,
        signal?: AbortSignal,
      ) => {
        await onDelta('partial');
        return new Promise<never>((_resolve, reject) => {
          if (signal?.aborted === true) reject(new Error('canceled'));
          else signal?.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
        });
      },
    } as unknown as ChatRuntimeAdapter;

    await executeChatTurn(client, runtime, claim);
    expect(lifecycle).toEqual(['execute', 'started', 'delta:partial', 'canceled:2']);
  });

  it('authenticates before readiness, claims one delivery, runs seven steps, and submits one candidate', async () => {
    const directory = await makeDirectory();
    const socketPath = join(directory, 'commands.sock');
    const claimedDelivery = delivery();
    const commands: WorkerCommand[] = [];
    const lifecycle: string[] = [];
    const shutdown = new AbortController();
    let claimed = false;
    const serverErrors: unknown[] = [];

    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) {
          if (!(chunk instanceof Uint8Array)) throw new Error('Expected request bytes');
          chunks.push(chunk);
        }
        const command = workerCommandSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        commands.push(command);
        lifecycle.push(command.command);
        let result: unknown;
        switch (command.command) {
          case 'session': result = { authenticated: true }; break;
          case 'claim_delivery':
            result = claimed ? null : claimedDelivery;
            claimed = true;
            break;
          case 'read_input': result = { kind: 'fixture', inputRef: claimedDelivery.inputRef }; break;
          case 'claim_step': result = { state: 'claimed', stepAttemptId: command.stepAttemptId, fencingToken: commands.length + 20 }; break;
          case 'complete_step': result = { accepted: true }; break;
          case 'submit_candidate':
            result = { accepted: true };
            shutdown.abort();
            break;
          case 'fail_delivery': result = { accepted: true }; break;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ command: command.command, ok: true, result }));
      })().catch((error: unknown) => {
        serverErrors.push(error);
        response.destroy(error instanceof Error ? error : new Error('Test command server failed'));
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));

    try {
      const client = new WorkerCommandClient(socketPath, TOKEN, identity);
      await runWorkerLoop(client, {
        signal: shutdown.signal,
        pollIntervalMs: 10,
        onReady: () => { lifecycle.push('ready'); },
        onAfterDeliveryClaim: () => {
          lifecycle.push('after_delivery_claim');
          return Promise.resolve();
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }

    expect(lifecycle.slice(0, 5)).toEqual(['session', 'ready', 'claim_delivery', 'after_delivery_claim', 'read_input']);
    expect(commands.filter((command) => command.command === 'claim_step')).toHaveLength(7);
    expect(commands.filter((command) => command.command === 'complete_step')).toHaveLength(7);
    const candidates = commands.filter((command): command is Extract<WorkerCommand, { command: 'submit_candidate' }> => command.command === 'submit_candidate');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.candidate.claims).toHaveLength(2);
    expect(candidates[0]?.candidate.evidence).toHaveLength(1);
    expect(commands.some((command) => command.command === 'fail_delivery')).toBe(false);
    expect(serverErrors).toEqual([]);
  });

  it('reports a delivery failure before executing when document bytes do not match the resolved hash', async () => {
    const directory = await makeDirectory();
    const socketPath = join(directory, 'commands.sock');
    const claimedDelivery = documentDelivery();
    const commands: WorkerCommand[] = [];
    const serverErrors: unknown[] = [];
    const shutdown = new AbortController();

    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) {
          if (!(chunk instanceof Uint8Array)) throw new Error('Expected request bytes');
          chunks.push(chunk);
        }
        const command = workerCommandSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        commands.push(command);
        let result: unknown;
        switch (command.command) {
          case 'session': result = { authenticated: true }; break;
          case 'claim_delivery': result = claimedDelivery; break;
          case 'read_input':
            result = {
              kind: 'document_snapshot',
              inputRef: claimedDelivery.inputRef,
              bytesBase64: Buffer.from('wrong document bytes', 'utf8').toString('base64'),
            };
            break;
          case 'fail_delivery':
            result = { accepted: true };
            shutdown.abort();
            break;
          case 'claim_step': result = { state: 'claimed', stepAttemptId: command.stepAttemptId, fencingToken: 1 }; break;
          case 'complete_step':
          case 'submit_candidate':
            result = { accepted: true };
            break;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ command: command.command, ok: true, result }));
      })().catch((error: unknown) => {
        serverErrors.push(error);
        response.destroy(error instanceof Error ? error : new Error('Test command server failed'));
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));

    try {
      const client = new WorkerCommandClient(socketPath, TOKEN, identity);
      await runWorkerLoop(client, { signal: shutdown.signal, pollIntervalMs: 10 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }

    expect(commands.filter((command) => command.command === 'fail_delivery')).toHaveLength(1);
    expect(commands.some((command) => command.command === 'claim_step')).toBe(false);
    expect(serverErrors).toEqual([]);
  });

  it('abandons an outcome-uncertain completion without reporting the delivery as failed', async () => {
    const directory = await makeDirectory();
    const socketPath = join(directory, 'commands.sock');
    const claimedDelivery = delivery();
    const commands: WorkerCommand[] = [];
    const serverErrors: unknown[] = [];
    const shutdown = new AbortController();
    let claimed = false;
    let abandonCode: string | undefined;

    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) {
          if (!(chunk instanceof Uint8Array)) throw new Error('Expected request bytes');
          chunks.push(chunk);
        }
        const command = workerCommandSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        commands.push(command);
        if (command.command === 'complete_step') {
          request.socket.destroy();
          return;
        }
        let result: unknown;
        switch (command.command) {
          case 'session': result = { authenticated: true }; break;
          case 'claim_delivery':
            result = claimed ? null : claimedDelivery;
            claimed = true;
            break;
          case 'read_input': result = { kind: 'fixture', inputRef: claimedDelivery.inputRef }; break;
          case 'claim_step': result = { state: 'claimed', stepAttemptId: command.stepAttemptId, fencingToken: 31 }; break;
          case 'submit_candidate':
          case 'fail_delivery':
            result = { accepted: true };
            break;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ command: command.command, ok: true, result }));
      })().catch((error: unknown) => {
        serverErrors.push(error);
        response.destroy(error instanceof Error ? error : new Error('Test command server failed'));
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));

    try {
      const client = new WorkerCommandClient(socketPath, TOKEN, identity);
      await runWorkerLoop(client, {
        signal: shutdown.signal,
        pollIntervalMs: 10,
        onDeliveryAbandoned: (_delivery, error) => {
          abandonCode = error.code;
          shutdown.abort();
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }

    const completions = commands.filter(
      (command): command is Extract<WorkerCommand, { command: 'complete_step' }> => command.command === 'complete_step',
    );
    expect(completions).toHaveLength(3);
    expect(completions[1]).toEqual(completions[0]);
    expect(completions[2]).toEqual(completions[0]);
    expect(commands.some((command) => command.command === 'fail_delivery')).toBe(false);
    expect(abandonCode).toBe('WORKER_COMMAND_OUTCOME_UNCERTAIN');
    expect(serverErrors).toEqual([]);
  });
});
