import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { currentKnowledgeReference } from './knowledge-service.mjs'

const LINK_TTL_MS = 10 * 60 * 1000
const LINK_FAILURE_LIMIT = 5
const CHANNEL_CAPABILITY_ID = 'gearjob-work-order-read'
const ACTIVE_WORK_EXECUTION = new Set(['accepted', 'running', 'cancel_requested'])
const DELIVERY_OUTCOMES = new Set(['delivered', 'failed', 'unknown'])
const RECONCILED_OUTCOMES = new Set(['delivered', 'failed'])
const FIXED_CONTENT = Object.freeze({
  'group.accepted': '已受理，后续仅通过已验证私聊反馈；详情请到 Web 查看。',
  'help.unsupported': '当前仅支持明确文本命令，请到 Web 处理其他内容。',
  'help.unavailable': '当前请求无法处理，请到 Web 核对。',
})

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
  workService,
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
    let output, transport, denied = false
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
      transport = deliveryEnvelope(state, delivery)
      return state
    })
    if (denied) throw error('DELIVERY_FORBIDDEN', '发送前授权已失效')
    return { ...transport, id: output.id, status: output.status }
  }

  async function handleInbound(input = {}) {
    if (!workService?.createWork || !workService?.followUp || !workService?.getWork || !workService?.cancel) throw error('UNAVAILABLE', '工作服务未配置')
    let reservation
    await store.update(state => {
      const resolved = findInbound(state, input)
      if (resolved.conflict) {
        const message = conflictInbound(state, input, resolved, clock, idFactory)
        if (resolved.unmatched) state = { ...state, channelMessages: [...state.channelMessages, message] }
        reservation = inboundReservation(state, message, { terminal: true })
        return state
      }
      let message = resolved.message
      if (!message) {
        state = ensureGroupConversation(state, input, clock, idFactory)
        message = newInbound(state, input, clock, idFactory)
        state = { ...state, channelMessages: [...state.channelMessages, message] }
      }
      if (['accepted', 'rejected', 'unhandled'].includes(message.status)) {
        const context = currentInboundContext(state, message)
        reservation = inboundReservation(state, message, { terminal: true, authorized: Boolean(context && (!message.command || commandStillAuthorized(state, context, message))) })
        return state
      }
      const reserved = reserveInbound(state, message, input, clock)
      reservation = reserved.reservation
      return reserved.state
    })

    if (reservation.terminal) {
      if (reservation.message.status === 'accepted' && !reservation.authorized) return { kind: 'error', ...inboundError('CHANNEL_AUTHORIZATION_CHANGED') }
      if (reservation.message.status === 'accepted' && reservation.message.command?.type === 'status') {
        const result = await workService.getWork({ id: reservation.memberId }, reservation.message.workId)
        return inboundOutput(reservation.message, result)
      }
      return inboundOutput(reservation.message)
    }
    if (reservation.suppressed) return { kind: 'error', ...inboundError('CHANNEL_AUTHORIZATION_CHANGED') }
    if (reservation.message.status !== 'reserved') return inboundOutput(reservation.message)

    reservation = await guardInboundReservation(store, reservation.message.id)
    if (reservation.suppressed) return { kind: 'error', ...inboundError('CHANNEL_AUTHORIZATION_CHANGED') }
    if (reservation.message.status !== 'reserved') return inboundOutput(reservation.message)
    const result = await runInboundCommand(workService, { id: reservation.memberId }, reservation.message)
    const failure = !result?.ok && safeWorkFailure(result?.error, reservation.message.command)
    let output
    await store.update(state => {
      const current = state.channelMessages.find(item => item.id === reservation.message.id)
      if (!current) throw error('NOT_FOUND', '渠道消息不存在')
      if (current.status === 'accepted' || current.status === 'rejected') {
        output = current
        return state
      }
      if (current.status !== 'reserved' || current.clientRequestId !== reservation.message.clientRequestId || !sameCommand(current.command, reservation.message.command)) throw error('CONFLICT', '渠道消息受理状态已变化')
      if (failure) output = compact({ ...current, status: 'rejected', workId: current.command.workId, error: failure })
      else {
        const workId = current.command.type === 'create' ? clean(result.value?.id) : current.command.workId
        if (!workId) throw error('INTERNAL_ERROR', '工作服务未返回工作标识')
        output = compact({ ...current, status: 'accepted', workId, error: undefined })
      }
      return { ...state, channelMessages: replaceById(state.channelMessages, output) }
    })
    return inboundOutput(output, output.status === 'accepted' ? result : undefined)
  }

  return {
    handleInbound,

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
        const status = enabled === false ? 'disabled' : 'unavailable'
        if (typeof enabled !== 'boolean' || !allowedScopes.length) throw error('INVALID_REQUEST', '渠道应用配置无效')
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

    async setChannelAppRuntime({ channelAppId, revision, providerAppId, providerTenantId, credentialRef, available, preservePending = false } = {}) {
      let output
      await store.update(state => {
        const app = state.channelApps.find(item => item.id === clean(channelAppId))
        if (!app || app.enabled !== true || app.revision !== revision || app.providerAppId !== providerAppId || app.providerTenantId !== providerTenantId
          || (credentialRef !== undefined && app.credentialRef !== credentialRef) || typeof available !== 'boolean' || typeof preservePending !== 'boolean') throw error('CHANNEL_RUNTIME_STALE', '渠道应用运行配置已变化')
        const status = available ? 'active' : 'unavailable'
        if (app.status === status) { output = app; return state }
        output = { ...app, status, updatedAt: now(clock) }
        const deliveries = available ? state.deliveries : invalidateClaims(state.deliveries, item => item.channelAppId === app.id && (item.status === 'sending' || (!preservePending && item.status === 'pending')), output.updatedAt, 'APP_UNAVAILABLE', '渠道应用当前不可用')
        return { ...state, channelApps: replaceById(state.channelApps, output), deliveries }
      })
      return appDto(output, true)
    },

    async issueLinkCode(actor, { channelAppId } = {}) {
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
      return { ...linkDto(output), code }
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
          : { id: `channel-conversation-${idFactory()}`, channelAppId: app.id, providerConversationId: input.providerConversationId, identityId: identity.id, memberId: link.memberId, type: 'private', allowedScopes: [...app.allowedScopes], verificationMethod: 'link-code', status: 'pending', revision: 1, createdAt: timestamp, updatedAt: timestamp }
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
        const dispatch = compact({ employeeId: clean(employeeId), skillId: clean(skillId), capabilityId: clean(capabilityId), connectionId: clean(connectionId) })
        if (!dispatchAuthorized(state, member, dispatch)) throw error('FORBIDDEN', '默认派发绑定当前未获准')
        output = { ...conversation, defaultDispatch: dispatch, revision: conversation.revision + 1, updatedAt: timestamp }
        return { ...state, channelConversations: replaceById(state.channelConversations, output) }
      })
      return conversationDto(output)
    },

    async clearDefaultDispatch(actor, { conversationId } = {}) {
      let output
      await store.update(state => {
        const timestamp = now(clock), member = requireMember(state, actor)
        const conversation = state.channelConversations.find(item => item.id === clean(conversationId) && item.memberId === member.id && item.status === 'active')
        if (!conversation || !state.channelApps.some(item => item.id === conversation.channelAppId && item.enabled && item.status === 'active')) throw error('NOT_FOUND', '渠道会话不存在')
        if (!conversation.defaultDispatch) { output = conversation; return state }
        const { defaultDispatch: _defaultDispatch, ...cleared } = conversation
        output = { ...cleared, revision: conversation.revision + 1, updatedAt: timestamp }
        return { ...state, channelConversations: replaceById(state.channelConversations, output) }
      })
      return conversationDto(output)
    },

    async recordInbound(input = {}) {
      let output, deduplicated = false
      await store.update(state => {
        const resolved = findInbound(state, input)
        if (resolved.conflict) {
          if (!resolved.unmatched) throw error('CONFLICT', '渠道官方 ID 映射冲突')
          output = conflictInbound(state, input, resolved, clock, idFactory)
          return { ...state, channelMessages: [...state.channelMessages, output] }
        }
        const existing = resolved.message
        if (existing) { output = existing; deduplicated = true; return state }
        state = ensureGroupConversation(state, input, clock, idFactory)
        output = newInbound(state, input, clock, idFactory)
        return { ...state, channelMessages: [...state.channelMessages, output] }
      })
      return { message: messageDto(output), deduplicated }
    },

    async createDelivery(actor, input = {}) {
      let output, deduplicated = false
      await store.update(state => {
        const member = requireMember(state, actor), app = state.channelApps.find(item => item.id === clean(input.channelAppId) && item.enabled === true && item.status === 'active')
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
        const identity = state.channelIdentities.find(item => item.id === clean(input.targetIdentityId) && item.memberId === member.id && item.channelAppId === app?.id && item.status === 'active')
        const conversation = state.channelConversations.find(item => item.id === clean(input.targetConversationId) && item.memberId === member.id && item.channelAppId === app?.id && item.identityId === identity?.id && item.type === 'private' && item.status === 'active')
        const resultId = input.resultId === undefined ? undefined : clean(input.resultId)
        const channelMessageId = input.channelMessageId === undefined ? undefined : clean(input.channelMessageId)
        if (!app || !work || !identity || !conversation || (resultId && !work.results.some(item => item.id === resultId)) || (channelMessageId && !state.channelMessages.some(item => item.id === channelMessageId && item.channelAppId === app.id))) throw error('FORBIDDEN', '投递目标或内容引用无效')
        const timestamp = now(clock)
        const contentKey = resultId ? 'result.gearjob' : 'work.accepted'
        output = compact({ id: `delivery-${idFactory()}`, channelAppId: app.id, requestId, workId: work.id, resultId, channelMessageId, targetConversationId: conversation.id, targetIdentityId: identity.id, contentScope: requiredId(input.contentScope, 'contentScope'), contentKey, status: 'pending', attempts: 0, createdAt: timestamp, updatedAt: timestamp })
        return { ...state, deliveries: [...state.deliveries, output] }
      })
      return { delivery: deliveryDto(output), deduplicated }
    },

    async createInboundDeliveries({ channelMessageId, requestId } = {}) {
      let outputs = [], deduplicated = true
      await store.update(state => {
        const message = state.channelMessages.find(item => item.id === clean(channelMessageId) && item.direction === 'inbound')
        if (!message || !['accepted', 'rejected'].includes(message.status)) throw error('INVALID_STATE', '渠道消息尚未完成受理')
        const identity = state.channelIdentities.find(item => item.id === message.senderIdentityId)
        const source = state.channelConversations.find(item => item.id === message.conversationId)
        if (!identity || !source) return state
        const baseRequest = requiredId(requestId, 'requestId')
        const specs = []
        if (source.type === 'group') {
          specs.push({ suffix: 'group', conversation: source, contentScope: 'fixed', contentKey: message.status === 'accepted' ? 'group.accepted' : fixedHelpKey(message) })
          if (message.status === 'accepted') {
            const privateConversation = uniquePrivateConversation(state, message.channelAppId, identity.id)
            if (privateConversation) specs.push({ suffix: 'private', conversation: privateConversation, contentScope: 'result', contentKey: 'work.accepted' })
          }
        } else {
          specs.push({ suffix: 'private', conversation: source, contentScope: message.status === 'accepted' ? 'result' : 'fixed', contentKey: message.status === 'accepted' ? 'work.accepted' : fixedHelpKey(message) })
        }
        for (const spec of specs) {
          const scopedRequest = `${baseRequest}:${spec.suffix}`
          const existing = state.deliveries.find(item => item.channelAppId === message.channelAppId && item.requestId === scopedRequest)
          if (existing) {
            if (existing.channelMessageId !== message.id || existing.workId !== message.workId || existing.targetConversationId !== spec.conversation.id || existing.targetIdentityId !== identity.id || existing.contentScope !== spec.contentScope || existing.contentKey !== spec.contentKey) throw error('CONFLICT', '幂等投递请求已绑定其他消息')
            outputs.push(existing)
            continue
          }
          deduplicated = false
          const timestamp = now(clock)
          const delivery = compact({ id: `delivery-${idFactory()}`, channelAppId: message.channelAppId, requestId: scopedRequest, workId: message.workId, channelMessageId: message.id, targetConversationId: spec.conversation.id, targetIdentityId: identity.id, contentScope: spec.contentScope, contentKey: spec.contentKey, status: 'pending', attempts: 0, createdAt: timestamp, updatedAt: timestamp })
          state = { ...state, deliveries: [...state.deliveries, delivery] }
          outputs.push(delivery)
        }
        return state
      })
      return { deliveries: outputs.map(deliveryDto), deduplicated }
    },

    async createWorkDelivery(actor, { workId, resultId, requestId } = {}) {
      const state = await store.read(), member = requireMember(state, actor)
      const work = state.works.find(item => item.id === clean(workId) && item.ownerMemberId === member.id)
      const origin = state.channelMessages.find(item => item.workId === work?.id && item.status === 'accepted' && item.command?.type === 'create')
      const identity = state.channelIdentities.find(item => item.id === origin?.senderIdentityId)
      const conversation = identity && uniquePrivateConversation(state, origin.channelAppId, identity.id)
      if (!work || !origin || !identity || !conversation) throw error('NOT_FOUND', '工作没有可用的已验证私聊来源')
      return this.createDelivery(actor, { channelAppId: origin.channelAppId, requestId, workId: work.id, resultId, channelMessageId: origin.id, targetIdentityId: identity.id, targetConversationId: conversation.id, contentScope: 'result' })
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
      const conversationIds = new Set(state.channelMessages.filter(item => identityIds.has(item.senderIdentityId)).map(item => item.conversationId).filter(Boolean))
      return {
        identities: state.channelIdentities.filter(item => identityIds.has(item.id)).map(identityDto),
        conversations: state.channelConversations.filter(item => identityIds.has(item.identityId) || conversationIds.has(item.id)).map(conversationDto),
        messages: state.channelMessages.filter(item => item.senderIdentityId && identityIds.has(item.senderIdentityId)).map(messageDto),
        deliveries: state.deliveries.filter(item => workIds.has(item.workId) || identityIds.has(item.targetIdentityId)).map(deliveryDto),
        linkCodes: state.linkCodes.filter(item => item.memberId === member.id).map(linkDto),
      }
    },
  }
}

