import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createChannelSecretStore } from '../src/channel-secret-store.mjs'
import { resolveCredentialFile } from '../src/execution-grant.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-channel-secret-test-'))
const secretRoot = join(root, 'secrets'), store = createChannelSecretStore(secretRoot)
const refs = ['context', 'cursor', 'token']
let failedWrites = 0

try {
  await initialDirectoryBarrier()
  await valuesAndPermissions()
  await rejectedPaths()
  await atomicWrites()
  await concurrentUpdates()
  assert.deepEqual((await readdir(secretRoot)).sort(), refs)
  console.log(JSON.stringify({ ok: true, source: 'temporary synthetic secrets', fixedRefs: refs.length, failedWritesPreserved: failedWrites, directoryMode: '0700', fileMode: '0600', initialDirectoryBarrier: true, atomicPublish: true, concurrentUpdates: true, postRenameFailure: 'durability unknown', nativeStarted: false }))
} finally { await rm(root, { recursive: true, force: true }) }

async function initialDirectoryBarrier() {
  const directory = join(root, 'first-write'), gates = [deferred(), deferred()], entered = [deferred(), deferred()]
  const finished = [false, false], synced = [false, false], events = []
  const options = index => ({
    async open(path, ...args) {
      if (path !== root && path !== directory && !synced[index]) events.push(`premature-file-${index}`)
      return instrument(await open(path, ...args), async (method, call) => {
        if (path === root && method === 'sync') {
          entered[index].resolve()
          await gates[index].promise
          const result = await call()
          synced[index] = true; events.push(`parent-${index}`)
          return result
        }
        return call()
      })
    },
  })
  const stores = [createChannelSecretStore(directory, options(0)), createChannelSecretStore(directory, options(1))]
  const writes = stores.map((current, index) => current.write(index ? 'context' : 'cursor', `synthetic-${index}`).then(() => { finished[index] = true; events.push(`finished-${index}`) }))
  try {
    await Promise.race([Promise.all(entered.map(value => value.promise)), ...writes])
    assert.deepEqual(events.filter(value => value.startsWith('premature-file-')), [], 'secret file opened before parent barrier')
    assert.deepEqual(finished, [false, false])
    assert.deepEqual(await readdir(directory), [])
    gates[0].resolve(); await writes[0]
    assert.deepEqual(finished, [true, false], 'different-ref first writer bypassed its parent barrier')
    gates[1].resolve(); await writes[1]
    for (let index = 0; index < 2; index += 1) assert(events.indexOf(`parent-${index}`) < events.indexOf(`finished-${index}`))
  } finally { for (const gate of gates) gate.resolve(); await Promise.allSettled(writes) }

  const failedRoot = join(root, 'parent-sync-failure')
  let parentSyncs = 0
  const retry = createChannelSecretStore(failedRoot, {
    async open(path, ...args) {
      return instrument(await open(path, ...args), async (method, call) => {
        if (path === root && method === 'sync' && ++parentSyncs === 1) throw new Error('synthetic-secret-that-must-not-escape')
        return call()
      })
    },
  })
  await assert.rejects(retry.write('cursor', 'not-published'), safeError('CHANNEL_SECRET_DIRECTORY_DURABILITY_UNKNOWN'))
  assert.deepEqual(await readdir(failedRoot), [])
  await retry.write('context', 'published-after-barrier')
  assert.equal(parentSyncs, 2)
  assert.equal(await retry.read('cursor'), undefined)
  assert.equal(await retry.read('context'), 'published-after-barrier')
}

