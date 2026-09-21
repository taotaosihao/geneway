import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { migrateState, STATE_VERSION } from '../src/store/file-store.mjs'

const execFile = promisify(execFileCallback)
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(repo, 'scripts', 'state-transfer.mjs')
const root = await mkdtemp(join(tmpdir(), 'geneway-p2-transfer-'))

try {
  const source = join(root, 'source')
  const statePath = join(source, 'state.json')
  const dshHome = join(source, 'dsh')
  const replayMarker = join(root, 'must-not-replay')
  const state = fixtureState()
  assert.deepEqual(migrateState(structuredClone(state)), state)
  const stateBytes = Buffer.from(JSON.stringify(state, null, 2) + '\n')
  await mkdir(source, { recursive: true })
  await writeFile(statePath, stateBytes, { mode: 0o644 })
  for (const [id, content] of [
    ['session-a', '{"event":"a"}\n'],
    ['session-b', `{"wouldReplay":${JSON.stringify(replayMarker)}}\n`],
    ['session-cycle', '{"event":"cycle"}\n'],
    ['session-unrelated', '{"secret":"not-related"}\n'],
  ]) await sessionFile(dshHome, id, content)
  await mkdir(join(dshHome, 'sessions', 'project'), { recursive: true })
  await writeFile(join(dshHome, 'sessions', 'project', 'auth.json'), 'AUTH_VERIFIER_MARKER')
  await mkdir(join(source, 'private'), { recursive: true })
  for (const [name, marker] of [
    ['auth.json', 'AUTH_VERIFIER_MARKER'],
    ['hmac.json', 'HMAC_SECRET_MARKER'],
    ['gearjob.json', 'GEARJOB_SECRET_MARKER'],
    ['zenmux.json', 'ZENMUX_SECRET_MARKER'],
    ['grant.json', 'EXECUTION_GRANT_MARKER'],
    ['claude-settings.json', 'CLAUDE_SETTINGS_MARKER'],
    ['cookies.json', 'BROWSER_COOKIE_MARKER'],
    ['lark.json', 'LARK_TOKEN_MARKER'],
  ]) await writeFile(join(source, 'private', name), marker)

  const backup = join(root, 'backup')
  await mkdir(backup, { mode: 0o777 })
  await chmod(backup, 0o777)
  const backupRun = await run(['backup', '--output', backup], {
    GENEWAY_STATE: statePath,
    GENEWAY_DSH_HOME: dshHome,
    GENEWAY_CANDIDATE: 'p2-test-candidate',
  })
  assert.equal(JSON.parse(backupRun.stdout).sessionRefs, 3)
  const manifestPath = join(backup, 'manifest.json')
  const originalManifestText = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(originalManifestText)
  assert.equal(manifest.version, 2)
  assert.equal(manifest.candidate, 'p2-test-candidate')
  assert.deepEqual(manifest.schema, {
    stateVersion: STATE_VERSION,
    members: 2,
    modelRoutes: 1,
    employees: 2,
    connections: 2,
    skills: 2,
    confirmations: 2,
    knowledgeMaterials: 0,
    channelApps: 0,
    channelIdentities: 0,
    channelConversations: 0,
    channelMessages: 0,
    deliveries: 0,
    linkCodes: 0,
    automationRules: 0,
    automationOccurrences: 0,
    works: 5,
    sessionRefs: ['session-a', 'session-b', 'session-cycle'],
  })
  assert.equal(manifest.entries.length, 4)
  assert.deepEqual(manifest.entries.map(item => item.path), [
    'dsh/sessions/project/session-a/session.v3.jsonl.zstd',
    'dsh/sessions/project/session-b/session.v3.jsonl.zstd',
    'dsh/sessions/project/session-cycle/session.v3.jsonl.zstd',
    'state.json',
  ])
  for (const entry of manifest.entries) {
    const bytes = await readFile(join(backup, ...entry.path.split('/')))
    assert.equal(entry.bytes, bytes.length)
    assert.equal(entry.sha256, digest(bytes))
  }
  const sourceState = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual(sourceState, state)
  assert.deepEqual(sourceState.works.slice(2).map(item => item.status), ['accepted', 'running', 'cancel_requested'])
  const backupStateBytes = await readFile(join(backup, 'state.json'))
  const backupState = JSON.parse(backupStateBytes)
  assert.deepEqual(backupState.works.slice(0, 2), state.works.slice(0, 2))
  assert.deepEqual(backupState.works.slice(2).map(item => item.status), ['interrupted', 'interrupted', 'interrupted'])
  for (const [index, work] of backupState.works.slice(2).entries()) {
    const execution = work.executions[0]
    assert.equal(execution.status, 'interrupted')
    assert.equal(execution.interruptedAt, manifest.createdAt)
    assert.deepEqual(execution.error, { code: 'BACKUP_INTERRUPTED', message: '备份时执行未完成' })
    assert.equal(execution.id, `execution-active-${index}`)
  }
  const stateEntry = manifest.entries.find(item => item.path === 'state.json')
  assert.equal(stateEntry.bytes, backupStateBytes.length)
  assert.equal(stateEntry.sha256, digest(backupStateBytes))
  assert.equal(await exists(join(backup, 'dsh', 'sessions', 'project', 'session-unrelated')), false)
  assert.equal(await exists(join(backup, 'private')), false)
  for (const marker of ['AUTH_VERIFIER_MARKER', 'HMAC_SECRET_MARKER', 'GEARJOB_SECRET_MARKER', 'ZENMUX_SECRET_MARKER', 'EXECUTION_GRANT_MARKER', 'CLAUDE_SETTINGS_MARKER', 'BROWSER_COOKIE_MARKER', 'LARK_TOKEN_MARKER']) {
    assert.equal((await allText(backup)).includes(marker), false)
  }
  await assertModes(backup)

  const restored = join(root, 'restored')
  await mkdir(restored, { mode: 0o777 })
  await chmod(restored, 0o777)
  const restoreRun = await run(['restore', '--input', backup, '--data-root', restored])
  assert.equal(JSON.parse(restoreRun.stdout).sessionRefs, 3)
  assert.deepEqual(JSON.parse(await readFile(join(restored, 'state.json'), 'utf8')), backupState)
  assert.equal(Buffer.compare(await readFile(join(restored, 'state.json')), backupStateBytes), 0)
  for (const entry of manifest.entries.filter(item => item.path !== 'state.json')) {
    assert.equal(Buffer.compare(await readFile(join(restored, ...entry.path.split('/'))), await readFile(join(backup, ...entry.path.split('/')))), 0)
  }
  const restoredState = JSON.parse(await readFile(join(restored, 'state.json'), 'utf8'))
  assert.deepEqual(restoredState.members.map(item => [item.id, item.role, item.employeeIds]), [
    ['member-admin', 'admin', ['employee-a', 'employee-b']],
    ['member-user', 'member', ['employee-b']],
  ])
  assert.deepEqual(restoredState.employees.map(item => [item.id, item.skillIds, item.connectionIds]), [
    ['employee-a', ['skill-gearjob-work-order-read'], ['connection-a']],
    ['employee-b', ['skill-cycle-time-calculate'], ['connection-b']],
  ])
  assert.equal(restoredState.confirmations.find(item => item.id === 'confirmation-revoked').status, 'revoked')
  assert.deepEqual(restoredState.knowledgeMaterials, [])
  for (const key of ['channelApps', 'channelIdentities', 'channelConversations', 'channelMessages', 'deliveries', 'linkCodes']) assert.deepEqual(restoredState[key], [])
  assert.deepEqual(restoredState.works.flatMap(item => item.results.map(result => result.kind)), [
    'gearjob.work-order.observation', 'assistant.follow-up', 'manufacturing.takt',
  ])
  assert.equal(restoredState.works[0].results[1].continuedFromDshSessionRef, 'session-a')
  assert.equal(restoredState.works[0].executions[1].status, 'interrupted')
  assert.deepEqual(restoredState.works.slice(2), backupState.works.slice(2))
  assert.equal(await exists(replayMarker), false)
  await assertModes(restored)

  const stableState = { ...state, works: state.works.slice(0, 2) }
  const stableBytes = Buffer.from(JSON.stringify(stableState) + '\n')
  const stableStatePath = join(root, 'stable-state.json')
  const stableBackup = join(root, 'stable-backup')
  await writeFile(stableStatePath, stableBytes)
  await run(['backup', '--output', stableBackup], { GENEWAY_STATE: stableStatePath, GENEWAY_DSH_HOME: dshHome })
  assert.equal(Buffer.compare(await readFile(join(stableBackup, 'state.json')), stableBytes), 0)

  await verifyKnowledgeTransfer(state, dshHome, replayMarker, root)
  await rejectNonEmptyTarget(backup, statePath, dshHome, root)
  await rejectMaliciousManifests(backup, manifestPath, manifest, originalManifestText, root)
  await rejectSymlinksAndNonRegular(backup, manifestPath, originalManifestText, statePath, dshHome, root)
  await rejectSecretState(state, statePath, dshHome, root)

  console.log('P2 state transfer checks passed')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function verifyKnowledgeTransfer(state, dshHome, replayMarker, root) {
  const material = {
    id: 'knowledge-transfer',
    ownerMemberId: 'member-user',
    employeeIds: ['employee-b'],
    sharedMemberIds: ['member-admin'],
    sharedEmployeeIds: ['employee-a'],
    title: '进度复核说明',
    body: '计划与完成量是业务事实，剩余时间由用户明确提供。',
    format: 'markdown',
    sourceLabel: 'P3 transfer fixture',
    authorizationBasis: '用户明确提供并授权指定员工使用',
    revision: 3,
    status: 'active',
    createdAt: '2026-09-19T05:00:00.000Z',
    updatedAt: '2026-09-19T05:30:00.000Z',
  }
  const knowledgeState = { ...state, knowledgeMaterials: [material], works: state.works.slice(0, 2) }
  assert.deepEqual(migrateState(structuredClone(knowledgeState)), knowledgeState)
  const statePath = join(root, 'knowledge-state.json')
  const backup = join(root, 'knowledge-backup')
  const restored = join(root, 'knowledge-restored')
  await writeFile(statePath, JSON.stringify(knowledgeState, null, 2) + '\n', { mode: 0o600 })
  await run(['backup', '--output', backup], { GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: dshHome })

  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema.stateVersion, STATE_VERSION)
  assert.equal(manifest.schema.knowledgeMaterials, 1)
  for (const entry of manifest.entries) {
    const bytes = await readFile(join(backup, ...entry.path.split('/')))
    assert.equal(entry.bytes, bytes.length)
    assert.equal(entry.sha256, digest(bytes))
  }
  await assertModes(backup)

  await run(['restore', '--input', backup, '--data-root', restored])
  const restoredState = JSON.parse(await readFile(join(restored, 'state.json'), 'utf8'))
  assert.deepEqual(restoredState.knowledgeMaterials, [material])
  for (const entry of manifest.entries) {
    const bytes = await readFile(join(restored, ...entry.path.split('/')))
    assert.equal(entry.bytes, bytes.length)
    assert.equal(entry.sha256, digest(bytes))
  }
  assert.equal(await exists(replayMarker), false)
  await assertModes(restored)
}

