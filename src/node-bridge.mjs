import { assertBridgeEventBytes } from '../packages/agent-contracts/terminal-proof.mjs'
import { workMemberAffected } from './work-member-removal.mjs'
import { supervisionUserQuestion } from './supervision-state.mjs'
import { authorizeBudgetIntentResume, authorizeIntentQuestionClosure, authorizeIntentDelivery, pendingIntentReview } from './interaction-state.mjs'
import { authorizeManualResume } from './manual-resume.mjs'
import { authorizeExecutionCommand } from '../packages/agent-orchestration/execution-dispatch.mjs'
import { assertManualConsumption, assertManualExecution, manualFence } from './manual-control.mjs'
import { recordSpreadsheetPreparation } from './spreadsheet-preparation.mjs'
import { buildSpreadsheetManifest } from './spreadsheet-sources.mjs'
import { isCollaborationSpreadsheet } from './spreadsheet-template.mjs'
import { collaborationRows } from '../packages/agent-contracts/spreadsheet-collaboration.mjs'
import { BRIDGE_LIMIT, COMMAND_FETCH_LIMIT, jsonBytes, commandReference, commandUnavailable, assertCommandReference } from '../packages/agent-contracts/command-bytes.mjs'
import { waitEnvelopeBytes } from '../packages/agent-orchestration/dependencies.mjs'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { binding, BINDING_FIELDS, digest, error, exact, key, sameBinding, text } from '../packages/agent-contracts/index.mjs'
import { assertNodeCaller } from '../packages/agent-contracts/nodes.mjs'
import { authorizeManualControlCommand, authorizeMultisiteExecution, authorizeQuestionClosureCommand, authorizeBudgetControlCommand, authorizeBudgetControlReceipt, hasConsumedExecutionMessage } from './multisite-authorization.mjs'
import { assertSpreadsheetAuthority } from '../packages/agent-contracts/tools.mjs'
import { SPREADSHEET_JSON_LIMIT, assertSpreadsheetJobProjection, assertSpreadsheetRows } from '../packages/agent-contracts/spreadsheet.mjs'

