import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createAutomationService } from '../src/automation-service.mjs'
import { getCapability } from '../src/capabilities.mjs'
import { normalizeTpmObservation } from '../src/domain/tpm.mjs'
import { digest, KIVO_EVENT_SOURCES_FILE, readKivoEventSources, verifyKivoEvent } from '../src/kivo-events.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { createFileStore, STATE_VERSION } from '../src/store/file-store.mjs'

const execFile = promisify(execFileCallback)
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const transfer = join(repo, 'scripts', 'state-transfer.mjs')
const temp = await mkdtemp(join(tmpdir(), 'geneway-kivo-transfer-'))
const now = '2026-10-16T01:00:00.000Z'
const objectId = '00000000-0000-4000-8000-000000000001', deviceId = '00000000-0000-4000-8000-000000000002'
const cap = getCapability('kivo-tpm-record-read'), actor = { id: 'owner' }
const signingKey = Buffer.from('synthetic-event-signing-key-only')
const checks = []
let serial = 0, passed = false

try {
  const f = await fixture()
  const pair = await transferChecks(f)
  await rejectedPackages(pair)
  await sourceRaces()
  await missingAndHistoricalSources()
  await legacyTransfer()
  passed = true
  console.log(JSON.stringify({ ok: true, checks, ordinarySecretRootAccesses: 0, modelCalls: 0, networkCalls: 0 }))
} finally {
  if (passed) await rm(temp, { recursive: true, force: true })
  else console.error(`失败测试的合成文件保留在 ${temp}`)
}

async function fixture({ ruleStatus = 'active', pending = true } = {}) {
  const root = join(temp, `source-${++serial}`), statePath = join(root, 'state.json'), secretRoot = join(temp, `secrets-${serial}`)
  const store = createFileStore(statePath)
  const connection = { id: 'kivo', name: '合成实例', kind: 'kivo-mcp', targetIdentity: 'test-a', baseUrl: 'http://127.0.0.1:41001/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41001', clientId: randomUUID(), credentialRef: 'synthetic.pem', allowedObjectIds: [], enabled: true, status: 'ready', revision: 1, skillIds: [cap.skillId], sourceSystem: 'Kivo', sourceInstance: 'synthetic-a', sourceEnvironment: 'pure-test', dataMode: 'synthetic', evidenceMode: 'controlled-function' }
  const connectionCatalog = [Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, connection[key]]))]
  await store.update(state => ({ ...state,
    members: [{ id: actor.id, loginName: actor.id, displayName: '合成成员', authRef: actor.id, enabled: true, role: 'member', sessionVersion: 1, employeeIds: ['agent'] }],
    employees: [{ id: 'agent', name: '合成员工', enabled: true, revision: 1, instructions: '', skillIds: [cap.skillId], connectionIds: ['kivo'], modelRouteId: 'model' }],
    skills: [{ id: cap.skillId, name: '单据查询', enabled: true, capabilityId: cap.id }],
    modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }], connections: [connection],
  }))
  const config = { version: 1, sources: [{ id: 'source-a', connectionId: connection.id, resource: connection.baseUrl, sourceInstance: connection.sourceInstance, signingSecretRef: 'event.key', subscriptionIds: [randomUUID()], enabled: true }] }
  const sourcePath = join(root, KIVO_EVENT_SOURCES_FILE)
  await put(root, KIVO_EVENT_SOURCES_FILE, bytes(config))
  await mkdir(secretRoot, { mode: 0o700 })
  for (const [ref, value] of Object.entries({ 'synthetic.pem': 'SYNTHETIC_MACHINE_KEY', ZENMUX_API_KEY: 'SYNTHETIC_MODEL_KEY', 'event.key': `whsec_${signingKey.toString('base64')}` })) await put(secretRoot, ref, Buffer.from(value))
  const service = createAutomationService({ store, clock: () => now, connectionCatalog, readEventSources: () => readKivoEventSources(root),
    workService: { async ensureReady() {}, async dispatchAutomationWork() { assert.fail('backup must not dispatch work') } },
    async readCurrentRecord(options) {
      await options.authorize()
      const source = { system: 'kivo', path: '/api/v1/mes/tpm/repairs/R-1', queriedAt: now, traceId: 'synthetic-read' }
      return normalizeTpmObservation({ mode: 'record', input: options.input, connection: options.connection,
        result: { status: 'ok', source, value: { id: objectId, orderNo: 'R-1', deviceId, status: 'reported', revision: 0, updatedAt: now } },
        deviceResult: { status: 'ok', source: { ...source, path: '/api/v1/mes/equipment/ledger/devices/' + deviceId }, value: { id: deviceId, code: 'D-1', name: '合成设备', lifecycleStatus: 'active', revision: 0 } } })
    },
  })
  let rule = await service.createRule(actor, { employeeId: 'agent', skillId: cap.skillId, connectionId: connection.id, input: { recordType: 'repair', reference: 'R-1' }, trigger: { kind: 'kivo-record-update', sourceId: 'source-a' } })
  if (ruleStatus !== 'draft') rule = await service.enableRule(actor, rule.id, { expectedRevision: rule.revision })
  const signed = signedEvent(config.sources[0])
  if (pending) {
    const snapshot = await readKivoEventSources(root)
    const verified = verifyKivoEvent({ ...signed, source: snapshot.sources.find(source => source.id === config.sources[0].id), signingKey, now: Date.parse(now) })
    await service.acceptKivoEvent({ ...verified, sourceConfigSha256: snapshot.sha256 })
  }
  if (ruleStatus === 'paused') rule = await service.pauseRule(actor, rule.id, { expectedRevision: rule.revision })
  if (ruleStatus === 'revoked') rule = await service.revokeRule(actor, rule.id, { expectedRevision: rule.revision })
  return { root, statePath, sourcePath, secretRoot, store, service, config, signed, rule, env: { GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: join(root, 'dsh') } }
}

