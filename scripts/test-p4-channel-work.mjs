import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelService } from '../src/channel-service.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p4-channel-work-'))
const environments = []
let sequence = 0

try {
  await duplicateAndCreateCrashGap()
  await followUpAndCrashGap()
  await guardRaceAfterCommittedReservation()
  await commandBranches()
  await exactReferencesAndUnsupported()
  await currentAuthorizationGates()
  console.log('P4 channel/work checks passed; dispatch: duplicate-create=1, create-crash-gap=1, follow-up-crash-gap=2 total, unsupported/revoked=0; external send=0')
} finally {
  await Promise.all(environments.map(environment => environment.workService.close().catch(() => undefined)))
  await rm(root, { recursive: true, force: true })
}

async function duplicateAndCreateCrashGap() {
  const environment = await createEnvironment('duplicate')
  const gate = environment.runner.holdNext()
  const input = inbound('create-duplicate', '交办 工单 WO-1')
  const [first, duplicate] = await Promise.all([
    environment.channelService.handleInbound(input),
    environment.channelService.handleInbound({ ...input, text: '重投不得覆盖命令' }),
  ])
  assert.equal(first.workId, duplicate.workId)
  const state = await environment.store.read()
  const message = state.channelMessages.find(item => item.providerEventId === input.providerEventId)
  assert.equal(message.status, 'accepted')
  assert.deepEqual(message.command, {
    type: 'create', workOrderId: 'WO-1', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read',
    capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner',
  })
  assert.deepEqual(message.authorizationRevisions, { app: 1, identity: 1, conversation: 1 })
  assert.equal(message.clientRequestId, `channel:app-1:${requestDigest('event', input.providerEventId)}`)
  assert.equal(message.clientRequestId.includes(input.providerEventId), false)
  assert.ok(message.reservedAt)
  assert.equal(state.works.length, 1)
  assert.equal(state.works[0].executions.length, 1)
  await waitUntil(() => environment.runner.calls.length === 1)
  gate.release()
  await waitWork(environment, first.workId, work => work.status === 'completed')
  assert.equal(environment.runner.calls.length, 1)

  const conflictMessageId = 'message-create-conflict'
  const conflict = await environment.channelService.handleInbound({ ...input, providerMessageId: conflictMessageId, text: '交办 工单 WO-2' })
  assert.equal(conflict.code, 'OFFICIAL_ID_CONFLICT')
  const conflictReplay = await environment.channelService.handleInbound({ ...input, providerEventId: undefined, providerMessageId: conflictMessageId, text: '交办 工单 WO-2' })
  assert.equal(conflictReplay.code, 'OFFICIAL_ID_CONFLICT')
  assert.equal((await environment.store.read()).works.length, 1)

  const messageOnly = inbound('message-only', '交办 工单 WO-2')
  delete messageOnly.providerEventId
  messageOnly.providerMessageId = input.providerEventId
  const messageOnlyResult = await environment.channelService.handleInbound(messageOnly)
  const messageOnlyState = await environment.store.read()
  const messageOnlyRequestId = messageOnlyState.channelMessages.find(item => item.providerMessageId === messageOnly.providerMessageId).clientRequestId
  assert.equal(messageOnlyRequestId, `channel:app-1:${requestDigest('message', messageOnly.providerMessageId)}`)
  assert.notEqual(messageOnlyRequestId, message.clientRequestId)
  await waitWork(environment, messageOnlyResult.workId, work => work.status === 'completed')

  const crash = await createEnvironment('create-crash')
  const crashingChannel = createChannelService({ store: failAcceptedOnce(crash.store), workService: crash.workService, clock: crash.clock, idFactory: crash.idFactory })
  const crashInput = inbound('create-crash', '交办 工单 WO-1')
  await assert.rejects(crashingChannel.handleInbound(crashInput), /simulated channel finalize crash/)
  let crashState = await crash.store.read()
  assert.equal(crashState.channelMessages[0].status, 'reserved')
  assert.equal(crashState.works.length, 1)
  await crash.channelService.upsertChannelApp({ id: 'member-admin' }, { id: 'app-1', enabled: false })
  const recovered = await crash.channelService.handleInbound({ ...crashInput, text: '交办 工单 WO-2' })
  crashState = await crash.store.read()
  assert.equal(recovered.code, 'CHANNEL_AUTHORIZATION_CHANGED')
  assert.equal(crashState.channelMessages[0].status, 'accepted')
  assert.equal(crashState.channelMessages[0].workId, crashState.works[0].id)
  assert.equal(crashState.works[0].input.workOrderId, 'WO-1')
  assert.equal(crashState.works[0].executions.length, 1)
  await waitUntil(() => crash.runner.calls.length === 1)
  const suppressed = await crash.channelService.createDelivery(crash.owner, { channelAppId: 'app-1', requestId: 'suppressed-after-crash', workId: crashState.works[0].id, targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result' })
  await assert.rejects(crash.channelService.authorizeDelivery({ deliveryId: suppressed.delivery.id }), hasCode('DELIVERY_FORBIDDEN'))
  assert.equal((await crash.store.read()).deliveries.find(item => item.id === suppressed.delivery.id).status, 'blocked')

  const cross = await createEnvironment('cross-id')
  await cross.channelService.handleInbound(inbound('cross-a', '不支持 A'))
  await cross.channelService.handleInbound(inbound('cross-b', '不支持 B'))
  assert.equal((await cross.channelService.handleInbound({ ...inbound('cross-a', '不支持'), providerMessageId: 'message-cross-b' })).code, 'OFFICIAL_ID_CONFLICT')
  assert.equal((await cross.store.read()).works.length, 0)
}

async function followUpAndCrashGap() {
  const environment = await createEnvironment('follow-up')
  const created = await environment.channelService.handleInbound(inbound('follow-create', '交办 工单 WO-1'))
  const workId = created.workId
  await waitWork(environment, workId, work => work.status === 'completed')
  const before = await environment.workService.getWork(environment.owner, workId)
  const providerReplyId = await deliveredResult(environment, workId, before.value.results[0].id, 'reply-work-1')
  const followInput = { ...inbound('follow-message', '补充 请解释：完成量来源'), replyToProviderMessageId: providerReplyId }
  const followed = await environment.channelService.handleInbound(followInput)
  assert.equal(followed.workId, workId)
  assert.equal(followed.code, 'FOLLOW_UP_ACCEPTED')
  const completed = await waitWork(environment, workId, work => work.results.length === 2 && work.status === 'completed')
  assert.deepEqual(completed.input, before.value.input)
  assert.deepEqual(environment.runner.calls.map(item => item.operation), ['create', 'follow-up'])
  assert.equal(environment.runner.calls[1].followUp.question, '请解释：完成量来源')
  await environment.channelService.handleInbound({ ...followInput, text: '补充 这条重投不应执行' })
  assert.equal(environment.runner.calls.length, 2)

  const crash = await createEnvironment('follow-crash')
  const base = await crash.channelService.handleInbound(inbound('follow-crash-create', '交办 工单 WO-1'))
  await waitWork(crash, base.workId, work => work.status === 'completed')
  const crashingChannel = createChannelService({ store: failAcceptedOnce(crash.store), workService: crash.workService, clock: crash.clock, idFactory: crash.idFactory })
  const followCrashInput = inbound('follow-crash-message', `补充 ${base.workId} 保留原始追问`)
  await assert.rejects(crashingChannel.handleInbound(followCrashInput), /simulated channel finalize crash/)
  let state = await crash.store.read()
  assert.equal(state.channelMessages.find(item => item.providerEventId === followCrashInput.providerEventId).status, 'reserved')
  await crash.channelService.upsertChannelApp({ id: 'member-admin' }, { id: 'app-1', enabled: false })
  const recovered = await crash.channelService.handleInbound({ ...followCrashInput, text: `补充 ${base.workId} 不得覆盖` })
  assert.equal(recovered.code, 'CHANNEL_AUTHORIZATION_CHANGED')
  await waitWork(crash, base.workId, work => work.results.length === 2)
  state = await crash.store.read()
  assert.equal(state.channelMessages.find(item => item.providerEventId === followCrashInput.providerEventId).status, 'accepted')
  assert.equal(state.channelMessages.find(item => item.providerEventId === followCrashInput.providerEventId).workId, base.workId)
  assert.equal(crash.runner.calls.length, 2)
  assert.equal((await crash.workService.getWork(crash.owner, base.workId)).value.executions.length, 2)
  assert.equal(crash.runner.calls.at(-1).followUp.question, '保留原始追问')
}

async function guardRaceAfterCommittedReservation() {
  const create = await createEnvironment('guard-race-create')
  const createChannel = createChannelService({
    store: commitAndRevokeAfterReserve(create.store, create.workService, state => Object.assign(state.channelApps[0], { enabled: false, status: 'disabled', revision: 2 })),
    workService: create.workService,
    clock: create.clock,
    idFactory: create.idFactory,
  })
  const createResponse = await createChannel.handleInbound(inbound('guard-race-create', '交办 工单 WO-1'))
  assert.equal(createResponse.code, 'CHANNEL_AUTHORIZATION_CHANGED')
  let state = await create.store.read()
  const createMessage = state.channelMessages.find(item => item.providerEventId === 'event-guard-race-create')
  assert.equal(createMessage.status, 'accepted')
  assert.equal(createMessage.workId, state.works[0].id)
  assert.equal(state.works.length, 1)
  assert.equal(state.works[0].executions.length, 1)
  await waitWork(create, createMessage.workId, work => work.status === 'completed')
  assert.equal(create.runner.calls.length, 1)

  const follow = await createEnvironment('guard-race-follow')
  const base = await follow.channelService.handleInbound(inbound('guard-race-follow-base', '交办 工单 WO-1'))
  await waitWork(follow, base.workId, work => work.status === 'completed')
  const followChannel = createChannelService({
    store: commitAndRevokeAfterReserve(follow.store, follow.workService, state => Object.assign(state.channelIdentities[0], { status: 'unlinked', revision: 2, unlinkedAt: follow.clock() })),
    workService: follow.workService,
    clock: follow.clock,
    idFactory: follow.idFactory,
  })
  const followResponse = await followChannel.handleInbound(inbound('guard-race-follow', `补充 ${base.workId} 竞态追问`))
  assert.equal(followResponse.code, 'CHANNEL_AUTHORIZATION_CHANGED')
  await waitWork(follow, base.workId, work => work.results.length === 2)
  state = await follow.store.read()
  const followMessage = state.channelMessages.find(item => item.providerEventId === 'event-guard-race-follow')
  assert.equal(followMessage.status, 'accepted')
  assert.equal(followMessage.workId, base.workId)
  assert.equal(state.works.find(item => item.id === base.workId).executions.length, 2)
  assert.equal(follow.runner.calls.filter(item => item.operation === 'follow-up').length, 1)
}

async function commandBranches() {
  const active = await createEnvironment('active')
  const created = await active.channelService.handleInbound(inbound('active-create', '交办 工单 WO-1'))
  await waitWork(active, created.workId, work => work.status === 'completed')
  const gate = active.runner.holdNext()
  await active.workService.followUp(active.owner, created.workId, '已在执行的追问', { clientRequestId: 'direct-active' })
  await waitWork(active, created.workId, work => work.status === 'running')
  const beforeCalls = active.runner.calls.length
  const notApplied = await active.channelService.handleInbound(inbound('active-follow', `补充 ${created.workId} 不应应用`))
  assert.equal(notApplied.kind, 'not-applied')
  assert.equal(active.runner.calls.length, beforeCalls)
  gate.release()

  const waiting = await createEnvironment('waiting')
  const waitingWork = await waiting.workService.createWork(waiting.owner, {
    employeeId: 'employee-owner', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', input: { availableSeconds: 60 }, clientRequestId: 'waiting-work',
  })
  assert.equal(waitingWork.value.status, 'waiting_input')
  const waitingReply = await waiting.channelService.handleInbound(inbound('waiting-follow', `补充 ${waitingWork.value.id} 自由文字`))
  assert.equal(waitingReply.kind, 'help')
  assert.equal(waitingReply.code, 'WORK_INPUT_REQUIRED')
  assert.equal(waiting.runner.calls.length, 0)

  const status = await createEnvironment('status')
  const statusCreated = await status.channelService.handleInbound(inbound('status-create', '交办 工单 WO-1'))
  await waitWork(status, statusCreated.workId, work => work.status === 'completed')
  const statusState = await status.store.read()
  const statusExecutions = statusState.works[0].executions.length
  const statusCalls = status.runner.calls.length
  const read = await status.channelService.handleInbound(inbound('status-read', `状态 ${statusCreated.workId}`))
  assert.equal(read.kind, 'result')
  assert.equal(read.workStatus, 'completed')
  assert.equal(status.runner.calls.length, statusCalls)
  assert.equal((await status.store.read()).works[0].executions.length, statusExecutions)
  await status.store.update(state => ({ ...state, channelIdentities: state.channelIdentities.map(item => item.id === 'identity-owner' ? { ...item, status: 'unlinked', revision: 2, unlinkedAt: status.clock() } : item) }))
  const revokedReplay = await status.channelService.handleInbound({ ...inbound('status-read', '状态 work-do-not-reparse'), providerMessageId: 'message-status-read' })
  assert.equal(revokedReplay.code, 'CHANNEL_AUTHORIZATION_CHANGED')
  assert.equal(revokedReplay.workStatus, undefined)

  const stopping = await createEnvironment('stop')
  const gate1 = stopping.runner.holdNext(), gate2 = stopping.runner.holdNext()
  const w1 = await stopping.channelService.handleInbound(inbound('stop-w1', '交办 工单 WO-1'))
  const w2 = await stopping.channelService.handleInbound(inbound('stop-w2', '交办 工单 WO-2'))
  await waitWork(stopping, w1.workId, work => work.status === 'running')
  await waitWork(stopping, w2.workId, work => work.status === 'running')
  const pendingDelivery = await stopping.channelService.createDelivery(stopping.owner, {
    channelAppId: 'app-1', requestId: 'pending-before-stop', workId: w1.workId,
    targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result',
  })
  await stopping.channelService.handleInbound(inbound('stop-command', `停止 ${w1.workId}`))
  await waitWork(stopping, w1.workId, work => ['cancel_requested', 'cancelled'].includes(work.status))
  assert.equal((await stopping.workService.getWork(stopping.owner, w2.workId)).value.status, 'running')
  assert.equal((await stopping.store.read()).deliveries.find(item => item.id === pendingDelivery.delivery.id).status, 'pending')
  assert.equal(stopping.runner.calls.length, 2)
  gate1.release()
  gate2.release()
}

async function exactReferencesAndUnsupported() {
  const environment = await createEnvironment('references')
  const ownerWork = await environment.channelService.handleInbound(inbound('reference-owner', '交办 工单 WO-1'))
  await waitWork(environment, ownerWork.workId, work => work.status === 'completed')
  const ownerResult = await environment.workService.getWork(environment.owner, ownerWork.workId)
  const replyId = await deliveredResult(environment, ownerWork.workId, ownerResult.value.results[0].id, 'owner-reply')
  await environment.store.update(state => ({
    ...state,
    channelConversations: [...state.channelConversations, { ...state.channelConversations[0], id: 'conversation-other', providerConversationId: 'private-other', revision: 1 }],
    works: [...state.works, fixtureWork('work-peer', 'member-peer'), fixtureWork('work-admin', 'member-admin')],
  }))
  const workCount = (await environment.store.read()).works.length
  for (const [event, text, code] of [['peer-guess', '状态 work-peer', 'WORK_REFERENCE_INVALID'], ['admin-guess', '停止 work-admin', 'WORK_REFERENCE_INVALID'], ['short-ref', '状态 peer', 'UNSUPPORTED']]) {
    const response = await environment.channelService.handleInbound(inbound(event, text))
    assert.equal(response.code, code)
  }
  const wrongConversation = await environment.channelService.handleInbound({ ...inbound('wrong-conversation', '补充 不应命中', 'private-other'), replyToProviderMessageId: replyId })
  assert.equal(wrongConversation.code, 'WORK_REFERENCE_INVALID')

  const otherWork = await environment.channelService.handleInbound(inbound('reference-other', '交办 工单 WO-2'))
  await waitWork(environment, otherWork.workId, work => work.status === 'completed')
  const mismatch = await environment.channelService.handleInbound({ ...inbound('reply-mismatch', `补充 ${otherWork.workId} 不一致`), replyToProviderMessageId: replyId })
  assert.equal(mismatch.code, 'WORK_REFERENCE_INVALID')

  const calls = environment.runner.calls.length
  const beforeUnsupported = (await environment.store.read()).works.map(item => ({ id: item.id, executions: item.executions.length, results: item.results.length }))
  const workServiceCalls = { createWork: 0, followUp: 0, getWork: 0, cancel: 0 }
  const unsupportedChannel = createChannelService({
    store: environment.store,
    clock: environment.clock,
    idFactory: environment.idFactory,
    workService: Object.fromEntries(Object.keys(workServiceCalls).map(name => [name, (...args) => {
      workServiceCalls[name] += 1
      return environment.workService[name](...args)
    }])),
  })
  for (const [event, text, extra] of [
    ['unsupported-text', '请帮我查工单', {}],
    ['unsupported-url', '补充 https://example.invalid', {}],
    ['unsupported-ftp', `补充 ${ownerWork.workId} (ftp://example.invalid/file)`, {}],
    ['unsupported-markdown', `补充 ${ownerWork.workId} [x](https://example.invalid)`, {}],
    ['unsupported-mailto', `补充 ${ownerWork.workId} "mailto:test@example.invalid"`, {}],
    ['unsupported-file', `补充 ${ownerWork.workId} “file:/tmp/private”`, {}],
    ['unsupported-custom', `补充 ${ownerWork.workId} custom:opaque`, {}],
    ['unsupported-structured-url', `补充 ${ownerWork.workId} 普通文字`, { url: 'custom:opaque' }],
    ['unsupported-attachment', '交办 工单 WO-3', { attachments: [{ id: 'file' }] }],
  ]) {
    const response = await unsupportedChannel.handleInbound({ ...inbound(event, text), ...extra })
    assert.equal(response.kind, 'help')
    assert.equal(response.code, 'UNSUPPORTED')
  }
  assert.equal(environment.runner.calls.length, calls)
  assert.deepEqual(workServiceCalls, { createWork: 0, followUp: 0, getWork: 0, cancel: 0 })
  assert.deepEqual((await environment.store.read()).works.map(item => ({ id: item.id, executions: item.executions.length, results: item.results.length })), beforeUnsupported)
  assert.equal((await environment.store.read()).works.length, workCount + 1)
}

async function currentAuthorizationGates() {
  for (const [name, mutate] of [
    ['member-disabled', state => { state.members.find(item => item.id === 'member-owner').enabled = false }],
    ['identity-unlinked', state => { const identity = state.channelIdentities[0]; Object.assign(identity, { status: 'unlinked', revision: 2, unlinkedAt: state.channelApps[0].updatedAt }) }],
    ['app-disabled', state => { Object.assign(state.channelApps[0], { enabled: false, status: 'disabled', revision: 2 }) }],
    ['default-revoked', state => { state.skills.find(item => item.id === 'skill-gearjob-work-order-read').enabled = false }],
  ]) {
    const environment = await createEnvironment(name)
    await environment.store.update(state => { const next = structuredClone(state); mutate(next); return next })
    const response = await environment.channelService.handleInbound(inbound(`${name}-event`, '交办 工单 WO-1'))
    assert.equal(['error', 'help'].includes(response.kind), true)
    assert.equal((await environment.store.read()).works.length, 0)
    assert.equal(environment.runner.calls.length, 0)
  }

  for (const [name, mutate] of [
    ['employee-binding', state => { state.employees.find(item => item.id === 'employee-owner').enabled = false }],
    ['skill-binding', state => { state.skills.find(item => item.id === 'skill-gearjob-work-order-read').enabled = false }],
    ['connection-enabled', state => { state.connections.find(item => item.id === 'connection-owner').enabled = false }],
    ['connection-ready', state => { state.connections.find(item => item.id === 'connection-owner').status = 'unknown' }],
    ['connection-skill', state => { state.connections.find(item => item.id === 'connection-owner').skillIds = [] }],
    ['allowed-object', state => { state.connections.find(item => item.id === 'connection-owner').allowedObjectIds = [] }],
  ]) {
    const environment = await createEnvironment(`work-auth-${name}`)
    const created = await environment.channelService.handleInbound(inbound(`work-auth-create-${name}`, '交办 工单 WO-1'))
    await waitWork(environment, created.workId, work => work.status === 'completed')
    await environment.store.update(state => { const next = structuredClone(state); mutate(next); return next })
    const calls = { getWork: 0, cancel: 0 }
    const guarded = createChannelService({
      store: environment.store,
      clock: environment.clock,
      idFactory: environment.idFactory,
      workService: {
        createWork: (...args) => environment.workService.createWork(...args),
        followUp: (...args) => environment.workService.followUp(...args),
        getWork: (...args) => { calls.getWork += 1; return environment.workService.getWork(...args) },
        cancel: (...args) => { calls.cancel += 1; return environment.workService.cancel(...args) },
      },
    })
    assert.equal((await guarded.handleInbound(inbound(`work-auth-status-${name}`, `状态 ${created.workId}`))).code, 'WORK_REFERENCE_INVALID')
    assert.equal((await guarded.handleInbound(inbound(`work-auth-stop-${name}`, `停止 ${created.workId}`))).code, 'WORK_REFERENCE_INVALID')
    assert.deepEqual(calls, { getWork: 0, cancel: 0 })
  }

  const finalGuard = await createEnvironment('final-guard')
  const guardedChannel = createChannelService({ store: revokeAfterReserve(finalGuard.store), workService: finalGuard.workService, clock: finalGuard.clock, idFactory: finalGuard.idFactory })
  const blocked = await guardedChannel.handleInbound(inbound('final-guard-event', '交办 工单 WO-1'))
  assert.equal(blocked.code, 'CHANNEL_AUTHORIZATION_CHANGED')
  assert.equal((await finalGuard.store.read()).works.length, 0)
  assert.equal(finalGuard.runner.calls.length, 0)
}

async function createEnvironment(name) {
  const store = createFileStore(join(root, `${name}.json`))
  await store.update(seedState)
  const runner = stubRunner()
  const clock = () => '2026-09-20T01:00:00.000Z'
  const idFactory = () => `${name}-${++sequence}`
  const workService = createWorkService({ store, runner, connectionCatalog: [catalogTarget()] })
  const channelService = createChannelService({ store, workService, clock, idFactory })
  const environment = { store, runner, workService, channelService, clock, idFactory, owner: { id: 'member-owner' } }
  environments.push(environment)
  return environment
}

function seedState(state) {
  const now = '2026-09-20T00:00:00.000Z'
  const member = (id, role, employeeIds) => ({ id, loginName: id, displayName: id, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now })
  return {
    ...state,
    members: [member('member-admin', 'admin', []), member('member-owner', 'member', ['employee-owner']), member('member-peer', 'member', [])],
    modelRoutes: [{ id: 'model-1', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-owner', name: '员工', enabled: true, modelRouteId: 'model-1', connectionIds: ['connection-owner'], skillIds: ['skill-gearjob-work-order-read', 'skill-cycle-time-calculate'] }],
    connections: [{ id: 'connection-owner', name: 'GearJob', ...catalogTarget(), allowedObjectIds: ['WO-1', 'WO-2', 'WO-3'], enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 }],
    skills: [
      { id: 'skill-gearjob-work-order-read', name: '工单查询', capabilityId: 'gearjob-work-order-read', enabled: true },
      { id: 'skill-cycle-time-calculate', name: '节拍', capabilityId: 'cycle-time-calculate', enabled: true },
    ],
    channelApps: [{ id: 'app-1', provider: 'feishu', providerAppId: 'official-app', providerTenantId: 'official-tenant', credentialRef: 'FEISHU_SECRET_REF', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }],
    channelIdentities: [{ id: 'identity-owner', channelAppId: 'app-1', providerUserId: 'provider-owner', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }],
    channelConversations: [{ id: 'conversation-owner', channelAppId: 'app-1', providerConversationId: 'private-owner', identityId: 'identity-owner', memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, defaultDispatch: { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner' }, createdAt: now, updatedAt: now }],
  }
}

function catalogTarget() {
  return { kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'http://127.0.0.1/gearjob', credentialRef: 'gearjob.json', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' }
}

function fixtureWork(id, ownerMemberId) {
  return { id, ownerMemberId, employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner', goal: 'fixture', input: { workOrderId: 'WO-1' }, requiredInputs: [], status: 'completed', acceptedAt: '2026-09-20T00:00:00.000Z', results: [], executions: [] }
}

function stubRunner() {
  const calls = [], queued = [], active = new Map()
  return {
    configured: true,
    calls,
    holdNext() {
      const gate = deferred()
      queued.push(gate)
      return gate
    },
    async run(args) {
      calls.push(structuredClone(args))
      const gate = queued.shift()
      if (gate) { active.set(args.executionId, gate); await gate.promise; active.delete(args.executionId) }
      const common = { explanation: `说明 ${args.operation}`, dshSessionRef: args.sessionId ?? `session-${calls.length}`, contextResultId: args.contextResultId, continuity: args.sessionId ? 'same-session' : 'new', contextConfirmationRefs: args.sessionMetadata.confirmationRefs, eventCount: 1 }
      if (args.operation === 'follow-up') return common
      return {
        ...common,
        result: {
          kind: 'gearjob.work-order.observation',
          payload: { workOrderId: args.input.workOrderId, status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', sourceRecordId: `Work Order:${args.input.workOrderId}`, sourceRevision: 'r1', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' },
          source: { sourceRecordId: `Work Order:${args.input.workOrderId}`, sourceRevision: 'r1', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' },
          toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2',
        },
      }
    },
    async cancel(executionId) { active.get(executionId)?.release() },
    async close() { for (const gate of active.values()) gate.release() },
  }
}

async function deliveredResult(environment, workId, resultId, providerMessageId) {
  const created = await environment.channelService.createDelivery(environment.owner, {
    channelAppId: 'app-1', requestId: `delivery-${providerMessageId}`, workId, resultId,
    targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result',
  })
  await environment.channelService.authorizeDelivery({ deliveryId: created.delivery.id })
  await environment.channelService.recordDeliveryOutcome({ deliveryId: created.delivery.id, status: 'delivered', providerMessageId })
  return providerMessageId
}

function failAcceptedOnce(store) {
  let armed = true
  return {
    read: () => store.read(),
    update(mutator) {
      return store.update(async state => {
        const next = await mutator(state)
        if (armed && next.channelMessages.some(item => item.status === 'accepted' && state.channelMessages.find(previous => previous.id === item.id)?.status === 'reserved')) {
          armed = false
          throw new Error('simulated channel finalize crash')
        }
        return next
      })
    },
  }
}

function commitAndRevokeAfterReserve(store, workService, revoke) {
  let armed = true
  return {
    read: () => store.read(),
    async update(mutator) {
      const next = await store.update(mutator)
      const message = armed && next.channelMessages.find(item => item.status === 'reserved')
      if (!message) return next
      armed = false
      const identity = next.channelIdentities.find(item => item.id === message.senderIdentityId)
      if (message.command.type === 'create') await workService.createWork({ id: identity.memberId }, {
        employeeId: message.command.employeeId,
        skillId: message.command.skillId,
        capabilityId: message.command.capabilityId,
        connectionId: message.command.connectionId,
        workOrderId: message.command.workOrderId,
        clientRequestId: message.clientRequestId,
      })
      else await workService.followUp({ id: identity.memberId }, message.command.workId, message.command.text, { clientRequestId: message.clientRequestId })
      await store.update(state => { const value = structuredClone(state); revoke(value); return value })
      return next
    },
  }
}

function revokeAfterReserve(store) {
  let armed = true
  return {
    read: () => store.read(),
    async update(mutator) {
      const next = await store.update(mutator)
      if (armed && next.channelMessages.some(item => item.status === 'reserved')) {
        armed = false
        await store.update(state => ({ ...state, skills: state.skills.map(item => item.id === 'skill-gearjob-work-order-read' ? { ...item, enabled: false } : item) }))
      }
      return next
    },
  }
}

function inbound(id, text, providerConversationId = 'private-owner') {
  return { channelAppId: 'app-1', providerEventId: `event-${id}`, providerMessageId: `message-${id}`, providerConversationId, providerUserId: 'provider-owner', text, memberId: 'member-peer', employeeId: 'not-trusted' }
}

function requestDigest(kind, officialId) {
  return createHash('sha256').update(`app-1\0${kind}\0${officialId}`).digest('hex')
}

async function waitWork(environment, workId, predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await environment.workService.getWork(environment.owner, workId)
    if (result.ok && predicate(result.value)) return result.value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${workId}`)
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for condition')
}

function deferred() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

function hasCode(code) { return value => value?.code === code }
