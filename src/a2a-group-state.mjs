import { isDeepStrictEqual } from 'node:util'
import { BINDING_FIELDS, binding, digest, error, exact, key } from '../packages/agent-contracts/index.mjs'
import { workMemberAffected } from './work-member-removal.mjs'

export const emptyA2aGroups = () => ({ groups: [], deliveries: [] })
export const a2aGroupId = (workspaceId, workId) => key('a2a-group', workspaceId, workId)
export const a2aDeliveryId = (groupId, sourceMessageId, employeeId) => key('a2a-delivery', groupId, sourceMessageId, employeeId)
export const A2A_GROUP_MESSAGE_KINDS = Object.freeze(['observation', 'question', 'answer', 'dependency_result'])
const check = (condition, name) => { if (!condition) throw error('INVALID_STATE', 'A2A 群元数据无效：' + name) }
const string = value => typeof value === 'string' && value.length > 0
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const fields = (value, names) => { exact(value, names); check(Object.keys(value).length === names.length, '字段缺失') }
export const normalizedA2aBinding = attempt => binding({ ...attempt, session_id: attempt.session_id ?? `geneway-${attempt.launch_id}` })

export function a2aDeliveryRevoked(state, delivery) {
  const removal = state.workMemberRemovals.find(row => row.workspaceId === delivery.workspaceId && row.workId === delivery.workId && row.commandId === delivery.revokedBy)
  // An earlier ancestor removal already revoked this queue entry; a later
  // overlapping removal must preserve that original provenance.
  return !!removal && delivery.receiverBinding.work_id === delivery.workId && workMemberAffected(state, delivery.receiverBinding, removal.employeeId)
}

export function a2aParticipantSource(state, work, attempt) {
  if (attempt.work_id !== work.id) return null
  const delegation = state.multisite.delegations.find(row => row.id === attempt.delegation_id && row.workId === work.id && row.agentId === attempt.agent_id && row.parentDelegationId === attempt.parent_delegation_id)
  if (!delegation) return null
  if (attempt.parent_delegation_id !== null) return state.multisite.commands.find(row => row.workspaceId === work.workspaceId && row.reply.workId === work.id && row.reply.attemptId === attempt.attempt_id && row.reply.delegationId === attempt.delegation_id) ?? null
  // A Task selects one root, while its original create input proves all roots
  // admitted in that same transaction. Later inputs cannot establish joining.
  const task = state.a2aProtocol.tasks.find(row => row.workId === work.id && row.workspaceId === work.workspaceId && row.memberId === work.ownerMemberId)
  if (!task) return null
  return state.multisite.commands.find(row => row.workspaceId === work.workspaceId && row.issuerId === task.memberId && row.commandId === task.commandKey && row.key === key(work.workspaceId, task.memberId, task.commandKey) && row.reply.workId === work.id && row.acceptedAt === work.acceptedAt && state.multisite.inputs.some(input => input.id === key('input', work.id, task.memberId, task.commandKey) && input.workId === work.id && input.issuerId === task.memberId && input.revision === 1 && input.at === row.acceptedAt && input.deliveries.some(delivery => delivery.attemptId === attempt.attempt_id))) ?? null
}

export function a2aNotice(group, delivery) {
  const member = group.members.find(row => row.employeeId === delivery.recipientEmployeeId)
  return { schema: 'geneway.a2a.work-group/1', groupId: group.id, contextId: member.contextId, deliveryId: delivery.id, locator: delivery.locator }
}
export const a2aNoticeDigest = (group, delivery) => digest(a2aNotice(group, delivery))

export function validateA2aGroups(state) {
  const domain = state.a2aProtocol
  check(domain && Array.isArray(domain.tasks) && Array.isArray(domain.groups) && Array.isArray(domain.deliveries), '集合')
  check(domain.groups.length <= 10000 && domain.deliveries.length <= 30000, '容量')
  check(new Set(domain.groups.map(row => row.id)).size === domain.groups.length, '群重复')
  check(new Set(domain.deliveries.map(row => row.id)).size === domain.deliveries.length && new Set(domain.deliveries.map(row => row.locator)).size === domain.deliveries.length, '投递重复')
  const contexts = new Set()
  for (const group of domain.groups) {
    fields(group, ['id', 'workspaceId', 'workId', 'createdAt', 'members', 'calibrations'])
    const work = state.works.find(row => row.id === group.workId && row.workspaceId === group.workspaceId && row.workType === 'multisite')
    check(work && domain.tasks.some(row => row.workId === work.id && row.workspaceId === group.workspaceId), '正式 Task 来源')
    check(group.id === a2aGroupId(group.workspaceId, group.workId) && instant(group.createdAt), '群身份')
    check(Array.isArray(group.members) && Array.isArray(group.calibrations), '成员与校准')
    check(new Set(group.members.map(row => row.employeeId)).size === group.members.length, '成员重复')
    check(new Set(group.calibrations.map(row => row.employeeId + ':' + row.removalCommandId)).size === group.calibrations.length, '移除校准重复')
    for (const member of group.members) {
      fields(member, ['employeeId', 'contextId', 'sourceAttemptId', 'sourceCommandKey', 'joinedAt'])
      const attempt = state.multisite.attempts.find(row => row.attempt_id === member.sourceAttemptId && row.work_id === group.workId && row.agent_id === member.employeeId)
      const command = attempt && a2aParticipantSource(state, work, attempt)
      check(command && command.key === member.sourceCommandKey, '成员实际加入来源')
      check(instant(member.joinedAt) && member.joinedAt === command.acceptedAt && string(member.contextId) && !contexts.has(member.contextId) && !domain.tasks.some(row => row.contextId === member.contextId) && !state.multisite.attempts.some(row => row.session_id === member.contextId), '独立成员 context')
      contexts.add(member.contextId)
    }
    for (const calibration of group.calibrations) {
      fields(calibration, ['employeeId', 'removalCommandId', 'sourceDigest', 'calibratedAt'])
      const removal = state.workMemberRemovals.find(row => row.workspaceId === group.workspaceId && row.workId === group.workId && row.employeeId === calibration.employeeId && row.commandId === calibration.removalCommandId)
      check(removal && digest(removal) === calibration.sourceDigest && instant(calibration.calibratedAt), '原撤销事实校准')
      check(domain.deliveries.filter(row => row.groupId === group.id && workMemberAffected(state, row.receiverBinding, removal.employeeId)).every(row => row.metadataAck || a2aDeliveryRevoked(state, row)), '受影响队列未校准')
    }
  }
  const ackKeys = new Set()
  for (const delivery of domain.deliveries) {
    fields(delivery, ['id', 'groupId', 'workspaceId', 'workId', 'sourceMessageId', 'recipientEmployeeId', 'receiverBinding', 'locator', 'createdAt', 'offeredAt', 'metadataAck', 'revokedBy'])
    const group = domain.groups.find(row => row.id === delivery.groupId), source = state.multisite.messages.find(row => row.id === delivery.sourceMessageId && row.workId === delivery.workId)
    check(group && group.workId === delivery.workId && group.workspaceId === delivery.workspaceId && group.members.some(row => row.employeeId === delivery.recipientEmployeeId), '接收成员')
    check(source && A2A_GROUP_MESSAGE_KINDS.includes(source.kind) && !source.historical, '已提交消息')
    fields(delivery.receiverBinding, BINDING_FIELDS)
    const attempt = state.multisite.attempts.find(row => row.attempt_id === delivery.receiverBinding.attempt_id && row.work_id === delivery.workId && row.agent_id === delivery.recipientEmployeeId)
    check(attempt && isDeepStrictEqual(normalizedA2aBinding(attempt), delivery.receiverBinding), '真实接收绑定')
    check(source.kind === 'observation' || source.targetAttemptId === attempt.attempt_id, '定向接收者')
    const member = group.members.find(row => row.employeeId === delivery.recipientEmployeeId)
    check(source.kind !== 'observation' || instant(source.createdAt) && Date.parse(source.createdAt) >= Date.parse(member.joinedAt), '成员加入后的消息边界')
    check(delivery.id === a2aDeliveryId(group.id, source.id, attempt.agent_id) && string(delivery.locator) && instant(delivery.createdAt) && (delivery.offeredAt === null || instant(delivery.offeredAt)), '投递身份')
    if (delivery.metadataAck !== null) {
      fields(delivery.metadataAck, ['operationId', 'payloadDigest', 'acceptedAt'])
      const receipt = delivery.metadataAck, ackKey = key(delivery.receiverBinding, receipt.operationId)
      check(delivery.offeredAt && string(receipt.operationId) && receipt.payloadDigest === a2aNoticeDigest(group, delivery) && instant(receipt.acceptedAt) && !ackKeys.has(ackKey), '精确 metadata ACK')
      ackKeys.add(ackKey)
    }
    if (delivery.revokedBy !== null) {
      check(a2aDeliveryRevoked(state, delivery), '投递撤销来源')
    }
  }
  return state
}

export function assertA2aGroupsAppendOnly(before, after) {
  for (const previous of before.a2aProtocol?.groups ?? []) {
    const current = after.a2aProtocol.groups.find(row => row.id === previous.id)
    check(current && isDeepStrictEqual({ ...previous, members: [], calibrations: [] }, { ...current, members: [], calibrations: [] }), '群身份不可改写')
    check(isDeepStrictEqual(current.members.slice(0, previous.members.length), previous.members) && isDeepStrictEqual(current.calibrations.slice(0, previous.calibrations.length), previous.calibrations), '成员来源与移除校准不可改写')
  }
  for (const previous of before.a2aProtocol?.deliveries ?? []) {
    const current = after.a2aProtocol.deliveries.find(row => row.id === previous.id)
    check(current && isDeepStrictEqual({ ...previous, offeredAt: null, metadataAck: null, revokedBy: null }, { ...current, offeredAt: null, metadataAck: null, revokedBy: null }), '投递来源与接收绑定不可改写')
    for (const name of ['offeredAt', 'metadataAck', 'revokedBy']) if (previous[name] !== null) check(isDeepStrictEqual(current[name], previous[name]), '投递事实不可回退')
  }
}
