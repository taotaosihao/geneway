// Adapted from dsh-superagent-prototype@6337fc8 core/intake.ts (MIT).
// Geneway authenticates the source and explicit Work target before the synchronous fan-out.
import { key, error, text, attachmentRefs } from '../agent-contracts/index.mjs'

export function receiveInput(state, work, source, targets, at) {
  const id = key('input', work.id, source.issuerId, source.commandId)
  const existing = state.multisite.inputs.find(input => input.id === id)
  if (existing) return existing
  if (!targets.length) throw error('INVALID_REQUEST', '输入必须有接收执行')
  const input = { id, workId: work.id, issuerId: source.issuerId, text: text(source.text, '输入'),
    attachmentRefs: attachmentRefs(source.attachmentRefs), ...(source.revisionScope ? { revisionScope: source.revisionScope } : {}), ...(source.spreadsheetRequest ? { spreadsheetRequest: structuredClone(source.spreadsheetRequest) } : {}), at: new Date(at).toISOString(), revision: work.instructionRevision, deliveries: [] }
  const reached = new Map(targets.map(target => [target.attempt_id, target]))
  for (const target of reached.values()) input.deliveries.push({ attemptId: target.attempt_id, sessionId: target.session_id, deliveredAt: null, ingestedAt: null })
  state.multisite.inputs.push(input)
  return input
}
