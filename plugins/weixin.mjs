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
            await attest('unavailable', code)
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
    const progress = (status, index, code) => ({ deliveryId, attemptId, status, totalParts: chunks.length, acknowledgedParts: confirmed.map(part => ({ ...part })), ...(index === undefined ? {} : { partIndex: index }), ...(code ? { error: { code } } : {}) })
    for (let index = confirmed.length; index < chunks.length; index += 1) {
      const clientId = expectedId(index)
      if (closed || !available || controller.signal.aborted) return record(progress('blocked', index, 'WEIXIN_UNAVAILABLE'))
      const [token, context] = await Promise.all([secrets.read(account.tokenRef), secrets.read(account.contextRef)])
      if (typeof token !== 'string' || !token || typeof context?.token !== 'string' || !context.token) return record(progress('failed', index, 'WEIXIN_CONTEXT_UNAVAILABLE'))
      try {
        if (await beforeSend({ deliveryId, attemptId, toUserId, partIndex: index, clientId }) !== true) return record(progress('blocked', index, 'WEIXIN_SEND_FORBIDDEN'))
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
    channelAppId: bot.channelAppId, providerEventId: providerMessageId, providerMessageId,
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
