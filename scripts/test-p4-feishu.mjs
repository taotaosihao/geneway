import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import { createFeishuRuntime } from '../plugins/feishu.mjs'
import { createChannelService } from '../src/channel-service.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const APP_A = 'cli_aaaaaaaaaaaaaaaa'
const APP_B = 'cli_bbbbbbbbbbbbbbbb'
const APP_C = 'cli_cccccccccccccccc'
const BOT_A = 'ou_bot_a'
const BOT_B = 'ou_bot_b'
const root = await mkdtemp(join(tmpdir(), 'geneway-p4-feishu-'))
const secretRoot = join(root, 'secrets')
const statePath = join(root, 'state.json')
const store = createFileStore(statePath)
const runner = fakeRunner()
const workService = createWorkService({ store, runner, connectionCatalog: [catalog()] })
const channel = createChannelService({ store, workService, clock: () => '2026-09-20T10:00:00.000Z' })
const fake = fakePlatform()
let holdInbound, failOutcomeOnce = false
const runtimeChannel = {
  ...channel,
  async recover() { fake.order.push('recover'); return channel.recover() },
  async handleInbound(input) {
    const result = await channel.handleInbound(input)
    if (holdInbound) {
      const hold = holdInbound
      holdInbound = undefined
      hold.persisted(result)
      await hold.promise
    }
    return result
  },
  async authorizeDelivery(input) { fake.order.push(`authorize:${input.deliveryId}`); return channel.authorizeDelivery(input) },
  async retryDelivery(input) { fake.order.push(`retry:${input.deliveryId}`); return channel.retryDelivery(input) },
  async validateSendClaim(input) { const result = await channel.validateSendClaim(input); fake.order.push(`claim:${input.deliveryId}`); return result },
  async recordDeliveryOutcome(input) {
    if (failOutcomeOnce) { failOutcomeOnce = false; throw new Error('controlled outcome write failure') }
    const result = await channel.recordDeliveryOutcome(input)
    fake.order.push(`outcome:${input.deliveryId}:${input.status}`)
    return result
  },
}
const runtime = createFeishuRuntime({ store, channelService: runtimeChannel, secretRoot, sdk: { ...Lark, Client: fake.Client, WSClient: fake.WSClient }, httpTimeoutMs: 50, readyTimeoutMs: 1000, closeDrainTimeoutMs: 25 })
const admin = { id: 'member-admin' }, owner = { id: 'member-owner' }

