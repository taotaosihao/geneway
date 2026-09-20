import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelService } from '../src/channel-service.mjs'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p4-channel-'))
let currentTime = '2026-09-20T00:00:00.000Z'
let sequence = 0

try {
  checkMigrations()
  const statePath = join(root, 'state.json')
  await writeFile(statePath, JSON.stringify(v5Fixture()), { mode: 0o600 })
  const store = createFileStore(statePath)
  const service = createChannelService({ store, clock: () => currentTime, idFactory: () => String(++sequence) })
  const admin = { id: 'member-admin' }, owner = { id: 'member-owner' }, peer = { id: 'member-peer' }

  await assert.rejects(service.upsertChannelApp(owner, appInput('app-1', 'official-app-1')), hasCode('FORBIDDEN'))
  const app1 = await service.upsertChannelApp(admin, appInput('app-1', 'official-app-1'))
  const app2 = await service.upsertChannelApp(admin, appInput('app-2', 'official-app-2'))
  await service.setChannelAppRuntime({ channelAppId: app1.id, revision: app1.revision, providerAppId: app1.providerAppId, providerTenantId: app1.providerTenantId, available: true })
  await service.setChannelAppRuntime({ channelAppId: app2.id, revision: app2.revision, providerAppId: app2.providerAppId, providerTenantId: app2.providerTenantId, available: true })
  assert.equal(app1.credentialRef, 'FEISHU_APP_SECRET_REF')
  assert.equal((await service.listChannelApps(owner))[0].credentialRef, undefined)
  await assert.rejects(service.upsertChannelApp(admin, { id: 'app-1', providerAppId: 'replacement' }), hasCode('INVALID_REQUEST'))

  const first = await service.issueLinkCode(owner, { channelAppId: app1.id })
  const firstCode = first.code
  assert.equal(Buffer.from(firstCode, 'base64url').length, 32)
  assert.equal(first.digest, undefined)
  let state = await store.read()
  assert.equal(state.linkCodes[0].digest, createHash('sha256').update(firstCode).digest('hex'))
  assert.equal(JSON.stringify(state).includes(firstCode), false)
  assert.equal(Date.parse(state.linkCodes[0].expiresAt) - Date.parse(state.linkCodes[0].createdAt), 10 * 60 * 1000)
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await assert.rejects(service.matchLinkCode({ channelAppId: app1.id, code: firstCode, providerUserId: 'external-user', providerConversationId: 'private-1', conversationType: 'group' }), hasCode('LINK_CODE_INVALID'))
    assert.equal((await store.read()).linkCodes[0].failedAttempts, attempt)
  }
  assert.equal((await store.read()).linkCodes[0].status, 'cancelled')

  const second = await service.issueLinkCode(owner, { channelAppId: app1.id })
  const secondCode = second.code
  await assert.rejects(service.matchLinkCode({ channelAppId: app1.id, code: 'unknown-code', providerUserId: 'external-user', providerConversationId: 'private-1', conversationType: 'private' }), hasCode('LINK_CODE_INVALID'))
  assert.equal((await store.read()).linkCodes.find(item => item.id === second.id).failedAttempts, 0)
  const matched1 = await service.matchLinkCode({ channelAppId: app1.id, code: secondCode, providerUserId: 'external-user', providerConversationId: 'private-1', conversationType: 'private' })
  await service.confirmLink(owner, { linkCodeId: matched1.id })
  await assert.rejects(service.confirmLink(owner, { linkCodeId: matched1.id }), hasCode('LINK_CODE_INVALID'))

  const crossApp = await service.issueLinkCode(owner, { channelAppId: app2.id })
  const matched2 = await service.matchLinkCode({ channelAppId: app2.id, code: crossApp.code, providerUserId: 'external-user', providerConversationId: 'private-1', conversationType: 'private' })
  await service.confirmLink(owner, { linkCodeId: matched2.id })
  state = await store.read()
  assert.equal(state.channelIdentities.filter(item => item.providerUserId === 'external-user').length, 2)

  const conflict = await service.issueLinkCode(peer, { channelAppId: app1.id })
  await assert.rejects(service.matchLinkCode({ channelAppId: app1.id, code: conflict.code, providerUserId: 'external-user', providerConversationId: 'peer-private', conversationType: 'private' }), hasCode('LINK_CODE_INVALID'))
  assert.equal((await store.read()).linkCodes.find(item => item.id === conflict.id).failedAttempts, 1)

  const ownerState = await service.memberChannelState(owner)
  const identity1 = ownerState.identities.find(item => item.channelAppId === app1.id)
  const conversation1 = ownerState.conversations.find(item => item.channelAppId === app1.id)
  const identity2 = ownerState.identities.find(item => item.channelAppId === app2.id)
  const conversation2 = ownerState.conversations.find(item => item.channelAppId === app2.id)
  const dispatchInput = { conversationId: conversation1.id, employeeId: 'employee-1', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-1' }
  for (const [mutate, restore] of [
    [state => { state.employees.find(item => item.id === 'employee-1').enabled = false }, state => { state.employees.find(item => item.id === 'employee-1').enabled = true }],
    [state => { state.skills.find(item => item.id === 'skill-gearjob-work-order-read').enabled = false }, state => { state.skills.find(item => item.id === 'skill-gearjob-work-order-read').enabled = true }],
    [state => { state.connections.find(item => item.id === 'connection-1').enabled = false }, state => { state.connections.find(item => item.id === 'connection-1').enabled = true }],
    [state => { state.connections.find(item => item.id === 'connection-1').status = 'unknown' }, state => { state.connections.find(item => item.id === 'connection-1').status = 'ready' }],
    [state => { state.connections.find(item => item.id === 'connection-1').skillIds = ['skill-1'] }, state => { state.connections.find(item => item.id === 'connection-1').skillIds = ['skill-1', 'skill-gearjob-work-order-read'] }],
  ]) {
    await store.update(state => { mutate(state); return state })
    await assert.rejects(service.setDefaultDispatch(owner, dispatchInput), hasCode('FORBIDDEN'))
    await store.update(state => { restore(state); return state })
  }
  await assert.rejects(service.setDefaultDispatch(owner, { ...dispatchInput, skillId: 'skill-1', capabilityId: 'capability-1' }), hasCode('FORBIDDEN'))
  await assert.rejects(service.setDefaultDispatch(owner, { ...dispatchInput, connectionId: undefined }), hasCode('FORBIDDEN'))
  const configuredDispatch = await service.setDefaultDispatch(owner, dispatchInput)
  await assert.rejects(service.setDefaultDispatch(peer, dispatchInput), hasCode('NOT_FOUND'))
  const clearDelivery = await service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-clear-default', workId: 'work-1', resultId: 'result-1', targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' })
  const clearedDispatch = await service.clearDefaultDispatch(owner, { conversationId: conversation1.id })
  assert.equal(clearedDispatch.defaultDispatch, undefined)
  assert.equal(clearedDispatch.revision, configuredDispatch.revision + 1)
  assert.equal((await store.read()).deliveries.find(item => item.id === clearDelivery.delivery.id).status, 'pending')
  assert.deepEqual(await service.clearDefaultDispatch(owner, { conversationId: conversation1.id }), clearedDispatch)
  assert.equal((await service.memberChannelState(owner)).conversations.find(item => item.id === conversation1.id).defaultDispatch, undefined)
  await assert.rejects(service.clearDefaultDispatch(peer, { conversationId: conversation1.id }), hasCode('NOT_FOUND'))
  await service.cancelDelivery(owner, { deliveryId: clearDelivery.delivery.id })
  await service.setDefaultDispatch(owner, dispatchInput)

  const received = await service.recordInbound({ channelAppId: app1.id, providerEventId: 'event-1', providerMessageId: 'message-1', providerConversationId: 'private-1', providerUserId: 'external-user', text: '交办 工单 WO-1' })
  assert.equal(received.message.status, 'received')
  const duplicate = await service.recordInbound({ channelAppId: app1.id, providerEventId: 'event-1', providerMessageId: 'message-other', providerConversationId: 'private-1', providerUserId: 'external-user', text: '不会覆盖' })
  assert.equal(duplicate.deduplicated, false)
  assert.equal(duplicate.message.status, 'rejected')
  assert.equal(duplicate.message.providerEventId, undefined)
  assert.equal(duplicate.message.providerMessageId, 'message-other')
  const conflictReplay = await service.recordInbound({ channelAppId: app1.id, providerMessageId: 'message-other', providerConversationId: 'private-1', providerUserId: 'external-user', text: '单独重投' })
  assert.equal(conflictReplay.deduplicated, true)
  assert.equal(conflictReplay.message.id, duplicate.message.id)
  const unhandled = await service.recordInbound({ channelAppId: app1.id, providerEventId: 'event-unhandled', providerConversationId: 'unknown-private', providerUserId: 'unknown-user', text: 'unknown' })
  assert.equal(unhandled.message.status, 'unhandled')
  await store.update(value => ({ ...value, channelMessages: value.channelMessages.map(item => item.id === received.message.id ? { ...item, status: 'accepted', workId: 'work-1' } : item) }))
  const acceptedMessage = (await store.read()).channelMessages.find(item => item.id === received.message.id)
  assert.equal(acceptedMessage.status, 'accepted')
  assert.equal('provider' in acceptedMessage, false)
  assert.equal('provider' in conversation1, false)

  const delivery1 = await service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-1', workId: 'work-1', resultId: 'result-1', channelMessageId: received.message.id, targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' })
  const delivery1Again = await service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-1', workId: 'work-1', resultId: 'result-1', channelMessageId: received.message.id, targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' })
  assert.equal(delivery1Again.deduplicated, true)
  assert.equal(delivery1Again.delivery.id, delivery1.delivery.id)
  await assert.rejects(service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-1', workId: 'work-1', resultId: 'result-1', targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' }), hasCode('FORBIDDEN'))
  await assert.rejects(service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-1', workId: 'work-2', targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' }), hasCode('FORBIDDEN'))
  await assert.rejects(service.createDelivery(peer, { channelAppId: app1.id, requestId: 'request-1', workId: 'work-1', resultId: 'result-1', channelMessageId: received.message.id, targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' }), hasCode('NOT_FOUND'))
  const crossAppRequest = await service.createDelivery(owner, { channelAppId: app2.id, requestId: 'request-1', workId: 'work-1', resultId: 'result-1', targetIdentityId: identity2.id, targetConversationId: conversation2.id, contentScope: 'result' })
  assert.notEqual(crossAppRequest.delivery.id, delivery1.delivery.id)
  assert.equal('provider' in delivery1.delivery, false)

  let sending = await service.authorizeDelivery({ deliveryId: delivery1.delivery.id })
  assert.equal(sending.status, 'sending')
  assert.equal(sending.attempts, 1)
  assert.equal((await service.validateSendClaim({ deliveryId: sending.id })).id, sending.id)
  assert.equal((await store.read()).deliveries.find(item => item.id === sending.id).status, 'sending')
  let unknown = await service.recordDeliveryOutcome({ deliveryId: sending.id, status: 'unknown' })
  assert.equal(unknown.status, 'unknown')
  await assert.rejects(service.retryDelivery({ deliveryId: unknown.id }), hasCode('INVALID_STATE'))
  let failed = await service.reconcileDelivery({ deliveryId: unknown.id, status: 'failed', error: { code: 'PLATFORM_CONFIRMED_FAILED', message: '平台确认未送达' } })
  assert.equal(failed.status, 'failed')
  sending = await service.retryDelivery({ deliveryId: failed.id })
  assert.equal(sending.attempts, 2)
  const delivered = await service.recordDeliveryOutcome({ deliveryId: sending.id, status: 'delivered', providerMessageId: 'provider-message-1' })
  assert.equal(delivered.status, 'delivered')
  await assert.rejects(service.retryDelivery({ deliveryId: delivered.id }), hasCode('INVALID_STATE'))

  const beforeRotation = (await service.listChannelApps(admin)).find(item => item.id === app1.id)
  const rotationPending = await service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-rotation-pending', workId: 'work-1', targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' })
  const rotationClaim = await service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-rotation-claim', workId: 'work-1', targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' })
  await service.authorizeDelivery({ deliveryId: rotationClaim.delivery.id })
  const rotated = await service.upsertChannelApp(admin, { id: app1.id, credentialRef: 'FEISHU_ROTATED_SECRET_REF' })
  assert.equal(rotated.revision, beforeRotation.revision + 1)
  assert.equal(rotated.status, 'unavailable')
  assert.equal((await service.recordInbound({ channelAppId: app1.id, providerEventId: 'event-during-rotation', providerConversationId: 'private-1', providerUserId: 'external-user', text: '交办 工单 WO-1' })).message.status, 'unhandled')
  await assert.rejects(service.issueLinkCode(owner, { channelAppId: app1.id }), hasCode('NOT_FOUND'))
  await assert.rejects(service.authorizeDelivery({ deliveryId: rotationPending.delivery.id }), hasCode('DELIVERY_FORBIDDEN'))
  await assert.rejects(service.validateSendClaim({ deliveryId: rotationClaim.delivery.id }), hasCode('INVALID_STATE'))
  assert.equal((await store.read()).deliveries.find(item => item.id === rotationClaim.delivery.id).status, 'unknown')
  await assert.rejects(service.setChannelAppRuntime({ channelAppId: app1.id, revision: beforeRotation.revision, providerAppId: app1.providerAppId, providerTenantId: app1.providerTenantId, available: true }), hasCode('CHANNEL_RUNTIME_STALE'))
  await service.setChannelAppRuntime({ channelAppId: app1.id, revision: rotated.revision, providerAppId: rotated.providerAppId, providerTenantId: rotated.providerTenantId, available: true })
  assert.equal((await service.listChannelApps(owner)).some(item => item.id === app1.id), true)

  const blockedCandidate = await service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-blocked', workId: 'work-1', resultId: 'result-1', targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' })
  const pendingCandidate = await service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-pending-disabled', workId: 'work-1', resultId: 'result-1', targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' })
  await service.authorizeDelivery({ deliveryId: blockedCandidate.delivery.id })
  assert.equal((await service.validateSendClaim({ deliveryId: blockedCandidate.delivery.id })).status, 'sending')
  await service.upsertChannelApp(admin, { id: app1.id, enabled: false })
  await assert.rejects(service.clearDefaultDispatch(owner, { conversationId: conversation1.id }), hasCode('NOT_FOUND'))
  await assert.rejects(service.validateSendClaim({ deliveryId: blockedCandidate.delivery.id }), hasCode('INVALID_STATE'))
  assert.equal((await store.read()).deliveries.find(item => item.id === blockedCandidate.delivery.id).status, 'unknown')
  assert.equal((await store.read()).deliveries.find(item => item.id === pendingCandidate.delivery.id).status, 'blocked')
  await assert.rejects(service.retryDelivery({ deliveryId: blockedCandidate.delivery.id }), hasCode('INVALID_STATE'))
  assert.equal((await service.reconcileDelivery({ deliveryId: blockedCandidate.delivery.id, status: 'delivered', providerMessageId: 'late-provider-message' })).status, 'delivered')
  const reenabledApp = await service.upsertChannelApp(admin, { id: app1.id, enabled: true })
  await service.setChannelAppRuntime({ channelAppId: app1.id, revision: reenabledApp.revision, providerAppId: reenabledApp.providerAppId, providerTenantId: reenabledApp.providerTenantId, available: true })
  sending = await service.retryDelivery({ deliveryId: pendingCandidate.delivery.id })
  assert.equal(sending.status, 'sending')
  assert.equal(sending.attempts, 1)
  await service.recordDeliveryOutcome({ deliveryId: pendingCandidate.delivery.id, status: 'failed' })

  await service.authorizeDelivery({ deliveryId: crossAppRequest.delivery.id })
  await service.unlinkIdentity(owner, { identityId: identity2.id })
  await assert.rejects(service.clearDefaultDispatch(owner, { conversationId: conversation2.id }), hasCode('NOT_FOUND'))
  assert.equal((await store.read()).deliveries.find(item => item.id === crossAppRequest.delivery.id).status, 'unknown')
  await assert.rejects(service.validateSendClaim({ deliveryId: crossAppRequest.delivery.id }), hasCode('INVALID_STATE'))
  await assert.rejects(service.retryDelivery({ deliveryId: crossAppRequest.delivery.id }), hasCode('INVALID_STATE'))
  assert.equal((await service.reconcileDelivery({ deliveryId: crossAppRequest.delivery.id, status: 'failed' })).status, 'failed')

  const recoveryCandidate = await service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-recovery', workId: 'work-1', resultId: 'result-1', targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' })
  await service.authorizeDelivery({ deliveryId: recoveryCandidate.delivery.id })
  const beforeRecovery = await store.read()
  const recovery = await service.recover()
  const afterRecovery = await store.read()
  assert.deepEqual(recovery, { recoveredDeliveries: 1, startedMessages: 0, retriedDeliveries: 0 })
  assert.equal(afterRecovery.deliveries.find(item => item.id === recoveryCandidate.delivery.id).status, 'unknown')
  assert.equal(afterRecovery.deliveries.find(item => item.id === delivered.id).status, 'delivered')
  assert.deepEqual(afterRecovery.works, beforeRecovery.works)
  assert.deepEqual(afterRecovery.channelMessages, beforeRecovery.channelMessages)
  assert.equal(JSON.stringify(afterRecovery).includes(secondCode), false)

  const revokedKnowledge = await service.createDelivery(owner, { channelAppId: app1.id, requestId: 'request-revoked-knowledge', workId: 'work-1', resultId: 'result-1', targetIdentityId: identity1.id, targetConversationId: conversation1.id, contentScope: 'result' })
  await service.authorizeDelivery({ deliveryId: revokedKnowledge.delivery.id })
  await store.update(value => ({ ...value, knowledgeMaterials: value.knowledgeMaterials.map(item => item.id === 'knowledge-1' ? { ...item, revision: 2, updatedAt: currentTime } : item) }))
  await assert.rejects(service.validateSendClaim({ deliveryId: revokedKnowledge.delivery.id }), hasCode('DELIVERY_FORBIDDEN'))
  assert.equal((await store.read()).deliveries.find(item => item.id === revokedKnowledge.delivery.id).status, 'blocked')

  const expiring = await service.issueLinkCode(owner, { channelAppId: app1.id })
  currentTime = '2026-09-20T00:11:00.000Z'
  assert.ok((await service.expireLinkCodes()).expired >= 1)
  assert.equal((await store.read()).linkCodes.find(item => item.id === expiring.id).status, 'expired')
  await assert.rejects(service.confirmLink(owner, { linkCodeId: expiring.id }), hasCode('LINK_CODE_INVALID'))

  checkClosedGraph(await store.read())
  console.log('P4 channel/state checks passed; work dispatch=0; external send=0')
} finally {
  await rm(root, { recursive: true, force: true })
}

