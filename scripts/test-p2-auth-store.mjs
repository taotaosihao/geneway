import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createAuthRuntime, initializeAuthFile, isSessionCurrent } from '../src/auth.mjs'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'

const execFile = promisify(execFileCallback)
const root = await mkdtemp(join(tmpdir(), 'geneway-p2-auth-'))

try {
  checkMigration()
  await checkMigrationFailureDoesNotWrite()
  await checkAuthAndRekey()
  await checkInitModes()
  await checkRealP1Restore()
  console.log('P2 auth/store checks passed')
} finally {
  await rm(root, { recursive: true, force: true })
}

function checkMigration() {
  const original = v3Fixture()
  const migrated = migrateState(original)
  const channelKeys = ['channelApps', 'channelIdentities', 'channelConversations', 'channelMessages', 'deliveries', 'linkCodes']
  assert.equal(migrated.version, 8)
  assert.deepEqual(migrated.knowledgeMaterials, [])
  for (const key of channelKeys) assert.deepEqual(migrated[key], [])
  assert.deepEqual(migrated.automationRules, [])
  assert.deepEqual(migrated.automationOccurrences, [])
  assert.equal(migrated.members[0].id, 'member-admin')
  assert.equal(migrated.members[0].role, 'admin')
  assert.equal(migrated.members[0].displayName, '旧操作者')
  assert.deepEqual(migrated.members[0].employeeIds, ['employee-1'])
  assert.equal(migrated.employees[0].modelRouteId, null)
  assert.equal(migrated.connections[0].status, 'unavailable')
  assert.equal(migrated.connections[0].credentialRef, null)
  assert.equal(migrated.connections[0].baseUrl, null)
  assert.deepEqual(migrated.modelRoutes, [])
  assert.equal(migrated.skills[0].capabilityId, 'gearjob-work-order-read')
  assert.equal(migrated.skills[0].action, undefined)
  assert.equal(migrated.skills[0].toolName, undefined)
  assert.equal(migrated.works[0].ownerMemberId, 'member-admin')
  assert.equal(migrated.works[0].observations, undefined)
  assert.equal(migrated.works[0].followUps, undefined)
  assert.deepEqual(migrated.works[0].results.map(item => item.id), ['obs-stable', 'follow-stable'])
  assert.deepEqual(migrated.works[0].results[0].payload, original.works[0].observations[0])
  assert.equal(migrated.works[0].results[0].createdAt, '2026-09-18T01:01:00.000Z')
  assert.equal(migrated.works[0].results[0].dshSessionRef, 'session-old')
  assert.equal(migrated.works[0].results[1].continuedFromDshSessionRef, 'session-old')
  assert.equal(migrated.works[0].results[0].pluginVersion, undefined)
  assert.deepEqual(migrated.works[0].executions.map(item => item.resultId), ['obs-stable', 'follow-stable'])
  assert.equal(migrated.works[0].executions[0].resultObservationId, 'obs-stable')
  assert.equal(migrated.works[0].executions[1].resultFollowUpId, 'follow-stable')
  assert.ok(migrated.reservations['member-admin|keep'])
  assert.deepEqual(migrateState(structuredClone(migrated)), migrated)
  const explicitV4 = structuredClone(migrated)
  explicitV4.version = 4
  delete explicitV4.knowledgeMaterials
  for (const key of channelKeys) delete explicitV4[key]
  assert.deepEqual(migrateState(explicitV4), migrated)
  const explicitV5 = structuredClone(migrated)
  explicitV5.version = 5
  for (const key of channelKeys) delete explicitV5[key]
  assert.deepEqual(migrateState(explicitV5), migrated)

  const missingIds = v3Fixture()
  delete missingIds.works[0].observations[0].observationId
  delete missingIds.works[0].followUps[0].id
  delete missingIds.works[0].executions[0].resultObservationId
  delete missingIds.works[0].executions[1].resultFollowUpId
  const firstFallback = migrateState(missingIds)
  const secondFallback = migrateState(structuredClone(missingIds))
  assert.deepEqual(firstFallback.works[0].results.map(item => item.id), ['legacy-observation-work-1-0', 'legacy-follow-up-work-1-0'])
  assert.deepEqual(firstFallback, secondFallback)
  const missingOptionalExplanation = v3Fixture()
  delete missingOptionalExplanation.works[0].followUps[0].explanation
  assert.equal(migrateState(missingOptionalExplanation).works[0].results[1].explanation, undefined)

  const sparse = migrateState({ version: 3 })
  assert.deepEqual(sparse.employees, [])
  assert.deepEqual(sparse.works, [])
  assert.equal(sparse.members[0].createdAt, '1970-01-01T00:00:00.000Z')
  for (const key of ['employees', 'connections', 'skills', 'works', 'modelRoutes', 'confirmations']) {
    assert.throws(() => migrateState({ version: 3, [key]: {} }), new RegExp(key))
  }
  assert.throws(() => migrateState({ version: 3, reservations: [] }), /reservations/)
  assert.throws(() => migrateState({ version: 9 }), /未来/)
  assert.throws(() => migrateState({ version: '6' }), /版本无效/)
  assert.throws(() => migrateState({ version: 2 }), /不支持产品状态版本/)
  assert.throws(() => migrateState({ ...original, employees: [{ ...original.employees[0], skillIds: {} }] }), /skillIds/)
  const currentWithoutResults = structuredClone(migrated)
  delete currentWithoutResults.works[0].results
  assert.throws(() => migrateState(currentWithoutResults), /results/)
  const currentWithLegacyResults = structuredClone(migrated)
  currentWithLegacyResults.works[0].observations = []
  assert.throws(() => migrateState(currentWithLegacyResults), /旧结果字段/)
  const currentWithDamagedPayload = structuredClone(migrated)
  currentWithDamagedPayload.works[0].results[0].payload.workOrderId = 'OTHER'
  assert.throws(() => migrateState(currentWithDamagedPayload), /不匹配/)
  const malformedResults = [
    state => { delete state.works[0].results[0].dshSessionRef },
    state => { state.works[0].results[0].source.sourceSystem = 7 },
    state => { state.works[0].results[0].payload.completion.ratio = '0.4' },
    state => { state.works[0].results[0].contextConfirmationRefs = [7] },
    state => { state.works[0].results[1].input = {} },
  ]
  for (const damage of malformedResults) {
    const state = structuredClone(migrated)
    damage(state)
    assert.throws(() => migrateState(state))
  }
  for (const key of ['members', 'modelRoutes', 'employees', 'connections', 'skills', 'confirmations', 'works']) {
    assert.throws(() => migrateState({ ...migrated, [key]: {} }), new RegExp(key))
  }

  const cycleState = structuredClone(migrated)
  cycleState.works = [{
    id: 'work-cycle', ownerMemberId: 'member-admin', employeeId: 'employee-1', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate',
    results: [{
      id: 'result-cycle', kind: 'manufacturing.takt', capabilityId: 'cycle-time-calculate', skillId: 'skill-cycle-time-calculate', schemaVersion: 1,
      input: { availableSeconds: 3600, quantity: 60 }, payload: { availableSeconds: 3600, quantity: 60, secondsPerUnit: 60, unit: 'seconds/unit' },
      createdAt: '2026-09-19T00:00:00.000Z', toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '2', dshSessionRef: 'session-cycle', contextConfirmationRefs: [],
    }],
    actions: [],
    executions: [{ id: 'exec-cycle', resultId: 'result-cycle' }],
  }]
  assert.equal(migrateState(cycleState).works[0].results[0].payload.secondsPerUnit, 60)
  cycleState.works[0].results[0].payload.secondsPerUnit = 61
  assert.throws(() => migrateState(cycleState), /不匹配/)
}

