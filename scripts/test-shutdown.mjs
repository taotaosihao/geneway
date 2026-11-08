import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shutdownServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'

let releaseServiceClose
let serviceCloseStarted
const closeStarted = new Promise(resolve => { serviceCloseStarted = resolve })
const closeGate = new Promise(resolve => { releaseServiceClose = resolve })
const heldServer = createServer((_request, response) => response.end('ok'))
await new Promise(resolve => heldServer.listen(0, '127.0.0.1', resolve))
const heldUrl = `http://127.0.0.1:${heldServer.address().port}/api/bootstrap`
assert.equal((await fetch(heldUrl, { headers: { connection: 'close' } })).status, 200)
const heldShutdown = shutdownServer(heldServer, { close: async () => { serviceCloseStarted(); await closeGate } })
let heldShutdownSettled = false
heldShutdown.finally(() => { heldShutdownSettled = true })
await closeStarted
await assert.rejects(() => fetch(heldUrl))
await new Promise(resolve => setImmediate(resolve))
assert.equal(heldShutdownSettled, false)
releaseServiceClose()
await heldShutdown
await assert.rejects(() => fetch(heldUrl))

const lifecycle = [], lifecycleServer = createServer((_request, response) => response.end('ok'))
await new Promise(resolve => lifecycleServer.listen(0, '127.0.0.1', resolve))
await shutdownServer(
  lifecycleServer,
  { async close() { lifecycle.push('work') } },
  { async close() { lifecycle.push('channel') } },
  { async stop() { lifecycle.push('automation-stop') }, async close() { lifecycle.push('automation-close') } },
  { async close() { lifecycle.push('receiver') } },
)
assert.deepEqual(lifecycle, ['receiver', 'automation-stop', 'channel', 'work', 'automation-close'])

const root = await mkdtemp(join(tmpdir(), 'geneway-shutdown-'))
const connectionCatalog = join(root, 'connections.json')
await writeFile(connectionCatalog, JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
const statePath = join(root, 'state.json')
await createFileStore(statePath).update(state => ({ ...state, connections: [{
  id: 'historical-disabled', name: '历史停用连接', kind: 'gearjob-rest', targetIdentity: 'historical', baseUrl: 'http://127.0.0.1:1', credentialRef: 'historical.json', allowedObjectIds: [], sourceSystem: 'GearJob', sourceInstance: 'historical', sourceEnvironment: 'historical', dataMode: 'synthetic', evidenceMode: 'historical', enabled: false, status: 'unavailable', skillIds: [], revision: 1,
}] }))
const port = 3499
const remote = spawn(process.execPath, ['src/server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, GENEWAY_HOST: '0.0.0.0', GENEWAY_ALLOW_REMOTE: 'true', GENEWAY_AUTH_FILE: join(root, 'remote-auth.json') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let remoteError = ''
remote.stderr.on('data', chunk => { remoteError += chunk })
const remoteExit = await new Promise(resolve => remote.once('exit', resolve))
assert.notEqual(remoteExit, 0)
assert.match(remoteError, /仅允许 loopback/)


const launchEnvironment = {
    ...process.env,
    GENEWAY_PORT: String(port),
    GENEWAY_TRUSTED_ORIGIN: 'https://localhost:4443',
    GENEWAY_STATE: statePath,
    GENEWAY_AUTH_FILE: join(root, 'auth.json'),
    GENEWAY_DSH_HOME: join(root, 'dsh'),
    DSH_HOME: join(root, 'dsh'),
    GENEWAY_CONNECTION_CATALOG: connectionCatalog,
    GENEWAY_GEARJOB_BASE_URL: '',
    GENEWAY_GEARJOB_CREDENTIAL_FILE: '',
    GENEWAY_GEARJOB_ALLOWED_WORK_ORDER: '',
}
const child = spawn(process.execPath, ['src/server.mjs'], { cwd: process.cwd(), env: launchEnvironment, stdio: ['ignore', 'ignore', 'pipe'] })
let defaultChild
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200)
  child.kill('SIGTERM')
  const exitCode = await new Promise(resolve => child.once('exit', resolve))
  assert.equal(exitCode, 0)
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`))
  delete launchEnvironment.GENEWAY_TRUSTED_ORIGIN
  defaultChild = spawn(process.execPath, ['src/server.mjs'], { cwd: process.cwd(), env: launchEnvironment, stdio: ['ignore', 'ignore', 'pipe'] })
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200)
  const defaultExit = new Promise(resolve => defaultChild.once('exit', resolve)); defaultChild.kill('SIGTERM'); assert.equal(await defaultExit, 0)
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`))
  console.log('shutdown checks passed: explicit HTTPS origin accepted with loopback listener; default HTTP loopback starts and exits; non-loopback listen rejected')
} finally {
  if (child.exitCode === null) child.kill('SIGKILL')
  if (defaultChild?.exitCode === null) defaultChild.kill('SIGKILL')
  await rm(root, { recursive: true, force: true })
}