async function transferChecks(f) {
  const ordinary = join(temp, 'ordinary'), accesses = join(temp, 'ordinary-accesses.json'), guard = join(temp, 'ordinary-guard.mjs')
  await writeFile(guard, `
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module'; import { resolve, sep } from 'node:path';
const root = ${JSON.stringify(f.secretRoot)}, log = ${JSON.stringify(accesses)}, write = fs.writeFileSync; let count = 0;
const guarded = value => { const path = typeof value === 'string' ? resolve(value) : value instanceof URL ? resolve(value.pathname) : ''; if (path === root || path.startsWith(root + sep)) { count++; throw new Error('ordinary backup touched synthetic secret root'); } };
for (const name of ['access','lstat','open','opendir','readFile','readdir','readlink','realpath','stat']) { const original = fsp[name]; fsp[name] = async (...args) => { guarded(args[0]); return original(...args); }; }
for (const name of ['accessSync','existsSync','lstatSync','openSync','opendirSync','readFileSync','readdirSync','readlinkSync','realpathSync','statSync']) { const original = fs[name]; fs[name] = (...args) => { guarded(args[0]); return original(...args); }; }
syncBuiltinESMExports(); process.on('exit', () => write(log, JSON.stringify({ count })));
`)
  await run(['backup', '--output', ordinary, '--event-sources', join(temp, 'unused-override.json')], { ...f.env, GENEWAY_SECRET_ROOT: f.secretRoot, GENEWAY_KIVO_EVENT_SOURCES: join(temp, 'unused-env-override.json') }, guard)
  assert.deepEqual(await json(accesses), { count: 0 })
  const ordinaryManifest = await json(join(ordinary, 'manifest.json'))
  assert.deepEqual(ordinaryManifest.entries.map(entry => entry.path), [KIVO_EVENT_SOURCES_FILE, 'state.json'])
  assert.deepEqual(await readFile(join(ordinary, KIVO_EVENT_SOURCES_FILE)), await readFile(f.sourcePath))
  for (const entry of ordinaryManifest.entries) {
    const raw = await readFile(join(ordinary, entry.path))
    assert.equal(raw.includes('SYNTHETIC_MACHINE_KEY'), false)
    assert.equal(raw.includes('SYNTHETIC_MODEL_KEY'), false)
    assert.equal(raw.includes(signingKey.toString('base64')), false)
  }
  const restored = join(temp, 'ordinary-restored')
  await run(['restore', '--input', ordinary, '--data-root', restored])
  const state = await json(join(restored, 'state.json')), original = await f.store.read()
  assert.equal(state.version, STATE_VERSION)
  assert.equal(state.automationRules[0].status, 'paused')
  assert.equal(state.automationRules[0].revision, original.automationRules[0].revision + 1)
  for (const key of ['activationId', 'objectId', 'baselineRevision', 'handledRevision']) assert.equal(state.automationRules[0][key], original.automationRules[0][key])
  assert.deepEqual(state.automationInbox[0].event, original.automationInbox[0].event)
  assert.deepEqual(state.automationInbox[0].targets, original.automationInbox[0].targets.map(target => ({ ...target, status: 'restore-suppressed', reason: 'restore-suppressed', occurrenceId: null })))
  const runtimeConfig = readRuntimeConfig({ GENEWAY_STATE: join(restored, 'state.json') }, repo)
  const sources = await readKivoEventSources(runtimeConfig.dataRoot)
  assert.equal(sources.sources[0].enabled, false)
  assert.deepEqual(sources.sources[0], { ...f.config.sources[0], enabled: false })
  assert.throws(() => verifyKivoEvent({ ...f.signed, source: sources.sources[0], signingKey, now: Date.parse(now) }), { code: 'SOURCE_NOT_CONFIGURED' })
  const restoredStore = createFileStore(runtimeConfig.stateFile)
  const restoredService = createAutomationService({ store: restoredStore, readEventSources: () => readKivoEventSources(runtimeConfig.dataRoot), readCurrentRecord() { assert.fail('restored pending target must not read MCP') } })
  await restoredService.processPending({ reconcile: true })
  assert.deepEqual(await restoredStore.read(), state)
  assert.equal((await lstat(join(restored, KIVO_EVENT_SOURCES_FILE))).mode & 0o777, 0o600)
  checks.push('fixed-data-root', 'ordinary-zero-secret-access', 'restore-disabled', 'pending-suppressed', 'old-signature-no-wakeup')

  const backup = join(temp, 'paired-backup'), secrets = join(temp, 'paired-secrets')
  await run(['backup', '--output', backup, '--secret-output', secrets, '--secret-root', f.secretRoot], f.env)
  const manifest = await json(join(secrets, 'manifest.json'))
  assert.equal(manifest.version, 2)
  assert.equal(manifest.stateSha256, digest(await readFile(join(backup, 'state.json'))))
  assert.equal(manifest.sourcesSha256, digest(await readFile(join(backup, KIVO_EVENT_SOURCES_FILE))))
  assert.deepEqual(manifest.entries.map(entry => entry.path), ['secrets/ZENMUX_API_KEY', 'secrets/event.key', 'secrets/synthetic.pem'])
  const target = join(temp, 'paired-restored'), secretTarget = join(temp, 'paired-restored-secrets')
  await run(['restore', '--input', backup, '--data-root', target, '--secret-input', secrets, '--secret-root', secretTarget])
  assert.equal((await readKivoEventSources(target)).sources[0].enabled, false)
  for (const entry of manifest.entries) assert.deepEqual(await readFile(join(secretTarget, entry.path.slice('secrets/'.length))), await readFile(join(secrets, entry.path)))
  checks.push('secret-v2-dual-binding', 'signing-ref-in-separate-pack')
  return { backup, secrets, ordinary }
}

