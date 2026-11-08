import assert from 'node:assert/strict'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { AgentCard, A2A_PROTOCOL_VERSION, Role, SendMessageRequest } from '@a2a-js/sdk'
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server'
import { RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors'
import { openWorkGroupJournal } from '../../common/work-group-journal.mjs'
import { workGroupClient } from './work-group-wire.mjs'

export const WORK_GROUP_SCHEMA = 'geneway.a2a-work-group/1'
const now = () => new Date().toISOString()
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const denied = code => Object.assign(new Error('Current Work group operation is unavailable'), { code })
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,512}$/.test(value)
const dataPart = value => ({ content: { $case: 'data', value }, mediaType: 'application/json', filename: '', metadata: {} })

// This is an application group over official A2A Message transport. Its journal
// owns protocol membership/delivery only; it never writes a Work or wakes DSH.
export async function startA2aWorkGroup({ root, work, principals, admin, authorize, resolve, loadFacts, tls, port = 0, openExisting = false, handleHttp, beforeRemove }) {
  assert(root && work?.workspaceId && work.workId && Array.isArray(principals) && principals.length)
  assert([authorize, resolve, loadFacts].every(value => typeof value === 'function'))
  const configured = [...principals.map(row => ({ ...structuredClone(row), role: 'member' })), { ...structuredClone(admin), role: 'admin' }]
  assert(configured.every(row => opaque(row.id) && typeof row.token === 'string' && row.token.length >= 24))
  assert.equal(new Set(configured.map(row => row.id)).size, configured.length)
  assert.equal(new Set(configured.map(row => row.token)).size, configured.length)
  assert.equal(new Set(principals.map(row => row.employeeId)).size, principals.length)
  assert(principals.every(row => row.employeeId && row.binding?.work_id === work.workId && row.binding.agent_id === row.employeeId))
  root = path.resolve(root); await mkdir(root, { recursive: true, mode: 0o700 })
  const descriptors = configured.map(row => ({ id: row.id, role: row.role, employeeId: row.employeeId ?? null, binding: row.binding ?? null }))
  const journal = await openWorkGroupJournal({ file: path.join(root, 'work-group.json'), openExisting, initial: {
    version: 1, candidate: 'a2a', identity: { candidate: 'a2a', groupId: randomUUID(), workspaceId: work.workspaceId, workId: work.workId },
    principals: descriptors.map(row => ({ ...row, contextId: randomUUID() })), created: false, membershipVersion: 0, sequence: 0, members: [], operations: [], events: [], deliveries: [],
  } })
  const initial = await journal.read()
  assert.equal(initial.candidate, 'a2a'); assert.equal(initial.identity.workspaceId, work.workspaceId); assert.equal(initial.identity.workId, work.workId)
  assert.equal(hash(initial.principals.map(({ contextId, ...row }) => row)), hash(descriptors), 'Existing group principals/bindings cannot be replaced')
  const identity = structuredClone(initial.identity), actors = new Map(), clients = new Map()
  for (const config of configured) {
    const descriptor = initial.principals.find(row => row.id === config.id), tokenFile = path.join(root, 'credential-' + hash(config.id))
    try { const file = await open(tokenFile, openExisting ? 'r' : 'wx', 0o600); try { if (!openExisting) { await file.writeFile(config.token); await file.sync() } } finally { await file.close() } } catch (error) { if (error.code !== 'EEXIST') throw error }
    assert.equal((await readFile(tokenFile, 'utf8')).trim(), config.token, 'Existing group credential cannot be replaced')
    actors.set(config.id, { ...config, contextId: descriptor.contextId, tokenFile })
  }
  const principalFor = actor => { const row = actors.get(typeof actor === 'string' ? actor : actor?.id); if (!row || row.role !== 'member') throw denied('FORBIDDEN'); return row }
  const removalKey = row => hash([work.workspaceId, work.workId, row.employeeId, row.commandId])
  async function facts() {
    let value; try { value = await loadFacts() } catch { throw denied('GROUP_STATE_UNKNOWN') }
    if (!value || !Array.isArray(value.removals) || value.removals.some(row => row.workspaceId !== work.workspaceId || row.workId !== work.workId || !row.employeeId || !row.commandId)) throw denied('GROUP_STATE_UNKNOWN')
    return value.removals
  }
  async function allowed(principal, purpose) {
    try { const result = await authorize(structuredClone(principals.find(row => row.id === principal.id)), { purpose }); if (result !== true && result?.allowed !== true) throw denied('FORBIDDEN') }
    catch { throw denied('FORBIDDEN') }
  }
  function hasPending(state, removals) { return !state.created || state.operations.some(op => op.kind === 'remove' && !op.confirmedAt) || removals.some(row => !state.operations.some(op => op.id === removalKey(row) && op.kind === 'remove' && op.sourceDigest === hash(row) && op.confirmedAt)) }
  async function metadata(principal, locator) {
    if (!opaque(locator)) throw new RequestMalformedError('An opaque locator is required')
    let value; try { value = await resolve(structuredClone(principals.find(row => row.id === principal.id)), locator, { metadataOnly: true }) } catch { throw denied('FORBIDDEN') }
    if (!value || value.workId !== work.workId || !value.eventId || !value.messageId || !Array.isArray(value.recipientEmployeeIds) || Object.hasOwn(value, 'text') || Object.hasOwn(value, 'evidenceRefs') || Object.hasOwn(value, 'token') || Object.hasOwn(value, 'url')) throw denied('FORBIDDEN')
    return { eventId: value.eventId, messageId: value.messageId, recipientEmployeeIds: [...new Set(value.recipientEmployeeIds)] }
  }
  async function applyControl(payload, principal) {
    if (principal.role !== 'admin') throw denied('FORBIDDEN')
    const removals = await facts()
    await journal.update(state => {
      const op = state.operations.find(op => op.id === payload.operationId && op.kind === payload.op)
      if (!op || hash(op.body) !== hash(payload)) throw denied('FORBIDDEN')
      if (op.appliedAt) return
      if (op.kind === 'create') state.created = true
      else if (!state.created) throw denied('GROUP_STATE_UNKNOWN')
      else if (op.kind === 'add') {
        if (removals.some(row => row.employeeId === op.employeeId)) throw denied('FORBIDDEN')
        if (!state.members.some(row => row.employeeId === op.employeeId)) state.members.push({ employeeId: op.employeeId, active: true, startSequence: state.sequence + 1, addedBy: op.id, removedBy: null })
      } else if (op.kind === 'remove') {
        if (!removals.some(row => removalKey(row) === op.id && hash(row) === op.sourceDigest)) throw denied('FORBIDDEN')
        const member = state.members.find(row => row.employeeId === op.employeeId)
        if (member) { member.active = false; member.removedBy = op.removalCommandId }
        // Invalidate this application's undelivered opaque queue, without
        // inventing transport ACKs or claiming any past content was recalled.
        for (const delivery of state.deliveries.filter(row => row.employeeId === op.employeeId && !row.transportAckedAt)) { delivery.locatorDisabledAt ??= now(); delivery.revokedBy ??= op.removalCommandId }
      }
      state.membershipVersion++; op.appliedAt = now(); op.appliedVersion = state.membershipVersion
    })
    return [{ ...payload, transportACK: true }]
  }
  async function applyPublish(payload, principal) {
    await allowed(principal, 'publish')
    const source = await metadata(principal, payload.locator), removals = await facts()
    let state = await journal.read()
    if (hasPending(state, removals)) throw denied('MEMBERSHIP_PENDING')
    if (!state.members.some(row => row.employeeId === principal.employeeId && row.active)) throw denied('FORBIDDEN')
    const recipients = []
    for (const target of principals.filter(row => source.recipientEmployeeIds.includes(row.employeeId) && state.members.some(member => member.employeeId === row.employeeId && member.active))) {
      try { await allowed(actors.get(target.id), 'resolve'); recipients.push(target.employeeId) } catch {}
    }
    if (!recipients.length) throw denied('FORBIDDEN')
    await allowed(principal, 'publish')
    const currentRemovals = await facts(), eventId = hash([identity.groupId, source.eventId, source.messageId])
    await journal.update(current => {
      if (hasPending(current, currentRemovals)) throw denied('MEMBERSHIP_PENDING')
      if (!current.members.some(row => row.employeeId === principal.employeeId && row.active)) throw denied('FORBIDDEN')
      const previous = current.events.find(row => row.id === eventId)
      if (previous) { if (previous.locator !== payload.locator) throw denied('IDEMPOTENCY_CONFLICT'); return }
      const sequence = ++current.sequence
      current.events.push({ id: eventId, locator: payload.locator, messageId: source.messageId, eventId: source.eventId, publisherEmployeeId: principal.employeeId, sequence, createdAt: now() })
      for (const employeeId of recipients) if (current.members.some(row => row.employeeId === employeeId && row.active && row.startSequence <= sequence)) current.deliveries.push({ id: hash([eventId, employeeId]), eventId, employeeId, locator: payload.locator, sequence, offeredAt: null, transportAckedAt: null })
    })
    return [{ ...payload, transportACK: true }]
  }
  async function applyReceive(payload, principal) {
    await allowed(principal, 'resolve')
    let deliveries
    await journal.update(state => {
      const member = state.members.find(row => row.employeeId === principal.employeeId && row.active)
      if (!member) throw denied('FORBIDDEN')
      deliveries = state.deliveries.filter(row => row.employeeId === principal.employeeId && !row.transportAckedAt && !row.locatorDisabledAt && row.sequence >= member.startSequence)
      for (const row of deliveries) row.offeredAt ??= now()
    })
    return deliveries.length ? deliveries.map(row => ({ opaqueSchema: WORK_GROUP_SCHEMA, op: 'delivery', groupId: identity.groupId, operationId: row.id, locator: row.locator })) : [{ ...payload, transportACK: true }]
  }
  async function applyAck(payload, principal) {
    // A minimal transport ACK for an already offered opaque delivery grants no
    // current Work/data permission. Body resolution always takes the fresh door.
    await journal.update(state => {
      const delivery = state.deliveries.find(row => row.id === payload.operationId && row.employeeId === principal.employeeId && row.locator === payload.locator && row.offeredAt)
      if (!delivery) throw denied('FORBIDDEN')
      delivery.transportAckedAt ??= now()
    })
    return [{ ...payload, transportACK: true }]
  }
  function validateMessage(message, principal) {
    const payload = message?.parts?.[0]?.content?.$case === 'data' ? message.parts[0].content.value : null
    if (!payload || message.parts.length !== 1 || message.contextId !== principal.contextId || message.taskId || message.role !== Role.ROLE_USER || payload.opaqueSchema !== WORK_GROUP_SCHEMA || payload.groupId !== identity.groupId || !opaque(payload.operationId) || message.messageId !== payload.operationId || Object.keys(payload).some(key => !['opaqueSchema', 'op', 'groupId', 'operationId', 'locator'].includes(key)) || !['create', 'add', 'remove', 'publish', 'receive', 'ack'].includes(payload.op)) throw new RequestMalformedError('Invalid opaque Work group message')
    if (['publish', 'ack'].includes(payload.op) && !opaque(payload.locator)) throw new RequestMalformedError('An opaque locator is required')
    return payload
  }
  function validateRaw(rpc, principal) {
    const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key))
    const empty = value => value === undefined || keys(value, [])
    const params = rpc.params, message = params?.message, part = message?.parts?.[0], config = params?.configuration
    if (!keys(rpc, ['jsonrpc', 'id', 'method', 'params']) || rpc.jsonrpc !== '2.0' || rpc.method !== 'SendMessage' || !(opaque(rpc.id) || Number.isSafeInteger(rpc.id)) || !keys(params, ['message', 'configuration', 'metadata', 'tenant']) || params.tenant && params.tenant !== '' || !empty(params.metadata)
      || !keys(message, ['messageId', 'contextId', 'taskId', 'role', 'parts', 'metadata', 'extensions', 'referenceTaskIds']) || !empty(message.metadata) || message.extensions?.length || message.referenceTaskIds?.length
      || !Array.isArray(message.parts) || message.parts.length !== 1 || !keys(part, ['data', 'metadata', 'filename', 'mediaType']) || !empty(part.metadata) || part.filename && part.filename !== '' || part.mediaType !== 'application/json'
      || config !== undefined && (!keys(config, ['returnImmediately', 'historyLength', 'acceptedOutputModes']) || config.returnImmediately !== undefined && typeof config.returnImmediately !== 'boolean' || config.historyLength !== undefined && (!Number.isSafeInteger(config.historyLength) || config.historyLength < 0) || config.acceptedOutputModes !== undefined && (!Array.isArray(config.acceptedOutputModes) || config.acceptedOutputModes.some(value => value !== 'application/json')))) throw new RequestMalformedError('Only the opaque application Message envelope is accepted')
    validateMessage(SendMessageRequest.fromJSON(params).message, principal)
  }
  let origin, card, closed = false, closing, syncing = Promise.resolve(), wireWrites = Promise.resolve()
  const handler = {
    async getAgentCard() { return card },
    async sendMessage(request, context) {
      try {
        const principal = actors.get(context.user.userName), payload = validateMessage(request.message, principal)
        context.state.set('work-group-payload', structuredClone(payload))
        const values = ['create', 'add', 'remove'].includes(payload.op) ? await applyControl(payload, principal) : principal.role !== 'member' ? (() => { throw denied('FORBIDDEN') })() : payload.op === 'publish' ? await applyPublish(payload, principal) : payload.op === 'receive' ? await applyReceive(payload, principal) : await applyAck(payload, principal)
        return { messageId: payload.operationId, contextId: principal.contextId, taskId: '', role: Role.ROLE_AGENT, parts: values.map(dataPart), metadata: {}, extensions: [], referenceTaskIds: [] }
      } catch (error) {
        context.state.set('work-group-denial', ['FORBIDDEN', 'MEMBERSHIP_PENDING', 'IDEMPOTENCY_CONFLICT'].includes(error.code) ? error.code : 'GROUP_UNAVAILABLE')
        throw new UnsupportedOperationError('Current Work group operation is unavailable')
      }
    },
  }
  for (const method of ['sendMessageStream', 'getTask', 'cancelTask', 'listTasks', 'resubscribeTask', 'getAuthenticatedExtendedAgentCard', 'createTaskPushNotificationConfig', 'getTaskPushNotificationConfig', 'listTaskPushNotificationConfigs', 'deleteTaskPushNotificationConfig']) handler[method] = async () => { throw new UnsupportedOperationError('This application-group endpoint only supports Message') }
  const transport = new JsonRpcTransportHandler(handler)
  const listener = async (request, response) => {
    try {
      if (handleHttp && await handleHttp(request, response)) return
      const url = new URL(request.url, origin)
      if (request.method === 'GET' && url.pathname === '/.well-known/agent-card.json') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(AgentCard.toJSON(card))); return }
      if (request.method !== 'POST' || url.pathname !== '/a2a' || url.search) { response.writeHead(404).end(); return }
      const candidate = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1]
      const principal = candidate && [...actors.values()].find(row => { const a = Buffer.from(candidate), b = Buffer.from(row.token); return a.length === b.length && timingSafeEqual(a, b) })
      if (!principal) { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED' } })); return }
      let bytes = 0; const chunks = []
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 32768) throw new RequestMalformedError('Work group message exceeds its wire limit'); chunks.push(chunk) }
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')), version = request.headers['a2a-version']
      if (rpc.method !== 'SendMessage') throw new UnsupportedOperationError('This application-group endpoint only supports Message')
      validateRaw(rpc, principal)
      validateVersion(version, card, 'JSONRPC')
      const context = new ServerCallContext({ requestedVersion: version, user: { isAuthenticated: true, userName: principal.id } })
      const result = await transport.handle(rpc, context), encoded = JSON.stringify(result)
      const denial = context.state.get('work-group-denial'), status = denial ? denial === 'GROUP_UNAVAILABLE' ? 503 : 403 : 200
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(encoded)
      // No headers or arbitrary incoming params are retained. Actual legitimate
      // Message payloads contain only the bounded opaque application envelope.
      wireWrites = wireWrites.then(() => appendFile(path.join(root, 'wire.jsonl'), JSON.stringify({ at: now(), actorId: principal.id, version, method: rpc.method, requestBytes: bytes, responseBytes: Buffer.byteLength(encoded), request: rpc, requestPayload: context.state.get('work-group-payload') ?? null, status, denial: denial ?? null, response: result }) + '\n', { mode: 0o600 })); void wireWrites.catch(() => {})
    } catch (error) {
      if (!response.headersSent) { const status = ['FORBIDDEN', 'MEMBERSHIP_PENDING', 'IDEMPOTENCY_CONFLICT'].includes(error.code) ? 403 : 503; response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: status === 403 ? error.code : 'GROUP_UNAVAILABLE' } })) } else response.destroy()
    }
  }
  const server = tls ? httpsServer({ key: await readFile(tls.keyFile), cert: await readFile(tls.certFile) }, listener) : httpServer(listener)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  origin = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`
  card = { name: 'Geneway experimental application Work group', description: 'Opaque locator fanout implemented by Geneway over A2A Message; not a protocol-native group', version: '1.0.0', supportedInterfaces: [{ url: origin + '/a2a', protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }], capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] }, defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], securitySchemes: { bearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { scheme: 'Bearer', bearerFormat: 'opaque', description: 'Per-principal managed identity' } } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }], skills: [{ id: 'opaque-work-group', name: 'Application Work group', description: 'Deliver opaque locators without data access or model wake authority', tags: ['experimental'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'], securityRequirements: [] }], signatures: [], documentationUrl: '' }
  async function call(principal, payload) {
    if (closed) throw denied('GROUP_STATE_UNKNOWN')
    if (!clients.has(principal.id)) clients.set(principal.id, await workGroupClient({ card, token: principal.token, caFile: tls?.caFile }))
    const result = await clients.get(principal.id).sendMessage({ message: { messageId: payload.operationId, contextId: principal.contextId, taskId: '', role: Role.ROLE_USER, parts: [dataPart(payload)], metadata: {}, extensions: [], referenceTaskIds: [] } }, { signal: AbortSignal.timeout(10000) })
    if (!result.messageId || !Array.isArray(result.parts)) throw denied('GROUP_STATE_UNKNOWN')
    return result.parts.map(part => part.content?.$case === 'data' ? part.content.value : null).filter(Boolean)
  }
  const body = (op, operationId, locator) => ({ opaqueSchema: WORK_GROUP_SCHEMA, op, groupId: identity.groupId, operationId, ...(locator ? { locator } : {}) })
  async function control(kind, id, details = {}) {
    await journal.update(state => { const old = state.operations.find(row => row.id === id); if (!old) state.operations.push({ id, kind, ...details, body: body(kind, id), createdAt: now(), appliedAt: null, confirmedAt: null }); else if (old.kind !== kind || details.sourceDigest && old.sourceDigest !== details.sourceDigest) throw denied('IDEMPOTENCY_CONFLICT') })
    const current = (await journal.read()).operations.find(row => row.id === id)
    if (current.confirmedAt) return
    // The test owner can hold the real outbound remove after durable intent,
    // without fabricating a receiver receipt or changing the wire contract.
    if (kind === 'remove' && beforeRemove) await beforeRemove({ operationId: id, employeeId: current.employeeId, removalCommandId: current.removalCommandId })
    const replies = await call(actors.get(admin.id), current.body)
    if (!replies.some(reply => reply.operationId === id && reply.op === kind && reply.transportACK === true)) throw denied('GROUP_STATE_UNKNOWN')
    await journal.update(state => { const op = state.operations.find(row => row.id === id); if (!op.appliedAt) throw denied('GROUP_STATE_UNKNOWN'); op.confirmedAt ??= now() })
  }
  function sync(removals) {
    const run = syncing.catch(() => {}).then(async () => {
      const current = await facts()
      if (removals && (!Array.isArray(removals) || removals.some(row => !current.some(actual => hash(actual) === hash(row))))) throw denied('FORBIDDEN')
      await control('create', hash(['create', work]))
      for (const principal of principals) if (!current.some(row => row.employeeId === principal.employeeId)) { await allowed(actors.get(principal.id), 'resolve'); await control('add', hash(['add', work, principal.employeeId]), { employeeId: principal.employeeId }) }
      for (const row of await facts()) await control('remove', removalKey(row), { employeeId: row.employeeId, removalCommandId: row.commandId, sourceDigest: hash(row) })
      return snapshot()
    }); syncing = run; return run
  }
  async function publish(actor, locator) {
    const principal = principalFor(actor)
    return call(principal, body('publish', hash(['publish', identity.groupId, principal.id, locator]), locator))
  }
  async function receive(actor) {
    const principal = principalFor(actor), replies = await call(principal, body('receive', randomUUID())), deliveries = replies.filter(row => row.op === 'delivery')
    for (const delivery of deliveries) await call(principal, body('ack', delivery.operationId, delivery.locator))
    return { groupId: identity.groupId, deliveries }
  }
  async function resolveBody(actor, locator) {
    const principal = principalFor(actor); await allowed(principal, 'resolve')
    const state = await journal.read(), member = state.members.find(row => row.employeeId === principal.employeeId && row.active)
    if (!member || !state.deliveries.some(row => row.employeeId === principal.employeeId && row.locator === locator && row.sequence >= member.startSequence && row.transportAckedAt)) throw denied('FORBIDDEN')
    return resolve(structuredClone(principals.find(row => row.id === principal.id)), locator, { metadataOnly: false })
  }
  async function memberStatus(employeeId, removal) {
    try {
      const current = await facts(), state = await journal.read()
      if (removal) {
        if (removal.workspaceId !== work.workspaceId || removal.workId !== work.workId || removal.employeeId !== employeeId || !current.some(row => hash(row) === hash(removal))) return 'unknown'
        const op = state.operations.find(row => row.id === removalKey(removal) && row.kind === 'remove' && row.employeeId === employeeId && row.removalCommandId === removal.commandId && row.sourceDigest === hash(removal))
        return op?.confirmedAt && !state.members.some(row => row.employeeId === employeeId && row.active) && state.deliveries.filter(row => row.employeeId === employeeId).every(row => row.transportAckedAt || row.revokedBy === removal.commandId) ? 'confirmed' : 'pending'
      }
      if (current.some(row => row.employeeId === employeeId)) return 'unknown'
      if (!principals.some(row => row.employeeId === employeeId)) return 'unknown'
      const member = state.members.find(row => row.employeeId === employeeId && row.active), add = state.operations.find(row => row.id === member?.addedBy && row.kind === 'add')
      return state.created && member && add?.confirmedAt ? 'confirmed' : 'pending'
    } catch { return 'unknown' }
  }
  async function snapshot() { const state = await journal.read(); const current = await facts(); return { ...state, origin, pending: hasPending(state, current), applicationGroup: true, nativeProtocolGroup: false } }
  const actorConfigs = Object.fromEntries([...actors.values()].map(row => [row.id, { origin, tokenFile: row.tokenFile, contextId: row.contextId, employeeId: row.employeeId ?? null, role: row.role }]))
  return { origin, identity, actorConfigs, publish, sync, receive, resolveBody, snapshot, memberStatus,
    close() { return closing ??= (async () => { closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await syncing.catch(() => {}); await wireWrites })() },
  }
}