function findInbound(state, input) {
  const app = state.channelApps.find(item => item.id === clean(input.channelAppId))
  if (!app) throw error('NOT_FOUND', '渠道应用不存在')
  const providerEventId = optionalOfficialId(input.providerEventId, 'providerEventId')
  const providerMessageId = optionalOfficialId(input.providerMessageId, 'providerMessageId')
  if (!providerEventId && !providerMessageId) throw error('INVALID_REQUEST', '渠道消息缺少官方稳定 ID')
  const eventMatch = providerEventId && state.channelMessages.find(item => item.channelAppId === app.id && item.providerEventId === providerEventId)
  const messageMatch = providerMessageId && state.channelMessages.find(item => item.channelAppId === app.id && item.providerMessageId === providerMessageId)
  if (providerEventId && providerMessageId) {
    if (eventMatch && messageMatch) return eventMatch.id === messageMatch.id ? { message: eventMatch } : { conflict: true }
    if (eventMatch || messageMatch) {
      const match = eventMatch || messageMatch
      if (match.providerEventId === providerEventId && match.providerMessageId === providerMessageId) return { message: match }
      return { conflict: true, unmatched: eventMatch ? 'message' : 'event' }
    }
  }
  return { message: eventMatch || messageMatch || undefined }
}

function conflictInbound(state, input, resolved, clock, idFactory) {
  if (!resolved.unmatched) return { id: 'channel-message-conflict', status: 'rejected', error: inboundError('OFFICIAL_ID_CONFLICT') }
  const isolated = resolved.unmatched === 'event' ? { ...input, providerMessageId: undefined } : { ...input, providerEventId: undefined }
  return { ...newInbound(state, isolated, clock, idFactory), status: 'rejected', error: inboundError('OFFICIAL_ID_CONFLICT') }
}