async function checkMigrationFailureDoesNotWrite() {
  const newStateDirectory = join(root, 'new-state-directory')
  const newStatePath = join(newStateDirectory, 'state.json')
  await createFileStore(newStatePath).update(state => state)
  assert.equal((await stat(newStateDirectory)).mode & 0o077, 0)
  assert.equal((await stat(newStatePath)).mode & 0o077, 0)

  const damagedCurrent = migrateState(v3Fixture())
  damagedCurrent.knowledgeMaterials = {}
  for (const [state, pattern] of [[{ ...v3Fixture(), works: {} }, /works/], [damagedCurrent, /knowledgeMaterials/], [{ version: 9 }, /未来/]]) {
    const statePath = join(root, `failure-${Math.random()}.json`)
    const raw = JSON.stringify(state)
    await writeFile(statePath, raw, { mode: 0o600 })
    const store = createFileStore(statePath)
    await assert.rejects(store.update(current => current), pattern)
    assert.equal(await readFile(statePath, 'utf8'), raw)
  }

  const statePath = join(root, 'migrated.json')
  const original = v3Fixture()
  await writeFile(statePath, JSON.stringify(original), { mode: 0o600 })
  const store = createFileStore(statePath)
  await store.update(state => state)
  const persisted = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(persisted.version, 8)
  assert.ok(persisted.works.every(work => Array.isArray(work.actions)))
  assert.deepEqual(persisted.knowledgeMaterials, [])
  for (const key of ['channelApps', 'channelIdentities', 'channelConversations', 'channelMessages', 'deliveries', 'linkCodes']) assert.deepEqual(persisted[key], [])
  assert.deepEqual(persisted.automationRules, [])
  assert.deepEqual(persisted.automationOccurrences, [])
  assert.equal(JSON.stringify(persisted).includes('"observations"'), false)
  assert.equal(JSON.stringify(persisted).includes('"followUps"'), false)
}