const BODY_LIMIT = BRIDGE_LIMIT
async function body(request, limit = BODY_LIMIT) {
  if (String(request.headers['content-type'] ?? '').split(';')[0] !== 'application/json') throw error('INVALID_REQUEST')
  let length = 0; const chunks = []
  const timeout = setTimeout(() => request.destroy(), 15_000); timeout.unref()
  try { for await (const chunk of request) { length += chunk.length; if (length > limit) throw error('INVALID_REQUEST', '节点消息超限'); chunks.push(chunk) } }
  finally { clearTimeout(timeout) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw error('INVALID_REQUEST', '节点消息格式无效') }
}
function execution(value) { exact(value, BINDING_FIELDS); for (const field of BINDING_FIELDS.filter(field => !['session_id', 'parent_delegation_id', 'execution_epoch'].includes(field))) text(value[field]); return value }
const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
export function createNodeBridge({ store, nodes, getMultisite, gateway, spreadsheetService, spreadsheetArtifacts, clock = () => Date.now(), scanIntervalMs = 500 }) {
  const connections = new Map()
  let timer, closed = false
  function authenticated(state, request) { return nodes.authenticate(state, request.headers.authorization, request.headers['x-geneway-node-instance']) }
  function allowed(state, authenticated, row) {
    try {
      const current = state.multisite.attempts.find(attempt => attempt.attempt_id === row.command.attempt_id), command = row.command
      assertNodeCaller(state, authenticated, { ...binding(command), session_id: command.session_id ?? current?.session_id ?? null }, { cleanup: ['cancel', 'settle'].includes(command.operation) })
      authorizeExecutionCommand(state, command)
      return true
    } catch (cause) { if (['FORBIDDEN', 'UNAUTHORIZED', 'REVISION_CONFLICT', 'WAITING_BUDGET', 'EXECUTION_DEADLINE', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING'].includes(cause.code)) return false; throw cause }
  }
  function pending(state, auth) { return state.multisite.outbox.filter(row => !row.acceptedAt && row.command.node_id === auth.nodeId && allowed(state, auth, row)) }
  const representation = (command, canInline) => jsonBytes(command) > COMMAND_FETCH_LIMIT ? commandUnavailable(command) : canInline(command) ? command : commandReference(command)
  const commandFrame = (id, value) => `id: ${id}\nevent: command\ndata: ${JSON.stringify(value)}\n\n`
  async function writeFrame(connection, frame) {
    if (Buffer.byteLength(frame) > BODY_LIMIT || connection.response.writableLength > 1024 * 1024) { connection.response.destroy(); return false }
    if (!connection.response.write(frame)) await once(connection.response, 'drain', { signal: AbortSignal.timeout(5000) })
    connection.lastWriteAt = clock()
    return true
  }
  async function scan(connection) {
    if (connection.scanning || connection.response.destroyed || closed) return
    connection.scanning = true
    let currentReoffer
    try {
      const state = await store.read(), node = state.nodes.find(row => row.id === connection.auth.nodeId)
      if (!node || node.nodeInstanceId !== connection.auth.nodeInstanceId || node.credentialVersion !== connection.auth.credentialVersion) { connection.response.destroy(); return }
      const rows = pending(state, connection.auth), ids = new Set(rows.map(row => row.id))
      for (const id of connection.sent) if (!ids.has(id)) connection.sent.delete(id)
      for (const id of connection.unavailableSent) if (!ids.has(id)) connection.unavailableSent.delete(id)
      for (const row of rows) {
        const reoffer = connection.reofferGuards.get(row.id)
        currentReoffer = reoffer
        if (reoffer) {
          const current = await store.read(), currentRow = current.multisite.outbox.find(item => item.id === row.id)
          if (!reofferEligible(current, connection, currentRow, reoffer.value, false)) {
            connection.sent.add(row.id); connection.reofferGuards.delete(row.id); continue
          }
        }
        const delivery = representation(row.command, command => Buffer.byteLength(commandFrame(row.id, command)) <= BODY_LIMIT)
        if (delivery.kind === 'command_unavailable') {
          // Diagnostics have no ACK and must not occupy the business inflight window.
          if (connection.unavailableSent.has(row.id) || connection.unavailableSent.size >= 32) continue
          connection.unavailableSent.add(row.id)
        } else {
          if (connection.sent.has(row.id)) continue
          if (connection.sent.size >= 32) break
          connection.sent.add(row.id)
        }
        const frame = commandFrame(row.id, delivery)
        const written = await writeFrame(connection, frame)
        if (reoffer) { reoffer.offered = written; connection.reofferGuards.delete(row.id) }
        currentReoffer = undefined
        if (!written) break
      }
      if (!connection.response.destroyed && clock() - connection.lastWriteAt >= 15000) await writeFrame(connection, ': keepalive\n\n')
    } catch { if (currentReoffer) currentReoffer.unconfirmed = true; connection.response.destroy() }
    finally { connection.scanning = false }
  }
  function kick(nodeId) { const connection = connections.get(nodeId); if (connection) void scan(connection) }
  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/internal/bridge/') && !url.pathname.startsWith('/internal/executions/') && !url.pathname.startsWith('/internal/spreadsheets/') && url.pathname !== '/internal/agent/commands' && url.pathname !== '/internal/context/read' && url.pathname !== '/internal/nodes/pair') return false
    try {
      if (url.search) throw error('INVALID_REQUEST')
      if (request.method === 'POST' && url.pathname === '/internal/nodes/pair') { json(response, await nodes.redeem(await body(request))); return true }
      let state = await store.read(), auth = authenticated(state, request)
      if (request.method === 'GET' && url.pathname === '/internal/bridge/events') {
        if (request.headers['last-event-id']) throw error('RESYNC_REQUIRED', '事件流不支持从旧位置恢复，请先重新同步待处理命令。')
        const hostRunId = text(request.headers['x-geneway-host-run']), generation = randomUUID(), previous = connections.get(auth.nodeId)
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); response.flushHeaders()
        const connection = { auth, response, generation, hostRunId, sent: new Set(), unavailableSent: new Set(), reofferGuards: new Map(), scanning: false, lastWriteAt: clock(), connectedAt: new Date(clock()).toISOString(), lastSeenAt: new Date(clock()).toISOString() }
        connections.set(auth.nodeId, connection)
        previous?.response.destroy()
        response.once('close', () => { if (connections.get(auth.nodeId)?.generation === generation) connections.delete(auth.nodeId) })
        await scan(connection); return true
      }
      if (request.method !== 'POST') throw error('NOT_FOUND')
      const value = await body(request, ['/internal/spreadsheets/prepare', '/internal/spreadsheets/revalidate', '/internal/spreadsheets/job-events'].includes(url.pathname) ? SPREADSHEET_JSON_LIMIT : BODY_LIMIT)
      // A slow body cannot retain authority that was revoked while it arrived.
      state = await store.read(); auth = authenticated(state, request)
      if (url.pathname.startsWith('/internal/spreadsheets/')) {
        if (!spreadsheetService || !spreadsheetArtifacts) throw error('FORBIDDEN')
        const operation = url.pathname.slice('/internal/spreadsheets/'.length)
        if (['authorize','read','prepare'].includes(operation) && pendingIntentReview(state,value.binding)) throw error('FORBIDDEN')
        if (operation === 'job-events') {
          exact(value, ['event'])
          exact(value.event, ['schema', 'event_id', 'workspace_id', 'kind', ...BINDING_FIELDS, 'input_id', 'instruction_revision', 'observed_revision', 'job', 'payload_digest'])
          if (value.event?.kind !== 'spreadsheet_job') throw error('INVALID_REQUEST')
          text(value.event.workspace_id)
          if (!/^[a-f0-9]{32}$/.test(value.event.event_id) || !/^[a-f0-9]{32}$/.test(value.event.input_id) || !Number.isSafeInteger(value.event.instruction_revision) || value.event.instruction_revision < 1 || !Number.isSafeInteger(value.event.observed_revision) || value.event.observed_revision < 0) throw error('INVALID_REQUEST')
          assertSpreadsheetJobProjection(value.event.job)
          // Receipt replay, Node authority, projection and ACK retain their original transaction.
          json(response, await getMultisite().acceptHostEvent(auth, value.event)); return true
        }
        const fields = { authorize: ['binding'], read: ['binding', 'parameters'], prepare: ['binding', 'parameters'], revalidate: ['binding', 'input', 'job'], 'upload-token': ['binding', 'jobId'], candidate: ['binding', 'jobId'] }[operation]
        if (!fields) throw error('NOT_FOUND')
        exact(value, fields); execution(value.binding); assertNodeCaller(state, auth, value.binding)
        const current = authorizeMultisiteExecution(state, value.binding, { allowCompleted: operation === 'upload-token' })
        if (['authorize', 'read', 'prepare'].includes(operation)) assertManualConsumption(state, value.binding)
        assertSpreadsheetAuthority(current.current)
        if (!current.work.spreadsheetRequest || !isCollaborationSpreadsheet(current.work.spreadsheetRequest) && state.multisite.attempts.filter(row => row.work_id === current.work.id).length !== 1) throw error('FORBIDDEN')
        let reply
        if (operation === 'authorize') {
          const access = await spreadsheetService.authorize(value.binding)
          reply = { current: { instructionRevision: access.current.instruction_revision }, work: { spreadsheetRequest: access.work.spreadsheetRequest } }
        } else if (operation === 'read') reply = await spreadsheetService.readEvidence(value.binding, value.parameters)
        else if (operation === 'prepare') {
          const controlFence = manualFence(state, value.binding)
          if (isCollaborationSpreadsheet(current.work.spreadsheetRequest)) collaborationRows(value.parameters?.rows); else assertSpreadsheetRows(value.parameters?.rows)
          reply = await spreadsheetService.prepare(value.binding, value.parameters)
          if (jsonBytes(reply) > SPREADSHEET_JSON_LIMIT) throw error('COMMAND_TOO_LARGE')
          await store.update(draft => {
            const currentAuth = authenticated(draft, request); assertNodeCaller(draft, currentAuth, value.binding)
            authorizeMultisiteExecution(draft, value.binding); assertManualExecution(draft, value.binding, controlFence); assertManualConsumption(draft, value.binding)
            const currentWork = draft.works.find(work => work.id === value.binding.work_id)
            if (currentWork.instructionRevision !== reply.input.instructionRevision || currentWork.spreadsheetRequest?.dueDate !== reply.input.dueDate) throw error('REVISION_CONFLICT')
            if (reply.input.sourceManifest && digest(buildSpreadsheetManifest(draft, value.binding, value.parameters.sourceResultIds, value.parameters.rows, { inputEncodingVersion: reply.input.inputEncodingVersion ?? 1 })) !== reply.input.sourceManifestDigest) throw error('REVISION_CONFLICT')
            recordSpreadsheetPreparation(draft, value.binding, value.parameters, reply, new Date(clock()).toISOString()); return draft
          })
        } else if (operation === 'candidate') reply = await spreadsheetArtifacts.candidateReceipt(value.binding, value.jobId)
        else if (operation === 'revalidate') { exact(value.input, isCollaborationSpreadsheet(current.work.spreadsheetRequest) ? ['instructionRevision', 'dueDate', 'sourceManifest', 'sourceManifestDigest', 'rows', 'inputEncodingVersion', 'jobId', 'inputDigest'] : ['instructionRevision', 'dueDate']); reply = await spreadsheetService.revalidate(value.binding, value.input, { job: value.job }) }
        else {
          if (typeof value.jobId !== 'string' || !/^[a-f0-9]{32}$/.test(value.jobId)) throw error('INVALID_REQUEST')
          // Only cloud-sealed receipt facts select the Job; no caller output/path claims.
          const job = state.multisite.jobs.find(row => row.id === value.jobId && sameBinding(row, value.binding))
          if (!job) throw error('JOB_PROJECTION_PENDING')
          reply = await spreadsheetArtifacts.issueUploadToken(job)
        }
        if (jsonBytes(reply) > (operation === 'prepare' ? SPREADSHEET_JSON_LIMIT : BODY_LIMIT)) throw error('INVALID_STATE', '表格响应超限')
        json(response, reply); return true
      }
      if (url.pathname === '/internal/executions/image-variants') {
        exact(value, ['binding', 'variant']); execution(value.binding); assertNodeCaller(state, auth, value.binding)
        await gateway.registerVariant(value.binding, value.variant); json(response, { accepted: true }); return true
      }
      if (url.pathname === '/internal/bridge/command') {
        exact(value, ['commandId', 'payloadDigest'])
        assertCommandReference({ kind: 'command_ref', ...value })
        const snapshot = await store.read(), currentAuth = authenticated(snapshot, request), row = snapshot.multisite.outbox.find(row => row.id === value.commandId)
        if (!row || row.command.node_id !== currentAuth.nodeId || !allowed(snapshot, currentAuth, row)) throw error('FORBIDDEN')
        if (row.command.payload_digest !== value.payloadDigest) throw error('IDEMPOTENCY_CONFLICT', '命令摘要不匹配')
        if (jsonBytes(row.command) > COMMAND_FETCH_LIMIT) throw error('COMMAND_UNAVAILABLE', '原命令超过可读取上限，可停止此执行。')
        json(response, row.command); return true
      }
      if (url.pathname === '/internal/bridge/resync') {
        exact(value, ['hostRunId']); text(value.hostRunId)
        // One committed snapshot supplies both bindings and commands; the periodic scan catches later commits.
        const snapshot = await store.read(), currentAuth = authenticated(snapshot, request), currentNode = snapshot.nodes.find(row => row.id === currentAuth.nodeId)
        const attempts = snapshot.multisite.attempts.filter(row => row.node_id === currentAuth.nodeId && row.nodeSnapshot?.nodeInstanceId === currentAuth.nodeInstanceId && (currentNode.status !== 'cleanup_only' || currentNode.cleanupBindings.some(item => sameBinding(item, row, { firstSession: item.session_id === null })))).map(row => ({ ...binding(row), status: row.status, instructionRevision: row.instruction_revision }))
        const result = { nodeId: currentNode.id, nodeInstanceId: currentNode.nodeInstanceId, status: currentNode.status, bindings: [], pending: [], unavailable: [], hasMoreBindings: false, hasMorePending: false, hasMoreUnavailable: false }
        for (const attempt of attempts) {
          result.bindings.push(attempt)
          if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024) { result.bindings.pop(); result.hasMoreBindings = true; break }
        }
        const commands = pending(snapshot, currentAuth), unavailable = []
        for (const row of commands) {
          if (jsonBytes(row.command) > COMMAND_FETCH_LIMIT) { unavailable.push(commandUnavailable(row.command)); continue }
          let delivery = row.command
          result.pending.push(delivery)
          if (jsonBytes(result) > BODY_LIMIT - 128) {
            result.pending.pop(); delivery = commandReference(row.command); result.pending.push(delivery)
            if (jsonBytes(result) > BODY_LIMIT - 128) { result.pending.pop(); result.hasMorePending = true; break }
          }
        }
        if (currentNode.status !== 'cleanup_only') for (const wait of snapshot.multisite.dependencyWaits.filter(row => !row.wokenAt && row.envelopeVersion === undefined)) {
          const parent = snapshot.multisite.attempts.find(row => row.attempt_id === wait.parentAttemptId)
          if (!parent || parent.node_id !== currentAuth.nodeId) continue
          try { authorizeMultisiteExecution(snapshot, parent) } catch { continue }
          if (waitEnvelopeBytes(snapshot, parent, wait, currentAuth.workspaceId) > COMMAND_FETCH_LIMIT) unavailable.push({ kind: 'wait_unavailable', waitId: wait.id, parentAttemptId: parent.attempt_id, code: 'COMMAND_TOO_LARGE' })
        }
        for (const diagnostic of unavailable) {
          result.unavailable.push(diagnostic)
          if (jsonBytes(result) > BODY_LIMIT - 128) { result.unavailable.pop(); result.hasMoreUnavailable = true; break }
        }
        json(response, result); return true
      }
      if (url.pathname === '/internal/bridge/acks') {
        exact(value, ['commandId', 'payloadDigest', 'binding', 'nodeInstanceId', 'registrationRevision']); execution(value.binding)
        let ack
        await store.update(draft => {
          const currentAuth = authenticated(draft, request), row = draft.multisite.outbox.find(row => row.id === value.commandId)
          if (!row || value.payloadDigest !== row.command.payload_digest || !sameBinding(row.command, value.binding) || value.nodeInstanceId !== currentAuth.nodeInstanceId) throw error('ACK_MISMATCH')
          const attempt = draft.multisite.attempts.find(row => row.attempt_id === value.binding.attempt_id)
          if (value.registrationRevision !== attempt.nodeSnapshot?.registrationRevision) throw error('ACK_MISMATCH')
          const memberRemoved = workMemberAffected(draft, row.command)
          // This exact sealed transport ACK records local acceptance only. Current
          // execution/data permission is still checked at dispatch and consumption.
          assertNodeCaller(draft, currentAuth, { ...value.binding, session_id: value.binding.session_id ?? attempt.session_id }, { cleanup: ['cancel', 'settle'].includes(row.command.operation), receiptReplay: !!row.acceptedAt })
          if (!memberRemoved && !row.acceptedAt && (row.command.operation === 'budget_wait' || row.command.parameters.messages?.[0]?.kind === 'budget_resume')) authorizeBudgetControlReceipt(draft, row.command)
          if (!memberRemoved && !row.acceptedAt && ['manual_pause', 'manual_release'].includes(row.command.operation)) authorizeManualControlCommand(draft, row.command)
          if (!memberRemoved && !row.acceptedAt && row.command.parameters.messages?.some(message => message.kind === 'question_closed')) authorizeQuestionClosureCommand(draft, row.command)
          if(!memberRemoved&&!row.acceptedAt&&row.command.operation==='intent_question_closed')authorizeIntentQuestionClosure(draft,row.command)
          if (!memberRemoved && !row.acceptedAt && row.command.operation==='intent_review') authorizeIntentDelivery(draft,row.command)
          row.acceptedAt ??= new Date(clock()).toISOString()
          ack = { command_id: row.id, payload_digest: row.command.payload_digest, node_id: currentAuth.nodeId, ...binding(row.command) }; return draft
        })
        json(response, ack); kick(auth.nodeId); return true
      }
      if (url.pathname === '/internal/bridge/events') {
        exact(value, ['event']); assertBridgeEventBytes(value.event); const ack = await getMultisite().acceptHostEvent(auth, value.event); json(response, ack); return true
      }
      if (url.pathname === '/internal/context/read') {
        exact(value, ['binding', 'parameters', 'modelStep']); execution(value.binding); assertNodeCaller(state, auth, value.binding)
        const page = await gateway.context.read(value.binding, value.parameters, value.modelStep, auth); json(response, page); return true
      }
      if (url.pathname === '/internal/agent/commands') {
        exact(value, ['binding', 'operation', 'parameters', 'manualFence']); execution(value.binding)
        // The same transaction checks Node and business authority before accepting the D1 command.
        const reply = await getMultisite().agentCommand(value.binding, value.operation, value.parameters, { nodeAuth: auth, manualFence: value.manualFence })
        json(response, reply); kick(auth.nodeId); return true
      }
      if (url.pathname === '/internal/executions/intent-review') {
        exact(value,['binding','commandId','options']);execution(value.binding);assertNodeCaller(state,auth,value.binding);exact(value.options,['request','inputMessageId','clientRequestId']);text(value.options.clientRequestId);if(value.options.request!==undefined&&typeof value.options.request!=='boolean')throw error('INVALID_REQUEST')
        const command=state.multisite.outbox.find(row=>row.id===value.commandId)?.command
        if(!command||!sameBinding({...binding(command),session_id:command.session_id??`geneway-${command.launch_id}`},value.binding))throw error('FORBIDDEN')
        authorizeIntentDelivery(state,command,{requireConsumed:!!value.options.request})
        let requestId
        await store.update(draft=>{const currentAuth=authenticated(draft,request);assertNodeCaller(draft,currentAuth,value.binding);authorizeIntentDelivery(draft,draft.multisite.outbox.find(row=>row.id===value.commandId)?.command,{requireConsumed:!!value.options.request});const id=key('intent-token',currentAuth.nodeId,value.binding.attempt_id,value.options.clientRequestId),parameters=structuredClone(value),old=draft.executionIssuances.find(row=>row.id===id);if(old){if(old.payloadDigest!==digest(parameters))throw error('IDEMPOTENCY_CONFLICT');requestId=old.requestId}else{requestId=randomUUID();draft.executionIssuances.push({id,attempt_id:value.binding.attempt_id,nodeId:currentAuth.nodeId,nodeInstanceId:currentAuth.nodeInstanceId,payloadDigest:digest(parameters),parameters,requestId,acceptedAt:new Date(clock()).toISOString()})}return draft})
        json(response,await gateway.issueIntentReview(value.binding,value.commandId,{...value.options,requestId}));return true
      }
      if (url.pathname === '/internal/executions/budget-resume') {
        exact(value, ['binding', 'commandId', 'options']); execution(value.binding); assertNodeCaller(state, auth, value.binding)
        const options=value.options??{};exact(options,['request','inputMessageId','clientRequestId']);if(options.request!==undefined&&typeof options.request!=='boolean')throw error('INVALID_REQUEST');let requestId
        if(options.clientRequestId){text(options.clientRequestId);await store.update(draft=>{const currentAuth=authenticated(draft,request);assertNodeCaller(draft,currentAuth,value.binding);if(options.request)assertManualConsumption(draft,value.binding);const command=draft.multisite.outbox.find(row=>row.id===value.commandId)?.command,hold=draft.budgetHolds.find(row=>row.resumeCommandId===value.commandId);if(!command||!sameBinding(command,value.binding))throw error('FORBIDDEN');if(hold?.intentReview)authorizeBudgetIntentResume(draft,command,options);else{authorizeBudgetControlCommand(draft,command);if(options.request){if(typeof options.inputMessageId!=='string')throw error('REVISION_CONFLICT');authorizeMultisiteExecution(draft,value.binding,{inputMessageId:options.inputMessageId})}}const id=key('budget-resume-token',currentAuth.nodeId,value.binding.attempt_id,options.clientRequestId),parameters=structuredClone(value),old=draft.executionIssuances.find(row=>row.id===id);if(old){if(old.payloadDigest!==digest(parameters))throw error('IDEMPOTENCY_CONFLICT');requestId=old.requestId}else{requestId=randomUUID();draft.executionIssuances.push({id,attempt_id:value.binding.attempt_id,nodeId:currentAuth.nodeId,nodeInstanceId:currentAuth.nodeInstanceId,payloadDigest:digest(parameters),parameters,requestId,acceptedAt:new Date(clock()).toISOString()})}return draft})}else if(options.request)throw error('INVALID_REQUEST')
        const issued = await gateway.issueBudgetResume(value.binding, value.commandId,{...options,...(requestId?{requestId}:{})}); json(response, issued); return true
      }
      if (!['/internal/executions/authorize', '/internal/executions/tokens'].includes(url.pathname)) throw error('NOT_FOUND')
      exact(value, url.pathname.endsWith('/authorize') ? ['binding'] : ['binding', 'options']); execution(value.binding)
      assertNodeCaller(state, auth, value.binding)
      if (url.pathname.endsWith('/authorize')) {
        const access = await gateway.authorize(value.binding)
        json(response, { modelSnapshot: access.current.modelSnapshot, work: { spreadsheetRequest: access.work.spreadsheetRequest ?? null }, current: { instructionRevision: access.current.instruction_revision, modelSnapshot: access.current.modelSnapshot } }); return true
      }
      const options = value.options
      exact(options, ['request', 'inputMessageId', 'refresh', 'clientRequestId'])
      if (options.request !== undefined && typeof options.request !== 'boolean' || options.refresh !== undefined && typeof options.refresh !== 'boolean') throw error('INVALID_REQUEST')
      const clientRequestId = text(options.clientRequestId), id = key('node-token', auth.nodeId, value.binding.attempt_id, clientRequestId), parameters = { binding: binding(value.binding), options: { ...options } }
      let requestId
      await store.update(draft => {
        const currentAuth = authenticated(draft, request); assertNodeCaller(draft, currentAuth, value.binding); const access = authorizeMultisiteExecution(draft, value.binding, { inputMessageId: options.inputMessageId })
        if (options.request) {
          const knownSource = hasConsumedExecutionMessage(draft, value.binding, options.inputMessageId)
          if (!knownSource) throw error('REVISION_CONFLICT', '模型输入尚未确认消费')
        }
        const old = draft.executionIssuances.find(row => row.id === id), payloadDigest = digest(parameters)
        if (old) { if (old.payloadDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT'); requestId = old.requestId; return draft }
        requestId = randomUUID(); draft.executionIssuances.push({ id, attempt_id: value.binding.attempt_id, nodeId: currentAuth.nodeId, nodeInstanceId: currentAuth.nodeInstanceId, payloadDigest, parameters, requestId, acceptedAt: new Date(clock()).toISOString() }); return draft
      })
      const issued = await gateway.issue(value.binding, { ...options, requestId })
      json(response, issued); return true
    } catch (cause) {
      const sourceCapacity = cause.code === 'CAPACITY_EXCEEDED' && cause.capacity?.domain === 'cloud' && cause.capacity?.queue === 'ordinary' ? cause.capacity : null
      const capacity = sourceCapacity ? { domain: 'cloud', queue: 'ordinary',
        ...(typeof sourceCapacity.reason === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(sourceCapacity.reason) ? { reason: sourceCapacity.reason } : {}),
        ...(Number.isSafeInteger(sourceCapacity.count) && sourceCapacity.count >= 0 ? { count: sourceCapacity.count } : {}),
        ...(Number.isSafeInteger(sourceCapacity.bytes) && sourceCapacity.bytes >= 0 ? { bytes: sourceCapacity.bytes } : {}) } : null
      if (response.headersSent) response.destroy()
      else json(response, { error: { code: cause.code ?? 'STORE_UNAVAILABLE', ...(capacity ? { capacity } : {}), message: ['FORBIDDEN', 'UNAUTHORIZED', 'CONTEXT_READ_UNAVAILABLE'].includes(cause.code) ? '节点请求未获准' : cause.code === 'RESYNC_REQUIRED' ? cause.message : cause.code === 'CONTEXT_READ_LIMIT' ? '资料读取已达到本次边界，请用户明确继续读取资料。' : cause.code === 'CONTEXT_READ_WINDOW_PENDING' ? '资料新窗口已批准，仍等待当前合法通知实际消费。' : '节点请求无法完成' } }, ({ CAPACITY_EXCEEDED: 409, COMMAND_TOO_LARGE: 413, COMMAND_UNAVAILABLE: 409, RESYNC_REQUIRED: 409, INVALID_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, IDEMPOTENCY_CONFLICT: 409, ACK_MISMATCH: 409, REVISION_CONFLICT: 409, WAITING_BUDGET: 409, EXECUTION_DEADLINE: 409, MANUALLY_PAUSED: 409, MANUAL_RELEASE_PENDING: 409, MANUAL_RESUME_PENDING: 409, CONTEXT_READ_UNAVAILABLE: 403, CONTEXT_READ_LIMIT: 409, CONTEXT_READ_WINDOW_PENDING: 409, CONTEXT_READ_VERSION_CHANGED: 409, INVALID_CURSOR: 409, RUNTIME_REQUEST_UNKNOWN: 409, INVALID_STATE: 409 })[cause.code] ?? 503)
      return true
    }
  }
  function supervisionConnection(nodeId) {
    const connection = connections.get(nodeId)
    return connection && !connection.response.destroyed ? { generation: connection.generation, nodeInstanceId: connection.auth.nodeInstanceId, hostRunId: connection.hostRunId, connectedAt: connection.connectedAt, sentCommandIds: [...connection.sent] } : null
  }
  function reofferEligible(state, connection, row, value, requireSent) {
    const command = row?.command, attempt = command && state.multisite.attempts.find(item => item.attempt_id === command.attempt_id)
    const work = attempt && state.works.find(item => item.id === attempt.work_id)
    if (closed || !connection || connections.get(connection.auth.nodeId) !== connection || connection.response.destroyed
      || connection.generation !== value.generation || connection.auth.nodeInstanceId !== value.nodeInstanceId || !row || row.acceptedAt
      || command.payload_digest !== value.payloadDigest || command.node_id !== connection.auth.nodeId || requireSent && !connection.sent.has(row.id)
      || !['launch', 'deliver'].includes(command.operation) || !attempt || !['accepted', 'running'].includes(attempt.status)
      || !work || !['accepted', 'running', 'waiting_input'].includes(work.status) || work.modelRequestBudget?.exhaustedAt
      || work.modelRequestBudget?.version !== 2 && work.modelRequestBudget?.reserved >= work.modelRequestBudget?.limit
      || state.modelRequests.some(item => item.attempt_id === attempt.attempt_id && item.outcome === 'unknown')
      || supervisionUserQuestion(state, attempt)
      || state.multisite.questions.some(item => item.state === 'open' && item.senderBinding?.attempt_id === attempt.attempt_id)
      || state.intentQuestions.some(item => item.state === 'open' && item.handlerBinding?.attempt_id === attempt.attempt_id)
      || state.workIntents.some(item => item.state === 'attached' && state.contextSubscriptions.some(sub => sub.id === item.handlerSubscriptionId && sub.handlerBinding.attempt_id === attempt.attempt_id))) return false
    try { if (!allowed(state, connection.auth, row)) return false }
    catch (cause) { if (cause.code === 'MODEL_NOT_CONFIGURED') return false; throw cause }
    try { assertManualConsumption(state, { ...binding(command), session_id: command.session_id ?? `geneway-${command.launch_id}` }) }
    catch (cause) { if (['MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'MANUAL_RESUME_PENDING', 'REVISION_CONFLICT', 'FORBIDDEN'].includes(cause.code)) return false; throw cause }
    return true
  }
  async function reofferPending(value, claim) {
    const connection = [...connections.values()].find(row => row.generation === value.generation && row.auth.nodeInstanceId === value.nodeInstanceId)
    const live = () => connection && connections.get(connection.auth.nodeId) === connection && !connection.response.destroyed && !closed
    if (!live() || connection.scanning) return false
    let claimed = false
    await store.update(state => {
      const row = state.multisite.outbox.find(item => item.id === value.commandId)
      // Only ordinary Input delivery may be offered again. Cleanup and special
      // intent/manual/budget wakes retain their own human-controlled protocols.
      if (!reofferEligible(state, connection, row, value, true)) return state
      claimed = claim(state) === true
      return state
    })
    if (!claimed || !live()) return false
    // ACK or revocation may have committed while the durable claim returned.
    // Recheck before exposing the one suppressed ID to the original scan.
    const current = await store.read(), row = current.multisite.outbox.find(item => item.id === value.commandId)
    if (!reofferEligible(current, connection, row, value, true) || connection.scanning) return false
    const guard = { value: structuredClone(value), offered: false }
    connection.reofferGuards.set(row.id, guard)
    connection.sent.delete(row.id)
    await scan(connection)
    return guard.unconfirmed ? undefined : guard.offered
  }
  return { handle, kick, supervisionConnection, reofferPending, revoke(nodeId) { connections.get(nodeId)?.response.destroy() }, start() { if (timer) return; timer = setInterval(() => { for (const connection of connections.values()) void scan(connection) }, scanIntervalMs); timer.unref() }, close() { closed = true; clearInterval(timer); for (const connection of connections.values()) connection.response.destroy(); connections.clear() } }
}