function newInbound(state, input, clock, idFactory) {
  const app = state.channelApps.find(item => item.id === clean(input.channelAppId))
  if (!app) throw error('NOT_FOUND', '渠道应用不存在')
  const providerEventId = optionalOfficialId(input.providerEventId, 'providerEventId')
  const providerMessageId = optionalOfficialId(input.providerMessageId, 'providerMessageId')
  const replyToProviderMessageId = optionalOfficialId(input.replyToProviderMessageId, 'replyToProviderMessageId')
  if (!providerEventId && !providerMessageId) throw error('INVALID_REQUEST', '渠道消息缺少官方稳定 ID')
  const providerConversationId = requiredOfficialId(input.providerConversationId, 'providerConversationId')
  const providerUserId = requiredOfficialId(input.providerUserId, 'providerUserId')
  const body = typeof input.text === 'string' && input.text.length <= 16_384 ? input.text : undefined
  if (body === undefined) throw error('INVALID_REQUEST', '仅支持有界文本消息')
  if (state.linkCodes.some(link => link.digest === sha256(body.trim()))) throw error('INVALID_REQUEST', '关联码必须通过关联入口处理')
  const identity = state.channelIdentities.find(item => item.channelAppId === app.id && item.providerUserId === providerUserId && item.status === 'active')
  const conversation = state.channelConversations.find(item => item.channelAppId === app.id && item.providerConversationId === providerConversationId && item.status === 'active')
  const type = input.conversationType ?? 'private'
  const privateConversation = identity && uniquePrivateConversation(state, app.id, identity.id)
  const allowed = app.enabled && app.status === 'active' && identity && conversation && conversation.type === type
    && (type === 'group' || conversation.identityId === identity.id && conversation.memberId === identity.memberId)
    && (type === 'private' || input.botMentioned === true && privateConversation?.defaultDispatch)
  const timestamp = now(clock)
  return compact({
    id: `channel-message-${idFactory()}`, channelAppId: app.id, providerEventId, providerMessageId,
    replyToProviderMessageId, providerConversationId, providerUserId, conversationId: conversation?.id, senderIdentityId: identity?.id,
    direction: 'inbound', text: body, receivedAt: input.receivedAt ? requiredTimestamp(input.receivedAt, 'receivedAt') : timestamp,
    persistedAt: timestamp, status: allowed ? 'received' : 'unhandled',
    error: allowed ? undefined : inboundError('CHANNEL_UNAVAILABLE'),
  })
}