async function checkAuthAndRekey() {
  const authPath = join(root, 'private', 'auth.json')
  await initializeAuthFile(authPath, {
    'member-admin': 'correct horse',
    'member-user': 'battery staple',
    'member-extra': 'extra password',
  }, { mode: 'create', allowedMemberIds: ['member-admin', 'member-user', 'member-extra'] })
  assert.equal((await stat(authPath)).mode & 0o777, 0o600)
  const rawAuth = await readFile(authPath, 'utf8')
  for (const secret of ['correct horse', 'battery staple', 'extra password']) assert.equal(rawAuth.includes(secret), false)
  const parsedAuth = JSON.parse(rawAuth)
  assert.deepEqual(Object.keys(parsedAuth).sort(), ['passwords', 'sessionSecret', 'version'])
  assert.deepEqual(Object.keys(parsedAuth.passwords['member-admin']).sort(), ['algorithm', 'salt', 'verifier'])

  let now = 1_000_000
  const auth = createAuthRuntime({ filePath: authPath, clock: () => now, sessionTtlMs: 1000 })
  assert.equal(await auth.verifyPassword('member-admin', 'correct horse'), true)
  assert.equal(await auth.verifyPassword('member-admin', 'wrong password'), false)
  const session = await auth.issueSession({ id: 'member-admin', sessionVersion: 7 })
  const verified = await auth.verifySession(session.token)
  const view = await auth.sessionView(session.token)
  assert.equal(verified.memberId, 'member-admin')
  assert.equal(verified.sessionVersion, 7)
  assert.deepEqual(view.session, verified)
  assert.equal(view.csrfToken, session.csrfToken)
  assert.equal(view.expiresAt, session.expiresAt)
  assert.equal(verified.expiresAt, now + 1000)
  assert.equal(isSessionCurrent(verified, { id: 'member-admin', enabled: true, sessionVersion: 7 }), true)
  assert.equal(isSessionCurrent(verified, { id: 'member-admin', enabled: true, sessionVersion: 8 }), false)
  assert.equal(isSessionCurrent(verified, { id: 'member-admin', enabled: false, sessionVersion: 7 }), false)
  assert.equal(isSessionCurrent(verified, { id: 'member-admin', sessionVersion: 7 }), false)
  assert.equal(await auth.verifyCsrf(session.token, session.csrfToken), true)
  assert.equal(await auth.verifyCsrf(session.token, session.csrfToken + 'x'), false)
  assert.equal(await auth.verifySession(session.token.slice(0, -1) + (session.token.endsWith('a') ? 'b' : 'a')), undefined)

  await initializeAuthFile(authPath, { 'member-admin': 'new admin password' }, {
    mode: 'rekey',
    allowedMemberIds: ['member-admin', 'member-user', 'member-extra'],
  })
  assert.equal(await auth.verifySession(session.token), undefined)
  assert.equal(await auth.verifyPassword('member-admin', 'correct horse'), false)
  assert.equal(await auth.verifyPassword('member-admin', 'new admin password'), true)
  assert.equal(await auth.verifyPassword('member-user', 'battery staple'), true)
  assert.equal(await auth.verifyPassword('member-extra', 'extra password'), true)
  await assert.rejects(initializeAuthFile(authPath, { outsider: 'outside password' }, {
    mode: 'rekey',
    allowedMemberIds: ['member-admin', 'member-user', 'member-extra'],
  }), /product facts/)

  const next = await auth.issueSession({ id: 'member-admin', sessionVersion: 8 })
  now += 1000
  assert.equal(await auth.verifySession(next.token), undefined)
  await chmod(authPath, 0o644)
  await assert.rejects(auth.verifyPassword('member-admin', 'new admin password'), /0600/)
  await chmod(authPath, 0o600)
}

