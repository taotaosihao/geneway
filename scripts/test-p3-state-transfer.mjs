import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createKnowledgeService } from '../src/knowledge-service.mjs'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const execFile = promisify(execFileCallback)
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const transfer = join(repo, 'scripts', 'state-transfer.mjs')
const temp = await mkdtemp(join(tmpdir(), 'geneway-p3-transfer-'))

try {
  await legacyV4Restore()
  await legacyV5Restore()
  await legacyV6Restore()
  await completeV6Transfer()
  console.log('P3 state transfer checks passed; external effects=unknown; replay/dispatch=0')
} finally {
  await rm(temp, { recursive: true, force: true })
}

async function legacyV4Restore() {
  const input = join(temp, 'legacy-v4')
  const output = join(temp, 'legacy-v4-restored')
  const state = v4State()
  const stateBytes = bytes(state)
  const session = Buffer.from('{"legacy":true}\n')
  const sessionPath = 'dsh/sessions/project/session-v4/session.v3.jsonl.zstd'
  await put(input, 'state.json', stateBytes)
  await put(input, sessionPath, session)
  const manifest = {
    format: 'geneway-state-transfer', version: 2, createdAt: '2026-09-20T00:00:00.000Z', candidate: 'legacy-v4',
    schema: { stateVersion: 4, members: 4, modelRoutes: 0, employees: 4, connections: 0, skills: 1, confirmations: 0, works: 1, sessionRefs: ['session-v4'] },
    entries: [entry(sessionPath, session), entry('state.json', stateBytes)].sort((a, b) => a.path.localeCompare(b.path)),
  }
  await put(input, 'manifest.json', bytes(manifest))
  const before = await treeDigest(input)
  await assert.rejects(run(['backup', '--output', join(temp, 'legacy-backup-rejected')], { GENEWAY_STATE: join(input, 'state.json'), GENEWAY_DSH_HOME: join(input, 'dsh') }), /产品状态版本不受支持/)
  await run(['restore', '--input', input, '--data-root', output])
  assert.deepEqual(await treeDigest(input), before)
  const restored = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'))
  assert.deepEqual(restored, migrateState(state))
  assert.deepEqual(restored.knowledgeMaterials, [])
  assert.equal(digest(await readFile(join(output, ...sessionPath.split('/')))), digest(session))
  await assertModes(output)

  for (const [name, mutate, pattern] of [
    ['manifest-v1', value => { value.version = 1 }, /manifest 无效/],
    ['manifest-v3', value => { value.version = 3 }, /manifest 无效/],
    ['state-v3', value => { value.schema.stateVersion = 3 }, /版本不受支持|schema 摘要/],
    ['state-v10', value => { value.schema.stateVersion = 10 }, /版本不受支持|schema 摘要/],
  ]) {
    const bad = join(temp, name)
    await copyBackup(input, bad)
    const value = JSON.parse(await readFile(join(bad, 'manifest.json'), 'utf8'))
    mutate(value)
    if (name.startsWith('state-')) {
      const stateValue = JSON.parse(await readFile(join(bad, 'state.json'), 'utf8'))
      stateValue.version = Number(name.slice(-1))
      const raw = bytes(stateValue)
      await writeFile(join(bad, 'state.json'), raw)
      const stateEntry = value.entries.find(item => item.path === 'state.json')
      Object.assign(stateEntry, entry('state.json', raw))
    }
    await writeFile(join(bad, 'manifest.json'), bytes(value))
    const target = join(temp, `${name}-target`)
    await assert.rejects(run(['restore', '--input', bad, '--data-root', target]), error => pattern.test(`${error.stderr}\n${error.stdout}`))
    assert.equal(await exists(target), false)
  }
}

