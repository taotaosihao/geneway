import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { acquireWeixinBot, createWeixinPlugin, createWeixinRuntime } from '../plugins/weixin.mjs'
import { resolveCredentialFile } from '../src/execution-grant.mjs'
import { createWeixinApi, normalizeWeixinApiBaseUrl, orderWeixinMessages, splitWeixinText, weixinMessageId } from '../vendor/dsh-im/weixin/weixin-api.mjs'
import { createILinkSimulator } from './fixtures/ilink-server.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-weixin-test-'))
const simulator = await createILinkSimulator()
const api = createWeixinApi({ testMode: true, testBaseUrl: simulator.url, timeoutMs: 200, longPollTimeoutMs: 250 })
const runtimes = [], lockPaths = [], publicValues = []
const protocolOnly = process.argv.includes('--protocol-only')
let serial = 0

try {
  await protocolChecks()
  await lockChecks()
  await pollingChecks()
  await contextOrderingChecks()
  await reconnectChecks()
  await deliveryChecks()
  const lifecycle = protocolOnly ? { skipped: true, reason: '--protocol-only: SDK/Cordis not started; U0 decision pending' } : await lifecycleChecks()
  assert.deepEqual(simulator.failures, [])
  const serialized = JSON.stringify(publicValues)
  for (const value of ['test-secret-token-', 'test-secret-context-', 'test-secret-cursor-', 'context_token', 'bot_token', 'get_updates_buf']) assert.equal(serialized.includes(value), false, `public projection contains ${value}`)
  assert.equal(simulator.calls.some(call => /notifystart|notifystop|typing|config|upload|cdn/.test(call.endpoint)), false)
  console.log(JSON.stringify({ ok: true, protocol: 'iLink HTTP simulator', package: '@xmanrui/dsh-im@4.39.0', channelAcceptance: 'protocol-only; C1 integration pending', httpCalls: simulator.calls.length, lifecycle, realPlatformCalls: 0, blindRetries: 0 }))
} finally {
  await Promise.allSettled(runtimes.map(runtime => runtime.close()))
  await simulator.close()
  await rm(root, { recursive: true, force: true })
  for (const path of lockPaths) await rm(path, { recursive: true, force: true })
}