async function checkInitModes() {
  const blockedStateParent = join(root, 'blocked-state-parent')
  const untouchedAuthPath = join(root, 'untouched-auth', 'auth.json')
  await writeFile(blockedStateParent, 'not a directory', { mode: 0o600 })
  await assert.rejects(runInit('bootstrap', join(blockedStateParent, 'state.json'), untouchedAuthPath, 'blocked admin', 'blocked member'))
  await assert.rejects(readFile(untouchedAuthPath), error => error?.code === 'ENOENT')

  const recoverableStatePath = join(root, 'recoverable-state.json')
  const blockedAuthParent = join(root, 'blocked-auth-parent')
  const recoverableAuthPath = join(blockedAuthParent, 'auth.json')
  await writeFile(recoverableStatePath, JSON.stringify(v3Fixture()), { mode: 0o600 })
  await writeFile(blockedAuthParent, 'not a directory', { mode: 0o600 })
  await assert.rejects(runInit('bootstrap', recoverableStatePath, recoverableAuthPath, 'recover admin', 'recover member'))
  const factsAfterAuthFailure = await createFileStore(recoverableStatePath).read()
  assert.deepEqual(factsAfterAuthFailure.members.map(member => member.id), ['member-admin', 'member-user'])
  await rm(blockedAuthParent)
  await runInit('rekey', recoverableStatePath, recoverableAuthPath, 'recover admin', 'recover member')
  assert.deepEqual((await createFileStore(recoverableStatePath).read()).members, factsAfterAuthFailure.members)
  assert.equal(await createAuthRuntime({ filePath: recoverableAuthPath }).verifyPassword('member-user', 'recover member'), true)

  const statePath = join(root, 'init-state.json')
  const authPath = join(root, 'init-private', 'auth.json')
  await writeFile(statePath, JSON.stringify(v3Fixture()), { mode: 0o600 })
  const bootstrap = await runInit('bootstrap', statePath, authPath, 'bootstrap admin', 'bootstrap member')
  assert.deepEqual(bootstrap.provisionedAuthRefs, ['member-admin', 'member-user'])
  const store = createFileStore(statePath)
  const bootstrapped = await store.read()
  assert.deepEqual(bootstrapped.members.map(member => member.id), ['member-admin', 'member-user'])
  assert.equal(bootstrapped.members[0].displayName, '旧操作者')
  assert.deepEqual(bootstrapped.members[0].employeeIds, ['employee-1'])

  const extraMember = {
    id: 'member-extra', loginName: 'extra', displayName: '额外成员', role: 'member', enabled: false,
    authRef: 'member-extra', sessionVersion: 11, employeeIds: ['employee-1'],
    createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z',
  }
  await store.update(state => ({
    ...state,
    members: [
      state.members[0],
      { ...state.members[1], enabled: false, sessionVersion: 9, employeeIds: ['employee-1'] },
      extraMember,
    ],
  }))
  await initializeAuthFile(authPath, { 'member-extra': 'kept extra password' }, {
    mode: 'rekey', allowedMemberIds: ['member-admin', 'member-user', 'member-extra'],
  })
  const auth = createAuthRuntime({ filePath: authPath })
  const oldCookie = await auth.issueSession({ id: 'member-user', sessionVersion: 9 })
  const before = await store.read()
  await runInit('rekey', statePath, authPath, 'replacement admin', 'replacement member')
  const after = await store.read()
  assert.deepEqual(after.members, before.members)
  assert.equal(after.members[1].enabled, false)
  assert.equal(after.members[1].sessionVersion, 9)
  assert.deepEqual(after.members[1].employeeIds, ['employee-1'])
  assert.deepEqual(after.members[2], extraMember)
  assert.equal(await auth.verifyPassword('member-extra', 'kept extra password'), true)
  assert.equal(await auth.verifySession(oldCookie.token), undefined)

  const restoredStatePath = join(root, 'restored-state.json')
  const restoredAuthPath = join(root, 'restored-private', 'auth.json')
  await writeFile(restoredStatePath, JSON.stringify(after), { mode: 0o600 })
  await runInit('rekey', restoredStatePath, restoredAuthPath, 'restored admin', 'restored member')
  const restoredStore = createFileStore(restoredStatePath)
  assert.deepEqual((await restoredStore.read()).members, after.members)
  const restoredAuth = createAuthRuntime({ filePath: restoredAuthPath })
  assert.equal(await restoredAuth.verifyPassword('member-admin', 'restored admin'), true)
  assert.equal(await restoredAuth.verifyPassword('member-user', 'restored member'), true)
  assert.equal(await restoredAuth.verifyPassword('member-extra', 'kept extra password'), false)
  await assert.rejects(runInit('bootstrap', statePath, authPath, 'x password', 'y password'), /bootstrap/)
  await assert.rejects(execFile(process.execPath, ['scripts/init-p2-auth.mjs', '--overwrite'], { cwd: process.cwd() }), /overwrite/)
}

