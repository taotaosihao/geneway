import { isCloudOrdinaryCapacityError } from './cloud-capacity.mjs'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BINDING_FIELDS, digest, error, exact, key, sameBinding, text } from '../packages/agent-contracts/index.mjs'
import { assertNodeCaller } from '../packages/agent-contracts/nodes.mjs'
import { assertEvidenceReader } from './evidence-access.mjs'
import { authorizeMultisiteExecution, authorizeReadyArtifactRead, hasConsumedExecutionMessage } from './multisite-authorization.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { workMemberAffected } from './work-member-removal.mjs'
import { A2A_GROUP_MESSAGE_KINDS, a2aDeliveryId, a2aDeliveryRevoked, a2aGroupId, a2aNoticeDigest, a2aParticipantSource, normalizedA2aBinding } from './a2a-group-state.mjs'

export const A2A_WORK_GROUP_SCHEMA = 'geneway.a2a.work-group/1'
const RECEIVE_LIMIT = 8
const SCAN_LIMIT = 128
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value))

function mappedWork(state, workId, workspaceId) {
  const work = state.works.find(row => row.id === workId && row.workType === 'multisite' && (!workspaceId || row.workspaceId === workspaceId))
  return work && state.a2aProtocol.tasks.some(row => row.workId === work.id && row.workspaceId === work.workspaceId) ? work : null
}
function participatingEmployees(state, work) { return [...new Set(state.multisite.attempts.filter(row => row.work_id === work.id).map(row => row.agent_id))] }
function ready(state, group) {
  const work = mappedWork(state, group.workId, group.workspaceId)
  if (!work || participatingEmployees(state, work).some(id => !group.members.some(member => member.employeeId === id))) return false
  return state.workMemberRemovals.filter(row => row.workId === work.id).every(row => group.calibrations.some(item => item.employeeId === row.employeeId && item.removalCommandId === row.commandId && item.sourceDigest === digest(row)) && state.a2aProtocol.deliveries.filter(delivery => delivery.groupId === group.id && workMemberAffected(state, delivery.receiverBinding, row.employeeId)).every(delivery => delivery.metadataAck || a2aDeliveryRevoked(state, delivery)))
}
function sourceFor(state, group, member, execution, sourceMessageId) {
  const source = state.multisite.messages.find(row => row.id === sourceMessageId && row.workId === group.workId)
  if (!source || source.historical || !A2A_GROUP_MESSAGE_KINDS.includes(source.kind)) throw error('FORBIDDEN')
  if (source.kind !== 'observation') { if (source.targetAttemptId !== execution.attempt_id) throw error('FORBIDDEN') }
  else if (!instant(source.createdAt) || Date.parse(source.createdAt) < Date.parse(member.joinedAt)) throw error('FORBIDDEN')
  return source
}
function sourceBody(state, source) {
  if (source.kind !== 'dependency_result') return { text: source.text, refs: source.evidenceRefs ?? [] }
  const result = state.multisite.results.find(row => row.id === source.resultRef && !row.historical && row.workId === source.workId)
  if (!result) throw error('FORBIDDEN')
  return { text: result.payload.text ?? result.payload.summary ?? '', refs: result.payload.evidenceRefs ?? [] }
}