async function legacyV5Restore() {
  const input = join(temp, 'legacy-v5')
  const output = join(temp, 'legacy-v5-restored')
  const state = v5State()
  const refs = collectRefs(state)
  const files = [['state.json', bytes(state)], ...refs.map(id => [`dsh/sessions/project/${id}/session.v3.jsonl.zstd`, Buffer.from(`{"session":${JSON.stringify(id)}}\n`)])]
  for (const [path, raw] of files) await put(input, path, raw)
  const manifest = {
    format: 'geneway-state-transfer', version: 2, createdAt: '2026-09-20T00:00:00.000Z', candidate: 'legacy-v5',
    schema: { stateVersion: 5, members: 4, modelRoutes: 0, employees: 3, connections: 0, skills: 1, confirmations: 0, knowledgeMaterials: 2, works: state.works.length, sessionRefs: refs },
    entries: files.map(([path, raw]) => entry(path, raw)).sort((a, b) => a.path.localeCompare(b.path)),
  }
  await put(input, 'manifest.json', bytes(manifest))
  assert.equal(Object.keys(manifest.schema).some(key => key.startsWith('channel') || ['deliveries', 'linkCodes'].includes(key)), false)
  const before = await treeDigest(input)
  await run(['restore', '--input', input, '--data-root', output])
  assert.deepEqual(await treeDigest(input), before)
  const restored = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'))
  assert.deepEqual(restored, migrateState(state))
  assert.equal(restored.version, 9)
  assert.ok(restored.works.every(work => Array.isArray(work.actions)))
  assert.equal(restored.knowledgeMaterials.find(item => item.id === 'knowledge-active').body, 'CURRENT KNOWLEDGE BODY')
  for (const key of ['channelApps', 'channelIdentities', 'channelConversations', 'channelMessages', 'deliveries', 'linkCodes']) assert.deepEqual(restored[key], [])
  assert.deepEqual(restored.automationRules, [])
  assert.deepEqual(restored.automationOccurrences, [])
  for (const id of refs) assert.equal(await exists(join(output, 'dsh', 'sessions', 'project', id, 'session.v3.jsonl.zstd')), true)
}

async function legacyV6Restore() {
  const input = join(temp, 'legacy-v6')
  const output = join(temp, 'legacy-v6-restored')
  const state = v6State()
  const refs = collectRefs(state)
  const files = [['state.json', bytes(state)], ...refs.map(id => [`dsh/sessions/project/${id}/session.v3.jsonl.zstd`, Buffer.from(`{"session":${JSON.stringify(id)}}\n`)])]
  for (const [path, raw] of files) await put(input, path, raw)
  const manifest = {
    format: 'geneway-state-transfer', version: 2, createdAt: '2026-09-20T00:00:00.000Z', candidate: 'legacy-v6',
    schema: { stateVersion: 6, members: state.members.length, modelRoutes: state.modelRoutes.length, employees: state.employees.length, connections: state.connections.length, skills: state.skills.length, confirmations: state.confirmations.length, knowledgeMaterials: state.knowledgeMaterials.length, channelApps: state.channelApps.length, channelIdentities: state.channelIdentities.length, channelConversations: state.channelConversations.length, channelMessages: state.channelMessages.length, deliveries: state.deliveries.length, linkCodes: state.linkCodes.length, works: state.works.length, sessionRefs: refs },
    entries: files.map(([path, raw]) => entry(path, raw)).sort((a, b) => a.path.localeCompare(b.path)),
  }
  await put(input, 'manifest.json', bytes(manifest))
  await run(['restore', '--input', input, '--data-root', output])
  const restored = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'))
  assert.equal(restored.works.length, state.works.length)
  assert.equal(restored.version, 9)
  assert.ok(restored.works.every(work => Array.isArray(work.actions)))
  assert.deepEqual(restored.automationRules, [])
  assert.deepEqual(restored.automationOccurrences, [])
  assert.ok(restored.channelApps.every(app => app.enabled === false && app.status === 'disabled'))
  await assertModes(output)
}