async function protocolChecks() {
  for (const options of [
    { testBaseUrl: simulator.url }, { testMode: false, testBaseUrl: simulator.url },
    { testMode: true, testBaseUrl: 'http://example.com/' }, { testMode: true, testBaseUrl: 'https://127.0.0.1/' },
    { testMode: true, testBaseUrl: 'http://localhost/' }, { testMode: true, testBaseUrl: `${simulator.url}other/` },
    { testMode: true, testBaseUrl: simulator.url + '?secret=yes' }, { timeoutMs: 0 }, { longPollTimeoutMs: 0 },
  ]) assert.throws(() => createWeixinApi(options))
  assert.equal(createWeixinApi({ testMode: true, testBaseUrl: 'http://[::1]:12345/' }).normalizeBaseUrl('http://[::1]:12345/'), 'http://[::1]:12345/')
  for (const value of [simulator.url, 'https://weixin.qq.com.evil.test/', 'https://user:password@ilinkai.weixin.qq.com/', 'https://ilinkai.weixin.qq.com:444/', 'https://ilinkai.weixin.qq.com/?token=x']) assert.throws(() => normalizeWeixinApiBaseUrl(value))
  assert.equal(normalizeWeixinApiBaseUrl('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com/')
  assert.equal(normalizeWeixinApiBaseUrl('https://ilink.wechat.com/'), 'https://ilink.wechat.com/')
  assert.throws(() => api.normalizeBaseUrl('http://127.0.0.1:1/'))
  assert.equal(weixinMessageId({ message_id: 42 }), '42')
  assert.equal(weixinMessageId({ message_id: 2 ** 54 }), undefined)
  assert.equal(weixinMessageId({ client_id: 'client-id' }), 'client-id')
  assert.equal(weixinMessageId({ message_id: '\n' }), undefined)
  assert.deepEqual(orderWeixinMessages([{ seq: '2' }, { seq: 1 }, { seq: 1 }]).map(message => Number(message.seq)), [1, 1, 2])
  assert.deepEqual(orderWeixinMessages([{ create_time_ms: 2 }, { create_time_ms: 1 }]).map(message => message.create_time_ms), [1, 2])
  assert.deepEqual(orderWeixinMessages([{ seq: '9007199254740993' }, { seq: '9007199254740992' }]).map(message => message.seq), ['9007199254740992', '9007199254740993'])
  assert.deepEqual(orderWeixinMessages([{ seq: 'x' }, { seq: 1 }]).map(message => message.seq), ['x', 1])
  assert.deepEqual(splitWeixinText('short'), ['short'])
  assert.deepEqual(splitWeixinText('abcde\nfghij', 8), ['abcde', 'fghij'])
  assert.equal(splitWeixinText('abc😀def😀ghi', 4).join(''), 'abc😀def😀ghi')
  assert(splitWeixinText('abc😀def😀ghi', 4).every(value => value.isWellFormed()))
  assert.throws(() => splitWeixinText('x', 1))

  const h = await fixture()
  const qr = await api.beginLogin()
  assert(qr.qrcodeUrl.startsWith(simulator.url))
  for (const [value, code] of [
    [{ ret: 403 }, 'qr-request-rejected'], [{ ret: 0, qrcode: '' }, 'invalid-qr'],
    [{ ret: 0, qrcode: 'qr', qrcode_img_content: 'invalid' }, 'invalid-qr'],
    [{ ret: 0, qrcode: 'qr', qrcode_img_content: 'https://attacker.test/' }, 'untrusted-base-url'],
    [{ ret: 0, qrcode: 'qr', qrcode_img_content: simulator.url.replace('http://', 'http://user:pass@') }, 'invalid-qr'],
  ]) { simulator.queueQr(value); await assert.rejects(api.beginLogin(), hasCode(code)) }
  await assert.rejects(api.pollLogin({ qrcode: '' }), /qrcode is required/)
  simulator.queueLogin(...['wait', 'scaned', 'expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'].map(status => ({ status })))
  for (const status of ['wait', 'scaned', 'expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect']) assert.deepEqual(await api.pollLogin({ qrcode: qr.qrcode, verifyCode: '1234' }), { status })
  simulator.queueLogin(simulator.confirmedLogin(h.bot.id))
  let saved = false
  const loggedIn = await api.pollLogin({ qrcode: qr.qrcode, onConfirmed: async login => { assert.equal(login.token, h.token); saved = true; await h.secrets.write(h.bot.tokenRef, login.token) } })
  assert(saved)
  assert.equal(loggedIn.ownerUserId, h.bot.ownerUserId)
  publicValues.push(loggedIn)
  simulator.queueLogin({ ...simulator.confirmedLogin(h.bot.id), baseurl: 'https://attacker.test/' })
  await assert.rejects(api.pollLogin({ qrcode: qr.qrcode, onConfirmed() { assert.fail('untrusted login reached secret sink') } }), hasCode('untrusted-base-url'))
  simulator.queueLogin({ status: 'scaned_but_redirect', redirect_host: 'attacker.test' })
  await assert.rejects(api.pollLogin({ qrcode: qr.qrcode }), hasCode('untrusted-base-url'))
  simulator.queueLogin({ status: 'scaned_but_redirect', redirect_host: simulator.url })
  assert.deepEqual(await api.pollLogin({ qrcode: qr.qrcode }), { status: 'scaned_but_redirect', baseUrl: simulator.url })
  simulator.queueLogin({ status: 'confirmed', ilink_bot_id: h.bot.id }, { status: 'unrecognized', bot_token: h.token })
  await assert.rejects(api.pollLogin({ qrcode: qr.qrcode }), hasCode('incomplete-login'))
  await assert.rejects(api.pollLogin({ qrcode: qr.qrcode }), hasCode('invalid-login-status'))
  simulator.queueLogin({ ...simulator.confirmedLogin(h.bot.id), ret: 403 }, { ...simulator.confirmedLogin(h.bot.id), bot_token: 'bad\ntoken' })
  await assert.rejects(api.pollLogin({ qrcode: qr.qrcode }), hasCode('login-rejected'))
  await assert.rejects(api.pollLogin({ qrcode: qr.qrcode }), hasCode('incomplete-login'))
  simulator.queueLogin(simulator.confirmedLogin(h.bot.id))
  await assert.rejects(api.pollLogin({ qrcode: qr.qrcode, onConfirmed() { throw new Error(h.token) } }), error => error.code === 'credential-save-failed' && !error.message.includes(h.token))
  simulator.queueLogin(simulator.confirmedLogin(h.bot.id))
  await assert.rejects(api.pollLogin({ qrcode: qr.qrcode }), /secret sink/)
  const abort = new AbortController()
  simulator.queueLogin({ value: simulator.confirmedLogin(h.bot.id), delayMs: 50 })
  const late = api.pollLogin({ qrcode: qr.qrcode, signal: abort.signal, onConfirmed() { assert.fail('cancelled login reached sink') } })
  abort.abort(new Error(h.token))
  await assert.rejects(late, error => error.code === 'aborted' && !error.message.includes(h.token))
  const shortApi = createWeixinApi({ testMode: true, testBaseUrl: simulator.url, longPollTimeoutMs: 5 })
  const timeout = await shortApi.getUpdates({ baseUrl: simulator.url, token: h.token, getUpdatesBuf: '' })
  assert.deepEqual(timeout, { ret: 0, msgs: [], get_updates_buf: '' })
  simulator.queuePoll(h.bot.id, { redirect: 'http://127.0.0.1:1/' })
  await assert.rejects(api.getUpdates({ baseUrl: simulator.url, token: h.token }), hasCode('network-error'))
}

async function lockChecks() {
  const id = `lock-${randomUUID()}`, path = lockDirectory(id)
  lockPaths.push(path)
  const first = await acquireWeixinBot(id)
  try {
    assert.equal((await lstat(path)).mode & 0o777, 0o700)
    assert.equal((await lstat(join(path, '.geneway-automation.lock'))).mode & 0o777, 0o600)
    await assert.rejects(acquireWeixinBot(id), hasCode('OWNER_ALREADY_RUNNING'))
    const childSource = `import { acquireWeixinBot } from ${JSON.stringify(new URL('../plugins/weixin.mjs', import.meta.url).href)}; try { const lock = await acquireWeixinBot(${JSON.stringify(id)}); await lock.release(); process.exitCode = 1 } catch (error) { if (error.code !== 'OWNER_ALREADY_RUNNING') throw error; console.log('same-bot-refused') }`
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', childSource], { env: { ...process.env, GENEWAY_DATA_ROOT: join(root, 'other-data-root') } })
    assert.equal(child.stdout.trim(), 'same-bot-refused')
  } finally { await first.release() }
  const remounted = await acquireWeixinBot(id); await remounted.release()
  await chmod(path, 0o755)
  await assert.rejects(acquireWeixinBot(id), hasCode('WEIXIN_LOCK_INVALID'))
  await chmod(path, 0o700)
  const linkedId = `linked-${randomUUID()}`, linkedPath = lockDirectory(linkedId)
  await symlink(root, linkedPath)
  try { await assert.rejects(acquireWeixinBot(linkedId), hasCode('WEIXIN_LOCK_INVALID')) } finally { await unlink(linkedPath) }
}

async function pollingChecks() {
  const h = await fixture(), gate = deferred()
  let entered = false, failOnce = true
  h.accept = async event => {
    if (failOnce) { failOnce = false; throw new Error(h.token) }
    h.persist(event)
    if (event.providerMessageId === 'message-1' && !entered) { entered = true; await gate.promise }
    return { status: event.rejectionCode ? 'rejected' : 'accepted' }
  }
  const cursor = simulator.push(h.bot.id, [
    message(h, 'message-2', 2), message(h, 'message-1', 1), message(h, 'message-1', 1),
    message(h, 'outsider', 3, { from_user_id: 'other-user', context_token: 'forbidden-context' }),
    message(h, 'image', 4, { item_list: [{ type: 2, image_item: {} }] }),
    message(h, 'echo', 5, { message_type: 2 }), message(h, 'group', 6, { group_id: 'group' }),
    message(h, 'empty', 7, { item_list: [{ type: 1, text_item: { text: ' ' } }] }),
    { message_type: 1, seq: 8, from_user_id: h.bot.ownerUserId, item_list: [] },
  ])
  const runtime = h.runtime()
  await runtime.start()
  await until(() => entered)
  assert.equal(await h.secrets.read(h.bot.cursorRef), '')
  assert(h.statuses.some(value => value.state === 'reconnecting'))
  gate.resolve()
  await until(async () => await h.secrets.read(h.bot.cursorRef) === cursor)
  const values = [...h.inbox.values()]
  assert.equal(h.inbox.size, 8)
  assert.deepEqual(values.filter(value => !value.rejectionCode).map(value => value.providerMessageId), ['message-1', 'message-2'])
  for (const code of ['WEIXIN_NOT_OWNER', 'WEIXIN_TEXT_ONLY', 'WEIXIN_ECHO', 'WEIXIN_PRIVATE_ONLY', 'WEIXIN_INVALID_TEXT', 'WEIXIN_INVALID_MESSAGE']) assert(values.some(value => value.rejectionCode === code))
  const before = await h.secrets.read(h.bot.contextRef)
  assert.equal(before.sequence, '4')
  simulator.push(h.bot.id, [message(h, 'late', 1)])
  await until(() => h.inbox.has('late'))
  assert.equal((await h.secrets.read(h.bot.contextRef)).token, before.token)
  const duplicate = h.runtime()
  await assert.rejects(duplicate.start(), hasCode('WEIXIN_ALREADY_RUNNING'))
  assert.equal(simulator.maxActivePolls(h.bot.id), 1)
  await runtime.close()
  const received = h.inbox.size, polls = count(h, 'getupdates')
  simulator.push(h.bot.id, [message(h, 'after-close', 10)])
  await delay(30)
  assert.equal(h.inbox.size, received)
  assert.equal(count(h, 'getupdates'), polls)
  await assert.rejects(runtime.start(), hasCode('WEIXIN_STOPPED'))

  const failing = await fixture()
  let failCursor = true
  const write = failing.secrets.write
  failing.secrets.write = async (ref, value) => { if (ref === failing.bot.cursorRef && failCursor) { failCursor = false; throw new Error(failing.token) } return write(ref, value) }
  const next = simulator.push(failing.bot.id, [message(failing, 'durable-before-cursor', 1)])
  const resumed = failing.runtime()
  await resumed.start()
  await until(async () => await failing.secrets.read(failing.bot.cursorRef) === next)
  assert.equal(failing.inbox.size, 1)
  assert(count(failing, 'getupdates') >= 2)
  await resumed.close()

  const unsupported = await fixture()
  simulator.push(unsupported.bot.id, [message(unsupported, 'non-text-first', 1, { item_list: [{ type: 4, file_item: {} }] })])
  const replying = unsupported.runtime(); await replying.start(); await until(() => unsupported.inbox.has('non-text-first'))
  assert.equal((await replying.sendText({ deliveryId: 'unsupported-reply', attemptId: 'unsupported-reply', text: '暂不支持非文本消息' })).status, 'delivered')
  await replying.close()

  const stopped = await fixture(), hold = deferred()
  let held = false
  stopped.accept = async event => { stopped.persist(event); held = true; await hold.promise; return { status: 'accepted' } }
  simulator.push(stopped.bot.id, [message(stopped, 'stop-inflight', 1)])
  const closing = stopped.runtime(); await closing.start(); await until(() => held)
  const closed = closing.close()
  hold.resolve(); await closed
  assert.equal(await stopped.secrets.read(stopped.bot.cursorRef), '')
}

async function contextOrderingChecks() {
  const h = await fixture(), runtime = h.runtime()
  await runtime.start()
  async function update(id, seq, timestamp, expectedId) {
    const cursor = simulator.push(h.bot.id, [message(h, id, 0, { seq, create_time_ms: timestamp })])
    await until(async () => await h.secrets.read(h.bot.cursorRef) === cursor)
    assert.equal((await h.secrets.read(h.bot.contextRef)).token, `test-secret-context-${expectedId}`)
  }
  await update('timestamp-only', undefined, 200, 'timestamp-only')
  await update('old-time-with-seq', 1, 100, 'timestamp-only')
  await update('seq-one', 1, 201, 'seq-one')
  await update('duplicate-seq', 1, 202, 'seq-one')
  await update('old-seq', 0, 250, 'seq-one')
  await update('new-seq-old-time', 2, 150, 'seq-one')
  await update('seq-two', 2, 202, 'seq-two')
  await update('new-time-no-seq', undefined, 203, 'new-time-no-seq')
  assert.equal((await h.secrets.read(h.bot.contextRef)).sequence, '2')
  await update('old-seq-after-no-seq', 1, 204, 'new-time-no-seq')
  await update('new-seq-no-time', 3, undefined, 'new-seq-no-time')
  assert.equal((await h.secrets.read(h.bot.contextRef)).timestamp, 203)
  await update('old-time-after-no-time', 4, 202, 'new-seq-no-time')
  await update('large-seq', '9007199254740993', 205, 'large-seq')
  await update('smaller-large-seq', '9007199254740992', 206, 'large-seq')
  await update('duplicate-large-seq', '9007199254740993', 207, 'large-seq')
  await update('larger-seq', '9007199254740994', 208, 'larger-seq')
  await update('invalid-precision', Number.MAX_SAFE_INTEGER + 1, 209, 'larger-seq')
  await update('invalid-seq', '1.5', 210, 'larger-seq')
  const cursor = simulator.push(h.bot.id, [
    message(h, 'batch-larger', 0, { seq: '9007199254740996', create_time_ms: 211 }),
    message(h, 'batch-smaller', 0, { seq: '9007199254740995', create_time_ms: 211 }),
  ])
  await until(async () => await h.secrets.read(h.bot.cursorRef) === cursor)
  assert.deepEqual([...h.inbox.keys()].slice(-2), ['batch-smaller', 'batch-larger'])
  assert.equal((await h.secrets.read(h.bot.contextRef)).token, 'test-secret-context-batch-larger')
  assert.equal((await h.secrets.read(h.bot.contextRef)).sequence, '9007199254740996')
  await runtime.close()
}

async function reconnectChecks() {
  const transient = await fixture()
  simulator.queuePoll(transient.bot.id, { httpStatus: 503, body: { ret: 503, token: transient.token } })
  const runtime = transient.runtime(); await runtime.start(); await until(() => runtime.isAvailable())
  assert(transient.statuses.some(value => value.state === 'reconnecting' && value.error.code === 'WEIXIN_HTTP_ERROR'))
  await runtime.close()
  for (const mode of ['stale', 'invalid', 'inbox']) {
    const h = await fixture()
    if (mode === 'stale') simulator.queuePoll(h.bot.id, { ret: -14, token: h.token })
    if (mode === 'invalid') simulator.queuePoll(h.bot.id, ...Array.from({ length: 3 }, () => ({ ret: 0, msgs: 'bad', get_updates_buf: h.token })))
    if (mode === 'inbox') { h.accept = async () => undefined; simulator.push(h.bot.id, [message(h, 'not-durable', 1)]) }
    const invalid = h.runtime(); await invalid.start(); await until(() => h.statuses.some(value => value.state === 'unavailable'))
    const calls = count(h, 'getupdates')
    await delay(30)
    assert.equal(count(h, 'getupdates'), calls)
    assert.equal(await h.secrets.read(h.bot.cursorRef), '')
    assert.equal(invalid.isAvailable(), false)
    await invalid.close()
  }
  const h = await fixture()
  const children = async () => new Set((await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean))
  const before = await children()
  const lost = h.runtime(); await lost.start(); await until(() => lost.isAvailable())
  const newChildren = [...await children()].filter(id => !before.has(id))
  assert.equal(newChildren.length, 1)
  process.kill(Number(newChildren[0]), 'SIGKILL')
  await until(() => h.statuses.some(value => value.error?.code === 'WEIXIN_LOCK_LOST'))
  const countBefore = count(h, 'getupdates')
  await delay(30)
  assert.equal(count(h, 'getupdates'), countBefore)
  assert.equal(lost.isAvailable(), false)
  await lost.close()
}

async function deliveryChecks() {
  const h = await fixture()
  const runtime = h.runtime({ maxMessageChars: 8 })
  simulator.push(h.bot.id, [message(h, 'context', 1)])
  await runtime.start(); await until(() => h.inbox.has('context'))
  const text = 'abcdefghijklmnopqrstuvwx'
  const input = { deliveryId: 'delivery-unknown', attemptId: 'attempt-unknown', text }
  simulator.queueSend(h.bot.id, { ret: 0 }, {})
  const unknown = await runtime.sendText(input)
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.acknowledgedParts.length, 1)
  const unknownCalls = count(h, 'sendmessage')
  await assert.rejects(runtime.sendText({ ...input, previousStatus: 'unknown', acknowledgedParts: unknown.acknowledgedParts }), hasCode('WEIXIN_SEND_FORBIDDEN'))
  assert.equal(count(h, 'sendmessage'), unknownCalls)
  assert.equal((await runtime.sendText(input)).status, 'blocked')
  assert.equal(count(h, 'sendmessage'), unknownCalls)
  assert.equal((await runtime.sendText(input)).status, 'blocked')
  assert.equal(count(h, 'sendmessage'), unknownCalls)

  const retry = { deliveryId: 'delivery-retry', attemptId: 'attempt-retry', text }
  simulator.queueSend(h.bot.id, { ret: 0 }, { ret: 400 })
  const failed = await runtime.sendText(retry)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.acknowledgedParts.length, 1)
  const delivered = await runtime.sendText({ ...retry, previousStatus: 'failed', acknowledgedParts: failed.acknowledgedParts })
  assert.equal(delivered.status, 'delivered')
  assert.equal(delivered.acknowledgedParts.length, 3)
  const firstPart = delivered.acknowledgedParts[0].clientId
  assert.equal(simulator.calls.filter(call => call.clientId === firstPart).length, 1)
  assert.equal(h.progress.filter(value => value.deliveryId === retry.deliveryId && value.status === 'delivered').length, 1)
  await assert.rejects(runtime.sendText({ ...retry, acknowledgedParts: [{ index: 0, clientId: 'wrong' }] }), hasCode('WEIXIN_PROGRESS_INVALID'))
  await assert.rejects(runtime.sendText({ ...retry, toUserId: 'other-user' }), hasCode('WEIXIN_SEND_FORBIDDEN'))

  for (const [response, status] of [[{ invalidJson: true }, 'unknown'], [{ drop: true }, 'unknown'], [{ httpStatus: 500 }, 'unknown'], [{ httpStatus: 403 }, 'failed'], [{ ret: 0, errcode: 400, errmsg: 'context_expired' }, 'failed'], [{ ret: h.token }, 'unknown'], [{ ret: null }, 'unknown'], [{ ret: true }, 'unknown'], [{ ret: {} }, 'unknown'], [{ ret: '0', errcode: null }, 'unknown'], [{ ret: 403, errcode: {} }, 'unknown'], [{ ret: 1.5 }, 'unknown'], [{ ret: '0' }, 'delivered']]) {
    simulator.queueSend(h.bot.id, response)
    const input = { deliveryId: `error-${serial++}`, attemptId: `error-${serial++}`, text: 'short' }
    const value = await runtime.sendText(input)
    assert.equal(value.status, status)
    if (status === 'unknown') {
      const before = count(h, 'sendmessage')
      await assert.rejects(runtime.sendText({ ...input, previousStatus: 'unknown' }), hasCode('WEIXIN_SEND_FORBIDDEN'))
      assert.equal((await runtime.sendText(input)).status, 'blocked')
      assert.equal(count(h, 'sendmessage'), before)
    }
  }
  h.allow = false
  const before = count(h, 'sendmessage')
  assert.equal((await runtime.sendText({ deliveryId: 'revoked', attemptId: 'revoked', text })).status, 'blocked')
  assert.equal(count(h, 'sendmessage'), before)
  h.allow = true
  h.afterProgress = value => { if (value.deliveryId === 'between-parts' && value.status === 'sending') h.allow = false }
  const revoked = await runtime.sendText({ deliveryId: 'between-parts', attemptId: 'between-parts', text })
  assert.equal(revoked.status, 'blocked')
  assert.equal(revoked.acknowledgedParts.length, 1)
  h.allow = true; h.afterProgress = undefined
  await h.secrets.write(h.bot.contextRef, null)
  const missing = await runtime.sendText({ deliveryId: 'no-context', attemptId: 'no-context', text })
  assert.equal(missing.status, 'failed')
  assert.equal(missing.error.code, 'WEIXIN_CONTEXT_UNAVAILABLE')
  await h.secrets.write(h.bot.contextRef, { token: 'test-secret-context-restored' })

  h.afterProgress = () => { throw new Error(h.token) }
  const progressBefore = count(h, 'sendmessage')
  await assert.rejects(runtime.sendText({ deliveryId: 'save-fails', attemptId: 'save-fails', text }), error => error.code === 'WEIXIN_PROGRESS_NOT_DURABLE' && !error.message.includes(h.token))
  assert.equal(count(h, 'sendmessage'), progressBefore + 1)
  h.afterProgress = undefined
  const gate = deferred(); let waiting = false
  h.before = async () => { waiting = true; await gate.promise; return true }
  const pending = runtime.sendText({ deliveryId: 'parallel', attemptId: 'parallel', text: 'short' })
  await until(() => waiting)
  await assert.rejects(runtime.sendText({ deliveryId: 'parallel', attemptId: 'parallel', text: 'short' }), hasCode('WEIXIN_SEND_IN_PROGRESS'))
  gate.resolve(); assert.equal((await pending).status, 'delivered')
  simulator.queueSend(h.bot.id, { ret: -14 })
  const stale = await runtime.sendText({ deliveryId: 'stale-on-send', attemptId: 'stale-on-send', text: 'short' })
  assert.equal(stale.status, 'failed')
  await until(() => h.statuses.some(value => value.error?.code === 'WEIXIN_STALE_TOKEN'))
  const stalePolls = count(h, 'getupdates')
  await delay(30)
  assert.equal(count(h, 'getupdates'), stalePolls)
  assert.equal(runtime.isAvailable(), false)
  await runtime.close()
  assert.equal((await runtime.sendText({ deliveryId: 'closed', attemptId: 'closed', text: 'short' })).status, 'blocked')
}