try {
  await mkdir(secretRoot, { mode: 0o700 })
  await writeCredential('FEISHU_A', APP_A, 'secret_A_0123456789')
  await writeCredential('FEISHU_B', APP_B, 'secret_B_0123456789')
  await store.update(seed)

  const recoveryWork = await createWork('WO-RECOVER', 'recover-work')
  const recoveryDelivery = await channel.createDelivery(owner, deliveryInput('recover-delivery', recoveryWork))
  await channel.authorizeDelivery({ deliveryId: recoveryDelivery.delivery.id })
  assert.equal((await delivery(recoveryDelivery.delivery.id)).status, 'sending')

  fake.holdReady.add(APP_A)
  let startSettled = false
  const starting = runtime.start().finally(() => { startSettled = true })
  await waitFor(() => fake.ws.some(item => item.options.appId === APP_A))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(startSettled, false)
  assert.equal(runtime.isAvailable('app-a'), false)
  fake.holdReady.delete(APP_A)
  currentWs(APP_A).options.onReady()
  await starting
  assert.equal(fake.order[0], 'recover')
  assert.equal((await delivery(recoveryDelivery.delivery.id)).status, 'unknown')
  assert(fake.order.indexOf(`bot:${APP_A}`) < fake.order.indexOf(`ws:${APP_A}`))
  assert(fake.order.indexOf(`bot:${APP_B}`) < fake.order.indexOf(`ws:${APP_B}`))
  assert.equal(runtime.isAvailable('app-a'), true)
  assert.equal(runtime.isAvailable('app-b'), true)
  assert.equal((await app('app-a')).status, 'active')
  assert.equal((await app('app-b')).status, 'active')
  assert(fake.clients.every(item => item.options.httpInstance !== Lark.defaultHttpInstance && item.options.httpInstance.timeoutMs === 50))
  const appA = await app('app-a')
  await assert.rejects(channel.setChannelAppRuntime({ channelAppId: appA.id, revision: appA.revision, providerAppId: appA.providerAppId, providerTenantId: appA.providerTenantId, credentialRef: 'WRONG_REF', available: true }), hasCode('CHANNEL_RUNTIME_STALE'))
  assert(fake.ws.every(item => item.dispatcher instanceof Lark.EventDispatcher))

  await callbackAvailability()
  const privateWork = await inboundAdmission()
  await sendOutcomes(privateWork)
  await rotationAndStrictCredentials()
  const strandedDeliveryId = await outcomeWriteFailure(privateWork)
  await shutdown(strandedDeliveryId)

  const disk = await readFile(statePath, 'utf8')
  for (const secret of ['secret_A_0123456789', 'secret_B_0123456789', 'rotated_A_01234567']) assert.equal(disk.includes(secret), false)
  assert.equal(fake.realPlatformCalls, 0)
  console.log(`P4 Feishu adapter checks passed; fake SDK calls=${fake.sendCalls.length}; real platform calls=0; blind retries=0`)
} finally {
  await runtime.close().catch(() => undefined)
  await workService.close()
  await rm(root, { recursive: true, force: true })
}

async function callbackAvailability() {
  const a = currentWs(APP_A), b = currentWs(APP_B)
  a.options.onReconnecting()
  await waitFor(() => !runtime.isAvailable('app-a') && runtime.isAvailable('app-b'))
  assert.equal((await app('app-a')).status, 'unavailable')
  assert.equal(b.closed, false)
  a.options.onReconnected()
  await waitFor(() => runtime.isAvailable('app-a'))
  assert.equal((await app('app-a')).status, 'active')
}