async function rejectedPackages(pair) {
  const cases = [
    ['state-hash', async (_, secret) => editJson(join(secret, 'manifest.json'), value => { value.stateSha256 = '0'.repeat(64) }), /普通备份不匹配/],
    ['sources-hash', async (_, secret) => editJson(join(secret, 'manifest.json'), value => { value.sourcesSha256 = '0'.repeat(64) }), /普通备份不匹配/],
    ['v1-downgrade', async (_, secret) => editJson(join(secret, 'manifest.json'), value => { value.version = 1; delete value.sourcesSha256 }), /普通备份不匹配/],
    ['missing-signing-ref', async (_, secret) => editJson(join(secret, 'manifest.json'), value => { value.entries = value.entries.filter(entry => entry.path !== 'secrets/event.key') }), /引用集合/],
    ['duplicate-ref', async (_, secret) => editJson(join(secret, 'manifest.json'), value => { value.entries.push(value.entries[0]) }), /引用集合/],
    ['extra-ref', async (_, secret) => editJson(join(secret, 'manifest.json'), value => { value.entries.push({ path: 'secrets/extra.key', bytes: 0, sha256: digest('') }) }), /引用集合/],
    ['secret-path', async (_, secret) => editJson(join(secret, 'manifest.json'), value => { value.entries[0].path = 'secrets/../outside' }), /路径越界/],
    ['secret-bytes', async (_, secret) => writeFile(join(secret, 'secrets', 'event.key'), 'tampered'), /文件校验/],
    ['source-bytes', async backup => writeFile(join(backup, KIVO_EVENT_SOURCES_FILE), bytes({ version: 1, sources: [] })), /备份校验失败/],
    ['source-unlisted', async backup => editJson(join(backup, 'manifest.json'), value => { value.entries = value.entries.filter(entry => entry.path !== KIVO_EVENT_SOURCES_FILE) }), /来源未列入 manifest/],
    ['source-missing', async backup => { await rm(join(backup, KIVO_EVENT_SOURCES_FILE)); await editJson(join(backup, 'manifest.json'), value => { value.entries = value.entries.filter(entry => entry.path !== KIVO_EVENT_SOURCES_FILE) }) }, /缺少事件来源/],
    ['source-symlink', async backup => { await rm(join(backup, KIVO_EVENT_SOURCES_FILE)); await symlink(join(pair.backup, KIVO_EVENT_SOURCES_FILE), join(backup, KIVO_EVENT_SOURCES_FILE)) }, /符号链接/],
  ]
  for (const [name, mutate, pattern] of cases) {
    const root = join(temp, `bad-${name}`), backup = join(root, 'backup'), secret = join(root, 'secrets'), target = join(root, 'target'), secretTarget = join(root, 'secret-target')
    await mkdir(root)
    await cp(pair.backup, backup, { recursive: true }); await cp(pair.secrets, secret, { recursive: true })
    await mutate(backup, secret)
    await mkdir(target, { mode: 0o750 }); await mkdir(secretTarget, { mode: 0o700 })
    await rejected(['restore', '--input', backup, '--data-root', target, '--secret-input', secret, '--secret-root', secretTarget], {}, pattern)
    assert.deepEqual(await readdir(target), [])
    assert.deepEqual(await readdir(secretTarget), [])
    assert.equal((await lstat(target)).mode & 0o777, 0o750)
  }
  checks.push('hash-ref-version-path-mismatches-before-write')
}

