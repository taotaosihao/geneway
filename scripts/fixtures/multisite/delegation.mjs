import { seedMultisite } from './runtime.mjs'
export function seedDelegation(state) {
  seedMultisite(state)
  const ids = ['coordinator', 'desktop-office', 'desktop-data', 'gateway', 'analysis']
  state.members[0].employeeIds = ids
  state.employees = ids.map(id => ({ ...structuredClone(state.employees[0]), id, name: id, placement: { nodeId: 'local', mode: 'agent_host', resourceRefs: ['fixture:history', 'fixture:site'] }, multisitePolicy: {
    execution: { capabilityIds: id === 'desktop-data' ? ['evidence.history.read.v1'] : id === 'desktop-office' ? ['office.xlsx.render.v1'] : id === 'gateway' ? ['evidence.site.inspect.v1'] : id === 'analysis' ? ['analysis.classify.v1'] : ['collaboration.coordinate.v1'], resourceRefs: [] },
    delegation: { agentIds: id === 'coordinator' ? ['desktop-office', 'desktop-data', 'gateway', 'analysis'] : id === 'desktop-office' ? ['desktop-data', 'gateway', 'analysis'] : id === 'gateway' ? ['analysis'] : [], capabilityIds: ['office.xlsx.render.v1', 'evidence.history.read.v1', 'evidence.site.inspect.v1', 'analysis.classify.v1'], resourceRefs: ['fixture:history', 'fixture:site'] },
  } }))
  state.employees.find(row => row.id === 'desktop-data').multisitePolicy.execution.resourceRefs = ['fixture:history']
  state.employees.find(row => row.id === 'gateway').multisitePolicy.execution.resourceRefs = ['fixture:site']
  return state
}
export const childRequest = (clientRequestId, targetAgentId = 'desktop-office', instructionRevision = 1) => ({ clientRequestId, targetAgentId, instructionRevision, goal: `请 ${targetAgentId} 独立处理目标并返回结构化回报`, requestedCapabilityId: targetAgentId === 'desktop-data' ? 'evidence.history.read.v1' : targetAgentId === 'desktop-office' ? 'office.xlsx.render.v1' : targetAgentId === 'gateway' ? 'evidence.site.inspect.v1' : 'analysis.classify.v1', resourceRefs: targetAgentId === 'desktop-data' ? ['fixture:history'] : targetAgentId === 'gateway' ? ['fixture:site'] : [], resultSchema: !['desktop-office', 'desktop-data', 'gateway'].includes(targetAgentId) ? 'geneway.analysis-result/1' : 'geneway.delegation-result/1' })
