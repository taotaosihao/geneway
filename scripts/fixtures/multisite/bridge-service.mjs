import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createServer as createPortServer } from 'node:net'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileStore } from '../../../src/store/file-store.mjs'
import { createWorkService } from '../../../src/work-service.mjs'
import { createGenewayServer } from '../../../src/server.mjs'
import { createAuthRuntime, initializeAuthFile } from '../../../src/auth.mjs'
import { createKnowledgeService } from '../../../src/knowledge-service.mjs'
import { createModelGateway } from '../../../src/model-gateway.mjs'
import { createArtifactService } from '../../../src/artifact-service.mjs'
import { createSpreadsheetService } from '../../../src/spreadsheet-service.mjs'
import { createSpreadsheetArtifacts } from '../../../src/spreadsheet-artifacts.mjs'
import { createEvidenceService } from '../../../src/evidence-service.mjs'
import { createNodeService } from '../../../src/node-service.mjs'
import { createNodeBridge } from '../../../src/node-bridge.mjs'
import { readRuntimeConfig } from '../../../src/runtime-config.mjs'
import { seedDelegation } from './delegation.mjs'
export async function startBridgeService({ directory, listenPort, upstreamBaseUrl, storeOperations, fetchImpl, seedState, index, spreadsheetVerification, spreadsheetFileOperations, trustedOrigin, onRequest, workMemberProtocolStatus, clock = () => Date.now() }) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const store = createFileStore(join(directory, 'state.json'), storeOperations)
  if (!(await store.read()).members.length) await store.update(state => {
    (seedState ?? seedDelegation)(state)
    if (!seedState) for (const employee of state.employees) employee.placement.nodeId = ({ coordinator: 'cloud', analysis: 'cloud', 'desktop-office': 'pc-b', 'desktop-data': 'pc-a', gateway: 'gateway' })[employee.id]
    state.skills = [{ id: 'cycle', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }]
    for (const employee of state.employees) employee.skillIds = ['cycle']
    return state
  })
  let port = listenPort
  if (port === undefined) { const portServer = createPortServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); port = portServer.address().port; await new Promise(resolve => portServer.close(resolve)) }
  const origin = `http://127.0.0.1:${port}`, config = readRuntimeConfig({ GENEWAY_STATE: join(directory, 'state.json'), GENEWAY_SECRET_ROOT: join(directory, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key' }, process.cwd())
  const attachments = createArtifactService({ store, root: join(directory, 'attachments') })
  const gateway = createModelGateway({ store, config, attachments, ...(fetchImpl ? { fetchImpl } : {}), ...(upstreamBaseUrl ? { upstreamBaseUrl } : {}) })
  let bridge
  const nodes = createNodeService({ store, clock, onRevoke: id => bridge?.revoke(id) })
  const evidence = createEvidenceService({ store, nodes, root: join(directory, 'evidence'), clock })
  const spreadsheetService = createSpreadsheetService({ store, attachments, gateway, evidence }), spreadsheetArtifacts = createSpreadsheetArtifacts({ store, attachments, gateway, evidence, root: join(directory, 'artifacts'), ...(spreadsheetFileOperations ? { fsOps: spreadsheetFileOperations } : {}), ...(spreadsheetVerification ? { verification: spreadsheetVerification } : {}) })
  const service = createWorkService({ store, workMemberProtocolStatus, multisiteOptions: { hosts: [], attachments, evidence, spreadsheetArtifacts, requireRemoteNodes: true } })
  bridge = createNodeBridge({ store, nodes, gateway, spreadsheetService, spreadsheetArtifacts, getMultisite: () => service.multisite, clock, scanIntervalMs: 50 })
  const authPath = join(directory, 'auth.json')
  try { await readFile(authPath) } catch (cause) { if (cause.code !== 'ENOENT') throw cause; await initializeAuthFile(authPath, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] }) }
  const requestCounts = new Map()
  const server = createGenewayServer({ service, store, index, attachments, spreadsheetArtifacts, evidence, auth: createAuthRuntime({ filePath: authPath }), nodeService: nodes, nodeBridge: bridge, modelGateway: gateway, trustedOrigin: trustedOrigin ?? origin, knowledge: createKnowledgeService({ store }) })
  if (onRequest) server.prependListener('request', onRequest)
  server.on('request', request => { const path = new URL(request.url, origin).pathname; requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1) })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); bridge.start()
  return { origin, store, nodes, bridge, service, gateway, attachments, evidence, spreadsheetService, spreadsheetArtifacts, requestCount: path => requestCounts.get(path) ?? 0, async close() { bridge.close(); await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let fixture
  process.once('message', async options => {
    try {
      fixture = await startBridgeService(options)
      await mkdir(join(options.directory, 'secrets'), { recursive: true, mode: 0o700 })
      await writeFile(join(options.directory, 'secrets/key'), 'synthetic-only-provider-key', { mode: 0o600 })
      process.send({ kind: 'ready', origin: fixture.origin, pid: process.pid })
    } catch (cause) { process.send({ kind: 'error', code: cause.code ?? 'BRIDGE_START_FAILED' }); process.exitCode = 1 }
  })
  process.on('SIGTERM', () => { fixture?.close().finally(() => process.exit(0)) })
}
