import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelService } from '../src/channel-service.mjs'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p4-feishu-channel-'))
let sequence = 0
const store = createFileStore(join(root, 'state.json'))
const runner = fakeRunner()
const clock = () => '2026-09-20T08:00:00.000Z'
const idFactory = () => `feishu-${++sequence}`
const workService = createWorkService({ store, runner, connectionCatalog: [catalogTarget()] })
const channel = createChannelService({ store, workService, clock, idFactory })
const owner = { id: 'member-owner' }

try {
  await store.update(seedState)
  await runtimeOwnership()
  await groupAdmissionAndOutbound()
  await deliveryOutcomesAndRecovery()
  console.log('P4 Feishu channel contract checks passed; platform calls=0; group sensitive disclosure=0; unknown retries=0')
} finally {
  await workService.close()
  await rm(root, { recursive: true, force: true })
}

async function runtimeOwnership() {
  const configured = await channel.upsertChannelApp({ id: 'member-admin' }, {
    id: 'app-2', provider: 'feishu', providerAppId: 'official-app-2', providerTenantId: 'tenant-2', credentialRef: 'FEISHU_APP_2_SECRET', enabled: true, allowedScopes: ['result'], status: 'active',
  })
  assert.equal(configured.status, 'unavailable')
  assert.equal((await channel.listChannelApps(owner)).some(item => item.id === configured.id), false)
  await assert.rejects(channel.setChannelAppRuntime({ channelAppId: configured.id, revision: 999, providerAppId: configured.providerAppId, providerTenantId: configured.providerTenantId, available: true }), hasCode('CHANNEL_RUNTIME_STALE'))
  await channel.setChannelAppRuntime({ channelAppId: configured.id, revision: configured.revision, providerAppId: configured.providerAppId, providerTenantId: configured.providerTenantId, available: true })
  assert.equal((await channel.listChannelApps(owner)).some(item => item.id === configured.id), true)
  await channel.setChannelAppRuntime({ channelAppId: configured.id, revision: configured.revision, providerAppId: configured.providerAppId, providerTenantId: configured.providerTenantId, available: false })
  assert.equal((await channel.listChannelApps(owner)).some(item => item.id === configured.id), false)
  assert.equal((await channel.listChannelApps(owner)).some(item => item.id === 'app-1'), true)
}

