import assert from 'node:assert/strict'
import { appendFile, readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createNodeService } from '../../../src/node-service.mjs'
import { assertNodeCaller } from '../../../packages/agent-contracts/nodes.mjs'
import { binding, sameBinding, error } from '../../../packages/agent-contracts/index.mjs'
import { authorizeMultisiteExecution } from '../../../src/multisite-authorization.mjs'
import { openWorkGroupJournal } from './work-group-journal.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
export async function createWorkGroupDomain({ root, stateFile, work, actors, openExisting = false, recordResolution }) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'))
  const recordAttempt = recordResolution ?? (value => appendFile(path.join(root, 'body-resolutions.jsonl'), JSON.stringify(value) + '\n'))
  const nodes = createNodeService({ store: { read: readState, update() { throw Error('The group domain cannot write Geneway state') } } })
  const privateActor = value => {
    const actor = actors.find(row => row.employeeId === value.employeeId)
    if (!actor || !sameBinding(actor.binding, value.binding)) throw error('FORBIDDEN', 'Unbound protocol principal')
    return actor
  }
  function authenticate(state, actor) {
    const auth = nodes.authenticate(state, 'Bearer ' + actor.identity.credential, actor.identity.nodeInstanceId)
    assertNodeCaller(state, auth, actor.binding, { receiptReplay: true })
    if (actor.binding.work_id !== work.workId || actor.binding.agent_id !== actor.employeeId || auth.workspaceId !== work.workspaceId) throw error('FORBIDDEN')
    return auth
  }
  const initial = await readState()
  const proof = actors.map(actor => {
    const auth = authenticate(initial, actor)
    if (!openExisting) authorizeMultisiteExecution(initial, actor.binding)
    return { employeeId: actor.employeeId, binding: binding(actor.binding), nodeId: auth.nodeId, nodeInstanceId: auth.nodeInstanceId, credentialSha256: hash(actor.identity.credential) }
  })
  const proofFile = path.join(root, 'principal-bindings.json')
  if (openExisting) assert.deepEqual(JSON.parse(await readFile(proofFile)), proof, 'Restart changed the authenticated logical actors')
  else await writeFile(proofFile, JSON.stringify(proof, null, 2), { mode: 0o600 })
  const journal = await openWorkGroupJournal({ file: path.join(root, 'event-locators.json'), initial: { version: 1, work, events: [] }, openExisting })
  assert.deepEqual((await journal.read()).work, work)
  async function authorize(principal) {
    const actor = privateActor(principal), state = await readState()
    authenticate(state, actor); authorizeMultisiteExecution(state, actor.binding)
    return true
  }
  function requestActor(headers, suppliedBinding) {
    const actor = actors.find(row => headers.authorization === 'Bearer ' + row.identity.credential && headers['x-geneway-node-instance'] === row.identity.nodeInstanceId)
    if (!actor || !sameBinding(actor.binding, suppliedBinding)) throw error('FORBIDDEN', 'Device credential and exact binding are required')
    return actor
  }
  function messageFor(state, messageId) {
    const message = state.multisite.messages.find(row => row.id === messageId && row.workId === work.workId)
    if (!message) throw error('NOT_FOUND')
    return message
  }
  function recipients(state, message) {
    if (message.kind === 'observation' && message.targetAttemptId === null) return actors.map(row => row.employeeId)
    const target = state.multisite.attempts.find(row => row.attempt_id === message.targetAttemptId && row.work_id === work.workId)
    return target && actors.some(row => row.employeeId === target.agent_id) ? [target.agent_id] : []
  }
  async function register(principal, messageId) {
    const actor = privateActor(principal); await authorize(actor)
    const state = await readState(), message = messageFor(state, messageId)
    if (!sameBinding(message.senderBinding, actor.binding)) throw error('FORBIDDEN', 'Only the original sender can announce this event')
    const existing = (await journal.read()).events.find(row => row.messageId === messageId)
    if (existing) return existing
    const row = { locator: randomUUID(), workId: work.workId, messageId, senderEmployeeId: actor.employeeId, recipientEmployeeIds: recipients(state, message), registeredAt: new Date().toISOString() }
    await journal.update(value => { if (!value.events.some(item => item.messageId === messageId)) value.events.push(row) })
    return (await journal.read()).events.find(item => item.messageId === messageId)
  }
  async function resolve(principal, locator, { metadataOnly = false } = {}) {
    const actor = privateActor(principal); await authorize(actor)
    const event = (await journal.read()).events.find(row => row.locator === locator)
    if (!event || !event.recipientEmployeeIds.includes(actor.employeeId) && !(metadataOnly && event.senderEmployeeId === actor.employeeId)) throw error('FORBIDDEN', 'This event was not directed to this recipient')
    // Record the attempt before the final authority read: logging must not leave
    // an I/O window between the last membership check and returning body bytes.
    await recordAttempt({ at: new Date().toISOString(), employeeId: actor.employeeId, locator, metadataOnly, messageId: event.messageId, phase: 'resolution-attempt' })
    const state = await readState(), message = messageFor(state, event.messageId)
    authenticate(state, actor); authorizeMultisiteExecution(state, actor.binding)
    if (!isDeepStrictEqual(recipients(state, message), event.recipientEmployeeIds)) throw error('FORBIDDEN')
    const result = { workId: work.workId, eventId: event.messageId, messageId: event.messageId, recipientEmployeeIds: event.recipientEmployeeIds }
    if (!metadataOnly) {
      const source = message.kind === 'dependency_result' ? state.multisite.results.find(row => row.id === message.resultRef)?.payload : message
      result.text = source?.text ?? source?.summary ?? ''
      result.evidenceCount = source?.evidenceRefs?.length ?? 0
    }
    return result
  }
  async function resolveRequest(headers, suppliedBinding, locator) {
    const actor = requestActor(headers, suppliedBinding)
    try { return await resolve(actor, locator) } catch (cause) {
      await appendFile(path.join(root, 'body-resolutions.jsonl'), JSON.stringify({ at: new Date().toISOString(), employeeId: actor.employeeId, locator, allowed: false, code: cause.code ?? 'FORBIDDEN' }) + '\n')
      throw cause
    }
  }
  async function calibrate({ home, groupDid, employeeId, removal, receipt, hostSnapshot }) {
    const actor = actors.find(row => row.employeeId === employeeId), state = await readState()
    assert(actor && state.workMemberRemovals.some(row => isDeepStrictEqual(row, removal)))
    const records = home.received.filter(row => row.rpc.params?.body?.group_did === groupDid && row.rpc.params?.meta?.target?.did === home.identities.get(employeeId).didDocument.id)
    const deliveries = []
    for (const record of records.filter(row => row.rpc.method === 'group.incoming')) {
      const locator = record.rpc.params.body.payload?.locator
      assert(locator && Object.keys(record.rpc.params.body.payload).sort().join(',') === 'locator,schema', 'Group delivery contains more than an opaque locator')
      let code
      try { await resolve(actor, locator); code = 'AVAILABLE' } catch (cause) { code = cause.code ?? 'FORBIDDEN' }
      deliveries.push({ locator, operationId: record.rpc.params.meta.operation_id, targetDid: record.rpc.params.meta.target.did, transportReceivedAt: record.at, bodyStatus: code })
    }
    const targetDid = home.identities.get(employeeId).didDocument.id
    const outstanding = hostSnapshot.deliveries.filter(row => row.target_did === targetDid && BigInt(row.group_event_seq) <= BigInt(receipt.group_event_seq) && row.status !== 'delivered')
    const finalState = records.some(row => row.rpc.method === 'group.state_changed' && row.rpc.params.body.group_receipt?.operation_id === receipt.operation_id)
    const complete = outstanding.length === 0 && finalState && deliveries.every(row => row.bodyStatus === 'FORBIDDEN')
    const result = { observedAt: new Date().toISOString(), complete, deliveries, outstanding, finalStateNotificationReceived: finalState }
    await appendFile(path.join(root, 'recipient-calibrations.jsonl'), JSON.stringify({ workId: work.workId, employeeId, removalCommandId: removal.commandId, ...result }) + '\n')
    return result
  }
  return { readState, actors, authorize, requestActor, register, resolve, resolveRequest, calibrate, snapshot: () => journal.read(), proof }
}
