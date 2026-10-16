import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelService } from '../src/channel-service.mjs'
import { createConversationService } from '../src/conversation-service.mjs'
import { currentKnowledgeAccess } from '../src/knowledge-service.mjs'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { createWeixinChannelRuntime } from '../plugins/weixin.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p4-channel-'))
let currentTime = '2026-09-20T00:00:00.000Z'
let sequence = 0
let conversations
let nativeAttempts = 0, networkAttempts = 0
const spawnOwner = childProcess.spawn, ownerChildren = []
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = () => { nativeAttempts += 1; throw new Error('NATIVE_FORBIDDEN') }
childProcess.spawn = (command, args, options) => {
  assert.equal(command, '/bin/sh')
  assert.deepEqual(args, ['-c', '/usr/bin/flock --nonblock --conflict-exit-code 73 3 || exit $?; printf ready; IFS= read -r _ || test "$?" -eq 1'])
  const child = spawnOwner(command, args, options)
  ownerChildren.push(child)
  return child
}
syncBuiltinESMExports()
Socket.prototype.connect = globalThis.fetch = () => { networkAttempts += 1; throw new Error('NETWORK_FORBIDDEN') }

try {
  checkMigrations()
  const statePath = join(root, 'state.json')
  await writeFile(statePath, JSON.stringify(v5Fixture()), { mode: 0o600 })
  const store = createFileStore(statePath)
  const runner = modelBoundary()
  conversations = createConversationService({ store, runner, clock: () => currentTime })
  const service = createChannelService({ store, conversationService: conversations, clock: () => currentTime, idFactory: () => String(++sequence) })
  const admin = { id: 'member-admin' }, owner = { id: 'member-owner' }, peer = { id: 'member-peer' }
  await service.setChannelDefaults(admin, { defaultChannelEmployeeId: 'employee-1' })

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
  await assert.rejects(service.setDefaultDispatch(owner, dispatchInput), hasCode('SOURCE_RETIRED'))
  // A retained old setting may be cleared; no API can activate it again.
  await store.update(state => ({ ...state, channelConversations: state.channelConversations.map(item => item.id === conversation1.id ? { ...item, defaultDispatch: { employeeId: dispatchInput.employeeId, skillId: dispatchInput.skillId, capabilityId: dispatchInput.capabilityId, connectionId: dispatchInput.connectionId } } : item) }))
  const clearedDispatch = await service.clearDefaultDispatch(owner, { conversationId: conversation1.id })
  assert.equal(clearedDispatch.defaultDispatch, undefined)
  assert.equal(clearedDispatch.revision, conversation1.revision + 1)
  assert.deepEqual(await service.clearDefaultDispatch(owner, { conversationId: conversation1.id }), clearedDispatch)
  assert.equal((await service.memberChannelState(owner)).conversations.find(item => item.id === conversation1.id).defaultDispatch, undefined)
  await assert.rejects(service.clearDefaultDispatch(peer, { conversationId: conversation1.id }), hasCode('NOT_FOUND'))
  const inbound = { channelAppId: app1.id, providerEventId: 'event-1', providerMessageId: 'message-1', providerConversationId: 'private-1', providerUserId: 'external-user', text: 'SYNTHETIC_NATURAL_TEXT' }
  const received = await service.recordInbound(inbound)
  assert.equal(received.message.status, 'received')
  const duplicate = await service.recordInbound({ channelAppId: app1.id, providerEventId: 'event-1', providerMessageId: 'message-other', providerConversationId: 'private-1', providerUserId: 'external-user', text: '不会覆盖' })
  assert.equal(duplicate.deduplicated, false)
  assert.equal(duplicate.message.status, 'rejected')
  assert.equal(duplicate.message.id, received.message.id)
  assert.equal((await store.read()).channelMessages.find(item => item.id === received.message.id).status, 'received')
  const conflictReplay = await service.recordInbound({ channelAppId: app1.id, providerEventId: 'event-1', providerMessageId: 'message-other', providerConversationId: 'private-1', providerUserId: 'external-user', text: '不会覆盖' })
  assert.equal(conflictReplay.message.error.code, 'OFFICIAL_ID_CONFLICT')
  assert.equal(conflictReplay.message.id, duplicate.message.id)
  assert.equal((await store.read()).channelMessages.find(item => item.id === received.message.id).conflicts.length, 1)
  const unhandled = await service.recordInbound({ channelAppId: app1.id, providerEventId: 'event-unhandled', providerConversationId: 'unknown-private', providerUserId: 'unknown-user', text: 'unknown' })
  assert.equal(unhandled.message.status, 'rejected')
  const accepted = await service.handleInbound(inbound)
  assert.equal(accepted.status, 'accepted')
  await waitCompleted(store, accepted.conversationId, accepted.turnId)
  const secondAccepted = await service.handleInbound({ ...inbound, channelAppId: app2.id })
  await waitCompleted(store, secondAccepted.conversationId, secondAccepted.turnId)
  const reply1 = { identityId: identity1.id, conversationId: accepted.conversationId, turnId: accepted.turnId, channelMessageId: accepted.messageId }
  const reply2 = { identityId: identity2.id, conversationId: secondAccepted.conversationId, turnId: secondAccepted.turnId, channelMessageId: secondAccepted.messageId }
  const acceptedMessage = (await store.read()).channelMessages.find(item => item.id === received.message.id)
  assert.equal(acceptedMessage.status, 'accepted')
  assert.equal('provider' in acceptedMessage, false)
  assert.equal('provider' in conversation1, false)

  const delivery1 = await service.createConversationDelivery(owner, { ...reply1, requestId: 'request-1' })
  const delivery1Again = await service.createConversationDelivery(owner, { ...reply1, requestId: 'request-1' })
  assert.equal(delivery1Again.deduplicated, true)
  assert.equal(delivery1Again.delivery.id, delivery1.delivery.id)
  const extra = await conversations.sendTurn(owner, accepted.conversationId, { text: 'SYNTHETIC_SECOND_TURN', clientRequestId: 'second-turn' })
  await waitCompleted(store, accepted.conversationId, extra.turn.id)
  await assert.rejects(service.createConversationDelivery(owner, { ...reply1, turnId: extra.turn.id, requestId: 'request-1' }), hasCode('CONFLICT'))
  await assert.rejects(service.createConversationDelivery(owner, { ...reply1, conversationId: reply2.conversationId, requestId: 'wrong-source' }), hasCode('NOT_FOUND'))
  await assert.rejects(service.createConversationDelivery(peer, { ...reply1, requestId: 'request-1' }), hasCode('NOT_FOUND'))
  const crossAppRequest = await service.createConversationDelivery(owner, { ...reply2, requestId: 'request-1' })
  assert.notEqual(crossAppRequest.delivery.id, delivery1.delivery.id)
  assert.equal('provider' in delivery1.delivery, false)
  const cancelled = await service.createConversationDelivery(owner, { ...reply1, requestId: 'cancel-pending' })
  await assert.rejects(service.cancelDelivery(peer, { deliveryId: cancelled.delivery.id }), hasCode('NOT_FOUND'))
  assert.equal((await service.cancelDelivery(owner, { deliveryId: cancelled.delivery.id })).status, 'cancelled')
  await assert.rejects(service.authorizeDelivery({ deliveryId: cancelled.delivery.id }), hasCode('INVALID_STATE'))

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
  const rotationPending = await service.createConversationDelivery(owner, { ...reply1, requestId: 'request-rotation-pending' })
  const rotationClaim = await service.createConversationDelivery(owner, { ...reply1, requestId: 'request-rotation-claim' })
  await service.authorizeDelivery({ deliveryId: rotationClaim.delivery.id })
  const rotated = await service.upsertChannelApp(admin, { id: app1.id, credentialRef: 'FEISHU_ROTATED_SECRET_REF' })
  assert.equal(rotated.revision, beforeRotation.revision + 1)
  assert.equal(rotated.status, 'unavailable')
  assert.equal((await service.recordInbound({ channelAppId: app1.id, providerEventId: 'event-during-rotation', providerConversationId: 'private-1', providerUserId: 'external-user', text: 'SYNTHETIC_UNAVAILABLE' })).message.status, 'rejected')
  await assert.rejects(service.issueLinkCode(owner, { channelAppId: app1.id }), hasCode('NOT_FOUND'))
  await assert.rejects(service.authorizeDelivery({ deliveryId: rotationPending.delivery.id }), hasCode('DELIVERY_FORBIDDEN'))
  await assert.rejects(service.validateSendClaim({ deliveryId: rotationClaim.delivery.id }), hasCode('INVALID_STATE'))
  assert.equal((await store.read()).deliveries.find(item => item.id === rotationClaim.delivery.id).status, 'unknown')
  await assert.rejects(service.setChannelAppRuntime({ channelAppId: app1.id, revision: beforeRotation.revision, providerAppId: app1.providerAppId, providerTenantId: app1.providerTenantId, available: true }), hasCode('CHANNEL_RUNTIME_STALE'))
  await service.setChannelAppRuntime({ channelAppId: app1.id, revision: rotated.revision, providerAppId: rotated.providerAppId, providerTenantId: rotated.providerTenantId, available: true })
  assert.equal((await service.listChannelApps(owner)).some(item => item.id === app1.id), true)

  const blockedCandidate = await service.createConversationDelivery(owner, { ...reply1, requestId: 'request-blocked' })
  const pendingCandidate = await service.createConversationDelivery(owner, { ...reply1, requestId: 'request-pending-disabled' })
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

  const recoveryCandidate = await service.createConversationDelivery(owner, { ...reply1, requestId: 'request-recovery' })
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

  const revisionStore = createFileStore(join(root, 'revision-only-state.json'))
  await revisionStore.update(() => structuredClone(afterRecovery))
  const revisionConversations = createConversationService({ store: revisionStore, runner, clock: () => currentTime })
  try {
    const revisionService = createChannelService({ store: revisionStore, conversationService: revisionConversations, clock: () => currentTime })
    const candidate = await revisionService.createConversationDelivery(owner, { ...reply1, requestId: 'request-revision-only' })
    assert.equal((await revisionService.authorizeDelivery({ deliveryId: candidate.delivery.id })).status, 'sending')
    assert.equal((await revisionService.validateSendClaim({ deliveryId: candidate.delivery.id })).status, 'sending')
    const previous = (await revisionStore.read()).knowledgeMaterials.find(item => item.id === 'knowledge-1')
    await revisionStore.update(value => ({ ...value, knowledgeMaterials: value.knowledgeMaterials.map(item => item.id === previous.id ? { ...item, revision: item.revision + 1 } : item) }))
    const changedState = await revisionStore.read(), changed = changedState.knowledgeMaterials.find(item => item.id === previous.id)
    assert.deepEqual(changed, { ...previous, revision: previous.revision + 1 }, 'only the knowledge revision may change')
    assert.equal(currentKnowledgeAccess(changedState, changed, { memberId: owner.id, employeeId: 'employee-1' }), 'use', 'the shared ACL remains authorized')
    await assert.rejects(revisionService.validateSendClaim({ deliveryId: candidate.delivery.id }), hasCode('DELIVERY_FORBIDDEN'))
    assert.equal((await revisionStore.read()).deliveries.find(item => item.id === candidate.delivery.id).status, 'blocked')
  } finally { await revisionConversations.close() }

  const revokedKnowledge = await service.createConversationDelivery(owner, { ...reply1, requestId: 'request-revoked-knowledge' })
  await service.authorizeDelivery({ deliveryId: revokedKnowledge.delivery.id })
  assert.equal((await service.validateSendClaim({ deliveryId: revokedKnowledge.delivery.id })).status, 'sending')
  await store.update(value => ({ ...value, knowledgeMaterials: value.knowledgeMaterials.map(item => item.id === 'knowledge-1' ? { ...item, sharedMemberIds: [], sharedEmployeeIds: [], revision: 2, updatedAt: currentTime } : item) }))
  await assert.rejects(service.validateSendClaim({ deliveryId: revokedKnowledge.delivery.id }), hasCode('DELIVERY_FORBIDDEN'))
  assert.equal((await store.read()).deliveries.find(item => item.id === revokedKnowledge.delivery.id).status, 'blocked')

  const expiring = await service.issueLinkCode(owner, { channelAppId: app1.id })
  currentTime = '2026-09-20T00:11:00.000Z'
  assert.ok((await service.expireLinkCodes()).expired >= 1)
  assert.equal((await store.read()).linkCodes.find(item => item.id === expiring.id).status, 'expired')
  await assert.rejects(service.confirmLink(owner, { linkCodeId: expiring.id }), hasCode('LINK_CODE_INVALID'))

  checkClosedGraph(await store.read())
  await checkAutomaticOutbox(afterRecovery, reply1, runner)
  await checkWeixinRebindReplay()
  assert.equal(runner.calls, 3)
  assert.equal(nativeAttempts, 0); assert.equal(networkAttempts, 0)
  for (const child of ownerChildren) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
  assert.deepEqual((await store.read()).works, migrateState(v5Fixture()).works, 'historical work is never executed or rewritten by natural text')
  console.log(`P4 channel/state checks passed; binding, closed turn delivery, ACL/revision-only revocation, graph and obsolete-origin replay; main synthetic turns=3; rebind synthetic turns=1; owner-lock processes=${ownerChildren.length}; real native/model/network=0; work dispatch=0`)
} finally {
  await conversations?.close()
  await rm(root, { recursive: true, force: true })
}

