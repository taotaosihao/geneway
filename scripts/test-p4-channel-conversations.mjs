import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { connection as receiptConnection, correlationFixture, createCompletedCorrelationTree, now as receiptNow } from './fixtures/kivo-device-correlation.mjs'

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await runChannelChecks()

export function createFeishuSimulator() {
  const replies = [], fixture = { dispatcher: undefined, sent: [], consumers: { starts: 0, closes: 0, active: 0, maxActive: 0 }, queueSend(...responses) { replies.push(...responses) } }
  fixture.Client = class {
    constructor() { this.im = { v1: { message: { create: async options => {
      fixture.sent.push(structuredClone(options))
      const next = replies.shift()
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(options) : next ?? { code: 0, data: { message_id: `sent-${fixture.sent.length}`, chat_id: options.data.receive_id } }
    } } } } }
    async request(input) { assert.deepEqual(input, { url: '/open-apis/bot/v3/info', method: 'GET' }); return { code: 0, bot: { open_id: 'fixture-bot' } } }
  }
  fixture.WSClient = class {
    constructor(options) { this.options = options }
    async start({ eventDispatcher }) {
      fixture.dispatcher = eventDispatcher
      fixture.consumers.starts += 1
      fixture.consumers.active += 1
      fixture.consumers.maxActive = Math.max(fixture.consumers.maxActive, fixture.consumers.active)
      this.options.onReady()
    }
    close() { if (this.closed) return; this.closed = true; fixture.consumers.closes += 1; fixture.consumers.active -= 1 }
  }
  return fixture
}


