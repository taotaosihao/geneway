import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { prepareRestoredState } from './state-transfer.mjs'

const execFile = promisify(execFileCallback), temp = await mkdtemp(join(tmpdir(), 'geneway-conversation-state-'))
const now = '2026-10-15T00:00:00.000Z', later = '2026-10-15T01:00:00.000Z'
const definition = { employeeRevision: 1, instructions: 'SYNTHETIC_INSTRUCTION', modelRouteId: 'route' }
const fingerprint = digest(JSON.stringify(definition))
try {
  const legacy = migrateState({ version: 3 })
  delete legacy.conversations
  legacy.version = 8
  legacy.works = [work('legacy-work')]
  const migrated = migrateState(legacy)
  assert.equal(migrated.version, STATE_VERSION)
  assert.deepEqual(migrated.conversations, [])
  assert.equal(migrated.works[0].conversationId, null)
  assert.deepEqual(migrated.works[0].results, legacy.works[0].results)

  const file = join(temp, 'state.json'), store = createFileStore(file)
  const complete = conversation('complete', [turn('complete', 'completed')], [{ id: 'native-complete', definitionFingerprint: fingerprint, createdAt: now }])
  const active = conversation('active', [turn('active', 'running')], [{ id: 'native-active', definitionFingerprint: fingerprint, createdAt: now }])
  const state = await store.update(() => ({ ...migrated, conversations: [complete, active], works: [...migrated.works, { ...work('linked-work'), conversationId: complete.id }] }))
  const baseline = digest(await readFile(file))
  const rejects = [
    value => { value.conversations[0].ownerMemberId = 'other' },
    value => { value.conversations[0].employeeId = 'other-agent' },
    value => { value.conversations.shift() },
    value => { value.conversations[0].sessions[0].createdAt = later },
    value => { value.conversations[0].turns[0].status = 'running'; value.conversations[0].turns[0].completedAt = null },
    value => { value.conversations[0].turns[0].userText = 'rewritten' },
    value => { value.conversations[1].turns[0].definition.instructions = 'changed' },
    value => { value.conversations[1].turns[0].userMessageId = 'other-native-message' },
    value => { value.conversations[1].turns.push({ ...turn('another', 'accepted'), sessionId: 'native-active' }) },
    value => { value.conversations[1].turns[0].assistantText = 'parallel history copy' },
    value => { value.conversations.push({ ...structuredClone(complete), id: 'session-theft' }) },
    value => { value.works.at(-1).ownerMemberId = 'other' },
    value => { value.works.at(-1).employeeId = 'other-agent' },
    value => { value.works.at(-1).conversationId = 'missing' },
  ]
  for (const change of rejects) {
    await assert.rejects(store.update(value => { change(value); return value }))
    assert.equal(digest(await readFile(file)), baseline, 'rejected mutation must not change persisted state')
  }
  await store.update(value => ({ ...value, conversations: value.conversations.map(item => item.id === complete.id ? { ...item, title: 'renamed', archivedAt: later, updatedAt: later } : item) }))
  await assert.rejects(store.update(value => ({ ...value, conversations: value.conversations.map(item => item.id === complete.id ? { ...item, archivedAt: null } : item) })), /不可恢复/)

  const restored = prepareRestoredState(state, later)
  assert.equal(restored.conversations[1].turns[0].status, 'interrupted')
  assert.equal(restored.conversations[1].turns[0].completedAt, later)
  assert.deepEqual(restored.conversations[0], complete, 'terminal history must survive recovery exactly')
  assert.deepEqual(state.conversations[1], active, 'recovery must not mutate the input snapshot')
  assert.deepEqual(prepareRestoredState(restored, '2026-10-15T02:00:00.000Z').conversations, restored.conversations)

  const dshHome = join(temp, 'dsh'), backup = join(temp, 'backup')
  for (const id of ['native-complete', 'native-active', 'unrelated-native']) {
    const directory = join(dshHome, 'sessions', 'project', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.v3.jsonl.zstd'), `SYNTHETIC_SESSION_${id}`)
  }
  const beforeBackup = await readFile(file)
  await run(['backup', '--output', backup], { GENEWAY_STATE: file, GENEWAY_DSH_HOME: dshHome })
  assert.deepEqual(await readFile(file), beforeBackup, 'backup must not interrupt the live conversation')
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema.conversations, 2)
  assert.deepEqual(manifest.schema.sessionRefs, ['native-active', 'native-complete'])
  assert.equal(manifest.entries.some(entry => entry.path.includes('unrelated-native')), false)
  const backed = JSON.parse(await readFile(join(backup, 'state.json'), 'utf8'))
  assert.equal(backed.conversations[1].turns[0].status, 'interrupted')
  assert.equal(backed.conversations[1].turns[0].error.code, 'BACKUP_INTERRUPTED')
  assert.deepEqual(backed.conversations[0], JSON.parse(beforeBackup).conversations[0])
  const restoredRoot = join(temp, 'restored')
  await run(['restore', '--input', backup, '--data-root', restoredRoot])
  assert.deepEqual(JSON.parse(await readFile(join(restoredRoot, 'state.json'), 'utf8')).conversations, backed.conversations)

  const old = join(temp, 'old-v8'), oldRoot = join(temp, 'restored-v8')
  await mkdir(old)
  const oldBytes = Buffer.from(JSON.stringify(legacy))
  await writeFile(join(old, 'state.json'), oldBytes)
  const schema = { ...manifest.schema, stateVersion: 8, members: legacy.members.length, modelRoutes: 0, employees: 0, connections: 0, skills: 0, confirmations: 0, knowledgeMaterials: 0, channelApps: 0, channelIdentities: 0, channelConversations: 0, channelMessages: 0, deliveries: 0, linkCodes: 0, automationRules: 0, automationOccurrences: 0, works: 1, sessionRefs: [] }
  delete schema.conversations
  await writeFile(join(old, 'manifest.json'), JSON.stringify({ format: 'geneway-state-transfer', version: 2, createdAt: now, candidate: null, schema, entries: [{ path: 'state.json', bytes: oldBytes.length, sha256: digest(oldBytes) }] }))
  await run(['restore', '--input', old, '--data-root', oldRoot])
  const oldRestored = JSON.parse(await readFile(join(oldRoot, 'state.json'), 'utf8'))
  assert.equal(oldRestored.version, STATE_VERSION)
  assert.deepEqual(oldRestored.conversations, [])
  assert.equal(oldRestored.works[0].conversationId, null)
  console.log('Conversation state checks passed: explicit v8 migration/restore, immutable ownership and native lineage, atomic rejection, active backup/restore interruption and terminal preservation (stdlib only; native/model/network starts=0)')
} finally { await rm(temp, { recursive: true, force: true }) }

function digest(value) { return createHash('sha256').update(value).digest('hex') }
function work(id) { return { id, ownerMemberId: 'member-admin', employeeId: 'agent', skillId: 'skill-test', capabilityId: 'test', status: 'completed', input: {}, results: [], executions: [], actions: [] } }
function conversation(id, turns, sessions) { return { id, ownerMemberId: 'member-admin', employeeId: 'agent', employeeName: 'Agent', title: id, source: 'web', channelIdentityId: null, createdAt: now, updatedAt: now, archivedAt: null, sessions, turns } }
function turn(id, status) { return { id, clientRequestId: `request-${id}`, userText: `SYNTHETIC_USER_${id}`, status, createdAt: now, startedAt: status === 'accepted' ? null : now, completedAt: status === 'completed' ? later : null, error: null, definition, definitionFingerprint: fingerprint, sessionId: `native-${id}`, userMessageId: status === 'accepted' ? null : `user-${id}`, assistantMessageIds: status === 'completed' ? [`assistant-${id}`] : [] } }
function run(args, env = {}) { return execFile(process.execPath, ['scripts/state-transfer.mjs', ...args], { cwd: process.cwd(), env: { ...process.env, ...env } }) }
