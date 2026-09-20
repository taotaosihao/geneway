import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as Lark from '@larksuiteoapi/node-sdk'
import { resolveCredentialFile } from '../src/execution-grant.mjs'

const EVENT = 'im.message.receive_v1'
const CREDENTIAL_LIMIT = 4096
const HTTP_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 15_000
const CLOSE_DRAIN_TIMEOUT_MS = 10_000
const silentLogger = Object.fromEntries(['error', 'warn', 'info', 'debug', 'trace'].map(name => [name, () => {}]))

export function createFeishuRuntime({ store, channelService, secretRoot, sdk = Lark, httpTimeoutMs = HTTP_TIMEOUT_MS, readyTimeoutMs = READY_TIMEOUT_MS, closeDrainTimeoutMs = CLOSE_DRAIN_TIMEOUT_MS, automationOwnerCheck } = {}) {
  if (!store?.read || !channelService?.recover || !channelService?.setChannelAppRuntime) throw new TypeError('Feishu runtime dependencies are required')
  for (const [name, value] of Object.entries({ httpTimeoutMs, readyTimeoutMs, closeDrainTimeoutMs })) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  const instances = new Map()
  let stopping = false
  let syncChain = Promise.resolve()

  const current = entry => !stopping && instances.get(entry.app.id) === entry

  async function attest(entry, available) {
    if (!current(entry)) return false
    try {
      await channelService.setChannelAppRuntime({
        channelAppId: entry.app.id,
        revision: entry.app.revision,
        providerAppId: entry.app.providerAppId,
        providerTenantId: entry.app.providerTenantId,
        credentialRef: entry.app.credentialRef,
        available,
      })
    } catch {
      closeEntry(entry)
      return false
    }
    if (!current(entry)) return false
    entry.available = available
    return true
  }

  function closeEntry(entry) {
    if (entry.closed) return
    entry.closed = true
    entry.available = false
    try { entry.ws?.close({ force: true }) } catch {}
    if (instances.get(entry.app.id) === entry) instances.delete(entry.app.id)
  }

  async function build(app) {
    if (!secretRoot) { await unavailable(app); return }
    let credentials
    try {
      credentials = await readCredentials(secretRoot, app.credentialRef, app.providerAppId)
    } catch {
      await unavailable(app)
      return
    }
    if (stopping) return

    let appSecret = credentials.appSecret
    credentials.appSecret = ''
    const httpInstance = createBoundedHttpInstance(sdk.defaultHttpInstance, httpTimeoutMs)
    const client = new sdk.Client({
      appId: credentials.appId,
      appSecret,
      appType: sdk.AppType.SelfBuild,
      domain: sdk.Domain.Feishu,
      logger: silentLogger,
      loggerLevel: sdk.LoggerLevel.error,
      source: 'geneway-feishu',
      httpInstance,
    })
    const botOpenId = await bounded(fetchBotOpenId(client), httpTimeoutMs, runtimeError('UNAVAILABLE', 'Feishu bot identity timeout')).catch(() => undefined)
    if (!botOpenId || stopping) { appSecret = ''; await unavailable(app); return }

    const entry = { app, client, botOpenId, available: false, closed: false, inflight: new Set(), drainResolve: undefined }
    const dispatcher = new sdk.EventDispatcher({ logger: silentLogger, loggerLevel: sdk.LoggerLevel.error }).register({
      [EVENT]: async data => {
        if (!current(entry)) return
        const inbound = inboundEvent(data, entry)
        if (!inbound) return
        entry.inflight.add(inbound)
        try { await processInbound(entry, inbound) } finally { finishInbound(entry, inbound) }
      },
    })

    let readyResolve, readyReject, readySettled = false
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const settleReady = (resolve, value) => {
      if (readySettled || !current(entry)) return
      readySettled = true
      resolve(value)
    }
    entry.ws = new sdk.WSClient({
      appId: credentials.appId,
      appSecret,
      domain: sdk.Domain.Feishu,
      logger: silentLogger,
      loggerLevel: sdk.LoggerLevel.error,
      source: 'geneway-feishu',
      httpInstance,
      autoReconnect: true,
      handshakeTimeoutMs: readyTimeoutMs,
      wsConfig: { pingTimeout: 10 },
      onReady: () => settleReady(readyResolve),
      onError: error => {
        if (!current(entry)) return
        if (!readySettled) settleReady(readyReject, error)
        else void attest(entry, false)
      },
      onReconnecting: () => { if (current(entry)) void attest(entry, false) },
      onReconnected: () => { if (current(entry)) void attest(entry, true) },
    })
    appSecret = ''
    if (stopping) { closeEntry(entry); return }
    instances.set(app.id, entry)
    try {
      await entry.ws.start({ eventDispatcher: dispatcher })
      await bounded(ready, readyTimeoutMs)
      if (!await attest(entry, true)) closeEntry(entry)
    } catch {
      closeEntry(entry)
      await unavailable(app)
    }
  }

  async function unavailable(app) {
    if (stopping) return
    await channelService.setChannelAppRuntime({
      channelAppId: app.id,
      revision: app.revision,
      providerAppId: app.providerAppId,
      providerTenantId: app.providerTenantId,
      credentialRef: app.credentialRef,
      available: false,
    }).catch(() => undefined)
  }

  async function reconcile() {
    if (stopping) return
    const state = await store.read()
    const desired = new Map(state.channelApps.filter(app => app.provider === 'feishu' && app.enabled === true).map(app => [app.id, app]))
    for (const entry of [...instances.values()]) {
      const app = desired.get(entry.app.id)
      if (app && fingerprint(app) === fingerprint(entry.app)) continue
      closeEntry(entry)
      await unavailable(entry.app)
    }
    for (const app of desired.values()) if (!instances.has(app.id) && !stopping) await build(app)
  }

  async function sendDelivery(deliveryId, { retry = false, ownerCheck } = {}) {
    if (stopping) throw runtimeError('UNAVAILABLE', 'Feishu runtime is stopping')
    if (ownerCheck && !ownerCheck()) throw runtimeError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
    const authorized = await (retry ? channelService.retryDelivery({ deliveryId }) : channelService.authorizeDelivery({ deliveryId }))
    if (ownerCheck && !ownerCheck()) return channelService.abandonAutomationClaim({ deliveryId })
    const entry = instances.get(authorized.channelAppId)
    if (!entry?.available || !current(entry)) {
      if (ownerCheck && !ownerCheck()) return channelService.abandonAutomationClaim({ deliveryId })
      await channelService.recordDeliveryOutcome({ deliveryId, status: 'failed', error: { code: 'CHANNEL_RUNTIME_UNAVAILABLE' } })
      throw runtimeError('UNAVAILABLE', 'Feishu runtime is unavailable')
    }
    const envelope = await channelService.validateSendClaim({ deliveryId })
    if (ownerCheck && !ownerCheck()) return channelService.abandonAutomationClaim({ deliveryId })
    let outcome
    try {
      const response = await bounded(entry.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: envelope.providerConversationId, msg_type: 'text', content: JSON.stringify({ text: envelope.text }), uuid: envelope.uuid },
      }), httpTimeoutMs, runtimeError('DELIVERY_UNKNOWN', 'Feishu send timeout'))
      const message = response?.data
      outcome = response?.code === 0 && officialId(message?.message_id) && message.chat_id === envelope.providerConversationId
        ? { status: 'delivered', providerMessageId: message.message_id }
        : Number.isSafeInteger(response?.code) && response.code !== 0
          ? { status: 'failed', error: { code: `FEISHU_${response.code}` } }
          : { status: 'unknown', error: { code: 'DELIVERY_UNKNOWN' } }
    } catch {
      outcome = { status: 'unknown', error: { code: 'DELIVERY_UNKNOWN' } }
    }
    if (ownerCheck && !ownerCheck()) outcome = { status: 'unknown', error: { code: 'DELIVERY_UNKNOWN' } }
    return channelService.recordDeliveryOutcome({ deliveryId, ...outcome })
  }

  async function flushAutomationNotifications({ ownerCheck = automationOwnerCheck } = {}) {
    const created = await channelService.ensureAutomationDeliveries({ ownerCheck })
    for (const delivery of created.deliveries) if (delivery.status === 'pending') {
      try { await sendDelivery(delivery.id, { ownerCheck }) } catch (error) { if (!['INVALID_STATE', 'DELIVERY_FORBIDDEN'].includes(error?.code)) throw error }
    }
    return created
  }

  return {
    async start() {
      if (stopping) throw runtimeError('UNAVAILABLE', 'Feishu runtime is stopping')
      await channelService.recover()
      await this.sync()
      await flushAutomationNotifications()
    },
    sync() {
      syncChain = syncChain.then(reconcile, reconcile)
      return syncChain
    },
    isAvailable(channelAppId) {
      const entry = instances.get(channelAppId)
      return Boolean(entry?.available && current(entry))
    },
    sendDelivery,
    sendAutomationNotifications: flushAutomationNotifications,
    async close() {
      if (stopping) return
      stopping = true
      const closing = [...instances.values()]
      for (const entry of closing) closeEntry(entry)
      await channelService.recover()
      const drained = await settleWithin(Promise.all(closing.map(waitForDrain)), closeDrainTimeoutMs)
      if (!drained) await Promise.all(closing.flatMap(entry => [...entry.inflight].map(ensureDeliveryFacts)))
      await Promise.all(closing.map(entry => channelService.setChannelAppRuntime({
        channelAppId: entry.app.id,
        revision: entry.app.revision,
        providerAppId: entry.app.providerAppId,
        providerTenantId: entry.app.providerTenantId,
        credentialRef: entry.app.credentialRef,
        available: false,
        preservePending: true,
      }).catch(() => undefined)))
    },
  }

  async function processInbound(entry, inbound) {
    if (inbound.conversationType === 'private' && LINK_CODE.test(inbound.text.trim())) {
      try {
        await channelService.matchLinkCode({
          channelAppId: entry.app.id,
          providerUserId: inbound.providerUserId,
          providerConversationId: inbound.providerConversationId,
          conversationType: 'private',
          code: inbound.text.trim(),
        })
      } catch (error) {
        if (error?.code !== 'LINK_CODE_INVALID') throw error
      }
      return
    }
    await channelService.handleInbound(inbound)
    const created = await ensureDeliveryFacts(inbound)
    if (stopping || !current(entry)) return
    for (const delivery of created?.deliveries ?? []) if (delivery.status === 'pending') await sendDelivery(delivery.id)
  }

  async function ensureDeliveryFacts(inbound) {
    const message = await storedInbound(store, inbound)
    if (!message || !['accepted', 'rejected'].includes(message.status)) return undefined
    return channelService.createInboundDeliveries({ channelMessageId: message.id, requestId: `feishu:${sha256(`${inbound.channelAppId}\0${inbound.providerEventId}`)}` })
  }

  function finishInbound(entry, inbound) {
    entry.inflight.delete(inbound)
    if (entry.inflight.size) return
    entry.drainResolve?.()
    entry.drainResolve = undefined
  }

  function waitForDrain(entry) {
    if (!entry.inflight.size) return Promise.resolve()
    return new Promise(resolve => { entry.drainResolve = resolve })
  }
}