async function sourceRaces() {
  for (const mode of ['before-secret', 'during-secret', 'ordinary-stage', 'secret-stage', 'source-created', 'source-deleted']) {
    const f = await fixture({ pending: false })
    if (mode === 'source-created') {
      await f.service.revokeRule(actor, f.rule.id, { expectedRevision: f.rule.revision })
      await rm(f.sourcePath)
    }
    const output = join(temp, `race-${mode}`), secrets = join(temp, `race-${mode}-secrets`), log = join(temp, `race-${mode}.json`), hook = join(temp, `race-${mode}.mjs`)
    await writeFile(hook, `
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
const source = ${JSON.stringify(f.sourcePath)}, secretFile = ${JSON.stringify(join(f.secretRoot, 'event.key'))}, mode = ${JSON.stringify(mode)}, log = ${JSON.stringify(log)};
const open = fsp.open, write = fsp.writeFile, rename = fsp.rename, remove = fsp.rm; let changed = false, sourceReads = 0, secretReads = 0;
async function mutate() { if (changed) return; changed = true; if (mode === 'source-deleted') return remove(source); const next = source + '.changed'; await write(next, ${JSON.stringify(JSON.stringify({ ...f.config, sources: f.config.sources.map(source => ({ ...source, enabled: false })) }))}); await rename(next, source); }
fsp.open = async (...args) => { if (args[0] === source && ++sourceReads === 2 && mode === 'before-secret') await mutate(); if (args[0] === secretFile) { secretReads++; if (mode === 'during-secret') await mutate(); } return open(...args); };
fsp.writeFile = async (...args) => { const result = await write(...args); const path = String(args[0]); if (path.endsWith('/manifest.json') && (mode === 'secret-stage' ? path.includes('.race-secret-stage-secrets.transfer-') : ['ordinary-stage','source-created','source-deleted'].includes(mode) && path.includes(${JSON.stringify(`.race-${mode}.transfer-`)}))) await mutate(); return result; };
syncBuiltinESMExports(); process.on('exit', () => fs.writeFileSync(log, JSON.stringify({ changed, secretReads })));
`)
    const withSecrets = ['before-secret', 'during-secret', 'secret-stage'].includes(mode)
    await rejected(['backup', '--output', output, ...(withSecrets ? ['--secret-output', secrets, '--secret-root', f.secretRoot] : [])], f.env,
      mode === 'secret-stage' ? /普通备份已写入，秘密包未完成/ : /事件来源配置在备份期间变化/, hook)
    const observed = await json(log)
    assert.equal(observed.changed, true)
    if (mode === 'before-secret') assert.equal(observed.secretReads, 0)
    assert.equal(await exists(output), mode === 'secret-stage')
    assert.equal(await exists(secrets), false)
    assert.equal((await readdir(temp)).some(name => name.startsWith(`.race-${mode}.transfer-`) || name.startsWith(`.race-${mode}-secrets.transfer-`)), false)
  }
  checks.push('source-races-before-after-secrets', 'source-races-before-each-publication', 'source-presence-races')
}