async function groupAdmissionAndOutbound() {
  const noMention = await channel.handleInbound(groupEvent('no-mention', '交办 工单 WO-1', { botMentioned: false }))
  assert.equal(noMention.code, 'CHANNEL_UNAVAILABLE')
  assert.equal((await store.read()).works.length, 0)

  const peer = await channel.handleInbound(groupEvent('peer', '交办 工单 WO-1', { providerUserId: 'provider-peer' }))
  assert.equal(peer.code, 'CHANNEL_UNAVAILABLE')
  assert.equal((await store.read()).works.length, 0)

  const noDm = await channel.handleInbound(groupEvent('no-dm', '交办 工单 WO-1', { channelAppId: 'app-no-dm', providerUserId: 'provider-no-dm', providerConversationId: 'group-no-dm' }))
  assert.equal(noDm.code, 'CHANNEL_UNAVAILABLE')
  assert.equal((await store.read()).works.length, 0)

  const gate = runner.holdNext()
  const accepted = await channel.handleInbound(groupEvent('accepted', '交办 工单 WO-1'))
  assert.equal(accepted.code, 'WORK_ACCEPTED')
  const repeated = await channel.handleInbound(groupEvent('accepted', '交办 工单 WO-2'))
  assert.equal(repeated.workId, accepted.workId)
  assert.equal(runner.calls.length, 1)
  const durableBeforeRunnerCompletion = await store.read()
  assert.equal(durableBeforeRunnerCompletion.channelMessages.find(item => item.providerEventId === 'event-accepted').status, 'accepted')
  assert.equal(durableBeforeRunnerCompletion.works.find(item => item.id === accepted.workId).executions.length, 1)
  gate.release()
  const completed = await waitWork(accepted.workId)
  const state = await store.read()
  const acceptedMessage = state.channelMessages.find(item => item.providerEventId === 'event-accepted')
  assert.equal(state.channelConversations.find(item => item.id === acceptedMessage.conversationId).type, 'group')
  assert.equal(state.works.length, 1)

  const outbound = await channel.createInboundDeliveries({ channelMessageId: acceptedMessage.id, requestId: 'accepted-feedback' })
  assert.equal(outbound.deliveries.length, 2)
  assert.equal((await channel.createInboundDeliveries({ channelMessageId: acceptedMessage.id, requestId: 'accepted-feedback' })).deduplicated, true)
  const groupDelivery = outbound.deliveries.find(item => item.contentKey === 'group.accepted')
  const privateDelivery = outbound.deliveries.find(item => item.contentKey === 'work.accepted')
  await channel.authorizeDelivery({ deliveryId: groupDelivery.id })
  const groupEnvelope = await channel.validateSendClaim({ deliveryId: groupDelivery.id })
  assert.equal(groupEnvelope.providerConversationId, 'group-owner')
  for (const secret of [accepted.workId, 'WO-1', '10', '4', 'member-owner']) assert.equal(groupEnvelope.text.includes(secret), false)
  await channel.recordDeliveryOutcome({ deliveryId: groupDelivery.id, status: 'delivered', providerMessageId: 'om-group-accepted' })

  await channel.authorizeDelivery({ deliveryId: privateDelivery.id })
  const privateEnvelope = await channel.validateSendClaim({ deliveryId: privateDelivery.id })
  assert.equal(privateEnvelope.providerConversationId, 'private-owner')
  assert.match(privateEnvelope.text, new RegExp(accepted.workId))
  assert.match(privateEnvelope.text, new RegExp(`/works/${accepted.workId}`))
  await channel.recordDeliveryOutcome({ deliveryId: privateDelivery.id, status: 'delivered', providerMessageId: 'om-private-accepted' })

  const resultDelivery = await channel.createWorkDelivery(owner, { workId: accepted.workId, resultId: completed.results[0].id, requestId: 'typed-result' })
  assert.equal(resultDelivery.delivery.targetConversationId, 'conversation-owner')
  await channel.authorizeDelivery({ deliveryId: resultDelivery.delivery.id })
  const resultEnvelope = await channel.validateSendClaim({ deliveryId: resultDelivery.delivery.id })
  for (const fact of ['工单：WO-1', '状态：In Process', '计划/完成量：10/4 Nos', 'GearJob / test / external-test / synthetic / controlled', `/works/${accepted.workId}`]) assert.match(resultEnvelope.text, new RegExp(escapeRegExp(fact)))
  await channel.recordDeliveryOutcome({ deliveryId: resultDelivery.delivery.id, status: 'delivered', providerMessageId: 'om-result' })

  const unsupported = await channel.handleInbound(groupEvent('unsupported', '随便聊聊'))
  assert.equal(unsupported.code, 'UNSUPPORTED')
  const unsupportedMessage = (await store.read()).channelMessages.find(item => item.providerEventId === 'event-unsupported')
  const fixed = await channel.createInboundDeliveries({ channelMessageId: unsupportedMessage.id, requestId: 'unsupported-feedback' })
  assert.equal(fixed.deliveries.length, 1)
  assert.equal(fixed.deliveries[0].workId, undefined)
  await channel.authorizeDelivery({ deliveryId: fixed.deliveries[0].id })
  const fixedEnvelope = await channel.validateSendClaim({ deliveryId: fixed.deliveries[0].id })
  assert.equal(fixedEnvelope.text, '当前仅支持明确文本命令，请到 Web 处理其他内容。')
  const closedState = await store.read()
  assert.doesNotThrow(() => migrateState(structuredClone(closedState)))

  const second = await channel.handleInbound(groupEvent('second-member', '交办 工单 WO-1', { providerUserId: 'provider-second' }))
  assert.equal(second.code, 'WORK_ACCEPTED')
  await waitWork(second.workId)
  const sharedGroup = await store.read()
  assert.equal(sharedGroup.channelConversations.filter(item => item.providerConversationId === 'group-owner').length, 1)
  assert.equal(sharedGroup.works.find(item => item.id === second.workId).ownerMemberId, 'member-second')
}