async function readCredentials(secretRoot, credentialRef, expectedAppId) {
  const file = await resolveCredentialFile(secretRoot, credentialRef)
  let raw = await readFile(file, 'utf8')
  if (Buffer.byteLength(raw) > CREDENTIAL_LIMIT) throw runtimeError('UNAVAILABLE', 'Feishu credential file is invalid')
  let value
  try { value = JSON.parse(raw) } catch { throw runtimeError('UNAVAILABLE', 'Feishu credential file is invalid') } finally { raw = '' }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'appId,appSecret'
    || value.appId !== expectedAppId || !/^cli_[0-9a-fA-F]{16}$/.test(value.appId) || !/^[A-Za-z0-9_-]{16,256}$/.test(value.appSecret)) throw runtimeError('UNAVAILABLE', 'Feishu credential file is invalid')
  return value
}

async function fetchBotOpenId(client) {
  const response = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
  if (response?.code !== 0 || !officialId(response?.bot?.open_id)) throw runtimeError('UNAVAILABLE', 'Feishu bot identity is unavailable')
  return response.bot.open_id
}

function inboundEvent(data, entry) {
  const message = data?.message
  const senderOpenId = data?.sender?.sender_id?.open_id
  if (data?.app_id !== entry.app.providerAppId || data?.tenant_key !== entry.app.providerTenantId || !officialId(data?.event_id)
    || !officialId(senderOpenId) || !officialId(message?.message_id) || !officialId(message?.chat_id)) return undefined
  if (senderOpenId === entry.botOpenId) return undefined
  if (data?.sender?.sender_type !== 'user') return undefined
  const conversationType = message.chat_type === 'p2p' ? 'private' : message.chat_type === 'group' ? 'group' : undefined
  if (!conversationType) return undefined
  const exactMentions = conversationType === 'group'
    ? (Array.isArray(message.mentions) ? message.mentions : []).filter(mention => mention?.id?.open_id === entry.botOpenId && typeof mention.key === 'string' && mention.key)
    : []
  if (conversationType === 'group' && exactMentions.length === 0) return undefined
  let text = ''
  let attachments
  if (message.message_type === 'text') {
    try {
      const content = JSON.parse(message.content)
      if (!content || Array.isArray(content) || typeof content.text !== 'string' || content.text.length > 16_384) return undefined
      text = content.text
    } catch { return undefined }
  } else {
    text = '不支持的非文本消息'
    attachments = true
  }
  for (const mention of exactMentions) text = text.replaceAll(mention.key, '')
  const receivedAt = timestamp(message.create_time)
  return compact({
    channelAppId: entry.app.id,
    providerEventId: data.event_id,
    providerMessageId: message.message_id,
    replyToProviderMessageId: officialId(message.parent_id) ? message.parent_id : undefined,
    providerConversationId: message.chat_id,
    providerUserId: senderOpenId,
    conversationType,
    botMentioned: conversationType === 'group',
    text: text.trim(),
    attachments,
    receivedAt,
  })
}