async function inboundAdmission() {
  const ws = currentWs(APP_A)
  const before = (await store.read()).channelMessages.length
  const hold = deferred()
  let persistedResolve
  const persisted = new Promise(resolve => { persistedResolve = resolve })
  holdInbound = { promise: hold.promise, persisted: persistedResolve }
  let settled = false
  const accepted = ws.dispatcher.invoke(event({ eventId: 'event-private', messageId: 'message-private', chatId: 'private-owner', senderOpenId: 'open-owner', text: '交办 工单 WO-1' }), { needCheck: false })
  accepted.finally(() => { settled = true })
  const inbound = await persisted
  assert.equal(inbound.code, 'WORK_ACCEPTED')
  assert.equal((await store.read()).channelMessages.find(item => item.providerEventId === 'event-private').status, 'accepted')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  hold.resolve()
  await accepted
  assert.equal(settled, true)
  const work = await waitWork(inbound.workId)
  assert.equal((await store.read()).channelMessages.length, before + 1)

  const replayState = await store.read(), replayExecutions = replayState.works.find(item => item.id === work.id).executions.length, replaySends = fake.sendCalls.length
  await ws.dispatcher.invoke(event({ eventId: 'event-private', messageId: 'message-private', chatId: 'private-owner', senderOpenId: 'open-owner', text: '交办 工单 WO-1' }), { needCheck: false })
  const replayed = await store.read()
  assert.equal(replayed.works.length, replayState.works.length)
  assert.equal(replayed.works.find(item => item.id === work.id).executions.length, replayExecutions)
  assert.equal(fake.sendCalls.length, replaySends)

  const link = await channel.issueLinkCode(admin, { channelAppId: 'app-a' })
  const linkMessages = (await store.read()).channelMessages.length, linkSends = fake.sendCalls.length
  await ws.dispatcher.invoke(event({ eventId: 'event-link', messageId: 'message-link', chatId: 'private-link', senderOpenId: 'open-link', text: link.code }), { needCheck: false })
  const linked = await store.read()
  assert.equal(linked.linkCodes.find(item => item.id === link.id).status, 'matched')
  assert.equal(linked.channelMessages.length, linkMessages)
  assert.equal(fake.sendCalls.length, linkSends)

  const nontextWorks = linked.works.length, nontextSends = fake.sendCalls.length
  await ws.dispatcher.invoke(event({ eventId: 'event-image', messageId: 'message-image', chatId: 'private-owner', senderOpenId: 'open-owner', messageType: 'image', content: JSON.stringify({ image_key: 'img-controlled' }) }), { needCheck: false })
  const nontext = await store.read()
  assert.equal(nontext.works.length, nontextWorks)
  assert.equal(nontext.channelMessages.find(item => item.providerEventId === 'event-image').status, 'rejected')
  assert.equal(fake.sendCalls.length, nontextSends + 1)

  const missingSenderType = event({ eventId: 'event-sender-missing', messageId: 'message-sender-missing', chatId: 'private-owner', senderOpenId: 'open-owner', text: '交办 工单 WO-1' })
  delete missingSenderType.event.sender.sender_type
  const ignored = [
    event({ eventId: 'event-self', messageId: 'message-self', chatId: 'private-owner', senderOpenId: BOT_A, senderType: 'app', text: '交办 工单 WO-1' }),
    event({ eventId: 'event-other-app', messageId: 'message-other-app', chatId: 'private-owner', senderOpenId: 'open-owner', senderType: 'app', text: '交办 工单 WO-1' }),
    event({ eventId: 'event-other-bot', messageId: 'message-other-bot', chatId: 'private-owner', senderOpenId: 'open-owner', senderType: 'bot', text: '交办 工单 WO-1' }),
    missingSenderType,
    event({ eventId: 'event-app', messageId: 'message-app', chatId: 'private-owner', senderOpenId: 'open-owner', appId: APP_B, text: '交办 工单 WO-1' }),
    event({ eventId: 'event-tenant', messageId: 'message-tenant', chatId: 'private-owner', senderOpenId: 'open-owner', tenantKey: 'wrong-tenant', text: '交办 工单 WO-1' }),
    event({ eventId: 'event-open', messageId: 'message-open', chatId: 'private-owner', senderOpenId: '', text: '交办 工单 WO-1' }),
    event({ eventId: 'event-chat', messageId: 'message-chat', chatId: '', senderOpenId: 'open-owner', text: '交办 工单 WO-1' }),
    event({ eventId: 'event-message', messageId: '', chatId: 'private-owner', senderOpenId: 'open-owner', text: '交办 工单 WO-1' }),
    event({ eventId: 'event-no-mention', messageId: 'message-no-mention', chatId: 'group-owner', senderOpenId: 'open-owner', chatType: 'group', text: '交办 工单 WO-2' }),
    event({ eventId: 'event-wrong-mention', messageId: 'message-wrong-mention', chatId: 'group-owner', senderOpenId: 'open-owner', chatType: 'group', text: '@_user_1 交办 工单 WO-2', mentions: [{ key: '@_user_1', id: { open_id: 'ou_other_bot' } }] }),
  ]
  const ignoredBefore = (await store.read()).channelMessages.length
  for (const value of ignored) await ws.dispatcher.invoke(value, { needCheck: false })
  assert.equal((await store.read()).channelMessages.length, ignoredBefore)

  await ws.dispatcher.invoke(event({ eventId: 'event-group', messageId: 'message-group', chatId: 'group-owner', senderOpenId: 'open-owner', chatType: 'group', text: '@_user_1 交办 工单 WO-2', mentions: [{ key: '@_user_1', id: { open_id: BOT_A } }] }), { needCheck: false })
  const groupMessage = (await store.read()).channelMessages.find(item => item.providerEventId === 'event-group')
  assert.equal(groupMessage.status, 'accepted')
  assert.equal(groupMessage.text, '交办 工单 WO-2')
  assert.equal((await store.read()).channelConversations.find(item => item.id === groupMessage.conversationId).type, 'group')
  await waitWork(groupMessage.workId)
  return work
}

