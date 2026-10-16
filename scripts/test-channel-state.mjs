import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { createChannelService } from '../src/channel-service.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-channel-state-')), now = '2026-10-15T00:00:00.000Z'
try {
  const old = seed()
  old.version = 9
  delete old.defaultChannelEmployeeId
  old.channelIdentities = old.channelIdentities.map(({ defaultEmployeeId, activeConversationId, ...identity }) => identity)
  old.channelApps.push({ ...app('legacy-weixin'), provider: 'weixin', providerAppId: 'old-manual-app' })
  old.skills = [{ id: 'history-skill', enabled: false }]
  old.connections = [{ id: 'history-connection', enabled: false, status: 'unavailable' }]
  old.automationRules = ['mapped', 'missing'].map(id => ({ id, ownerMemberId: 'member-admin', revision: 1, status: 'draft', employeeId: 'agent', skillId: 'history-skill', connectionId: 'history-connection', workOrderId: 'SYNTHETIC_HISTORY', trigger: { kind: 'daily-time', time: '09:00', timeZone: 'Asia/Shanghai' }, maxRuns: 1, notificationConversationId: id === 'mapped' ? 'endpoint' : 'absent-old-endpoint', effectiveFrom: null, eventAcceptAfter: null, createdAt: now, updatedAt: now, revokedAt: null }))
  const migrated = migrateState(old)
  assert.equal(migrated.version, STATE_VERSION)
  assert.equal(migrated.defaultChannelEmployeeId, null)
  assert.deepEqual(migrated.automationRules.map(rule => rule.notificationIdentityId), ['identity', null])
  assert.equal(migrated.automationRules.some(rule => Object.hasOwn(rule, 'notificationConversationId')), false)
  assert.equal(migrated.channelApps.at(-1).enabled, false)
  assert.equal(migrated.channelApps.at(-1).credentialRef, 'synthetic-channel-ref')
  assert.throws(() => migrateState({ ...migrated, channelApps: migrated.channelApps.map(item => item.provider === 'weixin' ? { ...item, enabled: true, status: 'active' } : item) }), /旧微信/)

  const file = join(root, 'state.json'), store = createFileStore(file)
  await store.update(() => seed())
  const rejected = async change => {
    const before = await readFile(file)
    await assert.rejects(store.update(state => { change(state); return state }))
    assert.deepEqual(await readFile(file), before)
  }
  await rejected(state => { state.defaultChannelEmployeeId = 'not-an-agent' })
  await rejected(state => { state.channelIdentities[0].activeConversationId = 'not-an-owned-conversation' })
  await rejected(state => { state.channelIdentities[0].providerUserId = 'different-owner' })
  await rejected(state => { state.channelApps.push({ ...app('bad'), provider: 'unknown' }) })

  await store.update(state => ({ ...state, channelIdentities: state.channelIdentities.map(item => ({ ...item, status: 'unlinked', activeConversationId: null, unlinkedAt: now })), channelConversations: state.channelConversations.map(item => ({ ...item, status: 'unlinked', unlinkedAt: now })) }))
  await rejected(state => { state.channelIdentities[0].status = 'active' })
  await rejected(state => { state.channelConversations[0].status = 'active' })
  await store.update(state => ({ ...state, channelIdentities: [...state.channelIdentities, { ...identity(), id: 'identity-new', status: 'pending' }], channelConversations: [...state.channelConversations, { ...endpoint(), id: 'endpoint-new', identityId: 'identity-new', status: 'pending' }] }))

  const poison = { id: 'poison', channelAppId: 'app', providerMessageId: `invalid-${hash('poison')}`, direction: 'inbound', text: '', bodyDigest: hash('poison'), conversationType: 'private', status: 'rejected', receivedAt: now, persistedAt: now, error: { code: 'UNSUPPORTED', message: '当前仅支持私聊文本' } }
  await store.update(state => ({ ...state, channelMessages: [poison] }))
  const conflict = { digest: hash('conflicting official ID'), providerMessageId: 'different-official-id', receivedAt: now, error: { code: 'OFFICIAL_ID_CONFLICT', message: '渠道官方消息标识冲突，本次不会受理' } }
  await store.update(state => ({ ...state, channelMessages: state.channelMessages.map(item => ({ ...item, conflicts: [conflict] })) }))
  await rejected(state => { state.channelMessages[0].conflicts = [] })
  await rejected(state => { state.channelMessages[0].text = 'replacement poison body' })
  await rejected(state => { state.channelMessages[0].status = 'received' })

  const attemptId = '00000000-0000-4000-8000-000000000001'
  const delivery = { id: 'delivery', channelAppId: 'app', requestId: 'fixed-notice', targetIdentityId: 'identity-new', targetConversationId: 'endpoint-new', contentScope: 'fixed', contentKey: 'help.confirmation', status: 'sending', attempts: 1, authorizationRevisions: { app: 1, identity: 1, conversation: 1 }, createdAt: now, updatedAt: now }
  await store.update(state => ({ ...state, deliveries: [delivery] }))
  await rejected(state => { delete state.deliveries[0].authorizationRevisions.conversation })
  const progress = { attemptId, totalParts: 2, textDigest: hash('exact rendered content'), acknowledgedParts: [], partIndex: 0 }
  await store.update(state => ({ ...state, deliveries: [{ ...state.deliveries[0], sendProgress: progress }] }))
  const ack = index => ({ index, clientId: `geneway-weixin-${hash(`${attemptId}\0${index}`).slice(0, 32)}` })
  await rejected(state => { state.deliveries[0].sendProgress.acknowledgedParts = [ack(1)] })
  await store.update(state => ({ ...state, deliveries: [{ ...state.deliveries[0], sendProgress: { ...progress, acknowledgedParts: [ack(0)], partIndex: 1 } }] }))
  await rejected(state => { state.deliveries[0].sendProgress.textDigest = hash('replacement') })
  await rejected(state => { state.deliveries[0].sendProgress.acknowledgedParts = []; state.deliveries[0].sendProgress.partIndex = 0 })
  await rejected(state => { state.deliveries[0].status = 'delivered'; state.deliveries[0].providerMessageId = ack(0).clientId })
  await store.update(state => ({ ...state, deliveries: [{ ...state.deliveries[0], status: 'unknown', error: { code: 'RECOVERY_UNKNOWN', message: '发送效果待核对' } }] }))
  await rejected(state => { state.deliveries[0].status = 'sending'; delete state.deliveries[0].error })
  await store.update(state => ({ ...state, deliveries: [{ ...state.deliveries[0], sendProgress: { attemptId, totalParts: 2, textDigest: progress.textDigest, acknowledgedParts: [ack(0), ack(1)] } }] }))
  assert.equal((await store.read()).deliveries[0].status, 'unknown', 'late ACK adds facts without claiming delivery')
  await weixinRuntimeChecks()
  console.log('Channel state checks passed: v9 precise notification migration, disabled old Weixin apps, tombstones, poison/conflict durability, atomic refusal, monotonic segmented ACK and current Weixin runtime authorization (native/model/network=0)')
} finally { await rm(root, { recursive: true, force: true }) }

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function app(id = 'app') { return { id, provider: 'feishu', providerAppId: id, providerTenantId: 'synthetic-tenant', credentialRef: 'synthetic-channel-ref', enabled: true, status: 'active', allowedScopes: ['result'], revision: 1, createdAt: now, updatedAt: now } }
function identity() { return { id: 'identity', channelAppId: 'app', providerUserId: 'synthetic-owner', memberId: 'member-admin', verificationMethod: 'link-code', status: 'active', revision: 1, defaultEmployeeId: null, activeConversationId: null, createdAt: now, updatedAt: now } }
function endpoint() { return { id: 'endpoint', channelAppId: 'app', providerConversationId: 'synthetic-private', identityId: 'identity', memberId: 'member-admin', type: 'private', verificationMethod: 'link-code', status: 'active', revision: 1, allowedScopes: ['result'], createdAt: now, updatedAt: now } }
function seed() {
  const state = migrateState({ version: 3 })
  return { ...state, employees: [{ id: 'agent', name: 'Agent', enabled: true, revision: 1, instructions: '', modelRouteId: null, skillIds: [], connectionIds: [] }], channelApps: [app()], channelIdentities: [identity()], channelConversations: [endpoint()] }
}