function ensureGroupConversation(state, input, clock, idFactory) {
  if (input.conversationType !== 'group' || input.botMentioned !== true) return state
  const app = state.channelApps.find(item => item.id === clean(input.channelAppId) && item.enabled === true && item.status === 'active')
  const providerUserId = validOfficialId(input.providerUserId) ? input.providerUserId : undefined
  const providerConversationId = validOfficialId(input.providerConversationId) ? input.providerConversationId : undefined
  const identity = state.channelIdentities.find(item => item.channelAppId === app?.id && item.providerUserId === providerUserId && item.status === 'active')
  const privateConversation = identity && uniquePrivateConversation(state, app.id, identity.id)
  if (!app || !identity || !privateConversation?.defaultDispatch || !providerConversationId) return state
  const current = state.channelConversations.find(item => item.channelAppId === app.id && item.providerConversationId === providerConversationId)
  if (current) return state
  const timestamp = now(clock)
  const group = {
    id: `channel-conversation-${idFactory()}`, channelAppId: app.id, providerConversationId,
    type: 'group', allowedScopes: ['fixed'], verificationMethod: 'bot-mention', status: 'active', revision: 1, createdAt: timestamp, updatedAt: timestamp,
  }
  return { ...state, channelConversations: [...state.channelConversations, group] }
}

function uniquePrivateConversation(state, channelAppId, identityId) {
  const matches = state.channelConversations.filter(item => item.channelAppId === channelAppId && item.identityId === identityId && item.type === 'private' && item.status === 'active')
  return matches.length === 1 ? matches[0] : undefined
}

