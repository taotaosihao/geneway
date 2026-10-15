import { createHash } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireAutomationOwner } from '../src/automation-service.mjs'
import { createWeixinApi, DEFAULT_WEIXIN_MAX_MESSAGE_CHARS, officialId, orderWeixinMessages, rejectedProviderResponse, splitWeixinText, WeixinApiError, weixinMessageId, weixinSequence } from '../vendor/dsh-im/weixin/weixin-api.mjs'

// The platform bot ID, rather than a data root or product identity ID, owns the lock.
export async function acquireWeixinBot(botId) {
  if (!officialId(botId)) throw new TypeError('Weixin bot ID is invalid')
  const root = join('/tmp', `geneway-weixin-${process.getuid()}`)
  const directory = join(root, sha256(botId))
  for (const path of [root, directory]) {
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) throw runtimeError('WEIXIN_LOCK_INVALID')
  }
  return acquireAutomationOwner(directory)
}

export function createWeixinRuntime({ bot, secrets, acceptInbound, onRuntime = async () => {}, beforeSend, recordSendProgress, api = createWeixinApi(), maxMessageChars = DEFAULT_WEIXIN_MAX_MESSAGE_CHARS, reconnectDelayMs = 2000 } = {}) {
  if (!bot || !['id', 'channelAppId', 'ownerUserId'].every(key => officialId(bot[key]))
    || !['tokenRef', 'cursorRef', 'contextRef'].every(key => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bot[key] ?? ''))
    || new Set([bot.tokenRef, bot.cursorRef, bot.contextRef]).size !== 3
    || !secrets?.read || !secrets?.write || typeof acceptInbound !== 'function' || typeof onRuntime !== 'function') throw new TypeError('Weixin runtime dependencies are invalid')
  if (!Number.isSafeInteger(maxMessageChars) || maxMessageChars < 2 || !Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 1) throw new TypeError('Weixin runtime limits are invalid')
  const account = Object.freeze({ ...bot, baseUrl: api.normalizeBaseUrl(bot.baseUrl) })
  const controller = new AbortController()
  const sends = new Map()
  let lock, starting, monitor, closed = false, available = false, lockLost = false

  async function attest(state, code) {
    available = state === 'connected' && !closed && !lockLost
    await onRuntime({ botId: account.id, channelAppId: account.channelAppId, state, available, ...(code ? { error: { code } } : {}) })
  }

  async function run() {
    let failures = 0
    try {
      while (!controller.signal.aborted) {
        try {
          const [token, cursor] = await Promise.all([secrets.read(account.tokenRef), secrets.read(account.cursorRef)])
          if (typeof token !== 'string' || !token || typeof cursor !== 'string') throw runtimeError('WEIXIN_SECRET_UNAVAILABLE')
          const response = await api.getUpdates({ baseUrl: account.baseUrl, token, getUpdatesBuf: cursor, signal: controller.signal })
          if (controller.signal.aborted) break
          const providerCode = rejectedProviderResponse(response)
          if (providerCode) throw new WeixinApiError(providerCode === '-14' ? 'stale-token' : 'updates-rejected', '微信消息同步被拒绝', { providerCode })
          if (![response.ret, response.errcode].some(code => code === 0 || code === '0') || !Array.isArray(response.msgs) || typeof response.get_updates_buf !== 'string') throw new WeixinApiError('invalid-response', '微信同步响应无效')
          await attest('connected')
          for (const message of orderWeixinMessages(response.msgs)) {
            if (controller.signal.aborted) break
            const inbound = inboundEvent(message, account)
            if (inbound.contextRef && typeof message.context_token === 'string' && message.context_token) await rememberContext(message)
            const result = await acceptInbound(inbound)
            if (!['accepted', 'rejected'].includes(result?.status) || (inbound.rejectionCode && result.status !== 'rejected')) throw runtimeError('WEIXIN_INBOX_NOT_DURABLE')
          }
          // A stopped instance cannot acknowledge a batch or revive itself after unbinding.
          if (controller.signal.aborted) break
          await secrets.write(account.cursorRef, response.get_updates_buf)
          failures = 0
        } catch (error) {
          if (controller.signal.aborted) break
          failures += 1
          const code = protocolCode(error)
          if (error?.code === 'stale-token' || error?.code === 'WEIXIN_SECRET_UNAVAILABLE' || (error?.code === 'http-error' && [401, 403].includes(error.status)) || failures >= 3) {
            await attest('unavailable', error?.code === 'http-error' && [401, 403].includes(error.status) ? 'WEIXIN_AUTH_REJECTED' : code)
            return
          }
          await attest('reconnecting', code)
          await delay(Math.min(reconnectDelayMs * (2 ** (failures - 1)), 10000), undefined, { signal: controller.signal })
        }
      }
    } finally {
      available = false
      controller.abort()
      await lock?.release()
      lock = undefined
    }
  }

  async function rememberContext(message) {
    const previous = await secrets.read(account.contextRef)
    const sequence = weixinSequence(message.seq), previousSequence = weixinSequence(previous?.sequence)
    const timestamp = orderValue(message.create_time_ms), previousTimestamp = orderValue(previous?.timestamp)
    if (message.seq !== undefined && sequence === undefined) return
    if (sequence !== undefined && previousSequence !== undefined && BigInt(sequence) <= BigInt(previousSequence)) return
    if (timestamp !== undefined && previousTimestamp !== undefined && timestamp < previousTimestamp) return
    await secrets.write(account.contextRef, { token: message.context_token,
      ...(sequence !== undefined || previousSequence !== undefined ? { sequence: sequence ?? previousSequence } : {}),
      ...(timestamp !== undefined || previousTimestamp !== undefined ? { timestamp: timestamp ?? previousTimestamp } : {}),
    })
  }

  async function start() {
    if (closed) throw runtimeError('WEIXIN_STOPPED')
    if (starting) return starting
    starting = (async () => {
      try {
        lock = await acquireWeixinBot(account.id)
        void lock.lost.then(() => {
          lockLost = true; available = false; controller.abort()
          void attest('unavailable', 'WEIXIN_LOCK_LOST').catch(() => undefined)
        })
        if (closed) { await lock.release(); lock = undefined; return }
        await attest('connecting')
        monitor = run().catch(async error => { if (!closed) await attest('unavailable', protocolCode(error)).catch(() => undefined) })
      } catch (error) {
        await lock?.release(); lock = undefined
        throw runtimeError(error?.code === 'OWNER_ALREADY_RUNNING' ? 'WEIXIN_ALREADY_RUNNING' : 'WEIXIN_START_FAILED')
      }
    })()
    return starting
  }

  async function send(input) {
    const { deliveryId, attemptId, text, toUserId = account.ownerUserId, acknowledgedParts = [], previousStatus = 'pending' } = input ?? {}
    if (!officialId(deliveryId) || !officialId(attemptId) || typeof text !== 'string' || !text.trim() || toUserId !== account.ownerUserId
      || !Array.isArray(acknowledgedParts) || !['pending', 'failed'].includes(previousStatus)
      || typeof beforeSend !== 'function' || typeof recordSendProgress !== 'function') throw runtimeError('WEIXIN_SEND_FORBIDDEN')
    const chunks = splitWeixinText(text, maxMessageChars)
    const expectedId = index => `geneway-weixin-${sha256(`${attemptId}\0${index}`).slice(0, 32)}`
    if (acknowledgedParts.some((part, index) => part?.index !== index || part.clientId !== expectedId(index)) || acknowledgedParts.length > chunks.length) throw runtimeError('WEIXIN_PROGRESS_INVALID')
    const confirmed = acknowledgedParts.map(part => ({ index: part.index, clientId: part.clientId }))
    const textDigest = sha256(text)
    const progress = (status, index, code) => ({ deliveryId, attemptId, status, totalParts: chunks.length, textDigest, acknowledgedParts: confirmed.map(part => ({ ...part })), ...(index === undefined ? {} : { partIndex: index }), ...(code ? { error: { code } } : {}) })
    for (let index = confirmed.length; index < chunks.length; index += 1) {
      const clientId = expectedId(index)
      if (closed || !available || controller.signal.aborted) return record(progress('blocked', index, 'WEIXIN_UNAVAILABLE'))
      const [token, context] = await Promise.all([secrets.read(account.tokenRef), secrets.read(account.contextRef)])
      if (typeof token !== 'string' || !token || typeof context?.token !== 'string' || !context.token) return record(progress('failed', index, 'WEIXIN_CONTEXT_UNAVAILABLE'))
      try {
        if (await beforeSend({ deliveryId, attemptId, toUserId, partIndex: index, clientId, totalParts: chunks.length, textDigest }) !== true) return record(progress('blocked', index, 'WEIXIN_SEND_FORBIDDEN'))
      } catch { return record(progress('blocked', index, 'WEIXIN_SEND_FORBIDDEN')) }
      if (closed || !available || controller.signal.aborted) return record(progress('blocked', index, 'WEIXIN_UNAVAILABLE'))
      try {
        await api.sendText({ baseUrl: account.baseUrl, token, toUserId, text: chunks[index], contextToken: context.token, clientId, signal: controller.signal })
      } catch (error) {
        const failed = error?.code === 'send-rejected' || (error?.code === 'http-error' && error.status >= 400 && error.status < 500)
        if (error?.providerCode === '-14') {
          controller.abort()
          await attest('unavailable', 'WEIXIN_STALE_TOKEN')
        }
        return record(progress(failed ? 'failed' : 'unknown', index, protocolCode(error)))
      }
      confirmed.push({ index, clientId })
      if (index === chunks.length - 1) return record(progress('delivered', index))
      await record(progress('sending', index))
    }
    return record(progress('delivered'))

    async function record(value) {
      try { await recordSendProgress(value) } catch { throw runtimeError('WEIXIN_PROGRESS_NOT_DURABLE') }
      return value
    }
  }

  return {
    start,
    isAvailable() { return available && !closed && !controller.signal.aborted },
    sendText(input) {
      if (sends.has(input?.deliveryId)) return Promise.reject(runtimeError('WEIXIN_SEND_IN_PROGRESS'))
      const pending = send(input).catch(error => {
        const code = ['WEIXIN_SEND_FORBIDDEN', 'WEIXIN_PROGRESS_INVALID', 'WEIXIN_PROGRESS_NOT_DURABLE'].includes(error?.code) ? error.code : 'WEIXIN_STORAGE_UNAVAILABLE'
        throw runtimeError(code)
      }).finally(() => sends.delete(input?.deliveryId))
      sends.set(input?.deliveryId, pending)
      return pending
    },
    async close() {
      closed = true
      available = false
      controller.abort()
      await starting?.catch(() => undefined)
      await monitor
      await Promise.allSettled([...sends.values()])
      await attest(lockLost ? 'unavailable' : 'stopped', lockLost ? 'WEIXIN_LOCK_LOST' : undefined).catch(() => { throw runtimeError('WEIXIN_STATE_NOT_DURABLE') })
    },
  }
}