async function missingAndHistoricalSources() {
  for (const status of ['draft', 'active', 'paused']) {
    const f = await fixture({ ruleStatus: status, pending: false })
    await rm(f.sourcePath)
    const output = join(temp, `missing-${status}`)
    await rejected(['backup', '--output', output], f.env, /缺少事件来源/)
    assert.equal(await exists(output), false)
  }
  const pending = await fixture()
  // A valid but inconsistent recovery input must still require its pending target's source.
  const state = await pending.store.read()
  state.automationRules[0] = { ...state.automationRules[0], status: 'revoked', revokedAt: now }
  await writeFile(pending.statePath, bytes(state)); await rm(pending.sourcePath)
  await rejected(['backup', '--output', join(temp, 'missing-pending')], pending.env, /缺少事件来源/)

  const history = await fixture({ ruleStatus: 'revoked' })
  const sourceState = await history.store.read()
  assert.equal(sourceState.automationInbox[0].targets[0].status, 'ignored')
  await rm(history.sourcePath)
  const backup = join(temp, 'history-backup'), secrets = join(temp, 'history-secrets')
  await run(['backup', '--output', backup, '--secret-output', secrets, '--secret-root', history.secretRoot], history.env)
  const manifest = await json(join(secrets, 'manifest.json'))
  assert.equal(manifest.version, 1)
  assert.equal(Object.hasOwn(manifest, 'sourcesSha256'), false)
  assert.equal(manifest.entries.some(entry => entry.path === 'secrets/event.key'), false)
  const restored = join(temp, 'history-restored')
  await run(['restore', '--input', backup, '--data-root', restored, '--secret-input', secrets, '--secret-root', join(temp, 'history-restored-secrets')])
  assert.deepEqual(await json(join(restored, 'state.json')), sourceState)
  assert.equal(await exists(join(restored, KIVO_EVENT_SOURCES_FILE)), false)
  checks.push('recoverable-source-required', 'terminal-history-no-retired-source', 'legacy-secret-v1-no-sources')
}