async function rejectNonEmptyTarget(backup, statePath, dshHome, root) {
  const target = join(root, 'non-empty-target')
  await mkdir(target)
  await writeFile(join(target, 'keep'), 'keep')
  await runFails(['restore', '--input', backup, '--data-root', target], /目标目录必须为空/)
  assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'keep')
  const backupTarget = join(root, 'non-empty-backup')
  await mkdir(backupTarget)
  await writeFile(join(backupTarget, 'keep'), 'keep')
  await runFails(['backup', '--output', backupTarget], /目标目录必须为空/, { GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: dshHome })
  assert.equal(await readFile(join(backupTarget, 'keep'), 'utf8'), 'keep')
}

async function rejectMaliciousManifests(backup, manifestPath, manifest, original, root) {
  const cases = [
    { name: 'absolute', mutate: value => { value.entries[0].path = '/tmp/escape' }, pattern: /路径越界/ },
    { name: 'escape', mutate: value => { value.entries[0].path = '../escape' }, pattern: /路径越界/ },
    { name: 'duplicate', mutate: value => { value.entries.push(structuredClone(value.entries[0])) }, pattern: /entry 重复/ },
    { name: 'allowlist', mutate: value => { value.entries[0].path = 'auth.json' }, pattern: /允许范围/ },
    { name: 'bytes', mutate: value => { value.entries[0].bytes += 1 }, pattern: /校验失败/ },
    { name: 'hash', mutate: value => { value.entries[0].sha256 = '0'.repeat(64) }, pattern: /校验失败/ },
    { name: 'schema', mutate: value => { value.schema.members += 1 }, pattern: /schema 摘要/ },
  ]
  for (const testCase of cases) {
    const value = structuredClone(manifest)
    testCase.mutate(value)
    await writeFile(manifestPath, JSON.stringify(value) + '\n')
    const target = join(root, `malicious-${testCase.name}`)
    if (testCase.name === 'hash') {
      await mkdir(target, { mode: 0o750 })
      await chmod(target, 0o750)
    }
    await runFails(['restore', '--input', backup, '--data-root', target], testCase.pattern)
    if (testCase.name === 'hash') {
      assert.deepEqual(await readdir(target), [])
      assert.equal((await lstat(target)).mode & 0o777, 0o750)
    } else assert.equal(await exists(target), false)
  }
  await writeFile(manifestPath, original)
  await chmod(manifestPath, 0o600)
}