async function completeV6Transfer() {
  const source = join(temp, 'v6-source')
  const backup = join(temp, 'v6-backup')
  const restored = join(temp, 'v6-restored')
  const rawSourceState = v6State()
  const sourceState = migrateState(structuredClone(rawSourceState))
  assert.equal(rawSourceState.version, 6)
  assert.equal(sourceState.version, 9)
  assert.deepEqual(sourceState.automationRules, [])
  assert.deepEqual(sourceState.automationOccurrences, [])
  await put(source, 'state.json', bytes(sourceState))
  const refs = collectRefs(sourceState)
  for (const id of [...refs, 'session-unrelated']) await put(source, `dsh/sessions/project/${id}/session.v3.jsonl.zstd`, Buffer.from(`{"session":${JSON.stringify(id)}}\n`))
  await put(source, 'private/zenmux', Buffer.from('P3_ZENMUX_SECRET_CANARY'))
  await put(source, 'private/gearjob', Buffer.from('P3_GEARJOB_SECRET_CANARY'))
  await put(source, 'private/channel', Buffer.from('P4_CHANNEL_SECRET_CANARY'))
  const sourceBefore = await treeDigest(source)

  const backupRun = JSON.parse((await run(['backup', '--output', backup], { GENEWAY_STATE: join(source, 'state.json'), GENEWAY_DSH_HOME: join(source, 'dsh') })).stdout)
  assert.equal(backupRun.sessionRefs, refs.length)
  assert.deepEqual(await treeDigest(source), sourceBefore)
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.schema.sessionRefs, refs)
  for (const key of ['channelApps', 'channelIdentities', 'channelConversations', 'channelMessages', 'deliveries', 'linkCodes']) assert.equal(manifest.schema[key], sourceState[key].length)
  assert.equal(manifest.entries.some(item => item.path.includes('session-unrelated')), false)
  assert.equal((await allText(backup)).includes('P3_ZENMUX_SECRET_CANARY'), false)
  assert.equal((await allText(backup)).includes('P3_GEARJOB_SECRET_CANARY'), false)
  assert.equal((await allText(backup)).includes('P4_CHANNEL_SECRET_CANARY'), false)
  await rejectUnsafeAuthorizationRevisions(sourceState, source)

  const interrupted = JSON.parse(await readFile(join(backup, 'state.json'), 'utf8'))
  const root = interrupted.works.find(work => work.id === 'work-root')
  const done = interrupted.works.find(work => work.id === 'work-child-done')
  const active = interrupted.works.find(work => work.id === 'work-child-active')
  const waiting = interrupted.works.find(work => work.id === 'work-waiting-independent')
  const sourceTerminalSiblings = sourceState.works.filter(work => work.rootWorkId === 'work-root-terminal-siblings')
  const backupTerminalSiblings = interrupted.works.filter(work => work.rootWorkId === 'work-root-terminal-siblings')
  assert.deepEqual([root.status, root.collaboration.status, root.plan.items[1].status], ['interrupted', 'interrupted', 'interrupted'])
  assert.equal(root.executions.at(-1).error.code, 'BACKUP_INTERRUPTED')
  assert.equal(done.status, 'completed')
  assert.equal(done.results.length, 2)
  assert.equal(active.status, 'interrupted')
  assert.equal(active.executions.at(-1).error.code, 'BACKUP_INTERRUPTED')
  assert.equal(waiting.status, 'waiting_input')
  assert.deepEqual(backupTerminalSiblings, sourceTerminalSiblings)
  assert.deepEqual(interrupted.works.find(work => work.id === 'work-root-terminal-siblings').plan.items.map(item => item.status), ['failed', 'cancelled', 'interrupted'])
  assert.deepEqual(interrupted.deliveries.find(item => item.id === 'delivery-sending').authorizationRevisions, { app: 1, identity: 1, conversation: 1 })
  assert.deepEqual(migrateState(structuredClone(interrupted)), interrupted)

  let dispatches = 0
  await run(['restore', '--input', backup, '--data-root', restored])
  const restoredState = JSON.parse(await readFile(join(restored, 'state.json'), 'utf8'))
  assert.ok(restoredState.channelApps.every(app => app.enabled === false && app.status === 'disabled'))
  assert.deepEqual(restoredState.linkCodes.map(link => link.status), ['cancelled', 'cancelled'])
  assert.equal(restoredState.channelIdentities.find(item => item.id === 'identity-pending').status, 'unlinked')
  assert.equal(restoredState.channelConversations.find(item => item.id === 'conversation-pending').status, 'unlinked')
  assert.deepEqual(Object.fromEntries(restoredState.deliveries.map(item => [item.id, item.status])), {
    'delivery-pending': 'pending',
    'delivery-sending': 'unknown',
    'delivery-failed': 'failed',
    'delivery-unknown': 'unknown',
    'delivery-delivered': 'delivered',
  })
  assert.equal(restoredState.deliveries.find(item => item.id === 'delivery-sending').error.code, 'RECOVERY_UNKNOWN')
  assert.deepEqual(restoredState.channelMessages, interrupted.channelMessages)
  assert.equal(restoredState.deliveries.length, interrupted.deliveries.length)
  const store = createFileStore(join(restored, 'state.json'))
  const knowledge = createKnowledgeService({ store })
  const works = createWorkService({ store, runner: { run() { dispatches += 1 }, async close() {} }, collaborationRunner: { run() { dispatches += 1 }, async close() {} } })
  const owner = { id: 'member-owner' }, peer = { id: 'member-peer' }, outsider = { id: 'member-outsider' }
  assert.equal((await knowledge.getMaterial(owner, 'knowledge-active')).body, 'CURRENT KNOWLEDGE BODY')
  assert.equal((await knowledge.readMaterial(peer, 'knowledge-active', { employeeId: 'employee-child' })).body, 'CURRENT KNOWLEDGE BODY')
  await assert.rejects(knowledge.readMaterial(outsider, 'knowledge-active', { employeeId: 'employee-child' }), error => error.code === 'NOT_FOUND')
  await assert.rejects(knowledge.readMaterial(peer, 'knowledge-active', { employeeId: 'employee-disabled' }), error => error.code === 'NOT_FOUND')
  const tombstone = await knowledge.getMaterial(owner, 'knowledge-deleted')
  assert.equal(tombstone.status, 'deleted')
  assert.equal('body' in tombstone, false)
  const projected = (await works.getWork(owner, 'work-root')).value
  assert.equal(JSON.stringify(projected).includes('OLD_KNOWLEDGE_CANARY'), false)
  assert.equal(projected.results[0].knowledgeUnavailable, true)
  assert.equal(dispatches, 0)
  assert.equal(JSON.stringify(await store.read()).includes('pluginEnabled'), false)
  const tightened = await knowledge.updateSharing(owner, 'knowledge-active', { expectedRevision: 2, memberIds: [], employeeIds: [] })
  assert.equal(tightened.revision, 3)
  const deleted = await knowledge.deleteMaterial(owner, 'knowledge-active', { expectedRevision: 3 })
  assert.equal(deleted.status, 'deleted')
  assert.equal(dispatches, 0)
  await assertModes(restored)

  await rejectSessionMismatch(backup, manifest)
  await rejectTamperAndFilesystem(backup, manifest)
}

