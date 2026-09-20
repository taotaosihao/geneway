import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { currentKnowledgeReference } from './knowledge-service.mjs'

const LINK_TTL_MS = 10 * 60 * 1000
const LINK_FAILURE_LIMIT = 5
const DELIVERY_OUTCOMES = new Set(['delivered', 'failed', 'unknown'])
const RECONCILED_OUTCOMES = new Set(['delivered', 'failed'])

export class ChannelServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ChannelServiceError'
    this.code = code
  }
}

export function createChannelService({
  store,
  clock = () => new Date().toISOString(),
  idFactory = randomUUID,
  randomBytesFactory = randomBytes,
  deliverLinkCode,
} = {}) {
  if (!store?.read || !store?.update) throw new TypeError('channel service 需要 store')

  async function authorizeDelivery({ deliveryId, retry = false } = {}) {
    let output, denied
    await store.update(state => {
      const delivery = state.deliveries.find(item => item.id === clean(deliveryId))
      if (!delivery) throw error('NOT_FOUND', '投递不存在')
      const expected = retry ? ['failed', 'blocked'] : ['pending']
      if (!expected.includes(delivery.status)) throw transitionError(delivery.status)
      const current = currentDeliveryAuthorization(state, delivery)
      if (!current) {
        denied = true
        output = { ...delivery, status: 'blocked', error: { code: 'DELIVERY_FORBIDDEN', message: '当前接收或内容范围不允许发送' }, updatedAt: now(clock) }
      } else {
        output = {
          ...delivery,
          status: 'sending',
          attempts: delivery.attempts + 1,
          authorizationRevisions: { app: current.app.revision, identity: current.identity.revision, conversation: current.conversation.revision },
          providerMessageId: undefined,
          error: undefined,
          updatedAt: now(clock),
        }
      }
      return { ...state, deliveries: replaceById(state.deliveries, compact(output)) }
    })
    if (denied) throw error('DELIVERY_FORBIDDEN', '当前接收或内容范围不允许发送')
    return deliveryDto(output)
  }

  async function validateSendClaim({ deliveryId } = {}) {
    let output, denied = false
    await store.update(state => {
      const delivery = state.deliveries.find(item => item.id === clean(deliveryId))
      if (!delivery) throw error('NOT_FOUND', '投递不存在')
      if (delivery.status !== 'sending') throw transitionError(delivery.status)
      if (!currentDeliveryAuthorization(state, delivery, { validateClaim: true })) {
        denied = true
        output = { ...delivery, status: 'blocked', error: { code: 'SEND_CLAIM_INVALID', message: '发送前授权已失效' }, updatedAt: now(clock) }
        return { ...state, deliveries: replaceById(state.deliveries, output) }
      }
      output = delivery
      return state
    })
    if (denied) throw error('DELIVERY_FORBIDDEN', '发送前授权已失效')
    return deliveryDto(output)
  }

  return {
    async recover() {
      let recovered = 0
      await store.update(state => ({
        ...state,
        deliveries: state.deliveries.map(delivery => {
          if (delivery.status !== 'sending') return delivery
          recovered += 1
          return { ...delivery, status: 'unknown', error: { code: 'RECOVERY_UNKNOWN', message: '发送效果待核对' }, updatedAt: now(clock) }
        }),
      }))
      return { recoveredDeliveries: recovered, startedMessages: 0, retriedDeliveries: 0 }
    },

    async listChannelApps(actor) {
      const state = await store.read(), member = requireMember(state, actor)
      return state.channelApps.filter(app => member.role === 'admin' || (app.enabled && app.status === 'active')).map(app => appDto(app, member.role === 'admin'))
    },

    async upsertChannelApp(actor, input = {}) {
      let output
      await store.update(state => {
        requireAdmin(state, actor)
        const id = clean(input.id) ?? `channel-app-${idFactory()}`
        const current = state.channelApps.find(item => item.id === id)
        const provider = requiredId(input.provider ?? current?.provider, 'provider')
        const providerAppId = requiredOfficialId(input.providerAppId ?? current?.providerAppId, 'providerAppId')
        const providerTenantId = requiredOfficialId(input.providerTenantId ?? current?.providerTenantId, 'providerTenantId')
        const credentialRef = credentialReference(input.credentialRef ?? current?.credentialRef)
        const enabled = input.enabled ?? current?.enabled ?? true
        const allowedScopes = idList(input.allowedScopes ?? current?.allowedScopes, 'allowedScopes')
        const requestedStatus = input.status ?? (current?.status === 'disabled' ? 'active' : current?.status) ?? 'active'
        const status = enabled === false ? 'disabled' : requestedStatus
        if (typeof enabled !== 'boolean' || !allowedScopes.length || (enabled ? !['active', 'unavailable'].includes(status) : status !== 'disabled')) throw error('INVALID_REQUEST', '渠道应用配置无效')
        if (current && [provider, providerAppId, providerTenantId].some((value, index) => value !== [current.provider, current.providerAppId, current.providerTenantId][index])) throw error('INVALID_REQUEST', '渠道应用官方 identity 不可原地更换')
        if (state.channelApps.some(item => item.id !== id && item.provider === provider && item.providerAppId === providerAppId && item.providerTenantId === providerTenantId)) throw error('CONFLICT', '渠道应用官方 identity 已存在')
        const timestamp = now(clock)
        output = { id, provider, providerAppId, providerTenantId, credentialRef, enabled, allowedScopes, revision: current ? current.revision + 1 : 1, status, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp }
        const deliveries = current
          ? invalidateClaims(state.deliveries, item => item.channelAppId === id && (item.status === 'sending' || (!enabled && item.status === 'pending')), timestamp, 'APP_CHANGED', '渠道应用配置已变化')
          : state.deliveries
        return { ...state, channelApps: current ? replaceById(state.channelApps, output) : [...state.channelApps, output], deliveries }
      })
      return appDto(output, true)
    },

    async issueLinkCode(actor, { channelAppId } = {}) {
      if (typeof deliverLinkCode !== 'function') throw error('UNAVAILABLE', '关联码展示入口未配置')
      const bytes = randomBytesFactory(32)
      if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw error('INTERNAL_ERROR', '关联码生成失败')
      const code = bytes.toString('base64url'), digest = sha256(code)
      let output
      await store.update(state => {
        const timestamp = now(clock), member = requireMember(state, actor), app = activeApp(state, channelAppId)
        state = expireLinks(state, timestamp)
        state = closeLinks(state, link => link.memberId === member.id && link.channelAppId === app.id && ['active', 'matched'].includes(link.status), 'cancelled', timestamp)
        output = { id: `link-${idFactory()}`, channelAppId: app.id, memberId: member.id, digest, status: 'active', failedAttempts: 0, expiresAt: new Date(Date.parse(timestamp) + LINK_TTL_MS).toISOString(), createdAt: timestamp, updatedAt: timestamp }
        return { ...state, linkCodes: [...state.linkCodes, output] }
      })
      try {
        await deliverLinkCode({ memberId: output.memberId, channelAppId: output.channelAppId, code, expiresAt: output.expiresAt })
      } catch (cause) {
        await store.update(state => closeLinks(state, link => link.id === output.id && link.status === 'active', 'cancelled', now(clock)))
        throw error('UNAVAILABLE', '关联码展示失败', cause)
      }
      return linkDto(output)
    },

    async matchLinkCode(input = {}) {
      const code = typeof input.code === 'string' ? input.code : ''
      const digest = sha256(code), timestamp = now(clock)
      let output, invalid = false
      await store.update(state => {
        state = expireLinks(state, timestamp)
        const link = state.linkCodes.find(item => item.digest === digest)
        const app = state.channelApps.find(item => item.id === clean(input.channelAppId))
        const correct = link?.status === 'active' && link.channelAppId === app?.id && app.enabled === true && app.status === 'active'
          && input.conversationType === 'private' && validOfficialId(input.providerUserId) && validOfficialId(input.providerConversationId)
        if (!correct) {
          invalid = true
          return link?.status === 'active' ? failLink(state, link, timestamp) : state
        }
        let identity = state.channelIdentities.find(item => item.channelAppId === app.id && item.providerUserId === input.providerUserId)
        let conversation = state.channelConversations.find(item => item.channelAppId === app.id && item.providerConversationId === input.providerConversationId)
        if ((identity && (identity.memberId !== link.memberId || identity.status !== 'unlinked')) || (conversation && (conversation.memberId !== link.memberId || conversation.status !== 'unlinked'))) {
          invalid = true
          return failLink(state, link, timestamp)
        }
        identity = identity
          ? { ...identity, status: 'pending', revision: identity.revision + 1, updatedAt: timestamp, unlinkedAt: undefined }
          : { id: `channel-identity-${idFactory()}`, channelAppId: app.id, providerUserId: input.providerUserId, memberId: link.memberId, verificationMethod: 'link-code', status: 'pending', revision: 1, createdAt: timestamp, updatedAt: timestamp }
        conversation = conversation
          ? { ...conversation, identityId: identity.id, status: 'pending', revision: conversation.revision + 1, allowedScopes: [...app.allowedScopes], updatedAt: timestamp, unlinkedAt: undefined }
          : { id: `channel-conversation-${idFactory()}`, channelAppId: app.id, providerConversationId: input.providerConversationId, provider: app.provider, identityId: identity.id, memberId: link.memberId, type: 'private', allowedScopes: [...app.allowedScopes], verificationMethod: 'link-code', status: 'pending', revision: 1, createdAt: timestamp, updatedAt: timestamp }
        output = { ...link, status: 'matched', matchedIdentityId: identity.id, matchedConversationId: conversation.id, matchedAt: timestamp, updatedAt: timestamp }
        return {
          ...state,
          channelIdentities: state.channelIdentities.some(item => item.id === identity.id) ? replaceById(state.channelIdentities, compact(identity)) : [...state.channelIdentities, identity],
          channelConversations: state.channelConversations.some(item => item.id === conversation.id) ? replaceById(state.channelConversations, compact(conversation)) : [...state.channelConversations, conversation],
          linkCodes: replaceById(state.linkCodes, output),
        }
      })
      if (invalid) throw invalidLink()
      return linkDto(output)
    },

    async confirmLink(actor, { linkCodeId } = {}) {
      const timestamp = now(clock)
      let output, invalid = false
      await store.update(state => {
        state = expireLinks(state, timestamp)
        const member = requireMember(state, actor), link = state.linkCodes.find(item => item.id === clean(linkCodeId))
        const app = state.channelApps.find(item => item.id === link?.channelAppId)
        const identity = state.channelIdentities.find(item => item.id === link?.matchedIdentityId)
        const conversation = state.channelConversations.find(item => item.id === link?.matchedConversationId)
        if (link?.status !== 'matched' || link.memberId !== member.id || app?.enabled !== true || app.status !== 'active' || identity?.status !== 'pending' || conversation?.status !== 'pending') {
          invalid = true
          return state
        }
        const activeIdentity = { ...identity, status: 'active', updatedAt: timestamp }
        const activeConversation = { ...conversation, status: 'active', updatedAt: timestamp }
        output = { ...link, status: 'consumed', consumedAt: timestamp, updatedAt: timestamp }
        return { ...state, channelIdentities: replaceById(state.channelIdentities, activeIdentity), channelConversations: replaceById(state.channelConversations, activeConversation), linkCodes: replaceById(state.linkCodes, output) }
      })
      if (invalid) throw invalidLink()
      return linkDto(output)
    },

    async expireLinkCodes() {
      let expired = 0
      const timestamp = now(clock)
      await store.update(state => {
        const next = expireLinks(state, timestamp)
        expired = next.linkCodes.filter((item, index) => item.status === 'expired' && state.linkCodes[index]?.status !== 'expired').length
        return next
      })
      return { expired }
    },

    async unlinkIdentity(actor, { identityId } = {}) {
      let output
      await store.update(state => {
        const timestamp = now(clock), member = requireMember(state, actor)
        const identity = state.channelIdentities.find(item => item.id === clean(identityId))
        if (!identity || (identity.memberId !== member.id && member.role !== 'admin')) throw error('NOT_FOUND', '渠道身份不存在')
        if (identity.status === 'unlinked') { output = identity; return state }
        output = { ...identity, status: 'unlinked', revision: identity.revision + 1, updatedAt: timestamp, unlinkedAt: timestamp }
        const conversations = state.channelConversations.map(item => item.identityId === identity.id && item.status !== 'unlinked' ? { ...item, status: 'unlinked', revision: item.revision + 1, updatedAt: timestamp, unlinkedAt: timestamp } : item)
        const deliveries = invalidateClaims(state.deliveries, item => item.targetIdentityId === identity.id && ['pending', 'sending'].includes(item.status), timestamp, 'IDENTITY_UNLINKED', '渠道身份已解绑')
        return { ...state, channelIdentities: replaceById(state.channelIdentities, output), channelConversations: conversations, deliveries, linkCodes: closeLinks(state, link => link.memberId === identity.memberId && link.channelAppId === identity.channelAppId && ['active', 'matched'].includes(link.status), 'cancelled', timestamp).linkCodes }
      })
      return identityDto(output)
    },

    async setDefaultDispatch(actor, { conversationId, employeeId, skillId, capabilityId, connectionId } = {}) {
      let output
      await store.update(state => {
        const timestamp = now(clock), member = requireMember(state, actor)
        const conversation = state.channelConversations.find(item => item.id === clean(conversationId) && item.memberId === member.id && item.status === 'active')
        if (!conversation || !state.channelApps.some(item => item.id === conversation.channelAppId && item.enabled && item.status === 'active')) throw error('NOT_FOUND', '渠道会话不存在')
        const employee = state.employees.find(item => item.id === clean(employeeId) && item.enabled === true && member.employeeIds.includes(item.id))
        const skill = state.skills.find(item => item.id === clean(skillId) && item.enabled === true && employee?.skillIds?.includes(item.id) && item.capabilityId === clean(capabilityId))
        const connection = connectionId === undefined || connectionId === null || connectionId === '' ? undefined : state.connections.find(item => item.id === clean(connectionId) && item.enabled === true && employee?.connectionIds?.includes(item.id) && item.skillIds?.includes(skill?.id))
        if (!employee || !skill || (connectionId !== undefined && connectionId !== null && connectionId !== '' && !connection)) throw error('FORBIDDEN', '默认派发绑定当前未获准')
        output = { ...conversation, defaultDispatch: compact({ employeeId: employee.id, skillId: skill.id, capabilityId: skill.capabilityId, connectionId: connection?.id }), revision: conversation.revision + 1, updatedAt: timestamp }
        return { ...state, channelConversations: replaceById(state.channelConversations, output) }
      })
      return conversationDto(output)
    },

    async recordInbound(input = {}) {
      let output, deduplicated = false
      await store.update(state => {
        const app = state.channelApps.find(item => item.id === clean(input.channelAppId))
        if (!app) throw error('NOT_FOUND', '渠道应用不存在')
        const providerEventId = optionalOfficialId(input.providerEventId, 'providerEventId')
        const providerMessageId = optionalOfficialId(input.providerMessageId, 'providerMessageId')
        if (!providerEventId && !providerMessageId) throw error('INVALID_REQUEST', '渠道消息缺少官方稳定 ID')
        const existing = state.channelMessages.find(item => item.channelAppId === app.id && ((providerEventId && item.providerEventId === providerEventId) || (providerMessageId && item.providerMessageId === providerMessageId)))
        if (existing) { output = existing; deduplicated = true; return state }
        const providerConversationId = requiredOfficialId(input.providerConversationId, 'providerConversationId')
        const providerUserId = requiredOfficialId(input.providerUserId, 'providerUserId')
        const body = typeof input.text === 'string' && input.text.length <= 16_384 ? input.text : undefined
        if (body === undefined) throw error('INVALID_REQUEST', '仅支持有界文本消息')
        if (state.linkCodes.some(link => link.digest === sha256(body.trim()))) throw error('INVALID_REQUEST', '关联码必须通过关联入口处理')
        const identity = state.channelIdentities.find(item => item.channelAppId === app.id && item.providerUserId === providerUserId && item.status === 'active')
        const conversation = state.channelConversations.find(item => item.channelAppId === app.id && item.providerConversationId === providerConversationId && item.status === 'active')
        const allowed = app.enabled && app.status === 'active' && identity && conversation && conversation.identityId === identity.id && conversation.memberId === identity.memberId
        const timestamp = now(clock)
        output = compact({ id: `channel-message-${idFactory()}`, channelAppId: app.id, provider: app.provider, providerEventId, providerMessageId, providerConversationId, providerUserId, conversationId: conversation?.id, senderIdentityId: identity?.id, direction: 'inbound', text: body, receivedAt: input.receivedAt ? requiredTimestamp(input.receivedAt, 'receivedAt') : timestamp, persistedAt: timestamp, status: allowed ? 'received' : 'unhandled', error: allowed ? undefined : { code: 'CHANNEL_UNAVAILABLE', message: '渠道身份或应用当前不可用' } })
        return { ...state, channelMessages: [...state.channelMessages, output] }
      })
      return { message: messageDto(output), deduplicated }
    },

    async bindMessageWork(actor, { messageId, workId } = {}) {
      let output
      await store.update(state => {
        const member = requireMember(state, actor), message = state.channelMessages.find(item => item.id === clean(messageId)), work = state.works.find(item => item.id === clean(workId))
        const identity = state.channelIdentities.find(item => item.id === message?.senderIdentityId)
        if (!message || !work || identity?.memberId !== member.id || work.ownerMemberId !== member.id) throw error('FORBIDDEN', '消息与工作不可绑定')
        if (message.status === 'accepted') {
          if (message.workId !== work.id) throw error('FORBIDDEN', '消息已绑定其他工作')
          output = message
          return state
        }
        const app = state.channelApps.find(item => item.id === message.channelAppId && item.enabled === true && item.status === 'active')
        const conversation = state.channelConversations.find(item => item.id === message.conversationId && item.status === 'active')
        if (message.status !== 'received' || message.direction !== 'inbound' || identity.status !== 'active' || !app || !conversation
          || identity.channelAppId !== app.id || conversation.channelAppId !== app.id || conversation.identityId !== identity.id || conversation.memberId !== member.id
          || message.providerUserId !== identity.providerUserId || message.providerConversationId !== conversation.providerConversationId) throw error('FORBIDDEN', '消息与工作不可绑定')
        output = compact({ ...message, workId: work.id, status: 'accepted', error: undefined })
        return { ...state, channelMessages: replaceById(state.channelMessages, output) }
      })
      return messageDto(output)
    },

    async createDelivery(actor, input = {}) {
      let output, deduplicated = false
      await store.update(state => {
        const member = requireMember(state, actor), app = state.channelApps.find(item => item.id === clean(input.channelAppId))
        const requestId = requiredId(input.requestId, 'requestId')
        const existing = state.deliveries.find(item => item.channelAppId === app?.id && item.requestId === requestId)
        if (existing) {
          if (!state.works.some(item => item.id === existing.workId && item.ownerMemberId === member.id)) throw error('NOT_FOUND', '投递不存在')
          if (!sameDeliveryTuple(existing, deliveryTuple(input))) throw error('FORBIDDEN', '幂等投递参数不一致')
          output = existing
          deduplicated = true
          return state
        }
        const work = state.works.find(item => item.id === clean(input.workId) && item.ownerMemberId === member.id)
        const identity = state.channelIdentities.find(item => item.id === clean(input.targetIdentityId) && item.memberId === member.id && item.channelAppId === app?.id)
        const conversation = state.channelConversations.find(item => item.id === clean(input.targetConversationId) && item.memberId === member.id && item.channelAppId === app?.id && item.identityId === identity?.id)
        const resultId = input.resultId === undefined ? undefined : clean(input.resultId)
        const channelMessageId = input.channelMessageId === undefined ? undefined : clean(input.channelMessageId)
        if (!app || !work || !identity || !conversation || (resultId && !work.results.some(item => item.id === resultId)) || (channelMessageId && !state.channelMessages.some(item => item.id === channelMessageId && item.channelAppId === app.id))) throw error('FORBIDDEN', '投递目标或内容引用无效')
        const timestamp = now(clock)
        output = compact({ id: `delivery-${idFactory()}`, channelAppId: app.id, requestId, provider: app.provider, workId: work.id, resultId, channelMessageId, targetConversationId: conversation.id, targetIdentityId: identity.id, contentScope: requiredId(input.contentScope, 'contentScope'), status: 'pending', attempts: 0, createdAt: timestamp, updatedAt: timestamp })
        return { ...state, deliveries: [...state.deliveries, output] }
      })
      return { delivery: deliveryDto(output), deduplicated }
    },

    authorizeDelivery,
    retryDelivery(input = {}) { return authorizeDelivery({ ...input, retry: true }) },
    validateSendClaim,

    async recordDeliveryOutcome({ deliveryId, status, providerMessageId, error: outcomeError } = {}) {
      if (!DELIVERY_OUTCOMES.has(status)) throw error('INVALID_REQUEST', '投递结果状态无效')
      return transitionDelivery(store, clock, deliveryId, ['sending'], status, providerMessageId, outcomeError)
    },

    async reconcileDelivery({ deliveryId, status, providerMessageId, error: outcomeError } = {}) {
      if (!RECONCILED_OUTCOMES.has(status)) throw error('INVALID_REQUEST', '核对结果状态无效')
      return transitionDelivery(store, clock, deliveryId, ['unknown'], status, providerMessageId, outcomeError)
    },

    async cancelDelivery(actor, { deliveryId } = {}) {
      let output
      await store.update(state => {
        const member = requireMember(state, actor), delivery = state.deliveries.find(item => item.id === clean(deliveryId)), work = state.works.find(item => item.id === delivery?.workId)
        if (!delivery || work?.ownerMemberId !== member.id) throw error('NOT_FOUND', '投递不存在')
        if (delivery.status !== 'pending') throw transitionError(delivery.status)
        output = { ...delivery, status: 'cancelled', updatedAt: now(clock) }
        return { ...state, deliveries: replaceById(state.deliveries, output) }
      })
      return deliveryDto(output)
    },

    async memberChannelState(actor) {
      const state = await store.read(), member = requireMember(state, actor)
      const identityIds = new Set(state.channelIdentities.filter(item => item.memberId === member.id).map(item => item.id))
      const workIds = new Set(state.works.filter(item => item.ownerMemberId === member.id).map(item => item.id))
      return {
        identities: state.channelIdentities.filter(item => identityIds.has(item.id)).map(identityDto),
        conversations: state.channelConversations.filter(item => identityIds.has(item.identityId)).map(conversationDto),
        messages: state.channelMessages.filter(item => item.senderIdentityId && identityIds.has(item.senderIdentityId)).map(messageDto),
        deliveries: state.deliveries.filter(item => workIds.has(item.workId)).map(deliveryDto),
        linkCodes: state.linkCodes.filter(item => item.memberId === member.id).map(linkDto),
      }
    },
  }
}