async function rejectSymlinksAndNonRegular(backup, manifestPath, originalManifest, statePath, dshHome, root) {
  const inputLink = join(root, 'backup-link')
  await symlink(backup, inputLink)
  await runFails(['restore', '--input', inputLink, '--data-root', join(root, 'from-input-link')], /备份根目录不得是符号链接/)

  const realTarget = join(root, 'real-target')
  const targetLink = join(root, 'target-link')
  await mkdir(realTarget)
  await symlink(realTarget, targetLink)
  await runFails(['restore', '--input', backup, '--data-root', targetLink], /目标根目录不得是符号链接/)

  const realBackupTarget = join(root, 'real-backup-target')
  const backupTargetLink = join(root, 'backup-target-link')
  await mkdir(realBackupTarget)
  await symlink(realBackupTarget, backupTargetLink)
  await runFails(['backup', '--output', backupTargetLink], /目标根目录不得是符号链接/, { GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: dshHome })

  const entry = JSON.parse(originalManifest).entries.find(item => item.path.includes('session-a'))
  const file = join(backup, ...entry.path.split('/'))
  const held = `${file}.held`
  await rename(file, held)
  await symlink('/etc/passwd', file)
  await runFails(['restore', '--input', backup, '--data-root', join(root, 'symlink-entry')], /符号链接/)
  await unlink(file)
  await rename(held, file)

  await rename(file, held)
  await mkdir(file)
  await runFails(['restore', '--input', backup, '--data-root', join(root, 'directory-entry')], /不是普通文件/)
  await rmdir(file)
  await rename(held, file)

  const stateLink = join(root, 'state-link.json')
  await symlink(statePath, stateLink)
  await runFails(['backup', '--output', join(root, 'state-link-backup')], /备份源不得是符号链接/, { GENEWAY_STATE: stateLink, GENEWAY_DSH_HOME: dshHome })

  const dshLink = join(root, 'dsh-link')
  await symlink(dshHome, dshLink)
  await runFails(['backup', '--output', join(root, 'dsh-link-backup')], /DSH 根目录不得是符号链接/, { GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: dshLink })
  await writeFile(manifestPath, originalManifest)
  await chmod(manifestPath, 0o600)
}