async function sendOutcomes(work) {
  const resultId = work.results[0].id
  const successful = await channel.createWorkDelivery(owner, { workId: work.id, resultId, requestId: 'send-success' })
  fake.outcomes.push('success')
  const orderAt = fake.order.length
  const delivered = await runtime.sendDelivery(successful.delivery.id)
  assert.equal(delivered.status, 'delivered')
  assert.deepEqual(fake.order.slice(orderAt), [`authorize:${successful.delivery.id}`, `claim:${successful.delivery.id}`, 'io', `outcome:${successful.delivery.id}:delivered`])
  const successfulCall = fake.sendCalls.at(-1)
  assert.equal(successfulCall.appId, APP_A)
  assert.equal(successfulCall.options.params.receive_id_type, 'chat_id')
  assert.equal(successfulCall.options.data.receive_id, 'private-owner')
  assert.match(successfulCall.options.data.uuid, /^[0-9a-f-]{36}$/)

  const failedCandidate = await channel.createWorkDelivery(owner, { workId: work.id, resultId, requestId: 'send-failed' })
  fake.outcomes.push('failed')
  const beforeFailed = fake.sendCalls.length
  assert.equal((await runtime.sendDelivery(failedCandidate.delivery.id)).status, 'failed')
  assert.equal(fake.sendCalls.length, beforeFailed + 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fake.sendCalls.length, beforeFailed + 1)
  fake.outcomes.push('success')
  const retried = await runtime.sendDelivery(failedCandidate.delivery.id, { retry: true })
  assert.equal(retried.status, 'delivered')
  assert.equal(retried.attempts, 2)

  const unknownCandidate = await channel.createWorkDelivery(owner, { workId: work.id, resultId, requestId: 'send-unknown' })
  fake.outcomes.push('throw')
  const beforeUnknown = fake.sendCalls.length
  assert.equal((await runtime.sendDelivery(unknownCandidate.delivery.id)).status, 'unknown')
  assert.equal(fake.sendCalls.length, beforeUnknown + 1)
  await assert.rejects(runtime.sendDelivery(unknownCandidate.delivery.id, { retry: true }), hasCode('INVALID_STATE'))
  assert.equal(fake.sendCalls.length, beforeUnknown + 1)

  const mismatched = await channel.createWorkDelivery(owner, { workId: work.id, resultId, requestId: 'send-chat-mismatch' })
  fake.outcomes.push('wrong-chat')
  assert.equal((await runtime.sendDelivery(mismatched.delivery.id)).status, 'unknown')

  const timedOut = await channel.createWorkDelivery(owner, { workId: work.id, resultId, requestId: 'send-timeout' })
  fake.outcomes.push('never')
  const timeoutStarted = Date.now()
  assert.equal((await runtime.sendDelivery(timedOut.delivery.id)).status, 'unknown')
  assert(Date.now() - timeoutStarted < 500)
  const late = fake.pendingSends.shift()
  assert(late)
  late.resolve({ code: 0, data: { message_id: 'om-late', chat_id: late.options.data.receive_id } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await delivery(timedOut.delivery.id)).status, 'unknown')
}