async function rejectUnsafeAuthorizationRevisions(state, source) {
  for (const [name, value] of [
    ['scalar', 'P4_PLAINTEXT_SECRET_CANARY'],
    ['extra-key', { app: 1, identity: 1, conversation: 1, secret: 'P4_PLAINTEXT_SECRET_CANARY' }],
    ['string-value', { app: 'P4_PLAINTEXT_SECRET_CANARY', identity: 1, conversation: 1 }],
  ]) {
    const statePath = join(temp, `unsafe-authorization-revisions-${name}.json`)
    const output = join(temp, `unsafe-authorization-revisions-${name}-backup`)
    await writeFile(statePath, bytes({ ...state, authorizationRevisions: value }), { mode: 0o600 })
    await assert.rejects(run(['backup', '--output', output], { GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: join(source, 'dsh') }), error => /秘密字段：authorizationRevisions/.test(`${error.stderr}\n${error.stdout}`))
    assert.equal(await exists(output), false)
  }
}

async function rejectSessionMismatch(backup, manifest) {
  for (const [name, mutate] of [
    ['missing-session', async root => rm(join(root, ...manifest.entries.find(item => item.path.includes('session-root-current')).path.split('/')))],
    ['extra-session', async root => {
      const raw = Buffer.from('{}\n'), path = 'dsh/sessions/project/session-extra/session.v3.jsonl.zstd'
      await put(root, path, raw)
      const value = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
      value.entries.push(entry(path, raw)); value.entries.sort((a, b) => a.path.localeCompare(b.path))
      await writeFile(join(root, 'manifest.json'), bytes(value))
    }],
  ]) {
    const copy = join(temp, name)
    await copyBackup(backup, copy)
    await mutate(copy)
    const target = join(temp, `${name}-target`)
    await assert.rejects(run(['restore', '--input', copy, '--data-root', target]))
    assert.equal(await exists(target), false)
  }
}

