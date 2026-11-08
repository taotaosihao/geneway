import assert from 'node:assert/strict';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createFileStore } from '../../../src/store/file-store.mjs';
import { createMultisiteService } from '../../../packages/agent-orchestration/service.mjs';
import { createAgentHost } from '../../../packages/agent-host/host.mjs';
import { createHostJournal } from '../../../packages/agent-host/journal.mjs';
import { createSimulatedRuntime } from '../../../scripts/fixtures/multisite/runtime.mjs';
import { seedDelegation } from '../../../scripts/fixtures/multisite/delegation.mjs';
import { fixture, binding, digest } from './fixture.mjs';

const denied = code => { throw Object.assign(new Error(code), { code }); };
// Domain writes remain in the existing single-writer FileStore/applyCommand path.
// Protocol stores may project these rows; they cannot publish an execution terminal.
export async function createComparisonDomain({ root }) {
  await mkdir(root, { recursive: true });
  const store = createFileStore(path.join(root, 'state.json'));
  if (!(await store.read()).members.length) await store.update(state => {
    seedDelegation(state);
    for (const employee of state.employees) employee.placement.nodeId = fixture.agents.find(row => row.id === employee.id).nodeId;
    return state;
  });
  const runtimes = new Map(), hosts = [];
  for (const agent of fixture.agents) {
    const runtime = createSimulatedRuntime({ path: path.join(root, `${agent.id}-sessions.json`) });
    const journal = createHostJournal(path.join(root, `${agent.id}-journal.json`));
    const host = createAgentHost({ nodeId: agent.nodeId, journal, runtime, maxActiveLoops: 1 });
    runtimes.set(agent.id, runtime); hosts.push(host);
  }
  const service = createMultisiteService({ store, hosts });
  let sequence = 0;
  const event = async value => appendFile(path.join(root, 'domain-events.jsonl'), JSON.stringify({ id: `domain-${++sequence}`, at: new Date().toISOString(), ...value }) + '\n');
  async function allowed(actor, attemptId) {
    const state = await store.read(), attempt = state.multisite.attempts.find(row => row.attempt_id === attemptId);
    if (!attempt) return denied('NOT_FOUND');
    if (actor !== 'owner' && actor !== attempt.agent_id) return denied('FORBIDDEN');
    if (!state.members.find(row => row.id === 'owner' && row.enabled)?.employeeIds.includes(attempt.agent_id)) return denied('FORBIDDEN');
    return { state, attempt };
  }
  async function dispatch(actor, value) {
    assert(value && typeof value === 'object');
    let reply;
    if (['create','input','cancel','pause','resume'].includes(value.operation)) {
      if (actor !== 'owner') return denied('FORBIDDEN');
      reply = await service.apply({ id: 'owner' }, value.operation, value.parameters);
    } else if (value.operation === 'command') {
      const { attempt } = await allowed(actor, value.binding?.attempt_id);
      if (actor === 'owner' || digest(binding(attempt)) !== digest(value.binding)) return denied('FORBIDDEN');
      reply = await service.agentCommand(binding(attempt), value.command, value.parameters);
    } else if (value.operation === 'query') {
      const { attempt, state } = await allowed(actor, value.attemptId);
      reply = { binding: binding(attempt), status: attempt.status, revision: attempt.instruction_revision, workStatus: state.works.find(row => row.id === attempt.work_id).status };
    } else return denied('UNSUPPORTED_OPERATION');
    await event({ actor, operation: value.operation, commandId: value.parameters?.clientRequestId ?? null, digest: digest(value), reply });
    if (value.operation === 'create') { const rootAttempt = (await store.read()).multisite.attempts.find(row => row.work_id === reply.workId && row.parent_delegation_id === null); return { ...reply, attemptId: rootAttempt.attempt_id }; }
    return reply;
  }
  async function task(actor, attemptId) {
    const { state, attempt } = await allowed(actor, attemptId);
    const states = { accepted: 1, running: 2, waiting_input: 6, waiting_question: 6, waiting_dependency: 2, completed: 3, failed: 4, cancelled: 5, rejected: 7, stopping: 2, interrupted: 4 };
    return { id: attempt.attempt_id, contextId: attempt.work_id, status: { state: states[attempt.status] ?? 2, timestamp: attempt.stoppedAt ?? attempt.completedAt ?? attempt.startedAt ?? state.works.find(row => row.id === attempt.work_id).acceptedAt }, artifacts: [], history: [], metadata: { binding: binding(attempt), instructionRevision: attempt.instruction_revision, genewayStatus: attempt.status } };
  }
  async function taskForReply(actor, reply, value) {
    const attemptId = reply.attemptId ?? value.binding?.attempt_id ?? (await store.read()).multisite.attempts.find(row => row.work_id === reply.workId && row.parent_delegation_id === null)?.attempt_id;
    return attemptId ? task(actor, attemptId) : null;
  }
  return { store, service, runtimes, hosts, dispatch, task, taskForReply,
    async drain() { await service.drain(); await service.drain(); },
    async close() { for (const work of (await store.read()).works) if (!['completed','cancelled','failed'].includes(work.status)) { try { await service.apply({ id: 'owner' }, 'cancel', { workId: work.id, clientRequestId: `experiment-cleanup-${work.id}` }); } catch {} } await service.drain(); await service.close(); },
  };
}
