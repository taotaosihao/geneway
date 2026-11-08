import { createServer as createPortServer } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileStore } from '../../../src/store/file-store.mjs'
import { createWorkService } from '../../../src/work-service.mjs'
import { createGenewayServer } from '../../../src/server.mjs'
import { createAuthRuntime, initializeAuthFile } from '../../../src/auth.mjs'
import { createArtifactService } from '../../../src/artifact-service.mjs'
import { createModelGateway } from '../../../src/model-gateway.mjs'
import { createNodeService } from '../../../src/node-service.mjs'
import { createNodeBridge } from '../../../src/node-bridge.mjs'
import { readRuntimeConfig } from '../../../src/runtime-config.mjs'

let server, bridge, service
process.once('message', async ({ directory, upstreamBaseUrl, supervisionIdentities }) => {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const store = createFileStore(join(directory, 'state.json'))
    await store.update(state => {
      state.members = [{ id: 'owner', loginName: 'owner', authRef: 'owner', displayName: '模拟监督验收成员', enabled: true, role: 'admin', sessionVersion: 1, employeeIds: ['coordinator'] }]
      state.modelRoutes = [{ id: 'route', enabled: true, provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', parameters: { maxOutputTokens: 4096 } }]
      state.employees = [{ id: 'coordinator', name: 'coordinator', enabled: true, revision: 1, instructions: '', modelRouteId: 'route', connectionIds: [], skillIds: [], placement: { nodeId: 'cloud', mode: 'agent_host', resourceRefs: [] }, multisitePolicy: { execution: { capabilityIds: ['collaboration.coordinate.v1'], resourceRefs: [] }, delegation: { agentIds: [], capabilityIds: [], resourceRefs: [] } } }]
      return state
    })
    const portServer = createPortServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve))
    const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve))
    const origin = `http://127.0.0.1:${port}`, secretRoot = join(directory, 'secrets')
    await mkdir(secretRoot, { recursive: true, mode: 0o700 }); await writeFile(join(secretRoot, 'key'), 'synthetic-only-provider-key', { mode: 0o600 })
    const config = readRuntimeConfig({ GENEWAY_STATE: join(directory, 'state.json'), GENEWAY_SECRET_ROOT: secretRoot, GENEWAY_MODEL_CREDENTIAL_REF: 'key' }, process.cwd())
    const attachments = createArtifactService({ store, root: join(directory, 'attachments') })
    const gateway = createModelGateway({ store, config, attachments, upstreamBaseUrl })
    service = createWorkService({ store, multisiteOptions: { hosts: [], attachments, requireRemoteNodes: true } })
    const nodes = createNodeService({ store, onRevoke: id => bridge?.revoke(id) })
    bridge = createNodeBridge({ store, nodes, gateway, getMultisite: () => service.multisite, scanIntervalMs: 25 })
    const authPath = join(directory, 'auth.json'); await initializeAuthFile(authPath, { owner: 'synthetic owner password' }, { mode: 'create', allowedMemberIds: ['owner'] })
    server = createGenewayServer({ service, store, attachments, auth: createAuthRuntime({ filePath: authPath }), nodeService: nodes, nodeBridge: bridge, modelGateway: gateway, trustedOrigin: origin, supervisionIdentities })
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); bridge.start()
    process.send({ kind: 'ready', origin, pid: process.pid, stateFile: join(directory, 'state.json') })
  } catch (cause) { process.send({ kind: 'error', code: cause.code ?? 'SUPERVISION_FIXTURE_FAILED', stack: cause.stack }); process.exitCode = 1 }
})
let closing
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  closing ??= (async () => { bridge?.close(); await service?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } })()
  closing.then(() => process.exit(0), cause => { console.error(cause.code ?? cause.message); process.exit(1) })
})