async function valuesAndPermissions() {
  for (const value of ['relative', '/', null]) assert.throws(() => createChannelSecretStore(value), hasCode('CHANNEL_SECRET_INVALID'))
  assert.equal(await store.read('cursor'), undefined)
  await assert.rejects(lstat(secretRoot), error => error.code === 'ENOENT')
  assert.equal(await store.write('cursor', 'cursor-0'), undefined)
  await store.write('token', 'synthetic-bot-token')
  await store.write('context', { token: 'synthetic-context', sequence: '9007199254740993', timestamp: 200 })
  assert.equal((await lstat(secretRoot)).mode & 0o777, 0o700)
  for (const ref of refs) {
    assert.equal((await lstat(join(secretRoot, ref))).mode & 0o777, 0o600)
    assert.equal(await resolveCredentialFile(secretRoot, ref), join(secretRoot, ref))
  }
  assert.equal(await store.read('token'), 'synthetic-bot-token')
  const context = await store.read('context')
  context.token = 'local-copy-only'
  assert.equal((await store.read('context')).token, 'synthetic-context')
  for (let index = 1; index <= 4; index += 1) await store.write('cursor', `cursor-${index}`)
  assert.deepEqual((await readdir(secretRoot)).sort(), refs)
  assert.equal(await store.read('cursor'), 'cursor-4')
  await store.write('context', null); assert.equal(await store.read('context'), null)
  await store.write('context', { token: 'synthetic-context', sequence: '9007199254740993', timestamp: 200 })

  const before = await readFile(join(secretRoot, 'cursor'), 'utf8')
  for (const value of [undefined, 1n]) await assert.rejects(store.write('cursor', value), hasCode('CHANNEL_SECRET_INVALID'))
  await assert.rejects(store.update('cursor', null), hasCode('CHANNEL_SECRET_INVALID'))
  await assert.rejects(store.update('cursor', () => { throw new Error('synthetic-secret-that-must-not-escape') }), safeError('CHANNEL_SECRET_UNAVAILABLE'))
  assert.equal(await readFile(join(secretRoot, 'cursor'), 'utf8'), before)
  const initial = createChannelSecretStore(join(root, 'new-store'))
  await initial.update('cursor', current => { assert.equal(current, undefined); return 'initial-cursor' })
  assert.equal(await initial.read('cursor'), 'initial-cursor')
}

