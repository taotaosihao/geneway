import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'

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
  console.log('Channel state checks passed: v9 precise notification migration, disabled old Weixin apps, tombstones, poison/conflict durability, atomic refusal and monotonic segmented ACK (stdlib only; native/model/network=0)')
} finally { await rm(root, { recursive: true, force: true }) }

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function app(id = 'app') { return { id, provider: 'feishu', providerAppId: id, providerTenantId: 'synthetic-tenant', credentialRef: 'synthetic-channel-ref', enabled: true, status: 'active', allowedScopes: ['result'], revision: 1, createdAt: now, updatedAt: now } }
function identity() { return { id: 'identity', channelAppId: 'app', providerUserId: 'synthetic-owner', memberId: 'member-admin', verificationMethod: 'link-code', status: 'active', revision: 1, defaultEmployeeId: null, activeConversationId: null, createdAt: now, updatedAt: now } }
function endpoint() { return { id: 'endpoint', channelAppId: 'app', providerConversationId: 'synthetic-private', identityId: 'identity', memberId: 'member-admin', type: 'private', verificationMethod: 'link-code', status: 'active', revision: 1, allowedScopes: ['result'], createdAt: now, updatedAt: now } }
function seed() {
  const state = migrateState({ version: 3 })
  return { ...state, employees: [{ id: 'agent', name: 'Agent', enabled: true, revision: 1, instructions: '', modelRouteId: null, skillIds: [], connectionIds: [] }], channelApps: [app()], channelIdentities: [identity()], channelConversations: [endpoint()] }
}