function reserveInbound(state, message, input = {}, clock) {
  if (message.status === 'reserved') {
    const committedWorkId = committedInboundWork(state, message)
    if (committedWorkId) return acceptCommittedInbound(state, message, committedWorkId)
  }
  const context = currentInboundContext(state, message)
  if (!context) return rejectInbound(state, message, inboundError('CHANNEL_UNAVAILABLE'), message.command)
  if (message.status === 'reserved') {
    if (!commandStillAuthorized(state, context, message)) return rejectInbound(state, message, inboundError('CHANNEL_AUTHORIZATION_CHANGED'), message.command)
    return { state, reservation: inboundReservation(state, message) }
  }
  if (message.status !== 'received') return { state, reservation: inboundReservation(state, message, { terminal: true }) }

  const parsed = parseInboundCommand(state, message, context, input)
  if (parsed.error) return rejectInbound(state, message, parsed.error, parsed.command)
  const officialKind = message.providerEventId ? 'event' : 'message'
  const officialId = message.providerEventId ?? message.providerMessageId
  const clientRequestId = `channel:${message.channelAppId}:${sha256(`${message.channelAppId}\0${officialKind}\0${officialId}`)}`
  const reserved = compact({
    ...message, status: 'reserved', command: parsed.command, clientRequestId, workId: parsed.command.workId,
    authorizationRevisions: { app: context.app.revision, identity: context.identity.revision, conversation: context.commandConversation.revision },
    reservedAt: now(clock), error: undefined,
  })
  const next = { ...state, channelMessages: replaceById(state.channelMessages, reserved) }
  return { state: next, reservation: inboundReservation(next, reserved) }
}

function acceptCommittedInbound(state, message, workId) {
  const accepted = { ...message, status: 'accepted', workId, error: undefined }
  const next = { ...state, channelMessages: replaceById(state.channelMessages, accepted) }
  const context = currentInboundContext(next, accepted)
  return { state: next, reservation: inboundReservation(next, accepted, { suppressed: !context || !commandStillAuthorized(next, context, accepted) }) }
}

function committedInboundWork(state, message) {
  const identity = state.channelIdentities.find(item => item.id === message.senderIdentityId)
  const memberId = identity?.memberId
  if (!memberId || !message.command || !message.clientRequestId) return undefined
  const key = message.command.type === 'create'
    ? `${memberId}|create|${message.clientRequestId}`
    : message.command.type === 'follow-up' ? `${memberId}|${message.command.workId}|follow-up|${message.clientRequestId}` : undefined
  const reservation = key && state.reservations[key]
  const work = reservation && state.works.find(item => item.id === reservation.workId && item.ownerMemberId === memberId)
  if (!work) return undefined
  if (message.command.type === 'create' && (work.employeeId !== message.command.employeeId || work.skillId !== message.command.skillId || work.capabilityId !== message.command.capabilityId
    || work.connectionId !== message.command.connectionId || work.input?.workOrderId !== message.command.workOrderId)) return undefined
  if (message.command.type === 'follow-up' && work.id !== message.command.workId) return undefined
  return work.id
}

function currentInboundContext(state, message) {
  const app = state.channelApps.find(item => item.id === message.channelAppId && item.enabled === true && item.status === 'active')
  const identity = state.channelIdentities.find(item => item.id === message.senderIdentityId && item.channelAppId === app?.id && item.status === 'active')
  const conversation = state.channelConversations.find(item => item.id === message.conversationId && item.channelAppId === app?.id && item.status === 'active')
  const member = state.members.find(item => item.id === identity?.memberId && item.enabled === true)
  const commandConversation = conversation?.type === 'group' ? uniquePrivateConversation(state, app?.id, identity?.id) : conversation
  if (!app || !identity || !conversation || !member || (conversation.type === 'private' && (conversation.identityId !== identity.id || conversation.memberId !== member.id))
    || !commandConversation || (conversation.type === 'group' && !commandConversation.defaultDispatch)
    || message.providerUserId !== identity.providerUserId || message.providerConversationId !== conversation.providerConversationId) return undefined
  return { app, identity, conversation, commandConversation, member }
}

function commandStillAuthorized(state, context, message) {
  const command = message.command, revisions = message.authorizationRevisions
  if (!command || !revisions || revisions.app !== context.app.revision || revisions.identity !== context.identity.revision || revisions.conversation !== context.commandConversation.revision) return false
  if (command.type !== 'create') {
    const work = state.works.find(item => item.id === command.workId && item.ownerMemberId === context.member.id)
    return Boolean(work && workBindingAuthorized(state, context.member, work))
  }
  const binding = context.commandConversation.defaultDispatch
  return ['employeeId', 'skillId', 'capabilityId', 'connectionId'].every(key => binding?.[key] === command[key]) && dispatchAuthorized(state, context.member, command)
}