async function storedInbound(store, inbound) {
  const state = await store.read()
  const byEvent = state.channelMessages.find(item => item.channelAppId === inbound.channelAppId && item.providerEventId === inbound.providerEventId)
  const byMessage = state.channelMessages.find(item => item.channelAppId === inbound.channelAppId && item.providerMessageId === inbound.providerMessageId)
  return byEvent?.id === byMessage?.id ? byEvent : undefined
}

function fingerprint(app) { return [app.revision, app.providerAppId, app.providerTenantId, app.credentialRef].join('\0') }
function officialId(value) { return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value) }
function timestamp(value) { const date = /^\d{10,16}$/.test(String(value ?? '')) ? new Date(Number(value)) : undefined; return date && Number.isFinite(date.valueOf()) ? date.toISOString() : undefined }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) }
function createBoundedHttpInstance(base, milliseconds) {
  if (!base?.request) throw new TypeError('Feishu SDK HttpInstance is required')
  return {
    timeoutMs: milliseconds,
    request: options => base.request({ ...options, timeout: milliseconds }),
    get: (url, options) => base.get(url, { ...options, timeout: milliseconds }),
    delete: (url, options) => base.delete(url, { ...options, timeout: milliseconds }),
    head: (url, options) => base.head(url, { ...options, timeout: milliseconds }),
    options: (url, options) => base.options(url, { ...options, timeout: milliseconds }),
    post: (url, data, options) => base.post(url, data, { ...options, timeout: milliseconds }),
    put: (url, data, options) => base.put(url, data, { ...options, timeout: milliseconds }),
    patch: (url, data, options) => base.patch(url, data, { ...options, timeout: milliseconds }),
  }
}
function bounded(promise, milliseconds, timeoutError = runtimeError('UNAVAILABLE', 'Feishu ready timeout')) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError), milliseconds) })]).finally(() => clearTimeout(timer)) }
async function settleWithin(promise, milliseconds) { try { await bounded(promise, milliseconds); return true } catch { return false } }
function runtimeError(code, message) { return Object.assign(new Error(message), { code, status: code === 'UNAVAILABLE' ? 503 : 500 }) }

const LINK_CODE = /^[A-Za-z0-9_-]{43}$/
