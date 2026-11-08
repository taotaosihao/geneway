import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { digest, error, exact } from '../packages/agent-contracts/index.mjs'
import { employeeModelRoute } from './model-route.mjs'
import { readModelCredential } from './runtime-config.mjs'
import { estimateModelRequest, knownUsageCost, normalizeModelUsage, chargedModelTokens } from './work-budget.mjs'
import { authorizeDiagnosisRecord } from './supervision-diagnosis-facts.mjs'
import { SUPERVISION_DIAGNOSIS_LIMITS as limits, SUPERVISION_DIAGNOSIS_PROMPT as prompt } from './supervision-diagnosis-state.mjs'

export function diagnosisPolicy(state, access, identity) {
  const policy = state.budgetPolicies.find(row => row.id === identity.budgetPolicyId && row.enabled && row.workspaceId === access.work.workspaceId && row.coordinatorAgentId === access.work.employeeId)
  const employee = state.employees.find(row => row.id === access.work.employeeId && row.enabled)
  if (!policy || !employee) throw error('DIAGNOSIS_POLICY_UNAVAILABLE')
  const route = employeeModelRoute(state, employee), rows = state.modelRequests.filter(row => row.purpose === 'supervision_diagnosis' && row.source.subjectBinding.work_id === access.work.id)
  const anchor = rows[0]
  if (anchor && (!isDeepStrictEqual(anchor.modelSnapshot, route) || !isDeepStrictEqual(anchor.budgetPolicySnapshot, policy))) throw error('DIAGNOSIS_POLICY_CHANGED')
  if (!policy.modelPrices.some(row => row.provider === route.provider && row.model === route.model)) throw error('BUDGET_PRICE_MISSING')
  return { policy, route, rows }
}
export function assertDiagnosisBudget(state, access, identity, body, now = Date.now()) {
  if (state.modelRequests.length >= 30000) throw error('CAPACITY_EXCEEDED')
  const { policy, route, rows } = diagnosisPolicy(state, access, identity)
  const output = Math.min(limits.maxOutputTokens, route.parameters.maxOutputTokens)
  const estimator = policy.estimator, price = policy.modelPrices.find(row => row.provider === route.provider && row.model === route.model), ceil = (n, d) => (n + d - 1n) / d
  const input = ceil(BigInt(limits.maxBodyBytes) * BigInt(estimator.inputBytesNumerator), BigInt(estimator.inputBytesDenominator)) + BigInt(estimator.fixedInputTokens)
  const upper = { totalTokens: Number(input + BigInt(output)), costMicros: Number(ceil(input * BigInt(price.inputMicrosPerMillionTokens), 1000000n) + ceil(BigInt(output) * BigInt(price.outputMicrosPerMillionTokens), 1000000n)) }
  const accounting = body ? estimateModelRequest({ policySnapshot: policy }, route, body) : null, estimate = accounting?.estimate ?? upper
  const tokenCost = rows.reduce((sum, row) => sum + chargedModelTokens(row), 0n), money = rows.reduce((sum, row) => sum + BigInt(Math.max(row.estimate.costMicros, row.usageCostMicros ?? 0)), 0n)
  if (rows.some(row => row.outcome === 'unknown') || rows.length >= Math.min(limits.maxCalls, policy.limits.maxModelRequests) || tokenCost + BigInt(estimate.totalTokens) > BigInt(Math.min(limits.maxReservedTokens, policy.limits.maxReservedTokens)) || money + BigInt(estimate.costMicros) > BigInt(Math.min(limits.maxReservedCostMicros, policy.limits.maxReservedCostMicros))) throw error('DIAGNOSIS_BUDGET_EXCEEDED')
  if (rows.length && now - Date.parse(rows.at(-1).reservedAt) < limits.cooldownMs) throw error('DIAGNOSIS_COOLDOWN')
  return { policy, route, accounting, output }
}
export function createSupervisionDiagnosisGateway({ store, config, base, fetchImpl, clock, identities, nodeBridge, isOwnedExecutionInFlight }) {
  const tokens = new Map(), active = new Map()
  let closed = false
  const options = () => ({ identities, nodeBridge, isOwnedExecutionInFlight, now: clock() })
  async function updateLedger(id, values) { await store.update(state => { const row = state.modelRequests.find(row => row.id === id); if (row && row.outcome === 'unknown') Object.assign(row, values); return state }) }
  async function handle(request, response, url) {
    if (url.pathname !== '/internal/model/supervision/v1/chat/completions') return false
    let ledgerId, sent = false, usage = null, timer
    const controller = new AbortController(), requestKey = Symbol()
    const disconnect = () => { if (!response.writableEnded) controller.abort() }
    const assertOpen = () => { if (closed) throw error('PROCESS_SHUTDOWN'); if (controller.signal.aborted || response.destroyed) throw error('REQUEST_ABORTED') }
    active.set(requestKey, controller); response.once('close', disconnect)
    try {
      if (closed || request.method !== 'POST' || url.search) throw error('FORBIDDEN')
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '')?.[1], record = tokens.get(token)
      if (!record || record.used || clock() >= record.expiresAt) throw error('UNAUTHORIZED')
      record.used = true
      const chunks = []; let size = 0
      for await (const chunk of request) { size += chunk.length; if (size > limits.maxBodyBytes) throw error('INVALID_REQUEST'); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks)), before = await store.read(), diagnosis = before.supervisionDiagnoses.find(row => row.id === record.id)
      if (!diagnosis || clock() >= Date.parse(diagnosis.deadlineAt)) throw error('EXECUTION_DEADLINE')
      let access = authorizeDiagnosisRecord(before, diagnosis, options()), budget = assertDiagnosisBudget(before, access, access.identity, body, clock())
      exact(body, ['model', 'messages', 'stream', 'max_tokens', 'tools', 'store', 'stream_options'])
      if (body.model !== diagnosis.modelSnapshot.model || body.stream !== true || body.max_tokens !== budget.output || body.store !== undefined && body.store !== false || body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length) || body.messages?.length !== 2 || body.messages[0].role !== 'system' || body.messages[0].content !== prompt || body.messages[1].role !== 'user' || body.messages[1].content !== JSON.stringify(diagnosis.packet)) throw error('INVALID_REQUEST', '诊断请求不是本次受限事实包')
      if (body.stream_options !== undefined) { exact(body.stream_options, ['include_usage']); if (body.stream_options.include_usage !== true) throw error('INVALID_REQUEST') }
      const credential = await readModelCredential(config)
      await store.update(state => {
        assertOpen()
        const current = state.supervisionDiagnoses.find(row => row.id === diagnosis.id)
        access = authorizeDiagnosisRecord(state, current, options()); budget = assertDiagnosisBudget(state, access, access.identity, body, clock())
        if (state.modelRequests.some(row => row.id === current.modelRequestId)) throw error('RUNTIME_REQUEST_UNKNOWN')
        ledgerId = current.modelRequestId
        state.modelRequests.push({ id: ledgerId, purpose: 'supervision_diagnosis', source: { findingId: current.findingId, episodeId: current.episodeId, grantId: current.grantId, grantRevision: current.grantRevision, subjectBinding: structuredClone(current.subjectBinding), instructionRevision: current.instructionRevision }, diagnosisSessionId: current.sessionId, modelSnapshot: structuredClone(current.modelSnapshot), budgetPolicySnapshot: structuredClone(current.budgetPolicySnapshot), ...budget.accounting, bodyDigest: digest(body), reservedAt: new Date(clock()).toISOString(), outcome: 'unknown', usage: null, usageCostMicros: null, completedAt: null, noForwardReason: null })
        current.state = 'running'; return state
      })
      const fresh = await store.read(), current = fresh.supervisionDiagnoses.find(row => row.id === diagnosis.id)
      access = authorizeDiagnosisRecord(fresh, current, options()); diagnosisPolicy(fresh, access, access.identity)
      if (clock() >= Date.parse(current.deadlineAt)) throw error('EXECUTION_DEADLINE')
      assertOpen()
      timer = setTimeout(() => controller.abort(), Date.parse(current.deadlineAt) - clock()); timer.unref()
      assertOpen(); sent = true
      const upstream = await fetchImpl(new URL(base.href.replace(/\/$/, '') + '/chat/completions'), { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: controller.signal })
      if (!upstream.ok) { await upstream.body?.cancel(); await updateLedger(ledgerId, { outcome: 'failed', completedAt: new Date(clock()).toISOString() }); throw error('UPSTREAM_ERROR') }
      if (!upstream.headers.get('content-type')?.startsWith('text/event-stream')) { await upstream.body?.cancel(); throw error('UPSTREAM_ERROR') }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      let pending = '', done = false, finished = false, invalid = false, bytes = 0
      const decoder = new TextDecoder('utf-8', { fatal: true })
      for await (const chunk of upstream.body) {
        bytes += chunk.length; if (bytes > 262144) throw error('INVALID_RESPONSE')
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split('\n'); pending = lines.pop()
        for (const line of lines) if (line.startsWith('data: ')) {
          const data = line.slice(6).trim(); if (data === '[DONE]') { done = true; continue }
          const event = JSON.parse(data); if (event.error) invalid = true; if (event.usage) usage = normalizeModelUsage(event.usage)
          if (event.choices?.some(choice => ['stop', 'length', 'tool_calls'].includes(choice.finish_reason))) finished = true
        }
        response.write(chunk)
      }
      if (!done || !finished || invalid) throw error('RUNTIME_REQUEST_UNKNOWN')
      const ledger = (await store.read()).modelRequests.find(row => row.id === ledgerId)
      await updateLedger(ledgerId, { outcome: 'completed', usage, usageCostMicros: knownUsageCost(usage, ledger.modelPriceSnapshot), completedAt: new Date(clock()).toISOString() })
      response.end()
    } catch (cause) {
      if (ledgerId) { const row = (await store.read()).modelRequests.find(row => row.id === ledgerId); if (row) await updateLedger(ledgerId, { ...(sent ? {} : { outcome: 'failed', noForwardReason: /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code) ? cause.code : 'DIAGNOSIS_NOT_FORWARDED' }), usage, usageCostMicros: knownUsageCost(usage, row.modelPriceSnapshot), completedAt: new Date(clock()).toISOString() }) }
      if (response.headersSent) response.destroy()
      else { response.writeHead(cause.code === 'UNAUTHORIZED' ? 401 : cause.code === 'FORBIDDEN' ? 403 : 409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: cause.code ?? 'DIAGNOSIS_GATEWAY_UNAVAILABLE' } })) }
    } finally { clearTimeout(timer); active.delete(requestKey); response.off('close', disconnect) }
    return true
  }
  return { handle, issue(id, deadlineAt) { if (closed) throw error('PROCESS_SHUTDOWN'); const token = randomBytes(32).toString('base64url'); tokens.set(token, { id, expiresAt: Date.parse(deadlineAt), used: false }); return token }, close() { closed = true; tokens.clear(); for (const value of active.values()) value.abort() } }
}