async function lifecycleChecks() {
  const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
  const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
  const host = new Context(), originalHost = host
  const h = await fixture()
  let mounted
  try {
    simulator.push(h.bot.id, [message(h, 'mounted', 1)])
    mounted = host.plugin(createWeixinPlugin(h.runtime()))
    await mounted; await until(() => h.inbox.has('mounted'))
    await until(() => simulator.activePolls(h.bot.id) === 1)
    await mounted.dispose(); mounted = undefined
    await until(() => simulator.activePolls(h.bot.id) === 0)
    const afterDispose = count(h, 'getupdates')
    simulator.push(h.bot.id, [message(h, 'remounted', 2)])
    await delay(30)
    assert.equal(count(h, 'getupdates'), afterDispose)
    assert.equal(h.inbox.has('remounted'), false)
    mounted = host.plugin(createWeixinPlugin(h.runtime()))
    await mounted; await until(() => h.inbox.has('remounted'))
    assert.equal(host, originalHost)
    assert.equal(simulator.maxActivePolls(h.bot.id), 1)
    await mounted.dispose(); mounted = undefined
    await until(() => simulator.activePolls(h.bot.id) === 0)
    return { sameHost: host === originalHost, dshVersion: requireFromDsh('./package.json').version, scope: 'installed candidate diagnostic; U0 compliance not asserted', disposedPolls: 0, maxConsumers: 1, remountReceived: true }
  } finally { await mounted?.dispose(); await host.fiber.dispose() }
}