async function rejectTamperAndFilesystem(backup, manifest) {
  const cases = [
    ['hash', value => { value.entries.find(item => item.path === 'state.json').sha256 = '0'.repeat(64) }],
    ['schema', value => { value.schema.works += 1 }],
    ['path', value => { value.entries[0].path = '../escape' }],
  ]
  for (const [name, mutate] of cases) {
    const copy = join(temp, `tamper-${name}`)
    await copyBackup(backup, copy)
    const value = structuredClone(manifest); mutate(value)
    await writeFile(join(copy, 'manifest.json'), bytes(value))
    const target = join(temp, `tamper-${name}-target`)
    await mkdir(target, { mode: 0o750 }); await chmod(target, 0o750)
    await assert.rejects(run(['restore', '--input', copy, '--data-root', target]))
    assert.deepEqual(await readdir(target), [])
    assert.equal((await lstat(target)).mode & 0o777, 0o750)
  }
  const linked = join(temp, 'linked-backup')
  await symlink(backup, linked)
  await assert.rejects(run(['restore', '--input', linked, '--data-root', join(temp, 'linked-target')]))
  await assert.rejects(run(['restore', '--input', backup, '--data-root', join(backup, 'nested-target')]), /不得重叠/)
  const realParent = join(temp, 'real-parent'), linkedParent = join(temp, 'linked-parent')
  await mkdir(realParent); await symlink(realParent, linkedParent)
  await assert.rejects(run(['restore', '--input', backup, '--data-root', join(linkedParent, 'target')]), /不得经过符号链接/)
  for (const [name, replace] of [
    ['entry-link', async path => symlink('/etc/passwd', path)],
    ['entry-directory', async path => mkdir(path)],
  ]) {
    const copy = join(temp, name)
    await copyBackup(backup, copy)
    const path = join(copy, 'state.json')
    await rm(path); await replace(path)
    await assert.rejects(run(['restore', '--input', copy, '--data-root', join(temp, `${name}-target`)]))
  }
  const nonempty = join(temp, 'nonempty')
  await put(nonempty, 'keep', Buffer.from('keep'))
  await assert.rejects(run(['restore', '--input', backup, '--data-root', nonempty]))
  assert.equal(await readFile(join(nonempty, 'keep'), 'utf8'), 'keep')
}

function v4State() {
  return {
    version: 4,
    members: [member('member-admin', 'admin', ['employee-lead']), member('member-owner', 'member', ['employee-lead', 'employee-child']), member('member-peer', 'member', ['employee-child']), member('member-outsider', 'member', ['employee-child'])],
    modelRoutes: [], employees: ['employee-lead', 'employee-child', 'employee-disabled', 'employee-other'].map(id => ({ id, enabled: id !== 'employee-disabled' })), connections: [], skills: [{ id: 'skill-test' }], confirmations: [],
    works: [{ id: 'work-v4', ownerMemberId: 'member-owner', employeeId: 'employee-child', skillId: 'skill-test', capabilityId: 'capability-test', status: 'completed', results: [{ id: 'result-v4', kind: 'assistant.follow-up', capabilityId: 'capability-test', skillId: 'skill-test', schemaVersion: 1, input: { text: 'legacy' }, payload: { text: 'legacy' }, createdAt: '2026-09-19T00:00:00.000Z', dshSessionRef: 'session-v4', contextConfirmationRefs: [] }], executions: [{ id: 'exec-v4', status: 'completed', resultId: 'result-v4', dshSessionRef: 'session-v4' }] }], reservations: {},
  }
}