async function rejectSecretState(state, statePath, dshHome, root) {
  for (const [name, mutate, pattern] of [
    ['password', value => { value.password = 'must-not-copy' }, /秘密字段：password/],
    ['token', value => { value.accessToken = 'must-not-copy' }, /秘密字段：accessToken/],
    ['secret', value => { value.apiSecret = 'must-not-copy' }, /秘密字段：apiSecret/],
    ['verifier', value => { value.passwordVerifier = 'must-not-copy' }, /秘密字段：passwordVerifier/],
    ['cookie', value => { value.browserCookie = 'must-not-copy' }, /秘密字段：browserCookie/],
    ['grant', value => { value.executionGrant = 'must-not-copy' }, /秘密字段：executionGrant/],
    ['grant-ref', value => { value.grantRef = 'must-not-copy' }, /秘密字段：grantRef/],
    ['auth-ref-lookalike', value => { value.authorizationRef = 'must-not-copy' }, /秘密字段：authorizationRef/],
    ['credential-ref-lookalike', value => { value.connectionCredentialRef = 'must-not-copy' }, /秘密字段：connectionCredentialRef/],
    ['api-key', value => { value.modelRoutes[0].apiKey = 'must-not-copy' }, /秘密字段：apiKey/],
    ['hmac', value => { value.hmacKey = 'must-not-copy' }, /秘密字段：hmacKey/],
    ['claude', value => { value.claudeSettings = { value: 'must-not-copy' } }, /秘密字段：claudeSettings/],
    ['auth', value => { value.authData = { value: 'must-not-copy' } }, /秘密字段：authData/],
    ['credential', value => { value.credential = 'must-not-copy' }, /秘密字段：credential/],
  ]) {
    const unsafe = structuredClone(state)
    mutate(unsafe)
    const unsafeState = join(root, `unsafe-${name}-state.json`)
    const unsafeBackup = join(root, `unsafe-${name}-backup`)
    await writeFile(unsafeState, JSON.stringify(unsafe))
    await runFails(['backup', '--output', unsafeBackup], pattern, { GENEWAY_STATE: unsafeState, GENEWAY_DSH_HOME: dshHome })
    assert.equal(await exists(unsafeBackup), false)
  }

  const missingSessionState = structuredClone(state)
  missingSessionState.works[1].results[0].dshSessionRef = 'session-missing'
  const missingState = join(root, 'missing-session-state.json')
  await writeFile(missingState, JSON.stringify(missingSessionState))
  await runFails(['backup', '--output', join(root, 'missing-session-backup')], /缺少关联 DSH Session：session-missing/, { GENEWAY_STATE: missingState, GENEWAY_DSH_HOME: dshHome })
  assert.equal(await exists(join(root, 'missing-session-backup')), false)
  assert.ok(await readFile(statePath))
}