async function rejectedPaths() {
  for (const ref of ['', '.', '..', '../outside', 'nested/ref', '/absolute', ' padded', 'bad\nref', 'a'.repeat(129), null]) {
    await assert.rejects(store.read(ref), hasCode('CHANNEL_SECRET_INVALID'))
    await assert.rejects(store.write(ref, 'synthetic'), hasCode('CHANNEL_SECRET_INVALID'))
    await assert.rejects(store.update(ref, () => 'synthetic'), hasCode('CHANNEL_SECRET_INVALID'))
  }
  await chmod(secretRoot, 0o755)
  try {
    for (const operation of [() => store.read('cursor'), () => store.write('cursor', 'bad'), () => store.update('cursor', () => 'bad')]) await assert.rejects(operation(), hasCode('CHANNEL_SECRET_INVALID'))
    assert.equal((await lstat(secretRoot)).mode & 0o777, 0o755)
  } finally { await chmod(secretRoot, 0o700) }
  await chmod(join(secretRoot, 'cursor'), 0o644)
  try {
    await assert.rejects(store.read('cursor'), hasCode('CHANNEL_SECRET_INVALID'))
    await assert.rejects(store.write('cursor', 'bad'), hasCode('CHANNEL_SECRET_INVALID'))
    assert.equal((await lstat(join(secretRoot, 'cursor'))).mode & 0o777, 0o644)
  } finally { await chmod(join(secretRoot, 'cursor'), 0o600) }

  const outside = join(root, 'outside')
  await writeFile(outside, JSON.stringify('untouched'), { mode: 0o600 })
  await symlink(outside, join(secretRoot, 'linked'))
  try {
    await assert.rejects(store.read('linked'), hasCode('CHANNEL_SECRET_INVALID'))
    await assert.rejects(store.write('linked', 'bad'), hasCode('CHANNEL_SECRET_INVALID'))
    await assert.rejects(store.update('linked', () => 'bad'), hasCode('CHANNEL_SECRET_INVALID'))
    assert.equal(JSON.parse(await readFile(outside, 'utf8')), 'untouched')
  } finally { await rm(join(secretRoot, 'linked')) }
  const linkedRoot = join(root, 'linked-root')
  await symlink(secretRoot, linkedRoot)
  await assert.rejects(createChannelSecretStore(linkedRoot).read('cursor'), hasCode('CHANNEL_SECRET_INVALID'))
  await assert.rejects(createChannelSecretStore(linkedRoot).write('new', 'bad'), hasCode('CHANNEL_SECRET_INVALID'))
  await assert.rejects(createChannelSecretStore(join(linkedRoot, 'nested')).write('new', 'bad'), hasCode('CHANNEL_SECRET_INVALID'))
  await assert.rejects(lstat(join(secretRoot, 'nested')), error => error.code === 'ENOENT')
  await assert.rejects(createChannelSecretStore(outside).write('new', 'bad'), hasCode('CHANNEL_SECRET_INVALID'))
  await assert.rejects(createChannelSecretStore(join(root, 'missing-parent', 'secrets')).write('new', 'bad'), safeError('CHANNEL_SECRET_UNAVAILABLE'))
  await assert.rejects(lstat(join(root, 'missing-parent')), error => error.code === 'ENOENT')

  await mkdir(join(secretRoot, 'directory'), { mode: 0o700 })
  try { await assert.rejects(store.write('directory', 'bad'), hasCode('CHANNEL_SECRET_INVALID')) } finally { await rm(join(secretRoot, 'directory'), { recursive: true }) }
  await writeFile(join(secretRoot, 'corrupt'), '{', { mode: 0o600 })
  try { await assert.rejects(store.read('corrupt'), hasCode('CHANNEL_SECRET_INVALID')) } finally { await rm(join(secretRoot, 'corrupt')) }
  await store.write('changed', 'before-open')
  const replacement = join(root, 'replacement')
  await writeFile(replacement, JSON.stringify('after-open'), { mode: 0o600 })
  let readChangedFile = false
  const changed = createChannelSecretStore(secretRoot, {
    async open(path, ...args) {
      if (path === join(secretRoot, 'changed')) await rename(replacement, path)
      return instrument(await open(path, ...args), async (method, call) => {
        if (method === 'readFile') readChangedFile = true
        return call()
      })
    },
  })
  try {
    await assert.rejects(changed.read('changed'), hasCode('CHANNEL_SECRET_INVALID'))
    assert.equal(readChangedFile, false)
  } finally { await rm(join(secretRoot, 'changed')) }
}

async function atomicWrites() {
  const events = []
  const traced = createChannelSecretStore(secretRoot, {
    async open(path, flags, mode) {
      const role = path === root ? 'parent' : path === secretRoot ? 'directory' : 'temp'
      events.push(`${role}-open`)
      if (role === 'temp') { assert(flags & constants.O_EXCL); assert(flags & constants.O_NOFOLLOW); assert.equal(mode, 0o600) }
      return instrument(await open(path, flags, mode), async (method, call) => {
        if (['chmod', 'writeFile', 'sync', 'close'].includes(method)) events.push(`${role}-${method}`)
        return call()
      })
    },
    async rename(from, to) { events.push('rename'); assert.equal(to, join(secretRoot, 'cursor')); return rename(from, to) },
  })
  await traced.write('cursor', 'atomic-current')
  assert.deepEqual(events, ['parent-open', 'parent-sync', 'parent-close', 'temp-open', 'temp-chmod', 'temp-writeFile', 'temp-sync', 'temp-close', 'directory-open', 'rename', 'directory-sync', 'directory-close'])
  assert.equal(await store.read('cursor'), 'atomic-current')

  const hold = deferred(), entered = deferred()
  const held = createChannelSecretStore(secretRoot, {
    async open(path, flags, mode) {
      return instrument(await open(path, flags, mode), async (method, call) => {
        if (path !== root && path !== secretRoot && method === 'sync') { entered.resolve(); await hold.promise }
        return call()
      })
    },
  })
  const writing = held.write('cursor', 'atomic-next')
  await entered.promise
  let readFinished = false
  const reading = store.read('cursor').then(value => { readFinished = true; return value })
  try {
    assert.equal(JSON.parse(await readFile(join(secretRoot, 'cursor'), 'utf8')), 'atomic-current')
    await delay(5); assert.equal(readFinished, false)
  } finally { hold.resolve() }
  await writing
  assert.equal(await reading, 'atomic-next')

  for (const stage of ['mkdir', 'parent-open', 'parent-sync', 'temp-open', 'writeFile', 'file-sync', 'file-close', 'directory-open', 'rename']) {
    const before = await readFile(join(secretRoot, 'cursor'), 'utf8')
    const broken = failingStore(stage)
    await assert.rejects(broken.write('cursor', 'synthetic-secret-that-must-not-escape'), safeError(stage === 'mkdir' ? 'CHANNEL_SECRET_UNAVAILABLE' : stage.startsWith('parent-') ? 'CHANNEL_SECRET_DIRECTORY_DURABILITY_UNKNOWN' : 'CHANNEL_SECRET_WRITE_FAILED'))
    assert.equal(await readFile(join(secretRoot, 'cursor'), 'utf8'), before)
    assert.deepEqual((await readdir(secretRoot)).sort(), refs)
    failedWrites += 1
  }
  const uncertain = failingStore('directory-sync')
  await assert.rejects(uncertain.write('cursor', 'renamed-current'), safeError('CHANNEL_SECRET_DURABILITY_UNKNOWN'))
  assert.equal(await store.read('cursor'), 'renamed-current')
  assert.deepEqual((await readdir(secretRoot)).sort(), refs)
  await store.write('cursor', 'cursor-0')
}

