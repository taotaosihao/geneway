import { isDeepStrictEqual } from 'node:util'
import { binding, digest, error, key, sameBinding } from '../packages/agent-contracts/index.mjs'
import { assertTerminalProofProfile } from '../packages/agent-contracts/terminal-proof.mjs'
import { buildExecutionCommand } from '../packages/agent-orchestration/commands.mjs'
import { manualFence } from './manual-control.mjs'

export const spreadsheetPreparationKey = (workspaceId, attemptId, clientRequestId) => key('spreadsheet-prepare', workspaceId, attemptId, clientRequestId)

export function recordSpreadsheetPreparation(state, execution, parameters, prepared, at) {
  const work = state.works.find(row => row.id === execution.work_id), commandId = parameters.clientRequestId, namespace = spreadsheetPreparationKey(work.workspaceId, execution.attempt_id, commandId), requestDigest = digest(parameters)
  const reply = { workId: work.id, jobId: key('spreadsheet-job', binding(execution), commandId), inputDigest: prepared.inputDigest, requestDigest, instructionRevision: prepared.input.instructionRevision }
  const row = { key: namespace, receiptKind: 'spreadsheet_prepared', workspaceId: work.workspaceId, issuerId: execution.attempt_id, issuerKind: 'agent', senderBinding: binding(execution), commandId, digest: digest({ operation: 'spreadsheet_prepare', parameters }), reply, manualFence: manualFence(state, execution), acceptedAt: at }
  const old = state.multisite.commands.find(row => row.key === namespace)
  if (old) { if (old.receiptKind !== row.receiptKind || old.digest !== row.digest || !isDeepStrictEqual(old.reply, row.reply)) throw error('IDEMPOTENCY_CONFLICT', '生成准备请求与原封存声明不同'); return old }
  const attempt = state.multisite.attempts.find(attempt => sameBinding(attempt, execution, { firstSession: attempt.session_id === null }))
  if (!attempt) throw error('FORBIDDEN', '生成准备与当前执行不匹配')
  const commands = ['cancel', 'settle'].map(operation => buildExecutionCommand(state, attempt, operation, null, work.workspaceId))
  const preparedJobIds = [...state.multisite.commands.filter(item => item.receiptKind === 'spreadsheet_prepared' && sameBinding(item.senderBinding, execution)).map(item => item.reply.jobId), reply.jobId]
  assertTerminalProofProfile({ execution, commands, preparedJobIds,
    registeredJobs: state.multisite.jobs.filter(job => sameBinding(job, execution)),
    sealedEvents: state.multisite.receipts.map(item => item.event) })
  state.multisite.commands.push(row); return row
}

export function preparationForJob(state, job) {
  return state.multisite.commands.find(row => row.receiptKind === 'spreadsheet_prepared' && row.key === spreadsheetPreparationKey(job.workspace_id ?? state.works.find(work => work.id === job.work_id)?.workspaceId, job.attempt_id, job.clientRequestId) && sameBinding(row.senderBinding, job) && row.reply.jobId === job.id && row.reply.inputDigest === job.inputDigest && row.reply.requestDigest === job.requestDigest && row.reply.instructionRevision === job.instructionRevision)
}
