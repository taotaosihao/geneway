import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer as createPortServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileStore } from '../src/store/file-store.mjs'
const source = process.argv[2] ?? '/home/gewu/.codex/task-checkpoints/geneway-evidence/bridge-native-ho7Jib/cloud-api/state.json'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/production-remote-'), log = []
let child
try {
  const original = JSON.parse(await readFile(source, 'utf8')), store = createFileStore(join(directory, 'state.json')); await store.update(() => original)
  await writeFile(join(directory, 'auth.json'), await readFile(join(source.slice(0, source.lastIndexOf('/')), 'auth.json')), { mode: 0o600 })
  await writeFile(join(directory, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  await mkdir(join(directory, 'secrets'), { mode: 0o700 }); await writeFile(join(directory, 'secrets/key'), 'synthetic-only-provider-key', { mode: 0o600 })
  const ports = createPortServer(); await new Promise(resolve => ports.listen(0, '127.0.0.1', resolve)); const port = ports.address().port; await new Promise(resolve => ports.close(resolve)); const origin = `http://127.0.0.1:${port}`
  child = fork(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: directory, GENEWAY_STATE: join(directory, 'state.json'), GENEWAY_AUTH_FILE: join(directory, 'auth.json'), GENEWAY_SECRET_ROOT: join(directory, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(directory, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(directory, 'dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: String(port), GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: 'http://127.0.0.1:1/v1' }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(`production start timed out: ${log.join('')}`)), 15_000); child.stdout.on('data', bytes => { log.push(bytes.toString()); if (bytes.toString().includes('Geneway listening on')) { clearTimeout(timeout); resolve() } }); child.stderr.on('data', bytes => log.push(bytes.toString())); child.once('exit', code => { clearTimeout(timeout); reject(new Error(`production start exited ${code}: ${log.join('')}`)) }) })
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); assert.equal(login.status, 200)
  const descendants = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
  for (const pid of descendants) assert(!(await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes('runtime-worker.mjs'))
  const beforeShutdown = await store.read(); assert.deepEqual(beforeShutdown.multisite.attempts, original.multisite.attempts); assert.deepEqual(beforeShutdown.modelRequests, original.modelRequests); assert.deepEqual(beforeShutdown.works.filter(row => row.workType === 'multisite'), original.works.filter(row => row.workType === 'multisite'))
  const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended
  const after = await store.read(); assert.deepEqual(after.multisite.attempts, original.multisite.attempts); assert.deepEqual(after.nodes, original.nodes)
  const result = { result: 'passed', directory, source, actualProductionStart: true, remoteModeNoLocalHostWorker: true, actualLogin: true, existingRemoteAttemptsUnchanged: true, modelLedgerUnchanged: true, gracefulShutdownLeavesNodeState: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await writeFile(join(directory, 'production.log'), log.join('')); if (child && child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended } }
