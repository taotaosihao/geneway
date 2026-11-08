import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { startBridgeService } from '../../../scripts/fixtures/multisite/bridge-service.mjs'
import { seedDelegation, childRequest } from '../../../scripts/fixtures/multisite/delegation.mjs'
import { createRemoteClient } from '../../../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../../../packages/agent-host/journal.mjs'
import { createAgentHost } from '../../../packages/agent-host/host.mjs'
import { createEvidenceCaptures } from '../../../packages/agent-host/evidence-captures.mjs'
import { createSimulatedRuntime } from '../../../scripts/fixtures/multisite/runtime.mjs'
import { binding } from '../../../packages/agent-contracts/index.mjs'

export async function startGroupFixture({ root, workMemberProtocolStatus }) {
  const ids = ['desktop-office', 'desktop-data', 'gateway'], peers = new Map(), owner = { id: 'owner' }
  const nodeFor = id => ({ 'desktop-office': 'pc-b', 'desktop-data': 'pc-a', gateway: 'gateway', coordinator: 'cloud', analysis: 'analysis' })[id]
  const fixture = await startBridgeService({ directory: path.join(root, 'api'), index: await readFile('web/index.html', 'utf8'), workMemberProtocolStatus, seedState(state) { seedDelegation(state); for (const actor of state.employees) { actor.placement.nodeId = nodeFor(actor.id); actor.placement.resourceRefs = actor.id === 'desktop-data' ? ['fixture:history'] : actor.id === 'gateway' ? ['fixture:site'] : [] }; return state } })
  const log = value => appendFile(path.join(root, 'core-http.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n')
  try {
    for (const employeeId of ids) {
      const nodeId = nodeFor(employeeId), directory = path.join(root, employeeId); await mkdir(directory, { recursive: true })
      const pairing = await fixture.nodes.createPairing(owner, { clientRequestId: 'pair-' + nodeId, nodeId, siteId: 'local-fixture', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: [employeeId], expiresAt: new Date(Date.now() + 300000).toISOString() })
      const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity })
      const paired = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem', ...identity }); Object.assign(identity, { nodeId, registrationRevision: paired.node.registrationRevision }); await writeFile(path.join(directory, 'node-identity.json'), JSON.stringify(identity), { mode: 0o600 })
      const resources = []
      if (employeeId !== 'desktop-office') {
        const history = employeeId === 'desktop-data', resourceId = history ? 'fixture:history' : 'fixture:site', cap = history ? 'evidence.history.read.v1' : 'evidence.site.inspect.v1', sourceRoot = path.join(directory, 'source'); await mkdir(sourceRoot)
        const payload = history ? { format: 'geneway.incident-history', version: 1, entries: Array.from({ length: 20 }, (_, index) => ({ date: '2026-11-01', description: '私有历史' + index, owner: '模拟来源' })) } : { sourceTime: null, health: { connection: 'unknown', lastSuccessAt: null, queueDepth: null }, events: Array.from({ length: 20 }, (_, index) => ({ sourceEventId: 'source-event-' + index, sourceTimestamp: null, code: 'ALARM', severity: 'unknown', message: '私有网关事件' + index })) }
        await writeFile(path.join(sourceRoot, 'source.json'), JSON.stringify(payload))
        await fixture.nodes.putResource(owner, resourceId, { clientRequestId: 'resource-' + nodeId, expectedRevision: null, workspaceId: 'local', siteId: 'local-fixture', kind: history ? 'history_directory' : 'site_diagnostics', ownerNodeId: nodeId, capabilityIds: [cap], evidenceReaderAgentIds: ids, enabled: true })
        resources.push({ resourceId, capabilityIds: [cap], adapterKind: history ? 'history_json' : 'site_snapshot_json', root: sourceRoot, datasets: { history: 'source.json' }, fixedFiles: { snapshot: 'source.json' }, allowedSections: ['collector_health', 'recent_events'], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: ids, clockTrust: 'fixture' })
      }
      const journal = createHostJournal(path.join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: path.join(directory, 'sessions.json') }), evidence = createEvidenceCaptures({ journal, root: path.join(directory, 'sealed'), profile: { profileVersion: 1, resources }, client })
      const host = createAgentHost({ nodeId, journal, runtime, evidence })
      host.setOrchestrationHandler({ call: async (execution, operation, parameters) => { try { const result = await client.command(execution, operation, parameters); await log({ employeeId, execution: binding(execution), operation, parameters, status: 200, result }); return result } catch (cause) { await log({ employeeId, execution: binding(execution), operation, parameters, status: cause.status, error: cause.code }); throw cause } }, event: event => client.event(event) })
      peers.set(employeeId, { employeeId, nodeId, identity, client, journal, runtime, host })
    }
    const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
    const api = async (url, body, expected = 200) => { const response = await fetch(fixture.origin + url, { method: body ? 'POST' : 'GET', headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), value = await response.json(); await log({ path: url, body, status: response.status, result: value }); assert.equal(response.status, expected, JSON.stringify(value)); return value }
    const execution = async employeeId => binding((await peers.get(employeeId).journal.read()).executions.findLast(row => row.agent_id === employeeId))
    async function pump() { for (let index = 0; index < 3; index++) for (const peer of peers.values()) { for (const delivery of (await peer.client.resync()).pending) { const command = await peer.client.resolveCommand(delivery); await peer.host.accept({ workspaceId: 'local', nodeId: peer.nodeId }, command); await peer.client.ack(command) }; await peer.host.process(); await peer.host.flushEvents(event => peer.client.event(event)) } }
    const call = async (employeeId, operation, parameters) => peers.get(employeeId).runtime.orchestration(await execution(employeeId), operation, { instructionRevision: 1, ...parameters })
    const workReply = await api('/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: '本工作私有三方群与原企业权限', clientRequestId: 'create' }), workId = workReply.value?.id ?? workReply.id; assert(workId); await pump()
    await call('desktop-office', 'delegate', childRequest('delegate-a', 'desktop-data')); await call('desktop-office', 'delegate', childRequest('delegate-g', 'gateway')); await pump()
    return { ...fixture, peers, workId, api, pump, call, execution, async close() { for (const work of (await fixture.store.read()).works.filter(row => row.workType === 'multisite' && !['completed', 'cancelled'].includes(row.status))) await fixture.service.multisite.apply(owner, 'cancel', { workId: work.id, clientRequestId: 'cleanup-' + work.id }); await pump(); for (const peer of peers.values()) await peer.host.close(); await fixture.close() } }
  } catch (cause) { for (const peer of peers.values()) await peer.host.close(); await fixture.close(); throw cause }
}