async function run(args, env = {}) {
  return execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 })
}

async function runFails(args, pattern, env = {}) {
  await assert.rejects(() => run(args, env), error => pattern.test(`${error.stderr}\n${error.stdout}`))
}

async function sessionFile(dshHome, id, content) {
  const path = join(dshHome, 'sessions', 'project', id, 'session.v3.jsonl.zstd')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, content, { mode: 0o600 })
}

async function assertModes(path) {
  const info = await lstat(path)
  assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600, `mode ${path}`)
  if (info.isDirectory()) for (const child of await readdir(path)) await assertModes(join(path, child))
}

async function allText(path) {
  const chunks = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) chunks.push(await allText(child))
    else chunks.push(await readFile(child, 'utf8'))
  }
  return chunks.join('\n')
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fixtureState() {
  const gearObservation = {
    id: 'result-observation', kind: 'gearjob.work-order.observation', capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', schemaVersion: 1,
    input: { workOrderId: 'WO-P2' },
    payload: {
      observationId: 'result-observation', workOrderId: 'WO-P2', status: 'In Process', unit: 'Nos', plannedQuantity: 10, completedQuantity: 4,
      completion: { ratio: 0.4, overPlan: false }, queriedAt: '2026-09-19T01:00:00.000Z', sourceRecordId: 'Work Order:WO-P2',
      sourceSystem: 'GearJob', sourceInstance: 'A', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest',
    },
    source: { sourceSystem: 'GearJob', sourceInstance: 'A', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest', sourceRecordId: 'Work Order:WO-P2' },
    createdAt: '2026-09-19T01:00:00.000Z',
    dshSessionRef: 'session-a', continuity: 'new', contextConfirmationRefs: [{ id: 'confirmation-active', revision: 2 }],
    toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2',
  }
  const followUp = {
    id: 'result-follow-up', kind: 'assistant.follow-up', capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', schemaVersion: 1,
    input: { text: '为什么' }, payload: { text: '为什么' }, explanation: '说明', createdAt: '2026-09-19T01:01:00.000Z',
    dshSessionRef: 'session-b', continuedFromDshSessionRef: 'session-a', continuity: 'successor', contextConfirmationRefs: [{ id: 'confirmation-active', revision: 2 }],
  }
  const cycle = {
    id: 'result-cycle', kind: 'manufacturing.takt', capabilityId: 'cycle-time-calculate', skillId: 'skill-cycle-time-calculate', schemaVersion: 1,
    input: { availableSeconds: 3600, quantity: 60 }, payload: { availableSeconds: 3600, quantity: 60, secondsPerUnit: 60, unit: 'seconds/unit' },
    createdAt: '2026-09-19T02:00:00.000Z', dshSessionRef: 'session-cycle', continuity: 'new', contextConfirmationRefs: [],
    toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '2',
  }
  return {
    version: STATE_VERSION,
    members: [
      { id: 'member-admin', loginName: 'admin', displayName: '管理员', role: 'admin', enabled: true, authRef: 'member-admin', sessionVersion: 3, employeeIds: ['employee-a', 'employee-b'] },
      { id: 'member-user', loginName: 'user', displayName: '成员', role: 'member', enabled: true, authRef: 'member-user', sessionVersion: 2, employeeIds: ['employee-b'] },
    ],
    modelRoutes: [{ id: 'route-deepseek', provider: 'ZenMux', model: 'deepseek/deepseek-v4-pro', secretRef: 'zenmux-main' }],
    employees: [
      { id: 'employee-a', enabled: true, modelRouteId: 'route-deepseek', skillIds: ['skill-gearjob-work-order-read'], connectionIds: ['connection-a'] },
      { id: 'employee-b', enabled: true, modelRouteId: 'route-deepseek', skillIds: ['skill-cycle-time-calculate'], connectionIds: ['connection-b'] },
    ],
    connections: [
      { id: 'connection-a', enabled: true, revision: 2, skillIds: ['skill-gearjob-work-order-read'], credentialRef: 'gearjob-a' },
      { id: 'connection-b', enabled: true, revision: 4, skillIds: ['skill-cycle-time-calculate'], credentialRef: 'gearjob-b' },
    ],
    skills: [
      { id: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', enabled: true },
      { id: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', enabled: true },
    ],
    confirmations: [
      { id: 'confirmation-active', ownerMemberId: 'member-user', revision: 2, status: 'active', value: '白班' },
      { id: 'confirmation-revoked', ownerMemberId: 'member-user', revision: 3, status: 'revoked', revokedAt: '2026-09-19T03:00:00.000Z' },
    ],
    works: [
      {
        id: 'work-gear', ownerMemberId: 'member-user', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', status: 'waiting_input',
        results: [gearObservation, followUp], actions: [],
        executions: [
          { id: 'execution-a', status: 'completed', dshSessionRef: 'session-a', resultId: 'result-observation' },
          { id: 'execution-b', status: 'interrupted', dshSessionRef: 'session-b', continuedFromDshSessionRef: 'session-a', resultId: 'result-follow-up' },
        ],
      },
      {
        id: 'work-cycle', ownerMemberId: 'member-admin', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', status: 'completed',
        results: [cycle], actions: [], executions: [{ id: 'execution-cycle', status: 'completed', dshSessionRef: 'session-cycle', resultId: 'result-cycle' }],
      },
      ...['accepted', 'running', 'cancel_requested'].map((status, index) => ({
        id: `work-active-${index}`, ownerMemberId: 'member-user', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate',
        status, input: { availableSeconds: 3600, quantity: 60 }, results: [], actions: [],
        executions: [{ id: `execution-active-${index}`, operation: 'create', clientRequestId: `active-${index}`, status, acceptedAt: '2026-09-19T04:00:00.000Z' }],
      })),
    ],
    reservations: {},
    knowledgeMaterials: [],
    channelApps: [],
    channelIdentities: [],
    channelConversations: [],
    channelMessages: [],
    deliveries: [],
    linkCodes: [],
    automationRules: [],
    automationOccurrences: [],
  }
}