function v5State() {
  const now = '2026-09-20T00:00:00.000Z'
  const oldRef = { knowledgeId: 'knowledge-active', revision: 1, segmentId: 'p1-c1' }
  const oldResult = result('result-old', 'handoff-old', 1, 'session-child-old', oldRef)
  const currentResult = result('result-current', 'handoff-current', 2, 'session-child-current', oldRef)
  const oldSummary = { id: 'summary-old', kind: 'assistant.collaboration-summary', capabilityId: 'cycle-time-calculate', skillId: 'skill-cycle-time-calculate', schemaVersion: 1, input: {}, payload: { resultRefs: ['result-old'] }, explanation: 'OLD_KNOWLEDGE_CANARY summary', createdAt: now, dshSessionRef: 'session-root-old', contextConfirmationRefs: [], employeeId: 'employee-lead', handoffRefs: ['handoff-old'], usage: usage(), generation: 1, knowledgeDependencyRefs: [oldRef] }
  return {
    version: 5,
    members: [member('member-admin', 'admin', ['employee-lead']), member('member-owner', 'member', ['employee-lead', 'employee-child']), member('member-peer', 'member', ['employee-child', 'employee-disabled']), member('member-outsider', 'member', ['employee-child'])],
    modelRoutes: [], employees: [{ id: 'employee-lead', enabled: true }, { id: 'employee-child', enabled: true }, { id: 'employee-disabled', enabled: false }], connections: [], skills: [{ id: 'skill-cycle-time-calculate' }], confirmations: [],
    knowledgeMaterials: [
      { id: 'knowledge-active', ownerMemberId: 'member-owner', employeeIds: ['employee-lead', 'employee-child'], sharedMemberIds: ['member-peer'], sharedEmployeeIds: ['employee-child'], title: 'Current', body: 'CURRENT KNOWLEDGE BODY', format: 'text', sourceLabel: 'fixture', authorizationBasis: 'explicit', revision: 2, status: 'active', createdAt: now, updatedAt: now },
      { id: 'knowledge-deleted', ownerMemberId: 'member-owner', revision: 2, status: 'deleted', createdAt: now, updatedAt: now, deletedAt: now },
    ],
    works: [
      { id: 'work-root', ownerMemberId: 'member-owner', employeeId: 'employee-lead', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', goal: 'active tree', input: {}, requiredInputs: [], status: 'running', acceptedAt: now, results: [oldSummary], executions: [{ id: 'exec-root-old', status: 'completed', resultId: 'summary-old', generation: 1, cancelGeneration: 0, planRevision: 1, employeeId: 'employee-lead', dshSessionRef: 'session-root-old' }, { id: 'exec-root-current', status: 'running', generation: 2, cancelGeneration: 0, planRevision: 2, employeeId: 'employee-lead', dshSessionRef: 'session-root-current', continuedFromDshSessionRef: 'session-root-old' }], workType: 'collaboration', collaboration: { generation: 2, cancelGeneration: 0, status: 'running', requestLimit: 12, requestCount: 2, childLimit: 4, maxConcurrentChildren: 2, rootTimeoutMs: 360000, childTimeoutMs: 120000, outputMaxTokens: 4096, childWorkIds: ['work-child-done', 'work-child-active'], summaryResultRefs: [], staleKnowledgeRefs: [], staleItemIds: [] }, plan: { revision: 2, items: [{ id: 'item-done', childWorkId: 'work-child-done', goal: 'done', employeeId: 'employee-child', status: 'completed', dependsOn: [] }, { id: 'item-active', childWorkId: 'work-child-active', goal: 'active', employeeId: 'employee-child', status: 'not_started', dependsOn: ['item-done'] }] }, handoffs: [{ id: 'handoff-old', childWorkId: 'work-child-done', fromEmployeeId: 'employee-child', toEmployeeId: 'employee-lead', resultRefs: ['result-old'], knowledgeRefs: [oldRef], revision: 1, generation: 1, status: 'superseded', createdAt: now }, { id: 'handoff-current', childWorkId: 'work-child-done', fromEmployeeId: 'employee-child', toEmployeeId: 'employee-lead', resultRefs: ['result-current'], knowledgeRefs: [oldRef], revision: 2, generation: 2, status: 'current', createdAt: now }] },
      { id: 'work-child-done', ownerMemberId: 'member-owner', employeeId: 'employee-child', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', goal: 'done', input: { availableSeconds: 60, quantity: 1 }, requiredInputs: [], status: 'completed', acceptedAt: now, results: [oldResult, currentResult], executions: [{ id: 'exec-child-old', status: 'completed', resultId: 'result-old', generation: 1, cancelGeneration: 0, planRevision: 1, employeeId: 'employee-child', dshSessionRef: 'session-child-old' }, { id: 'exec-child-current', status: 'completed', resultId: 'result-current', generation: 2, cancelGeneration: 0, planRevision: 2, employeeId: 'employee-child', dshSessionRef: 'session-child-current', continuedFromDshSessionRef: 'session-child-old' }], workType: 'collaboration-child', parentWorkId: 'work-root', rootWorkId: 'work-root', collaborationGeneration: 2, planItemId: 'item-done', knowledgeQuery: 'current' },
      { id: 'work-child-active', ownerMemberId: 'member-owner', employeeId: 'employee-child', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', goal: 'active', input: { availableSeconds: 120, quantity: 2 }, requiredInputs: [], status: 'accepted', acceptedAt: now, results: [], executions: [{ id: 'exec-child-active', status: 'accepted', generation: 2, cancelGeneration: 0, planRevision: 2, employeeId: 'employee-child', dshSessionRef: 'session-child-active' }], workType: 'collaboration-child', parentWorkId: 'work-root', rootWorkId: 'work-root', collaborationGeneration: 2, planItemId: 'item-active' },
      { id: 'work-waiting-independent', ownerMemberId: 'member-owner', employeeId: 'employee-child', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', status: 'waiting_input', results: [], executions: [] },
      { id: 'work-root-terminal-siblings', ownerMemberId: 'member-owner', employeeId: 'employee-lead', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', goal: 'preserve terminal siblings', input: {}, requiredInputs: [], status: 'running', acceptedAt: now, results: [], executions: [{ id: 'exec-terminal-root', status: 'running', generation: 1, cancelGeneration: 0, planRevision: 1, employeeId: 'employee-lead' }], workType: 'collaboration', collaboration: { generation: 1, cancelGeneration: 0, status: 'running', requestLimit: 12, requestCount: 0, childLimit: 4, maxConcurrentChildren: 2, rootTimeoutMs: 360000, childTimeoutMs: 120000, outputMaxTokens: 4096, childWorkIds: ['work-child-failed', 'work-child-cancelled', 'work-child-interrupted'], summaryResultRefs: [], staleKnowledgeRefs: [], staleItemIds: [] }, plan: { revision: 1, items: [{ id: 'item-failed', childWorkId: 'work-child-failed', goal: 'failed', employeeId: 'employee-child', status: 'failed', dependsOn: [] }, { id: 'item-cancelled', childWorkId: 'work-child-cancelled', goal: 'cancelled', employeeId: 'employee-child', status: 'cancelled', dependsOn: [] }, { id: 'item-interrupted', childWorkId: 'work-child-interrupted', goal: 'interrupted', employeeId: 'employee-child', status: 'interrupted', dependsOn: [] }] }, handoffs: [] },
      ...['failed', 'cancelled', 'interrupted'].map(status => ({ id: `work-child-${status}`, ownerMemberId: 'member-owner', employeeId: 'employee-child', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', goal: status, input: { availableSeconds: 60, quantity: 1 }, requiredInputs: [], status, acceptedAt: now, results: [], executions: [{ id: `exec-child-${status}`, status }], workType: 'collaboration-child', parentWorkId: 'work-root-terminal-siblings', rootWorkId: 'work-root-terminal-siblings', collaborationGeneration: 1, planItemId: `item-${status}` })),
    ], reservations: {},
  }
}

function v6State() {
  const state = structuredClone(v5State())
  const now = '2026-09-20T00:00:00.000Z'
  const app = { id: 'app-feishu', provider: 'feishu', providerAppId: 'provider-app', providerTenantId: 'provider-tenant', credentialRef: 'P4_CHANNEL_CREDENTIAL', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }
  const activeIdentity = { id: 'identity-active', channelAppId: app.id, providerUserId: 'provider-user-active', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }
  const pendingIdentity = { id: 'identity-pending', channelAppId: app.id, providerUserId: 'provider-user-pending', memberId: 'member-peer', verificationMethod: 'link-code', status: 'pending', revision: 1, createdAt: now, updatedAt: now }
  const activeConversation = { id: 'conversation-active', channelAppId: app.id, providerConversationId: 'provider-conversation-active', provider: app.provider, identityId: activeIdentity.id, memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }
  const pendingConversation = { id: 'conversation-pending', channelAppId: app.id, providerConversationId: 'provider-conversation-pending', provider: app.provider, identityId: pendingIdentity.id, memberId: 'member-peer', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'pending', revision: 1, createdAt: now, updatedAt: now }
  const message = { id: 'channel-message-inbound', channelAppId: app.id, provider: app.provider, providerEventId: 'provider-event-1', providerMessageId: 'provider-inbound-1', providerConversationId: activeConversation.providerConversationId, providerUserId: activeIdentity.providerUserId, conversationId: activeConversation.id, senderIdentityId: activeIdentity.id, direction: 'inbound', text: '历史消息保留', receivedAt: now, persistedAt: now, status: 'accepted', workId: 'work-root' }
  const delivery = (id, status, extra = {}) => ({ id, channelAppId: app.id, requestId: `request-${id}`, provider: app.provider, workId: 'work-root', resultId: 'summary-old', channelMessageId: message.id, targetConversationId: activeConversation.id, targetIdentityId: activeIdentity.id, contentScope: 'result', ...(status === 'pending' ? {} : { authorizationRevisions: { app: 1, identity: 1, conversation: 1 } }), status, attempts: status === 'pending' ? 0 : 1, createdAt: now, updatedAt: now, ...extra })
  return {
    ...state,
    version: 6,
    channelApps: [app],
    channelIdentities: [activeIdentity, pendingIdentity],
    channelConversations: [activeConversation, pendingConversation],
    channelMessages: [message],
    deliveries: [
      delivery('delivery-pending', 'pending'),
      delivery('delivery-sending', 'sending', { authorizationRevisions: { app: 1, identity: 1, conversation: 1 } }),
      delivery('delivery-failed', 'failed', { error: { code: 'PLATFORM_FAILED', message: '发送失败' } }),
      delivery('delivery-unknown', 'unknown', { error: { code: 'DELIVERY_UNKNOWN', message: '发送效果待核对' } }),
      delivery('delivery-delivered', 'delivered', { providerMessageId: 'provider-outbound-1' }),
    ],
    linkCodes: [
      { id: 'link-active', channelAppId: app.id, memberId: 'member-owner', digest: 'a'.repeat(64), status: 'active', failedAttempts: 0, expiresAt: '2026-09-20T00:10:00.000Z', createdAt: now, updatedAt: now },
      { id: 'link-matched', channelAppId: app.id, memberId: 'member-peer', digest: 'b'.repeat(64), status: 'matched', failedAttempts: 0, expiresAt: '2026-09-20T00:10:00.000Z', createdAt: now, updatedAt: now, matchedIdentityId: pendingIdentity.id, matchedConversationId: pendingConversation.id, matchedAt: now },
    ],
  }
}

function result(id, handoff, generation, session, ref) {
  return { id, kind: 'manufacturing.takt', capabilityId: 'cycle-time-calculate', skillId: 'skill-cycle-time-calculate', schemaVersion: 1, input: { availableSeconds: 60, quantity: 1 }, payload: { availableSeconds: 60, quantity: 1, secondsPerUnit: 60, unit: 'seconds/unit' }, explanation: 'OLD_KNOWLEDGE_CANARY result', createdAt: '2026-09-20T00:00:00.000Z', toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '2', dshSessionRef: session, contextConfirmationRefs: [], employeeId: 'employee-child', handoffRefs: [handoff], usage: usage(), generation, knowledgeDependencyRefs: [ref] }
}
function usage() { return { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null } }
function member(id, role, employeeIds) { return { id, loginName: id, displayName: id, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds } }
function collectRefs(state) { const refs = new Set(); visit(state.works, (key, value) => { if (['dshSessionRef', 'continuedFromDshSessionRef'].includes(key) && typeof value === 'string') refs.add(value) }); return [...refs].sort() }
function visit(value, inspect, key = '') { inspect(key, value); if (Array.isArray(value)) for (const item of value) visit(item, inspect); else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, inspect, childKey) }
function bytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n') }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function entry(path, raw) { return { path, bytes: raw.length, sha256: digest(raw) } }
async function put(root, path, raw) { const target = join(root, ...path.split('/')); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, raw, { mode: 0o600 }); await chmod(target, 0o600) }
async function run(args, env = {}) { return execFile(process.execPath, [transfer, ...args], { env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 }) }
async function copyBackup(source, target) { for (const [path, raw] of await treeFiles(source)) await put(target, path, raw) }
async function treeFiles(root, prefix = '') { const files = []; for (const item of await readdir(root, { withFileTypes: true })) { const path = prefix ? `${prefix}/${item.name}` : item.name; if (item.isDirectory()) files.push(...await treeFiles(join(root, item.name), path)); else files.push([path, await readFile(join(root, item.name))]) } return files }
async function treeDigest(root) { return Object.fromEntries((await treeFiles(root)).map(([path, raw]) => [path, digest(raw)])) }
async function allText(root) { return (await treeFiles(root)).map(([, raw]) => raw.toString('utf8')).join('\n') }
async function assertModes(path) { const info = await lstat(path); assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600); if (info.isDirectory()) for (const name of await readdir(path)) await assertModes(join(path, name)) }
async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