async function rotationAndStrictCredentials() {
  const oldA = currentWs(APP_A), originalB = currentWs(APP_B)
  await writeCredential('FEISHU_A_ROTATED', APP_A, 'rotated_A_01234567')
  const rotated = await channel.upsertChannelApp(admin, { id: 'app-a', credentialRef: 'FEISHU_A_ROTATED' })
  await runtime.sync()
  assert.equal(oldA.closed, true)
  assert.deepEqual(oldA.closeParams, { force: true })
  assert.equal(originalB.closed, false)
  assert.equal(runtime.isAvailable('app-a'), true)
  assert.equal((await app('app-a')).revision, rotated.revision)
  const newA = currentWs(APP_A)
  oldA.options.onReconnected()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.isAvailable('app-a'), true)
  assert.equal(currentWs(APP_A), newA)

  await writeFile(join(secretRoot, 'FEISHU_BAD'), JSON.stringify({ appId: APP_A, appSecret: 'bad_secret_01234567', extra: true }), { mode: 0o600 })
  await channel.upsertChannelApp(admin, { id: 'app-a', credentialRef: 'FEISHU_BAD' })
  await runtime.sync()
  assert.equal(newA.closed, true)
  assert.equal(runtime.isAvailable('app-a'), false)
  assert.equal((await app('app-a')).status, 'unavailable')

  await writeCredential('FEISHU_MISMATCH', APP_B, 'mismatch_012345678')
  await channel.upsertChannelApp(admin, { id: 'app-a', credentialRef: 'FEISHU_MISMATCH' })
  await runtime.sync()
  assert.equal(runtime.isAvailable('app-a'), false)

  await channel.upsertChannelApp(admin, { id: 'app-a', credentialRef: 'FEISHU_A_ROTATED' })
  await runtime.sync()
  assert.equal(runtime.isAvailable('app-a'), true)

  const disabledB = await channel.upsertChannelApp(admin, { id: 'app-b', enabled: false })
  await runtime.sync()
  assert.equal(disabledB.status, 'disabled')
  assert.equal(originalB.closed, true)
  assert.equal(runtime.isAvailable('app-b'), false)
  assert.equal((await app('app-b')).status, 'disabled')
}

async function outcomeWriteFailure(work) {
  const candidate = await channel.createWorkDelivery(owner, { workId: work.id, resultId: work.results[0].id, requestId: 'outcome-write-failure' })
  fake.outcomes.push('success')
  failOutcomeOnce = true
  await assert.rejects(runtime.sendDelivery(candidate.delivery.id), /controlled outcome write failure/)
  assert.equal((await delivery(candidate.delivery.id)).status, 'sending')
  return candidate.delivery.id
}

async function shutdown(strandedDeliveryId) {
  const active = currentWs(APP_A)
  const hold = deferred()
  let persistedResolve
  const persisted = new Promise(resolve => { persistedResolve = resolve })
  holdInbound = { promise: hold.promise, persisted: persistedResolve }
  const shutdownEvent = event({ eventId: 'event-shutdown', messageId: 'message-shutdown', chatId: 'private-owner', senderOpenId: 'open-owner', text: '交办 工单 WO-3' })
  const invocation = active.dispatcher.invoke(shutdownEvent, { needCheck: false })
  const accepted = await persisted
  assert.equal(accepted.code, 'WORK_ACCEPTED')
  const acceptedState = await store.read(), acceptedMessage = acceptedState.channelMessages.find(item => item.providerEventId === 'event-shutdown')
  assert.equal(acceptedMessage.status, 'accepted')
  assert.equal(acceptedState.deliveries.some(item => item.channelMessageId === acceptedMessage.id), false)

  await writeCredential('FEISHU_C', APP_C, 'secret_C_0123456789')
  fake.botOutcomes.set(APP_C, 'never')
  await channel.upsertChannelApp(admin, { id: 'app-c', provider: 'feishu', providerAppId: APP_C, providerTenantId: 'tenant-c', credentialRef: 'FEISHU_C', enabled: true, allowedScopes: ['result'] })
  const syncing = runtime.sync()
  await waitFor(() => fake.order.includes(`bot:${APP_C}`))
  const sends = fake.sendCalls.length, closeStarted = Date.now()
  await runtime.close()
  assert(Date.now() - closeStarted < 500)
  assert.equal(active.closed, true)
  assert.deepEqual(active.closeParams, { force: true })
  assert.equal(runtime.isAvailable('app-a'), false)
  assert.equal((await app('app-a')).status, 'unavailable')
  const closedState = await store.read()
  const fallbackDeliveries = closedState.deliveries.filter(item => item.channelMessageId === acceptedMessage.id)
  assert.equal(fallbackDeliveries.length, 1)
  assert.equal(fallbackDeliveries[0].status, 'pending')
  assert.equal(closedState.deliveries.find(item => item.id === strandedDeliveryId).status, 'unknown')
  assert.equal(closedState.works.find(item => item.id === accepted.workId).executions.length, 1)
  assert.equal(fake.sendCalls.length, sends)

  hold.resolve()
  await invocation
  await syncing
  const drained = await store.read()
  assert.equal(drained.deliveries.filter(item => item.channelMessageId === acceptedMessage.id).length, 1)
  assert.equal(drained.deliveries.find(item => item.channelMessageId === acceptedMessage.id).status, 'pending')
  const executions = drained.works.find(item => item.id === accepted.workId).executions.length
  await active.dispatcher.invoke(shutdownEvent, { needCheck: false })
  assert.equal((await store.read()).works.find(item => item.id === accepted.workId).executions.length, executions)
  assert.equal(fake.sendCalls.length, sends)

  active.options.onReconnected()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.isAvailable('app-a'), false)
  await assert.rejects(runtime.sendDelivery('anything'), hasCode('UNAVAILABLE'))
  assert.equal(fake.sendCalls.length, sends)
}

