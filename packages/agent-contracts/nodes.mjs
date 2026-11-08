import { isDeepStrictEqual } from 'node:util'
import { binding, digest, error, exact, sameBinding, text } from './index.mjs'
import { ids, DELEGATION_CAPABILITIES } from './delegation.mjs'

export const NODE_FIELDS = ['id', 'workspaceId', 'siteId', 'platform', 'runtimeMode', 'status', 'revision', 'registrationRevision', 'allowedAgentIds', 'nodeInstanceId', 'credentialVersion', 'credentialHash', 'pairedAt', 'revokedAt', 'cleanupBindings']
export function nodeConfiguration(value) {
  exact(value, ['siteId', 'platform', 'runtimeMode', 'allowedAgentIds'])
  if (!['linux', 'windows', 'macos'].includes(value.platform) || value.runtimeMode !== 'agent_node') throw error('INVALID_REQUEST', '节点平台或运行模式无效')
  return { siteId: text(value.siteId), platform: value.platform, runtimeMode: value.runtimeMode, allowedAgentIds: ids(value.allowedAgentIds, '节点承载员工') }
}
export function resourceConfiguration(value) {
  exact(value, ['workspaceId', 'siteId', 'kind', 'ownerNodeId', 'capabilityIds', 'evidenceReaderAgentIds', 'enabled'])
  if (!['history_directory', 'site_diagnostics', 'analysis', 'office_template'].includes(value.kind) || typeof value.enabled !== 'boolean') throw error('INVALID_REQUEST', '资源类型或状态无效')
  return { workspaceId: text(value.workspaceId), siteId: text(value.siteId), kind: value.kind, ownerNodeId: text(value.ownerNodeId), capabilityIds: ids(value.capabilityIds, '资源能力', DELEGATION_CAPABILITIES), evidenceReaderAgentIds: ids(value.evidenceReaderAgentIds ?? [], '证据读取员工'), enabled: value.enabled }
}
export function snapshotNode(state, attempt, { required = false } = {}) {
  const node = state.nodes.find(row => row.id === attempt.node_id)
  if (!node) { if (required) throw error('FORBIDDEN', '执行节点尚未注册'); return }
  if (node.status !== 'active' || !node.allowedAgentIds.includes(attempt.agent_id)) throw error('FORBIDDEN', '节点未获准承载此员工')
  attempt.nodeSnapshot = { id: node.id, workspaceId: node.workspaceId, registrationRevision: node.registrationRevision, credentialVersion: node.credentialVersion, nodeInstanceId: node.nodeInstanceId }
  attempt.resourceSnapshots = attempt.resource_refs.map(id => {
    const resource = state.resources.find(row => row.id === id && row.enabled && row.ownerNodeId === node.id && row.workspaceId === node.workspaceId && row.siteId === node.siteId)
    if (!resource || attempt.grant && !attempt.grant.execution.capabilityIds.every(capability => resource.capabilityIds.includes(capability))) throw error('FORBIDDEN', '资源不属于执行节点或能力未获准')
    return { id, revision: resource.revision }
  })
}
export function assertNodeExecution(state, attempt, execution = attempt) {
  if (!attempt.nodeSnapshot) return
  const snapshot = attempt.nodeSnapshot, node = state.nodes.find(row => row.id === snapshot.id)
  if (!node || node.status !== 'active' || node.workspaceId !== snapshot.workspaceId || node.registrationRevision !== snapshot.registrationRevision || node.credentialVersion !== snapshot.credentialVersion || node.nodeInstanceId !== snapshot.nodeInstanceId || !node.allowedAgentIds.includes(attempt.agent_id)) throw error('FORBIDDEN', '节点执行授权已失效')
  if (attempt.session_id === null && execution.session_id !== null && execution.session_id !== `geneway-${attempt.launch_id}`) throw error('FORBIDDEN', '首次 Session 必须使用服务端预绑定身份')
  for (const ref of attempt.resourceSnapshots) {
    const resource = state.resources.find(row => row.id === ref.id)
    if (!resource || !resource.enabled || resource.revision !== ref.revision || resource.ownerNodeId !== node.id || resource.workspaceId !== node.workspaceId) throw error('FORBIDDEN', '执行资源已变化')
  }
}
export function assertNodeCaller(state, authenticated, execution, { cleanup = false, receiptReplay = false } = {}) {
  const node = state.nodes.find(row => row.id === authenticated.nodeId), attempt = state.multisite.attempts.find(row => row.attempt_id === execution.attempt_id)
  if (!node || node.credentialVersion !== authenticated.credentialVersion || node.nodeInstanceId !== authenticated.nodeInstanceId || node.workspaceId !== authenticated.workspaceId || !attempt || attempt.node_id !== node.id || attempt.nodeSnapshot?.nodeInstanceId !== node.nodeInstanceId || !sameBinding(attempt, execution, { firstSession: attempt.session_id === null && execution.session_id !== null }) || attempt.session_id === null && execution.session_id !== null && execution.session_id !== `geneway-${attempt.launch_id}`) throw error('FORBIDDEN', '节点与执行绑定不匹配')
  if (receiptReplay) return { node, attempt }
  // Revoking execution resources cannot revoke cleanup of an already bound execution.
  if (cleanup && node.status === 'active') return { node, attempt }
  if (node.status === 'cleanup_only') {
    if (!cleanup || !node.cleanupBindings.some(row => sameBinding(row, execution, { firstSession: row.session_id === null && execution.session_id !== null }))) throw error('FORBIDDEN', '节点仅可清理撤权时的执行')
  } else assertNodeExecution(state, attempt, execution)
  return { node, attempt }
}
export const publicNode = node => Object.fromEntries(Object.entries(node).filter(([field]) => !['credentialHash', 'cleanupBindings'].includes(field)))
export const emptyNodeState = () => ({ nodes: [], nodePairings: [], nodeCommands: [], resources: [], executionIssuances: [] })
export function validateNodeState(state) {
  for (const [name, rows] of Object.entries(emptyNodeState())) {
    if (!Array.isArray(state[name]) || state[name].length > 10_000 || new Set(state[name].map(row => row.id)).size !== state[name].length) throw error('INVALID_STATE', `节点状态域无效：${name}`)
  }
  for (const node of state.nodes) {
    exact(node, NODE_FIELDS); nodeConfiguration({ siteId: node.siteId, platform: node.platform, runtimeMode: node.runtimeMode, allowedAgentIds: node.allowedAgentIds })
    if (!['paired', 'active', 'cleanup_only'].includes(node.status) || ![node.revision, node.registrationRevision, node.credentialVersion].every(value => Number.isSafeInteger(value) && value > 0) || !/^[a-f0-9]{64}$/.test(node.credentialHash) || typeof node.nodeInstanceId !== 'string' || !Array.isArray(node.cleanupBindings)) throw error('INVALID_STATE', '节点注册事实无效')
  }
  for (const row of state.resources) { const { id, revision, ...configuration } = row; text(id); resourceConfiguration(configuration); if (!Number.isSafeInteger(revision) || revision < 1 || !state.nodes.some(node => node.id === row.ownerNodeId && node.workspaceId === row.workspaceId && node.siteId === row.siteId)) throw error('INVALID_STATE', '资源所属节点无效') }
  for (const row of state.nodePairings) if (!/^[a-f0-9]{64}$/.test(row.codeHash) || !/^[a-f0-9]{64}$/.test(row.requestDigest) || !Number.isFinite(Date.parse(row.expiresAt)) || row.redemptionDigest !== null && !/^[a-f0-9]{64}$/.test(row.redemptionDigest)) throw error('INVALID_STATE', '配对受理事实无效')
  for (const row of state.executionIssuances) if (!state.multisite.attempts.some(attempt => attempt.attempt_id === row.attempt_id) || row.payloadDigest !== digest(row.parameters)) throw error('INVALID_STATE', '执行令牌受理事实无效')
  return state
}
export function assertNodeStateImmutable(before, after) {
  for (const name of ['nodeCommands', 'executionIssuances']) for (const row of before[name]) if (!isDeepStrictEqual(row, after[name].find(item => item.id === row.id))) throw error('INVALID_STATE', '节点受理事实不可改写')
  for (const row of before.nodePairings) {
    const current = after.nodePairings.find(item => item.id === row.id)
    if (!current || !isDeepStrictEqual({ ...row, redeemedAt: null, redemptionRequestId: null, redemptionDigest: null }, { ...current, redeemedAt: null, redemptionRequestId: null, redemptionDigest: null }) || row.redeemedAt && !isDeepStrictEqual(row, current)) throw error('INVALID_STATE', '配对事实不可改写')
  }
  for (const node of before.nodes) {
    const current = after.nodes.find(row => row.id === node.id)
    if (!current || current.revision < node.revision || current.registrationRevision < node.registrationRevision || current.credentialVersion < node.credentialVersion) throw error('INVALID_STATE', '节点注册不可回退')
  }
}