async function deliveryOutcomesAndRecovery() {
  const state = await store.read()
  const work = state.works[0], result = work.results[0]
  const app1 = state.channelApps.find(item => item.id === 'app-1')
  const app2 = state.channelApps.find(item => item.id === 'app-2')
  await channel.setChannelAppRuntime({ channelAppId: app2.id, revision: app2.revision, providerAppId: app2.providerAppId, providerTenantId: app2.providerTenantId, available: true })
  const deliveryInput = { channelAppId: 'app-1', workId: work.id, resultId: result.id, targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result' }

  await channel.setChannelAppRuntime({ channelAppId: app1.id, revision: app1.revision, providerAppId: app1.providerAppId, providerTenantId: app1.providerTenantId, available: false })
  await assertDeliveryCreationRejected({ ...deliveryInput, requestId: 'app-unavailable' })
  assert.equal((await channel.listChannelApps(owner)).some(item => item.id === 'app-2'), true)
  await channel.setChannelAppRuntime({ channelAppId: app1.id, revision: app1.revision, providerAppId: app1.providerAppId, providerTenantId: app1.providerTenantId, available: true })

  await store.update(current => ({ ...current, channelIdentities: current.channelIdentities.map(item => item.id === 'identity-owner' ? { ...item, status: 'unlinked', revision: item.revision + 1, updatedAt: clock(), unlinkedAt: clock() } : item) }))
  await assertDeliveryCreationRejected({ ...deliveryInput, requestId: 'identity-unlinked' })
  await store.update(current => ({ ...current, channelIdentities: current.channelIdentities.map(item => {
    if (item.id !== 'identity-owner') return item
    const { unlinkedAt: _unlinkedAt, ...active } = item
    return { ...active, status: 'active', revision: item.revision + 1, updatedAt: clock() }
  }) }))

  await store.update(current => ({ ...current, channelConversations: current.channelConversations.map(item => item.id === 'conversation-owner' ? { ...item, status: 'unlinked', revision: item.revision + 1, updatedAt: clock(), unlinkedAt: clock() } : item) }))
  await assertDeliveryCreationRejected({ ...deliveryInput, requestId: 'conversation-unlinked' })
  await store.update(current => ({ ...current, channelConversations: current.channelConversations.map(item => {
    if (item.id !== 'conversation-owner') return item
    const { unlinkedAt: _unlinkedAt, ...active } = item
    return { ...active, status: 'active', revision: item.revision + 1, updatedAt: clock() }
  }) }))

  const derived = await channel.createDelivery(owner, { channelAppId: 'app-1', requestId: 'derived-content', workId: work.id, resultId: result.id, targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result' })
  assert.equal(derived.delivery.contentKey, 'result.gearjob')

  const removedBeforeAuthorize = await channel.createWorkDelivery(owner, { workId: work.id, resultId: result.id, requestId: 'object-removed-before-authorize' })
  await setAllowedObjects([])
  await assert.rejects(channel.authorizeDelivery({ deliveryId: removedBeforeAuthorize.delivery.id }), hasCode('DELIVERY_FORBIDDEN'))
  assert.equal((await store.read()).deliveries.find(item => item.id === removedBeforeAuthorize.delivery.id).status, 'blocked')
  await setAllowedObjects(['WO-1'])

  const removedBeforeClaim = await channel.createWorkDelivery(owner, { workId: work.id, resultId: result.id, requestId: 'object-removed-before-claim' })
  await channel.authorizeDelivery({ deliveryId: removedBeforeClaim.delivery.id })
  await setAllowedObjects([])
  await assert.rejects(channel.validateSendClaim({ deliveryId: removedBeforeClaim.delivery.id }), hasCode('DELIVERY_FORBIDDEN'))
  assert.equal((await store.read()).deliveries.find(item => item.id === removedBeforeClaim.delivery.id).status, 'blocked')
  await setAllowedObjects(['WO-1'])

  const failed = await channel.createWorkDelivery(owner, { workId: work.id, resultId: result.id, requestId: 'failed-result' })
  await channel.authorizeDelivery({ deliveryId: failed.delivery.id })
  const firstClaim = await channel.validateSendClaim({ deliveryId: failed.delivery.id })
  await channel.recordDeliveryOutcome({ deliveryId: failed.delivery.id, status: 'failed', error: { code: 'SDK_FAILED', message: 'ignored' } })
  await channel.retryDelivery({ deliveryId: failed.delivery.id })
  const secondClaim = await channel.validateSendClaim({ deliveryId: failed.delivery.id })
  assert.equal(firstClaim.deliveryId, secondClaim.deliveryId)
  assert.equal(firstClaim.attempt, 1)
  assert.equal(secondClaim.attempt, 2)
  assert.notEqual(firstClaim.uuid, secondClaim.uuid)
  await channel.recordDeliveryOutcome({ deliveryId: failed.delivery.id, status: 'unknown' })
  await assert.rejects(channel.retryDelivery({ deliveryId: failed.delivery.id }), hasCode('INVALID_STATE'))

  const revoked = await channel.createWorkDelivery(owner, { workId: work.id, resultId: result.id, requestId: 'revoked-before-send' })
  await channel.authorizeDelivery({ deliveryId: revoked.delivery.id })
  await channel.unlinkIdentity(owner, { identityId: 'identity-owner' })
  await assert.rejects(channel.validateSendClaim({ deliveryId: revoked.delivery.id }), hasCode('INVALID_STATE'))
  assert.equal((await store.read()).deliveries.find(item => item.id === revoked.delivery.id).status, 'unknown')

  const recoveryState = await store.read()
  const sending = recoveryState.deliveries.find(item => item.id === failed.delivery.id)
  assert.equal(sending.status, 'unknown')
  const restored = migrateState(structuredClone(recoveryState))
  assert.equal(restored.deliveries.find(item => item.id === failed.delivery.id).status, 'unknown')
  assert.deepEqual(await channel.recover(), { recoveredDeliveries: 0, startedMessages: 0, retriedDeliveries: 0 })
}

async function assertDeliveryCreationRejected(input) {
  const before = (await store.read()).deliveries.length
  await assert.rejects(channel.createDelivery(owner, input), hasCode('FORBIDDEN'))
  assert.equal((await store.read()).deliveries.length, before)
}

async function setAllowedObjects(allowedObjectIds) {
  await store.update(state => ({ ...state, connections: state.connections.map(item => item.id === 'connection-owner' ? { ...item, allowedObjectIds } : item) }))
}

function seedState(state) {
  const now = '2026-09-20T00:00:00.000Z'
  const member = (id, role, employeeIds) => ({ id, loginName: id, displayName: id, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now })
  const app = (id, appId) => ({ id, provider: 'feishu', providerAppId: appId, providerTenantId: `tenant-${id}`, credentialRef: `${id.replaceAll('-', '_').toUpperCase()}_SECRET`, enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now })
  return {
    ...state,
    members: [member('member-admin', 'admin', []), member('member-owner', 'member', ['employee-owner']), member('member-second', 'member', ['employee-owner']), member('member-peer', 'member', [])],
    modelRoutes: [{ id: 'model-1', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-owner', name: '员工', enabled: true, modelRouteId: 'model-1', connectionIds: ['connection-owner'], skillIds: ['skill-gearjob-work-order-read'] }],
    connections: [{ id: 'connection-owner', name: 'GearJob', ...catalogTarget(), allowedObjectIds: ['WO-1'], enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 }],
    skills: [{ id: 'skill-gearjob-work-order-read', name: '工单查询', capabilityId: 'gearjob-work-order-read', enabled: true }],
    channelApps: [app('app-1', 'official-app-1'), app('app-no-dm', 'official-app-no-dm')],
    channelIdentities: [
      { id: 'identity-owner', channelAppId: 'app-1', providerUserId: 'provider-owner', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now },
      { id: 'identity-second', channelAppId: 'app-1', providerUserId: 'provider-second', memberId: 'member-second', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now },
      { id: 'identity-no-dm', channelAppId: 'app-no-dm', providerUserId: 'provider-no-dm', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now },
    ],
    channelConversations: [
      { id: 'conversation-owner', channelAppId: 'app-1', providerConversationId: 'private-owner', identityId: 'identity-owner', memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, defaultDispatch: { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner' }, createdAt: now, updatedAt: now },
      { id: 'conversation-second', channelAppId: 'app-1', providerConversationId: 'private-second', identityId: 'identity-second', memberId: 'member-second', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, defaultDispatch: { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner' }, createdAt: now, updatedAt: now },
    ],
  }
}

function groupEvent(id, text, overrides = {}) {
  return { channelAppId: 'app-1', providerEventId: `event-${id}`, providerMessageId: `message-${id}`, providerConversationId: 'group-owner', providerUserId: 'provider-owner', conversationType: 'group', botMentioned: true, text, ...overrides }
}

function catalogTarget() {
  return { kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'http://127.0.0.1/gearjob', credentialRef: 'gearjob.json', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' }
}

function fakeRunner() {
  const calls = [], gates = []
  return {
    configured: true,
    calls,
    holdNext() {
      let release
      const promise = new Promise(resolve => { release = resolve })
      gates.push(promise)
      return { release }
    },
    async run(args) {
      calls.push(structuredClone(args))
      const gate = gates.shift()
      if (gate) await gate
      return {
        explanation: 'fixture', dshSessionRef: `session-${calls.length}`, continuity: 'new', contextConfirmationRefs: [], eventCount: 1,
        result: {
          kind: 'gearjob.work-order.observation',
          payload: { workOrderId: args.input.workOrderId, status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', sourceRecordId: `Work Order:${args.input.workOrderId}`, sourceRevision: 'r1', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' },
          source: { sourceRecordId: `Work Order:${args.input.workOrderId}`, sourceRevision: 'r1', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' },
          toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2',
        },
      }
    },
    async cancel() {},
    async close() {},
  }
}

async function waitWork(workId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const work = (await store.read()).works.find(item => item.id === workId)
    if (work?.status === 'completed') return work
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`work did not complete: ${workId}`)
}

function hasCode(code) { return value => value?.code === code }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
