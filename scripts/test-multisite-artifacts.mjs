import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { createArtifactService, ATTACHMENT_LIMITS } from '../src/artifact-service.mjs'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'

const root = await fs.mkdtemp(join(tmpdir(), 'geneway-attachments-'))
const owner = { id: 'owner' }, peer = { id: 'peer' }
const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#cb4335' } }).png().toBuffer()
const jpeg = await sharp(png).jpeg().toBuffer()
const history = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-05', description: '模拟现场异常', owner: '模拟责任人' }] }))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const declaration = (id, bytes = png, mediaType = 'image/png', name = '现场.png') => ({ clientRequestId: id, name, mediaType, sizeBytes: bytes.length, sha256: hash(bytes) })
const create = (id, refs = []) => ({ workType: 'multisite', employeeId: 'coordinator', targets: ['coordinator', 'worker'], goal: '按现场照片与历史整理异常', clientRequestId: id, attachmentRefs: refs })
const upload = (service, id, bytes = png) => service.upload(owner, id, Readable.from([bytes.subarray(0, 17), bytes.subarray(17)]))
let server, workService
try {
  const statePath = join(root, 'state.json'), filesRoot = join(root, 'files')
  const store = createFileStore(statePath); await store.update(seedMultisite)
  let raceArmed = false, missingRoots = 0, mkdirCollisions = 0, releaseRoot
  const rootBarrier = new Promise(resolve => { releaseRoot = resolve })
  const attachments = createArtifactService({ store, root: filesRoot, fsOps: {
    async lstat(path) {
      try { return await fs.lstat(path) } catch (cause) {
        // Hold each real ENOENT until both legitimate PUTs have observed the absent root.
        if (raceArmed && path === filesRoot && cause.code === 'ENOENT') {
          if (++missingRoots === 2) releaseRoot()
          await rootBarrier
        }
        throw cause
      }
    },
    async mkdir(path, options) {
      try { return await fs.mkdir(path, options) } catch (cause) {
        if (path === filesRoot && cause.code === 'EEXIST') mkdirCollisions++
        throw cause
      }
    },
  } })
  const dispatched = [], host = { nodeId: 'local', async accept(_, command) { dispatched.push(command); return command }, async process() {}, async flushEvents() {} }
  workService = createWorkService({ store, multisiteOptions: { attachments, hosts: [host] } })
  const authPath = join(root, 'auth.json')
  await initializeAuthFile(authPath, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  // Real HTTP session/CSRF entrypoint; images come from the actual sharp producer.
  server = createGenewayServer({ store, service: workService, attachments, auth: createAuthRuntime({ filePath: authPath }), trustedOrigin: 'http://localhost' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  async function request(path, { method = 'GET', session, body, bytes, expected = 200, csrf = true } = {}) {
    const response = await fetch(origin + path, { method, headers: { origin: 'http://localhost', ...(session ? { cookie: session.cookie, 'x-csrf-token': csrf ? session.csrfToken : '' } : {}), ...(bytes ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}) }, body: bytes ?? (body ? JSON.stringify(body) : undefined) })
    const payload = response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    assert.equal(response.status, expected, JSON.stringify(payload))
    return { payload, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  async function login(name) { const response = await request('/api/session', { method: 'POST', body: { loginName: name, password: `synthetic ${name} password` } }); return { ...response.payload, cookie: response.cookie } }
  const session = await login('owner'), peerSession = await login('peer')
  await request('/api/attachments/init', { method: 'POST', body: declaration('no-session'), expected: 401 })
  await request('/api/attachments/init', { method: 'POST', session, csrf: false, body: declaration('csrf'), expected: 403 })
  const init = (await request('/api/attachments/init', { method: 'POST', session, body: declaration('http-image') })).payload
  const duplicate = (await request('/api/attachments/init', { method: 'POST', session, body: declaration('http-image') })).payload
  assert.equal(duplicate.id, init.id, 'lost init response replays the same object')
  await request('/api/attachments/init', { method: 'POST', session, body: { ...declaration('http-image'), name: '其他.png' }, expected: 409 })
  await request(`/api/attachments/${init.id}/content`, { session, expected: 409 })
  await request('/api/works', { method: 'POST', session, body: create('pending', [init.ref]), expected: 409 })
  await request(`/api/attachments/${init.id}/content`, { method: 'PUT', session, csrf: false, bytes: png, expected: 403 })
  await request(`/api/attachments/${init.id}/content`, { method: 'PUT', session: peerSession, bytes: png, expected: 404 })
  const simultaneous = (await request('/api/attachments/init', { method: 'POST', session, body: declaration('first-root-peer') })).payload
  raceArmed = true
  const [firstUpload, secondUpload] = await Promise.all([
    request(`/api/attachments/${init.id}/content`, { method: 'PUT', session, bytes: png }),
    request(`/api/attachments/${simultaneous.id}/content`, { method: 'PUT', session, bytes: png }),
  ])
  raceArmed = false
  assert.equal(missingRoots, 2); assert.equal(mkdirCollisions, 1, 'exercise the first-root EEXIST schedule')
  const ready = firstUpload.payload
  assert.equal(ready.status, 'ready'); assert.equal(secondUpload.payload.status, 'ready')
  assert.equal(hash((await attachments.download(owner, simultaneous.id)).bytes), simultaneous.ref.sha256)
  const path = join(filesRoot, init.id), originalStat = await fs.stat(path)
  await request(`/api/attachments/${init.id}/content`, { method: 'PUT', session, bytes: png })
  assert.equal((await fs.stat(path)).ino, originalStat.ino, 'ready retry does not replace the object')
  const downloaded = (await request(`/api/attachments/${init.id}/content`, { session })).payload
  assert.equal(hash(downloaded), ready.ref.sha256)
  await request(`/api/attachments/${init.id}`, { session: peerSession, expected: 404 })
  await request(`/api/attachments/${init.id}/content`, { session: peerSession, expected: 404 })
  await request('/api/works', { method: 'POST', session, body: create('wrong-version', [{ ...ready.ref, version: 2 }]), expected: 409 })
  await request('/api/works', { method: 'POST', session: peerSession, body: { ...create('cross-owner', [ready.ref]), employeeId: 'worker', targets: ['worker'] }, expected: 404 })
  const work = (await request('/api/works', { method: 'POST', session, body: create('http-work', [ready.ref]) })).payload
  let state = await store.read()
  assert.deepEqual(state.multisite.inputs[0].attachmentRefs, [ready.ref])
  assert(state.multisite.outbox.every(row => JSON.stringify(row.command.parameters.attachmentRefs) === JSON.stringify([ready.ref])))
  assert.equal(state.attachments[0].workId, work.id)
  await hostCapabilityChecks(state.multisite.outbox[0].command)
  assert(!JSON.stringify(state).includes(filesRoot)); assert(!JSON.stringify(ready).includes(filesRoot))
  await request('/api/works', { method: 'POST', session, body: create('http-work', [ready.ref]) })
  await request('/api/works', { method: 'POST', session, body: create('different-work', [ready.ref]), expected: 403 })
  const json = await attachments.init(owner, declaration('history', history, 'application/json', 'history.json'))
  await upload(attachments, json.id, history)
  await request(`/api/works/${work.id}/multisite/inputs`, { method: 'POST', session, body: { text: '补充历史资料', clientRequestId: 'http-input', attachmentRefs: [json.ref] } })
  state = await store.read()
  assert.deepEqual(state.multisite.inputs[1].attachmentRefs, [json.ref])
  assert(state.multisite.outbox.slice(2).every(row => row.command.parameters.attachmentRefs[0].attachmentId === json.id))
  const reopened = createArtifactService({ store: createFileStore(statePath), root: filesRoot })
  assert.equal(hash((await reopened.download(owner, init.id)).bytes), ready.ref.sha256)
  const jpg = await attachments.init(owner, declaration('jpeg', jpeg, 'image/jpeg', '现场.jpeg')); await upload(attachments, jpg.id, jpeg)
  // Same declared file, independent service instances and concurrent writers: one immutable object.
  const concurrent = await attachments.init(owner, declaration('concurrent'))
  await Promise.all([upload(attachments, concurrent.id), upload(createArtifactService({ store, root: filesRoot }), concurrent.id)])
  assert.equal(hash(await fs.readFile(join(filesRoot, concurrent.id))), concurrent.ref.sha256)
  assert.equal((await store.read()).attachments.filter(row => row.id === concurrent.id).length, 1)
  const otherWorkspace = createArtifactService({ store, root: filesRoot, workspaceId: 'other' })
  await assert.rejects(otherWorkspace.get(owner, init.id), { code: 'NOT_FOUND' })
  const other = await otherWorkspace.init(owner, declaration('http-image')); assert.notEqual(other.id, init.id)
  const peerPrivate = await attachments.init(peer, declaration('http-image')); assert.notEqual(peerPrivate.id, init.id)
  // Negative content is deliberately produced by another format or corrupted after the producer.
  for (const [label, bytes, type, name] of [
    ['fake-type', jpeg, 'image/png', 'fake.png'], ['invalid-json', Buffer.from('{bad'), 'application/json', 'history.json'],
    ['wrong-history', Buffer.from('{"entries":[]}'), 'application/json', 'history.json'], ['truncated', png.subarray(0, 45), 'image/png', 'short.png'],
  ]) {
    const item = await attachments.init(owner, declaration(label, bytes, type, name))
    await assert.rejects(upload(attachments, item.id, bytes), { code: 'INVALID_REQUEST' })
    assert.equal((await attachments.get(owner, item.id)).status, 'pending')
  }
  const tooWide = await sharp({ create: { width: ATTACHMENT_LIMITS.maxDimension + 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer()
  const wide = await attachments.init(owner, declaration('wide', tooWide)); await assert.rejects(upload(attachments, wide.id, tooWide), { code: 'INVALID_REQUEST' })
  const badHash = await attachments.init(owner, { ...declaration('bad-hash'), sha256: '0'.repeat(64) })
  await assert.rejects(upload(attachments, badHash.id), { code: 'INVALID_REQUEST' })
  const tooMuch = await attachments.init(owner, declaration('too-much', png.subarray(0, 10)))
  await assert.rejects(upload(attachments, tooMuch.id), { code: 'ATTACHMENT_TOO_LARGE' })
  await assert.rejects(attachments.init(owner, { ...declaration('large'), sizeBytes: ATTACHMENT_LIMITS.maxBytes + 1 }), { code: 'INVALID_REQUEST' })
  await assert.rejects(attachments.init(owner, declaration('xlsx', Buffer.from('PK'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'test.xlsx')), { code: 'INVALID_REQUEST' })
  await assert.rejects(attachments.init(owner, { ...declaration('path'), name: '../escape.png' }), { code: 'INVALID_REQUEST' })
  await assert.rejects(attachments.init(owner, { ...declaration('body-path'), path: '/tmp/object' }), { code: 'INVALID_REQUEST' })
  await request('/api/works', { method: 'POST', session, body: { ...create('json-limit'), goal: 'x'.repeat(66 * 1024) }, expected: 400 })
  // Revocation is rechecked after binding for downloads and for subsequent inputs.
  await store.update(state => { state.members[0].employeeIds = ['coordinator']; return state })
  await request(`/api/attachments/${init.id}/content`, { session, expected: 403 })
  await request(`/api/works/${work.id}/multisite/inputs`, { method: 'POST', session, body: { text: '撤权后不能派发', clientRequestId: 'revoked', attachmentRefs: [ready.ref] }, expected: 403 })
  await store.update(state => { state.members[0].employeeIds = ['coordinator', 'worker']; return state })
  // Disk mutation cannot be referenced, downloaded, or dispatched as valid input.
  await fs.writeFile(path, Buffer.alloc(png.length))
  const count = (await store.read()).multisite.inputs.length
  await request(`/api/attachments/${init.id}/content`, { session, expected: 409 })
  await request(`/api/works/${work.id}/multisite/inputs`, { method: 'POST', session, body: { text: '坏字节不能入队', clientRequestId: 'bad-disk', attachmentRefs: [ready.ref] }, expected: 409 })
  assert.equal((await store.read()).multisite.inputs.length, count)
  await assert.rejects(workService.multisite.drain(), { code: 'INVALID_STATE' })
  assert(dispatched.every(command => !command.parameters.attachmentRefs.some(ref => ref.attachmentId === init.id)), 'corrupt bytes never reach Host.accept')
  await migrationChecks(statePath)
  const timeoutItem = await attachments.init(owner, declaration('timeout'))
  const shortTimeout = createArtifactService({ store, root: filesRoot, uploadTimeoutMs: 10 })
  const stalled = new Readable({ read() {} })
  const keepAlive = setInterval(() => {}, 100)
  try { await assert.rejects(shortTimeout.upload(owner, timeoutItem.id, stalled), { code: 'UPLOAD_TIMEOUT' }) } finally { clearInterval(keepAlive); stalled.destroy() }
  assert.equal((await attachments.get(owner, timeoutItem.id)).status, 'pending')
  await failureChecks()
  await referenceCommitChecks()
  await symlinkChecks()
  console.log('Attachment checks passed: real session+CSRF HTTP → sharp PNG/JPEG or parsed incident-history JSON → durable bytes → Work/Input/outbox stable references → reopen/hash/download; conflict, integrity, authorization, version, concurrency, symlink, v13 migration and file/metadata commit faults covered. XLSX intentionally unsupported; no image inference or Artifact.ready claim.')
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await workService?.close()
  await fs.rm(root, { recursive: true, force: true })
}
async function hostCapabilityChecks(command) {
  const journal = createHostJournal(join(root, 'capability-host.json'))
  const runtime = createSimulatedRuntime({ path: join(root, 'capability-sessions.json') }), delivered = []
  const deliver = runtime.deliver.bind(runtime)
  runtime.deliver = async (execution, input) => { delivered.push(input); return deliver(execution, input) }
  const host = createAgentHost({ nodeId: 'local', journal, runtime })
  await host.accept({ workspaceId: 'local', nodeId: 'local' }, command)
  await host.process(); await host.process()
  assert.equal(runtime.starts(), 0); assert.equal(runtime.messageCount(), 0)
  assert.deepEqual((await journal.read()).executions, [])
  assert.equal((await journal.read()).inbox[0].lastError, 'ATTACHMENT_RUNTIME_UNAVAILABLE')
  runtime.supportsAttachments = true
  await host.process()
  assert.deepEqual(delivered[0].attachmentRefs, command.parameters.attachmentRefs)
  assert.equal((await journal.read()).inbox[0].status, 'ingested')
  assert.equal((await journal.read()).inbox[0].lastError, undefined)
  await host.close()
}
async function migrationChecks(path) {
  // The v13 producer has no attachments. Use an actual text-only producer for its old schema.
  const store = createFileStore(join(root, 'legacy.json')); await store.update(seedMultisite)
  const service = createWorkService({ store }); await service.createMultisite(owner, { workType: 'multisite', employeeId: 'coordinator', goal: '原文本链', clientRequestId: 'legacy' })
  const text = await store.read(); text.version = 13; delete text.attachments
  for (const input of text.multisite.inputs) delete input.attachmentRefs
  // Original v13 commands did not contain attachmentRefs; reseal this external compatibility fixture.
  const { seal } = await import('../packages/agent-contracts/index.mjs')
  for (const row of text.multisite.outbox) { const { payload_digest, ...command } = row.command; delete command.parameters.attachmentRefs; row.command = seal(command) }
  const migrated = migrateState(text)
  assert.equal(migrated.version, STATE_VERSION); assert.deepEqual(migrated.attachments, [])
  assert.deepEqual(migrated.multisite, text.multisite)
  assert.throws(() => migrateState({ ...migrated, attachments: undefined }), /附件状态/)
  const altered = await createFileStore(path).read(); altered.attachments[0].sha256 = '0'.repeat(64)
  await assert.rejects(createFileStore(path).update(() => altered))
  await service.close()
}
async function failureChecks() {
  for (const stage of ['write', 'fileSync', 'publish', 'dirSync', 'metadataWrite', 'metadataSync', 'metadataRename', 'metadataDirSync']) {
    const base = join(root, stage), statePath = join(base, 'state.json'), filesRoot = join(base, 'files')
    let enabled = false, triggered = false
    const trip = label => { if (enabled && !triggered && label === stage) { triggered = true; throw new Error(`synthetic ${stage}`) } }
    const cloud = {
      async rename(...args) { trip('metadataRename'); return fs.rename(...args) },
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode), temp = String(path).endsWith('.tmp')
        return { ...wrapHandle(handle), async writeFile(...args) { if (temp) trip('metadataWrite'); return handle.writeFile(...args) }, async sync() { trip(temp ? 'metadataSync' : path === base ? 'metadataDirSync' : 'unused'); return handle.sync() } }
      },
    }
    const store = createFileStore(statePath, cloud); await store.update(seedMultisite)
    await fs.mkdir(filesRoot)
    const files = {
      async link(...args) { trip('publish'); return fs.link(...args) },
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode), temp = String(path).endsWith('.tmp')
        return { ...wrapHandle(handle), async writeFile(...args) { if (temp) trip('write'); return handle.writeFile(...args) }, async sync() { trip(temp ? 'fileSync' : path === filesRoot ? 'dirSync' : 'unused'); return handle.sync() } }
      },
    }
    const attachments = createArtifactService({ store, root: filesRoot, fsOps: files })
    const item = await attachments.init(owner, declaration(`fault-${stage}`)); enabled = true
    await assert.rejects(upload(attachments, item.id), new RegExp(`synthetic ${stage}`)); assert(triggered)
    enabled = false
    if (stage === 'metadataDirSync') {
      await assert.rejects(store.read(), { code: 'STORE_UNAVAILABLE' })
      // Exposed metadata cannot be used until the new instance confirms file and directory durability.
    } else assert.equal((await store.read()).attachments[0].status, 'pending')
    const reopenedStore = createFileStore(statePath), reopened = createArtifactService({ store: reopenedStore, root: filesRoot })
    const retry = await upload(reopened, item.id)
    assert.equal(retry.status, 'ready'); assert.equal(hash((await reopened.download(owner, item.id)).bytes), item.ref.sha256)
    assert.deepEqual((await reopenedStore.read()).multisite.outbox, [])
  }
}
async function referenceCommitChecks() {
  for (const stage of ['write', 'sync', 'rename', 'dirSync', 'referenceSync']) {
    const base = join(root, `reference-${stage}`), statePath = join(base, 'state.json'), filesRoot = join(base, 'files')
    let enabled = false, triggered = false, kicks = 0
    const trip = label => { if (enabled && !triggered && stage === label) { triggered = true; throw new Error(`reference ${stage}`) } }
    const io = {
      async rename(...args) { trip('rename'); return fs.rename(...args) },
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode), temp = String(path).endsWith('.tmp')
        return { ...wrapHandle(handle), async writeFile(...args) { if (temp) trip('write'); return handle.writeFile(...args) }, async sync() { trip(temp ? 'sync' : path === base ? 'dirSync' : 'unused'); return handle.sync() } }
      },
    }
    const store = createFileStore(statePath, io); await store.update(seedMultisite)
    const attachments = createArtifactService({ store, root: filesRoot, fsOps: { async open(path, flags, mode) { const handle = await fs.open(path, flags, mode); return { ...wrapHandle(handle), async sync() { trip('referenceSync'); return handle.sync() } } } } })
    const item = await attachments.init(owner, declaration(`reference-${stage}`)); await upload(attachments, item.id)
    const service = createWorkService({ store, multisiteOptions: { attachments, kick() { kicks++ } } })
    await service.ensureReady(); enabled = true
    await assert.rejects(service.createMultisite(owner, create(`bind-${stage}`, [item.ref])), new RegExp(`reference ${stage}`))
    assert(triggered); assert.equal(kicks, 0, 'failed Work commit never sends the dispatch hint')
    enabled = false
    const reopenedStore = createFileStore(statePath), after = await reopenedStore.read()
    if (stage !== 'dirSync') {
      assert.deepEqual(after.multisite.inputs, []); assert.deepEqual(after.multisite.outbox, []); assert.equal(after.attachments[0].workId, null)
    } else await assert.rejects(store.read(), { code: 'STORE_UNAVAILABLE' })
    const reopenedAttachments = createArtifactService({ store: reopenedStore, root: filesRoot })
    const retryService = createWorkService({ store: reopenedStore, multisiteOptions: { attachments: reopenedAttachments } })
    const retried = await retryService.createMultisite(owner, create(`bind-${stage}`, [item.ref]))
    assert.equal((await reopenedStore.read()).attachments[0].workId, retried.value.id)
    assert.equal((await reopenedStore.read()).multisite.inputs.length, 1)
    await assert.rejects(reopenedStore.update(state => { state.attachments[0].readyAt = '2099-01-01T00:00:00.000Z'; return state }), /就绪不可改写/)
    await assert.rejects(reopenedStore.update(state => { state.multisite.inputs[0].attachmentRefs = []; return state }))
    await retryService.close(); await store.confirmDurability(); await service.close()
  }
}
function wrapHandle(handle) { return Object.fromEntries(['close', 'sync', 'stat', 'readFile', 'writeFile'].map(name => [name, handle[name].bind(handle)])) }
async function symlinkChecks() {
  const base = join(root, 'symlinks'), outside = join(root, 'outside')
  await fs.mkdir(base); await fs.mkdir(outside)
  const store = createFileStore(join(base, 'state.json')); await store.update(seedMultisite)
  const linkedRoot = join(base, 'linked'); await fs.symlink(outside, linkedRoot)
  const unsafe = createArtifactService({ store, root: linkedRoot }), item = await unsafe.init(owner, declaration('symlink-root'))
  await assert.rejects(upload(unsafe, item.id), { code: 'STORE_UNAVAILABLE' })
  const racedRoot = join(base, 'raced')
  const raced = createArtifactService({ store, root: racedRoot, fsOps: { async mkdir(path, options) {
    if (path === racedRoot) await fs.symlink(outside, path)
    return fs.mkdir(path, options)
  } } })
  await assert.rejects(upload(raced, item.id), { code: 'STORE_UNAVAILABLE' }, 'mkdir EEXIST must recheck a concurrently inserted symlink')
  assert.deepEqual(await fs.readdir(outside), [])
  const safeRoot = join(base, 'safe'), safe = createArtifactService({ store, root: safeRoot })
  await fs.mkdir(safeRoot); await fs.writeFile(join(outside, 'object'), png); await fs.symlink(join(outside, 'object'), join(safeRoot, item.id))
  await assert.rejects(upload(safe, item.id), { code: 'STORE_UNAVAILABLE' })
  assert.equal((await store.read()).attachments[0].status, 'pending')
}
