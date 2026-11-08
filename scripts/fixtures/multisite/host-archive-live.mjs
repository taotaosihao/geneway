import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridgeService } from './bridge-service.mjs'
import { seedDelegation } from './delegation.mjs'
import { processIdentity, signalOwned } from './supervision-process-lifecycle.mjs'
import { HOST_ARCHIVE_LIMITS } from '../../../packages/agent-host/journal-archive.mjs'
import { binding, key, seal } from '../../../packages/agent-contracts/index.mjs'
import { BRIDGE_LIMIT, commandReference, jsonBytes } from '../../../packages/agent-contracts/command-bytes.mjs'
import { messageId } from '../../../packages/agent-host/delivery.mjs'

const rowId = (kind, row) => kind === 'inbox' ? row.command.command_id : row.event.event_id
const pause = () => new Promise(resolve => setTimeout(resolve, 1000))
export async function runArchiveLive({ directory, save }) {
  const root = join(directory, 'remote'), nodeId = 'archive-node', events = [], children = [], traffic = [], pendingWrites = [], streams = new Set()
  let fixture, proxy, active, session, requestNumber = 0, generation = 0
  const local = () => readFile(join(root, 'host-journal.json'), 'utf8').then(JSON.parse)
  const cloud = () => fixture.store.read()
  const stage = async name => { await save('processes.json', events); console.log(JSON.stringify({ stage: name, directory, pid: process.pid, root, hostPid: active?.child.pid, api: fixture?.origin, transport: 'Node HTTP internal', runtime: 'HostSim' })) }
  async function until(predicate, label) {
    let deadline = Date.now() + 120000, previous
    for (;;) {
      const value = await predicate(); if (value) return value
      const journal = await local().catch(cause => { if (cause.code === 'ENOENT') return null; throw cause })
      const progress = journal ? JSON.stringify([journal.inbox.length, journal.outbox.filter(row => row.acknowledged).length, journal.executions.map(row => [row.status, row.observed_revision])]) : ''
      if (progress !== previous) { previous = progress; deadline = Date.now() + 120000 }
      assert(Date.now() < deadline, label + ' stalled without observed Journal progress'); await pause()
    }
  }
  async function user(path, body) {
    const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  async function control(item, operation, parameters = {}) {
    const requestId = String(++requestNumber)
    item.child.send({ kind: 'control', requestId, operation, parameters })
    const result = await until(() => { assert(item.child.exitCode === null && item.child.signalCode === null, 'Host exited during control'); return item.messages.find(row => row.kind === 'control-result' && row.requestId === requestId) }, operation)
    if (result.error) throw Object.assign(Error(result.error.message), result.error)
    return result.value
  }
  async function launch() {
    const child = fork(fileURLToPath(new URL('./host-archive-host.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, HOME: root } })
    const item = { child, name: 'host-' + (++generation), messages: [] }
    item.exited = new Promise(resolve => child.once('exit', (code, signal) => { events.push({ kind: 'exit', pid: child.pid, code, signal, at: new Date().toISOString() }); resolve({ code, signal }) }))
    item.closed = new Promise(resolve => child.once('close', resolve)); children.push(item)
    child.on('message', value => item.messages.push(value))
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => pendingWrites.push(appendFile(join(directory, item.name + '.' + stream + '.log'), bytes)))
    item.identity = await processIdentity(child.pid); assert(item.identity)
    events.push({ kind: 'start', ...item.identity, argv: (await readFile('/proc/' + child.pid + '/cmdline', 'utf8')).split('\0').filter(Boolean), at: new Date().toISOString() })
    child.send({ kind: 'start', profile: join(root, 'profile.json') })
    await until(() => { const failure = item.messages.find(row => row.kind === 'start-error'); assert(!failure, JSON.stringify(failure)); assert(child.exitCode === null && child.signalCode === null); return item.messages.find(row => row.kind === 'ready') }, 'real remote Host ready')
    active = item; await stage('host-ready-' + generation); return item
  }
  async function closeHost(item) {
    if (!item || item.child.exitCode !== null || item.child.signalCode !== null) return
    await save(item.name + '-io.json', await control(item, 'metrics'))
    await save(item.name + '-runtime.json', await control(item, 'facts'))
    await signalOwned(item, 'SIGTERM', events)
    let timeout
    try { await Promise.race([item.exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Owned Host TERM grace expired')), 15000) })]) }
    catch (cause) { await signalOwned(item, 'SIGKILL', events); events.push({ kind: 'fallback', reason: cause.message, pid: item.child.pid }); await item.exited }
    finally { clearTimeout(timeout) }
    await item.closed
    const current = await processIdentity(item.child.pid); assert(!current || current.startTicks !== item.identity.startTicks)
    events.push({ kind: 'os-final', ...item.identity, gone: true }); if (active === item) active = undefined
  }
  async function consumed(work) {
    const state = await cloud(), inputs = state.multisite.inputs.filter(row => row.workId === work.id)
    return inputs.length > 0 && inputs.every(row => row.deliveries.length > 0 && row.deliveries.every(delivery => delivery.ingestedAt)) && state.multisite.outbox.filter(row => row.command.work_id === work.id).every(row => row.acceptedAt)
  }
  async function stop(work, label) {
    await user('/api/works/' + work.id + '/multisite/cancel', { clientRequestId: label })
    await until(async () => {
      const state = await cloud(), journal = await local()
      const execution = journal.executions.find(row => row.work_id === work.id)
      return state.works.find(row => row.id === work.id).status === 'cancelled' && execution?.status === 'stopped' && execution.slotHeld === false && journal.outbox.filter(row => row.event.launch_id === execution.launch_id).every(row => row.acknowledged) && journal.outbox.some(row => row.event.launch_id === execution.launch_id && row.event.kind === 'stopped' && row.acknowledged)
    }, 'real cancel and terminal proof exact ACK')
  }
  const original = { inbox: new Map(), outbox: new Map() }
  function remember(state) { for (const kind of ['inbox', 'outbox']) for (const row of state[kind]) original[kind].set(rowId(kind, row), structuredClone(row)) }
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    fixture = await startBridgeService({ directory: join(directory, 'api'), seedState(state) {
      seedDelegation(state)
      for (const employee of state.employees) { employee.placement = { nodeId, mode: 'agent_host', resourceRefs: [] }; employee.multisitePolicy.execution.resourceRefs = []; employee.multisitePolicy.delegation.resourceRefs = [] }
      return state
    } })
    proxy = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const path = request.url
      const upstream = httpRequest(new URL(path, fixture.origin), { method: request.method, headers: { ...request.headers, host: new URL(fixture.origin).host } }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers)
        if (request.method === 'GET' && path === '/internal/bridge/events') {
          traffic.push({ path, method: request.method, status: incoming.statusCode, stage: 'subscribe', at: new Date().toISOString() }); streams.add(response); response.flushHeaders(); incoming.pipe(response)
        } else {
          const received = []; incoming.on('data', chunk => received.push(chunk)); incoming.once('end', () => {
            const bytes = Buffer.concat(received), row = { path, method: request.method, status: incoming.statusCode, bytes: bytes.length, at: new Date().toISOString() }
            if (path === '/internal/bridge/resync') row.reply = JSON.parse(bytes)
            traffic.push(row); response.end(bytes)
          })
        }
        response.once('close', () => { streams.delete(response); incoming.destroy(); upstream.destroy() })
      })
      upstream.once('error', cause => { traffic.push({ path, code: cause.code }); response.destroy() }); response.once('close', () => upstream.destroy()); upstream.end(Buffer.concat(chunks))
    })
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    await save('ports.json', { api: Number(new URL(fixture.origin).port), proxy: proxy.address().port })
    const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
    assert.equal(login.status, 200); session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
    const pairing = await user('/api/admin/nodes/pairings', { clientRequestId: 'archive-pair', nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-office'], expiresAt: new Date(Date.now() + 120000).toISOString() })
    await writeFile(join(root, 'profile.json'), JSON.stringify({ root, origin: 'http://127.0.0.1:' + proxy.address().port, pairing, maxActiveLoops: 1, officeEnabled: false, transport: 'internal' }), { mode: 0o600 })
    await stage('api-ready'); await launch()
    const identity = JSON.parse(await readFile(join(root, 'node-identity.json'), 'utf8'))
    const works = []; let sawActiveAtCut = false, lastManifest = 0
    for (let workIndex = 0; workIndex < 3; workIndex++) {
      await control(active, 'phase', { phase: 'work-' + workIndex + '-launch' })
      const work = await user('/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: '档'.repeat(16000), attachmentRefs: [], clientRequestId: 'archive-work-' + workIndex }); works.push(work)
      await until(() => consumed(work), 'launch consumed/ACKed')
      for (let batch = 0; batch < 4; batch++) {
        await control(active, 'phase', { phase: 'work-' + workIndex + '-batch-' + batch })
        const before = await local(); remember(before)
        for (let offset = 0; offset < 8; offset++) await user('/api/works/' + work.id + '/multisite/inputs', { clientRequestId: 'archive-input-' + workIndex + '-' + (batch * 8 + offset), text: '归'.repeat(16000) })
        await until(() => consumed(work), 'bounded batch actual consumed and ACKed')
        const after = await local(); remember(after)
        const segments = after.archive?.segments.length ?? 0
        if (segments > lastManifest) {
          assert(workIndex >= 2, 'Expected original closed cohorts before first cut')
          const execution = after.executions.find(row => row.work_id === work.id)
          assert.equal(execution.status, 'running'); assert.equal(execution.slotHeld, true)
          const cold = []
          for (const ref of after.archive.segments) cold.push(...(await readFile(join(root, 'journal-archive', ref.id + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse))
          assert(cold.every(record => (record.row.command ?? record.row.event).work_id !== work.id))
          for (const record of cold) {
            assert.deepEqual(record.row, original[record.kind].get(rowId(record.kind, record.row)))
            assert.deepEqual(record.row, before[record.kind][record.position])
          }
          await save('first-real-cut.json', { before, after, metadata: await control(active, 'facts'), activeWork: work.id, coldRows: cold, scope: 'actual legal Work/ACK/HostSim; current active cohort kept hot' })
          sawActiveAtCut = true; lastManifest = segments
        }
        await stage('batch-' + workIndex + '-' + batch)
      }
      await control(active, 'phase', { phase: 'work-' + workIndex + '-stop' }); await stop(work, 'archive-stop-' + workIndex)
      const closed = await local(); remember(closed); await save('closed-work-' + workIndex + '.json', closed)
    }
    assert(sawActiveAtCut, 'Real legal batches must reach production archive trigger')
    const journalBeforeReopen = await local(), refs = journalBeforeReopen.archive.segments
    const record = JSON.parse((await readFile(join(root, 'journal-archive', refs[0].id + '.jsonl'), 'utf8')).split('\n')[0]), command = record.row.command
    assert(command)
    await closeHost(active); await launch()
    assert.deepEqual(JSON.parse(await readFile(join(root, 'node-identity.json'), 'utf8')), identity)
    await control(active, 'phase', { phase: 'real-warm-journal-read' })
    await control(active, 'read')
    await control(active, 'phase', { phase: 'real-cold-hit-lookup' })
    const beforeReplay = await local(), runtimeBefore = await control(active, 'facts')
    assert.deepEqual(await control(active, 'lookup', { kind: 'inbox', id: command.command_id }), record.row)
    await control(active, 'phase', { phase: 'real-cold-old-command-accept-replay' })
    const ack = await control(active, 'accept', { command }); assert.deepEqual(binding(ack), binding(command))
    const { payload_digest, ...body } = command
    await assert.rejects(control(active, 'accept', { command: seal({ ...body, parameters: { ...body.parameters, text: '同ID异文组件入口负控' } }) }), { code: 'IDEMPOTENCY_CONFLICT' })
    assert.deepEqual(await local(), beforeReplay)
    const runtimeAfter = await control(active, 'facts'); assert.deepEqual(runtimeAfter.runtime, runtimeBefore.runtime)
    await save('real-cold-replay.json', { command, originalRow: record.row, ack, runtimeBefore, runtimeAfter, scope: 'same-root new PID production accept entry only; terminal cloud rows already ACKed, no fake cloud pending or execution' })
    await closeHost(active)

    // Tight inline envelopes leave too little room for all command references,
    // exercising real resync pages without hitting pending admission pressure.
    const offline = await user('/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: '页'.repeat(14000), attachmentRefs: [], clientRequestId: 'archive-offline-work' })
    const state = await cloud(), first = state.multisite.outbox.find(row => row.command.work_id === offline.id).command
    const node = state.nodes.find(row => row.id === nodeId)
    const bindings = state.multisite.attempts.filter(row => row.node_id === nodeId).map(row => ({ ...binding(row), status: row.status, instructionRevision: row.instruction_revision }))
    const base = { nodeId, nodeInstanceId: node.nodeInstanceId, status: node.status, bindings, pending: [], unavailable: [], hasMoreBindings: false, hasMorePending: false, hasMoreUnavailable: false }
    const targetBytes = Math.floor((BRIDGE_LIMIT - 128 - jsonBytes(base) - jsonBytes(first) - 2) / 2) - 16
    let template = first
    for (let index = 0; index < 64; index++) {
      const fixed = jsonBytes(template) - Buffer.byteLength(template.parameters.text)
      const textLength = Math.floor((targetBytes - fixed) / 3)
      assert(textLength > 0 && textLength <= 16000)
      const clientRequestId = 'archive-offline-input-' + index
      await user('/api/works/' + offline.id + '/multisite/inputs', { clientRequestId, text: '续'.repeat(textLength) })
      const current = await cloud(), inputId = key('input', offline.id, 'owner', clientRequestId)
      template = current.multisite.outbox.find(row => row.command.work_id === offline.id && row.command.input_id === inputId).command
    }
    const queued = (await cloud()).multisite.outbox.filter(row => row.command.work_id === offline.id)
    assert(queued.every(row => !row.acceptedAt)); assert(queued.length < 256)
    const shadow = { ...base, pending: [] }
    for (const row of queued) {
      shadow.pending.push(row.command)
      if (jsonBytes(shadow) > BRIDGE_LIMIT - 128) {
        shadow.pending.pop(); shadow.pending.push(commandReference(row.command))
        if (jsonBytes(shadow) > BRIDGE_LIMIT - 128) { shadow.pending.pop(); shadow.hasMorePending = true; break }
      }
    }
    assert(shadow.hasMorePending, 'Actual command bytes must predict genuine production pagination')
    await save('offline-legitimate-pending.json', { work: offline.id, queued, targetBytes, shadow, totalCommandBytes: queued.reduce((sum, row) => sum + jsonBytes(row.command), 0), scope: 'normal API writes while own Host closed; no command/store edits' })
    const trafficStart = traffic.length; await launch(); await until(() => consumed(offline), 'all legitimate offline Input messages consumed and ACKed')
    await until(() => traffic.slice(trafficStart).filter(row => row.path === '/internal/bridge/resync' && row.reply?.pending.length).length >= 2 && traffic.slice(trafficStart).some(row => row.stage === 'subscribe'), 'actual two nonempty resync pages followed by SSE subscribe')
    const pages = traffic.slice(trafficStart).filter(row => row.path === '/internal/bridge/resync' && row.reply)
    assert(pages.some(row => row.reply.hasMorePending))
    const sessions = JSON.parse(await readFile(join(root, 'archive-sim-sessions.json'), 'utf8')), last = queued.at(-1).command
    const expected = messageId(last.input_id, last.attempt_id, last.session_id ?? 'geneway-' + last.launch_id)
    assert.equal(Object.values(sessions).flatMap(row => row.events).filter(row => row.type === 'user/message' && row.data.id === expected).length, 1)
    await save('offline-real-pages-and-consume.json', { pages, latestCommand: last, expectedInputMessageId: expected, sessions, scope: 'actual Node HTTP resync pagination + subscribe and HostSim user/message once; no model/native claim' })
    await stop(offline, 'archive-offline-final-stop')
    await save('terminal-host.json', await local()); await save('terminal-cloud.json', await cloud())
    assert.equal((await cloud()).modelRequests.length, 0)
    await save('result.json', { result: 'passed', scope: 'single real API/Node HTTP/HostSim; production thresholds unchanged', works: works.map(work => work.id), offlineWork: offline.id, sameIdentityColdReplay: true, realActiveCohortHot: true, actualTwoResyncPages: true, latestInputConsumedOnce: true, limits: HOST_ARCHIVE_LIMITS })
  } finally {
    const errors = []
    for (const child of children) try { await closeHost(child) } catch (cause) { errors.push({ pid: child.child.pid, message: cause.message }); const current = await processIdentity(child.identity.pid); if (current?.startTicks === child.identity.startTicks) { await signalOwned(child, 'SIGKILL', events); await child.exited; await child.closed } }
    for (const stream of streams) stream.destroy()
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) }
    await fixture?.close(); await Promise.all(pendingWrites)
    await save('processes.json', events); await save('http-wire.json', traffic)
    const ports = JSON.parse(await readFile(join(directory, 'ports.json'), 'utf8').catch(() => '{}')), portFinal = []
    for (const [name, port] of Object.entries(ports)) {
      const listening = await new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false)) })
      portFinal.push({ name, port, listening }); assert.equal(listening, false)
    }
    await save('cleanup.json', { errors, ports: portFinal, children: await Promise.all(children.map(async item => ({ ...item.identity, current: await processIdentity(item.identity.pid) }))) })
    assert.equal(errors.length, 0)
  }
}