function checkMigrations() {
  assert.equal(STATE_VERSION, 7)
  const fromV3 = migrateState({ version: 3 })
  assert.equal(fromV3.version, 7)
  for (const key of ['channelApps', 'channelIdentities', 'channelConversations', 'channelMessages', 'deliveries', 'linkCodes']) assert.deepEqual(fromV3[key], [])
  const v4 = v4Fixture(), fromV4 = migrateState(v4)
  assert.equal(fromV4.version, 7)
  assert.deepEqual(fromV4.works, v4.works)
  const v5 = v5Fixture(), fromV5 = migrateState(v5)
  assert.equal(fromV5.version, 7)
  assert.deepEqual(fromV5.knowledgeMaterials, v5.knowledgeMaterials)
  assert.deepEqual(migrateState(structuredClone(fromV5)), fromV5)
  assert.throws(() => migrateState({ version: 8 }), /未来/)
}

function checkClosedGraph(state) {
  const damagedIdentity = structuredClone(state)
  damagedIdentity.channelIdentities[0].channelAppId = 'missing-app'
  assert.throws(() => migrateState(damagedIdentity), /引用不存在/)
  const duplicateIdentity = structuredClone(state)
  duplicateIdentity.channelIdentities.push({ ...duplicateIdentity.channelIdentities[0], id: 'duplicate-identity' })
  assert.throws(() => migrateState(duplicateIdentity), /官方 identity 重复/)
  const crossAppConversation = structuredClone(state)
  crossAppConversation.channelConversations[0].channelAppId = 'app-2'
  crossAppConversation.channelConversations[0].providerConversationId = 'cross-app-invalid'
  assert.throws(() => migrateState(crossAppConversation), /引用不闭合/)
  const duplicateRequest = structuredClone(state)
  duplicateRequest.deliveries.push({ ...duplicateRequest.deliveries[0], id: 'duplicate-delivery' })
  assert.throws(() => migrateState(duplicateRequest), /投递 request 重复/)

  const acceptedWithoutConversation = structuredClone(state)
  delete acceptedWithoutConversation.channelMessages.find(item => item.status === 'accepted').conversationId
  assert.throws(() => migrateState(acceptedWithoutConversation), /accepted 引用不闭合/)
  for (const damage of [
    item => { item.direction = 'outbound' },
    item => { item.providerUserId = 'wrong-official-user' },
    item => { item.providerConversationId = 'wrong-official-conversation' },
  ]) {
    const damaged = structuredClone(state)
    damage(damaged.channelMessages.find(item => item.status === 'accepted'))
    assert.throws(() => migrateState(damaged), /accepted 引用不闭合/)
  }

  for (const [status, damage] of [
    ['pending', item => { item.status = 'pending'; item.attempts = 1; delete item.authorizationRevisions; delete item.providerMessageId; delete item.error }],
    ['sending', item => { item.status = 'sending'; item.attempts = 1; delete item.authorizationRevisions; delete item.providerMessageId; delete item.error }],
    ['delivered', item => { item.status = 'delivered'; item.attempts = 1; delete item.providerMessageId; delete item.error }],
    ['failed', item => { item.status = 'failed'; item.attempts = 1; delete item.error }],
    ['blocked', item => { item.status = 'blocked'; delete item.providerMessageId; delete item.error }],
    ['cancelled', item => { item.status = 'cancelled'; item.providerMessageId = 'not-allowed' }],
  ]) {
    const damaged = structuredClone(state)
    damage(damaged.deliveries[0])
    assert.throws(() => migrateState(damaged), new RegExp(`${status} 状态不闭合`))
  }

  const historical = structuredClone(state)
  const identity = historical.channelIdentities.find(item => item.channelAppId === 'app-1')
  const conversation = historical.channelConversations.find(item => item.identityId === identity.id)
  Object.assign(identity, { status: 'unlinked', revision: identity.revision + 1, updatedAt: '2026-09-20T00:11:00.000Z', unlinkedAt: '2026-09-20T00:11:00.000Z' })
  Object.assign(conversation, { status: 'unlinked', revision: conversation.revision + 1, updatedAt: '2026-09-20T00:11:00.000Z', unlinkedAt: '2026-09-20T00:11:00.000Z' })
  assert.equal(migrateState(historical).channelMessages.find(item => item.status === 'accepted').workId, 'work-1')
}

