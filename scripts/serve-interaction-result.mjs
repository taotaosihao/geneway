import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { createKnowledgeService } from '../src/knowledge-service.mjs'
import { createAuthRuntime } from '../src/auth.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createWorkService, projectBootstrap } from '../src/work-service.mjs'
import { createSpreadsheetArtifacts } from '../src/spreadsheet-artifacts.mjs'
import { createHash } from 'node:crypto'

// Frozen result inspection: real HTTP projections, without any writable domain or runtime.
const source = process.argv[2], directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/interaction-result-view-')
assert(source)
const snapshotName = process.argv[3] ?? 'state-final.json'; assert(/^[a-zA-Z0-9._-]+\.json$/.test(snapshotName))
const sourceFile = join(source, snapshotName), original = await readFile(sourceFile)
let providerFile = join(source, process.argv.includes('--context') ? 'provider-requests.jsonl' : 'provider-bodies.json'), provider
try { provider = await readFile(providerFile) } catch (cause) { if (cause.code !== 'ENOENT' || !process.argv.includes('--context')) throw cause; providerFile = join(source, 'provider-bodies.json'); provider = await readFile(providerFile) }
await writeFile(join(directory, 'state.json'), original)
await cp(join(source, 'api/auth.json'), join(directory, 'auth.json'))
const snapshot = JSON.parse(original), store = { read: async () => structuredClone(snapshot), update: async () => { throw new Error('RESULT_VIEW_IS_READ_ONLY') } }
const service = createWorkService({ store, multisiteOptions: { hosts: [], requireRemoteNodes: true } })
service.bootstrap = async actor => projectBootstrap(structuredClone(snapshot), actor)
service.getWork = async (actor, id) => { service.multisite.authorizeRead(snapshot, actor, id); return { ok: true, value: projectBootstrap(structuredClone(snapshot), actor).works.find(row => row.id === id) } }
const index = await readFile('web/index.html', 'utf8'), metadataDependencies = process.argv.includes('--context') ? { modelGateway: { setContextReader() {}, async handle() { return false } }, spreadsheetArtifacts: createSpreadsheetArtifacts({ store, root: join(source, 'api/artifacts') }) } : {}
const observations = [], server = createGenewayServer({ service, store, knowledge: createKnowledgeService({ store }), auth: createAuthRuntime({ filePath: join(directory, 'auth.json') }), ...metadataDependencies, index, trustedOrigin: 'http://127.0.0.1:1', interactionRuntimeEnabled: false })
// Choose the local port before constructing the server's fixed trusted Origin.
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const origin = `http://127.0.0.1:${port}`, viewer = createGenewayServer({ service, store, knowledge: createKnowledgeService({ store }), auth: createAuthRuntime({ filePath: join(directory, 'auth.json') }), ...metadataDependencies, index, trustedOrigin: origin, interactionRuntimeEnabled: false })
const [handler] = viewer.listeners('request'); viewer.removeListener('request', handler)
viewer.on('request', (request, response) => {
  const path = new URL(request.url, origin).pathname
  response.once('finish', () => observations.push({ method: request.method, path, status: response.statusCode }))
  if (request.method !== 'GET' && !(request.method === 'POST' && path === '/api/session')) { response.writeHead(405, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'READ_ONLY_RESULT' } })); return }
  return handler(request, response)
})
await new Promise(resolve => viewer.listen(port, '127.0.0.1', resolve))
await writeFile(join(directory, 'served-index.html'), index)
console.log(JSON.stringify({ stage: 'read-only result ready', directory, source, snapshotName, origin, pid: process.pid, servedHtmlSha256: createHash('sha256').update(index).digest('hex'), boundary: 'real server session and authorized bootstrap/interaction GET; frozen readStore rejects updates; disabled model adapter only enables context metadata projection, no credential/forward/provider/Host/DSH/background interval' }))
await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
viewer.closeAllConnections(); await new Promise(resolve => viewer.close(resolve))
assert.deepEqual(await readFile(sourceFile), original); assert.deepEqual(await readFile(providerFile), provider); assert.deepEqual(await readFile(join(directory, 'state.json')), original)
await writeFile(join(directory, 'result.json'), JSON.stringify({ result: 'passed', source, snapshotName, directory, observations, sourceStateAndProviderUnchanged: true, writableStore: false, executionServices: false }, null, 2))
