import { SITE_RULE_TOOLS, siteRuleRuntime, siteModelReadIds } from './site-rule-state.mjs'
import { assertEvidenceReader } from './evidence-access.mjs'
import { createSupervisionDiagnosisGateway } from './supervision-diagnosis-gateway.mjs'
import { validateSupervisionDiagnosisLedger } from './supervision-diagnosis-state.mjs'
import { continuationReaderSource } from './context-read-access.mjs'
import { CONTEXT_READ_TOOL } from '../packages/agent-contracts/context-read.mjs'
import { assertManualExecution, assertManualConsumption, manualFence } from './manual-control.mjs'
import { consumedManualResumeForMessage } from './manual-resume.mjs'
import { authorizeIntentDelivery, authorizeBudgetIntentResume, pendingIntentReview, INTENT_TOOL_NAMES } from './interaction-state.mjs'
import { createRoutingGateway, validateRoutingLedger } from './routing-gateway.mjs'
import { consumedSpreadsheetPages } from './spreadsheet-candidate-read.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { queueExecutionCommand } from '../packages/agent-orchestration/commands.mjs'
import { queueBudgetWait } from '../packages/agent-orchestration/budgets.mjs'
import { reserveModelBudget, settleModelAccounting, knownUsageCost, assertModelAccounting, budgetTokenExpiry, normalizeModelUsage } from './work-budget.mjs'
import { multisiteToolNames } from '../packages/agent-contracts/tools.mjs'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { once } from 'node:events'
import { binding, digest, error, key, exact, sameBinding } from '../packages/agent-contracts/index.mjs'
import { authorizeMultisiteExecution, authorizeBudgetControlCommand } from './multisite-authorization.mjs'
import { readModelCredential } from './runtime-config.mjs'
import { MODEL_BASE_URL } from './model-route.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = (code, message, status) => Object.assign(error(code, message), { status })
const check = (condition, label) => { if (!condition) throw error('INVALID_STATE', `模型代理状态无效：${label}`) }
export function validateModelGatewayState(state) {
  check(Array.isArray(state.modelRequests) && Array.isArray(state.modelImageVariants), '事务域缺失')
  for (const [rows, label] of [[state.modelRequests, '请求'], [state.modelImageVariants, '图像派生']]) {
    check(rows.length <= 30_000 && new Set(rows.map(row => row.id)).size === rows.length, `${label}容量或身份`)
    for (const row of rows) {
      if (label === '请求' && row.purpose === 'supervision_diagnosis') { validateSupervisionDiagnosisLedger(state, row); continue }
      if (label === '请求' && row.purpose === 'routing') { validateRoutingLedger(state, row); continue }
      const attempt = state.multisite.attempts.find(item => item.attempt_id === row.attempt_id)
      check(attempt && isDeepStrictEqual({ ...binding(attempt), session_id: row.session_id }, binding(row)) && typeof row.session_id === 'string', `${label}绑定`)
    }
  }
  for (const attempt of state.multisite.attempts) check(state.modelRequests.filter(row => row.attempt_id === attempt.attempt_id).length <= attempt.modelRequestsReserved, '请求事实不得超出已预留预算')
  for (const row of state.modelRequests) {
    if (['routing', 'supervision_diagnosis'].includes(row.purpose)) continue
    exact(row, ['id', ...Object.keys(binding(row)), 'instructionRevision', 'bodyDigest', 'reservedAt', 'outcome', 'usage', 'completedAt', 'imageVariantIds', 'accountingVersion', 'budgetRevisionAtReservation', 'forwardedBodyBytes', 'modelPriceSnapshot', 'estimate', 'usageCostMicros', 'overReservation', 'resumedFromHoldId', 'spreadsheetReadReceiptIds', 'purpose', 'intentFence', 'intentReviewCommandId', 'inputMessageId', 'intentBudgetResumeCommandId', 'manualFence', 'manualResumeCommandId', 'contextReadEnabled', 'contextReadReceiptIds'])
    if (row.contextReadEnabled !== undefined) check(typeof row.contextReadEnabled === 'boolean' && typeof row.inputMessageId === 'string', '资料读取真实模型轮次')
    if (row.contextReadReceiptIds !== undefined) check(Array.isArray(row.contextReadReceiptIds) && new Set(row.contextReadReceiptIds).size === row.contextReadReceiptIds.length && row.contextReadReceiptIds.every(id => state.contextReads.some(read => read.id === id && sameBinding(read.receiverBinding, row))), '资料页模型消费')
    if (row.manualFence !== undefined) { exact(row.manualFence, ['workGeneration', 'agentGeneration']); check(['workGeneration', 'agentGeneration'].every(field => Number.isSafeInteger(row.manualFence[field]) && row.manualFence[field] >= 0), '人工控制代次快照') }
    if (row.manualResumeCommandId !== undefined) { const command = state.multisite.outbox.find(entry => entry.id === row.manualResumeCommandId)?.command; check(command && sameBinding({ ...command, session_id: command.session_id ?? `geneway-${command.launch_id}` }, row) && row.inputMessageId === messageId(command.input_id, row.attempt_id, row.session_id) && state.manualControls.some(control => control.holders.some(holder => holder.resumeCommandId === command.command_id && holder.resumeConsumedAt && isDeepStrictEqual(holder.resumeFence, row.manualFence))), '人工续行实际消费来源') }
    if (row.purpose !== undefined) { const command = state.multisite.outbox.find(entry => entry.id === row.intentReviewCommandId)?.command; check(row.purpose === 'intent_review' && command?.operation === 'intent_review' && isDeepStrictEqual(command.parameters.intentFence, row.intentFence) && isDeepStrictEqual(binding(row), row.intentFence.handlerBinding) && command.instruction_revision === row.instructionRevision && (row.intentBudgetResumeCommandId ? (()=>{const resume=state.multisite.outbox.find(entry=>entry.id===row.intentBudgetResumeCommandId)?.command,hold=state.budgetHolds.find(hold=>hold.resumeCommandId===resume?.command_id);return resume&&sameBinding(resume,row)&&hold?.intentReview?.commandId===command.command_id&&isDeepStrictEqual(hold.intentReview.intentFence,row.intentFence)&&row.inputMessageId===messageId(resume.input_id,row.attempt_id,row.session_id)})() : row.inputMessageId === messageId(command.input_id, row.attempt_id, row.session_id)), '意图模型用途绑定') }
    check(Number.isSafeInteger(row.instructionRevision) && row.instructionRevision > 0 && /^[a-f0-9]{64}$/.test(row.bodyDigest) && Number.isFinite(Date.parse(row.reservedAt)) && ['unknown', 'completed', 'failed'].includes(row.outcome), '请求事实')
    check(row.completedAt === null || Number.isFinite(Date.parse(row.completedAt)), '请求结束时间')
    check(row.usage === null || Object.keys(row.usage).every(field => ['prompt_tokens', 'completion_tokens', 'total_tokens'].includes(field)) && Object.values(row.usage).every(value => Number.isSafeInteger(value) && value >= 0), 'usage')
    if (row.accountingVersion !== undefined) assertModelAccounting(state, row)
    if (row.spreadsheetReadReceiptIds !== undefined) check(Array.isArray(row.spreadsheetReadReceiptIds) && new Set(row.spreadsheetReadReceiptIds).size === row.spreadsheetReadReceiptIds.length && row.spreadsheetReadReceiptIds.every(id => state.spreadsheetReads.some(read => read.id === id && isDeepStrictEqual(binding(read), binding(row)) && read.instructionRevision === row.instructionRevision)), '候选页模型消费引用')
    check(Array.isArray(row.imageVariantIds) && row.imageVariantIds.every(id => state.modelImageVariants.some(variant => variant.id === id && variant.attempt_id === row.attempt_id)), '请求图片引用')
  }
  for (const row of state.modelImageVariants) {
    exact(row, ['id', ...Object.keys(binding(row)), 'originalRef', 'normalizedRef', 'variantId', 'sha256', 'mediaType', 'sizeBytes', 'width', 'height'])
    check(row.originalRef && state.attachments.some(item => item.id === row.originalRef.attachmentId && item.workId === row.work_id && item.sha256 === row.originalRef.sha256 && item.version === row.originalRef.version), '派生来源')
    check(/^[a-f0-9]{64}$/.test(row.sha256) && /^sha256:[a-f0-9]{64}$/.test(row.normalizedRef?.attachmentId) && typeof row.variantId === 'string' && ['image/png', 'image/jpeg', 'image/webp'].includes(row.mediaType) && [row.sizeBytes, row.width, row.height].every(value => Number.isSafeInteger(value) && value > 0), '派生事实')
  }
  return state
}
export function assertModelGatewayImmutable(before, after) {
  for (const row of before.modelImageVariants) check(isDeepStrictEqual(row, after.modelImageVariants.find(item => item.id === row.id)), '派生事实不可改写')
  for (const row of before.modelRequests) {
    const next = after.modelRequests.find(item => item.id === row.id)
    check(next && isDeepStrictEqual({ ...row, outcome: undefined, usage: undefined, completedAt: undefined, usageCostMicros: undefined, overReservation: undefined, ...(['routing', 'supervision_diagnosis'].includes(row.purpose) ? { noForwardReason: undefined } : {}) }, { ...next, outcome: undefined, usage: undefined, completedAt: undefined, usageCostMicros: undefined, overReservation: undefined, ...(['routing', 'supervision_diagnosis'].includes(row.purpose) ? { noForwardReason: undefined } : {}) }), '请求预留不可改写')
    if (row.outcome !== 'unknown' || row.completedAt) check(isDeepStrictEqual(row, next), '请求结论不可改写')
  }
}

