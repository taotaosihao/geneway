import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createWorkGroupDomain } from './work-group-domain.mjs'

const config = JSON.parse(await readFile(process.argv[process.argv.indexOf('--config') + 1], 'utf8'))
let group, home, timer, scanning, scanPaused = false, closing = false, removeBlocked = false, removeRelease, removeSeen
let removeObserved = new Promise(resolve => removeSeen = resolve)
const domain = await createWorkGroupDomain({ root: path.join(config.root, 'domain'), stateFile: config.stateFile, work: config.work, actors: config.actors, openExisting: config.openExisting })
const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
const log = value => appendFile(path.join(config.root, 'managed-wire.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n')
const actors = config.actors
async function readBody(request) { let bytes = 0; const chunks = []; for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 32768); chunks.push(chunk) }; return JSON.parse(Buffer.concat(chunks)) }
async function handleHttp(request, response) {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/status' && request.method === 'GET') {
    if (request.headers['x-work-group-status'] !== config.statusCredential) { json(response, 401, { error: { code: 'UNAUTHORIZED' } }); return true }
    const employeeId = url.searchParams.get('employeeId'), state = await domain.readState(), removal = state.workMemberRemovals.find(row => row.workId === config.work.workId && row.employeeId === employeeId)
    const configured = actors.some(row => row.employeeId === employeeId)
    json(response, 200, { ...config.work, employeeId, configured, removalCommandId: removal?.commandId ?? null, ...(configured ? { status: group ? await group.memberStatus(employeeId, removal) : 'unknown' } : {}) }); return true
  }
  if (!url.pathname.startsWith('/managed/')) return false
  let value, actor
  try {
    assert.equal(request.method, 'POST'); assert(!url.search)
    value = await readBody(request)
    assert(value && Object.keys(value).every(key => ['binding', 'locator', 'messageId'].includes(key)))
    actor = domain.requestActor(request.headers, value.binding)
    let result
    if (url.pathname === '/managed/register') result = await domain.register(actor, value.messageId)
    else if (url.pathname === '/managed/body') result = await domain.resolveRequest(request.headers, value.binding, value.locator)
    else if (url.pathname === '/managed/publish') {
      await domain.authorize(actor)
      result = config.candidate === 'anp' ? await group.publish({ employeeId: actor.employeeId, locator: value.locator, eventId: value.locator }) : await group.publish(actor.employeeId, value.locator)
    } else if (url.pathname === '/managed/receive') {
      await domain.authorize(actor)
      result = config.candidate === 'a2a' ? await group.receive(actor.employeeId) : home.received.filter(row => row.rpc.method === 'group.incoming' && row.rpc.params.meta.target.did === home.identities.get(actor.employeeId).didDocument.id).map(row => ({ locator: row.rpc.params.body.payload.locator, operationId: row.rpc.params.meta.operation_id }))
    } else throw Object.assign(Error('Unknown managed operation'), { code: 'NOT_FOUND' })
    json(response, 200, result); await log({ path: url.pathname, employeeId: actor.employeeId, request: value, status: 200, result })
  } catch (cause) {
    const code = cause.code ?? 'INVALID_REQUEST', status = ['NOT_FOUND'].includes(code) ? 404 : 403
    json(response, status, { error: { code } }); await log({ path: url.pathname, employeeId: actor?.employeeId ?? null, request: value, status, error: code })
  }
  return true
}
async function beforeRemove(value) {
  if (!removeBlocked) return
  await appendFile(path.join(config.root, 'remove-barriers.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n')
  removeSeen(value); await new Promise(resolve => removeRelease = resolve)
}
async function scan() {
  if (closing || scanPaused || scanning) return
  scanning = (async () => {
    const state = await domain.readState(), removals = state.workMemberRemovals.filter(row => row.workId === config.work.workId && actors.some(actor => actor.employeeId === row.employeeId))
    if (removals.length && !(await Promise.all(removals.map(row => group.memberStatus(row.employeeId, row)))).every(status => status === 'confirmed')) await group.sync(removals)
  })().catch(cause => appendFile(path.join(config.root, 'scan-errors.jsonl'), JSON.stringify({ at: new Date().toISOString(), code: cause.code, message: cause.message }) + '\n')).finally(() => scanning = undefined)
}
async function close() { if (closing) return; closing = true; clearInterval(timer); removeRelease?.(); if (group) await group.close(); await home?.close() }
try {
  await mkdir(config.root, { recursive: true })
  if (config.candidate === 'anp') {
    const { startAnpHome } = await import('../adapters/anp/home.mjs'), { startAnpWorkGroup } = await import('../adapters/anp/work-group.mjs')
    home = await startAnpHome({ root: path.join(config.root, 'home'), didDomain: config.homeDomain, port: config.port, openExisting: config.openExisting, resolverBaseUrls: { [config.peer.didDomain]: config.peer.origin }, admitIncoming: async record => {
      if (record.rpc.method !== 'group.incoming') return true
      let protocolGroup
      try { protocolGroup = JSON.parse(await readFile(path.join(config.root, 'group/anp-work-group.json'))) } catch (cause) { if (cause.code === 'ENOENT') return true; throw cause }
      if (record.rpc.params.body.group_did !== protocolGroup.groupDid) return true
      const payload = record.rpc.params.body.payload
      if (!payload || Object.keys(payload).sort().join(',') !== 'locator,schema' || payload.schema !== 'geneway.work-group-event/1') return false
      const event = (await domain.snapshot()).events.find(row => row.locator === payload.locator)
      const sender = protocolGroup.members.find(row => row.employeeId === event?.senderEmployeeId)
      return !!event && record.rpc.params.meta.sender_did === sender?.protocol.did
    } })
    home.handleHttp(handleHttp)
    const principals = actors.map(actor => ({ employeeId: actor.employeeId, binding: actor.binding, protocol: { did: home.identities.get(actor.employeeId).didDocument.id, homeActor: actor.employeeId } }))
    group = await startAnpWorkGroup({ root: path.join(config.root, 'group'), work: config.work, actors: principals, home, peer: { origin: config.peer.origin, identity: config.peer.identity }, readState: domain.readState, authorize: domain.authorize, calibrate: value => domain.calibrate({ ...value, home }) })
    await group.bootstrap()
    const snapshot = await group.snapshot()
    const identity = { candidate: 'anp', origin: home.origin, serviceDid: home.serviceDid, groupDid: snapshot.journal.groupDid, principals }
    process.send({ kind: 'ready', candidate: config.candidate, pid: process.pid, origin: home.origin, identity, info: identity })
  } else {
    const { startA2aWorkGroup } = await import('../adapters/a2a/work-group.mjs')
    try { removeBlocked = JSON.parse(await readFile(path.join(config.root, 'test-remove-gate.json'))).blocked } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    group = await startA2aWorkGroup({ root: path.join(config.root, 'group'), work: config.work, principals: actors.map(actor => ({ id: actor.employeeId, token: actor.protocolToken, employeeId: actor.employeeId, binding: actor.binding })), admin: config.groupAdmin, port: config.port, openExisting: config.openExisting, authorize: async actor => ({ allowed: await domain.authorize(actor) }), resolve: domain.resolve, loadFacts: async () => ({ removals: (await domain.readState()).workMemberRemovals.filter(row => row.workId === config.work.workId) }), handleHttp, beforeRemove })
    if (!config.openExisting) await group.sync()
    process.send({ kind: 'ready', candidate: config.candidate, pid: process.pid, origin: group.origin, identity: group.identity, info: { identity: group.identity, actorConfigs: group.actorConfigs } })
  }
  timer = setInterval(() => { void scan() }, 250); timer.unref(); void scan()
  process.on('message', async value => {
    if (value.kind !== 'control') return
    try {
      let result
      if (value.operation === 'pause-scan') { scanPaused = value.parameters.value; result = { scanPaused } }
      else if (value.operation === 'block-remove') {
        if (config.candidate === 'anp') await group.setRemoveBlocked(value.parameters.value)
        else { removeBlocked = value.parameters.value; await writeFile(path.join(config.root, 'test-remove-gate.json'), JSON.stringify({ blocked: removeBlocked })); if (!removeBlocked) removeRelease?.(); else removeObserved = new Promise(resolve => removeSeen = resolve) }
        result = { blocked: value.parameters.value }
      } else if (value.operation === 'wait-remove-blocked') result = config.candidate === 'anp' ? await group.waitRemoveBlocked() : await removeObserved
      else if (value.operation === 'snapshot') result = { group: await group.snapshot(), domain: await domain.snapshot(), ...(home ? { incoming: home.received } : {}) }
      else if (value.operation === 'sync') { void scan(); result = { requested: true } }
      else if (value.operation === 'raw-send' && config.candidate === 'anp') { const state = await group.snapshot(); result = await home.rpc(value.parameters.employeeId, config.peer.origin, 'group.send', { kind: 'group', did: state.journal.groupDid }, { payload: { schema: 'geneway.work-group-event/1', locator: value.parameters.locator } }) }
      else throw Error('Unsupported control operation')
      process.send({ kind: 'control-result', requestId: value.requestId, value: result })
    } catch (cause) { process.send({ kind: 'control-result', requestId: value.requestId, error: { code: cause.code, message: cause.message } }) }
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { close().then(() => process.exit(0), () => process.exit(1)) })
} catch (cause) { process.send?.({ kind: 'startup-error', message: cause.message }); await close(); process.exitCode = 1 }