function fakePlatform() {
  const platform = { order: [], clients: [], ws: [], sendCalls: [], outcomes: [], pendingSends: [], botOutcomes: new Map(), holdReady: new Set(), realPlatformCalls: 0 }
  platform.Client = class {
    constructor(options) {
      this.options = options
      this.appId = options.appId
      platform.clients.push(this)
      this.im = { v1: { message: { create: async options => {
        platform.order.push('io')
        platform.sendCalls.push({ appId: this.appId, options: structuredClone(options) })
        const outcome = platform.outcomes.shift() ?? 'success'
        if (outcome === 'throw') throw new Error('controlled network ambiguity')
        if (outcome === 'never') return new Promise(resolve => platform.pendingSends.push({ resolve, options: structuredClone(options) }))
        if (outcome === 'failed') return { code: 230001, msg: 'controlled failure' }
        if (outcome === 'wrong-chat') return { code: 0, data: { message_id: `om-${platform.sendCalls.length}`, chat_id: 'wrong-chat' } }
        return { code: 0, data: { message_id: `om-${platform.sendCalls.length}`, chat_id: options.data.receive_id } }
      } } } }
    }
    async request({ url, method }) {
      assert.equal(url, '/open-apis/bot/v3/info')
      assert.equal(method, 'GET')
      platform.order.push(`bot:${this.appId}`)
      if (platform.botOutcomes.get(this.appId) === 'never') return new Promise(() => {})
      return { code: 0, bot: { open_id: this.appId === APP_A ? BOT_A : BOT_B } }
    }
  }
  platform.WSClient = class {
    constructor(options) { this.options = options; this.closed = false; platform.ws.push(this) }
    async start({ eventDispatcher }) {
      this.dispatcher = eventDispatcher
      platform.order.push(`ws:${this.options.appId}`)
      if (!platform.holdReady.has(this.options.appId)) this.options.onReady()
    }
    close(params) { this.closed = true; this.closeParams = structuredClone(params) }
  }
  return platform
}

function event({ eventId, messageId, chatId, senderOpenId, text, appId = APP_A, tenantKey = 'tenant-a', senderType = 'user', chatType = 'p2p', messageType = 'text', content, mentions }) {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: appId, tenant_key: tenantKey, create_time: '1789870000000' },
    event: {
      sender: { sender_id: { open_id: senderOpenId }, sender_type: senderType, tenant_key: tenantKey },
      message: { message_id: messageId, chat_id: chatId, chat_type: chatType, message_type: messageType, content: content ?? JSON.stringify({ text }), create_time: '1789870000000', mentions },
    },
  }
}