function checkMigrations() {
  assert.equal(STATE_VERSION, 12)
  const fromV3 = migrateState({ version: 3 })
  assert.equal(fromV3.version, STATE_VERSION)
  for (const key of ['channelApps', 'channelIdentities', 'channelConversations', 'channelMessages', 'deliveries', 'linkCodes']) assert.deepEqual(fromV3[key], [])
  const v4 = v4Fixture(), fromV4 = migrateState(v4)
  assert.equal(fromV4.version, STATE_VERSION)
  assert.deepEqual(fromV4.works, v4.works.map(work => ({ ...work, actions: [], conversationId: null })))
  const v5 = v5Fixture(), fromV5 = migrateState(v5)
  assert.equal(fromV5.version, STATE_VERSION)
  assert.deepEqual(fromV5.knowledgeMaterials, v5.knowledgeMaterials)
  assert.deepEqual(migrateState(structuredClone(fromV5)), fromV5)
  assert.deepEqual(migrateState({ ...structuredClone(fromV5), version: 9 }), fromV5)
  assert.throws(() => migrateState({ version: STATE_VERSION + 1 }), /未来/)
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
  assert.throws(() => migrateState(acceptedWithoutConversation), /授权 revision 引用无效/)
  for (const damage of [
    item => { item.direction = 'outbound' },
    item => { item.providerUserId = 'wrong-official-user' },
    item => { item.providerConversationId = 'wrong-official-conversation' },
  ]) {
    const damaged = structuredClone(state)
    damage(damaged.channelMessages.find(item => item.status === 'accepted'))
    assert.throws(() => migrateState(damaged), /对话引用不闭合/)
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
  for (const [damage, reason] of [
    [item => { item.sourceRef.kind = 'unknown' }, /渠道回复来源类型无效/],
    [item => { item.sourceRef.turnId = 'missing-turn' }, /回复引用不闭合/],
    [item => { item.sourceRef.conversationId = state.conversations.find(conversation => conversation.id !== item.sourceRef.conversationId).id }, /回复引用不闭合/],
    [item => { item.workId = 'work-1' }, /渠道回复来源无效/],
    [item => { item.channelMessageId = 'missing-message' }, /消息引用无效/],
  ]) {
    const damaged = structuredClone(state)
    damage(damaged.deliveries[0])
    assert.throws(() => migrateState(damaged), reason)
  }

  const historical = structuredClone(state)
  const identity = historical.channelIdentities.find(item => item.channelAppId === 'app-1')
  const conversation = historical.channelConversations.find(item => item.identityId === identity.id)
  Object.assign(identity, { status: 'unlinked', revision: identity.revision + 1, updatedAt: '2026-09-20T00:11:00.000Z', unlinkedAt: '2026-09-20T00:11:00.000Z' })
  Object.assign(conversation, { status: 'unlinked', revision: conversation.revision + 1, updatedAt: '2026-09-20T00:11:00.000Z', unlinkedAt: '2026-09-20T00:11:00.000Z' })
  identity.activeConversationId = null
  assert.equal(migrateState(historical).channelMessages.find(item => item.status === 'accepted').memberConversationId, state.channelMessages.find(item => item.status === 'accepted').memberConversationId)
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
    modelRoutes: [{ id: 'model-fixture', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', enabled: true, credentialRef: 'SYNTHETIC_MODEL_UNUSED' }],
    employees: [
      { id: 'employee-1', name: '合成员工', enabled: true, revision: 1, instructions: 'synthetic', modelRouteId: 'model-fixture', connectionIds: ['connection-1'], skillIds: ['skill-1', 'skill-gearjob-work-order-read'] },
      { id: 'employee-peer', name: '合成同事', enabled: true, revision: 1, instructions: 'synthetic', modelRouteId: 'model-fixture', connectionIds: [], skillIds: ['skill-peer'] },
    ],
    connections: [{ id: 'connection-1', enabled: true, status: 'ready', skillIds: ['skill-1', 'skill-gearjob-work-order-read'] }],
    skills: [{ id: 'skill-1', enabled: true, capabilityId: 'capability-1' }, { id: 'skill-gearjob-work-order-read', enabled: true, capabilityId: 'gearjob-work-order-read' }, { id: 'skill-peer', enabled: true, capabilityId: 'capability-peer' }],
    confirmations: [],
    knowledgeMaterials: [{ id: 'knowledge-1', ownerMemberId: 'member-peer', employeeIds: ['employee-peer'], sharedMemberIds: ['member-owner'], sharedEmployeeIds: ['employee-1'], title: 'Knowledge', body: 'approved content', format: 'text', sourceLabel: 'fixture', authorizationBasis: 'test', revision: 1, status: 'active', createdAt: timestamp, updatedAt: timestamp }],
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

async function checkAutomaticOutbox(snapshot, reply, runner) {
  const actor = { id: 'member-owner' }, source = snapshot.channelMessages.find(item => item.id === reply.channelMessageId)
  for (const mode of ['active', 'unlinked', 'rebind-required', 'endpoint-only', 'unlink-race', 'fixed-unlink-race']) {
    const fileStore = createFileStore(join(root, `outbox-${mode}.json`))
    await fileStore.update(() => structuredClone(snapshot))
    let beforeUpdate
    const store = { read: () => fileStore.read(), async update(mutator, options) {
      const gate = beforeUpdate; beforeUpdate = undefined; await gate?.()
      return fileStore.update(mutator, options)
    } }
    const conversations = createConversationService({ store, runner, clock: () => currentTime })
    const channel = createChannelService({ store, conversationService: conversations, clock: () => currentTime })
    try {
      await conversations.ensureReady()
      const refs = { conversationId: reply.conversationId, turnId: reply.turnId }, initial = await channel.ensureConversationDeliveries(refs)
      assert.equal(initial.deliveries.length, 1); assert.equal(initial.deliveries[0].status, 'pending')
      const automatic = initial.deliveries[0]
      assert.equal((await channel.ensureConversationDeliveries(refs)).deliveries[0].id, automatic.id, 'active replay must repair exactly one outbox fact')
      await channel.authorizeDelivery({ deliveryId: automatic.id })
      assert.equal((await channel.validateSendClaim({ deliveryId: automatic.id })).status, 'sending')
      await channel.recordDeliveryOutcome({ deliveryId: automatic.id, status: 'unknown' })
      const fixed = await channel.recordInbound({ channelAppId: source.channelAppId, providerEventId: `fixed-${mode}`, providerMessageId: `fixed-${mode}`,
        providerConversationId: source.providerConversationId, providerUserId: source.providerUserId, text: 'SYNTHETIC_NON_TEXT', attachments: true })
      const fixedDelivery = await channel.createInboundDeliveries({ channelMessageId: fixed.message.id, requestId: 'fixed-original' })
      assert.equal(fixedDelivery.deliveries.length, 1)
      const unknown = (await store.read()).deliveries.find(item => item.id === automatic.id)
      if (mode === 'active') {
        assert.deepEqual((await channel.ensureConversationDeliveries(refs)).deliveries, [unknown], 'unknown is preserved without retrying it')
        continue
      }
      const expireOrigin = mode === 'unlinked' || mode.endsWith('unlink-race')
        ? () => channel.unlinkIdentity(actor, { identityId: reply.identityId })
        : () => store.update(state => ({ ...state,
          channelIdentities: state.channelIdentities.map(item => item.id === reply.identityId && mode !== 'endpoint-only'
            ? { ...item, status: 'rebind-required', activeConversationId: null, revision: item.revision + 1 } : item),
          channelConversations: state.channelConversations.map(item => item.id === source.conversationId
            ? { ...item, status: 'rebind-required', revision: item.revision + 1 } : item),
        }))
      let invalidated
      const expire = async () => { await expireOrigin(); invalidated = await fileStore.read() }
      if (mode.endsWith('unlink-race')) beforeUpdate = expire
      else await expire()
      if (mode === 'fixed-unlink-race') assert.deepEqual((await channel.createInboundDeliveries({ channelMessageId: fixed.message.id, requestId: 'race-fixed' })).deliveries, [])
      assert.deepEqual((await channel.ensureConversationDeliveries(refs)).deliveries, [], `${mode}: obsolete automatic reply must be a no-op`)
      for (const messageId of [source.id, fixed.message.id]) assert.deepEqual((await channel.createInboundDeliveries({ channelMessageId: messageId, requestId: `new-transport-${mode}-${messageId}` })).deliveries, [])
      const after = await store.read()
      assert.deepEqual(after.deliveries, invalidated.deliveries, 'replay cannot create or transfer obsolete outbox facts')
      assert.deepEqual(after.deliveries.find(item => item.id === unknown.id), unknown)
      assert.deepEqual(after.conversations, invalidated.conversations)
      assert.deepEqual(after.channelMessages, invalidated.channelMessages)
      await assert.rejects(channel.createConversationDelivery(actor, { ...reply, requestId: automatic.requestId }), hasCode('NOT_FOUND'), 'explicit Web reply must still authorize before its existing request ID')
    } finally { await conversations.close() }
  }
}

async function checkWeixinRebindReplay() {
  const statePath = join(root, 'weixin-rebind.json'), botId = `synthetic-rebind-${randomUUID()}`, actor = { id: 'member-owner' }, ownerId = 'synthetic-wx-owner'
  const blocked = deferred(), release = deferred(), runner = modelBoundary(), polls = [], cursorWrites = [], sends = [], errors = []
  let blockOutbox = true, blockedOnce = false, runtimeUnavailable = false, runtime
  const store = createFileStore(statePath, { async rename(from, to) {
    const next = JSON.parse(await readFile(from, 'utf8')), message = next.channelMessages.find(item => item.providerMessageId === 'fresh-pending')
    if (blockOutbox && message && next.deliveries.some(item => item.channelMessageId === message.id)) {
      blockOutbox = false; blockedOnce = true; blocked.resolve(); await release.promise
      throw Object.assign(new Error('synthetic outbox rename failure'), { code: 'SYNTHETIC_OUTBOX_WRITE_FAILURE' })
    }
    await rename(from, to)
  } })
  await store.update(() => ({ ...migrateState(v5Fixture()), defaultChannelEmployeeId: 'employee-1' }))
  const conversations = createConversationService({ store, runner, clock: () => currentTime })
  const channel = createChannelService({ store, conversationService: conversations, clock: () => currentTime })
  const match = async () => {
    const link = await channel.beginWeixinBinding(actor)
    await channel.setWeixinQr({ linkCodeId: link.id, qrcodeUrl: 'https://weixin.qq.com/synthetic' })
    await channel.matchWeixinLogin({ linkCodeId: link.id, botId, ownerUserId: ownerId, baseUrl: 'https://ilinkai.weixin.qq.com/' })
    const state = await store.read(), identity = state.channelIdentities.find(item => item.id === state.linkCodes.find(item => item.id === link.id).matchedIdentityId)
    return { link, identity }
  }
  const raw = (id, sequence) => ({ message_id: id, from_user_id: ownerId, to_user_id: botId, message_type: 1, seq: sequence,
    context_token: 'SYNTHETIC_CONTEXT', item_list: [{ type: 1, text_item: { text: `SYNTHETIC_${id}` } }] })
  const input = message => ({ channelAppId: 'channel-app-weixin', providerAccountId: botId, providerEventId: message.message_id, providerMessageId: message.message_id,
    providerUserId: ownerId, providerConversationId: ownerId, conversationType: 'private', text: message.item_list[0].text_item.text })
  try {
    await conversations.ensureReady(); await channel.ensureBuiltinWeixinApp()
    const old = await match(), batches = [raw('old-pending', 1), raw('old-accepted', 2), raw('fresh-pending', 3)]
    const pending = await channel.handleInbound(input(batches[0]))
    assert.equal(pending.code, 'CHANNEL_CONFIRMATION_REQUIRED')
    await channel.createInboundDeliveries({ channelMessageId: pending.messageId, requestId: 'old-confirmation' })
    await channel.confirmLink(actor, { linkCodeId: old.link.id })
    await channel.setWeixinRuntime({ identityId: old.identity.id, botId, state: 'connected' })
    const accepted = await channel.handleInbound(input(batches[1]))
    await waitCompleted(store, accepted.conversationId, accepted.turnId)
    const oldReply = (await channel.ensureConversationDeliveries({ conversationId: accepted.conversationId, turnId: accepted.turnId })).deliveries[0]
    await channel.authorizeDelivery({ deliveryId: oldReply.id })
    await channel.recordDeliveryOutcome({ deliveryId: oldReply.id, status: 'unknown' })
    await channel.unlinkIdentity(actor, { identityId: old.identity.id })
    const previous = await store.read(), current = await match(), values = new Map([[current.link.tokenRef, 'SYNTHETIC_TOKEN'], [current.link.cursorRef, ''], [current.link.contextRef, null]])
    const secrets = { async read(ref) { assert(values.has(ref)); return structuredClone(values.get(ref)) }, async write(ref, value) {
      assert(values.has(ref)); values.set(ref, structuredClone(value)); if (ref === current.link.cursorRef) cursorWrites.push(value)
    } }
    const observed = { ...channel, async setWeixinRuntime(input) {
      await channel.setWeixinRuntime(input); runtimeUnavailable = input.state === 'unavailable'
    }, async createInboundDeliveries(args) {
      try { return await channel.createInboundDeliveries(args) } catch (error) { errors.push(error.code); throw error }
    } }
    const api = { normalizeBaseUrl: value => value, async getUpdates({ getUpdatesBuf, signal }) {
      const index = getUpdatesBuf ? Number(getUpdatesBuf) : 0; polls.push(index)
      if (index < batches.length) return { ret: 0, msgs: [batches[index]], get_updates_buf: String(index + 1) }
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('synthetic poll closed'), { name: 'AbortError' }))
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      })
    }, async sendText(value) { sends.push({ toUserId: value.toUserId, text: value.text }); return { providerMessageId: value.clientId } } }
    runtime = createWeixinChannelRuntime({ store, channelService: observed, secrets, api, reconnectDelayMs: 1 })
    await runtime.start()
    await waitFor(() => blockedOnce || runtimeUnavailable)
    assert.equal(errors.filter(code => code === 'NOT_FOUND').length, 0, 'obsolete replay cannot poison the new polling instance')
    assert(blockedOnce, 'polling must reach the current identity outbox commit')
    await blocked.promise
    assert.equal(values.get(current.link.cursorRef), '2', 'outbox commit failure must still withhold this batch cursor')
    assert.equal(sends.length, 0, 'old replies and the uncommitted current guide cannot be sent')
    const beforePublish = JSON.parse(await readFile(statePath, 'utf8')), fresh = beforePublish.channelMessages.find(item => item.providerMessageId === 'fresh-pending')
    assert.equal(fresh.status, 'rejected'); assert.equal(fresh.error.code, 'CHANNEL_CONFIRMATION_REQUIRED')
    assert.equal(beforePublish.deliveries.some(item => item.channelMessageId === fresh.id), false)
    release.resolve()
    await waitFor(() => values.get(current.link.cursorRef) === '3')
    const state = await store.read(), freshIdentity = state.channelIdentities.find(item => item.id === current.identity.id)
    assert.deepEqual(errors, ['SYNTHETIC_OUTBOX_WRITE_FAILURE'])
    assert.deepEqual(polls.slice(0, 4), [0, 1, 2, 2]); assert.deepEqual(cursorWrites, ['1', '2', '3'])
    assert.equal(freshIdentity.status, 'pending'); assert.equal(freshIdentity.activeConversationId, null)
    assert.equal(freshIdentity.weixin.runtimeState, 'connected')
    assert.deepEqual(state.conversations, previous.conversations)
    assert.deepEqual(state.channelMessages.filter(item => item.id !== fresh.id), previous.channelMessages)
    assert.deepEqual(state.deliveries.filter(item => item.channelMessageId !== fresh.id), previous.deliveries)
    const freshDeliveries = state.deliveries.filter(item => item.channelMessageId === fresh.id)
    assert.equal(freshDeliveries.length, 1); assert.equal(freshDeliveries[0].status, 'delivered')
    assert.equal(freshDeliveries[0].targetIdentityId, current.identity.id)
    assert.deepEqual(sends, [{ toUserId: ownerId, text: '请先在 Web 确认本人渠道身份，再重新发送消息。' }])
    assert.equal(runner.calls, 1, 'old official IDs and pending text never execute another turn')
  } finally {
    release.resolve(); await runtime?.close(); await conversations.close()
    await rm(join('/tmp', `geneway-weixin-${process.getuid()}`, createHash('sha256').update(botId).digest('hex')), { recursive: true, force: true })
  }
}

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function waitFor(check) {
  for (let count = 0; count < 300; count += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('synthetic replay condition timed out')
}

async function waitCompleted(store, conversationId, turnId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const turn = (await store.read()).conversations.find(item => item.id === conversationId)?.turns.find(item => item.id === turnId)
    if (turn?.status === 'completed') return turn
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('synthetic conversation turn did not complete')
}

function modelBoundary() {
  const history = new Map()
  return { calls: 0, async runChatTurn(options) {
    this.calls += 1
    await options.authorize()
    const sessionId = options.sessionId ?? `synthetic-session-${this.calls}`, userMessageId = `user-${options.turnId}`, assistantId = `assistant-${options.turnId}`
    await options.onSession({ sessionId, userMessageId })
    const events = history.get(sessionId) ?? [], turn = events.filter(event => event.type === 'turn/start').length + 1
    events.push({ type: 'turn/start', data: { turn } }, { type: 'user/message', data: { id: userMessageId } }, { type: 'assistant/message', data: { turn, message: { id: assistantId, content: [{ type: 'text', text: 'SYNTHETIC_APPROVED_REPLY' }] } } })
    history.set(sessionId, events)
    return { sessionId, userMessageId, assistantMessageIds: [assistantId], stopReason: 'completed', knowledgeDependencyRefs: [{ knowledgeId: 'knowledge-1', revision: 1, segmentId: 'p1-c1' }] }
  }, async readChatHistory(ids) { return ids.map(sessionId => ({ sessionId, status: history.has(sessionId) ? 'available' : 'unavailable', events: structuredClone(history.get(sessionId) ?? []) })) }, async cancelChatTurn() {} }
}
