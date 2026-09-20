import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import * as Lark from '@larksuiteoapi/node-sdk'

const logger = Object.fromEntries(['error', 'warn', 'info', 'debug', 'trace'].map(name => [name, () => {}]))

class ProbeError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function deferred() {
  let resolve
  let settled = false
  const promise = new Promise(ok => { resolve = value => { if (!settled) { settled = true; ok(value) } } })
  return { promise, resolve, get settled() { return settled } }
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--self-check') return { selfCheck: true }
  const [mode, canary, ...extra] = argv
  if (extra.length || !['fast', 'slow'].includes(mode) || typeof canary !== 'string' || Buffer.byteLength(canary) > 256 || !/^[^\u0000-\u001f\u007f]+$/u.test(canary)) throw new ProbeError('invalid_args')
  return { mode, canary, selfCheck: false }
}

function parseCredentials(raw) {
  let value
  try { value = JSON.parse(raw) } catch { throw new ProbeError('invalid_credentials') }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'appId,appSecret' || !/^cli_[0-9a-fA-F]{16}$/.test(value.appId) || !/^[A-Za-z0-9_-]{16,256}$/.test(value.appSecret)) throw new ProbeError('invalid_credentials')
  return value
}

async function readCredentialInput() {
  process.stdin.setEncoding('utf8')
  let raw = ''
  for await (const chunk of process.stdin) {
    raw += chunk
    if (Buffer.byteLength(raw) > 4096) {
      raw = ''
      throw new ProbeError('credential_input_too_large')
    }
  }
  return raw
}

function inboundFields(data) {
  const message = data?.message
  const eventId = data?.event_id
  const messageId = message?.message_id
  const chatId = message?.chat_id
  if (![eventId, messageId, chatId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value))) throw new ProbeError('invalid_inbound_ids')
  return { eventId, messageId, chatId, key: `${eventId}\0${messageId}` }
}

async function bounded(promise, ms, code) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new ProbeError(code)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

async function selfCheck() {
  const secret = 'SELF_CHECK_SECRET_0123456789'
  const credentials = parseCredentials(JSON.stringify({ appId: 'cli_0123456789abcdef', appSecret: secret }))
  assert.deepEqual(parseArgs(['fast', 'GENEWAY-P4-T0-SELF-CHECK']), { mode: 'fast', canary: 'GENEWAY-P4-T0-SELF-CHECK', selfCheck: false })
  assert.throws(() => parseArgs(['fast', 'bad\ncanary']), error => error.code === 'invalid_args')
  assert.throws(() => parseCredentials(JSON.stringify({ appId: credentials.appId, appSecret: secret, extra: true })), error => error.code === 'invalid_credentials')
  const event = { event_id: 'event-1', message: { message_id: 'message-1', chat_id: 'chat-1' } }
  const fields = inboundFields(event)
  assert.deepEqual(fields, { eventId: 'event-1', messageId: 'message-1', chatId: 'chat-1', key: 'event-1\0message-1' })
  assert.equal(inboundFields(structuredClone(event)).key, fields.key)
  assert.notEqual(inboundFields({ ...event, event_id: 'event-2' }).key, fields.key)
  assert.notEqual(inboundFields({ ...event, message: { ...event.message, message_id: 'message-2' } }).key, fields.key)
  for (const name of ['event_id', 'message_id', 'chat_id']) {
    for (const invalid of ['', 'x'.repeat(513), 'bad\0id']) {
      const candidate = structuredClone(event)
      if (name === 'event_id') candidate.event_id = invalid
      else candidate.message[name] = invalid
      assert.throws(() => inboundFields(candidate), error => error.code === 'invalid_inbound_ids')
    }
  }
  const rawId = 'provider-id-self-check'
  const report = JSON.stringify({ status: 'passed', idHash: hash(rawId) })
  credentials.appSecret = ''
  assert.equal(hash(rawId), hash(rawId))
  assert.equal(hash(rawId).length, 16)
  assert(!report.includes(rawId))
  assert(!report.includes(secret))
  console.log(JSON.stringify({ status: 'passed', mode: 'self-check', network: 'not-used' }))
}