async function concurrentUpdates() {
  const peer = createChannelSecretStore(secretRoot)
  await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? store : peer).update('cursor', async current => {
    await delay(1)
    return `cursor-${Number(current.slice('cursor-'.length)) + 1}`
  })))
  assert.equal(await store.read('cursor'), 'cursor-16')
  await Promise.all([
    store.update('context', async current => { await delay(2); return { ...current, token: 'synthetic-context-new' } }),
    peer.update('context', async current => { await delay(1); return { ...current, sequence: '9007199254740994' } }),
  ])
  assert.deepEqual(await store.read('context'), { token: 'synthetic-context-new', sequence: '9007199254740994', timestamp: 200 })

  const hold = deferred(), entered = deferred()
  const blocked = store.update('context', async current => { entered.resolve(); await hold.promise; return current })
  await entered.promise
  try { await peer.write('cursor', 'cursor-independent') } finally { hold.resolve() }
  await blocked
  assert.equal(await store.read('cursor'), 'cursor-independent')
  await assert.rejects(peer.update('cursor', () => { throw new Error('synthetic-secret-that-must-not-escape') }), safeError('CHANNEL_SECRET_UNAVAILABLE'))
  await store.update('cursor', current => current + '-after-error')
  assert.equal(await peer.read('cursor'), 'cursor-independent-after-error')
}

function failingStore(stage) {
  const fail = () => { throw new Error('synthetic-secret-that-must-not-escape') }
  return createChannelSecretStore(secretRoot, {
    async mkdir(...args) { if (stage === 'mkdir') fail(); return mkdir(...args) },
    async open(path, flags, mode) {
      const role = path === root ? 'parent' : path === secretRoot ? 'directory' : 'temp'
      if (stage === `${role}-open`) fail()
      return instrument(await open(path, flags, mode), async (method, call) => {
        if (method === 'writeFile' && stage === 'writeFile') fail()
        if (method === 'sync' && stage === (role === 'temp' ? 'file-sync' : `${role}-sync`)) fail()
        const result = await call()
        if (role === 'temp' && method === 'close' && stage === 'file-close') fail()
        return result
      })
    },
    async rename(...args) { if (stage === 'rename') fail(); return rename(...args) },
  })
}
function instrument(handle, intercept) {
  return new Proxy(handle, { get(target, key) {
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? (...args) => intercept(key, () => value.apply(target, args)) : value
  } })
}
function hasCode(code) { return error => error?.code === code }
function safeError(code) { return error => error?.code === code && error.message === '渠道秘密存储当前不可用' && error.cause === undefined }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