async function createWork(workOrderId, clientRequestId) {
  const accepted = await workService.createWork(owner, { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner', workOrderId, clientRequestId })
  assert.equal(accepted.ok, true)
  return waitWork(accepted.value.id)
}

async function waitWork(workId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const work = (await store.read()).works.find(item => item.id === workId)
    if (work?.status === 'completed') return work
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`work did not complete: ${workId}`)
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

async function writeCredential(ref, appId, appSecret) {
  await writeFile(join(secretRoot, ref), JSON.stringify({ appId, appSecret }), { mode: 0o600 })
}

function seed(state) {
  const now = '2026-09-20T00:00:00.000Z'
  return {
    ...state,
    members: [
      { id: 'member-admin', loginName: 'admin', displayName: 'admin', role: 'admin', enabled: true, authRef: 'admin', sessionVersion: 1, employeeIds: [], createdAt: now, updatedAt: now },
      { id: 'member-owner', loginName: 'owner', displayName: 'owner', role: 'member', enabled: true, authRef: 'owner', sessionVersion: 1, employeeIds: ['employee-owner'], createdAt: now, updatedAt: now },
    ],
    modelRoutes: [{ id: 'model-1', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-owner', name: '员工', enabled: true, modelRouteId: 'model-1', connectionIds: ['connection-owner'], skillIds: ['skill-gearjob-work-order-read'] }],
    connections: [{ id: 'connection-owner', name: 'GearJob', ...catalog(), allowedObjectIds: ['WO-RECOVER', 'WO-1', 'WO-2', 'WO-3'], enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 }],
    skills: [{ id: 'skill-gearjob-work-order-read', name: '工单查询', capabilityId: 'gearjob-work-order-read', enabled: true }],
    channelApps: [channelApp('app-a', APP_A, 'tenant-a', 'FEISHU_A', now), channelApp('app-b', APP_B, 'tenant-b', 'FEISHU_B', now)],
    channelIdentities: [{ id: 'identity-owner', channelAppId: 'app-a', providerUserId: 'open-owner', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }],
    channelConversations: [{ id: 'conversation-owner', channelAppId: 'app-a', providerConversationId: 'private-owner', identityId: 'identity-owner', memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, defaultDispatch: { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner' }, createdAt: now, updatedAt: now }],
  }
}

function channelApp(id, providerAppId, providerTenantId, credentialRef, now) { return { id, provider: 'feishu', providerAppId, providerTenantId, credentialRef, enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now } }
function catalog() { return { kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'http://127.0.0.1/gearjob', credentialRef: 'gearjob.json', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' } }
function deliveryInput(requestId, work) { return { channelAppId: 'app-a', requestId, workId: work.id, resultId: work.results[0].id, targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result' } }
function currentWs(appId) { const result = fake.ws.findLast(item => item.options.appId === appId && !item.closed); assert(result, `missing active WS ${appId}`); return result }
async function app(id) { return (await store.read()).channelApps.find(item => item.id === id) }
async function delivery(id) { return (await store.read()).deliveries.find(item => item.id === id) }
function hasCode(code) { return value => value?.code === code }
function deferred() { let resolve; const promise = new Promise(ok => { resolve = ok }); return { promise, resolve } }

function fakeRunner() {
  let calls = 0
  return {
    configured: true,
    async run(args) {
      calls += 1
      const source = { sourceRecordId: `Work Order:${args.input.workOrderId}`, sourceRevision: 'r1', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' }
      return { explanation: 'fixture', dshSessionRef: `session-${calls}`, continuity: 'new', contextConfirmationRefs: [], eventCount: 1, result: { kind: 'gearjob.work-order.observation', payload: { workOrderId: args.input.workOrderId, status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', ...source }, source, toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2' } }
    },
    async cancel() {},
    async close() {},
  }
}