async function legacyTransfer() {
  const root = join(temp, 'legacy-source'), statePath = join(root, 'state.json')
  const state = await createFileStore(statePath).read()
  await put(root, 'state.json', bytes(state))
  const backup = join(temp, 'legacy-backup'), restored = join(temp, 'legacy-restored')
  await run(['backup', '--output', backup], { GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: join(root, 'dsh') })
  const legacy = { ...state, version: 10 }; delete legacy.automationInbox
  const raw = bytes(legacy)
  await writeFile(join(backup, 'state.json'), raw)
  await editJson(join(backup, 'manifest.json'), manifest => {
    manifest.schema.stateVersion = 10
    Object.assign(manifest.entries.find(entry => entry.path === 'state.json'), { bytes: raw.length, sha256: digest(raw) })
  })
  await run(['restore', '--input', backup, '--data-root', restored])
  const result = await json(join(restored, 'state.json'))
  assert.equal(result.version, STATE_VERSION)
  assert.deepEqual(result.automationInbox, [])
  assert.equal(await exists(join(restored, KIVO_EVENT_SOURCES_FILE)), false)
  checks.push('state-v10-to-current-no-sources')
  const v11 = { ...state, version: 11 }, v11Raw = bytes(v11), v11Restored = join(temp, 'v11-restored')
  await writeFile(join(backup, 'state.json'), v11Raw)
  await editJson(join(backup, 'manifest.json'), manifest => {
    manifest.schema.stateVersion = 11
    Object.assign(manifest.entries.find(entry => entry.path === 'state.json'), { bytes: v11Raw.length, sha256: digest(v11Raw) })
  })
  await run(['restore', '--input', backup, '--data-root', v11Restored])
  assert.deepEqual(await json(join(v11Restored, 'state.json')), { ...v11, version: STATE_VERSION })
  checks.push('state-v11-to-v12-explicit-migration')

  const emptyRoot = join(temp, 'empty-source-secrets'), withSources = join(temp, 'empty-source-backup'), secrets = join(temp, 'empty-source-pack')
  await mkdir(emptyRoot, { mode: 0o700 })
  await put(root, KIVO_EVENT_SOURCES_FILE, bytes({ version: 1, sources: [] }))
  await run(['backup', '--output', withSources, '--secret-output', secrets, '--secret-root', emptyRoot], { GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: join(root, 'dsh') })
  const secretManifest = await json(join(secrets, 'manifest.json'))
  assert.equal(secretManifest.version, 2)
  assert.equal(secretManifest.sourcesSha256, digest(await readFile(join(withSources, KIVO_EVENT_SOURCES_FILE))))
  assert.deepEqual(secretManifest.entries, [])
  const emptyRestored = join(temp, 'empty-source-restored')
  await run(['restore', '--input', withSources, '--data-root', emptyRestored, '--secret-input', secrets, '--secret-root', join(temp, 'empty-source-restored-secrets')])
  assert.deepEqual((await readKivoEventSources(emptyRestored)).sources, [])
  assert.equal(await exists(join(emptyRestored, KIVO_EVENT_SOURCES_FILE)), true)
  checks.push('empty-source-file-still-bound')
}

function signedEvent(source) {
  const deliveryId = randomUUID(), subject = { id: objectId, type: 'repair', label: 'SYNTHETIC-REPAIR', deviceId, deviceName: '合成设备', organizationId: randomUUID(), organizationAncestorIds: [] }
  const rawBody = bytes({ version: 2, deliveryId, type: 'notification.business_event', timestamp: now, data: {
    source: { authority: 'mes.native.repair', adapter: 'mes.native', revision: '1' }, object: structuredClone(subject), message: { templateVersion: 1, title: '合成标题', body: '合成正文' },
    rule: { id: source.subscriptionIds[0], revision: 1, name: '合成订阅' }, businessEvent: { version: 1, eventId: randomUUID(), sourceKind: 'native_audit', objectType: 'repair', objectId, sourceRevision: '1', occurredAt: now, timezone: 'Asia/Shanghai', actorId: null, traceId: 'synthetic-change', action: null, before: { status: 'reported' }, after: { status: 'dispatched' }, subject, businessLink: {}, displayBefore: {}, displayAfter: {} }, basis: {}, businessLink: {},
  } })
  const stamp = String(Date.parse(now) / 1000), signature = createHmac('sha256', signingKey).update(`${deliveryId}.${stamp}.`).update(rawBody).digest('base64')
  return { rawBody, rawHeaders: ['webhook-id', deliveryId, 'webhook-timestamp', stamp, 'webhook-signature', `v1,${signature}`] }
}

async function run(args, env = {}, hook) {
  return execFile(process.execPath, [...(hook ? ['--import', hook] : []), transfer, ...args], { cwd: repo, env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 })
}
async function rejected(args, env, pattern, hook) {
  await assert.rejects(run(args, env, hook), error => {
    assert.equal(error.code, 1)
    assert.match(`${error.stderr}\n${error.stdout}`, pattern)
    return true
  })
}
async function put(root, path, raw) { const target = join(root, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, raw, { mode: 0o600 }); await chmod(target, 0o600) }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function editJson(path, mutate) { const value = await json(path); mutate(value); await writeFile(path, bytes(value)) }
function bytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n') }
async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
