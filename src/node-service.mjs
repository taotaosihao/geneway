import { closeQuestions } from '../packages/agent-orchestration/conversations.mjs'
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { binding, digest, error, exact, key, text } from '../packages/agent-contracts/index.mjs'
import { nodeConfiguration, resourceConfiguration, publicNode } from '../packages/agent-contracts/nodes.mjs'
import { queueExecutionCommand } from '../packages/agent-orchestration/commands.mjs'

export const secretHash = secret => createHash('sha256').update(secret).digest('hex')
const matches = (hash, value) => typeof value === 'string' && timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(secretHash(value), 'hex'))
export function createNodeService({ store, workspaceId = 'local', clock = () => Date.now(), onRevoke = () => {} }) {
  function admin(state, actor) {
    const member = state.members.find(row => row.id === actor?.id && row.enabled && row.role === 'admin')
    if (!member) throw error('FORBIDDEN', '仅管理员可配置节点')
    return member
  }
  async function createPairing(actor, parameters) {
    exact(parameters, ['clientRequestId', 'nodeId', 'expectedRevision', 'siteId', 'platform', 'runtimeMode', 'allowedAgentIds', 'expiresAt'])
    const configuration = nodeConfiguration(Object.fromEntries(['siteId', 'platform', 'runtimeMode', 'allowedAgentIds'].map(field => [field, parameters[field]]))), clientRequestId = text(parameters.clientRequestId)
    const payloadDigest = digest(parameters), pairingCode = randomBytes(32).toString('base64url')
    let reply
    await store.update(state => {
      const member = admin(state, actor), id = key('pairing', workspaceId, member.id, clientRequestId), old = state.nodePairings.find(row => row.id === id)
      if (old) { if (old.requestDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT'); reply = { pairingId: id, nodeId: old.nodeId, expiresAt: old.expiresAt, alreadyIssued: true }; return state }
      const expires = Date.parse(parameters.expiresAt)
      if (!Number.isFinite(expires) || expires <= clock() || expires > clock() + 10 * 60_000) throw error('INVALID_REQUEST', '配对码须在十分钟内过期')
      if (configuration.allowedAgentIds.some(id => !state.employees.some(employee => employee.id === id && employee.enabled))) throw error('INVALID_REQUEST', '节点承载员工不存在')
      const nodeId = parameters.nodeId === undefined ? `node-${randomUUID()}` : text(parameters.nodeId), existing = state.nodes.find(row => row.id === nodeId)
      if (existing) {
        if (existing.revision !== parameters.expectedRevision) throw error('REVISION_CONFLICT')
        if (existing.status !== 'cleanup_only' || state.multisite.attempts.some(row => row.node_id === nodeId && !row.settledAt && row.status !== 'cancelled')) throw error('BUSY', '原节点执行尚未清理')
      } else if (parameters.expectedRevision !== undefined && parameters.expectedRevision !== null) throw error('REVISION_CONFLICT')
      state.nodePairings.push({ id, workspaceId, nodeId, configuration, expectedRevision: existing?.revision ?? null, createdBy: member.id, clientRequestId, requestDigest: payloadDigest, codeHash: secretHash(pairingCode), expiresAt: new Date(expires).toISOString(), createdAt: new Date(clock()).toISOString(), redeemedAt: null, redemptionRequestId: null, redemptionDigest: null })
      reply = { pairingId: id, nodeId, pairingCode, expiresAt: new Date(expires).toISOString() }
      return state
    })
    return reply
  }
  async function redeem(parameters) {
    exact(parameters, ['pairingId', 'pairingCode', 'clientRequestId', 'nodeInstanceId', 'credential'])
    for (const field of ['pairingId', 'clientRequestId', 'nodeInstanceId']) text(parameters[field])
    if (typeof parameters.credential !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(parameters.credential) || typeof parameters.pairingCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(parameters.pairingCode)) throw error('UNAUTHORIZED')
    const payloadDigest = digest(parameters)
    let reply
    await store.update(state => {
      const pairing = state.nodePairings.find(row => row.id === parameters.pairingId && row.workspaceId === workspaceId)
      if (!pairing || !matches(pairing.codeHash, parameters.pairingCode)) throw error('UNAUTHORIZED', '配对凭据无效')
      if (pairing.redeemedAt) {
        if (pairing.redemptionRequestId !== parameters.clientRequestId || pairing.redemptionDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT')
        const node = state.nodes.find(row => row.id === pairing.nodeId)
        if (node.nodeInstanceId !== parameters.nodeInstanceId || !matches(node.credentialHash, parameters.credential)) throw error('FORBIDDEN')
        reply = { node: publicNode(node) }; return state
      }
      if (Date.parse(pairing.expiresAt) <= clock()) throw error('UNAUTHORIZED', '配对码已过期')
      const existing = state.nodes.find(row => row.id === pairing.nodeId)
      if ((existing?.revision ?? null) !== pairing.expectedRevision) throw error('REVISION_CONFLICT')
      const node = { id: pairing.nodeId, workspaceId, ...pairing.configuration, status: 'active', revision: (existing?.revision ?? 0) + 1, registrationRevision: (existing?.registrationRevision ?? 0) + 1, credentialVersion: (existing?.credentialVersion ?? 0) + 1, nodeInstanceId: parameters.nodeInstanceId, credentialHash: secretHash(parameters.credential), pairedAt: new Date(clock()).toISOString(), revokedAt: null, cleanupBindings: [] }
      if (existing) state.nodes[state.nodes.indexOf(existing)] = node; else state.nodes.push(node)
      pairing.redeemedAt = node.pairedAt; pairing.redemptionRequestId = parameters.clientRequestId; pairing.redemptionDigest = payloadDigest
      reply = { node: publicNode(node) }; return state
    })
    return reply
  }
  function authenticate(state, authorization, instanceId) {
    const credential = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization ?? '')?.[1]
    const node = state.nodes.find(row => credential && matches(row.credentialHash, credential))
    if (!node || node.nodeInstanceId !== instanceId) throw error('UNAUTHORIZED', '节点身份无效')
    return { nodeId: node.id, nodeInstanceId: node.nodeInstanceId, credentialVersion: node.credentialVersion, workspaceId: node.workspaceId, remote: true }
  }
  async function revoke(actor, nodeId, parameters) {
    exact(parameters, ['clientRequestId', 'expectedRevision'])
    let reply
    await store.update(state => {
      const member = admin(state, actor), id = key('revoke-node', workspaceId, member.id, text(parameters.clientRequestId)), payloadDigest = digest({ nodeId, parameters }), old = state.nodeCommands.find(row => row.id === id)
      if (old) { if (old.payloadDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT'); reply = old.reply; return state }
      const node = state.nodes.find(row => row.id === nodeId && row.workspaceId === workspaceId)
      if (!node) throw error('NOT_FOUND')
      if (node.revision !== parameters.expectedRevision) throw error('REVISION_CONFLICT')
      const at = new Date(clock()).toISOString()
      node.status = 'cleanup_only'; node.revision++; node.revokedAt ??= at
      const attempts = state.multisite.attempts.filter(row => row.node_id === node.id && row.nodeSnapshot?.nodeInstanceId === node.nodeInstanceId && row.status !== 'cancelled' && !row.settledAt)
      node.cleanupBindings = attempts.map(binding)
      for (const attempt of attempts) {
        if (attempt.status !== 'completed') { attempt.status = 'stopping'; const work = state.works.find(row => row.id === attempt.work_id); if (work.status !== 'completed' && !work.modelRequestBudget.exhaustedAt) { work.status = 'interrupted'; work.error = { code: 'NODE_REVOKED', message: '执行节点授权已撤销，正在停止。' } } }
        queueExecutionCommand(state, attempt, attempt.status === 'completed' ? 'settle' : 'cancel', null, at, workspaceId)
      }
      closeQuestions(state, question => attempts.some(attempt => [question.senderBinding.attempt_id, question.responsibleAttemptId].includes(attempt.attempt_id)), 'NODE_REVOKED', { queue: (draft, attempt, operation, input, at) => queueExecutionCommand(draft, attempt, operation, input, at, workspaceId), at })
      reply = { node: publicNode(node) }
      state.nodeCommands.push({ id, payloadDigest, reply: structuredClone(reply), acceptedAt: at }); return state
    })
    onRevoke(nodeId)
    return reply
  }
  async function putResource(actor, resourceId, parameters) {
    exact(parameters, ['clientRequestId', 'expectedRevision', 'workspaceId', 'siteId', 'kind', 'ownerNodeId', 'capabilityIds', 'evidenceReaderAgentIds', 'enabled'])
    const { clientRequestId, expectedRevision, ...configuration } = parameters, normalized = resourceConfiguration(configuration)
    let reply
    await store.update(state => {
      const member = admin(state, actor), id = key('resource', workspaceId, member.id, text(clientRequestId)), payloadDigest = digest({ resourceId, parameters }), old = state.nodeCommands.find(row => row.id === id)
      if (old) { if (old.payloadDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT'); reply = old.reply; return state }
      if (normalized.workspaceId !== workspaceId || !state.nodes.some(row => row.id === normalized.ownerNodeId && row.workspaceId === workspaceId && row.siteId === normalized.siteId && row.status === 'active')) throw error('FORBIDDEN')
      const current = state.resources.find(row => row.id === resourceId)
      if ((current?.revision ?? null) !== (expectedRevision ?? null)) throw error('REVISION_CONFLICT')
      const row = { id: text(resourceId), ...normalized, revision: (current?.revision ?? 0) + 1 }
      if (current) state.resources[state.resources.indexOf(current)] = row; else state.resources.push(row)
      reply = { resource: row }; state.nodeCommands.push({ id, payloadDigest, reply: structuredClone(reply), acceptedAt: new Date(clock()).toISOString() }); return state
    })
    return reply
  }
  return { createPairing, redeem, authenticate, revoke, putResource, async directory(actor) { const state = await store.read(); admin(state, actor); return { nodes: state.nodes.filter(row => row.workspaceId === workspaceId).map(publicNode), resources: state.resources.filter(row => row.workspaceId === workspaceId) } } }
}