async function run({ mode, canary }) {
  let raw = await readCredentialInput()
  const credentials = parseCredentials(raw)
  raw = ''
  const appId = credentials.appId
  let appSecret = credentials.appSecret
  credentials.appSecret = ''

  const ready = deferred()
  const failed = deferred()
  const first = deferred()
  const duplicate = deferred()
  const hits = new Map()
  let inflight = 0
  let firstAt
  let firstHandlerMs
  const startedAt = performance.now()

  const dispatcher = new Lark.EventDispatcher({ logger, loggerLevel: Lark.LoggerLevel.error }).register({
    'im.message.receive_v1': async data => {
      let text
      try { text = JSON.parse(data?.message?.content)?.text } catch { return }
      if (data?.message?.message_type !== 'text' || text !== canary) return
      const handlerAt = performance.now()
      let firstDelivery = false
      inflight += 1
      try {
        let fields
        try { fields = inboundFields(data) } catch (error) { failed.resolve(error); throw error }
        const count = (hits.get(fields.key) ?? 0) + 1
        hits.set(fields.key, count)
        firstDelivery = count === 1
        if (count > 1) {
          duplicate.resolve({ data, fields, count, at: performance.now() })
          return
        }
        firstAt = performance.now()
        first.resolve({ data, fields })
        if (mode === 'slow') await sleep(4_000)
      } finally {
        inflight -= 1
        if (firstDelivery) firstHandlerMs = performance.now() - handlerAt
      }
    },
  })

  const client = new Lark.Client({ appId, appSecret, appType: Lark.AppType.SelfBuild, domain: Lark.Domain.Feishu, logger, loggerLevel: Lark.LoggerLevel.error, source: 'geneway-p4-t0' })
  const ws = new Lark.WSClient({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    logger,
    loggerLevel: Lark.LoggerLevel.error,
    source: 'geneway-p4-t0',
    autoReconnect: true,
    handshakeTimeoutMs: 15_000,
    wsConfig: { pingTimeout: 10 },
    onReady: () => ready.resolve(performance.now()),
    onError: () => failed.resolve(new ProbeError('ws_failed')),
  })
  appSecret = ''

  const failure = () => failed.promise.then(error => { throw error })
  const shutdown = () => { try { ws.close({ force: true }) } catch {} }
  const onSignal = () => { shutdown(); process.exit(130) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    Lark.defaultHttpInstance.defaults.timeout = 10_000
    await ws.start({ eventDispatcher: dispatcher })
    const readyAt = await bounded(Promise.race([ready.promise, failure()]), 20_000, 'ready_timeout')
    console.log(JSON.stringify({ status: 'ready', mode, connection: ws.getConnectionStatus().state, readyMs: Math.round(readyAt - startedAt) }))
    const inbound = await bounded(Promise.race([first.promise, failure()]), 5 * 60_000, 'canary_timeout')

    if (mode === 'fast') {
      while (firstHandlerMs === undefined) await sleep(0)
      const sendAt = performance.now()
      const outbound = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: inbound.fields.chatId, msg_type: 'text', content: JSON.stringify({ text: `GENEWAY-P4-T0-ACK ${canary}` }), uuid: randomUUID() },
      })
      const sendMs = performance.now() - sendAt
      const output = outbound?.data
      const deletedStatus = typeof output?.deleted === 'boolean' ? output.deleted : null
      if (outbound?.code !== 0 || typeof output?.message_id !== 'string' || output.message_id.length === 0 || output.chat_id !== inbound.fields.chatId || output.msg_type !== 'text' || deletedStatus === true) throw new ProbeError(`message_create_failed_${Number.isSafeInteger(outbound?.code) ? outbound.code : 'unknown'}`)
      const observationAt = performance.now()
      await Promise.race([sleep(10_000), failure()])
      console.log(JSON.stringify({
        status: 'passed', mode, connection: ws.getConnectionStatus().state,
        inboundEventHash: hash(inbound.fields.eventId), inboundMessageHash: hash(inbound.fields.messageId), inboundChatHash: hash(inbound.fields.chatId),
        outboundMessageHash: hash(output.message_id), outboundChatHash: hash(output.chat_id), outboundType: output.msg_type, outboundDeleted: deletedStatus,
        sendCode: outbound.code, readyMs: Math.round(readyAt - startedAt), handlerMs: Math.round(firstHandlerMs), sendMs: Math.round(sendMs),
        observationMs: Math.round(performance.now() - observationAt), deliveries: hits.get(inbound.fields.key), duplicateObserved: hits.get(inbound.fields.key) > 1,
      }))
    } else {
      const remaining = Math.max(0, 20_000 - (performance.now() - firstAt))
      const retry = await Promise.race([duplicate.promise, sleep(remaining).then(() => null), failure()])
      await bounded((async () => { while (inflight > 0) await sleep(25) })(), 5_000, 'handler_drain_timeout')
      console.log(JSON.stringify({
        status: 'observed', mode, connection: ws.getConnectionStatus().state,
        inboundEventHash: hash(inbound.fields.eventId), inboundMessageHash: hash(inbound.fields.messageId), inboundChatHash: hash(inbound.fields.chatId),
        readyMs: Math.round(readyAt - startedAt), handlerMs: Math.round(firstHandlerMs), observationMs: Math.round(performance.now() - firstAt),
        deliveries: hits.get(inbound.fields.key), retryStatus: retry ? 'observed' : 'not-observed',
      }))
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    shutdown()
    await sleep(25)
    if (!['idle', 'failed'].includes(ws.getConnectionStatus().state)) throw new ProbeError('close_failed')
  }
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfCheck) await selfCheck()
  else await run(args)
} catch (error) {
  const code = error instanceof ProbeError && /^[a-z0-9_-]+$/i.test(error.code) ? error.code : 'probe_failed'
  console.error(JSON.stringify({ status: 'failed', error: code }))
  process.exitCode = 1
}
