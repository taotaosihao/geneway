import { seedDelegation } from './delegation.mjs'
export const commandNodeId = '节'.repeat(16000)
export const commandHelperIds = Array.from({ length: 8 }, (_, index) => `helper-${index}`)
export function seedCommandFetch(state) {
  seedDelegation(state)
  const root = structuredClone(state.employees.find(row => row.id === 'coordinator')), analysis = state.employees.find(row => row.id === 'analysis')
  root.placement = { nodeId: 'cloud', mode: 'agent_host', resourceRefs: [] }; root.multisitePolicy = { execution: { capabilityIds: ['collaboration.coordinate.v1'], resourceRefs: [] }, delegation: { agentIds: commandHelperIds, capabilityIds: ['analysis.classify.v1'], resourceRefs: [] } }
  state.employees = [root, ...commandHelperIds.map(id => ({ ...structuredClone(analysis), id, name: id, placement: { nodeId: commandNodeId, mode: 'agent_host', resourceRefs: [] }, multisitePolicy: { execution: { capabilityIds: ['analysis.classify.v1'], resourceRefs: [] }, delegation: { agentIds: [], capabilityIds: [], resourceRefs: [] } } }))]
  state.members = [{ ...state.members[0], employeeIds: ['coordinator', ...commandHelperIds] }]; return state
}
