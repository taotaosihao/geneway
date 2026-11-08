import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { start } from '../src/server.mjs'

// Reopen an existing local acceptance result for independent UI readback, without a Host.
const directory = resolve(process.argv[2]), state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
if (!state.works.some(work => work.status === 'completed') || !state.artifacts.some(artifact => artifact.status === 'ready')) throw new Error('需要已有核验成果')
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
const origin = `http://127.0.0.1:${port}`
Object.assign(process.env, { GENEWAY_STATE: join(directory, 'state.json'), GENEWAY_AUTH_FILE: join(directory, 'auth.json'), GENEWAY_SECRET_ROOT: join(directory, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'model.key', GENEWAY_CONNECTION_CATALOG: join(directory, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(directory, 'unused-cloud-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: String(port), GENEWAY_TRUSTED_ORIGIN: origin })
await start()
console.log(JSON.stringify({ directory, origin, pid: process.pid, mode: 'existing-result-no-Host', completedWorkIds: state.works.filter(work => work.status === 'completed').map(work => work.id), stoppedWorkIds: state.works.filter(work => work.status === 'cancelled').map(work => work.id) }))