async function transitionDelivery(store, clock, deliveryId, from, status, providerMessageId, outcomeError) {
  let output
  await store.update(state => {
    const delivery = state.deliveries.find(item => item.id === clean(deliveryId))
    if (!delivery) throw error('NOT_FOUND', '投递不存在')
    if (!from.includes(delivery.status)) throw transitionError(delivery.status)
    const messageId = providerMessageId === undefined ? undefined : requiredOfficialId(providerMessageId, 'providerMessageId')
    if (status === 'delivered' && !messageId) throw error('INVALID_REQUEST', '已送达必须包含平台 message ID')
    output = compact({ ...delivery, status, providerMessageId: messageId ?? delivery.providerMessageId, error: status === 'delivered' ? undefined : safeOutcomeError(outcomeError, status), updatedAt: now(clock) })
    return { ...state, deliveries: replaceById(state.deliveries, output) }
  })
  return deliveryDto(output)
}

function currentDeliveryAuthorization(state, delivery, { validateClaim = false } = {}) {
  const app = state.channelApps.find(item => item.id === delivery.channelAppId && item.enabled === true && item.status === 'active')
  const identity = state.channelIdentities.find(item => item.id === delivery.targetIdentityId && item.status === 'active')
  const conversation = state.channelConversations.find(item => item.id === delivery.targetConversationId && item.status === 'active')
  const work = state.works.find(item => item.id === delivery.workId)
  const member = state.members.find(item => item.id === work?.ownerMemberId && item.enabled === true)
  const employee = state.employees.find(item => item.id === work?.employeeId && item.enabled === true && member?.employeeIds.includes(item.id))
  const skill = state.skills.find(item => item.id === work?.skillId && item.enabled === true && employee?.skillIds?.includes(item.id) && item.capabilityId === work.capabilityId)
  const connection = work?.connectionId === undefined ? undefined : state.connections.find(item => item.id === work.connectionId && item.enabled === true && item.status === 'ready' && employee?.connectionIds?.includes(item.id) && item.skillIds?.includes(skill?.id))
  const result = delivery.resultId === undefined ? undefined : work?.results.find(item => item.id === delivery.resultId)
  const revisions = delivery.authorizationRevisions
  if (!app || !identity || !conversation || !work || !member || !employee || !skill || (work.connectionId !== undefined && !connection)
    || identity.channelAppId !== app.id || conversation.channelAppId !== app.id || identity.memberId !== member.id || conversation.memberId !== member.id || conversation.identityId !== identity.id
    || !app.allowedScopes.includes(delivery.contentScope) || !conversation.allowedScopes.includes(delivery.contentScope) || (delivery.resultId !== undefined && !result)
    || result?.knowledgeDependencyRefs?.some(ref => !currentKnowledgeReference(state, ref, member.id, result.employeeId ?? work.employeeId))) return undefined
  if (validateClaim && (!revisions || revisions.app !== app.revision || revisions.identity !== identity.revision || revisions.conversation !== conversation.revision)) return undefined
  return { app, identity, conversation, work, member, employee, skill, connection, result }
}

function invalidateClaims(deliveries, predicate, timestamp, code, message) {
  return deliveries.map(delivery => {
    if (!predicate(delivery)) return delivery
    const unknown = delivery.status === 'sending'
    return { ...delivery, status: unknown ? 'unknown' : 'blocked', error: { code: unknown ? 'DELIVERY_UNKNOWN' : code, message: unknown ? '发送效果待核对' : message }, updatedAt: timestamp }
  })
}

function deliveryTuple(value) {
  return {
    workId: clean(value.workId),
    resultId: clean(value.resultId),
    channelMessageId: clean(value.channelMessageId),
    targetConversationId: clean(value.targetConversationId),
    targetIdentityId: clean(value.targetIdentityId),
    contentScope: clean(value.contentScope),
  }
}

function sameDeliveryTuple(delivery, supplied) {
  return Object.keys(supplied).every(key => delivery[key] === supplied[key])
}

function expireLinks(state, timestamp) {
  return closeLinks(state, link => ['active', 'matched'].includes(link.status) && Date.parse(link.expiresAt) <= Date.parse(timestamp), 'expired', timestamp)
}

function closeLinks(state, predicate, status, timestamp) {
  const closing = state.linkCodes.filter(predicate)
  if (!closing.length) return state
  const identityIds = new Set(closing.map(item => item.matchedIdentityId).filter(Boolean)), conversationIds = new Set(closing.map(item => item.matchedConversationId).filter(Boolean))
  return {
    ...state,
    linkCodes: state.linkCodes.map(link => predicate(link) ? { ...link, status, updatedAt: timestamp } : link),
    channelIdentities: state.channelIdentities.map(identity => identityIds.has(identity.id) && identity.status === 'pending' ? { ...identity, status: 'unlinked', revision: identity.revision + 1, updatedAt: timestamp, unlinkedAt: timestamp } : identity),
    channelConversations: state.channelConversations.map(conversation => conversationIds.has(conversation.id) && conversation.status === 'pending' ? { ...conversation, status: 'unlinked', revision: conversation.revision + 1, updatedAt: timestamp, unlinkedAt: timestamp } : conversation),
  }
}

function failLink(state, link, timestamp) {
  const attempts = link.failedAttempts + 1
  const failed = { ...link, failedAttempts: attempts, status: attempts >= LINK_FAILURE_LIMIT ? 'cancelled' : link.status, updatedAt: timestamp }
  return { ...state, linkCodes: replaceById(state.linkCodes, failed) }
}

function activeApp(state, id) {
  const app = state.channelApps.find(item => item.id === clean(id) && item.enabled === true && item.status === 'active')
  if (!app) throw error('NOT_FOUND', '渠道应用不可用')
  return app
}

function requireMember(state, actor) {
  const id = clean(actor?.id ?? actor?.memberId), member = state.members.find(item => item.id === id && item.enabled === true)
  if (!member) throw error('UNAUTHORIZED', '会话无效')
  return member
}

function requireAdmin(state, actor) {
  const member = requireMember(state, actor)
  if (member.role !== 'admin') throw error('FORBIDDEN', '需要管理员权限')
  return member
}

function appDto(app, admin) {
  const value = structuredClone(app)
  if (!admin) delete value.credentialRef
  return value
}
function identityDto(identity) { return structuredClone(identity) }
function conversationDto(conversation) { return structuredClone(conversation) }
function messageDto(message) { return structuredClone(message) }
function deliveryDto(delivery) { return structuredClone(delivery) }
function linkDto(link) { const value = structuredClone(link); delete value.digest; return value }

function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function replaceById(items, value) { return items.map(item => item.id === value.id ? value : item) }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) }
function clean(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function validOfficialId(value) { return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 512 }
function requiredOfficialId(value, label) { if (!validOfficialId(value)) throw error('INVALID_REQUEST', `${label} 无效`); return value }
function optionalOfficialId(value, label) { return value === undefined || value === null || value === '' ? undefined : requiredOfficialId(value, label) }
function requiredId(value, label) { const result = clean(value); if (!result || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(result)) throw error('INVALID_REQUEST', `${label} 无效`); return result }
function credentialReference(value) { const result = clean(value); if (!result || !/^[A-Z][A-Z0-9_]{2,127}$/.test(result)) throw error('INVALID_REQUEST', 'credentialRef 必须是仓库外凭据引用'); return result }
function idList(value, label) { if (!Array.isArray(value)) throw error('INVALID_REQUEST', `${label} 无效`); const result = value.map(item => requiredId(item, label)); if (new Set(result).size !== result.length) throw error('INVALID_REQUEST', `${label} 重复`); return result }
function requiredTimestamp(value, label) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw error('INVALID_REQUEST', `${label} 无效`); return value }
function now(clock) { return requiredTimestamp(clock(), '当前时间') }
function safeOutcomeError(value, status) { const code = typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : status === 'unknown' ? 'DELIVERY_UNKNOWN' : 'DELIVERY_FAILED'; return { code, message: status === 'unknown' ? '发送效果待核对' : '发送失败' } }
function invalidLink() { return error('LINK_CODE_INVALID', '关联码无效或已过期') }
function transitionError(status) { return error('INVALID_STATE', status === 'unknown' ? '发送效果待核对，不能直接重试' : '投递状态不允许此操作') }
function error(code, message, cause) { return Object.assign(new ChannelServiceError(code, message), cause ? { cause } : {}) }
