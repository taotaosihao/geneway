import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHostIdentity, writeHostIdentity } from '../packages/agent-host/identity.mjs'
import { acquireHostOwner } from '../packages/agent-host/ownership.mjs'

if (process.argv[2] === '--crash') {
  const root = process.argv[3], operation = process.argv[4], owner = await acquireHostOwner(root)
  const operations = { async rename(from) {
    process.send({ kind: 'before-rename', temporary: basename(from), helperPid: owner.helperPid })
    await new Promise(() => {})
  } }
  if (operation === 'create') await readHostIdentity(root, operations)
  else { const identity = await readHostIdentity(root); await writeHostIdentity(root, { ...identity, registrationRevision: 2 }, operations) }
} else {
  const directory = await fs.mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/host-identity-temp-'), results = []
  const selected = process.argv[2], enabled = name => !selected || selected === name
  console.log('Evidence directory:', directory)
  if (enabled('crash')) {
    for (const operation of ['create', 'update']) {
      const root = join(directory, `crash-${operation}`)
      let original, originalBytes
      if (operation === 'update') await owned(root, async () => {
        original = await readHostIdentity(root)
        await writeHostIdentity(root, { ...original, nodeId: 'paired-fixture', registrationRevision: 1, credentialVersion: 1 })
        original = await readHostIdentity(root); originalBytes = await fs.readFile(join(root, 'node-identity.json'))
      })
      const child = fork(fileURLToPath(import.meta.url), ['--crash', root, operation], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] })
      const blocked = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('identity producer exited before rename barrier'))) })
      assert.equal(blocked.kind, 'before-rename')
      await assert.rejects(acquireHostOwner(root), { code: 'HOST_ALREADY_RUNNING' })
      const residual = join(root, blocked.temporary), residualBytes = await fs.readFile(residual)
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await closed
      assert.equal(child.signalCode, 'SIGKILL')
      await waitForExit(blocked.helperPid)
      await owned(root, async () => {
        const recovered = await readHostIdentity(root)
        const metadata = await fs.stat(join(root, 'node-identity.json'))
        assert.equal(metadata.mode & 0o777, 0o600); if (process.getuid) assert.equal(metadata.uid, process.getuid())
        assert((await fs.readFile(residual)).equals(residualBytes), 'crash residual must remain unchanged')
        if (original) { assertStable(recovered, original); assert((await fs.readFile(join(root, 'node-identity.json'))).equals(originalBytes), 'unpublished update must not replace the original identity') }
        const reopened = await readHostIdentity(root); assertStable(reopened, recovered)
      })
      results.push({ case: `crash-${operation}`, realOwnerLock: true, childSignal: child.signalCode, residualPreserved: true, publishedIdentityStable: operation === 'update' })
    }
  }
  if (enabled('cleanup')) await owned(join(directory, 'cleanup'), async root => {
    const identity = await readHostIdentity(root), originalBytes = await fs.readFile(join(root, 'node-identity.json'))
    for (const code of ['EEXIST', 'EACCES']) {
      let unowned
      await assert.rejects(writeHostIdentity(root, identity, { async open(path, flags, mode) {
        if (path !== join(root, 'node-identity.json') && path !== root) {
          assert(flags & constants.O_EXCL); assert(flags & constants.O_NOFOLLOW); assert.equal(mode, 0o600)
          unowned = path; await fs.writeFile(path, 'not-owned-by-this-attempt', { flag: 'wx', mode: 0o600 })
          if (code === 'EACCES') throw Object.assign(new Error('controlled open denial'), { code })
        }
        return fs.open(path, flags, mode)
      } }), { code })
      assert.equal(await fs.readFile(unowned, 'utf8'), 'not-owned-by-this-attempt')
      assert((await fs.readFile(join(root, 'node-identity.json'))).equals(originalBytes), 'failed open must preserve original identity')
      results.push({ case: `unowned-${code}`, unownedTemporaryPreserved: true })
    }
  })
  if (enabled('faults')) await owned(join(directory, 'faults'), async root => {
    const original = await readHostIdentity(root)
    await writeHostIdentity(root, { ...original, nodeId: 'paired-fixture', registrationRevision: 1, credentialVersion: 1 })
    const stable = await readHostIdentity(root), originalBytes = await fs.readFile(join(root, 'node-identity.json'))
    for (const stage of ['write', 'fileSync', 'rename', 'dirSync']) {
      let temporary, hit = false
      const fail = () => { hit = true; throw Object.assign(new Error('controlled identity I/O failure'), { code: 'EIO' }) }
      const operations = {
        async open(path, flags, mode) {
          const handle = await fs.open(path, flags, mode), isTemp = path !== root && path !== join(root, 'node-identity.json')
          if (isTemp) temporary = path
          return new Proxy(handle, { get(target, field) {
            if (field === 'writeFile' && isTemp && stage === 'write') return async () => fail()
            if (field === 'sync' && (isTemp && stage === 'fileSync' || path === root && stage === 'dirSync')) return async () => fail()
            const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value
          } })
        },
        async rename(from, to) { if (stage === 'rename') fail(); await fs.rename(from, to) },
      }
      await assert.rejects(writeHostIdentity(root, { ...stable, registrationRevision: 2 }, operations), { code: 'EIO' }); assert(hit)
      await assert.rejects(fs.stat(temporary), { code: 'ENOENT' })
      if (stage !== 'dirSync') assert((await fs.readFile(join(root, 'node-identity.json'))).equals(originalBytes), 'pre-publish failure must preserve old identity bytes')
      else await assert.rejects(readHostIdentity(root, operations), { code: 'EIO' })
      const recovered = await readHostIdentity(root); assertStable(recovered, stable)
      assert.equal(recovered.registrationRevision, stage === 'dirSync' ? 2 : 1)
      results.push({ case: stage, failedClosed: true, stablePublishedIdentity: true, reconfirmedAfterRename: stage === 'dirSync' })
    }
  })
  const result = { result: 'passed', directory, boundary: 'real local filesystem, original flock owner, SIGKILL/restart and controlled I/O; no pairing HTTP/provider/credential output', results }
  await fs.writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
}
function assertStable(current, previous) {
  assert(current.nodeInstanceId === previous.nodeInstanceId, 'nodeInstanceId changed')
  assert(current.pairRequestId === previous.pairRequestId, 'pairRequestId changed')
  assert(current.credential === previous.credential, 'credential changed')
  assert(current.nodeId === previous.nodeId, 'paired node changed')
  assert(current.credentialVersion === previous.credentialVersion, 'credential version changed')
}
async function owned(root, run) { const owner = await acquireHostOwner(root); try { return await run(root) } finally { await owner.release() } }
async function waitForExit(pid) {
  const deadline = Date.now() + 5000
  while (true) {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(cause => { if (!['ENOENT', 'ESRCH'].includes(cause.code)) throw cause; return '' })
    if (!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return
    assert(Date.now() < deadline, 'owner helper did not exit after parent SIGKILL'); await new Promise(resolve => setTimeout(resolve, 10))
  }
}