async function runChannelChecks() {
  // This fixture starts product HTTP/transports, never the default server/native/model assembly.
  for (const key of Object.keys(process.env)) if (/^(GENEWAY_|DSH_|DEEPSEEK|ZENMUX|OPENAI|ANTHROPIC|CLAUDE)|(?:API_KEY|TOKEN|SECRET|PASSWORD|PROXY)$/i.test(key)) delete process.env[key]
  const spawnOwner = childProcess.spawn
  let ownerLockProcesses = 0, transferProcesses = 0
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = () => { throw new Error('NATIVE_PROCESS_FORBIDDEN') }
  childProcess.spawn = (command, args, options) => {
    assert.equal(command, '/bin/sh', 'only the existing OS owner-lock helper may start')
    assert.deepEqual(args, ['-c', '/usr/bin/flock --nonblock --conflict-exit-code 73 3 || exit $?; printf ready; IFS= read -r _ || test "$?" -eq 1'])
    ownerLockProcesses += 1
    return spawnOwner(command, args, options)
  }
  syncBuiltinESMExports()
  const connect = Socket.prototype.connect, fetchLocal = globalThis.fetch, origins = new Set()
  let httpCalls = 0, nonLoopbackAttempts = 0
  Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0]
    const host = typeof options === 'object' ? options.host ?? options.hostname : args[1]
    if (!['127.0.0.1', '::1'].includes(host)) { nonLoopbackAttempts += 1; throw new Error('NON_LOOPBACK_FORBIDDEN') }
    return connect.apply(this, args)
  }
  globalThis.fetch = (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!origins.has(url.origin)) { nonLoopbackAttempts += 1; throw new Error('UNREGISTERED_FIXTURE_ORIGIN') }
    httpCalls += 1
    return fetchLocal(input, { ...options, redirect: 'error' })
  }

  const [{ createGenewayServer, createChannelRuntime }, { createFileStore, STATE_VERSION }, { createConversationService }, { createChannelService }, { createWorkService }, { createAuthRuntime, initializeAuthFile }, { createChannelSecretStore }, { createFeishuRuntime }, weixin, { createWeixinApi }, { createILinkSimulator }, Lark] = await Promise.all([
    import('../src/server.mjs'), import('../src/store/file-store.mjs'), import('../src/conversation-service.mjs'), import('../src/channel-service.mjs'),
    import('../src/work-service.mjs'), import('../src/auth.mjs'), import('../src/channel-secret-store.mjs'), import('../plugins/feishu.mjs'),
    import('../plugins/weixin.mjs'), import('../vendor/dsh-im/weixin/weixin-api.mjs'), import('./fixtures/ilink-server.mjs'), import('@larksuiteoapi/node-sdk'),
  ])
  const now = '2026-10-15T00:00:00.000Z', appId = 'cli_aaaaaaaaaaaaaaaa', weixinAppId = 'channel-app-weixin', results = []
  const transferChecks = [
    ['backup: separate exact-reference secrets paired with final state bytes', transferCopies, { noFixture: true }],
    ['backup: permission, path, omission, tamper and pairing failures publish nothing', transferRejects, { noFixture: true }],
    ['backup: live atomic state replacement invalidates the secret snapshot', transferSnapshotRace, { noFixture: true }],
  ]
  const receiptChecks = [
    ['receipt: child Feishu delivery, exact reply parent, retry isolation and late revocation', receiptFeishu, { receipt: true }],
    ['receipt: child iLink delivery, recent context and late revocation', receiptWeixin, { receipt: true, weixinPrebound: true }],
  ]
  const checks = process.argv.includes('--receipt-only') ? receiptChecks : process.argv.includes('--transfer-only') ? transferChecks : [
    ['fixture: S1 HTTP and synthetic model boundary', webBoundary],
    ['fixture: both actual transports enter the product inbox', transportBoundary, { weixinPrebound: true }],
    ['Feishu: pending confirmation and isolated natural-text conversations', confirmation],
    ['Feishu: stable IDs deduplicate and conflicting text stays rejected', idempotency],
    ['Feishu reply: unknown parent is durable rejection without a turn', unknownReplyParent],
    ['Feishu reply: another member parent cannot enter the current conversation', foreignReplyParent],
    ['Feishu reply: an old parent cannot cross explicit or default rotation', oldReplyParent],
    ['Feishu reply: exact current inbox and platform ACK parents are accepted', currentReplyParent],
    ['Feishu: explicit Web reply preserves failed/unknown without another model run', feishuDeliveryOutcomes],
    ['iLink: failed inbox commit cannot acknowledge a batch', inboxFailure, { weixinPrebound: true }],
    ['iLink: failed cursor publication replays without another turn', cursorFailure, { weixinPrebound: true }],
    ['iLink: restart rejects a durable unfinished inbox without starting another turn', restartInbox, { weixinPrebound: true }],
    ['iLink: expired credentials survive close/restart and app enable without polling again', expiredCredentials, { weixinPrebound: true }],
    ['iLink: cancelled binding cannot activate a late login', cancelledLogin],
    ['rotation: clean channel context and continued owner Web history', rotation],
    ['default Agent: implicit next-message rotation and explicit choice isolation', channelDefaults],
    ['default Agent: active reply is durable busy without an automatic replay', busyDefaultChange],
    ['iLink: partial unknown is durable and never blindly retried', partialUnknown, { weixinPrebound: true }],
    ['iLink: next segment rechecks current member authorization', segmentRevocation, { weixinPrebound: true }],
    ['relink: fresh identity and notification target never transfers', relink],
    ['notification: legacy target survives rotation and never moves on relink', notificationIdentity, { legacyNotification: true }],
    ['restore: paired and missing secrets preserve history and require a fresh Weixin identity', restoreWeixin, { weixinPrebound: true }],
    ...transferChecks,
    ...receiptChecks,
  ]
  for (const [name, check, options] of checks) {
    let h
    try { if (!options?.noFixture) h = await fixture(options); await check(h); results.push({ name, status: 'passed' }) }
    catch (error) { results.push({ name, status: 'failed', code: error.code ?? error.name, reason: String(error.message).split('\n')[0] }) }
    finally {
      try { await h?.close() } catch (error) { results.push({ name: `${name}: cleanup`, status: 'failed', code: error.code ?? error.name, reason: String(error.message).split('\n')[0] }) }
    }
  }
  const failed = results.filter(item => item.status === 'failed')
  console.log(JSON.stringify({ ok: failed.length === 0, channelAcceptance: 'controlled transport/API fixture; no real native/model/browser acceptance', nativeStarts: 0, ownerLockProcesses, transferProcesses, realModelCalls: 0, nonLoopbackAttempts, httpCalls, ...(process.argv.includes('--transfer-only') ? { skipped: 'channel transports/API assertions; --transfer-only' } : {}), ...(process.argv.includes('--receipt-only') ? { skipped: 'unrelated channel/transfer assertions; --receipt-only' } : {}), results }))
  process.exitCode = failed.length || nonLoopbackAttempts ? 1 : 0

  async function receiptPreview(h, conversationId) {
    const { createActionService } = await import('../src/action-service.mjs')
    const tree = await createCompletedCorrelationTree({ store: h.store, workService: h.workService, actor: { id: 'a' }, conversationId, leaderEmployeeId: 'agent-a', childEmployeeId: 'agent-b', at: receiptNow })
    h.actionService = createActionService({ store: h.store, clock: () => receiptNow, connectionCatalog: [receiptConnection],
      async readCorrelation(options) { await options.authorize(); return correlationFixture({ ...options.input, at: receiptNow, sampleAt: receiptNow }) },
      adapter: { async dispatch(options) {
        const claim = await options.claimAttempt()
        if (!claim.claimed) return { kind: 'not-claimed', action: claim.action }
        await options.authorize(); h.injectedBusinessWrites = (h.injectedBusinessWrites ?? 0) + 1
        const action = options.action
        return { kind: 'receipt', receipt: { upstreamRecordId: randomUUID(), orderNo: action.preview.payload.orderNo, deviceId: action.preview.payload.deviceId, status: 'reported',
          creation: { actorKind: 'machine', machineAccountId: receiptConnection.clientId, traceId: action.id, revision: '0' }, currentRevision: '0', replayed: false, queriedAt: receiptNow } }
      } },
    })
    const path = `/api/works/${tree.child.id}/actions`
    const preview = await h.request('a', path, { reason: '合成异常', description: '受控渠道回执', clientRequestId: 'receipt-preview' })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    const action = preview.body, body = { expectedRevision: action.preview.expectedRevision, previewDigest: action.preview.digest, clientRequestId: 'receipt-approve' }
    return { ...tree, action, body, approvePath: `${path}/${action.id}/approve` }
  }

  async function receiptFeishu(h) {
    await h.bindFeishu('a')
    const source = await h.active('a'), prepared = await receiptPreview(h, source.id)
    const before = h.platform.sent.length, models = h.runner.calls.length
    const approved = await h.request('a', prepared.approvePath, prepared.body)
    assert.equal(approved.status, 200); assert(approved.body.receipt)
    let delivery = (await h.disk()).deliveries.find(item => item.actionId === prepared.action.id)
    assert.equal(delivery.status, 'delivered'); assert.equal(delivery.workId, prepared.child.id)
    assert.equal(h.platform.sent.length, before + 1); assert.equal(h.injectedBusinessWrites, 1)
    assert(h.platform.sent.at(-1).data.content.includes(approved.body.receipt.orderNo))
    assert.equal(h.runner.calls.length, models)
    await h.request('a', prepared.approvePath, prepared.body)
    assert.equal(h.platform.sent.length, before + 1); assert.equal(h.injectedBusinessWrites, 1)
    await h.feishuEvent('a', 'receipt-exact-parent', '本人明确补充', delivery.providerMessageId)
    assert.equal((await h.disk()).channelMessages.find(item => item.providerMessageId === 'receipt-exact-parent').memberConversationId, source.id)
    const analysis = await h.channel.createWorkDelivery({ id: 'a' }, { workId: prepared.child.id, resultId: prepared.action.preview.resultId, requestId: 'receipt-separate-analysis' })
    assert.equal(analysis.delivery.actionId, undefined); assert.notEqual(analysis.delivery.id, delivery.id)

    delivery = (await h.channel.createWorkDelivery({ id: 'a' }, { workId: prepared.child.id, actionId: prepared.action.id, requestId: 'receipt-retry-check' })).delivery
    h.platform.queueSend({ code: 230001 })
    assert.equal((await h.transports.sendDelivery(delivery.id)).status, 'failed')
    h.platform.queueSend(new Error('controlled unknown send'))
    assert.equal((await h.request('a', `/api/channels/deliveries/${delivery.id}/retry`, {})).body.status, 'unknown')
    const sent = h.platform.sent.length
    assert.equal((await h.request('a', `/api/channels/deliveries/${delivery.id}/retry`, {})).status, 409)
    assert.equal(h.platform.sent.length, sent); assert.equal(h.injectedBusinessWrites, 1)
    await receiptRevocation(h, prepared, () => h.platform.sent.length)
  }

  async function receiptWeixin(h) {
    await h.startWeixin()
    h.simulator.push(h.bot.id, [h.message('receipt-context')])
    await until(async () => (await h.disk()).channelMessages.some(item => item.providerMessageId === 'receipt-context' && item.status === 'accepted'))
    await until(() => h.sent().length > 0)
    const identity = (await h.disk()).channelIdentities.find(item => item.id === 'wx-fixture')
    const prepared = await receiptPreview(h, identity.activeConversationId), before = h.sent().length, models = h.runner.calls.length
    const approved = await h.request('a', prepared.approvePath, prepared.body)
    assert.equal(approved.status, 200); assert(approved.body.receipt)
    const delivery = (await h.disk()).deliveries.find(item => item.actionId === prepared.action.id)
    assert.equal(delivery.status, 'delivered'); assert.equal(delivery.workId, prepared.child.id)
    assert.equal(h.sent().length, before + 1); assert.equal(h.injectedBusinessWrites, 1); assert.equal(h.runner.calls.length, models)
    const pending = (await h.channel.createWorkDelivery({ id: 'a' }, { workId: prepared.child.id, actionId: prepared.action.id, requestId: 'receipt-missing-context' })).delivery
    const context = await h.secrets.read(h.bot.contextRef)
    await h.secrets.write(h.bot.contextRef, {})
    const missing = await h.transports.sendDelivery(pending.id)
    assert.equal(missing.status, 'failed'); assert.equal(missing.error.code, 'WEIXIN_CONTEXT_UNAVAILABLE')
    assert.equal(h.sent().length, before + 1)
    await h.secrets.write(h.bot.contextRef, context)
    await receiptRevocation(h, prepared, () => h.sent().length)
  }

  async function receiptRevocation(h, prepared, sendCount) {
    const pending = (await h.channel.createWorkDelivery({ id: 'a' }, { workId: prepared.child.id, actionId: prepared.action.id, requestId: 'receipt-late-revoke' })).delivery
    const before = sendCount()
    h.beforeSendClaim = async () => {
      h.beforeSendClaim = undefined
      await h.store.update(state => ({ ...state, members: state.members.map(member => member.id === 'a' ? { ...member, employeeIds: ['agent-a'] } : member) }))
    }
    await assert.rejects(h.transports.sendDelivery(pending.id), { code: 'DELIVERY_FORBIDDEN' })
    assert.equal((await h.disk()).deliveries.find(item => item.id === pending.id).status, 'blocked')
    assert.equal(sendCount(), before); assert.equal(h.injectedBusinessWrites, 1)
  }

  async function webBoundary(h) {
    assert.equal(h.automationFlushes, 1, 'aggregate alone owns the first notification flush')
    const created = await h.request('a', '/api/conversations', { employeeId: 'agent-a' })
    assert.equal(created.status, 201)
    const path = `/api/conversations/${created.body.id}`, body = { text: 'SYNTHETIC_WEB', clientRequestId: 'web-one' }
    assert.equal((await h.request('a', path + '/turns', body)).status, 202)
    await until(async () => (await h.request('a', path)).body.turns[0]?.status === 'completed')
    assert.equal((await h.request('a', path + '/turns', body)).status, 200)
    assert.equal((await h.request('a', path + '/turns', { ...body, text: 'different' })).status, 409)
    assert.equal((await h.request('b', path)).status, 404)
    assert.equal((await h.request('admin', path)).status, 404)
    assert.equal(h.runner.calls.length, 1)
  }

  async function transportBoundary(h) {
    await h.bindFeishu('a')
    await h.feishuEvent('a', 'transport-feishu', 'SYNTHETIC_TRANSPORT')
    assert(h.entered.some(input => input.providerMessageId === 'transport-feishu'))
    assert((await h.disk()).channelMessages.some(item => item.providerMessageId === 'transport-feishu'))
    await h.startWeixin()
    h.simulator.push(h.bot.id, [h.message('transport-weixin')])
    await until(() => h.receipts.some(item => item.id === 'transport-weixin'))
    assert((await h.disk()).channelMessages.some(item => item.providerMessageId === 'transport-weixin'))
    assert(h.simulator.calls.some(call => call.botId === h.bot.id && call.endpoint.endsWith('/getupdates')))
    assert(h.platform.dispatcher instanceof Lark.EventDispatcher)
  }

  async function confirmation(h) {
    const pending = await h.linkFeishu('a')
    await h.feishuEvent('a', 'before-confirm', 'SYNTHETIC_PENDING')
    assert.equal(h.runner.calls.length, 0)
    assert((await h.disk()).channelMessages.some(item => item.providerMessageId === 'before-confirm' && ['unhandled', 'rejected'].includes(item.status)))
    await h.confirm('a', pending.id)
    await h.bindFeishu('b')
    const first = await h.active('a'), second = await h.active('b')
    assert.notEqual(first.id, second.id)
    await h.feishuEvent('a', 'owner-a', 'SYNTHETIC_A')
    await h.feishuEvent('b', 'owner-b', 'SYNTHETIC_B')
    await until(() => h.runner.calls.length === 2)
    assert.equal((await h.request('b', `/api/conversations/${first.id}`)).status, 404)
    assert.equal(h.runner.calls.some(call => call.text === 'SYNTHETIC_PENDING'), false, 'confirmation must not replay the pre-confirmation message')
  }

  async function idempotency(h) {
    await h.bindFeishu('a')
    await h.feishuEvent('a', 'stable-id', 'SYNTHETIC_ORIGINAL')
    await until(() => h.runner.calls.length === 1, 'C1 natural text did not reach conversation service')
    await h.feishuEvent('a', 'stable-id', 'SYNTHETIC_ORIGINAL')
    await h.feishuEvent('a', 'stable-id', 'SYNTHETIC_CHANGED')
    assert.equal(h.runner.calls.length, 1)
    const state = await h.disk()
    assert(state.channelMessages.some(item => JSON.stringify(item).includes('OFFICIAL_ID_CONFLICT')), 'official-ID conflict needs a durable disposition')
    assert.equal(state.conversations.flatMap(item => item.turns).filter(item => item.userText === 'SYNTHETIC_ORIGINAL').length, 1)
  }

  async function feishuDeliveryOutcomes(h) {
    await h.bindFeishu('a')
    const conversation = await h.active('a'), identity = await h.identity('a')
    const reply = await h.request('a', `/api/conversations/${conversation.id}/turns`, { text: 'SYNTHETIC_WEB_REPLY', clientRequestId: 'reply-from-web' })
    assert.equal(reply.status, 202)
    await until(async () => (await h.request('a', `/api/conversations/${conversation.id}`)).body.turns.at(-1)?.status === 'completed')
    assert.equal(h.platform.sent.length, 0, 'continuing old owner history does not automatically send to the platform')
    const body = { identityId: identity.id, conversationId: conversation.id, turnId: reply.body.turn.id, requestId: 'explicit-failed' }
    h.platform.queueSend({ code: 403 })
    const failed = await h.request('a', '/api/channels/deliveries', body)
    assert.equal(failed.status, 200); assert.equal(failed.body.delivery.status, 'failed')
    const retried = await h.request('a', `/api/channels/deliveries/${failed.body.delivery.id}/retry`, {})
    assert.equal(retried.status, 200); assert.equal(retried.body.status, 'delivered')
    h.platform.queueSend({ code: null })
    const unknown = await h.request('a', '/api/channels/deliveries', { ...body, requestId: 'explicit-unknown' })
    assert.equal(unknown.status, 200); assert.equal(unknown.body.delivery.status, 'unknown')
    const sends = h.platform.sent.length
    assert.equal((await h.request('a', `/api/channels/deliveries/${unknown.body.delivery.id}/retry`, {})).status, 409)
    assert.equal(h.platform.sent.length, sends)
    assert.equal(h.runner.calls.length, 1)
    assert.equal((await h.request('b', '/api/channels/deliveries', { ...body, requestId: 'wrong-owner' })).status, 404)
  }

  async function unknownReplyParent(h) {
    await h.bindFeishu('a')
    const before = await h.disk(), calls = h.runner.calls.length
    await h.feishuEvent('a', 'reply-unknown', '继续处理刚才的工作', 'unknown-platform-message')
    assert(h.entered.some(input => input.providerMessageId === 'reply-unknown' && input.replyToProviderMessageId === 'unknown-platform-message'))
    await assertRejectedReply(h, 'reply-unknown', before, calls)
    await h.feishuEvent('a', 'reply-unknown', '继续处理刚才的工作', 'unknown-platform-message')
    await assertRejectedReply(h, 'reply-unknown', before, calls)
    assert.equal((await h.disk()).channelMessages.filter(item => item.providerMessageId === 'reply-unknown').length, 1)
  }

  async function foreignReplyParent(h) {
    await h.bindFeishu('a'); await h.bindFeishu('b')
    await h.feishuEvent('b', 'parent-owner-b', 'SYNTHETIC_PRIVATE_B')
    const parent = await deliveredFeishuReply(h, 'parent-owner-b'), before = await h.disk(), calls = h.runner.calls.length
    for (const [index, parentId] of ['parent-owner-b', parent.providerMessageId].entries()) {
      await h.feishuEvent('a', `reply-foreign-${index}`, '继续处理刚才的工作', parentId)
      await assertRejectedReply(h, `reply-foreign-${index}`, before, calls)
    }
    assert.equal((await h.request('a', `/api/conversations/${parent.sourceRef.conversationId}`)).status, 404)
  }

  async function oldReplyParent(h) {
    await h.bindFeishu('a')
    await h.feishuEvent('a', 'parent-old', 'SYNTHETIC_OLD_REPLY_CONTEXT')
    const parent = await deliveredFeishuReply(h, 'parent-old'), old = await h.active('a')
    assert.equal((await h.request('admin', '/api/admin/channel-defaults', { defaultChannelEmployeeId: 'agent-b' }, 'PATCH')).status, 200)
    const beforeDefault = await h.disk(), calls = h.runner.calls.length
    await h.feishuEvent('a', 'reply-before-default-rotation', '继续处理刚才的工作', 'parent-old')
    await assertRejectedReply(h, 'reply-before-default-rotation', beforeDefault, calls)
    assert.equal((await h.active('a')).id, old.id, 'rejected parent cannot publish the lazy default rotation')
    await h.feishuEvent('a', 'fresh-default-context', 'SYNTHETIC_FRESH_DEFAULT')
    await deliveredFeishuReply(h, 'fresh-default-context')
    const next = await h.active('a')
    assert.notEqual(next.id, old.id)
    const identity = await h.identity('a')
    assert.equal((await h.request('a', `/api/channels/identities/${identity.id}/conversations`, {})).status, 201)
    const beforeOld = await h.disk(), rotatedCalls = h.runner.calls.length
    for (const [index, parentId] of ['parent-old', parent.providerMessageId].entries()) {
      await h.feishuEvent('a', `reply-old-${index}`, '继续处理刚才的工作', parentId)
      await assertRejectedReply(h, `reply-old-${index}`, beforeOld, rotatedCalls)
    }
  }

  async function currentReplyParent(h) {
    await h.bindFeishu('a')
    const conversation = await h.active('a')
    await h.feishuEvent('a', 'parent-current', 'SYNTHETIC_CURRENT_REPLY_CONTEXT')
    const parent = await deliveredFeishuReply(h, 'parent-current')
    for (const [index, parentId] of ['parent-current', parent.providerMessageId].entries()) {
      await h.feishuEvent('a', `reply-current-${index}`, 'SYNTHETIC_EXACT_PARENT', parentId)
      const reply = await deliveredFeishuReply(h, `reply-current-${index}`), state = await h.disk()
      const message = state.channelMessages.find(item => item.providerMessageId === `reply-current-${index}`)
      assert.equal(message.status, 'accepted')
      assert.equal(message.replyToProviderMessageId, parentId)
      assert.equal(message.memberConversationId, conversation.id)
      assert.equal(reply.sourceRef.conversationId, conversation.id)
    }
    assert.equal(h.runner.calls.length, 3)
    assert.equal((await h.active('a')).turns.length, 3)
    assert(h.runner.calls.every(call => call.conversationId === conversation.id))
  }

  async function deliveredFeishuReply(h, messageId) {
    let delivery
    await until(async () => {
      const state = await h.disk(), message = state.channelMessages.find(item => item.providerMessageId === messageId)
      delivery = state.deliveries.find(item => item.channelMessageId === message?.id && item.sourceRef?.kind === 'conversation-turn' && item.status === 'delivered')
      return Boolean(delivery)
    }, 'actual Feishu response did not publish the platform message ID')
    assert.match(delivery.providerMessageId, /^sent-\d+$/)
    return delivery
  }

  async function assertRejectedReply(h, id, before, calls) {
    const state = await h.disk(), message = state.channelMessages.find(item => item.providerMessageId === id)
    assert.equal(message?.status, 'rejected', 'a reply with no authorized current parent must be rejected')
    assert.equal(message.error?.code, 'CHANNEL_REPLY_INVALID')
    assert.match(message.error?.message, /Web/)
    assert.equal(message.turnId, undefined)
    assert.equal(h.runner.calls.length, calls, 'a rejected parent cannot start another model turn')
    assert.deepEqual(state.conversations, before.conversations, 'a rejected parent cannot create, rotate or append a turn')
    assert.deepEqual(state.channelIdentities, before.channelIdentities)
    const deliveries = state.deliveries.filter(item => item.channelMessageId === message.id && item.contentScope === 'fixed')
    assert.equal(deliveries.length, 1, 'this rejection needs its own fixed guide delivery')
    const delivery = deliveries[0]
    assert.equal(delivery.contentKey, 'help.reply-invalid')
    assert.equal(delivery.status, 'delivered')
    assert.match(delivery.providerMessageId, /^sent-\d+$/)
    // The simulated SDK assigns sent-N to the Nth captured create request.
    const sent = h.platform.sent[Number(delivery.providerMessageId.slice(5)) - 1]
    assert.equal(sent?.data.receive_id, message.providerConversationId)
    assert.equal(JSON.parse(sent.data.content).text, '引用消息无法用于当前会话，请到 Web 打开原对话，或发送一条新消息。')
  }

  async function inboxFailure(h) {
    const gate = deferred(), entered = deferred()
    h.beforeInbox = async () => { h.beforeInbox = undefined; entered.resolve(); await gate.promise; throw new Error('SYNTHETIC_INBOX_FAILURE') }
    await h.startWeixin()
    const cursor = h.simulator.push(h.bot.id, [h.message('failed-inbox')])
    try {
      await entered.promise
      assert.equal(await h.secrets.read(h.bot.cursorRef), '')
      assert.equal((await h.disk()).channelMessages.some(item => item.providerMessageId === 'failed-inbox'), false)
    } finally { gate.resolve() }
    await until(() => h.receipts.some(item => item.id === 'failed-inbox'))
    assertReceipt(h.receipts.at(-1).value)
    await until(async () => await h.secrets.read(h.bot.cursorRef) === cursor)
    assert.equal((await h.disk()).channelMessages.filter(item => item.providerMessageId === 'failed-inbox').length, 1)
  }

  async function cursorFailure(h) {
    let failedWrite = false
    const original = h.secrets.write
    h.secrets.write = async (ref, value) => {
      if (ref === h.bot.cursorRef && value && !failedWrite) { failedWrite = true; throw new Error('SYNTHETIC_CURSOR_FAILURE') }
      return original(ref, value)
    }
    await h.startWeixin()
    const cursor = h.simulator.push(h.bot.id, [h.message('cursor-replay')])
    await until(() => h.receipts.length > 0)
    assertReceipt(h.receipts[0].value)
    assert.equal(h.receipts[0].value.status, 'accepted')
    await until(async () => await h.secrets.read(h.bot.cursorRef) === cursor)
    assert(failedWrite)
    assert.equal((await h.disk()).channelMessages.filter(item => item.providerMessageId === 'cursor-replay').length, 1)
    assert.equal(h.runner.calls.filter(item => item.text === 'SYNTHETIC_WEIXIN').length, 1)
    assert(h.simulator.calls.filter(call => call.botId === h.bot.id && call.endpoint.endsWith('/getupdates')).length >= 2)
  }

  async function restartInbox(h) {
    let admissionFailed = false
    h.beforeTurnAdmission = async () => { admissionFailed = true; throw new Error('SYNTHETIC_ADMISSION_COMMIT_FAILURE') }
    await h.startWeixin()
    const cursor = h.simulator.push(h.bot.id, [h.message('restart-inbox')])
    await until(() => {
      if (admissionFailed) return true
      const receipt = h.receipts.find(item => item.id === 'restart-inbox')?.value
      assert(!receipt, `restart-inbox did not reach turn-admission hook: ${receipt?.status ?? 'unknown'}/${receipt?.code ?? 'no-code'}`)
      return false
    }, 'restart-inbox turn-admission hook was not reached')
    await h.weixinChannel.close()
    await h.conversation.close()
    const before = await h.disk(), reserved = before.channelMessages.find(item => item.providerMessageId === 'restart-inbox')
    assert.equal(reserved.status, 'reserved')
    assert.equal(before.conversations.flatMap(item => item.turns).length, 0)
    assert.equal(await h.secrets.read(h.bot.cursorRef), '')
    const store = createFileStore(h.statePath), runner = syntheticRunner(), conversation = createConversationService({ store, runner }), receipts = []
    const channel = createChannelService({ store, conversationService: conversation })
    const runtime = weixin.createWeixinChannelRuntime({ store, channelService: { ...channel, async handleInbound(input) { const value = await channel.handleInbound(input); receipts.push(value); return value } }, secrets: h.secrets,
      api: createWeixinApi({ testMode: true, testBaseUrl: h.simulator.url, timeoutMs: 100, longPollTimeoutMs: 150 }), reconnectDelayMs: 10,
    })
    try {
      await conversation.ensureReady()
      await channel.recover()
      await runtime.start()
      await until(() => receipts.length > 0, 'same real iLink batch must replay after the process services restart')
      assert.equal(receipts[0].status, 'rejected')
      assert.equal(receipts[0].code, 'CHANNEL_RECOVERY_INTERRUPTED')
      await until(async () => await h.secrets.read(h.bot.cursorRef) === cursor)
      assert.equal(runner.calls.length, 0)
      assert.equal(h.runner.calls.length, 0)
      const disk = await h.disk()
      assert.equal(disk.channelMessages.filter(item => item.providerMessageId === 'restart-inbox').length, 1)
      assert.equal(disk.conversations.flatMap(item => item.turns).length, 0)
      assert.equal(disk.channelMessages.find(item => item.id === reserved.id).status, 'rejected')
    } finally { await runtime.close(); await conversation.close() }
  }

  async function cancelledLogin(h) {
    // Candidate C1 names are intentionally executable failures until the single writer supplies the seam.
    await h.startWeixin()
    h.simulator.queueLogin({ value: h.simulator.confirmedLogin(h.bot.id), delayMs: 80 })
    const begun = await h.request('a', '/api/channels/weixin/bindings', { channelAppId: weixinAppId })
    assert.equal(begun.status, 201, 'C1 Weixin binding HTTP entry is not implemented')
    const id = begun.body.id
    await until(() => h.simulator.calls.some(call => call.endpoint.endsWith('/get_qrcode_status')))
    const cancelled = await h.request('a', `/api/channels/weixin/bindings/${id}`, {}, 'DELETE')
    assert.equal(cancelled.status, 200)
    await delay(100)
    assert.equal((await h.disk()).channelIdentities.some(item => item.channelAppId === weixinAppId && item.status === 'active' && item.id !== 'wx-fixture'), false)
    assert.equal((await h.disk()).linkCodes.find(item => item.id === id)?.status, 'cancelled')
    assert.equal((await h.request('b', `/api/channels/link-codes/${id}/confirm`, {})).status, 404)
  }

  async function expiredCredentials(h) {
    await h.startWeixin()
    h.simulator.queuePoll(h.bot.id, { ret: -14 })
    await until(async () => (await h.disk()).channelIdentities.find(item => item.id === 'wx-fixture').status === 'rebind-required')
    await until(() => h.simulator.activePolls(h.bot.id) === 0)
    const count = () => h.simulator.calls.filter(call => call.botId === h.bot.id && call.endpoint.endsWith('/getupdates')).length
    const before = count()
    assert.equal((await h.request('admin', `/api/admin/channel-apps/${weixinAppId}`, { enabled: false }, 'PATCH')).status, 200)
    assert.equal((await h.request('admin', `/api/admin/channel-apps/${weixinAppId}`, { enabled: true }, 'PATCH')).status, 200)
    const identity = (await h.disk()).channelIdentities.find(item => item.id === 'wx-fixture')
    assert.equal(identity.status, 'rebind-required')
    assert.equal(identity.activeConversationId, null)
    assert.equal(identity.weixin.runtimeState, 'unavailable')
    assert.equal(identity.weixin.error.code, 'WEIXIN_STALE_TOKEN')
    assert.equal((await h.disk()).channelApps.find(item => item.id === weixinAppId).status, 'active', 'mounted protocol must allow a new explicit scan after app enable')
    await h.weixinChannel.close()
    const store = createFileStore(h.statePath), channel = createChannelService({ store })
    const runtime = weixin.createWeixinChannelRuntime({ store, channelService: channel, secrets: h.secrets,
      api: createWeixinApi({ testMode: true, testBaseUrl: h.simulator.url, timeoutMs: 100, longPollTimeoutMs: 150 }), reconnectDelayMs: 10,
    })
    try {
      await runtime.start(); await runtime.sync(); await delay(90)
      assert.equal(count(), before, 'same expired credential cannot silently resume in a new runtime')
      assert.equal(h.runner.calls.length, 0)
      assert.equal((await h.disk()).channelIdentities.find(item => item.id === identity.id).weixin.error.code, 'WEIXIN_STALE_TOKEN')
    } finally { await runtime.close() }
  }

  async function rotation(h) {
    await h.bindFeishu('a')
    const old = await h.active('a'), identity = await h.identity('a')
    await h.feishuEvent('a', 'before-rotation', 'SYNTHETIC_OLD_CONTEXT')
    await until(() => h.runner.calls.length === 1)
    await h.feishuEvent('a', 'rotate-command', '新会话')
    const next = await h.active('a')
    assert.notEqual(next.id, old.id)
    assert.equal((await h.identity('a')).revision, identity.revision)
    assert.deepEqual(next.turns, [])
    const continued = await h.request('a', `/api/conversations/${old.id}/turns`, { text: 'SYNTHETIC_WEB_CONTINUE', clientRequestId: 'continue-old' })
    assert.equal(continued.status, 202)
    await until(() => h.runner.calls.length === 2)
    assert.equal((await h.identity('a')).activeConversationId, next.id)
    const switched = await h.request('a', `/api/channels/identities/${identity.id}/conversations`, { employeeId: 'agent-b' })
    assert.equal(switched.status, 201)
    assert.equal((await h.active('a')).employeeId, 'agent-b')
  }

  async function channelDefaults(h) {
    await h.bindFeishu('a'); await h.bindFeishu('b', 'agent-a')
    const old = await h.active('a'), explicit = await h.active('b')
    await h.feishuEvent('a', 'default-before', 'SYNTHETIC_OLD_DEFAULT')
    await until(async () => (await h.disk()).conversations.find(item => item.id === old.id).turns.at(-1)?.status === 'completed')
    assert.equal((await h.request('admin', '/api/admin/channel-defaults', { defaultChannelEmployeeId: 'agent-b' }, 'PATCH')).status, 200)
    await h.feishuEvent('a', 'default-after', 'SYNTHETIC_NEW_DEFAULT')
    const next = await h.active('a')
    assert.notEqual(next.id, old.id); assert.equal(next.employeeId, 'agent-b')
    await until(() => h.runner.calls.length === 2)
    assert.equal(h.runner.calls[1].sessionId, null, 'new default gets no old native context')
    await h.feishuEvent('b', 'explicit-default', 'SYNTHETIC_EXPLICIT_DEFAULT')
    assert.equal((await h.active('b')).id, explicit.id)
    assert.equal((await h.active('b')).employeeId, 'agent-a')
    await until(() => h.runner.calls.length === 3)
    assert(h.platform.sent.some(call => JSON.parse(call.data.content).text.includes('默认员工已变更，已开启新会话')))
    assert.equal((await h.request('admin', '/api/admin/channel-defaults', { defaultChannelEmployeeId: null }, 'PATCH')).status, 200)
    await h.feishuEvent('a', 'missing-default', 'SYNTHETIC_NO_FALLBACK')
    assert.equal((await h.active('a')).id, next.id)
    assert.equal((await h.disk()).channelMessages.find(item => item.providerMessageId === 'missing-default').error.code, 'CHANNEL_DEFAULT_REQUIRED')
    assert.equal(h.runner.calls.length, 3)
    assert.equal((await h.request('admin', '/api/admin/channel-defaults', { defaultChannelEmployeeId: 'agent-b' }, 'PATCH')).status, 200)
    await h.store.update(state => ({ ...state, members: state.members.map(member => member.id === 'a' ? { ...member, employeeIds: ['agent-a'] } : member) }))
    await h.feishuEvent('a', 'unauthorized-default', 'SYNTHETIC_UNAUTHORIZED_DEFAULT')
    assert.equal((await h.disk()).channelMessages.find(item => item.providerMessageId === 'unauthorized-default').error.code, 'CHANNEL_DEFAULT_REQUIRED')
    assert.equal(h.runner.calls.length, 3)
  }

  async function busyDefaultChange(h) {
    await h.bindFeishu('a')
    const old = await h.active('a'), release = h.runner.holdNext()
    try {
      await h.feishuEvent('a', 'busy-first', 'SYNTHETIC_ACTIVE_REPLY')
      await until(() => h.runner.calls.length === 1)
      assert.equal((await h.request('admin', '/api/admin/channel-defaults', { defaultChannelEmployeeId: 'agent-b' }, 'PATCH')).status, 200)
      await h.feishuEvent('a', 'busy-new-default', 'SYNTHETIC_DURABLE_BUSY')
      assert.equal((await h.disk()).channelMessages.find(item => item.providerMessageId === 'busy-new-default').error.code, 'CHANNEL_BUSY')
      assert.equal((await h.active('a')).id, old.id)
    } finally { release() }
    await until(async () => (await h.disk()).conversations.find(item => item.id === old.id).turns.at(-1)?.status === 'completed')
    assert.equal(h.runner.calls.length, 1, 'busy text is not queued when the old reply completes')
    await h.feishuEvent('a', 'busy-explicit-resend', 'SYNTHETIC_EXPLICIT_RESEND')
    assert.equal((await h.active('a')).employeeId, 'agent-b')
    assert.notEqual((await h.active('a')).id, old.id)
    await until(() => h.runner.calls.length === 2)
    assert.equal(h.runner.calls.some(call => call.text === 'SYNTHETIC_DURABLE_BUSY'), false)
  }

  async function partialUnknown(h) {
    const deliveryId = await h.prepareWeixinDelivery()
    h.simulator.queueSend(h.bot.id, { ret: 0 }, { drop: true })
    const result = await h.weixinChannel.sendDelivery(deliveryId)
    assert.equal(result.status, 'unknown')
    assert.equal(result.sendProgress.acknowledgedParts.length, 1)
    const delivery = (await h.disk()).deliveries.find(item => item.id === deliveryId)
    assert.equal(delivery.status, 'unknown')
    const count = h.sent().length
    assert.equal((await h.request('a', `/api/channels/deliveries/${delivery.id}/retry`, {})).status, 409)
    assert.equal(h.sent().length, count)
  }

  async function segmentRevocation(h) {
    const deliveryId = await h.prepareWeixinDelivery()
    h.afterProgress = async progress => {
      if (progress.status === 'sending') await h.store.update(state => ({ ...state, members: state.members.map(member => member.id === 'a' ? { ...member, employeeIds: [] } : member) }))
    }
    const result = await h.weixinChannel.sendDelivery(deliveryId)
    assert.equal(result.status, 'blocked')
    assert.equal(result.sendProgress.acknowledgedParts.length, 1)
    assert.equal(h.sent().length, 1, 'revocation after the first segment must prevent the next network send')
  }

  async function relink(h) {
    await h.bindFeishu('a')
    const old = await h.identity('a')
    assert.equal((await h.request('a', `/api/channels/identities/${old.id}`, {}, 'DELETE')).status, 200)
    await h.bindFeishu('a')
    const current = await h.identity('a')
    assert.notEqual(current.id, old.id, 'relink must create a new identity')
    assert.notEqual(current.activeConversationId, old.activeConversationId)
    assert.equal((await h.disk()).channelIdentities.find(item => item.id === old.id).status, 'unlinked')
  }

  async function notificationIdentity(h) {
    const rule = (await h.disk()).automationRules.find(item => item.id === 'legacy-notification')
    assert.equal(rule.notificationIdentityId, 'notification-owner', 'legacy endpoint must migrate only to its unique original identity')
    const rotated = await h.request('b', '/api/channels/identities/notification-owner/conversations', { employeeId: 'agent-b' })
    assert.equal(rotated.status, 201, `notification rotation: ${JSON.stringify(rotated.body)}`)
    assert.equal((await h.disk()).automationRules[0].notificationIdentityId, 'notification-owner')
    const unlinked = await h.request('b', '/api/channels/identities/notification-owner', {}, 'DELETE')
    assert.equal(unlinked.status, 200, `notification unlink: ${JSON.stringify(unlinked.body)}`)
    await h.bindFeishu('b', 'agent-b')
    assert.notEqual((await h.identity('b')).id, 'notification-owner')
    assert.equal((await h.disk()).automationRules[0].notificationIdentityId, 'notification-owner')
    assert.equal(h.platform.sent.some(call => call.data.receive_id !== 'chat-b'), false)
  }

  async function restoreWeixin(h) {
    await h.startWeixin()
    h.simulator.push(h.bot.id, [h.message('restore-delivered')])
    await until(async () => (await h.disk()).deliveries.some(delivery => delivery.status === 'delivered' && delivery.contentKey === 'conversation.reply'))
    const unknownId = await h.prepareWeixinDelivery()
    h.simulator.queueSend(h.bot.id, { ret: 0 }, { drop: true })
    assert.equal((await h.weixinChannel.sendDelivery(unknownId)).status, 'unknown')
    const qr = await h.request('b', '/api/channels/weixin/bindings', { channelAppId: weixinAppId })
    assert.equal(qr.status, 201)
    await h.transports.close()
    await until(() => h.simulator.activePolls(h.bot.id) === 0)
    const source = await h.disk(), secretRoot = join(h.root, 'secrets'), dshHome = join(h.root, 'dsh')
    const pending = source.linkCodes.find(link => link.id === qr.body.id)
    for (const key of ['tokenRef', 'cursorRef', 'contextRef']) assert.equal(await absent(join(secretRoot, pending[key])), true, 'unconfirmed QR login has no account secrets yet')
    // This runner is the synthetic model boundary; transfer still reads actual associated files.
    const sessions = source.conversations.flatMap(conversation => conversation.sessions.map(session => session.id))
    for (const session of await h.runner.readChatHistory(sessions)) {
      const directory = join(dshHome, 'sessions', 'fixture', session.sessionId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, 'session.v3.jsonl'), session.events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 })
    }
    await writeFile(join(secretRoot, source.modelRoutes[0].credentialRef), 'SYNTHETIC_MODEL_CREDENTIAL', { mode: 0o600 })
    const backup = join(h.root, 'backup'), secretPackage = join(h.root, 'private-backup')
    const run = args => runStateTransfer(args, { statePath: h.statePath, dshHome, modelCredentialRef: 'ZENMUX_API_KEY' })
    const backed = await run(['backup', '--output', backup, '--secret-output', secretPackage, '--secret-root', secretRoot])
    assert.equal(backed.code, 0, backed.stderr)
    const privateManifest = JSON.parse(await readFile(join(secretPackage, 'manifest.json'), 'utf8'))
    assert(privateManifest.entries.some(entry => entry.path === `secrets/${pending.loginRef}`))
    for (const key of ['tokenRef', 'cursorRef', 'contextRef']) assert.equal(privateManifest.entries.some(entry => entry.path === `secrets/${pending[key]}`), false)
    const before = h.simulator.calls.length
    for (const paired of [true, false]) {
      const dataRoot = join(h.root, paired ? 'paired-restore' : 'ordinary-restore'), restoredSecrets = join(h.root, paired ? 'paired-secrets' : 'missing-secrets')
      const result = await run(['restore', '--input', backup, '--data-root', dataRoot, ...(paired ? ['--secret-input', secretPackage, '--secret-root', restoredSecrets] : [])])
      assert.equal(result.code, 0, result.stderr)
      const store = createFileStore(join(dataRoot, 'state.json')), restored = await store.read(), identity = restored.channelIdentities.find(item => item.id === 'wx-fixture')
      assert.equal(identity.status, 'rebind-required'); assert.equal(identity.activeConversationId, null)
      assert.equal(identity.unlinkedAt, undefined, 'recovery is not a user unbind')
      assert.equal(identity.weixin.runtimeState, 'unavailable'); assert.equal(identity.weixin.error.code, 'RESTORE_REBIND_REQUIRED')
      assert.equal(restored.channelConversations.find(endpoint => endpoint.identityId === identity.id).status, 'rebind-required')
      assert(restored.channelApps.every(app => app.enabled === false))
      assert.deepEqual(restored.conversations, source.conversations, 'completed member history and native lineage survive exactly')
      for (const delivery of source.deliveries) assert.deepEqual(restored.deliveries.find(item => item.id === delivery.id), delivery, 'delivered/unknown and segment ACK facts survive exactly')
      assert.equal(restored.linkCodes.find(link => link.id === pending.id).status, 'cancelled')
      assert.equal(restored.linkCodes.find(link => link.id === pending.id).error.code, 'RESTORE_BINDING_CLOSED')
      if (paired) assert.deepEqual(await readFile(join(restoredSecrets, identity.weixin.cursorRef)), await readFile(join(secretRoot, identity.weixin.cursorRef)))
      const channel = createChannelService({ store }), runtime = weixin.createWeixinChannelRuntime({ store, channelService: channel, secrets: createChannelSecretStore(restoredSecrets),
        api: createWeixinApi({ testMode: true, testBaseUrl: h.simulator.url, timeoutMs: 100, longPollTimeoutMs: 150 }), loginPollMs: 10, reconnectDelayMs: 10,
      })
      try {
        await runtime.start()
        // Admin enable restores the module, never the unverifiable old owner account.
        await channel.upsertChannelApp({ id: 'admin' }, { id: weixinAppId, enabled: true })
        await runtime.sync(); await delay(90)
        assert.equal(h.simulator.calls.length, before, 'restored token/QR/cursor must not start any protocol request')
        assert.equal((await store.read()).channelIdentities.find(item => item.id === identity.id).status, 'rebind-required')
        if (!paired) assert.equal(await absent(restoredSecrets), true, 'missing secret root is not probed or created')
      } finally { await runtime.close() }
    }
  }

  async function transferCopies() {
    const h = await transferFixture()
    try {
      const result = await h.backup('paired', true)
      assert.equal(result.code, 0, result.stderr)
      const normal = await readFile(join(h.root, 'paired', 'state.json')), manifest = JSON.parse(await readFile(join(h.root, 'paired-private', 'manifest.json'), 'utf8'))
      assert.notEqual(digest(normal), digest(h.source), 'backup interrupts its own snapshot without changing the live state')
      assert.equal(manifest.stateSha256, digest(normal), 'pairing must use the final backup bytes, not the live-source hash')
      assert.deepEqual(manifest.entries.map(entry => entry.path), ['secrets/fixture-channel', 'secrets/manifest.json'])
      assert.deepEqual(await readdir(join(h.root, 'paired')), ['manifest.json', 'state.json'])
      assert.equal(normal.includes(Buffer.from('SYNTHETIC_PRIVATE_VALUE')), false)
      assert.equal((await readFile(join(h.root, 'paired', 'manifest.json'), 'utf8')).includes('geneway-secret-transfer'), false)
      assert.deepEqual(await readFile(h.statePath), h.source)
      const restored = await h.run(['restore', '--input', join(h.root, 'paired'), '--data-root', join(h.root, 'restored'), '--secret-input', join(h.root, 'paired-private'), '--secret-root', join(h.root, 'restored-private')])
      assert.equal(restored.code, 0, restored.stderr)
      assert.equal((await lstat(join(h.root, 'restored-private'))).mode & 0o777, 0o700)
      for (const ref of ['fixture-channel', 'manifest.json']) {
        assert.equal((await lstat(join(h.root, 'restored-private', ref))).mode & 0o777, 0o600)
        assert.deepEqual(await readFile(join(h.root, 'restored-private', ref)), await readFile(join(h.secretRoot, ref)))
      }
      assert.equal((await readFile(join(h.root, 'restored-private', 'unreferenced')).catch(error => error.code)), 'ENOENT')
      assert.equal(JSON.parse(await readFile(join(h.root, 'restored', 'state.json'), 'utf8')).channelApps[0].enabled, false)
      await chmod(h.secretRoot, 0o000)
      assert.equal((await h.backup('ordinary-only', false)).code, 0, 'ordinary backup must never inspect the secret root')
      assert.equal((await h.run(['restore', '--input', join(h.root, 'ordinary-only'), '--data-root', join(h.root, 'ordinary-restore')])).code, 0)
      const legacy = JSON.parse(normal), legacyRoot = join(h.root, 'legacy-v9')
      legacy.version = 9; delete legacy.defaultChannelEmployeeId
      const bytes = Buffer.from(JSON.stringify(legacy) + '\n'), ordinaryManifest = JSON.parse(await readFile(join(h.root, 'paired', 'manifest.json'), 'utf8'))
      ordinaryManifest.schema.stateVersion = 9
      ordinaryManifest.entries = [{ path: 'state.json', bytes: bytes.length, sha256: digest(bytes) }]
      await mkdir(legacyRoot, { mode: 0o700 }); await writeFile(join(legacyRoot, 'state.json'), bytes, { mode: 0o600 })
      await writeFile(join(legacyRoot, 'manifest.json'), JSON.stringify(ordinaryManifest), { mode: 0o600 })
      const legacyResult = await h.run(['restore', '--input', legacyRoot, '--data-root', join(h.root, 'legacy-v9-restored')])
      assert.equal(legacyResult.code, 0, legacyResult.stderr)
      assert.equal(JSON.parse(await readFile(join(h.root, 'legacy-v9-restored', 'state.json'), 'utf8')).version, STATE_VERSION)
    } finally { await h.close() }
  }

  async function transferRejects() {
    const h = await transferFixture()
    try {
      const rejectBackup = async name => {
        const result = await h.backup(name, true)
        assert.notEqual(result.code, 0)
        assert.equal(await absent(join(h.root, name)), true)
        assert.equal(await absent(join(h.root, `${name}-private`)), true)
      }
      await chmod(h.secretRoot, 0o755); await rejectBackup('unsafe-root'); await chmod(h.secretRoot, 0o700)
      await chmod(join(h.secretRoot, 'fixture-channel'), 0o640); await rejectBackup('unsafe-file'); await chmod(join(h.secretRoot, 'fixture-channel'), 0o600)
      await rm(join(h.secretRoot, 'fixture-channel')); await symlink(join(h.secretRoot, 'manifest.json'), join(h.secretRoot, 'fixture-channel'))
      await rejectBackup('symlink-file'); await rm(join(h.secretRoot, 'fixture-channel')); await writeFile(join(h.secretRoot, 'fixture-channel'), 'SYNTHETIC_PRIVATE_VALUE_CHANNEL', { mode: 0o600 })
      assert.notEqual((await h.run(['backup', '--output', join(h.root, 'missing-flag'), '--secret-output', join(h.root, 'missing-private')])).code, 0)
      assert.equal(await absent(join(h.root, 'missing-flag')), true)
      assert.notEqual((await h.run(['backup', '--output', join(h.root, 'empty-flags'), '--secret-output', '', '--secret-root', ''])).code, 0)
      assert.equal(await absent(join(h.root, 'empty-flags')), true)
      assert.equal((await h.backup('valid', true)).code, 0)
      const privateRoot = join(h.root, 'valid-private'), manifestPath = join(privateRoot, 'manifest.json'), original = await readFile(manifestPath)
      const rejectRestore = async name => {
        const result = await h.run(['restore', '--input', join(h.root, 'valid'), '--data-root', join(h.root, name), '--secret-input', privateRoot, '--secret-root', join(h.root, `${name}-private`)])
        assert.notEqual(result.code, 0)
        assert.equal(await absent(join(h.root, name)), true)
        assert.equal(await absent(join(h.root, `${name}-private`)), true)
      }
      for (const [name, change] of [
        ['wrong-pair', value => { value.stateSha256 = '0'.repeat(64) }],
        ['missing-ref', value => { value.entries.pop() }],
        ['duplicate-ref', value => { value.entries.push(value.entries[0]) }],
        ['traversal', value => { value.entries[0].path = '../fixture-channel' }],
      ]) {
        const value = JSON.parse(original); change(value); await writeFile(manifestPath, JSON.stringify(value)); await rejectRestore(name)
      }
      await writeFile(manifestPath, original)
      await writeFile(join(privateRoot, 'secrets', 'fixture-channel'), 'SYNTHETIC_TAMPER')
      await rejectRestore('tampered')
      await writeFile(join(privateRoot, 'secrets', 'fixture-channel'), await readFile(join(h.secretRoot, 'fixture-channel')))
      await chmod(privateRoot, 0o755); await rejectRestore('unsafe-package'); await chmod(privateRoot, 0o700)
      await chmod(manifestPath, 0o644); await rejectRestore('unsafe-manifest'); await chmod(manifestPath, 0o600)
      await mkdir(join(h.root, 'unsafe-target-private'), { mode: 0o755 })
      const unsafe = await h.run(['restore', '--input', join(h.root, 'valid'), '--data-root', join(h.root, 'unsafe-target'), '--secret-input', privateRoot, '--secret-root', join(h.root, 'unsafe-target-private')])
      assert.notEqual(unsafe.code, 0); assert.equal(await absent(join(h.root, 'unsafe-target')), true)
      assert.equal((await lstat(join(h.root, 'unsafe-target-private'))).mode & 0o777, 0o755, 'do not chmod somebody else\'s directory')
    } finally { await h.close() }
  }

  async function transferSnapshotRace() {
    const h = await transferFixture()
    try {
      const preload = join(h.root, 'state-race.mjs'), changed = JSON.parse(h.source), marker = join(h.root, 'gate-entered')
      changed.members[0].displayName = 'SYNTHETIC_CHANGED_DURING_BACKUP'
      await writeFile(preload, `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
  const original = fs.open; let once = false;
  fs.open = async (path, ...args) => { const handle = await original(path, ...args);
  if (!once && path === ${JSON.stringify(join(h.secretRoot, 'fixture-channel'))}) { once = true;
  await fs.writeFile(${JSON.stringify(marker)}, 'entered');
  await fs.writeFile(${JSON.stringify(h.statePath + '.race')}, ${JSON.stringify(JSON.stringify(changed))});
  await fs.rename(${JSON.stringify(h.statePath + '.race')}, ${JSON.stringify(h.statePath)}); }
  return handle; }; syncBuiltinESMExports();`)
      const result = await h.backup('raced', true, preload)
      assert.notEqual(result.code, 0)
      assert(result.stderr.includes('产品状态已变化'))
      assert.equal(await readFile(marker, 'utf8'), 'entered', 'real secret-file open must enter the race gate')
      assert.equal(await absent(join(h.root, 'raced')), true)
      assert.equal(await absent(join(h.root, 'raced-private')), true)
      const denyRename = join(h.root, 'publish-failure.mjs')
      await writeFile(denyRename, `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
  const original = fs.rename;
  fs.rename = async (source, target) => { if (target === ${JSON.stringify(join(h.root, 'partial-private'))} || target === ${JSON.stringify(join(h.root, 'restored-private'))}) throw new Error('SYNTHETIC_RENAME_FAILURE'); return original(source, target); }; syncBuiltinESMExports();`)
      const partial = await h.backup('partial', true, denyRename)
      assert.notEqual(partial.code, 0); assert(partial.stderr.includes('普通备份已写入，秘密包未完成'))
      assert.equal(await absent(join(h.root, 'partial', 'state.json')), false)
      assert.equal(await absent(join(h.root, 'partial-private')), true)
      assert.equal((await h.backup('restore-source', true)).code, 0)
      const restored = await h.run(['restore', '--input', join(h.root, 'restore-source'), '--data-root', join(h.root, 'restored'), '--secret-input', join(h.root, 'restore-source-private'), '--secret-root', join(h.root, 'restored-private')], denyRename)
      assert.notEqual(restored.code, 0); assert(restored.stderr.includes('产品状态已恢复且外部收发关闭，秘密恢复未完成'))
      assert.equal(JSON.parse(await readFile(join(h.root, 'restored', 'state.json'), 'utf8')).channelApps[0].enabled, false)
      assert.equal(await absent(join(h.root, 'restored-private')), true)
    } finally { await h.close() }
  }

  async function transferFixture() {
    const root = await mkdtemp(join(tmpdir(), 'geneway-channel-transfer-')), statePath = join(root, 'state.json'), secretRoot = join(root, 'secrets')
    await mkdir(secretRoot, { mode: 0o700 })
    const store = createFileStore(statePath), definition = { employeeRevision: 1, instructions: 'synthetic', modelRouteId: 'fixture-model' }
    await store.update(state => ({ ...seed(state), channelApps: [{ id: 'feishu', provider: 'feishu', providerAppId: appId, providerTenantId: 'fixture-tenant', credentialRef: 'fixture-channel', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }],
      modelRoutes: [{ id: 'fixture-model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', enabled: true, credentialRef: 'manifest.json' }],
      conversations: [{ id: 'snapshot-active', ownerMemberId: 'a', employeeId: 'agent-a', employeeName: 'agent-a', title: 'synthetic', source: 'web', channelIdentityId: null, createdAt: now, updatedAt: now, archivedAt: null, sessions: [],
        turns: [{ id: 'snapshot-turn', clientRequestId: 'snapshot-request', userText: 'SYNTHETIC_ACTIVE', status: 'accepted', createdAt: now, startedAt: null, completedAt: null, error: null, definition, definitionFingerprint: digest(JSON.stringify(definition)), sessionId: null, userMessageId: null, assistantMessageIds: [] }],
      }],
    }))
    for (const ref of ['manifest.json', 'fixture-channel', 'unreferenced']) await writeFile(join(secretRoot, ref), `SYNTHETIC_PRIVATE_VALUE_${ref}`, { mode: 0o600 })
    const run = (args, preload) => runStateTransfer(args, { statePath, dshHome: join(root, 'dsh'), preload })
    return { root, statePath, secretRoot, source: await readFile(statePath), run,
      backup: (name, includeSecrets, preload) => run(['backup', '--output', join(root, name), ...(includeSecrets ? ['--secret-output', join(root, `${name}-private`), '--secret-root', secretRoot] : [])], preload),
      async close() { await chmod(secretRoot, 0o700); await rm(root, { recursive: true, force: true }) },
    }
  }
  function runStateTransfer(args, { statePath, dshHome, preload, modelCredentialRef } = {}) {
    transferProcesses += 1
    return new Promise((resolve, reject) => {
      const child = spawnOwner(process.execPath, [...(preload ? ['--import', preload] : []), fileURLToPath(new URL('./state-transfer.mjs', import.meta.url)), ...args], { env: { ...process.env, GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: dshHome, GENEWAY_SECRET_ROOT: join(dshHome, 'must-never-probe'), ...(modelCredentialRef === undefined ? {} : { GENEWAY_MODEL_CREDENTIAL_REF: modelCredentialRef }) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }))
    })
  }
  async function absent(path) { try { await lstat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error } }

  async function fixture(options = {}) {
    const root = await mkdtemp(join(tmpdir(), 'geneway-channel-conversations-')), secretRoot = join(root, 'secrets')
    await mkdir(secretRoot, { mode: 0o700 })
    const h = { root, entered: [], receipts: [], beforeInbox: undefined, afterProgress: undefined }
    let service, conversation, channel, feishu, server, origin, closed = false
    h.close = async () => {
      if (closed) return
      closed = true
      const outcomes = await Promise.allSettled([() => h.transports ? h.transports.close() : Promise.all([h.weixinChannel?.close(), feishu?.close()]), () => conversation?.close(), () => service?.close()].map(close => close()))
      if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
      try { await h.simulator?.close() } finally {
        if (h.bot) await rm(join('/tmp', `geneway-weixin-${process.getuid()}`, digest(h.bot.id)), { recursive: true, force: true })
        await rm(root, { recursive: true, force: true })
      }
      origins.delete(origin)
      if (h.simulator) { origins.delete(new URL(h.simulator.url).origin); assert.deepEqual(h.simulator.failures, []) }
      const failures = outcomes.filter(outcome => outcome.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), 'fixture cleanup failed')
      if (h.runtimeStarted) assert.equal(h.recoveries, 2, 'aggregate recovers once before intake and once after both transports stop')
    }
    try {
    const stateFile = h.statePath = join(root, 'state.json'), backing = createFileStore(stateFile)
    const store = h.store = { read: () => backing.read(), update: (mutate, options) => backing.update(async state => {
      const next = await mutate(state)
      if (h.beforeInbox && next.channelMessages.length > state.channelMessages.length) await h.beforeInbox()
      if (h.beforeTurnAdmission && next.conversations.some(conversation => conversation.turns.length > (state.conversations.find(item => item.id === conversation.id)?.turns.length ?? 0))) await h.beforeTurnAdmission()
      return next
    }, options) }
    const runner = h.runner = syntheticRunner()
    const connectionCatalog = options.receipt ? [receiptConnection] : []
    service = h.workService = createWorkService({ store, runner: { configured: false }, collaborationRunner: options.receipt ? { ...runner, async run() {} } : runner,
      connectionCatalog, ...(options.receipt ? { clock: () => receiptNow } : {}), policyPaths: { stateFile, dataRoot: root, secretRoot } })
    conversation = h.conversation = createConversationService({ store, runner, onTurnTerminal: async ref => {
      const created = await channel.ensureConversationDeliveries(ref)
      for (const delivery of created.deliveries) if (delivery.status === 'pending') {
        try { await h.transports.sendDelivery(delivery.id) } catch (error) { if (!['INVALID_STATE', 'DELIVERY_FORBIDDEN'].includes(error?.code)) throw error }
      }
    } })
    channel = h.channel = createChannelService({ store, workService: service, conversationService: conversation, connectionCatalog, onIdentityChanged: async () => { if (h.weixinStarted) await h.weixinChannel.sync() } })
    const observed = { ...channel, async recover() { h.recoveries = (h.recoveries ?? 0) + 1; return channel.recover() }, async ensureAutomationDeliveries(input) { h.automationFlushes = (h.automationFlushes ?? 0) + 1; return channel.ensureAutomationDeliveries(input) }, async handleInbound(input) {
      h.entered.push(structuredClone(input))
      const value = await channel.handleInbound(input)
      h.receipts.push({ id: input.providerMessageId, value })
      return value
    }, async validateSendClaim(input) { await h.beforeSendClaim?.(input); return channel.validateSendClaim(input) }, async recordSendProgress(input) { const result = await channel.recordSendProgress(input); await h.afterProgress?.(input); return result } }
    h.simulator = await createILinkSimulator({ holdMs: 30 }); origins.add(new URL(h.simulator.url).origin)
    const serial = randomUUID(), token = `SYNTHETIC_TOKEN_${serial}`
    h.bot = { id: `bot-${serial}`, ownerUserId: 'wx-owner', channelAppId: weixinAppId, baseUrl: h.simulator.url, tokenRef: 'bot-token', cursorRef: 'bot-cursor', contextRef: 'bot-context' }
    h.simulator.addAccount({ ...h.bot, token })
    h.secrets = createChannelSecretStore(secretRoot)
    await h.secrets.write(h.bot.tokenRef, token); await h.secrets.write(h.bot.cursorRef, '')
    await h.secrets.write(h.bot.contextRef, { token: `SYNTHETIC_CONTEXT_${serial}` })
    await writeFile(join(secretRoot, 'FEISHU_FIXTURE'), JSON.stringify({ appId, appSecret: 'synthetic_0123456789' }), { mode: 0o600 })
    await store.update(state => seed(state, { ...options, bot: h.bot }))
    h.platform = createFeishuSimulator()
    feishu = createFeishuRuntime({ store, channelService: observed, secretRoot, recover: false, flushOnStart: false, sdk: { ...Lark, Client: h.platform.Client, WSClient: h.platform.WSClient }, httpTimeoutMs: 100, readyTimeoutMs: 500 })
    h.weixinChannel = weixin.createWeixinChannelRuntime({ store, channelService: observed, secrets: h.secrets,
      api: createWeixinApi({ testMode: true, testBaseUrl: h.simulator.url, timeoutMs: 100, longPollTimeoutMs: 150 }), loginPollMs: 10, reconnectDelayMs: 10,
    })
    h.transports = createChannelRuntime({ store, channelService: observed, feishuRuntime: feishu, weixinRuntime: h.weixinChannel, ownerCheck: () => true })
    await h.transports.start(); h.weixinStarted = true; h.runtimeStarted = true
    const authPath = join(root, 'auth.json')
    await initializeAuthFile(authPath, { a: 'synthetic-password-a', b: 'synthetic-password-b', admin: 'synthetic-password-admin' })
    const auth = createAuthRuntime({ filePath: authPath })
    const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
    origin = `http://127.0.0.1:${port}`; origins.add(origin)
    server = createGenewayServer({ service, conversationService: conversation, channel: observed, channelRuntime: h.transports, weixinRuntime: h.weixinChannel, store, auth, knowledge: {}, collaborationRunner: runner, automation: {}, automationRuntime: { ownsLock: () => true },
      ...(options.receipt ? { actionService: Object.fromEntries(['createPreview', 'approve', 'reject', 'revoke', 'reconcile'].map(name => [name, (...args) => h.actionService[name](...args)])) } : {}), index: '', trustedOrigin: origin })
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
    const sessions = new Map()
    h.request = async (member, path, json, method = json === undefined ? 'GET' : 'POST') => {
      const session = sessions.get(member), headers = { origin, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }
      const response = await fetch(origin + path, { method, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) })
      const body = await response.json()
      assert.equal(JSON.stringify(body).includes('SYNTHETIC_TOKEN_'), false)
      assert.equal(JSON.stringify(body).includes('SYNTHETIC_CONTEXT_'), false)
      return { status: response.status, body, cookie: response.headers.get('set-cookie') }
    }
    for (const member of ['a', 'b', 'admin']) {
      const login = await h.request(member, '/api/session', { loginName: member, password: `synthetic-password-${member}` })
      assert.equal(login.status, 200); sessions.set(member, { cookie: login.cookie.split(';')[0], csrf: login.body.csrfToken })
    }
    h.disk = async () => JSON.parse(await readFile(stateFile, 'utf8'))
    h.feishuEvent = (member, id, text, parentId) => h.platform.dispatcher.invoke({ schema: '2.0', header: { event_id: `event-${id}`, event_type: 'im.message.receive_v1', app_id: appId, tenant_key: 'fixture-tenant', create_time: '1789870000000' }, event: { sender: { sender_id: { open_id: `open-${member}` }, sender_type: 'user', tenant_key: 'fixture-tenant' }, message: { message_id: id, parent_id: parentId, chat_id: `chat-${member}`, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: '1789870000000' } } }, { needCheck: false })
    h.linkFeishu = async member => {
      const result = await h.request(member, '/api/channels/link-codes', { channelAppId: 'feishu' })
      assert.equal(result.status, 200); await h.feishuEvent(member, `link-${randomUUID()}`, result.body.code); return result.body
    }
    h.confirm = async (member, id, employeeId) => { const result = await h.request(member, `/api/channels/link-codes/${id}/confirm`, employeeId === undefined ? {} : { employeeId }); assert.equal(result.status, 200, `binding confirmation: ${JSON.stringify(result.body)}`); return result.body }
    h.bindFeishu = async (member, employeeId) => h.confirm(member, (await h.linkFeishu(member)).id, employeeId)
    h.identity = async member => (await h.disk()).channelIdentities.find(item => item.memberId === member && item.channelAppId === 'feishu' && item.status === 'active')
    h.active = async member => {
      const state = await h.disk(), identity = await h.identity(member), current = state.conversations.find(item => item.id === identity?.activeConversationId)
      assert(current, 'C1 confirmation must create an active member conversation'); return current
    }
    h.message = id => ({ message_id: id, from_user_id: h.bot.ownerUserId, to_user_id: h.bot.id, message_type: 1, seq: 1, create_time_ms: 1789870000000, context_token: `SYNTHETIC_CONTEXT_${serial}`, item_list: [{ type: 1, text_item: { text: 'SYNTHETIC_WEIXIN' } }] })
    h.startWeixin = async () => {
      if (!h.weixinStarted) { await h.weixinChannel.start(); h.weixinStarted = true }
      if (options.weixinPrebound) await until(async () => (await h.disk()).channelIdentities.find(item => item.id === 'wx-fixture')?.weixin?.runtimeState === 'connected')
    }
    h.prepareWeixinDelivery = async () => {
      assert.equal(typeof channel.createConversationDelivery, 'function', 'C1 sealed turn-delivery seam is missing')
      assert.equal(typeof channel.recordSendProgress, 'function', 'C1 durable send-progress seam is missing')
      const rotated = await h.request('a', '/api/channels/identities/wx-fixture/conversations', { employeeId: 'agent-a' })
      assert.equal(rotated.status, 201, 'C1 channel conversation HTTP seam is missing')
      const identity = (await h.disk()).channelIdentities.find(item => item.id === 'wx-fixture'), id = identity.activeConversationId
      const sent = await h.request('a', `/api/conversations/${id}/turns`, { text: 'SYNTHETIC_LONG', clientRequestId: 'long-reply' })
      assert.equal(sent.status, 202)
      await until(async () => (await h.request('a', `/api/conversations/${id}`)).body.turns.at(-1)?.status === 'completed')
      const created = await channel.createConversationDelivery({ id: 'a' }, { identityId: identity.id, conversationId: id, turnId: sent.body.turn.id, requestId: 'long-delivery' })
      await h.startWeixin()
      return created.delivery.id
    }
    h.sent = () => h.simulator.calls.filter(call => call.botId === h.bot.id && call.endpoint.endsWith('/sendmessage'))
    return h
    } catch (error) { await h.close(); throw error }
  }

  function seed(state, { legacyNotification = false, weixinPrebound = false, receipt = false, bot } = {}) {
    const member = id => ({ id, loginName: id, displayName: id, role: id === 'admin' ? 'admin' : 'member', enabled: true, authRef: id, employeeIds: ['agent-a', 'agent-b'], sessionVersion: 1, createdAt: now, updatedAt: now })
    const app = (id, provider, credentialRef) => ({ id, provider, providerAppId: id === 'feishu' ? appId : 'ilink', providerTenantId: id === 'feishu' ? 'fixture-tenant' : 'personal', credentialRef, enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now })
    const value = { ...state, defaultChannelEmployeeId: 'agent-a', members: [member('a'), member('b'), member('admin')], modelRoutes: [{ id: 'fixture-model', enabled: true, provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY' }], employees: ['agent-a', 'agent-b'].map(id => ({ id, name: id, enabled: true, revision: 1, instructions: 'synthetic fixture', modelRouteId: 'fixture-model', skillIds: [], connectionIds: [] })),
      channelApps: [app('feishu', 'feishu', 'FEISHU_FIXTURE'), ...(weixinPrebound ? [app(weixinAppId, 'weixin', null)] : [])],
      // Pre-bound synthetic identity is setup for inbox/send tests; Web binding is tested separately.
      channelIdentities: weixinPrebound ? [{ id: 'wx-fixture', memberId: 'a', channelAppId: weixinAppId, providerUserId: 'wx-owner', verificationMethod: 'weixin-qr', status: 'active', revision: 1,
        defaultEmployeeId: null, activeConversationId: null, weixin: { botId: bot.id, baseUrl: bot.baseUrl, tokenRef: bot.tokenRef, cursorRef: bot.cursorRef, contextRef: bot.contextRef, runtimeState: 'stopped' }, createdAt: now, updatedAt: now }] : [],
      channelConversations: weixinPrebound ? [{ id: 'wx-endpoint', memberId: 'a', identityId: 'wx-fixture', channelAppId: weixinAppId, providerConversationId: 'wx-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'weixin-qr', status: 'active', revision: 1, createdAt: now, updatedAt: now }] : [],
    }
    if (receipt) {
      value.skills = [{ id: 'skill-kivo-tpm-device-correlate', capabilityId: 'kivo-tpm-device-correlate', enabled: true }]
      value.connections = [receiptConnection]
      value.employees = value.employees.map(employee => ({ ...employee, skillIds: ['skill-kivo-tpm-device-correlate'], connectionIds: [receiptConnection.id] }))
    }
    if (legacyNotification) {
      value.version = 9
      value.skills.push({ id: 'legacy-skill', enabled: false, capabilityId: 'legacy-history-only' })
      value.connections.push({ id: 'legacy-connection', enabled: false, status: 'unavailable' })
      value.channelIdentities.push({ id: 'notification-owner', memberId: 'b', channelAppId: 'feishu', providerUserId: 'open-b', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now })
      value.channelConversations.push({ id: 'notification-endpoint', memberId: 'b', identityId: 'notification-owner', channelAppId: 'feishu', providerConversationId: 'chat-b', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now })
      value.automationRules.push({ id: 'legacy-notification', ownerMemberId: 'b', revision: 1, status: 'draft', employeeId: 'agent-b', skillId: 'legacy-skill', connectionId: 'legacy-connection', workOrderId: 'SYNTHETIC_HISTORY_ONLY', trigger: { kind: 'daily-time', time: '09:00', timeZone: 'Asia/Shanghai' }, maxRuns: 1, notificationConversationId: 'notification-endpoint', effectiveFrom: null, eventAcceptAfter: null, createdAt: now, updatedAt: now, revokedAt: null })
    }
    return value
  }


  function syntheticRunner() {
    const calls = [], history = new Map()
    let held
    return { calls, holdNext() { assert.equal(held, undefined); held = deferred(); return held.resolve }, async runChatTurn(options) {
      calls.push({ conversationId: options.conversationId, text: options.text, sessionId: options.sessionId })
      await options.authorize()
      const gate = held; held = undefined; await gate?.promise
      const sessionId = options.sessionId ?? `synthetic-native-${randomUUID()}`, userMessageId = `user-${options.turnId}`, assistantId = `assistant-${options.turnId}`
      await options.onSession({ sessionId, userMessageId })
      const events = history.get(sessionId) ?? [], turn = events.filter(event => event.type === 'turn/start').length + 1
      const text = options.text === 'SYNTHETIC_LONG' ? '合成分段回复。'.repeat(700) : `synthetic:${options.text}`
      events.push({ type: 'turn/start', data: { turn } }, { type: 'user/message', data: { id: userMessageId } }, { type: 'assistant/message', data: { turn, message: { id: assistantId, content: [{ type: 'text', text }] } } })
      history.set(sessionId, events)
      return { sessionId, userMessageId, assistantMessageIds: [assistantId], stopReason: 'completed' }
    }, async readChatHistory(ids) { return ids.map(sessionId => ({ sessionId, status: history.has(sessionId) ? 'available' : 'unavailable', events: structuredClone(history.get(sessionId) ?? []) })) }, async cancelChatTurn() {}, async close() {} }
  }
  function assertReceipt(value) { assert(['accepted', 'rejected'].includes(value?.status), 'C1 must return a durable accepted/rejected inbox receipt') }
  function digest(value) { return createHash('sha256').update(value).digest('hex') }
  function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
  async function until(check, reason = 'C1 transport assertion timed out') { for (let attempt = 0; attempt < 100; attempt += 1) { if (await check()) return; await delay(10) } throw new Error(reason) }
}