export function createA2aWorkGroups({ store, nodes, workspaceId, clock = () => Date.now() }) {
  if (!store?.read || !store?.update || !nodes?.authenticate) throw new Error('A2A Work groups require the production Store and Node service')
  let closed = false, scanning, messageOffset = 0
  const timestamp = () => new Date(clock()).toISOString()
  function caller(state, auth, execution, { ack = false } = {}) {
    exact(execution, BINDING_FIELDS)
    if (Object.keys(execution).length !== BINDING_FIELDS.length || auth?.remote !== true || workspaceId && auth.workspaceId !== workspaceId) throw error('FORBIDDEN')
    assertNodeCaller(state, auth, execution, { receiptReplay: ack })
    const work = mappedWork(state, execution.work_id, auth.workspaceId), group = state.a2aProtocol.groups.find(row => row.workId === work?.id && row.workspaceId === auth.workspaceId)
    const member = group?.members.find(row => row.employeeId === execution.agent_id)
    if (!work || !group || !member) throw error('FORBIDDEN')
    if (!ack) authorizeMultisiteExecution(state, execution, { workspaceId: auth.workspaceId, nodeId: auth.nodeId })
    return { work, group, member }
  }
  function messageAccess(state, auth, execution, delivery) {
    const access = caller(state, auth, execution)
    if (!ready(state, access.group) || delivery.groupId !== access.group.id || delivery.recipientEmployeeId !== execution.agent_id || !sameBinding(delivery.receiverBinding, execution) || delivery.revokedBy) throw error('FORBIDDEN')
    const source = sourceFor(state, access.group, access.member, execution, delivery.sourceMessageId)
    if (source.instructionRevision !== access.work.instructionRevision) throw error('REVISION_CONFLICT')
    const current = state.multisite.attempts.find(row => row.attempt_id === execution.attempt_id), input = state.multisite.inputs.find(row => row.workId === access.work.id && row.revision === access.work.instructionRevision)
    if (!input || current.instruction_revision !== access.work.instructionRevision || current.observed_revision < access.work.instructionRevision || !hasConsumedExecutionMessage(state, execution, messageId(input.id, execution.attempt_id, execution.session_id))) throw error('INPUT_CONSUMPTION_PENDING')
    const body = sourceBody(state, source), executionAccess = authorizeMultisiteExecution(state, execution, { workspaceId: auth.workspaceId, nodeId: auth.nodeId })
    for (const ref of body.refs) {
      if (ref.kind === 'evidence') { assertEvidenceReader(state, execution, access.work.instructionRevision, ref); continue }
      if (ref.kind === 'attachment') {
        if (!executionAccess.refs.some(row => row.attachmentId === ref.id && row.version === ref.version && row.sha256 === ref.sha256)) throw error('FORBIDDEN')
      } else if (ref.kind === 'artifact') {
        const artifact = state.artifacts.find(row => row.id === ref.id && row.workId === access.work.id && row.version === ref.version && row.sha256 === ref.sha256)
        if (!artifact) throw error('FORBIDDEN')
        authorizeReadyArtifactRead(state, artifact)
      } else throw error('FORBIDDEN')
    }
    return { ...access, source, body }
  }
  function locate(state, execution, payload) {
    const row = state.a2aProtocol.deliveries.find(row => row.workId === execution.work_id && row.recipientEmployeeId === execution.agent_id && sameBinding(row.receiverBinding, execution) && (payload.deliveryId ? row.id === payload.deliveryId : row.locator === payload.locator))
    if (!row || payload.locator !== undefined && row.locator !== payload.locator) throw error('FORBIDDEN')
    return row
  }
  function request(operation, payload) {
    exact(payload, operation === 'receive' ? ['operationId'] : ['operationId', 'deliveryId', 'locator', 'payloadDigest'])
    if (!['receive', 'ack'].includes(operation) || text(payload.operationId).length > 200) throw error('INVALID_REQUEST')
    if (operation === 'ack' && (!payload.deliveryId && !payload.locator || !/^[a-f0-9]{64}$/.test(payload.payloadDigest))) throw error('INVALID_REQUEST')
  }
  async function verifyReply(auth, execution, operation, payload, reply) {
    request(operation, payload)
    const state = await store.read(), access = caller(state, auth, execution, { ack: operation === 'ack' })
    if (reply.schema !== A2A_WORK_GROUP_SCHEMA || reply.operation !== operation || reply.operationId !== payload.operationId || reply.groupId !== access.group.id || reply.contextId !== access.member.contextId) throw error('FORBIDDEN')
    if (operation === 'receive') {
      if (!ready(state, access.group) || !Array.isArray(reply.deliveries) || reply.deliveries.length > RECEIVE_LIMIT) throw error('FORBIDDEN')
      for (const item of reply.deliveries) {
        const delivery = locate(state, execution, item)
        if (!delivery.offeredAt || delivery.locator !== item.locator || item.payloadDigest !== a2aNoticeDigest(access.group, delivery)) throw error('FORBIDDEN')
        messageAccess(state, auth, execution, delivery)
      }
    } else {
      const delivery = locate(state, execution, payload)
      if (!delivery.offeredAt || !delivery.metadataAck || delivery.metadataAck.operationId !== payload.operationId || delivery.metadataAck.payloadDigest !== payload.payloadDigest || reply.deliveryId !== delivery.id || reply.locator !== delivery.locator || reply.payloadDigest !== payload.payloadDigest || reply.accepted !== true) throw error('FORBIDDEN')
    }
    return reply
  }
  async function handle(auth, execution, operation, payload) {
    if (closed) throw error('FORBIDDEN')
    request(operation, payload)
    let reply
    await store.update(state => {
      const access = caller(state, auth, execution, { ack: operation === 'ack' })
      if (operation === 'receive') {
        if (!ready(state, access.group)) throw error('FORBIDDEN')
        const deliveries = []
        for (const delivery of state.a2aProtocol.deliveries.filter(row => row.groupId === access.group.id && row.recipientEmployeeId === execution.agent_id && sameBinding(row.receiverBinding, execution) && !row.metadataAck && !row.revokedBy)) {
          try { messageAccess(state, auth, execution, delivery) } catch (cause) { if (['FORBIDDEN', 'REVISION_CONFLICT', 'INPUT_CONSUMPTION_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING'].includes(cause.code)) continue; throw cause }
          // An offer attempt is not a receiver receipt or an SDK consumption fact.
          delivery.offeredAt ??= timestamp()
          deliveries.push({ deliveryId: delivery.id, locator: delivery.locator, payloadDigest: a2aNoticeDigest(access.group, delivery) })
          if (deliveries.length === RECEIVE_LIMIT) break
        }
        reply = { schema: A2A_WORK_GROUP_SCHEMA, operation, operationId: payload.operationId, groupId: access.group.id, contextId: access.member.contextId, deliveries }
      } else {
        const delivery = locate(state, execution, payload), previous = state.a2aProtocol.deliveries.find(row => sameBinding(row.receiverBinding, execution) && row.metadataAck?.operationId === payload.operationId)
        if (!delivery.offeredAt || payload.payloadDigest !== a2aNoticeDigest(access.group, delivery)) throw error('FORBIDDEN')
        if (previous && previous.id !== delivery.id || delivery.metadataAck && (delivery.metadataAck.operationId !== payload.operationId || delivery.metadataAck.payloadDigest !== payload.payloadDigest)) throw error('IDEMPOTENCY_CONFLICT')
        delivery.metadataAck ??= { operationId: payload.operationId, payloadDigest: payload.payloadDigest, acceptedAt: timestamp() }
        reply = { schema: A2A_WORK_GROUP_SCHEMA, operation, operationId: payload.operationId, groupId: access.group.id, contextId: access.member.contextId, deliveryId: delivery.id, locator: delivery.locator, payloadDigest: payload.payloadDigest, accepted: true }
      }
      return state
    })
    await verifyReply(auth, execution, operation, payload, reply)
    return reply
  }
  async function resolveBody(auth, execution, locator) {
    if (closed) throw error('FORBIDDEN')
    text(locator)
    const read = state => {
      const delivery = locate(state, execution, { locator })
      if (!delivery.offeredAt) throw error('FORBIDDEN')
      const access = messageAccess(state, auth, execution, delivery)
      return { workId: access.work.id, sourceMessageId: access.source.id, kind: access.source.kind, revision: access.source.instructionRevision, text: access.body.text, evidenceCount: access.body.refs.length }
    }
    const result = read(await store.read()), final = read(await store.read())
    if (!isDeepStrictEqual(result, final)) throw error('FORBIDDEN')
    return final
  }
  async function scan() {
    if (closed) return
    return scanning ??= (async () => {
      await store.update(state => {
        const workIds = [...new Set(state.a2aProtocol.tasks.filter(row => !workspaceId || row.workspaceId === workspaceId).map(row => row.workId))]
        for (const workId of workIds) {
          const work = mappedWork(state, workId, workspaceId); if (!work) continue
          let group = state.a2aProtocol.groups.find(row => row.workId === work.id)
          if (!group) { group = { id: a2aGroupId(work.workspaceId, work.id), workspaceId: work.workspaceId, workId: work.id, createdAt: timestamp(), members: [], calibrations: [] }; state.a2aProtocol.groups.push(group) }
          for (const attempt of state.multisite.attempts.filter(row => row.work_id === work.id)) {
            if (group.members.some(row => row.employeeId === attempt.agent_id)) continue
            const command = a2aParticipantSource(state, work, attempt); if (!command || !instant(command.acceptedAt)) continue
            group.members.push({ employeeId: attempt.agent_id, contextId: randomUUID(), sourceAttemptId: attempt.attempt_id, sourceCommandKey: command.key, joinedAt: command.acceptedAt })
          }
          for (const removal of state.workMemberRemovals.filter(row => row.workId === work.id)) {
            for (const delivery of state.a2aProtocol.deliveries.filter(row => row.groupId === group.id && !row.metadataAck && workMemberAffected(state, row.receiverBinding, removal.employeeId))) delivery.revokedBy ??= removal.commandId
            if (!group.calibrations.some(row => row.employeeId === removal.employeeId && row.removalCommandId === removal.commandId)) group.calibrations.push({ employeeId: removal.employeeId, removalCommandId: removal.commandId, sourceDigest: digest(removal), calibratedAt: timestamp() })
          }
        }
        return state
      })
      // Required membership/revocation calibration remains committed if ordinary
      // opaque fanout has no capacity. The next scan resumes from real sources.
      await store.update(state => {
        const workIds = [...new Set(state.a2aProtocol.tasks.filter(row => !workspaceId || row.workspaceId === workspaceId).map(row => row.workId))]
        const sources = state.multisite.messages.filter(row => workIds.includes(row.workId) && A2A_GROUP_MESSAGE_KINDS.includes(row.kind) && !row.historical)
        if (messageOffset >= sources.length) messageOffset = 0
        const selected = sources.slice(messageOffset, messageOffset + SCAN_LIMIT); messageOffset += selected.length
        for (const source of selected) {
          const group = state.a2aProtocol.groups.find(row => row.workId === source.workId), work = state.works.find(row => row.id === source.workId)
          if (!group || !ready(state, group) || source.instructionRevision !== work.instructionRevision) continue
          for (const member of group.members) {
            const attempts = state.multisite.attempts.filter(row => row.work_id === group.workId && row.agent_id === member.employeeId && row.instruction_revision === work.instructionRevision && !['completed', 'cancelled', 'stopping', 'unknown'].includes(row.status) && state.multisite.delegations.some(delegation => delegation.id === row.delegation_id && delegation.currentAttemptId === row.attempt_id))
            if (attempts.length !== 1) continue
            const execution = normalizedA2aBinding(attempts[0]), id = a2aDeliveryId(group.id, source.id, member.employeeId)
            if (state.a2aProtocol.deliveries.some(row => row.id === id) || workMemberAffected(state, execution)) continue
            try { sourceFor(state, group, member, execution, source.id) } catch { continue }
            state.a2aProtocol.deliveries.push({ id, groupId: group.id, workspaceId: group.workspaceId, workId: group.workId, sourceMessageId: source.id, recipientEmployeeId: member.employeeId, receiverBinding: execution, locator: randomUUID(), createdAt: timestamp(), offeredAt: null, metadataAck: null, revokedBy: null })
          }
        }
        return state
      })
    })().catch(cause => { if (!isCloudOrdinaryCapacityError(cause)) throw cause }).finally(() => { scanning = undefined })
  }
  async function status(tuple) {
    exact(tuple, ['workspaceId', 'workId', 'employeeId', 'removalCommandId'])
    const value = { configured: false, workspaceId: tuple.workspaceId, workId: tuple.workId, employeeId: tuple.employeeId, removalCommandId: tuple.removalCommandId ?? null }
    try {
      const state = await store.read(), work = mappedWork(state, tuple.workId, tuple.workspaceId)
      if (!work || workspaceId && tuple.workspaceId !== workspaceId) return value
      value.configured = true
      const group = state.a2aProtocol.groups.find(row => row.workId === work.id), member = group?.members.find(row => row.employeeId === tuple.employeeId)
      if (!group || !member) return { ...value, status: 'unknown' }
      const removal = state.workMemberRemovals.find(row => row.workId === work.id && row.employeeId === tuple.employeeId)
      if (!removal) return { ...value, status: tuple.removalCommandId ? 'unknown' : ready(state, group) ? 'confirmed' : 'pending' }
      if (removal.commandId !== tuple.removalCommandId) return { ...value, status: 'unknown' }
      const matched = group.calibrations.some(row => row.employeeId === removal.employeeId && row.removalCommandId === removal.commandId && row.sourceDigest === digest(removal))
      const pending = state.a2aProtocol.deliveries.some(row => row.groupId === group.id && workMemberAffected(state, row.receiverBinding, removal.employeeId) && !row.metadataAck && !a2aDeliveryRevoked(state, row))
      return { ...value, status: matched && !pending ? 'confirmed' : 'pending' }
    } catch { return { ...value, configured: true, status: 'unknown' } }
  }
  return { handle, resolveBody, status, scan, verifyReply, async close() { closed = true; await scanning } }
}