async function checkRealP1Restore() {
  const explicitPath = process.env.GENEWAY_P1_RESTORE_STATE
  const statePath = explicitPath ?? '/tmp/geneway-p1-2df5d15-backup.ckAtBN/state.json'
  let original
  try {
    original = JSON.parse(await readFile(statePath, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT' || explicitPath) throw error
    console.log('P1 real restore check skipped: set GENEWAY_P1_RESTORE_STATE to require it')
    return
  }
  assert.equal(original.version, 3)
  const migrated = migrateState(original)
  const sourceWork = original.works[0]
  const work = migrated.works.find(item => item.id === sourceWork.id)
  assert.ok(work)
  assert.equal(work.results.length, sourceWork.observations.length + sourceWork.followUps.length)
  assert.deepEqual(work.results.map(item => item.id), [
    sourceWork.observations[0].observationId,
    sourceWork.followUps[0].id,
    sourceWork.observations[1].observationId,
    sourceWork.followUps[1].id,
  ])
  for (const execution of work.executions.filter(item => item.resultObservationId || item.resultFollowUpId)) {
    const legacyRef = execution.resultObservationId ?? execution.resultFollowUpId
    assert.equal(execution.resultId, legacyRef)
    assert.ok(work.results.some(result => result.id === legacyRef))
  }
  assert.deepEqual(work.results.filter(item => item.kind === 'gearjob.work-order.observation').map(item => item.payload), sourceWork.observations)
  assert.deepEqual(work.results.map(item => item.dshSessionRef), [
    sourceWork.observations[0].dshSessionRef,
    sourceWork.followUps[0].dshSessionRef,
    sourceWork.observations[1].dshSessionRef,
    sourceWork.followUps[1].dshSessionRef,
  ])
  assert.equal(work.results.at(-1).continuedFromDshSessionRef, sourceWork.followUps.at(-1).continuedFromDshSessionRef)
  assert.ok(work.results.every(item => item.pluginVersion === undefined))
}

async function runInit(mode, statePath, authPath, adminPassword, memberPassword) {
  const { stdout, stderr } = await execFile(process.execPath, [
    'scripts/init-p2-auth.mjs', '--mode', mode, '--state', statePath, '--auth', authPath,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, GENEWAY_ADMIN_PASSWORD: adminPassword, GENEWAY_MEMBER_PASSWORD: memberPassword },
  })
  assert.equal(stderr, '')
  assert.equal(stdout.includes(adminPassword), false)
  assert.equal(stdout.includes(memberPassword), false)
  return JSON.parse(stdout)
}

function v3Fixture() {
  return {
    version: 3,
    operator: { id: 'local-operator', displayName: '旧操作者' },
    employees: [{ id: 'employee-1', name: '员工', connectionIds: ['connection-1'], skillIds: ['skill-gearjob-work-order-read'] }],
    connections: [{ id: 'connection-1', name: '连接', kind: 'gearjob-rest', status: 'ready', skillIds: ['skill-gearjob-work-order-read'] }],
    skills: [{ id: 'skill-gearjob-work-order-read', name: '读取', action: 'gearjob.work-order.read', toolName: 'geneway_gearjob_read_work_order' }],
    reservations: { 'local-operator|keep': { workId: 'work-1', executionId: 'exec-1' } },
    works: [{
      id: 'work-1', operatorId: 'local-operator', employeeId: 'employee-1', connectionId: 'connection-1', workOrderId: 'WO-1', status: 'completed', acceptedAt: '2026-09-18T01:00:00.000Z',
      observations: [{ observationId: 'obs-stable', workOrderId: 'WO-1', status: 'running', plannedQuantity: 10, completedQuantity: 4, unit: '件', completion: { ratio: 0.4 }, sourceRecordId: 'Work Order:WO-1', sourceSystem: 'GearJob', sourceInstance: 'A', sourceEnvironment: 'external-test', dataMode: 'synthetic', queriedAt: '2026-09-18T01:01:00.000Z', explanation: '观察', dshSessionRef: 'session-old', continuity: 'new' }],
      followUps: [{ id: 'follow-stable', text: '为什么', explanation: '说明', at: '2026-09-18T01:02:00.000Z', dshSessionRef: 'session-new', continuedFromDshSessionRef: 'session-old', contextObservationId: 'obs-stable', continuity: 'successor' }],
      executions: [{ id: 'exec-1', status: 'completed', dshSessionRef: 'session-old', resultObservationId: 'obs-stable' }, { id: 'exec-2', status: 'completed', dshSessionRef: 'session-new', continuedFromDshSessionRef: 'session-old', contextObservationId: 'obs-stable', resultFollowUpId: 'follow-stable' }],
    }],
  }
}