async function weixinRuntimeChecks() {
  let serial = 0
  const report = { identityId: 'identity', botId: 'synthetic-bot', state: 'connected' }
  const fixtures = async ({ runtimeState = 'connected', code, derived = false } = {}) => {
    const file = join(root, `weixin-runtime-${++serial}.json`), counts = { reads: 0, updates: 0, publishes: 0, clockCalls: 0 }, hooks = {}
    const disk = createFileStore(file, { async rename(from, to) { await rename(from, to); counts.publishes++ } })
    const state = seed(), channelAppId = 'channel-app-weixin'
    state.channelApps = [{ ...app(channelAppId), provider: 'weixin', providerAppId: 'ilink', providerTenantId: 'personal', credentialRef: null }]
    state.channelIdentities = [{ ...identity(), channelAppId, verificationMethod: 'weixin-qr', weixin: {
      botId: report.botId, baseUrl: 'http://127.0.0.1:40199/', tokenRef: 'token', cursorRef: 'cursor', contextRef: 'context', runtimeState, ...(code ? { error: { code } } : {}),
    } }]
    state.channelConversations = [{ ...endpoint(), channelAppId, verificationMethod: 'weixin-qr' }]
    if (derived) {
      state.channelIdentities[0].activeConversationId = 'runtime-conversation'
      state.conversations = [{ id: 'runtime-conversation', ownerMemberId: 'member-admin', employeeId: 'agent', employeeName: 'Agent', title: 'Synthetic runtime conversation', source: 'weixin', channelIdentityId: 'identity', createdAt: now, updatedAt: now, archivedAt: null, sessions: [], turns: [] }]
      state.deliveries = ['pending', 'sending', 'delivered'].map(status => ({ id: `runtime-${status}`, channelAppId, requestId: `runtime-${status}`, targetIdentityId: 'identity', targetConversationId: 'endpoint', contentScope: 'fixed', contentKey: 'help.confirmation', status,
        attempts: status === 'pending' ? 0 : 1, ...(status === 'pending' ? {} : { authorizationRevisions: { app: 1, identity: 1, conversation: 1 } }), ...(status === 'delivered' ? { providerMessageId: 'already-delivered' } : {}), createdAt: now, updatedAt: now }))
      state.linkCodes = [{ id: 'runtime-link', channelAppId, memberId: 'member-admin', digest: hash('runtime-link'), status: 'matched', failedAttempts: 0, expiresAt: '2026-10-15T01:00:00.000Z', createdAt: now, updatedAt: now, matchedIdentityId: 'identity', matchedConversationId: 'endpoint', matchedAt: now,
        kind: 'weixin-qr', loginRef: 'login', tokenRef: 'token', cursorRef: 'cursor', contextRef: 'context' }]
    }
    await disk.update(() => state)
    counts.publishes = 0
    const service = createChannelService({ store: {
      async read() { counts.reads++; if (hooks.readFailure) throw hooks.readFailure; const value = await disk.read(); await hooks.afterRead?.(); return value },
      async update(mutator) { counts.updates++; await hooks.beforeUpdate?.(); if (hooks.persistFailure) throw hooks.persistFailure; return disk.update(mutator) },
    }, clock: () => new Date(Date.parse(now) + ++counts.clockCalls * 1000).toISOString() })
    const snapshot = async () => ({ bytes: await readFile(file), mtime: (await stat(file, { bigint: true })).mtimeNs })
    return { service, disk, counts, hooks, snapshot }
  }
  const currentIdentity = async h => (await h.disk.read()).channelIdentities[0]
  const unlink = state => ({ ...state,
    channelIdentities: state.channelIdentities.map(item => ({ ...item, status: 'unlinked', activeConversationId: null, unlinkedAt: now })),
    channelConversations: state.channelConversations.map(item => ({ ...item, status: 'unlinked', unlinkedAt: now })),
  })
  const disable = state => ({ ...state, channelApps: state.channelApps.map(item => ({ ...item, enabled: false, status: 'disabled' })) })
  const repeat = await fixtures(), before = await repeat.snapshot(), identityBefore = await currentIdentity(repeat)
  for (let index = 0; index < 6; index++) await repeat.service.setWeixinRuntime(report)
  const after = await repeat.snapshot(), identityAfter = await currentIdentity(repeat)
  const comparison = { case: 'weixin-runtime-repeated-connected', callbacks: 6, ...repeat.counts,
    bytesUnchanged: before.bytes.equals(after.bytes), fileTimeUnchanged: before.mtime === after.mtime,
    identityTimeUnchanged: identityBefore.updatedAt === identityAfter.updatedAt, revisionUnchanged: identityBefore.revision === identityAfter.revision }
  console.log(JSON.stringify(comparison))
  assert.equal(comparison.updates, 0, 'unchanged connected reports must not enter a write transaction')
  assert.equal(comparison.publishes, 0)
  assert.equal(comparison.reads, 6, 'every callback must read reliable current state')
  for (const key of ['bytesUnchanged', 'fileTimeUnchanged', 'identityTimeUnchanged', 'revisionUnchanged']) assert.equal(comparison[key], true, key)

  for (const change of [disable, unlink]) {
    const h = await fixtures()
    await h.disk.update(change)
    const saved = await h.snapshot()
    await assert.rejects(h.service.setWeixinRuntime(report), { code: 'CHANNEL_RUNTIME_STALE' })
    assert.equal(h.counts.reads, 1); assert.equal(h.counts.updates, 0)
    assert.deepEqual(await h.snapshot(), saved)
  }
  for (const fields of [{ identityId: 'missing' }, { botId: 'different-bot' }]) {
    const h = await fixtures()
    await assert.rejects(h.service.setWeixinRuntime({ ...report, ...fields }), { code: 'CHANNEL_RUNTIME_STALE' })
    assert.equal(h.counts.reads, 1); assert.equal(h.counts.updates, 0)
  }
  for (const change of [disable, unlink]) {
    const h = await fixtures()
    let revoked
    h.hooks.beforeUpdate = async () => { await h.disk.update(change); revoked = await h.snapshot() }
    await assert.rejects(h.service.setWeixinRuntime({ ...report, state: 'reconnecting' }), { code: 'CHANNEL_RUNTIME_STALE' })
    assert.equal(h.counts.reads, 1); assert.equal(h.counts.updates, 1)
    assert.deepEqual(await h.snapshot(), revoked, 'transaction authorization must preserve revocation after the pre-read')
  }
  const concurrentNoop = await fixtures()
  let revoked
  concurrentNoop.hooks.afterRead = async () => { await concurrentNoop.disk.update(unlink); revoked = await concurrentNoop.snapshot() }
  await concurrentNoop.service.setWeixinRuntime(report)
  assert.equal(concurrentNoop.counts.updates, 0)
  assert.deepEqual(await concurrentNoop.snapshot(), revoked, 'a read-linearized noop cannot resurrect a concurrent tombstone')

  const changed = await fixtures()
  for (const input of [
    { state: 'connecting' }, { state: 'connected', error: {} }, { state: 'connected', error: { code: 'NETWORK_ERROR' } },
    { state: 'connected' }, { state: 'reconnecting', error: { code: 'NETWORK_ERROR' } }, { state: 'stopped' }, { state: 'unavailable', error: { code: 'WEIXIN_LOCK_LOST' } },
  ]) {
    const previousWrites = changed.counts.updates
    await changed.service.setWeixinRuntime({ ...report, ...input })
    assert.equal(changed.counts.updates, previousWrites + 1)
    const value = await currentIdentity(changed), expectedCode = input.error ? input.error.code ?? 'WEIXIN_UNAVAILABLE' : undefined
    assert.equal(value.weixin.runtimeState, input.state); assert.equal(value.weixin.error?.code, expectedCode)
    assert.equal(value.updatedAt, new Date(Date.parse(now) + changed.counts.clockCalls * 1000).toISOString())
    const snapshot = await changed.snapshot()
    await changed.service.setWeixinRuntime({ ...report, ...input, ...(input.error && !input.error.code ? { error: { code: 'not-a-safe-code' } } : {}) })
    assert.equal(changed.counts.updates, previousWrites + 1, 'equivalent normalized error must not write')
    assert.deepEqual(await changed.snapshot(), snapshot)
  }
  const unavailable = await fixtures({ runtimeState: 'unavailable', code: 'WEIXIN_LOCK_LOST' }), stickyBefore = await unavailable.snapshot()
  await unavailable.service.setWeixinRuntime({ ...report, state: 'stopped' })
  assert.equal(unavailable.counts.updates, 0); assert.deepEqual(await unavailable.snapshot(), stickyBefore)

  for (const code of ['WEIXIN_STALE_TOKEN', 'WEIXIN_AUTH_REJECTED', 'WEIXIN_SECRET_UNAVAILABLE']) {
    const h = await fixtures({ runtimeState: 'unavailable', code, derived: true })
    await h.service.setWeixinRuntime({ ...report, state: 'unavailable', error: { code } })
    const state = await h.disk.read(), identity = state.channelIdentities[0]
    assert.equal(h.counts.updates, 1, 'same invalid runtime state still requires derived cleanup')
    assert.equal(identity.status, 'rebind-required'); assert.equal(identity.activeConversationId, null); assert.equal(identity.revision, 2)
    assert.equal(state.channelConversations[0].status, 'rebind-required'); assert.equal(state.channelConversations[0].revision, 2)
    assert.deepEqual(state.deliveries.map(item => item.status), ['blocked', 'unknown', 'delivered'])
    assert.equal(state.linkCodes[0].status, 'cancelled'); assert.equal(state.linkCodes[0].error.code, 'WEIXIN_REBIND_REQUIRED')
    const sticky = await h.snapshot()
    for (const input of [{ state: 'unavailable', error: { code: 'WEIXIN_LOCK_LOST' } }, { state: 'stopped' }]) await h.service.setWeixinRuntime({ ...report, ...input })
    assert.equal(h.counts.updates, 1); assert.deepEqual(await h.snapshot(), sticky)
    assert.equal((await currentIdentity(h)).weixin.error.code, code)
  }
  const failing = await fixtures(), readFailure = Object.assign(new Error('synthetic reliable read failed'), { code: 'STORE_UNAVAILABLE' })
  failing.hooks.readFailure = readFailure
  await assert.rejects(failing.service.setWeixinRuntime(report), error => error === readFailure)
  assert.equal(failing.counts.updates, 0)
  delete failing.hooks.readFailure
  await failing.service.setWeixinRuntime(report)
  assert.equal(failing.counts.reads, 2); assert.equal(failing.counts.updates, 0)
  const persistFailure = new Error('synthetic persist failed')
  failing.hooks.persistFailure = persistFailure
  await assert.rejects(failing.service.setWeixinRuntime({ ...report, state: 'reconnecting' }), error => error === persistFailure)
  assert.equal((await currentIdentity(failing)).weixin.runtimeState, 'connected')
  delete failing.hooks.persistFailure
  await failing.service.setWeixinRuntime({ ...report, state: 'reconnecting' })
  assert.equal(failing.counts.updates, 2); assert.equal(failing.counts.publishes, 1)
  assert.equal((await currentIdentity(failing)).weixin.runtimeState, 'reconnecting')
}