export function createModelGateway({ store, attachments, config, upstreamBaseUrl = MODEL_BASE_URL, fetchImpl = fetch, clock = () => Date.now(), tokenTtlMs = 5 * 60_000 }) {
  const base = new URL(upstreamBaseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('模型上游地址无效')
  const routing = createRoutingGateway({ store, config, base, fetchImpl, clock })
  let contextReader
  const tokens = new Map(), activeRequests = new Map(), deadlines = new Map()
  async function authorize(execution, inputMessageId, allowActive = true) {
    const state = await store.read(), result = authorizeMultisiteExecution(state, execution, { inputMessageId })
    if (pendingIntentReview(state, execution)) throw error('FORBIDDEN', '本轮只允许已绑定意图的判断用途')
    if (state.modelRequests.some(row => row.attempt_id === execution.attempt_id && row.session_id === execution.session_id && row.outcome === 'unknown' && (!allowActive || !activeRequests.has(row.id)))) throw error('RUNTIME_REQUEST_UNKNOWN', '已有结果未知的模型请求，禁止自动恢复重发')
    if (result.refs.length) { if (!attachments) throw error('FORBIDDEN'); await attachments.verifyReferences(state, result.refs) }
    const latest = await store.read(), access = authorizeMultisiteExecution(latest, execution, { inputMessageId })
    if (pendingIntentReview(latest, execution)) throw error('FORBIDDEN')
    return { state: latest, ...access }
  }
  function tokenRecord(request, purpose) {
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '')?.[1], record = tokens.get(token)
    if (!record || clock() >= record.expiresAt || !(purpose === 'execution' ? ['execution', 'intent_review'] : ['execution', 'attachments']).includes(record.purpose)) throw fail('UNAUTHORIZED', '执行令牌无效或已过期', 401)
    return record
  }
  async function issue(execution, { request = false, inputMessageId, refresh = false, requestId = randomUUID() } = {}) {
    const result = await authorize(execution, inputMessageId, request || refresh)
    if (request && inputMessageId === undefined) throw error('REVISION_CONFLICT', '请求缺少真实输入消息身份')
    return mint(execution, result, { request, inputMessageId, requestId })
  }
  function contextEnabled(state, execution) { if (state.works.some(row => row.id === execution.work_id && row.origin === 'rule')) return false; try { continuationReaderSource(state, execution); return true } catch { return false } }
  function authorizeContextModelStep(state, execution, modelStep) {
    exact(modelStep, ['requestId', 'inputMessageId', 'manualFence'])
    assertManualExecution(state, execution, modelStep.manualFence); assertManualConsumption(state, execution)
    const requests = state.modelRequests.filter(row => row.purpose !== 'routing' && sameBinding(row, execution)), row = requests.at(-1)
    if (!row || row.id !== modelStep.requestId || row.inputMessageId !== modelStep.inputMessageId || row.contextReadEnabled !== true || !isDeepStrictEqual(row.manualFence, modelStep.manualFence) || row.instructionRevision !== state.works.find(work => work.id === execution.work_id)?.instructionRevision || row.outcome !== 'completed' && !(row.outcome === 'unknown' && activeRequests.has(row.id))) throw error('CONTEXT_READ_UNAVAILABLE', '当前模型轮次未获准读取资料')
    const access = row.purpose === 'intent_review' ? row.intentBudgetResumeCommandId ? authorizeBudgetIntentResume(state, state.multisite.outbox.find(item => item.id === row.intentBudgetResumeCommandId)?.command, { request: true, inputMessageId: row.inputMessageId }) : authorizeIntentDelivery(state, state.multisite.outbox.find(item => item.id === row.intentReviewCommandId)?.command, { requireConsumed: true }) : authorizeMultisiteExecution(state, execution, { inputMessageId: row.inputMessageId })
    if (row.purpose !== 'intent_review' && pendingIntentReview(state, execution)) throw error('FORBIDDEN')
    return { ...access, modelRequest: row }
  }
  function mint(execution, result, { request = false, inputMessageId, requestId = randomUUID(), intentReviewCommandId, intentBudgetResumeCommandId } = {}) {
    for (const [token, entry] of tokens) if (clock() >= entry.expiresAt) tokens.delete(token)
    const token = randomBytes(32).toString('base64url'), expiresAt = budgetTokenExpiry(result.work, clock() + tokenTtlMs, clock())
    const controlFence = manualFence(result.state, execution)
    tokens.set(token, { execution: structuredClone(execution), manualFence: controlFence, purpose: intentReviewCommandId ? 'intent_review' : request ? 'execution' : 'attachments', ...(intentReviewCommandId ? { intentReviewCommandId, intentFence: structuredClone(result.intentFence), ...(intentBudgetResumeCommandId?{intentBudgetResumeCommandId}:{}) } : {}), expiresAt, requestId, instructionRevision: result.current.instruction_revision, inputMessageId })
    return { token, expiresAt, ...(request ? { modelStep: { requestId, inputMessageId, manualFence: controlFence } } : {}), contextReadEnabled: contextEnabled(result.state, execution), manualFence: controlFence, modelSnapshot: result.current.modelSnapshot, spreadsheetRequest: result.work.spreadsheetRequest ?? null, activeCollaboration: !!result.current.grant, executionGrant: result.current.grant ?? null, ...(result.work.origin === 'rule' ? { siteRule: siteRuleRuntime(result.work) } : {}), ...(intentReviewCommandId ? { intentReviewCommandId, intentFence: result.intentFence } : {}), imageMappings: result.state.modelImageVariants.filter(row => row.attempt_id === execution.attempt_id) }
  }
  async function reviewAuthority(execution, commandId, { request = false, inputMessageId, intentBudgetResumeCommandId } = {}) {
    const state = await store.read(), command = state.multisite.outbox.find(row => row.id === commandId)?.command
    if (request) assertManualConsumption(state, execution)
    if (!command || !isDeepStrictEqual({ ...binding(command), session_id: command.session_id ?? `geneway-${command.launch_id}` }, binding(execution))) throw error('FORBIDDEN')
    const access = intentBudgetResumeCommandId ? authorizeBudgetIntentResume(state,state.multisite.outbox.find(row=>row.id===intentBudgetResumeCommandId)?.command,{request,inputMessageId}) : authorizeIntentDelivery(state, command, { requireConsumed: request })
    if (!intentBudgetResumeCommandId && request && inputMessageId !== messageId(command.input_id, execution.attempt_id, execution.session_id)) throw error('REVISION_CONFLICT')
    if (state.modelRequests.some(row => row.attempt_id === execution.attempt_id && row.session_id === execution.session_id && row.outcome === 'unknown' && !activeRequests.has(row.id))) throw error('RUNTIME_REQUEST_UNKNOWN')
    return { state, ...access, intentFence: command.parameters.intentFence }
  }
  async function issueIntentReview(execution, commandId, options = {}) {
    const access = await reviewAuthority(execution, commandId, options)
    return mint(execution, access, { ...options, intentReviewCommandId: commandId })
  }
  async function issueBudgetResume(execution, commandId, options = {}) {
    const state = await store.read(), command = state.multisite.outbox.find(row => row.id === commandId)?.command
    assertManualExecution(state, execution)
    if (options.request) assertManualConsumption(state, execution)
    if (!command || !isDeepStrictEqual({ ...binding(command), session_id: command.session_id ?? `geneway-${command.launch_id}` }, binding(execution)) || command.parameters.messages?.[0]?.kind !== 'budget_resume') throw error('FORBIDDEN')
    const hold=state.budgetHolds.find(row=>row.resumeCommandId===commandId)
    if(hold?.intentReview){const access=authorizeBudgetIntentResume(state,command,options);return mint(execution,{state,...access},{...options,intentReviewCommandId:hold.intentReview.commandId,intentBudgetResumeCommandId:commandId})}
    const access = authorizeBudgetControlCommand(state, command)
    if(options.request){if(typeof options.inputMessageId!=='string')throw error('REVISION_CONFLICT');return mint(execution,await authorize(execution,options.inputMessageId),options)}
    return mint(execution, { state, ...access }, options)
  }
  async function registerVariant(execution, value) {
    exact(value, ['originalRef', 'normalizedRef', 'variantId', 'sha256', 'mediaType', 'sizeBytes', 'width', 'height'])
    await authorize(execution)
    await store.update(state => {
      const access = authorizeMultisiteExecution(state, execution)
      if (!access.refs.some(ref => isDeepStrictEqual(ref, value.originalRef))) throw error('FORBIDDEN')
      const row = { id: key(execution.attempt_id, value.originalRef.attachmentId, value.normalizedRef.attachmentId, value.variantId), ...binding(execution), ...structuredClone(value) }
      const old = state.modelImageVariants.find(item => item.id === row.id)
      if (old && !isDeepStrictEqual(old, row)) throw error('IDEMPOTENCY_CONFLICT')
      if (!old) state.modelImageVariants.push(row)
      return state
    })
  }
  async function resetDeadline(id) {
    const active = deadlines.get(id)
    if (!active) return
    const generation = active.generation = (active.generation ?? 0) + 1
    const state = await store.read(), work = state.works.find(row => row.id === active.workId)
    if (deadlines.get(id) !== active || active.generation !== generation || work?.modelRequestBudget?.version !== 2) return
    scheduleDeadline(id, active, work.modelRequestBudget.executionDeadlineAt)
  }
  function scheduleDeadline(id, active, deadline) {
    clearTimeout(active.timer)
    const remaining = Date.parse(deadline) - clock()
    if (remaining <= 0) { active.abort.abort(error('EXECUTION_DEADLINE')); return }
    // A known deadline must still stop the upstream when Store I/O is unavailable.
    active.timer = setTimeout(() => { if (deadlines.get(id) === active) active.abort.abort(error('EXECUTION_DEADLINE')) }, remaining); active.timer.unref()
  }
  async function budgetChanged(workId) {
    const state = await store.read(), work = state.works.find(row => row.id === workId)
    if (work?.modelRequestBudget?.version !== 2) return
    for (const entry of tokens.values()) if (entry.execution.work_id === workId) entry.expiresAt = Math.min(entry.expiresAt, Date.parse(work.modelRequestBudget.executionDeadlineAt))
    for (const [id, active] of deadlines) if (active.workId === workId) { active.generation = (active.generation ?? 0) + 1; scheduleDeadline(id, active, work.modelRequestBudget.executionDeadlineAt) }
  }
  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/internal/model/')) return false
    if (await routing.handle(request, response, url)) return true
    try {
      const file = url.pathname.match(/^\/internal\/model\/attachments\/(attachment-[a-f0-9-]{36})\/content$/)
      if (request.method === 'GET' && file) {
        const record = tokenRecord(request), access = await authorize(record.execution)
        assertManualExecution(access.state, record.execution, record.manualFence)
        const ref = access.refs.find(ref => ref.attachmentId === file[1] && String(ref.version) === url.searchParams.get('version') && ref.sha256 === url.searchParams.get('sha256'))
        if (!ref || [...url.searchParams.keys()].some(field => !['version', 'sha256'].includes(field))) throw error('FORBIDDEN')
        const result = await attachments.download(access.owner, ref.attachmentId)
        const current = await authorize(record.execution)
        tokenRecord(request)
        assertManualExecution(current.state, record.execution, record.manualFence)
        if (!current.refs.some(value => isDeepStrictEqual(value, ref))) throw error('FORBIDDEN')
        response.writeHead(200, { 'content-type': result.metadata.mediaType, 'content-length': result.bytes.length, 'cache-control': 'no-store' }); response.end(result.bytes)
        return true
      }
      if (request.method !== 'POST' || url.pathname !== '/internal/model/v1/chat/completions' || url.search) throw fail('NOT_FOUND', '代理接口不存在', 404)
      const record = tokenRecord(request, 'execution')
      if (String(request.headers['content-type'] ?? '').split(';')[0] !== 'application/json') throw error('INVALID_REQUEST')
      const chunks = []; let length = 0
      const timeout = setTimeout(() => request.destroy(), 30_000); timeout.unref()
      try { for await (const chunk of request) { length += chunk.length; if (length > 112 * 1024 * 1024) throw fail('INVALID_REQUEST', '模型请求超限', 413); chunks.push(chunk) } } finally { clearTimeout(timeout) }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw error('INVALID_REQUEST') }
      const access = record.purpose === 'intent_review' ? await reviewAuthority(record.execution, record.intentReviewCommandId, { request: true, inputMessageId: record.inputMessageId, intentBudgetResumeCommandId: record.intentBudgetResumeCommandId }) : await authorize(record.execution, record.inputMessageId), route = access.current.modelSnapshot
      assertManualExecution(access.state, record.execution, record.manualFence)
      body.tools = (body.tools ?? []).filter(tool => tool.function?.name === CONTEXT_READ_TOOL ? contextEnabled(access.state, record.execution) : record.purpose === 'intent_review' ? INTENT_TOOL_NAMES.includes(tool.function?.name) && tool.function?.name !== 'geneway_split_intent' : (!INTENT_TOOL_NAMES.includes(tool.function?.name) || ['geneway_intent_context','geneway_reply_intent','geneway_split_intent'].includes(tool.function?.name) && !!access.current.grant))
      if (record.instructionRevision !== access.current.instruction_revision || clock() >= record.expiresAt) throw error('REVISION_CONFLICT')
      if (body.max_tokens === undefined) body.max_tokens = route.parameters.maxOutputTokens
      if (body.model !== route.model || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > route.parameters.maxOutputTokens || body.max_completion_tokens !== undefined || body.stream !== true || !Array.isArray(body.messages) || body.messages.length > 400
        || (body.tools ?? []).some(tool => tool.type !== 'function' || !(record.purpose === 'intent_review' ? [...INTENT_TOOL_NAMES, ...(contextEnabled(access.state, record.execution) ? [CONTEXT_READ_TOOL] : [])] : access.work.origin === 'rule' ? SITE_RULE_TOOLS : multisiteToolNames(access.work.spreadsheetRequest, access.current.grant, { contextRead: contextEnabled(access.state, record.execution) })).includes(tool.function?.name))) throw error('INVALID_REQUEST', '模型请求超出执行范围')
      const imageVariantIds = []
      for (const message of body.messages) for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'image_url') {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(block.image_url?.url ?? '')
        if (!match) throw error('FORBIDDEN', '仅允许当前工作已核验图片')
        const bytes = Buffer.from(match[2], 'base64')
        if (bytes.toString('base64') !== match[2]) throw error('FORBIDDEN')
        const variant = access.state.modelImageVariants.find(row => row.attempt_id === record.execution.attempt_id && row.session_id === record.execution.session_id && row.sha256 === sha256(bytes) && row.sizeBytes === bytes.length && row.mediaType === match[1] && access.refs.some(ref => isDeepStrictEqual(ref, row.originalRef)))
        if (!variant) throw error('FORBIDDEN', '图片派生来源不匹配')
        imageVariantIds.push(variant.id)
      }
      const credential = await readModelCredential(config)
      let exhausted = false, budgetHold
      function ruleReadIds(state, work) {
        const ids = siteModelReadIds(state, work, record.execution, body)
        for (const id of ids) assertEvidenceReader(state, record.execution, record.instructionRevision, state.siteRuleReads.find(row => row.id === id).evidenceRef)
        return ids
      }
      await store.update(state => {
        assertManualExecution(state, record.execution, record.manualFence)
        assertManualConsumption(state, record.execution)
        const manualResumeCommandId = consumedManualResumeForMessage(state, record.execution, record.inputMessageId)
        const current = record.purpose === 'intent_review' ? (record.intentBudgetResumeCommandId?authorizeBudgetIntentResume(state,state.multisite.outbox.find(row=>row.id===record.intentBudgetResumeCommandId)?.command,{request:true,inputMessageId:record.inputMessageId}):authorizeIntentDelivery(state, state.multisite.outbox.find(row => row.id === record.intentReviewCommandId)?.command, { requireConsumed: true })) : authorizeMultisiteExecution(state, record.execution, { inputMessageId: record.inputMessageId }), budget = current.work.modelRequestBudget, pages = consumedSpreadsheetPages(state, record.execution, body), contextPages = contextReader?.consumedPages(state, record.execution, body) ?? [], pageConsumption = { inputMessageId: record.inputMessageId, contextReadEnabled: contextEnabled(state, record.execution), ...(contextPages.length ? { contextReadReceiptIds: contextPages } : {}), manualFence: structuredClone(record.manualFence), ...(manualResumeCommandId ? { manualResumeCommandId, inputMessageId: record.inputMessageId } : {}), ...(pages.length ? { spreadsheetReadReceiptIds: pages } : {}), ...(record.purpose === 'intent_review' ? { purpose: 'intent_review', intentFence: structuredClone(record.intentFence), intentReviewCommandId: record.intentReviewCommandId, inputMessageId: record.inputMessageId, ...(record.intentBudgetResumeCommandId?{intentBudgetResumeCommandId:record.intentBudgetResumeCommandId}:{}) } : {}) }
        if (clock() >= record.expiresAt || current.current.instruction_revision !== record.instructionRevision) throw error('REVISION_CONFLICT')
        if (state.modelRequests.some(row => row.id === record.requestId)) throw error('IDEMPOTENCY_CONFLICT', '原请求已预留，结果未知时不能自动重发')
        if (budget.version === 2) {
          const reserved = reserveModelBudget(state, current.work, current.current, record, route, body, clock())
          budgetHold = reserved.hold
          if (budgetHold) queueBudgetWait(state, current.current, budgetHold, (draft, attempt, operation, input, at) => queueExecutionCommand(draft, attempt, operation, input, at, current.work.workspaceId), new Date(clock()).toISOString())
          let resumedFromHoldId
          if (!budgetHold) {
            const source = state.multisite.outbox.find(row => row.command.operation === 'wake' && row.command.attempt_id === record.execution.attempt_id && row.command.parameters.messages?.[0]?.kind === 'budget_resume' && messageId(row.command.input_id, record.execution.attempt_id, record.execution.session_id) === record.inputMessageId)
            const hold = source && state.budgetHolds.find(row => row.resumeCommandId === source.id && row.state === 'resume_queued')
            if (hold) { hold.state = 'resumed'; hold.resumedAt = new Date(clock()).toISOString(); hold.resumeRequestId = record.requestId; resumedFromHoldId = hold.id }
          }
          if (!budgetHold) {
            state.modelRequests.push({ id: record.requestId, ...binding(record.execution), instructionRevision: record.instructionRevision, bodyDigest: digest(body), reservedAt: new Date(clock()).toISOString(), outcome: 'unknown', usage: null, completedAt: null, imageVariantIds: [...new Set(imageVariantIds)], ...reserved.accounting, ...pageConsumption, ...(resumedFromHoldId ? { resumedFromHoldId } : {}) })
            for (const readId of ruleReadIds(state, current.work)) {
              state.siteRuleModelReads.push({ id: key('site-rule-model-read', readId, record.requestId), readId, modelRequestId: record.requestId })
            }
          }
        } else if (budget.exhaustedAt || budget.reserved >= budget.limit) {
          budget.exhaustedAt ??= new Date(clock()).toISOString(); current.work.error = { code: 'BUDGET_EXHAUSTED', message: '本工作模型请求预算已耗尽' }; current.work.status = 'failed'; exhausted = true
        } else {
          budget.reserved++; current.current.modelRequestsReserved++
          state.modelRequests.push({ id: record.requestId, ...binding(record.execution), instructionRevision: record.instructionRevision, bodyDigest: digest(body), reservedAt: new Date(clock()).toISOString(), outcome: 'unknown', usage: null, completedAt: null, imageVariantIds: [...new Set(imageVariantIds)], ...pageConsumption })
        }
        return state
      }, { beforeCommit: () => access.refs.length ? attachments.verifyReferences(access.state, access.refs) : undefined })
      if (budgetHold) throw Object.assign(error('WAITING_BUDGET', '工作预算不足，等待管理员调整'), { budgetHoldId: budgetHold.id })
      if (exhausted) throw error('BUDGET_EXHAUSTED')
      const abort = new AbortController(), disconnect = () => { if (!response.writableEnded) abort.abort() }
      const inFlight = { binding: structuredClone(record.execution), instructionRevision: record.instructionRevision, purpose: record.purpose === 'execution' ? undefined : record.purpose, inputMessageId: record.inputMessageId, signal: abort.signal, sending: false }
      activeRequests.set(record.requestId, inFlight)
      response.once('close', disconnect)
      if (access.work.modelRequestBudget.version === 2) { const active = { workId: access.work.id, abort, timer: undefined }; deadlines.set(record.requestId, active); scheduleDeadline(record.requestId, active, access.work.modelRequestBudget.executionDeadlineAt) }
      let usage = null, finished = false, terminal = false, invalidStream = false, pending = '', upstream
      try {
        await resetDeadline(record.requestId)
        if (access.work.origin === 'rule') {
          // Credential I/O, reservation, and deadline reloading all precede this last authorization.
          const fresh = await store.read()
          try {
            tokenRecord(request, 'execution')
            const current = authorizeMultisiteExecution(fresh, record.execution, { inputMessageId: record.inputMessageId })
            assertManualExecution(fresh, record.execution, record.manualFence)
            ruleReadIds(fresh, current.work)
            abort.signal.throwIfAborted()
          } catch (cause) {
            // Nothing crossed the provider boundary. Keep the original reservation.
            await settle('failed', null)
            throw cause
          }
        }
        abort.signal.throwIfAborted()
        inFlight.sending = true
        upstream = await fetchImpl(new URL(base.href.replace(/\/$/, '') + '/chat/completions'), { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: abort.signal })
        if (!upstream.ok) {
          inFlight.sending = false
          await upstream.body?.cancel(); await settle('failed', null)
          throw fail('UPSTREAM_ERROR', '模型上游拒绝请求', 502)
        }
        if (!(upstream.headers.get('content-type') ?? '').startsWith('text/event-stream')) { inFlight.sending = false; await upstream.body?.cancel(); throw fail('UPSTREAM_ERROR', '模型响应类型无效', 502) }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        const decoder = new TextDecoder()
        for await (const chunk of upstream.body) {
          pending += decoder.decode(chunk, { stream: true })
          if (pending.length > 1024 * 1024) throw error('UPSTREAM_ERROR')
          const lines = pending.split('\n'); pending = lines.pop()
          for (const line of lines) {
            if (line.trim() === 'data: [DONE]') finished = true
            if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue
            try { const event = JSON.parse(line.slice(6)); if (event.error) invalidStream = true; if (event.choices?.some(choice => ['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason))) terminal = true; if (event.usage) { const value = normalizeModelUsage(event.usage); if (value) usage = value } } catch { /* non-JSON SSE metadata is not usage */ }
          }
          if (!response.write(chunk)) await once(response, 'drain', { signal: abort.signal })
        }
        if (!finished || !terminal || invalidStream) throw error('UPSTREAM_ERROR', '模型流未完成，结果未知')
        await settle('completed', usage)
        response.end()
      } catch (cause) {
        inFlight.sending = false
        if (access.work.modelRequestBudget.version === 2 && usage) await store.update(state => { const row = state.modelRequests.find(row => row.id === record.requestId); if (row.outcome === 'unknown' && !row.completedAt) { row.usage = usage; settleModelAccounting(state, row) }; return state })
        if (response.headersSent) response.destroy()
        else throw cause
      } finally { clearTimeout(deadlines.get(record.requestId)?.timer); deadlines.delete(record.requestId); activeRequests.delete(record.requestId); response.off('close', disconnect) }
      async function settle(outcome, usage) {
        await store.update(state => { const row = state.modelRequests.find(row => row.id === record.requestId); if (row.outcome !== 'unknown' || row.completedAt) throw error('INVALID_STATE'); row.outcome = outcome; row.usage = usage; row.completedAt = new Date(clock()).toISOString(); settleModelAccounting(state, row); return state })
      }
      return true
    } catch (cause) {
      const status = cause.status ?? ({ UNAUTHORIZED: 401, FORBIDDEN: 403, REVISION_CONFLICT: 409, RUNTIME_REQUEST_UNKNOWN: 409, IDEMPOTENCY_CONFLICT: 409, CAPACITY_EXCEEDED: 409, BUDGET_EXHAUSTED: 409, WAITING_BUDGET: 409, EXECUTION_DEADLINE: 409, MANUALLY_PAUSED: 409, MANUAL_RELEASE_PENDING: 409, MANUAL_RESUME_PENDING: 409, CONTEXT_READ_UNAVAILABLE: 403, CONTEXT_READ_WINDOW_PENDING: 409, CONTEXT_READ_LIMIT: 409, BUDGET_PRICE_MISSING: 409, BUDGET_ESTIMATE_INVALID: 409, INVALID_REQUEST: 400 }[cause.code] ?? 503)
      if (response.headersSent) response.destroy()
      else { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: { code: cause.code ?? 'MODEL_GATEWAY_UNAVAILABLE', message: status >= 500 ? '模型代理暂不可用' : cause.message, ...(cause.budgetHoldId ? { budgetHoldId: cause.budgetHoldId } : {}) } })) }
      return true
    }
  }
  function isOwnedExecutionInFlight(row, currentBinding, revision) {
    const entry = activeRequests.get(row.id)
    return !!(entry && entry.sending && !entry.signal.aborted && entry.purpose === undefined && row.purpose === undefined && row.outcome === 'unknown' && row.completedAt === null && row.usage === null && sameBinding(entry.binding, currentBinding) && sameBinding(row, currentBinding) && entry.instructionRevision === revision && row.instructionRevision === revision && entry.inputMessageId === row.inputMessageId)
  }
  return { isOwnedExecutionInFlight, createSupervisionGateway(options) { return createSupervisionDiagnosisGateway({ ...options, store, config, base, fetchImpl, clock, isOwnedExecutionInFlight }) }, setContextReader(value) { contextReader = value }, context: { read(execution, parameters, modelStep, nodeAuth) { if (!contextReader) throw error('FORBIDDEN'); return contextReader.read(execution, parameters, modelStep, nodeAuth) } }, authorizeContextModelStep, issue, issueIntentReview, issueBudgetResume, budgetChanged, authorize, registerVariant, handle, issueRouting: routing.issue, route: routing.decide, routeBatch: routing.decideBatch, isRoutingInFlight: routing.isInFlight, closeRouting: routing.close }
}
