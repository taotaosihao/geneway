import { getCapability } from './capabilities.mjs'
import { authorizeWorkBinding, workConversationSource } from './work-service.mjs'
import { currentKnowledgeReference, stableKnowledgeRefs } from './knowledge-service.mjs'

// References only: model and delivery callers re-evaluate the existing work policy.
export function currentConversationDependencies(state, conversation, references, connectionCatalog = []) {
  try {
    if (!(references.workDependencyRefs ?? []).length && !(references.knowledgeDependencyRefs ?? []).length) return true
    const member = state.members.find(item => item.id === conversation.ownerMemberId && item.enabled === true)
    const employee = state.employees.find(item => item.id === conversation.employeeId && item.enabled === true)
    if (!member || !employee || !member.employeeIds.includes(employee.id)) return false
    for (const ref of references.workDependencyRefs ?? []) {
      const work = state.works.find(item => item.id === ref.workId && item.ownerMemberId === member.id)
      const result = work?.results.find(item => item.id === ref.resultId)
      if (!result || workConversationSource(state, work)?.conversation.id !== conversation.id || !factAllowed(work, result, ref.connectionRevision)) return false
      if (result.kind === 'assistant.collaboration-summary') for (const resultId of result.payload.resultRefs) {
        const child = state.works.find(item => item.rootWorkId === work.id && item.results.some(result => result.id === resultId))
        const childResult = child?.results.find(item => item.id === resultId)
        if (!childResult || workConversationSource(state, child)?.root.id !== work.id || !factAllowed(child, childResult)) return false
      }
    }
    return (references.knowledgeDependencyRefs ?? []).every(ref => currentKnowledgeReference(state, ref, member.id, employee.id))

    function factAllowed(work, result, revision) {
      if (getCapability(work.capabilityId)?.retired || result.knowledgeUnavailable) return false
      const { binding } = authorizeWorkBinding(state, member, work, connectionCatalog)
      if (revision !== undefined && (binding.connection?.revision ?? null) !== revision) return false
      if (binding.connection && result.source && ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].some(key => result.source[key] !== binding.connection[key])) return false
      if ((result.knowledgeDependencyRefs ?? []).some(item => !currentKnowledgeReference(state, item, member.id, result.employeeId ?? work.employeeId)
        || !currentKnowledgeReference(state, item, member.id, employee.id))) return false
      return true
    }
  } catch { return false }
}

export function conversationSessionDependencies(conversation, turn) {
  const turns = turn.sessionId ? conversation.turns.filter(item => item.sessionId === turn.sessionId) : [turn]
  return {
    workDependencyRefs: [...new Map(turns.flatMap(item => item.workDependencyRefs ?? []).map(ref => [`${ref.workId}\0${ref.resultId}\0${ref.connectionRevision}`, ref])).values()],
    knowledgeDependencyRefs: stableKnowledgeRefs(turns.flatMap(item => item.knowledgeDependencyRefs ?? [])),
  }
}