function appInput(id, providerAppId) {
  return { id, provider: 'feishu', providerAppId, providerTenantId: 'tenant-1', credentialRef: 'FEISHU_APP_SECRET_REF', enabled: true, allowedScopes: ['result', 'knowledge'], status: 'active' }
}

function hasCode(code) { return value => value?.code === code }

function v4Fixture() {
  const value = v5Fixture()
  value.version = 4
  delete value.knowledgeMaterials
  value.works[0].results[0] = { ...value.works[0].results[0] }
  delete value.works[0].results[0].knowledgeDependencyRefs
  return value
}

function v5Fixture() {
  const timestamp = '2026-09-20T00:00:00.000Z'
  return {
    version: 5,
    members: [
      member('member-admin', 'admin', ['employee-1']),
      member('member-owner', 'member', ['employee-1']),
      member('member-peer', 'member', ['employee-peer']),
    ],
    modelRoutes: [],
    employees: [
      { id: 'employee-1', enabled: true, connectionIds: ['connection-1'], skillIds: ['skill-1', 'skill-gearjob-work-order-read'] },
      { id: 'employee-peer', enabled: true, connectionIds: [], skillIds: ['skill-peer'] },
    ],
    connections: [{ id: 'connection-1', enabled: true, status: 'ready', skillIds: ['skill-1', 'skill-gearjob-work-order-read'] }],
    skills: [{ id: 'skill-1', enabled: true, capabilityId: 'capability-1' }, { id: 'skill-gearjob-work-order-read', enabled: true, capabilityId: 'gearjob-work-order-read' }, { id: 'skill-peer', enabled: true, capabilityId: 'capability-peer' }],
    confirmations: [],
    knowledgeMaterials: [{ id: 'knowledge-1', ownerMemberId: 'member-owner', employeeIds: ['employee-1'], sharedMemberIds: [], sharedEmployeeIds: [], title: 'Knowledge', body: 'approved content', format: 'text', sourceLabel: 'fixture', authorizationBasis: 'test', revision: 1, status: 'active', createdAt: timestamp, updatedAt: timestamp }],
    works: [{
      id: 'work-1', ownerMemberId: 'member-owner', employeeId: 'employee-1', skillId: 'skill-1', capabilityId: 'capability-1', status: 'completed',
      connectionId: 'connection-1',
      results: [{ id: 'result-1', kind: 'assistant.follow-up', capabilityId: 'capability-1', skillId: 'skill-1', schemaVersion: 1, input: { text: 'result' }, payload: { text: 'result' }, createdAt: timestamp, dshSessionRef: 'session-1', contextConfirmationRefs: [], knowledgeDependencyRefs: [{ knowledgeId: 'knowledge-1', revision: 1, segmentId: 'p1-c1' }] }],
      executions: [{ id: 'execution-1', status: 'completed', resultId: 'result-1' }],
    }, { id: 'work-2', ownerMemberId: 'member-owner', employeeId: 'employee-1', skillId: 'skill-1', capabilityId: 'capability-1', connectionId: 'connection-1', status: 'waiting_input', results: [], executions: [] }],
    reservations: {},
  }
}

function member(id, role, employeeIds) {
  return { id, loginName: id, displayName: id, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' }
}