function parseInboundCommand(state, message, context, input) {
  if (input.attachments !== undefined || input.url !== undefined || hasUriToken(message.text)) return { error: inboundError('UNSUPPORTED') }
  const create = /^\u4ea4\u529e \u5de5\u5355 (\S+)$/u.exec(message.text)
  if (create) {
    const dispatch = context.commandConversation.defaultDispatch
    if (!dispatch || !dispatchAuthorized(state, context.member, dispatch)) return { error: inboundError('DEFAULT_DISPATCH_UNAVAILABLE') }
    const command = compact({ type: 'create', workOrderId: create[1], employeeId: dispatch.employeeId, skillId: dispatch.skillId, capabilityId: dispatch.capabilityId, connectionId: dispatch.connectionId })
    return { command }
  }

  const status = /^\u72b6\u6001 (work-[A-Za-z0-9._:/-]{1,250})$/u.exec(message.text)
  if (status) return resolvedWorkCommand(state, context.member, { type: 'status', workRef: status[1] })

  const stop = /^(?:\u505c\u6b62|\u505c\u6b62 (work-[A-Za-z0-9._:/-]{1,250}))$/u.exec(message.text)
  if (stop) return resolvedWorkCommand(state, context.member, { type: 'stop', workRef: stop[1], replyToProviderMessageId: message.replyToProviderMessageId, channelAppId: message.channelAppId, conversationId: message.conversationId })

  const supplement = /^\u8865\u5145 ([\s\S]+)$/u.exec(message.text)
  if (supplement) {
    let workRef, text = supplement[1]
    const explicit = /^(work-[A-Za-z0-9._:/-]{1,250}) ([\s\S]+)$/u.exec(text)
    if (!message.replyToProviderMessageId) {
      if (!explicit) return { error: inboundError('WORK_REFERENCE_INVALID') }
      workRef = explicit[1]
      text = explicit[2]
    } else if (explicit) {
      workRef = explicit[1]
      text = explicit[2]
    }
    if (!text || text.length > 4000) return { error: inboundError('UNSUPPORTED') }
    return resolvedWorkCommand(state, context.member, { type: 'follow-up', workRef, text, replyToProviderMessageId: message.replyToProviderMessageId, channelAppId: message.channelAppId, conversationId: message.conversationId })
  }
  return { error: inboundError('UNSUPPORTED') }
}