async function fixture() {
  const id = `bot-${randomUUID()}`, token = `test-secret-token-${id}`, secretRoot = join(root, id)
  await mkdir(secretRoot, { mode: 0o700 })
  lockPaths.push(lockDirectory(id))
  const bot = { id, channelAppId: `app-${id}`, ownerUserId: `owner-${id}`, baseUrl: simulator.url, tokenRef: 'token', cursorRef: 'cursor', contextRef: 'context' }
  simulator.addAccount({ id, ownerUserId: bot.ownerUserId, token })
  const h = { bot, token, inbox: new Map(), progress: [], deliveryStates: new Map(), statuses: [], allow: true }
  h.secrets = {
    async read(ref) { return JSON.parse(await readFile(await resolveCredentialFile(secretRoot, ref), 'utf8')).value },
    async write(ref, value) { const file = join(secretRoot, ref); await writeFile(`${file}.next`, JSON.stringify({ value }), { mode: 0o600 }); await rename(`${file}.next`, file) },
  }
  await h.secrets.write('token', token); await h.secrets.write('cursor', ''); await h.secrets.write('context', null)
  h.persist = event => { publicValues.push(event); if (!h.inbox.has(event.providerEventId)) h.inbox.set(event.providerEventId, event) }
  h.accept = async event => { h.persist(event); return { status: event.rejectionCode ? 'rejected' : 'accepted' } }
  h.runtime = options => {
    const runtime = createWeixinRuntime({ bot, secrets: h.secrets, api, reconnectDelayMs: 10,
      acceptInbound: event => h.accept(event),
      onRuntime: async value => { h.statuses.push(value); publicValues.push(value) },
      beforeSend: envelope => h.before ? h.before(envelope) : h.allow && !['unknown', 'delivered'].includes(h.deliveryStates.get(envelope.deliveryId)),
      recordSendProgress: async value => {
        h.progress.push(value); publicValues.push(value)
        if (!['unknown', 'delivered'].includes(h.deliveryStates.get(value.deliveryId))) h.deliveryStates.set(value.deliveryId, value.status)
        await h.afterProgress?.(value)
      }, ...options })
    runtimes.push(runtime)
    return runtime
  }
  return h
}
function message(h, id, seq, extra = {}) { return { message_id: id, seq, create_time_ms: 1792022400000 + seq, from_user_id: h.bot.ownerUserId, to_user_id: h.bot.id, message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: `消息 ${id}` } }], context_token: `test-secret-context-${id}`, ...extra } }
function count(h, endpoint) { return simulator.calls.filter(call => call.botId === h.bot.id && call.endpoint.endsWith(`/${endpoint}`)).length }
function lockDirectory(id) { return join('/tmp', `geneway-weixin-${process.getuid()}`, createHash('sha256').update(id).digest('hex')) }
function hasCode(code) { return error => error?.code === code }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
async function until(check) { const end = Date.now() + 3000; while (!await check()) { if (Date.now() > end) throw new Error('Weixin test condition timed out'); await delay(5) } }