// Cordis owns the same transport cleanup used by the server runtime.
export function createWeixinPlugin(runtime) {
  return async ctx => {
    ctx.effect(() => () => runtime.close(), 'geneway-weixin')
    await runtime.start()
  }
}

export function createWeixinChannelRuntime({ store, channelService, secrets, api = createWeixinApi(), loginPollMs = 1000, reconnectDelayMs = 2000 } = {}) {
  if (!store?.read || !channelService?.beginWeixinBinding || !secrets?.read || !secrets?.write || ![loginPollMs, reconnectDelayMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Weixin channel dependencies are invalid')
  const instances = new Map(), logins = new Map(), availableApps = new Set(), sendOwnerChecks = new Map()
  let closed = false, syncChain = Promise.resolve()

  async function login(actor, binding, controller) {
    try {
      while (!closed && !controller.signal.aborted) {
        const current = await channelService.getWeixinBinding(actor, { linkCodeId: binding.id })
        if (current.status !== 'active') return
        if (Date.parse(current.expiresAt) <= Date.now()) {
          await channelService.finishWeixinBinding({ linkCodeId: binding.id, status: 'expired', code: 'WEIXIN_QR_EXPIRED' }); return
        }
        const challenge = await secrets.read(binding.loginRef)
        const result = await api.pollLogin({ ...challenge, signal: controller.signal, onConfirmed: async value => {
          const before = await channelService.getWeixinBinding(actor, { linkCodeId: binding.id })
          if (before.status !== 'active' || controller.signal.aborted) throw runtimeError('WEIXIN_BINDING_CLOSED')
          await secrets.write(binding.tokenRef, value.token)
          await secrets.write(binding.cursorRef, '')
          await secrets.write(binding.contextRef, null)
          await channelService.matchWeixinLogin({ linkCodeId: binding.id, botId: value.botId, ownerUserId: value.ownerUserId, baseUrl: value.baseUrl })
        } })
        if (result.status === 'confirmed') { await sync(); return }
        if (result.status === 'scaned_but_redirect') await secrets.write(binding.loginRef, { ...challenge, baseUrl: result.baseUrl })
        else if (!['wait', 'scaned'].includes(result.status)) {
          await channelService.finishWeixinBinding({ linkCodeId: binding.id, status: result.status === 'expired' ? 'expired' : 'cancelled', code: 'WEIXIN_LOGIN_UNAVAILABLE' }); return
        }
        await delay(loginPollMs, undefined, { signal: controller.signal })
      }
    } catch (error) {
      if (!controller.signal.aborted && !closed) await channelService.finishWeixinBinding({ linkCodeId: binding.id, code: protocolCode(error) })
    }
  }

  function startLogin(actor, binding) {
    if (closed || logins.has(binding.id)) return
    const controller = new AbortController(), entry = { controller, promise: undefined }
    logins.set(binding.id, entry)
    entry.promise = login(actor, binding, controller).finally(() => { if (logins.get(binding.id) === entry) logins.delete(binding.id) })
    void entry.promise.catch(() => undefined)
  }

  async function sync() {
    const reconcile = async () => {
      if (closed) return
      await channelService.expireLinkCodes()
      let state = await store.read()
      // App readiness means this protocol module is mounted; bot readiness remains per identity.
      for (const app of state.channelApps.filter(app => app.provider === 'weixin' && app.enabled && app.status === 'unavailable')) {
        await channelService.setChannelAppRuntime({ channelAppId: app.id, revision: app.revision, providerAppId: app.providerAppId, providerTenantId: app.providerTenantId, credentialRef: app.credentialRef, available: true })
      }
      state = await store.read()
      const desired = new Map()
      availableApps.clear()
      for (const app of state.channelApps.filter(app => app.provider === 'weixin' && app.enabled && app.status === 'active')) availableApps.add(app.id)
      for (const identity of state.channelIdentities) {
        if (!identity.weixin || identity.weixin.runtimeState === 'unavailable' || !availableApps.has(identity.channelAppId) || !['pending', 'active'].includes(identity.status)
          || !state.members.some(member => member.id === identity.memberId && member.enabled)) continue
        if (identity.status === 'pending' && !state.linkCodes.some(link => link.status === 'matched' && link.matchedIdentityId === identity.id)) continue
        desired.set(identity.id, identity)
      }
      for (const [id, entry] of instances) {
        const identity = desired.get(id)
        if (identity && entry.fingerprint === fingerprint(identity)) continue
        instances.delete(id); await entry.runtime.close()
      }
      for (const [id, entry] of logins) {
        if (state.linkCodes.some(link => link.id === id && link.status === 'active' && availableApps.has(link.channelAppId))) continue
        entry.controller.abort()
      }
      for (const identity of desired.values()) {
        if (instances.has(identity.id) || closed) continue
        const { botId, baseUrl, tokenRef, cursorRef, contextRef } = identity.weixin
        const runtime = createWeixinRuntime({ bot: { id: botId, channelAppId: identity.channelAppId, ownerUserId: identity.providerUserId, baseUrl, tokenRef, cursorRef, contextRef }, secrets, api, reconnectDelayMs,
          onRuntime: value => channelService.setWeixinRuntime({ identityId: identity.id, ...value }),
          acceptInbound: async input => {
            const receipt = await channelService.handleInbound(input)
            if (receipt.code !== 'OFFICIAL_ID_CONFLICT') {
              const created = await channelService.createInboundDeliveries({ channelMessageId: receipt.messageId, requestId: `weixin:${sha256(`${identity.id}\0${receipt.messageId}`)}` })
              for (const delivery of created.deliveries) if (delivery.status === 'pending') {
                try { await sendDelivery(delivery.id) } catch (error) { if (!['INVALID_STATE', 'DELIVERY_FORBIDDEN'].includes(error?.code)) throw error }
              }
            }
            return receipt
          },
          beforeSend: async input => {
            const ownerCheck = sendOwnerChecks.get(input.deliveryId)
            if (ownerCheck && !ownerCheck()) { await abandonOwnerClaim(input.deliveryId); return false }
            await channelService.validateSendClaim(input)
            if (ownerCheck && !ownerCheck()) { await abandonOwnerClaim(input.deliveryId); return false }
            return true
          },
          recordSendProgress: async value => {
            const ownerCheck = sendOwnerChecks.get(value.deliveryId)
            if (ownerCheck && !ownerCheck()) await abandonOwnerClaim(value.deliveryId)
            return channelService.recordSendProgress(value)
          },
        })
        instances.set(identity.id, { runtime, fingerprint: fingerprint(identity) })
        try { await runtime.start() } catch (error) { await channelService.setWeixinRuntime({ identityId: identity.id, botId, state: 'unavailable', error: { code: protocolCode(error) } }) }
      }
      for (const binding of state.linkCodes.filter(link => link.kind === 'weixin-qr' && link.status === 'active' && link.qrcodeUrl && availableApps.has(link.channelAppId))) startLogin({ id: binding.memberId }, binding)
    }
    syncChain = syncChain.then(reconcile, reconcile)
    return syncChain
  }

  async function abandonOwnerClaim(deliveryId) {
    const delivery = (await store.read()).deliveries.find(item => item.id === deliveryId)
    if (delivery?.status === 'sending') await channelService.abandonAutomationClaim({ deliveryId })
  }

  async function sendDelivery(deliveryId, { retry = false, ownerCheck } = {}) {
    if (closed) throw runtimeError('WEIXIN_STOPPED')
    if (ownerCheck && !ownerCheck()) throw runtimeError('OWNER_LOCK_LOST')
    const delivery = await channelService.authorizeDelivery({ deliveryId, retry })
    if (ownerCheck && !ownerCheck()) return channelService.abandonAutomationClaim({ deliveryId })
    const state = await store.read(), identity = state.channelIdentities.find(item => item.id === delivery.targetIdentityId)
    const entry = instances.get(identity?.id)
    if (!entry) return channelService.recordDeliveryOutcome({ deliveryId, status: 'failed', error: { code: 'WEIXIN_UNAVAILABLE' } })
    if (ownerCheck) sendOwnerChecks.set(deliveryId, ownerCheck)
    try {
      const envelope = await channelService.validateSendClaim({ deliveryId })
      await entry.runtime.sendText({ deliveryId, attemptId: envelope.uuid, text: envelope.text, toUserId: identity.providerUserId,
        acknowledgedParts: envelope.acknowledgedParts ?? [], previousStatus: retry ? 'failed' : 'pending',
      })
      return (await store.read()).deliveries.find(item => item.id === deliveryId)
    } finally { sendOwnerChecks.delete(deliveryId) }
  }

  function fingerprint(identity) { return JSON.stringify([identity.channelAppId, identity.providerUserId, identity.weixin.botId, identity.weixin.baseUrl, identity.weixin.tokenRef, identity.weixin.cursorRef, identity.weixin.contextRef]) }
  return {
    async start() { if (closed) throw runtimeError('WEIXIN_STOPPED'); await channelService.ensureBuiltinWeixinApp(); await sync() },
    sync, sendDelivery,
    isAvailable(channelAppId) { return !closed && availableApps.has(channelAppId) },
    async beginBinding(actor, input = {}) {
      if (closed) throw runtimeError('WEIXIN_STOPPED')
      const binding = await channelService.beginWeixinBinding(actor, input)
      try {
        const qr = await api.beginLogin()
        await secrets.write(binding.loginRef, { qrcode: qr.qrcode })
        const result = await channelService.setWeixinQr({ linkCodeId: binding.id, qrcodeUrl: qr.qrcodeUrl })
        startLogin(actor, binding)
        return result
      } catch (error) {
        await channelService.finishWeixinBinding({ linkCodeId: binding.id, code: protocolCode(error) })
        throw runtimeError('WEIXIN_BINDING_UNAVAILABLE')
      }
    },
    async cancelBinding(actor, { linkCodeId } = {}) {
      const result = await channelService.cancelWeixinBinding(actor, { linkCodeId })
      logins.get(linkCodeId)?.controller.abort()
      await sync()
      return result
    },
    async close() {
      closed = true; availableApps.clear()
      for (const entry of logins.values()) entry.controller.abort()
      const results = await Promise.allSettled([syncChain, ...[...logins.values()].map(entry => entry.promise), ...[...instances.values()].map(entry => entry.runtime.close())])
      instances.clear()
      if (results.some(result => result.status === 'rejected')) throw runtimeError('WEIXIN_STATE_NOT_DURABLE')
    },
  }
}

function inboundEvent(message, bot) {
  const id = weixinMessageId(message)
  const sender = officialId(message?.from_user_id) ? message.from_user_id : undefined
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  let rejectionCode
  if (!id || !sender || (message.to_user_id && message.to_user_id !== bot.id)) rejectionCode = 'WEIXIN_INVALID_MESSAGE'
  else if (message.message_type === 2) rejectionCode = 'WEIXIN_ECHO'
  else if (sender !== bot.ownerUserId) rejectionCode = 'WEIXIN_NOT_OWNER'
  else if (message.message_type !== 1 || message.group_id || message.chat_type === 'group') rejectionCode = 'WEIXIN_PRIVATE_ONLY'
  else if (!items.length || items.some(item => item?.type !== 1 || typeof item.text_item?.text !== 'string')) rejectionCode = 'WEIXIN_TEXT_ONLY'
  const content = rejectionCode ? '' : items.map(item => item.text_item.text).join('\n').trim()
  if (!rejectionCode && (!content || content.length > 16384)) rejectionCode = 'WEIXIN_INVALID_TEXT'
  const providerMessageId = id ?? `invalid-${sha256(JSON.stringify({ sender, type: message?.message_type, items: items.map(item => item?.type) }))}`
  const time = orderValue(message?.create_time_ms)
  const date = time === undefined ? undefined : new Date(time)
  return {
    channelAppId: bot.channelAppId, providerAccountId: bot.id, providerEventId: providerMessageId, providerMessageId,
    ...(sender ? { providerUserId: sender, providerConversationId: sender } : {}),
    conversationType: 'private', text: rejectionCode ? '' : content,
    ...(rejectionCode ? { rejectionCode, attachments: rejectionCode === 'WEIXIN_TEXT_ONLY' } : {}),
    ...(!rejectionCode || rejectionCode === 'WEIXIN_TEXT_ONLY' ? { contextRef: bot.contextRef } : {}),
    ...(date && Number.isFinite(date.valueOf()) ? { receivedAt: date.toISOString() } : {}),
  }
}

function orderValue(value) { return (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : undefined }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function protocolCode(error) {
  if (error instanceof WeixinApiError) return `WEIXIN_${error.code.replaceAll('-', '_').toUpperCase()}`
  return ['WEIXIN_INBOX_NOT_DURABLE', 'WEIXIN_SECRET_UNAVAILABLE'].includes(error?.code) ? error.code : 'WEIXIN_STORAGE_UNAVAILABLE'
}
function runtimeError(code) { return Object.assign(new Error('微信通道当前不可用'), { code }) }
