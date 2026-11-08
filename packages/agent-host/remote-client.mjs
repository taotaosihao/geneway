import { assertNodeTransport, createA2aNodeClient } from './a2a-client.mjs'
import { BRIDGE_LIMIT, COMMAND_FETCH_LIMIT, assertCommandReference } from '../agent-contracts/command-bytes.mjs'
import { randomUUID } from 'node:crypto'
import { assertSealed, binding, error } from '../agent-contracts/index.mjs'
import { SPREADSHEET_JSON_LIMIT } from '../agent-contracts/spreadsheet.mjs'

const LIMIT = BRIDGE_LIMIT
export async function readLimitedJson(response, maxBytes = LIMIT) {
  const chunks = []; let length = 0
  for await (const chunk of response.body ?? []) { length += chunk.length; if (length > maxBytes) { await response.body?.cancel().catch(() => {}); throw error('INVALID_RESPONSE', '节点响应超限') }; chunks.push(chunk) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw error('INVALID_RESPONSE', '节点响应格式无效') }
}
export async function* parseCommandStream(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = ''
  for await (const bytes of body) {
    pending += decoder.decode(bytes, { stream: true }); pending = pending.replace(/\r\n/g, '\n')
    if (Buffer.byteLength(pending) > LIMIT) throw error('INVALID_RESPONSE', '节点事件帧超限')
    for (;;) {
      const boundary = pending.indexOf('\n\n'); if (boundary < 0) break
      const frame = pending.slice(0, boundary).replace(/\r/g, ''); pending = pending.slice(boundary + 2)
      const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      if (!data) continue
      let command; try { command = JSON.parse(data) } catch { throw error('INVALID_RESPONSE', '节点事件格式无效') }
      yield command
    }
  }
  pending += decoder.decode()
  if (pending.trim()) throw error('INVALID_RESPONSE', '节点事件帧不完整')
}
export function createRemoteClient({ origin, identity, hostRunId = randomUUID(), fetchImpl = fetch, transport = 'internal' }) {
  assertNodeTransport(transport)
  const base = new URL(origin)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw error('INVALID_REQUEST', '云服务入口无效')
  const headers = () => ({ authorization: `Bearer ${identity.credential}`, 'x-geneway-node-instance': identity.nodeInstanceId, 'x-geneway-host-run': hostRunId })
  const a2a = transport === 'a2a' ? createA2aNodeClient({ origin, headers, fetchImpl }) : null
  const groupAbort = new AbortController(), groupA2a = transport === 'a2a' ? createA2aNodeClient({ origin, headers, fetchImpl, signal: groupAbort.signal }) : null
  let beforeRequest, cleanupOnly = false
  async function post(path, parameters, { attempts = 3, signal, responseLimit = LIMIT } = {}) {
    let last
    for (let index = 0; index < attempts; index++) {
      try {
        const response = await fetchImpl(new URL(path, base), { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(parameters), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) })
        const result = await readLimitedJson(response, responseLimit)
        if (!response.ok) {
          const cause = Object.assign(error(result.error?.code ?? 'REMOTE_UNAVAILABLE', result.error?.message ?? '节点请求失败'), { status: response.status }), capacity = result.error?.capacity
          if (cause.code === 'CAPACITY_EXCEEDED' && capacity?.domain === 'cloud' && capacity.queue === 'ordinary') {
            cause.capacity = { domain: 'cloud', queue: 'ordinary' }
            if (typeof capacity.reason === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(capacity.reason)) cause.capacity.reason = capacity.reason
            for (const field of ['count', 'bytes']) if (Number.isSafeInteger(capacity[field]) && capacity[field] >= 0) cause.capacity[field] = capacity[field]
          }
          throw cause
        }
        return result
      } catch (cause) {
        last = cause
        if (cause.status && cause.status < 500 || signal?.aborted || index === attempts - 1) throw cause
        await new Promise(resolve => setTimeout(resolve, 100 * (index + 1)))
      }
    }
    throw last
  }
  async function evidenceGet(path, token, limit = LIMIT) {
    const response = await fetchImpl(new URL(path, base), { headers: { ...headers(), 'x-geneway-evidence-token': token }, redirect: 'error', signal: AbortSignal.timeout(8000) }), value = await readLimitedJson(response, limit)
    if (!response.ok) throw Object.assign(error(value.error?.code ?? 'REMOTE_UNAVAILABLE'), { status: response.status })
    return value
  }
  return {
    hostRunId, get cleanupOnly() { return cleanupOnly }, post,
    async resolveCommand(delivery) {
      if (delivery?.kind === 'command_unavailable') throw Object.assign(error('COMMAND_UNAVAILABLE', '原命令无法读取，可停止此执行。'), { commandId: delivery.commandId })
      if (delivery?.kind !== 'command_ref') return delivery
      const reference = assertCommandReference(delivery)
      const command = await post('/internal/bridge/command', { commandId: reference.commandId, payloadDigest: reference.payloadDigest }, { responseLimit: COMMAND_FETCH_LIMIT })
      assertSealed(command)
      if (command.command_id !== reference.commandId || command.payload_digest !== reference.payloadDigest) throw error('IDEMPOTENCY_CONFLICT', '取回命令与引用不匹配')
      return command
    },
    setBeforeRequest(value) { beforeRequest = value },
    async authorize(execution) { return post('/internal/executions/authorize', { binding: binding(execution) }) },
    async issue(execution, options = {}) {
      if (options.request) await beforeRequest?.(execution, options.inputMessageId)
      const parameters = { binding: binding(execution), options: { ...options, clientRequestId: randomUUID() } }
      return post('/internal/executions/tokens', parameters)
    },
    issueIntentReview(execution,commandId,options={}) { return post('/internal/executions/intent-review',{binding:binding(execution),commandId,options:{...options,clientRequestId:randomUUID()}}) },
    issueBudgetResume(execution, commandId, options = {}) { return post('/internal/executions/budget-resume', { binding: binding(execution), commandId, options:{...options,clientRequestId:randomUUID()} }) },
    registerVariant(execution, variant) { return post('/internal/executions/image-variants', { binding: binding(execution), variant }) },
    evidence: {
      authorize(execution, instructionRevision, resourceId, window) { return post('/internal/evidence/authorize', { binding: binding(execution), instructionRevision, resourceId, ...(window === undefined ? {} : { window }) }) },
      init(declaration) { return post('/internal/evidence/init', declaration) },
      resume(row, signal) { return post('/internal/evidence/resume-upload', { binding: binding(row.producerBinding), captureId: row.id, declarationDigest: row.declarationDigest }, { signal }) },
      async publish(issued, bytes, signal) {
        const response = await fetchImpl(new URL(`/internal/evidence/${issued.id}/content`, base), { method: 'PUT', headers: { ...headers(), 'x-geneway-evidence-token': issued.token, 'content-type': 'application/json' }, body: bytes, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }), value = await readLimitedJson(response)
        if (!response.ok) throw Object.assign(error(value.error?.code ?? 'REMOTE_UNAVAILABLE'), { status: response.status }); return value
      },
      async read(execution, instructionRevision, parameters) {
        const issued = await post('/internal/evidence/read-token', { binding: binding(execution), instructionRevision, ref: parameters.ref })
        const suffix = parameters.cursor === undefined ? '' : `?cursor=${encodeURIComponent(parameters.cursor)}`
        return evidenceGet(`/internal/evidence/${parameters.ref.id}/content${suffix}`, issued.token, 16384)
      },
      async metadata(execution, instructionRevision, ref) { const issued = await post('/internal/evidence/read-token', { binding: binding(execution), instructionRevision, ref }); return evidenceGet(`/internal/evidence/${ref.id}`, issued.token) },
    },
    group: groupA2a ? {
      async receive(execution, { signal } = {}) {
        const operationId = randomUUID(), reply = await groupA2a.message({ schema: 'geneway.a2a.work-group/1', operation: 'receive', operationId, binding: binding(execution) }, { signal })
        if (!reply || reply.schema !== 'geneway.a2a.work-group/1' || reply.operation !== 'receive' || reply.operationId !== operationId || !Array.isArray(reply.deliveries) || reply.deliveries.length > 8 || ![null, 'string'].includes(reply.groupId === null ? null : typeof reply.groupId) || ![null, 'string'].includes(reply.contextId === null ? null : typeof reply.contextId)) throw error('INVALID_RESPONSE', '群收件元数据无效')
        for (const row of reply.deliveries) if (!['deliveryId', 'locator', 'payloadDigest'].every(field => typeof row[field] === 'string' && row[field].length > 0 && row[field].length <= 512)) throw error('INVALID_RESPONSE', '群收件元数据无效')
        if (reply.deliveries.length && (!reply.groupId || !reply.contextId)) throw error('INVALID_RESPONSE', '群收件绑定无效')
        return { groupId: reply.groupId, contextId: reply.contextId, deliveries: reply.deliveries.map(({ deliveryId, locator, payloadDigest }) => ({ deliveryId, locator, payloadDigest })) }
      },
      async body(execution, locator, { signal } = {}) {
        const reply = await post('/internal/a2a/group-body', { binding: binding(execution), locator }, { signal, attempts: 1, responseLimit: 16 * 1024 })
        if (!reply || reply.workId !== execution.work_id || typeof reply.sourceMessageId !== 'string' || typeof reply.kind !== 'string' || !Number.isInteger(reply.revision) || typeof reply.text !== 'string' || !Number.isInteger(reply.evidenceCount) || reply.evidenceCount < 0 || Object.keys(reply).some(field => !['workId', 'sourceMessageId', 'kind', 'revision', 'text', 'evidenceCount'].includes(field))) throw error('INVALID_RESPONSE', '群正文响应无效')
        return reply
      },
      async ack(execution, { deliveryId, locator, payloadDigest }, { signal, operationId = randomUUID() } = {}) {
        const reply = await groupA2a.message({ schema: 'geneway.a2a.work-group/1', operation: 'ack', operationId, binding: binding(execution), deliveryId, locator, payloadDigest }, { signal })
        if (!reply || reply.schema !== 'geneway.a2a.work-group/1' || reply.operation !== 'ack' || reply.operationId !== operationId || reply.accepted !== true) throw error('INVALID_RESPONSE', '群收件回执无效')
        for (const [field, value] of Object.entries({ deliveryId, locator, payloadDigest })) if (reply[field] !== undefined && reply[field] !== value) throw error('INVALID_RESPONSE', '群收件回执不匹配')
        return reply
      },
      close() { groupAbort.abort() },
    } : null,
    context: { read(execution, parameters, modelStep) { return post('/internal/context/read', { binding: binding(execution), parameters, modelStep }, { responseLimit: 16384 }) } },
    spreadsheet: {
      authorize(execution) { return post('/internal/spreadsheets/authorize', { binding: binding(execution) }) },
      readEvidence(execution, parameters) { return post('/internal/spreadsheets/read', { binding: binding(execution), parameters }) },
      prepare(execution, parameters) { return post('/internal/spreadsheets/prepare', { binding: binding(execution), parameters }, { responseLimit: SPREADSHEET_JSON_LIMIT }) },
      async revalidate(execution, input) {
        try { return await post('/internal/spreadsheets/revalidate', { binding: binding(execution), ...(execution.id && execution.inputDigest ? {job:{id:execution.id,inputDigest:execution.inputDigest}} : {}), input: { instructionRevision: input.instructionRevision, dueDate: input.dueDate, ...(input.sourceManifest ? { sourceManifest: input.sourceManifest, sourceManifestDigest: input.sourceManifestDigest, ...(input.inputEncodingVersion === 2 ? { inputEncodingVersion: 2 } : { rows: input.rows, jobId: execution.id, inputDigest: execution.inputDigest }) } : {}) } }) }
        catch (cause) { if (!cause.status || cause.status >= 500) cause.retryableConnection = true; throw cause }
      },
      candidateReceipt(execution, jobId) { return post('/internal/spreadsheets/candidate', { binding: binding(execution), jobId }) },
      issueUploadToken(job) { return post('/internal/spreadsheets/upload-token', { binding: binding(job), jobId: job.id }) },
    },
    command(execution, operation, parameters, { manualFence } = {}) { const value = { binding: binding(execution), operation, parameters, ...(manualFence ? { manualFence } : {}) }; return a2a ? a2a.command({ schema: 'geneway.a2a.node-command/1', ...value }) : post('/internal/agent/commands', value) },
    event(event) { return post(event.kind === 'spreadsheet_job' ? '/internal/spreadsheets/job-events' : '/internal/bridge/events', { event }) },
    ack(command) { return post('/internal/bridge/acks', { commandId: command.command_id, payloadDigest: command.payload_digest, binding: binding(command), nodeInstanceId: identity.nodeInstanceId, registrationRevision: identity.registrationRevision }) },
    async resync() { const result = await post('/internal/bridge/resync', { hostRunId }); cleanupOnly = result.status === 'cleanup_only'; return result },
    async stream(signal) {
      const headersAbort = new AbortController(), timeout = setTimeout(() => headersAbort.abort(), 8000); timeout.unref()
      let response
      try { response = await fetchImpl(new URL('/internal/bridge/events', base), { headers: { ...headers(), accept: 'text/event-stream' }, redirect: 'error', signal: AbortSignal.any([signal, headersAbort.signal]) }) } finally { clearTimeout(timeout) }
      if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) { const result = await readLimitedJson(response); throw error(result.error?.code ?? 'REMOTE_UNAVAILABLE') }
      return parseCommandStream(response.body)
    },
  }
}
