import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { currentKnowledgeReference } from './knowledge-service.mjs'
import { newConversationRecord, requireConversationEmployee } from './conversation-service.mjs'
import { currentConversationDependencies } from './conversation-dependencies.mjs'
import { authorizeWorkBinding } from './work-service.mjs'

const LINK_TTL_MS = 10 * 60 * 1000
const LINK_FAILURE_LIMIT = 5
const CHANNEL_CAPABILITY_ID = 'gearjob-work-order-read'
const DELIVERY_OUTCOMES = new Set(['delivered', 'failed', 'unknown'])
const RECONCILED_OUTCOMES = new Set(['delivered', 'failed'])
const FIXED_CONTENT = Object.freeze({
  'group.accepted': '已受理，后续仅通过已验证私聊反馈；详情请到 Web 查看。',
  'help.unsupported': '当前仅支持私聊文本，请到 Web 处理其他内容。',
  'help.unavailable': '当前请求无法处理，请到 Web 核对。',
  'help.confirmation': '请先在 Web 确认本人渠道身份，再重新发送消息。',
  'help.busy': '当前回复尚未结束，请先完成或停止回复，再重新发送。',
  'help.interrupted': '上次消息未完成受理，请发送一条新消息。',
  'help.reply-invalid': '引用消息无法用于当前会话，请到 Web 打开原对话，或发送一条新消息。',
  'conversation.started': '已开启新会话。旧对话可在 Web 继续。',
  'conversation.default-changed': '默认员工已变更，已开启新会话。旧对话可在 Web 继续。',
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
  conversationService,
  connectionCatalog = [],
  onIdentityChanged = async () => undefined,
} = {}) {
  if (!store?.read || !store?.update) throw new TypeError('channel service 需要 store')

  async function authorizeDelivery({ deliveryId, retry = false } = {}) {
    let output, denied
    await store.update(state => {
      const delivery = state.deliveries.find(item => item.id === clean(deliveryId))
      if (!delivery) throw error('NOT_FOUND', '投递不存在')
      const expected = retry ? ['failed', 'blocked'] : ['pending']
      if (!expected.includes(delivery.status)) throw transitionError(delivery.status)
      const current = currentDeliveryAuthorization(state, delivery, { connectionCatalog })
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

  async function validateSendClaim({ deliveryId, attemptId, partIndex, clientId, totalParts, textDigest } = {}) {
    const initial = await store.read(), first = initial.deliveries.find(item => item.id === clean(deliveryId))
    let text
    try { if (first && currentDeliveryAuthorization(initial, first, { validateClaim: true, connectionCatalog })) {
      if (Object.hasOwn(FIXED_CONTENT, first.contentKey)) text = FIXED_CONTENT[first.contentKey]
      else if (first.sourceRef?.kind === 'conversation-turn' && conversationService?.getConversation) {
        const source = initial.conversations.find(item => item.id === first.sourceRef.conversationId)
        const detail = await conversationService.getConversation({ id: source.ownerMemberId }, source.id)
        const turn = detail.turns.find(item => item.id === first.sourceRef.turnId)
        if (turn?.status === 'completed' && detail.historyStatus === 'available') text = turn.assistantText
      } else if (workService?.getWork && first.workId) {
        const work = initial.works.find(item => item.id === first.workId)
        const result = await workService.getWork({ id: work.ownerMemberId }, work.id)
        if (result?.ok) text = formatWorkContent(first.contentKey, result.value, result.value.results.find(item => item.id === first.resultId))
      }
    } } catch { text = undefined }
    let output, transport, denied = false
    await store.update(state => {
      const delivery = state.deliveries.find(item => item.id === clean(deliveryId))
      if (!delivery) throw error('NOT_FOUND', '投递不存在')
      if (delivery.status !== 'sending') throw transitionError(delivery.status)
      if (!currentDeliveryAuthorization(state, delivery, { validateClaim: true, connectionCatalog }) || typeof text !== 'string' || !text
        || JSON.stringify(first?.sourceRef) !== JSON.stringify(delivery.sourceRef)) {
        denied = true
        const unknown = automationOccurrence(state, delivery)?.deliveryId === delivery.id
        output = { ...delivery, status: unknown ? 'unknown' : 'blocked', error: { code: unknown ? 'DELIVERY_UNKNOWN' : 'SEND_CLAIM_INVALID', message: unknown ? '发送效果待核对' : '发送前授权已失效' }, updatedAt: now(clock) }
        return { ...state, deliveries: replaceById(state.deliveries, output) }
      }
      output = delivery
      if (partIndex !== undefined) {
        const previous = delivery.sendProgress
        if (attemptId !== deliveryAttemptId(delivery) || !Number.isSafeInteger(partIndex) || partIndex !== (previous?.acknowledgedParts.length ?? 0)
          || !Number.isSafeInteger(totalParts) || totalParts < 1 || partIndex >= totalParts || textDigest !== sha256(text)
          || clientId !== `geneway-weixin-${sha256(`${attemptId}\0${partIndex}`).slice(0, 32)}`
          || (previous && (previous.totalParts !== totalParts || previous.textDigest !== textDigest))) throw error('SEND_CLAIM_INVALID', '发送分段与原内容不一致')
        output = { ...delivery, sendProgress: { attemptId, totalParts, textDigest, acknowledgedParts: previous?.acknowledgedParts ?? [], partIndex } }
      }
      transport = deliveryEnvelope(state, output, text)
      return output === delivery ? state : { ...state, deliveries: replaceById(state.deliveries, output) }
    })
    if (denied) throw error('DELIVERY_FORBIDDEN', '发送前授权已失效')
    return { ...transport, id: output.id, status: output.status }
  }

  async function handleInbound(input = {}) {
    let message, terminal = false
    await store.update(state => {
      const resolved = findInbound(state, input)
      if (resolved.conflict) {
        const conflict = persistInboundConflict(state, input, resolved, clock, idFactory)
        message = conflict.message; terminal = true
        return conflict.state
      }
      message = resolved.message
      if (!message) {
        state = ensureGroupConversation(state, input, clock, idFactory)
        message = newInbound(state, input, clock, idFactory)
        state = { ...state, channelMessages: [...state.channelMessages, message] }
      }
      if (['accepted', 'rejected', 'unhandled'].includes(message.status)) {
        terminal = true
        return state
      }
      const context = currentInboundContext(state, message)
      const reject = code => {
        terminal = true
        message = { ...message, status: 'rejected', error: inboundError(code) }
        return { ...state, channelMessages: replaceById(state.channelMessages, message) }
      }
      if (!context) return reject('CHANNEL_UNAVAILABLE')
      if (!conversationService?.sendTurn) return reject('CHANNEL_CONVERSATION_UNAVAILABLE')
      if (message.status === 'reserved') {
        const conversation = state.conversations.find(item => item.id === message.memberConversationId)
        const turn = conversation?.turns.find(item => item.clientRequestId === message.clientRequestId)
        if (turn) {
          terminal = true
          message = { ...message, status: 'accepted', turnId: turn.id, error: undefined }
          return { ...state, channelMessages: replaceById(state.channelMessages, compact(message)) }
        }
        if (!replyParentMatches(state, message, conversation, context)) return reject('CHANNEL_REPLY_INVALID')
        if (!inboundAuthorized(state, message)) return reject('CHANNEL_AUTHORIZATION_CHANGED')
        return state
      }
      try {
        const selected = selectChannelConversation(state, context, { forceNew: message.text === '新会话' }, clock, idFactory)
        if (!replyParentMatches(state, message, selected.conversation, context)) return reject('CHANNEL_REPLY_INVALID')
        state = selected.state
        message = compact({ ...message, status: message.text === '新会话' ? 'accepted' : 'reserved', action: message.text === '新会话' ? 'new-conversation' : 'chat',
          memberConversationId: selected.conversation.id, clientRequestId: `channel:${sha256(`${message.channelAppId}\0${message.id}`)}`,
          authorizationRevisions: { app: context.app.revision, identity: context.identity.revision, conversation: context.commandConversation.revision },
          reservedAt: now(clock), noticeKey: message.text === '新会话' ? 'conversation.started' : selected.changed ? 'conversation.default-changed' : undefined,
        })
        terminal = message.status === 'accepted'
        return { ...state, channelMessages: replaceById(state.channelMessages, message) }
      } catch (failure) {
        if (!['CONFLICT', 'CHANNEL_BUSY', 'CHANNEL_DEFAULT_REQUIRED', 'FORBIDDEN', 'MODEL_NOT_CONFIGURED', 'INVALID_REQUEST'].includes(failure.code)) throw failure
        const code = ['CONFLICT', 'CHANNEL_BUSY'].includes(failure.code) ? 'CHANNEL_BUSY' : 'CHANNEL_DEFAULT_REQUIRED'
        return reject(code)
      }
    })
    if (terminal) return durableInboxReceipt(message)
    const identity = (await store.read()).channelIdentities.find(item => item.id === message.senderIdentityId)
    let turn, rejected
    try {
      const result = await conversationService.sendTurn({ id: identity?.memberId }, message.memberConversationId, { text: message.text, clientRequestId: message.clientRequestId }, {
        authorize: async () => {
          const state = await store.read(), current = state.channelMessages.find(item => item.id === message.id)
          if (!current || !inboundAuthorized(state, current)) throw error('FORBIDDEN', '渠道授权已变化')
        },
      })
      turn = result.turn
    } catch (failure) {
      if (!['CONFLICT', 'FORBIDDEN', 'UNAUTHORIZED', 'MODEL_NOT_CONFIGURED', 'HISTORY_UNAVAILABLE', 'INVALID_REQUEST', 'NOT_FOUND'].includes(failure.code)) throw failure
      rejected = inboundError(failure.code === 'CONFLICT' ? 'CHANNEL_BUSY' : failure.code === 'HISTORY_UNAVAILABLE' ? 'CHANNEL_HISTORY_UNAVAILABLE' : 'CHANNEL_AUTHORIZATION_CHANGED')
    }
    await store.update(state => {
      const current = state.channelMessages.find(item => item.id === message.id)
      if (!current) throw error('NOT_FOUND', '渠道消息不存在')
      if (current.status !== 'reserved') { message = current; return state }
      if (current.clientRequestId !== message.clientRequestId || current.memberConversationId !== message.memberConversationId) throw error('CONFLICT', '渠道消息受理状态已变化')
      message = compact({ ...current, status: rejected ? 'rejected' : 'accepted', turnId: turn?.id, error: rejected })
      return { ...state, channelMessages: replaceById(state.channelMessages, message) }
    })
    return durableInboxReceipt(message)
  }

  return {
    handleInbound,

    async recover() {
      let recovered = 0
      await store.update(state => ({
        ...state,
        channelMessages: state.channelMessages.map(message => {
          if (!['received', 'reserved'].includes(message.status)) return message
          const conversation = state.conversations.find(item => item.id === message.memberConversationId)
          const turn = message.clientRequestId && conversation?.turns.find(item => item.clientRequestId === message.clientRequestId)
          return turn ? compact({ ...message, status: 'accepted', turnId: turn.id, error: undefined })
            : { ...message, status: 'rejected', error: inboundError('CHANNEL_RECOVERY_INTERRUPTED') }
        }),
        deliveries: state.deliveries.map(delivery => {
          if (delivery.status !== 'sending') return delivery
          recovered += 1
          return { ...delivery, status: 'unknown', error: { code: 'RECOVERY_UNKNOWN', message: '发送效果待核对' }, updatedAt: now(clock) }
        }),
      }))
      return { recoveredDeliveries: recovered, startedMessages: 0, retriedDeliveries: 0 }
    },

    async ensureAutomationDeliveries({ ownerCheck } = {}) {
      const assertOwner = () => { if (ownerCheck && !ownerCheck()) throw error('OWNER_LOCK_LOST', 'automation owner lock 已失效') }
      assertOwner()
      const outputs = []
      await store.update(state => {
        assertOwner()
        let next = state
        for (const occurrence of state.automationOccurrences) {
          if (!occurrence.workId) continue
          if (occurrence.deliveryId) {
            const delivery = state.deliveries.find(item => item.id === occurrence.deliveryId)
            if (delivery?.status === 'pending') outputs.push(delivery)
            continue
          }
          const work = state.works.find(item => item.id === occurrence.workId)
          const execution = work?.executions?.find(item => item.operation === 'automation' && item.clientRequestId === occurrence.occurrenceKey)
          if (!work || !execution || !['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.status)) continue
          const created = automationDelivery(next, occurrence, work, execution, clock, idFactory, connectionCatalog)
          if (!created) continue
          next = created.state
          outputs.push(created.delivery)
        }
        return next
      }, { beforeCommit: assertOwner })
      return { deliveries: outputs.map(deliveryDto) }
    },

    async abandonAutomationClaim({ deliveryId } = {}) {
      let output
      await store.update(state => {
        const delivery = state.deliveries.find(item => item.id === clean(deliveryId))
        if (!delivery || !automationOccurrence(state, delivery)) throw error('NOT_FOUND', '自动投递不存在')
        if (delivery.status !== 'sending') throw transitionError(delivery.status)
        output = { ...delivery, status: 'unknown', error: { code: 'DELIVERY_UNKNOWN', message: '发送效果待核对' }, updatedAt: now(clock) }
        return { ...state, deliveries: replaceById(state.deliveries, output) }
      })
      return deliveryDto(output)
    },

    async listChannelApps(actor) {
      const state = await store.read(), member = requireMember(state, actor)
      const ownedApps = new Set([...state.channelIdentities, ...state.linkCodes].filter(item => item.memberId === member.id).map(item => item.channelAppId))
      return state.channelApps.filter(app => member.role === 'admin' || app.enabled && app.status === 'active' || ownedApps.has(app.id) || app.id === 'channel-app-weixin').map(app => appDto(app, member.role === 'admin'))
    },

    async getChannelDefaults(actor) {
      const state = await store.read()
      requireAdmin(state, actor)
      return { defaultChannelEmployeeId: state.defaultChannelEmployeeId ?? null }
    },

    async setChannelDefaults(actor, { defaultChannelEmployeeId } = {}) {
      if (defaultChannelEmployeeId !== null) defaultChannelEmployeeId = requiredId(defaultChannelEmployeeId, 'defaultChannelEmployeeId')
      await store.update(state => {
        requireAdmin(state, actor)
        if (defaultChannelEmployeeId !== null && !state.employees.some(employee => employee.id === defaultChannelEmployeeId && employee.enabled === true)) throw error('INVALID_REQUEST', '请选择已启用的默认员工')
        return { ...state, defaultChannelEmployeeId }
      })
      return { defaultChannelEmployeeId }
    },

    async ensureBuiltinWeixinApp() {
      let output
      await store.update(state => {
        const current = state.channelApps.find(item => item.id === 'channel-app-weixin')
        if (current) { output = current; return state }
        const timestamp = now(clock)
        output = { id: 'channel-app-weixin', provider: 'weixin', providerAppId: 'ilink', providerTenantId: 'personal', credentialRef: null,
          enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: timestamp, updatedAt: timestamp,
        }
        return { ...state, channelApps: [...state.channelApps, output] }
      })
      return appDto(output, false)
    },

    async beginWeixinBinding(actor, { channelAppId = 'channel-app-weixin' } = {}) {
      let output
      await store.update(state => {
        const timestamp = now(clock), member = requireMember(state, actor), app = activeApp(state, channelAppId)
        if (app.provider !== 'weixin') throw error('INVALID_REQUEST', '不是内置微信渠道')
        if (state.channelIdentities.some(item => item.channelAppId === app.id && item.memberId === member.id && item.status === 'active')) throw error('CONFLICT', '请先解绑已有微信身份')
        state = closeLinks(expireLinks(state, timestamp), link => link.memberId === member.id && link.channelAppId === app.id && ['active', 'matched'].includes(link.status), 'cancelled', timestamp)
        const id = `link-${idFactory()}`, prefix = `weixin-${sha256(id).slice(0, 32)}`
        output = { id, kind: 'weixin-qr', channelAppId: app.id, memberId: member.id, digest: sha256(randomBytesFactory(32)), status: 'active', failedAttempts: 0,
          loginRef: `${prefix}-login`, tokenRef: `${prefix}-token`, cursorRef: `${prefix}-cursor`, contextRef: `${prefix}-context`,
          expiresAt: new Date(Date.parse(timestamp) + LINK_TTL_MS).toISOString(), createdAt: timestamp, updatedAt: timestamp,
        }
        return { ...state, linkCodes: [...state.linkCodes, output] }
      })
      return structuredClone(output)
    },

    // Private transport projection. HTTP callers receive linkDto/memberChannelState instead.
    async getWeixinBinding(actor, { linkCodeId } = {}) {
      const state = await store.read(), member = requireMember(state, actor), link = state.linkCodes.find(item => item.id === clean(linkCodeId) && item.memberId === member.id && item.kind === 'weixin-qr')
      if (!link) throw error('NOT_FOUND', '扫码绑定不存在')
      return structuredClone(link)
    },

    async setWeixinQr({ linkCodeId, qrcodeUrl } = {}) {
      let output
      await store.update(state => {
        const link = state.linkCodes.find(item => item.id === clean(linkCodeId) && item.kind === 'weixin-qr'), timestamp = now(clock)
        if (!link || link.status !== 'active' || Date.parse(link.expiresAt) <= Date.parse(timestamp)) throw invalidLink()
        if (typeof qrcodeUrl !== 'string' || qrcodeUrl.length > 4096) throw error('INVALID_REQUEST', '扫码地址无效')
        output = { ...link, qrcodeUrl, updatedAt: timestamp }
        return { ...state, linkCodes: replaceById(state.linkCodes, output) }
      })
      return linkDto(output)
    },

    async finishWeixinBinding({ linkCodeId, status = 'cancelled', code = 'WEIXIN_BINDING_UNAVAILABLE' } = {}) {
      if (!['expired', 'cancelled'].includes(status) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw error('INVALID_REQUEST', '扫码终态无效')
      await store.update(state => {
        const link = state.linkCodes.find(item => item.id === clean(linkCodeId) && item.kind === 'weixin-qr')
        if (!link || !['active', 'matched'].includes(link.status)) return state
        const next = closeLinks(state, item => item.id === link.id, status, now(clock))
        return { ...next, linkCodes: next.linkCodes.map(item => item.id === link.id ? { ...item, error: { code, message: '微信绑定暂不可用，请重新扫码' } } : item) }
      })
    },

    async matchWeixinLogin({ linkCodeId, botId, ownerUserId, baseUrl } = {}) {
      botId = requiredOfficialId(botId, 'botId'); ownerUserId = requiredOfficialId(ownerUserId, 'ownerUserId')
      let output, invalid = false
      await store.update(state => {
        const timestamp = now(clock)
        state = expireLinks(state, timestamp)
        const link = state.linkCodes.find(item => item.id === clean(linkCodeId) && item.kind === 'weixin-qr')
        const app = state.channelApps.find(item => item.id === link?.channelAppId && item.provider === 'weixin' && item.enabled === true && item.status === 'active')
        const member = state.members.find(item => item.id === link?.memberId && item.enabled === true)
        if (!link || link.status !== 'active' || !app || !member || state.channelIdentities.some(item => ['active', 'pending'].includes(item.status)
          && (item.weixin?.botId === botId || item.channelAppId === app.id && item.providerUserId === ownerUserId))) { invalid = true; return state }
        const identity = { id: `channel-identity-${idFactory()}`, channelAppId: app.id, providerUserId: ownerUserId, memberId: member.id,
          verificationMethod: 'weixin-qr', status: 'pending', revision: 1, defaultEmployeeId: null, activeConversationId: null,
          weixin: { botId, baseUrl, tokenRef: link.tokenRef, cursorRef: link.cursorRef, contextRef: link.contextRef, runtimeState: 'pending' }, createdAt: timestamp, updatedAt: timestamp,
        }
        const endpoint = { id: `channel-conversation-${idFactory()}`, channelAppId: app.id, providerConversationId: ownerUserId, identityId: identity.id, memberId: member.id,
          type: 'private', allowedScopes: [...app.allowedScopes], verificationMethod: 'weixin-qr', status: 'pending', revision: 1, createdAt: timestamp, updatedAt: timestamp,
        }
        output = { ...link, status: 'matched', matchedIdentityId: identity.id, matchedConversationId: endpoint.id, matchedAt: timestamp, updatedAt: timestamp }
        return { ...state, channelIdentities: [...state.channelIdentities, identity], channelConversations: [...state.channelConversations, endpoint], linkCodes: replaceById(state.linkCodes, output) }
      })
      if (invalid) throw invalidLink()
      return linkDto(output)
    },

    async cancelWeixinBinding(actor, { linkCodeId } = {}) {
      let output
      await store.update(state => {
        const member = requireMember(state, actor), link = state.linkCodes.find(item => item.id === clean(linkCodeId) && item.memberId === member.id && item.kind === 'weixin-qr')
        if (!link) throw error('NOT_FOUND', '扫码绑定不存在')
        if (link.status === 'consumed') throw error('CONFLICT', '已确认身份请使用解绑')
        const next = closeLinks(state, item => item.id === link.id && ['active', 'matched'].includes(item.status), 'cancelled', now(clock))
        output = next.linkCodes.find(item => item.id === link.id)
        return next
      })
      await onIdentityChanged({ identityId: output.matchedIdentityId })
      return linkDto(output)
    },

    async setWeixinRuntime({ identityId, botId, state: runtimeState, error: runtimeError } = {}) {
      if (!['connecting', 'connected', 'reconnecting', 'unavailable', 'stopped'].includes(runtimeState)) throw error('INVALID_REQUEST', '微信连接状态无效')
      await store.update(state => {
        const identity = state.channelIdentities.find(item => item.id === clean(identityId) && item.weixin?.botId === botId)
        const app = state.channelApps.find(item => item.id === identity?.channelAppId && item.enabled === true)
        if (!identity || ((!app || !['active', 'pending'].includes(identity.status)) && !['stopped', 'unavailable'].includes(runtimeState))) throw error('CHANNEL_RUNTIME_STALE', '微信身份已变化')
        if (identity.weixin.runtimeState === 'unavailable' && (runtimeState === 'stopped' || identity.status === 'rebind-required')) return state
        const code = runtimeError ? /^[A-Z][A-Z0-9_]{0,63}$/.test(runtimeError.code) ? runtimeError.code : 'WEIXIN_UNAVAILABLE' : undefined
        const invalid = runtimeState === 'unavailable' && ['WEIXIN_STALE_TOKEN', 'WEIXIN_AUTH_REJECTED', 'WEIXIN_SECRET_UNAVAILABLE'].includes(code)
        const timestamp = now(clock)
        const next = { ...identity, ...(invalid ? { status: 'rebind-required', activeConversationId: null, revision: identity.revision + 1 } : {}),
          weixin: compact({ ...identity.weixin, runtimeState, error: code ? { code } : undefined }), updatedAt: timestamp,
        }
        if (!invalid) return { ...state, channelIdentities: replaceById(state.channelIdentities, next) }
        return { ...state, channelIdentities: replaceById(state.channelIdentities, next),
          channelConversations: state.channelConversations.map(endpoint => endpoint.identityId === identity.id && ['active', 'pending'].includes(endpoint.status)
            ? { ...endpoint, status: 'rebind-required', revision: endpoint.revision + 1, updatedAt: timestamp } : endpoint),
          deliveries: invalidateClaims(state.deliveries, delivery => delivery.targetIdentityId === identity.id && ['pending', 'sending'].includes(delivery.status), timestamp, 'WEIXIN_REBIND_REQUIRED', '微信账号已失效，请重新扫码绑定'),
          linkCodes: state.linkCodes.map(link => link.matchedIdentityId === identity.id && ['active', 'matched'].includes(link.status)
            ? { ...link, status: 'cancelled', error: { code: 'WEIXIN_REBIND_REQUIRED', message: '微信账号已失效，请重新扫码绑定' }, updatedAt: timestamp } : link),
        }
      })
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
        if (provider === 'weixin' && (id !== 'channel-app-weixin' || providerAppId !== 'ilink' || providerTenantId !== 'personal')) throw error('INVALID_REQUEST', '微信使用内置渠道入口')
        const credentialRef = provider === 'weixin' ? null : credentialReference(input.credentialRef ?? current?.credentialRef)
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
        if (state.channelIdentities.some(item => item.channelAppId === app.id && item.providerUserId === input.providerUserId && ['active', 'pending'].includes(item.status))
          || state.channelConversations.some(item => item.channelAppId === app.id && item.providerConversationId === input.providerConversationId && ['active', 'pending'].includes(item.status))) {
          invalid = true
          return failLink(state, link, timestamp)
        }
        const identity = { id: `channel-identity-${idFactory()}`, channelAppId: app.id, providerUserId: input.providerUserId, memberId: link.memberId,
          verificationMethod: 'link-code', status: 'pending', revision: 1, defaultEmployeeId: null, activeConversationId: null, createdAt: timestamp, updatedAt: timestamp }
        const conversation = { id: `channel-conversation-${idFactory()}`, channelAppId: app.id, providerConversationId: input.providerConversationId,
          identityId: identity.id, memberId: link.memberId, type: 'private', allowedScopes: [...app.allowedScopes], verificationMethod: 'link-code', status: 'pending', revision: 1, createdAt: timestamp, updatedAt: timestamp }
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

    async confirmLink(actor, { linkCodeId, employeeId } = {}) {
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
        const selected = selectChannelConversation(state, { member, app, identity, commandConversation: conversation }, { forceNew: true, employeeId }, clock, idFactory)
        state = selected.state
        const activeIdentity = { ...state.channelIdentities.find(item => item.id === identity.id), status: 'active', updatedAt: timestamp }
        const activeConversation = { ...conversation, status: 'active', updatedAt: timestamp }
        output = { ...link, status: 'consumed', consumedAt: timestamp, updatedAt: timestamp }
        return { ...state, channelIdentities: replaceById(state.channelIdentities, activeIdentity), channelConversations: replaceById(state.channelConversations, activeConversation), linkCodes: replaceById(state.linkCodes, output) }
      })
      if (invalid) throw invalidLink()
      await onIdentityChanged({ identityId: output.matchedIdentityId })
      return linkDto(output)
    },

    async rotateConversation(actor, { identityId, employeeId } = {}) {
      if (employeeId !== undefined && employeeId !== null) employeeId = requiredId(employeeId, 'employeeId')
      let output
      await store.update(state => {
        const member = requireMember(state, actor), identity = state.channelIdentities.find(item => item.id === clean(identityId) && item.memberId === member.id && item.status === 'active')
        const app = state.channelApps.find(item => item.id === identity?.channelAppId && item.enabled === true && item.status === 'active')
        const endpoint = identity && uniquePrivateConversation(state, app?.id, identity.id)
        if (!identity || !app || !endpoint) throw error('NOT_FOUND', '渠道身份当前不可用')
        const selected = selectChannelConversation(state, { member, identity, app, commandConversation: endpoint }, { forceNew: true, employeeId }, clock, idFactory)
        output = { identityId: identity.id, conversationId: selected.conversation.id, employeeId: selected.conversation.employeeId }
        return selected.state
      })
      return output
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
        output = { ...identity, status: 'unlinked', activeConversationId: null, revision: identity.revision + 1, updatedAt: timestamp, unlinkedAt: timestamp }
        const conversations = state.channelConversations.map(item => item.identityId === identity.id && item.status !== 'unlinked' ? { ...item, status: 'unlinked', revision: item.revision + 1, updatedAt: timestamp, unlinkedAt: timestamp } : item)
        const deliveries = invalidateClaims(state.deliveries, item => item.targetIdentityId === identity.id && ['pending', 'sending'].includes(item.status), timestamp, 'IDENTITY_UNLINKED', '渠道身份已解绑')
        return { ...state, channelIdentities: replaceById(state.channelIdentities, output), channelConversations: conversations, deliveries, linkCodes: closeLinks(state, link => link.memberId === identity.memberId && link.channelAppId === identity.channelAppId && ['active', 'matched'].includes(link.status), 'cancelled', timestamp).linkCodes }
      })
      await onIdentityChanged({ identityId: output.id })
      return identityDto(output)
    },

    async setDefaultDispatch(actor) {
      requireMember(await store.read(), actor)
      throw error('SOURCE_RETIRED', '旧默认派发已停用，请为渠道选择对话员工')
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
          const conflict = persistInboundConflict(state, input, resolved, clock, idFactory)
          output = conflict.message
          return conflict.state
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
        if (!identity || !source || channelOriginClosed(identity, source)) return state
        const baseRequest = requiredId(requestId, 'requestId')
        const specs = []
        if (source.type === 'group') {
          specs.push({ suffix: 'group', conversation: source, contentScope: 'fixed', contentKey: message.status === 'accepted' ? 'group.accepted' : fixedHelpKey(message) })
        } else if (message.status === 'rejected' || message.noticeKey) {
          specs.push({ suffix: 'private', conversation: source, contentScope: 'fixed', contentKey: message.noticeKey ?? fixedHelpKey(message) })
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
      const message = (await store.read()).channelMessages.find(item => item.id === clean(channelMessageId))
      if (message?.turnId) {
        const replies = await this.ensureConversationDeliveries({ conversationId: message.memberConversationId, turnId: message.turnId })
        outputs.push(...replies.deliveries)
      }
      return { deliveries: outputs.map(deliveryDto), deduplicated }
    },

    async createWorkDelivery(actor, { workId, resultId, requestId } = {}) {
      const state = await store.read(), member = requireMember(state, actor)
      const work = state.works.find(item => item.id === clean(workId) && item.ownerMemberId === member.id)
      const target = work && workChannelTarget(state, work)
      if (!target) throw error('NOT_FOUND', '工作没有可用的已验证私聊来源')
      const { origin, identity, conversation } = target
      return this.createDelivery(actor, compact({ channelAppId: identity.channelAppId, requestId, workId: work.id, resultId, channelMessageId: origin?.id, targetIdentityId: identity.id, targetConversationId: conversation.id, contentScope: 'result' }))
    },

    async createConversationDelivery(actor, input = {}) {
      let created
      await store.update(state => {
        created = conversationReplyDelivery(state, actor, input, clock, idFactory)
        return created.state
      })
      return { delivery: deliveryDto(created.delivery), deduplicated: created.deduplicated }
    },

    async ensureConversationDeliveries({ conversationId, turnId } = {}) {
      let output
      await store.update(state => {
        const conversation = state.conversations.find(item => item.id === conversationId)
        const turn = conversation?.turns.find(item => item.id === turnId && item.status === 'completed')
        const message = turn && state.channelMessages.find(item => item.memberConversationId === conversation.id && item.clientRequestId === turn.clientRequestId && ['reserved', 'accepted'].includes(item.status))
        if (!conversation || !turn || !message) return state
        const identity = state.channelIdentities.find(item => item.id === message.senderIdentityId)
        const source = state.channelConversations.find(item => item.id === message.conversationId)
        if (channelOriginClosed(identity, source)) return state
        const created = conversationReplyDelivery(state, { id: conversation.ownerMemberId }, { identityId: conversation.channelIdentityId, conversationId,
          turnId, requestId: `conversation:${sha256(`${conversationId}\0${turnId}`)}`, channelMessageId: message.id,
        }, clock, idFactory)
        output = created.delivery
        return created.state
      })
      return { deliveries: output ? [deliveryDto(output)] : [] }
    },

    authorizeDelivery,
    retryDelivery(input = {}) { return authorizeDelivery({ ...input, retry: true }) },
    validateSendClaim,

    async recordDeliveryOutcome({ deliveryId, status, providerMessageId, error: outcomeError } = {}) {
      if (!DELIVERY_OUTCOMES.has(status)) throw error('INVALID_REQUEST', '投递结果状态无效')
      return transitionDelivery(store, clock, deliveryId, ['sending'], status, providerMessageId, outcomeError)
    },

    async recordSendProgress({ deliveryId, attemptId, status, totalParts, textDigest, acknowledgedParts, partIndex, error: outcomeError } = {}) {
      let output
      await store.update(state => {
        const delivery = state.deliveries.find(item => item.id === clean(deliveryId))
        const progress = delivery?.sendProgress ?? (['failed', 'blocked'].includes(status) && acknowledgedParts?.length === 0 ? { attemptId: delivery && deliveryAttemptId(delivery), totalParts, textDigest, acknowledgedParts: [] } : undefined)
        if (!delivery || !progress || progress.attemptId !== attemptId || progress.totalParts !== totalParts || progress.textDigest !== textDigest
          || !Number.isSafeInteger(totalParts) || totalParts < 1 || !/^[a-f0-9]{64}$/.test(textDigest ?? '')
          || !['sending', 'delivered', 'failed', 'unknown', 'blocked'].includes(status) || !Array.isArray(acknowledgedParts)
          || acknowledgedParts.length < progress.acknowledgedParts.length || acknowledgedParts.length > totalParts
          || acknowledgedParts.some((part, index) => part.index !== index || part.clientId !== `geneway-weixin-${sha256(`${attemptId}\0${index}`).slice(0, 32)}`)
          || (status === 'delivered' && acknowledgedParts.length !== totalParts)
          || (partIndex !== undefined && (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= totalParts || partIndex > acknowledgedParts.length))) throw error('SEND_PROGRESS_INVALID', '发送进展与原投递不一致')
        const nextProgress = compact({ ...progress, acknowledgedParts: acknowledgedParts.map(part => ({ index: part.index, clientId: part.clientId })), partIndex: partIndex === acknowledgedParts.length ? partIndex : undefined })
        const live = delivery.status === 'sending'
        output = compact({ ...delivery, sendProgress: nextProgress, ...(live ? { status,
          providerMessageId: status === 'delivered' ? acknowledgedParts.at(-1).clientId : undefined,
          error: status === 'sending' || status === 'delivered' ? undefined : safeOutcomeError(outcomeError, status), updatedAt: now(clock),
        } : {}) })
        return { ...state, deliveries: replaceById(state.deliveries, output) }
      })
      return deliveryDto(output)
    },

    async reconcileDelivery({ deliveryId, status, providerMessageId, error: outcomeError } = {}) {
      if (!RECONCILED_OUTCOMES.has(status)) throw error('INVALID_REQUEST', '核对结果状态无效')
      return transitionDelivery(store, clock, deliveryId, ['unknown'], status, providerMessageId, outcomeError)
    },

    async cancelDelivery(actor, { deliveryId } = {}) {
      let output
      await store.update(state => {
        const member = requireMember(state, actor), delivery = state.deliveries.find(item => item.id === clean(deliveryId))
        const identity = state.channelIdentities.find(item => item.id === delivery?.targetIdentityId)
        const source = delivery?.sourceRef?.kind === 'conversation-turn' && state.conversations.find(item => item.id === delivery.sourceRef.conversationId)
        const work = state.works.find(item => item.id === delivery?.workId)
        if (!delivery || (source?.ownerMemberId ?? work?.ownerMemberId ?? identity?.memberId) !== member.id) throw error('NOT_FOUND', '投递不存在')
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
        defaultChannelEmployeeId: state.defaultChannelEmployeeId ?? null,
        workChannels: state.works.filter(work => work.ownerMemberId === member.id).flatMap(work => {
          const target = workChannelTarget(state, work)
          return target ? [{ workId: work.id, channelAppId: target.identity.channelAppId, conversationId: target.conversation.id }] : []
        }),
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
  const account = app.provider === 'weixin' ? input.providerAccountId : undefined
  const inAccount = item => item.channelAppId === app.id && item.providerAccountId === account
  if (!providerEventId && !providerMessageId) return { message: state.channelMessages.find(item => inAccount(item) && item.providerMessageId === invalidMessageId(input)) }
  const eventMatch = providerEventId && state.channelMessages.find(item => inAccount(item) && item.providerEventId === providerEventId)
  const messageMatch = providerMessageId && state.channelMessages.find(item => inAccount(item) && item.providerMessageId === providerMessageId)
  if (!eventMatch && !messageMatch) {
    const conflicted = state.channelMessages.find(item => inAccount(item) && item.conflicts?.some(conflict =>
      (providerEventId && conflict.providerEventId === providerEventId) || (providerMessageId && conflict.providerMessageId === providerMessageId)))
    if (conflicted) return { conflict: true, message: conflicted }
  }
  if (providerEventId && providerMessageId) {
    if (eventMatch && messageMatch) return eventMatch.id === messageMatch.id && sameInboundBody(eventMatch, input) ? { message: eventMatch } : { conflict: true, message: eventMatch }
    if (eventMatch || messageMatch) {
      const match = eventMatch || messageMatch
      if (match.providerEventId === providerEventId && match.providerMessageId === providerMessageId && sameInboundBody(match, input)) return { message: match }
      return { conflict: true, message: match, unmatched: eventMatch ? 'message' : 'event' }
    }
  }
  const message = eventMatch || messageMatch || undefined
  return message && !sameInboundBody(message, input) ? { conflict: true, message } : { message }
}

function inboundBody(input) {
  return { providerAccountId: input.providerAccountId ?? null, providerUserId: input.providerUserId ?? null, providerConversationId: input.providerConversationId ?? null, text: typeof input.text === 'string' ? input.text : null,
    conversationType: input.conversationType ?? 'private', replyToProviderMessageId: input.replyToProviderMessageId ?? null,
    rejectionCode: input.rejectionCode ?? (input.attachments ? 'UNSUPPORTED' : null),
  }
}
function sameInboundBody(message, input) {
  const digest = message.bodyDigest ?? sha256(JSON.stringify(inboundBody({ ...message, conversationType: message.conversationType ?? 'private' })))
  return digest === sha256(JSON.stringify(inboundBody(input)))
}
function invalidMessageId(input) { return `invalid-${sha256(JSON.stringify(inboundBody(input)))}` }
function persistInboundConflict(state, input, resolved, clock, idFactory) {
  const original = resolved.message
  if (!original) {
    const message = { ...newInbound(state, input, clock, idFactory), status: 'rejected', error: inboundError('OFFICIAL_ID_CONFLICT') }
    return { state: { ...state, channelMessages: [...state.channelMessages, message] }, message }
  }
  const digest = sha256(JSON.stringify({ ...inboundBody(input), providerEventId: input.providerEventId ?? null, providerMessageId: input.providerMessageId ?? null }))
  const conflicts = original.conflicts ?? []
  const updated = conflicts.some(item => item.digest === digest) ? original : { ...original, conflicts: [...conflicts, compact({ digest,
    providerEventId: input.providerEventId, providerMessageId: input.providerMessageId, receivedAt: now(clock), error: inboundError('OFFICIAL_ID_CONFLICT'),
  })] }
  return { state: { ...state, channelMessages: replaceById(state.channelMessages, updated) }, message: { ...original, status: 'rejected', error: inboundError('OFFICIAL_ID_CONFLICT') } }
}

function durableInboxReceipt(message) {
  return compact({ status: message.status === 'accepted' ? 'accepted' : 'rejected', messageId: message.id,
    conversationId: message.memberConversationId, turnId: message.turnId, ...(message.error ? { code: message.error.code } : {}),
  })
}

function inboundAuthorized(state, message) {
  const context = currentInboundContext(state, message), revisions = message.authorizationRevisions
  const conversation = state.conversations.find(item => item.id === message.memberConversationId)
  return Boolean(context && revisions && revisions.app === context.app.revision && revisions.identity === context.identity.revision
    && revisions.conversation === context.commandConversation.revision && ['reserved', 'accepted'].includes(message.status)
    && conversation?.ownerMemberId === context.member.id && conversation.channelIdentityId === context.identity.id
    && replyParentMatches(state, message, conversation, context))
}

function replyParentMatches(state, message, conversation, context) {
  if (!message.replyToProviderMessageId) return true
  const parents = state.channelMessages.filter(parent => parent.direction === 'inbound' && parent.channelAppId === message.channelAppId
    && parent.providerAccountId === message.providerAccountId && parent.providerMessageId === message.replyToProviderMessageId)
    .map(parent => ({ identityId: parent.senderIdentityId, endpointId: parent.conversationId,
      conversationId: parent.status === 'accepted' ? parent.memberConversationId : undefined }))
  // iLink currently acknowledges our clientId, not an official reply-parent ID.
  if (context.app.provider === 'feishu') for (const delivery of state.deliveries) {
    if (delivery.channelAppId !== message.channelAppId || delivery.status !== 'delivered' || delivery.providerMessageId !== message.replyToProviderMessageId) continue
    const origin = state.channelMessages.find(item => item.id === delivery.channelMessageId && item.status === 'accepted')
    const sourceConversationId = delivery.sourceRef?.kind === 'conversation-turn' ? delivery.sourceRef.conversationId
      : delivery.workId ? state.works.find(item => item.id === delivery.workId)?.conversationId : origin?.memberConversationId
    parents.push({ identityId: delivery.targetIdentityId, endpointId: delivery.targetConversationId, conversationId: sourceConversationId })
  }
  const parent = parents[0]
  return parents.length === 1 && parent.identityId === context.identity.id && parent.endpointId === context.conversation.id
    && parent.conversationId === conversation?.id && conversation?.ownerMemberId === context.member.id && conversation.channelIdentityId === context.identity.id
}

function selectChannelConversation(state, context, { forceNew = false, employeeId } = {}, clock, idFactory) {
  const chosen = (employeeId === undefined ? context.identity.defaultEmployeeId : employeeId) ?? state.defaultChannelEmployeeId
  if (!chosen) throw error('CHANNEL_DEFAULT_REQUIRED', '请在 Web 选择当前获准的员工')
  requireConversationEmployee(state, context.member, state.employees.find(employee => employee.id === chosen))
  const current = state.conversations.find(item => item.id === context.identity.activeConversationId)
  if (current && (current.ownerMemberId !== context.member.id || current.channelIdentityId !== context.identity.id)) throw error('FORBIDDEN', '渠道会话归属无效')
  const changed = current && !context.identity.defaultEmployeeId && current.employeeId !== chosen
  if (current && !current.archivedAt && !forceNew && !changed) return { state, conversation: current, changed: false }
  if (current?.turns.some(turn => ['accepted', 'running'].includes(turn.status))) throw error('CHANNEL_BUSY', '请先结束当前回复，再重新发送')
  const timestamp = now(clock), conversation = newConversationRecord(state, context.member, { id: `conversation-${idFactory()}`, employeeId: chosen,
    title: '渠道对话', source: context.app.provider, channelIdentityId: context.identity.id,
  }, timestamp)
  const identity = { ...context.identity, activeConversationId: conversation.id, ...(employeeId === undefined ? {} : { defaultEmployeeId: employeeId }), updatedAt: timestamp }
  return { state: { ...state, conversations: [...state.conversations, conversation], channelIdentities: replaceById(state.channelIdentities, identity) }, conversation, changed: Boolean(changed) }
}

function newInbound(state, input, clock, idFactory) {
  const app = state.channelApps.find(item => item.id === clean(input.channelAppId))
  if (!app) throw error('NOT_FOUND', '渠道应用不存在')
  const providerEventId = optionalOfficialId(input.providerEventId, 'providerEventId')
  const providerMessageId = optionalOfficialId(input.providerMessageId, 'providerMessageId') ?? (!providerEventId ? invalidMessageId(input) : undefined)
  const replyToProviderMessageId = optionalOfficialId(input.replyToProviderMessageId, 'replyToProviderMessageId')
  if (!providerEventId && !providerMessageId) throw error('INVALID_REQUEST', '渠道消息缺少官方稳定 ID')
  const providerConversationId = validOfficialId(input.providerConversationId) ? input.providerConversationId : undefined
  const providerUserId = validOfficialId(input.providerUserId) ? input.providerUserId : undefined
  const body = typeof input.text === 'string' && input.text.length <= 16_000 ? input.text : undefined
  const providerAccountId = app.provider === 'weixin' && validOfficialId(input.providerAccountId) ? input.providerAccountId : undefined
  const matches = item => item.channelAppId === app.id && item.providerUserId === providerUserId && (app.provider !== 'weixin' || item.weixin?.botId === providerAccountId)
  const identity = state.channelIdentities.find(item => matches(item) && item.status === 'active')
    ?? state.channelIdentities.find(item => matches(item) && item.status === 'pending')
  const conversation = state.channelConversations.find(item => item.channelAppId === app.id && item.providerConversationId === providerConversationId && item.status === 'active')
    ?? state.channelConversations.find(item => item.channelAppId === app.id && item.providerConversationId === providerConversationId && item.status === 'pending')
  const type = input.conversationType ?? 'private'
  const privateConversation = identity && uniquePrivateConversation(state, app.id, identity.id)
  const allowed = app.enabled && app.status === 'active' && identity?.status === 'active' && conversation?.status === 'active' && conversation.type === type
    && (type === 'group' || conversation.identityId === identity.id && conversation.memberId === identity.memberId)
    && (type === 'private' || input.botMentioned === true && privateConversation)
  const rejection = input.rejectionCode || input.attachments || body === undefined || !body.trim() || !providerUserId || !providerConversationId || app.provider === 'weixin' && !providerAccountId
    || state.linkCodes.some(link => link.digest === sha256(body.trim()))
  const reason = rejection ? input.rejectionCode ?? 'UNSUPPORTED' : identity?.status === 'pending' ? 'CHANNEL_CONFIRMATION_REQUIRED' : 'CHANNEL_UNAVAILABLE'
  const timestamp = now(clock)
  return compact({
    id: `channel-message-${idFactory()}`, channelAppId: app.id, providerAccountId, providerEventId, providerMessageId,
    replyToProviderMessageId, providerConversationId, providerUserId, conversationId: conversation?.id, senderIdentityId: identity?.id,
    direction: 'inbound', text: body ?? '', conversationType: type, bodyDigest: sha256(JSON.stringify(inboundBody(input))),
    rejectionCode: input.rejectionCode, receivedAt: input.receivedAt ? requiredTimestamp(input.receivedAt, 'receivedAt') : timestamp,
    persistedAt: timestamp, status: allowed && !rejection ? 'received' : 'rejected',
    error: allowed && !rejection ? undefined : inboundError(reason),
  })
}

function ensureGroupConversation(state, input, clock, idFactory) {
  if (input.conversationType !== 'group' || input.botMentioned !== true) return state
  const app = state.channelApps.find(item => item.id === clean(input.channelAppId) && item.enabled === true && item.status === 'active')
  const providerUserId = validOfficialId(input.providerUserId) ? input.providerUserId : undefined
  const providerConversationId = validOfficialId(input.providerConversationId) ? input.providerConversationId : undefined
  const identity = state.channelIdentities.find(item => item.channelAppId === app?.id && item.providerUserId === providerUserId && item.status === 'active')
  const privateConversation = identity && uniquePrivateConversation(state, app.id, identity.id)
  if (!app || !identity || !privateConversation || !providerConversationId) return state
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

function channelOriginClosed(identity, endpoint) {
  if (!identity || !endpoint || identity.channelAppId !== endpoint.channelAppId
    || endpoint.type === 'private' && (endpoint.identityId !== identity.id || endpoint.memberId !== identity.memberId)) return false
  return [identity, endpoint].some(item => ['unlinked', 'rebind-required'].includes(item.status))
}

function conversationReplyDelivery(state, actor, { identityId, conversationId, turnId, requestId, channelMessageId } = {}, clock, idFactory) {
  const member = requireMember(state, actor), conversation = state.conversations.find(item => item.id === clean(conversationId) && item.ownerMemberId === member.id)
  const identity = state.channelIdentities.find(item => item.id === clean(identityId) && item.memberId === member.id && item.status === 'active')
  const endpoint = identity && uniquePrivateConversation(state, identity.channelAppId, identity.id)
  const turn = conversation?.turns.find(item => item.id === clean(turnId) && item.status === 'completed')
  if (!identity || !endpoint || !conversation || conversation.channelIdentityId !== identity.id || !turn) throw error('NOT_FOUND', '本人渠道回复当前不可用')
  const sourceRef = { kind: 'conversation-turn', conversationId: conversation.id, turnId: turn.id }
  const stableRequest = requiredId(requestId, 'requestId'), existing = state.deliveries.find(item => item.channelAppId === identity.channelAppId && item.requestId === stableRequest)
  if (existing) {
    if (existing.targetIdentityId !== identity.id || JSON.stringify(existing.sourceRef) !== JSON.stringify(sourceRef)) throw error('CONFLICT', '投递请求已绑定其他回复')
    return { state, delivery: existing, deduplicated: true }
  }
  const timestamp = now(clock)
  const delivery = compact({ id: `delivery-${idFactory()}`, channelAppId: identity.channelAppId, requestId: stableRequest,
    sourceRef, channelMessageId, targetIdentityId: identity.id, targetConversationId: endpoint.id, contentScope: 'result', contentKey: 'conversation.reply',
    status: 'pending', attempts: 0, createdAt: timestamp, updatedAt: timestamp,
  })
  return { state: { ...state, deliveries: [...state.deliveries, delivery] }, delivery, deduplicated: false }
}

function workChannelTarget(state, work) {
  const source = state.conversations.find(item => item.id === work.conversationId && item.ownerMemberId === work.ownerMemberId)
  const origins = state.channelMessages.filter(item => item.workId === work.id && item.status === 'accepted' && item.command?.type === 'create')
  const origin = new Set(origins.map(item => `${item.channelAppId}\0${item.senderIdentityId}`)).size === 1 ? origins[0] : undefined
  const identity = state.channelIdentities.find(item => item.id === (source?.channelIdentityId ?? origin?.senderIdentityId) && item.memberId === work.ownerMemberId && item.status === 'active')
  const conversation = identity && uniquePrivateConversation(state, identity.channelAppId, identity.id)
  return identity && conversation ? { identity, conversation, origin } : undefined
}

function currentInboundContext(state, message) {
  const app = state.channelApps.find(item => item.id === message.channelAppId && item.enabled === true && item.status === 'active')
  const identity = state.channelIdentities.find(item => item.id === message.senderIdentityId && item.channelAppId === app?.id && item.status === 'active')
  const conversation = state.channelConversations.find(item => item.id === message.conversationId && item.channelAppId === app?.id && item.status === 'active')
  const member = state.members.find(item => item.id === identity?.memberId && item.enabled === true)
  const commandConversation = conversation?.type === 'group' ? uniquePrivateConversation(state, app?.id, identity?.id) : conversation
  if (!app || !identity || !conversation || !member || (conversation.type === 'private' && (conversation.identityId !== identity.id || conversation.memberId !== member.id))
    || !commandConversation
    || (app.provider === 'weixin' && (message.providerAccountId !== identity.weixin?.botId || identity.weixin?.runtimeState !== 'connected'))
    || message.providerUserId !== identity.providerUserId || message.providerConversationId !== conversation.providerConversationId) return undefined
  return { app, identity, conversation, commandConversation, member }
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

function inboundError(code) {
  const messages = {
    CHANNEL_UNAVAILABLE: '渠道身份或应用当前不可用',
    CHANNEL_CONFIRMATION_REQUIRED: '请先在 Web 确认本人渠道身份，再重新发送消息',
    CHANNEL_CONVERSATION_UNAVAILABLE: '渠道对话暂不可用，请到 Web 继续',
    CHANNEL_DEFAULT_REQUIRED: '请在 Web 为渠道选择当前获准的员工',
    CHANNEL_BUSY: '当前回复尚未结束，请先完成或停止回复，再重新发送',
    CHANNEL_HISTORY_UNAVAILABLE: '原生历史暂不可用，请到 Web 核对，不会另开上下文重试',
    CHANNEL_AUTHORIZATION_CHANGED: '渠道授权已变化，请到 Web 重新提交',
    CHANNEL_RECOVERY_INTERRUPTED: '上次消息未完成受理，请发送一条新消息',
    CHANNEL_REPLY_INVALID: '引用消息无法用于当前会话，请到 Web 打开原对话，或发送一条新消息',
    DEFAULT_DISPATCH_UNAVAILABLE: '默认派发当前不可用，请到 Web 重新选择',
    WORK_REFERENCE_INVALID: '无法精确确定本人工作，请到 Web 核对',
    WORK_ACTIVE_NOT_APPLIED: '已收到但本轮未应用，请在本轮结束后重新提交',
    WORK_INPUT_REQUIRED: '工作尚无可用业务结果，请到 Web 补充结构化输入',
    WORK_REQUEST_INVALID: '请求内容无效，请到 Web 核对',
    WORK_SERVICE_FAILED: '工作服务暂时无法完成请求',
    OFFICIAL_ID_CONFLICT: '渠道官方消息标识冲突，本次不会受理',
    UNSUPPORTED: '当前仅支持私聊文本，请到 Web 处理其他内容',
  }
  return { code, message: messages[code] ?? '渠道请求无法处理' }
}

async function transitionDelivery(store, clock, deliveryId, from, status, providerMessageId, outcomeError) {
  let output
  await store.update(state => {
    const delivery = state.deliveries.find(item => item.id === clean(deliveryId))
    if (!delivery) throw error('NOT_FOUND', '投递不存在')
    if (!from.includes(delivery.status)) throw transitionError(delivery.status)
    if (status === 'delivered' && delivery.sendProgress && delivery.sendProgress.acknowledgedParts.length !== delivery.sendProgress.totalParts) throw error('INVALID_STATE', '部分分段尚未确认，不能标记全部已发送')
    const messageId = providerMessageId === undefined ? undefined : requiredOfficialId(providerMessageId, 'providerMessageId')
    if (status === 'delivered' && !messageId) throw error('INVALID_REQUEST', '已送达必须包含平台 message ID')
    output = compact({ ...delivery, status, providerMessageId: messageId ?? delivery.providerMessageId, error: status === 'delivered' ? undefined : safeOutcomeError(outcomeError, status), updatedAt: now(clock) })
    return { ...state, deliveries: replaceById(state.deliveries, output) }
  })
  return deliveryDto(output)
}

function currentDeliveryAuthorization(state, delivery, { validateClaim = false, connectionCatalog = [] } = {}) {
  const app = state.channelApps.find(item => item.id === delivery.channelAppId && item.enabled === true && item.status === 'active')
  const confirmation = delivery.contentKey === 'help.confirmation'
  const identity = state.channelIdentities.find(item => item.id === delivery.targetIdentityId && (item.status === 'active' || confirmation && item.status === 'pending'))
  const conversation = state.channelConversations.find(item => item.id === delivery.targetConversationId && (item.status === 'active' || confirmation && item.status === 'pending'))
  const work = state.works.find(item => item.id === delivery.workId)
  const source = delivery.sourceRef?.kind === 'conversation-turn' && state.conversations.find(item => item.id === delivery.sourceRef.conversationId)
  const turn = source && source.turns.find(item => item.id === delivery.sourceRef.turnId && item.status === 'completed')
  const member = state.members.find(item => item.id === (work?.ownerMemberId ?? source?.ownerMemberId ?? identity?.memberId) && item.enabled === true)
  const employee = state.employees.find(item => item.id === (work?.employeeId ?? source?.employeeId) && item.enabled === true && member?.employeeIds.includes(item.id))
  const skill = state.skills.find(item => item.id === work?.skillId && item.enabled === true && employee?.skillIds?.includes(item.id) && item.capabilityId === work.capabilityId)
  const connection = work?.connectionId === undefined ? undefined : state.connections.find(item => item.id === work.connectionId && item.enabled === true && item.status === 'ready' && employee?.connectionIds?.includes(item.id) && item.skillIds?.includes(skill?.id))
  const result = delivery.resultId === undefined ? undefined : work?.results.find(item => item.id === delivery.resultId)
  const revisions = delivery.authorizationRevisions
  const fixed = Object.hasOwn(FIXED_CONTENT, delivery.contentKey)
  const occurrence = automationOccurrence(state, delivery)
  const rule = occurrence && state.automationRules.find(item => item.id === occurrence.ruleId)
  const workAuthorized = work && (occurrence?.query ? automationWorkAuthorized(state, member, work, connectionCatalog) : workBindingAuthorized(state, member, work))
  const sourceAuthorized = source && turn && source.channelIdentityId === identity?.id && source.ownerMemberId === member?.id && employee
    && currentConversationDependencies(state, source, turn, connectionCatalog)
  if (!app || !identity || !conversation || !member
    || identity.channelAppId !== app.id || conversation.channelAppId !== app.id || identity.memberId !== member.id
    || (conversation.type === 'private' && (conversation.memberId !== member.id || conversation.identityId !== identity.id))
    || (app.provider === 'weixin' && identity.weixin?.runtimeState !== 'connected')
    || (confirmation && identity.status === 'pending' && !state.linkCodes.some(link => link.status === 'matched' && link.matchedIdentityId === identity.id && link.matchedConversationId === conversation.id))
    || (occurrence && (conversation.type !== 'private' || rule?.ownerMemberId !== work?.ownerMemberId || rule.status !== 'active'
      || rule.revision !== occurrence.ruleRevision || rule.notificationIdentityId !== identity.id
      || occurrence.query && rule.activationId !== occurrence.activationId))
    || (!fixed && ((!sourceAuthorized && (!workAuthorized || !employee || !skill || (work?.connectionId !== undefined && !connection)))
      || !app.allowedScopes.includes(delivery.contentScope) || !conversation.allowedScopes.includes(delivery.contentScope) || (delivery.resultId !== undefined && !result)
      || result?.knowledgeDependencyRefs?.some(ref => !currentKnowledgeReference(state, ref, member.id, result.employeeId ?? work.employeeId))))) return undefined
  if (validateClaim && (!revisions || revisions.app !== app.revision || revisions.identity !== identity.revision || revisions.conversation !== conversation.revision)) return undefined
  return { app, identity, conversation, work, member, employee, skill, connection, result }
}

function automationWorkAuthorized(state, member, work, connectionCatalog) {
  try { authorizeWorkBinding(state, member, work, connectionCatalog); return true } catch { return false }
}

function deliveryEnvelope(state, delivery, renderedText) {
  const conversation = state.channelConversations.find(item => item.id === delivery.targetConversationId)
  const work = delivery.workId && state.works.find(item => item.id === delivery.workId)
  const result = delivery.resultId && work?.results.find(item => item.id === delivery.resultId)
  const text = renderedText ?? FIXED_CONTENT[delivery.contentKey] ?? formatWorkContent(delivery.contentKey, work, result)
  if (!conversation || !text) throw error('DELIVERY_FORBIDDEN', '投递内容无法生成')
  return Object.freeze({
    deliveryId: delivery.id,
    attempt: delivery.attempts,
    providerConversationId: conversation.providerConversationId,
    text,
    uuid: deliveryAttemptId(delivery),
    ...(delivery.sendProgress ? { acknowledgedParts: structuredClone(delivery.sendProgress.acknowledgedParts) } : {}),
  })
}

function formatWorkContent(contentKey, work, result) {
  if (!work) return undefined
  const path = `/works/${encodeURIComponent(work.id)}`
  if (contentKey === 'work.accepted') return `工作 ${work.id} 已受理，当前状态：${work.status}。来源：渠道文本交办。详情：${path}`
  if (contentKey === 'automation.failed') return `自动工作 ${work.id} 未完成，状态：${({ failed: '失败', cancelled: '已停止', interrupted: '已中断' })[work.status] ?? '未完成'}。详情：${path}`
  if (!['result.gearjob', 'automation.completed'].includes(contentKey)) return undefined
  if (result?.kind !== 'gearjob.work-order.observation') return [result?.explanation, `工作 ${work.id} 当前状态：${work.status}。来源：已验证工作结果。详情：${path}`].filter(Boolean).join('\n')
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
function deliveryAttemptId(delivery) { return delivery.sendProgress?.attemptId ?? stableAttemptUuid(delivery.id, delivery.attempts) }

function fixedHelpKey(message) {
  if (message.error?.code === 'CHANNEL_RECOVERY_INTERRUPTED') return 'help.interrupted'
  if (message.error?.code === 'CHANNEL_REPLY_INVALID') return 'help.reply-invalid'
  return message.error?.code === 'CHANNEL_CONFIRMATION_REQUIRED' ? 'help.confirmation'
    : message.error?.code === 'CHANNEL_BUSY' ? 'help.busy'
      : message.error?.code === 'UNSUPPORTED' || message.error?.code === 'WEIXIN_TEXT_ONLY' ? 'help.unsupported' : 'help.unavailable'
}

function invalidateClaims(deliveries, predicate, timestamp, code, message) {
  return deliveries.map(delivery => {
    if (!predicate(delivery)) return delivery
    const unknown = delivery.status === 'sending'
    return { ...delivery, status: unknown ? 'unknown' : 'blocked', error: { code: unknown ? 'DELIVERY_UNKNOWN' : code, message: unknown ? '发送效果待核对' : message }, updatedAt: timestamp }
  })
}

function automationOccurrence(state, delivery) { return state.automationOccurrences?.find(item => item.deliveryId === delivery.id) }

function automationDelivery(state, occurrence, work, execution, clock, idFactory, connectionCatalog) {
  const rule = state.automationRules.find(item => item.id === occurrence.ruleId)
  const identity = state.channelIdentities.find(item => item.id === rule?.notificationIdentityId && item.status === 'active')
  const conversation = identity && uniquePrivateConversation(state, identity.channelAppId, identity.id)
  const app = state.channelApps.find(item => item.id === identity?.channelAppId)
  if (!identity || !conversation || !app) return undefined
  const requestId = `automation:${occurrence.occurrenceKey}:terminal`
  const existing = state.deliveries.find(item => item.channelAppId === app.id && item.requestId === requestId)
  if (existing) return existing.workId === work.id ? { state: { ...state, automationOccurrences: replaceById(state.automationOccurrences, { ...occurrence, deliveryId: existing.id }) }, delivery: existing } : undefined
  const timestamp = now(clock)
  const completed = execution.status === 'completed'
  const resultId = completed ? execution.resultId : undefined
  let delivery = compact({
    id: `delivery-${idFactory()}`, channelAppId: app.id, requestId, workId: work.id, resultId,
    targetConversationId: conversation.id, targetIdentityId: identity.id, contentScope: 'result',
    contentKey: completed ? 'automation.completed' : 'automation.failed', status: 'pending', attempts: 0, createdAt: timestamp, updatedAt: timestamp,
  })
  let next = { ...state, deliveries: [...state.deliveries, delivery], automationOccurrences: replaceById(state.automationOccurrences, { ...occurrence, deliveryId: delivery.id }) }
  if (rule.revision !== occurrence.ruleRevision || !currentDeliveryAuthorization(next, delivery, { connectionCatalog })) {
    delivery = { ...delivery, status: 'blocked', error: { code: 'DELIVERY_FORBIDDEN', message: '自动通知当前不允许发送' } }
    next = { ...next, deliveries: replaceById(next.deliveries, delivery) }
  }
  return { state: next, delivery }
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
function identityDto(identity) {
  const value = structuredClone(identity)
  if (value.weixin) value.weixin = compact({ runtimeState: value.weixin.runtimeState, error: value.weixin.error })
  return value
}
function conversationDto(conversation) { return structuredClone(conversation) }
function messageDto(message) { return structuredClone(message) }
function deliveryDto(delivery) { return structuredClone(delivery) }
function linkDto(link) {
  const value = structuredClone(link)
  for (const key of ['digest', 'loginRef', 'tokenRef', 'cursorRef', 'contextRef']) delete value[key]
  return value
}

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
