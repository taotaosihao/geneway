import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shutdownServer } from '../src/server.mjs'

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

const root = await mkdtemp(join(tmpdir(), 'geneway-shutdown-'))
const port = 3499
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    GENEWAY_PORT: String(port),
    GENEWAY_STATE: join(root, 'state.json'),
    GENEWAY_DSH_HOME: join(root, 'dsh'),
    GENEWAY_GEARJOB_BASE_URL: '',
    GENEWAY_GEARJOB_CREDENTIAL_FILE: '',
    GENEWAY_GEARJOB_ALLOWED_WORK_ORDER: '',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).ok) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).status, 200)
  child.kill('SIGTERM')
  const exitCode = await new Promise(resolve => child.once('exit', resolve))
  assert.equal(exitCode, 0)
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/bootstrap`))
  console.log('shutdown checks passed')
} finally {
  if (child.exitCode === null) child.kill('SIGKILL')
  await rm(root, { recursive: true, force: true })
}