function hasUriToken(value) {
  return /(?:^|[\s()[\]{}<>"'`“”‘’.,;!?，。；！？、（【《])(?:[A-Za-z][A-Za-z0-9+.-]*:|www\.)/u.test(value)
}

function dispatchAuthorized(state, member, dispatch) {
  if (dispatch?.capabilityId !== CHANNEL_CAPABILITY_ID) return false
  const employee = state.employees.find(item => item.id === dispatch.employeeId && item.enabled === true && member.employeeIds.includes(item.id))
  const skill = state.skills.find(item => item.id === dispatch.skillId && item.enabled === true && employee?.skillIds?.includes(item.id) && item.capabilityId === dispatch.capabilityId)
  const connection = state.connections.find(item => item.id === dispatch.connectionId && item.enabled === true && item.status === 'ready' && employee?.connectionIds?.includes(item.id) && item.skillIds?.includes(skill?.id))
  return Boolean(employee && skill && connection)
}

function workBindingAuthorized(state, member, work) {
  if (!member?.enabled || !member.employeeIds.includes(work.employeeId)) return false
  const employee = state.employees.find(item => item.id === work.employeeId && item.enabled === true)
  const skill = state.skills.find(item => item.id === work.skillId && item.enabled === true && employee?.skillIds?.includes(item.id) && item.capabilityId === work.capabilityId)
  if (!employee || !skill) return false
  if (work.capabilityId === CHANNEL_CAPABILITY_ID && !work.connectionId) return false
  if (!work.connectionId) return true
  const connection = state.connections.find(item => item.id === work.connectionId && item.enabled === true && item.status === 'ready'
    && employee.connectionIds?.includes(item.id) && item.skillIds?.includes(skill.id))
  return Boolean(connection && (!work.input?.workOrderId || connection.allowedObjectIds?.includes(work.input.workOrderId)))
}

function resolvedWorkCommand(state, member, candidate) {
  const replyWorkId = candidate.replyToProviderMessageId && resolveReplyWork(state, candidate.channelAppId, candidate.conversationId, candidate.replyToProviderMessageId)
  if (candidate.replyToProviderMessageId && !replyWorkId) return { error: inboundError('WORK_REFERENCE_INVALID') }
  if (candidate.workRef && replyWorkId && candidate.workRef !== replyWorkId) return { error: inboundError('WORK_REFERENCE_INVALID') }
  const workId = candidate.workRef ?? replyWorkId
  const work = state.works.find(item => item.id === workId && item.ownerMemberId === member.id)
  if (!work || !workBindingAuthorized(state, member, work)) return { error: inboundError('WORK_REFERENCE_INVALID') }
  const command = compact({ type: candidate.type, workId: work.id, text: candidate.text })
  if (candidate.type === 'follow-up') {
    if (work.executions.some(item => ACTIVE_WORK_EXECUTION.has(item.status))) return { command, error: inboundError('WORK_ACTIVE_NOT_APPLIED') }
    if (!work.results.some(item => item.kind !== 'assistant.follow-up')) return { command, error: inboundError('WORK_INPUT_REQUIRED') }
  }
  return { command }
}

function resolveReplyWork(state, channelAppId, conversationId, providerMessageId) {
  const workIds = new Set([
    ...state.deliveries.filter(item => item.channelAppId === channelAppId && item.targetConversationId === conversationId && item.providerMessageId === providerMessageId).map(item => item.workId),
    ...state.channelMessages.filter(item => item.channelAppId === channelAppId && item.conversationId === conversationId && item.direction === 'outbound' && item.providerMessageId === providerMessageId && item.workId).map(item => item.workId),
  ])
  return workIds.size === 1 ? [...workIds][0] : undefined
}

function rejectInbound(state, message, reason, command) {
  const rejected = compact({ ...message, status: 'rejected', command, workId: command?.workId, error: reason })
  const next = { ...state, channelMessages: replaceById(state.channelMessages, rejected) }
  return { state: next, reservation: inboundReservation(next, rejected) }
}

function inboundReservation(state, message, extra = {}) {
  const identity = state.channelIdentities.find(item => item.id === message.senderIdentityId)
  return { message, memberId: identity?.memberId, ...extra }
}

async function guardInboundReservation(store, messageId) {
  let reservation
  await store.update(state => {
    const message = state.channelMessages.find(item => item.id === messageId)
    if (!message) throw error('NOT_FOUND', '渠道消息不存在')
    if (message.status !== 'reserved') {
      const context = currentInboundContext(state, message)
      reservation = inboundReservation(state, message, { terminal: true, suppressed: message.status === 'accepted' && (!context || !commandStillAuthorized(state, context, message)) })
      return state
    }
    const committedWorkId = committedInboundWork(state, message)
    if (committedWorkId) {
      const accepted = acceptCommittedInbound(state, message, committedWorkId)
      reservation = accepted.reservation
      return accepted.state
    }
    const context = currentInboundContext(state, message)
    if (!context || !commandStillAuthorized(state, context, message)) {
      const rejected = rejectInbound(state, message, inboundError('CHANNEL_AUTHORIZATION_CHANGED'), message.command)
      reservation = rejected.reservation
      return rejected.state
    }
    reservation = inboundReservation(state, message)
    return state
  })
  return reservation
}

async function runInboundCommand(service, actor, message) {
  const command = message.command
  if (command.type === 'create') return service.createWork(actor, {
    employeeId: command.employeeId, skillId: command.skillId, capabilityId: command.capabilityId, connectionId: command.connectionId,
    workOrderId: command.workOrderId, clientRequestId: message.clientRequestId,
  })
  if (command.type === 'follow-up') return service.followUp(actor, command.workId, command.text, { clientRequestId: message.clientRequestId })
  if (command.type === 'status') return service.getWork(actor, command.workId)
  return service.cancel(actor, command.workId)
}

function inboundOutput(message, result) {
  if (message.status === 'unhandled') return { kind: 'error', ...message.error }
  if (message.status === 'rejected') {
    const kind = message.error?.code === 'WORK_ACTIVE_NOT_APPLIED' ? 'not-applied'
      : ['UNSUPPORTED', 'WORK_REFERENCE_INVALID', 'WORK_INPUT_REQUIRED', 'DEFAULT_DISPATCH_UNAVAILABLE', 'CHANNEL_AUTHORIZATION_CHANGED'].includes(message.error?.code) ? 'help' : 'error'
    return { kind, ...message.error, ...(message.workId ? { workId: message.workId } : {}) }
  }
  if (message.status !== 'accepted') return { kind: 'accepted', code: 'RECEIVED', message: '消息已保留' }
  if (message.command?.type === 'status') return compact({ kind: 'result', code: 'WORK_STATUS', message: '工作状态已查询', workId: message.workId, workStatus: result?.value?.status })
  if (message.command?.type === 'stop') return { kind: 'accepted', code: 'WORK_STOPPED', message: '停止请求已处理', workId: message.workId }
  return { kind: 'accepted', code: message.command?.type === 'follow-up' ? 'FOLLOW_UP_ACCEPTED' : 'WORK_ACCEPTED', message: message.command?.type === 'follow-up' ? '补充已受理，结果待处理' : '工作已受理，结果待处理', workId: message.workId }
}

function safeWorkFailure(value, command) {
  if (value?.code === 'BUSY' && command.type === 'follow-up') return inboundError('WORK_ACTIVE_NOT_APPLIED')
  if (['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(value?.code)) return inboundError(command.type === 'create' ? 'DEFAULT_DISPATCH_UNAVAILABLE' : 'WORK_REFERENCE_INVALID')
  if (['INVALID_REQUEST', 'INVALID_INPUT', 'UNDECLARED_INPUT', 'MISSING_INPUT', 'INVALID_WORK_ORDER_ID'].includes(value?.code)) return inboundError('WORK_REQUEST_INVALID')
  return inboundError('WORK_SERVICE_FAILED')
}

function inboundError(code) {
  const messages = {
    CHANNEL_UNAVAILABLE: '渠道身份或应用当前不可用',
    CHANNEL_AUTHORIZATION_CHANGED: '渠道授权已变化，请到 Web 重新提交',
    DEFAULT_DISPATCH_UNAVAILABLE: '默认派发当前不可用，请到 Web 重新选择',
    WORK_REFERENCE_INVALID: '无法精确确定本人工作，请到 Web 核对',
    WORK_ACTIVE_NOT_APPLIED: '已收到但本轮未应用，请在本轮结束后重新提交',
    WORK_INPUT_REQUIRED: '工作尚无可用业务结果，请到 Web 补充结构化输入',
    WORK_REQUEST_INVALID: '请求内容无效，请到 Web 核对',
    WORK_SERVICE_FAILED: '工作服务暂时无法完成请求',
    OFFICIAL_ID_CONFLICT: '渠道官方消息标识冲突，本次不会受理',
    UNSUPPORTED: '当前仅支持明确文本命令，请到 Web 处理其他内容',
  }
  return { code, message: messages[code] ?? '渠道请求无法处理' }
}

function sameCommand(left, right) { return JSON.stringify(left) === JSON.stringify(right) }

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
  const member = state.members.find(item => item.id === (work?.ownerMemberId ?? identity?.memberId) && item.enabled === true)
  const employee = state.employees.find(item => item.id === work?.employeeId && item.enabled === true && member?.employeeIds.includes(item.id))
  const skill = state.skills.find(item => item.id === work?.skillId && item.enabled === true && employee?.skillIds?.includes(item.id) && item.capabilityId === work.capabilityId)
  const connection = work?.connectionId === undefined ? undefined : state.connections.find(item => item.id === work.connectionId && item.enabled === true && item.status === 'ready' && employee?.connectionIds?.includes(item.id) && item.skillIds?.includes(skill?.id))
  const result = delivery.resultId === undefined ? undefined : work?.results.find(item => item.id === delivery.resultId)
  const revisions = delivery.authorizationRevisions
  const fixed = Object.hasOwn(FIXED_CONTENT, delivery.contentKey)
  const workAuthorized = work && workBindingAuthorized(state, member, work)
  if (!app || !identity || !conversation || !member
    || identity.channelAppId !== app.id || conversation.channelAppId !== app.id || identity.memberId !== member.id
    || (conversation.type === 'private' && (conversation.memberId !== member.id || conversation.identityId !== identity.id))
    || (!fixed && (!workAuthorized || !employee || !skill || (work.connectionId !== undefined && !connection)
      || !app.allowedScopes.includes(delivery.contentScope) || !conversation.allowedScopes.includes(delivery.contentScope) || (delivery.resultId !== undefined && !result)
      || result?.knowledgeDependencyRefs?.some(ref => !currentKnowledgeReference(state, ref, member.id, result.employeeId ?? work.employeeId))))) return undefined
  if (validateClaim && (!revisions || revisions.app !== app.revision || revisions.identity !== identity.revision || revisions.conversation !== conversation.revision)) return undefined
  return { app, identity, conversation, work, member, employee, skill, connection, result }
}

function deliveryEnvelope(state, delivery) {
  const conversation = state.channelConversations.find(item => item.id === delivery.targetConversationId)
  const work = delivery.workId && state.works.find(item => item.id === delivery.workId)
  const result = delivery.resultId && work?.results.find(item => item.id === delivery.resultId)
  const text = FIXED_CONTENT[delivery.contentKey] ?? formatWorkContent(delivery.contentKey, work, result)
  if (!conversation || !text) throw error('DELIVERY_FORBIDDEN', '投递内容无法生成')
  return Object.freeze({
    deliveryId: delivery.id,
    attempt: delivery.attempts,
    providerConversationId: conversation.providerConversationId,
    text,
    uuid: stableAttemptUuid(delivery.id, delivery.attempts),
  })
}

function formatWorkContent(contentKey, work, result) {
  if (!work) return undefined
  const path = `/works/${encodeURIComponent(work.id)}`
  if (contentKey === 'work.accepted') return `工作 ${work.id} 已受理，当前状态：${work.status}。来源：渠道文本交办。详情：${path}`
  if (contentKey !== 'result.gearjob') return undefined
  if (result?.kind !== 'gearjob.work-order.observation') return `工作 ${work.id} 当前状态：${work.status}。来源：已验证工作结果。详情：${path}`
  const fact = result.payload ?? {}
  const source = result.source ?? fact
  return [
    `工单：${fact.workOrderId ?? work.input?.workOrderId ?? '未知'}`,
    `状态：${fact.status ?? work.status}`,
    `计划/完成量：${fact.plannedQuantity ?? '未知'}/${fact.completedQuantity ?? '未知'}${fact.unit ? ` ${fact.unit}` : ''}`,
    `来源：${source.sourceSystem ?? '未知'} / ${source.sourceInstance ?? '未知'} / ${source.sourceEnvironment ?? '未知'} / ${source.dataMode ?? '未知'} / ${source.evidenceMode ?? '未知'}`,
    `Web：${path}`,
  ].join('\n')
}

function stableAttemptUuid(deliveryId, attempt) {
  const hex = sha256(`${deliveryId}\0${attempt}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function fixedHelpKey(message) {
  return message.error?.code === 'UNSUPPORTED' ? 'help.unsupported' : 'help.unavailable'
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
    contentKey: clean(value.resultId) ? 'result.gearjob' : 'work.accepted',
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
function error(code, message) { return new ChannelServiceError(code, message) }
