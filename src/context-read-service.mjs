import { authorizeContextSubscription, authorizeMultisiteExecution as authorizeMultisiteExecutionForProjection } from './multisite-authorization.mjs'
import { queueContextReadWindows, assertContextWindowAvailable } from './context-read-delivery.mjs'
import { assertNodeCaller } from '../packages/agent-contracts/nodes.mjs'
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import ExcelJS from 'exceljs'
import { binding, digest, error, key, sameBinding } from '../packages/agent-contracts/index.mjs'
import { CONTEXT_READ_TOOL, CONTEXT_READ_LIMITS as L, contextReadParameters } from '../packages/agent-contracts/context-read.mjs'
import { continuationReaderSource, continuationArtifact, continuationEvidence } from './context-read-access.mjs'
import { openContextInstance, currentContextWindow, continueContextWindow, contextResumePosition, contextWindowUsage, recordContextPage, contextObjectKey } from './context-read-state.mjs'
import { budgetTokenExpiry } from './work-budget.mjs'
const unavailable = () => error('CONTEXT_READ_UNAVAILABLE', '此资料当前不可读取')
const ref = (kind, id, version = 1) => ({ kind, id, version })
function fragments(value) {
  const points = Array.from(JSON.stringify(value)), parts = Math.max(1, Math.ceil(points.length / 1000))
  return Array.from({ length: parts }, (_, part) => ({ type: 'json_fragment', part, parts, text: points.slice(part * 1000, (part + 1) * 1000).join('') }))
}
export function createContextReadService({ store, gateway, evidence, spreadsheetArtifacts, clock = () => Date.now() }) {
  const cursorSecret = randomBytes(32)
  const phase = row => digest({ receiver: binding(row), instructionRevision: row.instructionRevision, purpose: row.purpose ?? 'execution', intentFence: row.intentFence ?? null, manualFence: row.manualFence })
  function encode(value) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return body + '.' + createHmac('sha256', cursorSecret).update(body).digest('base64url') }
  function decode(value) { try { const [body, tag, extra] = value.split('.'), signature = Buffer.from(tag, 'base64url'), expected = createHmac('sha256', cursorSecret).update(body).digest(); if (extra || signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw Error(); return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { throw error('INVALID_CURSOR') } }
  function graph(state, execution, objectRef, view) {
    const source = continuationReaderSource(state, execution), artifact = source.artifactRead ? continuationArtifact(state, source) : null
    const rootRef = ref('continuation', source.link.id), workRef = ref('work', source.source.id, source.source.instructionRevision)
    const job = artifact && state.multisite.jobs.find(row => row.id === artifact.jobId && row.work_id === source.source.id && sameBinding(row, artifact) && row.inputDigest === artifact.inputDigest)
    const manifest = job?.sourceManifest
    if (manifest && (digest(manifest) !== job.sourceManifestDigest || job.sourceManifestDigest !== artifact.manifestDigest)) throw unavailable()
    function resultFor(id) {
      const result = state.multisite.results.find(row => row.id === id && row.workId === source.source.id && row.payloadDigest === digest(row.payload)), origin = manifest?.sources.filter(row => row.resultId === id) ?? [], analysis = manifest?.analysis?.resultId === id ? manifest.analysis : null
      if (!result || !origin.length && !analysis || !state.multisite.delegations.some(row => row.id === result.delegationId && row.agentId === result.senderBinding.agent_id) || !state.multisite.attempts.some(row => sameBinding({ ...row, session_id: row.session_id ?? `geneway-${row.launch_id}` }, result.senderBinding))) throw unavailable()
      if (analysis && (analysis.payloadDigest !== result.payloadDigest || analysis.producerRevision !== result.instructionRevision || !sameBinding(analysis.senderBinding, result.senderBinding))) throw unavailable()
      for (const row of origin) if (row.producerRevision !== result.instructionRevision || !sameBinding(row.producerBinding, result.senderBinding) || !result.payload.evidenceRefs?.some(value => isDeepStrictEqual(value, row.ref))) throw unavailable()
      for (const evidenceRef of result.payload.evidenceRefs ?? []) { if (!manifest.sources.some(row => isDeepStrictEqual(row.ref, evidenceRef))) throw unavailable(); continuationEvidence(state, source, evidenceRef, execution) }
      return result
    }
    const resultRefs = []
    for (const id of [...new Set([...(manifest?.sources.map(row => row.resultId) ?? []), ...(manifest?.analysis ? [manifest.analysis.resultId] : [])])]) {
      try { const row = resultFor(id); resultRefs.push({ objectRef: ref('result', row.id, row.instructionRevision), view: 'content', label: '原来源回报' }) } catch (cause) { if (!['CONTEXT_READ_UNAVAILABLE', 'FORBIDDEN', 'NOT_FOUND'].includes(cause.code)) throw cause }
    }
    let actualRef, items = [], nextRefs = [], file
    if (objectRef.kind === 'continuation' && objectRef.id === rootRef.id) {
      actualRef = rootRef; items = fragments({ currentWorkId: source.work.id, currentInstructionRevision: source.work.instructionRevision, sourceWorkId: source.source.id, sourceState: source.link.context.sourceState, unknownEffects: source.link.context.unknownEffects, limitation: '来源资料属于历史记录，不替代当前要求或恢复旧执行。' }); nextRefs = [{ objectRef: workRef, view: 'content', label: '原工作记录' }]
    } else if (objectRef.kind === 'work' && objectRef.id === source.source.id) {
      actualRef = workRef; const input = state.multisite.inputs.find(row => row.workId === source.source.id && row.revision === source.source.instructionRevision)
      items = fragments({ id: source.source.id, goal: source.source.goal, status: source.source.status, instructionRevision: source.source.instructionRevision, acceptedAt: source.source.acceptedAt, historicalInput: input?.text ?? null, executionDeadlineAt: source.source.modelRequestBudget.executionDeadlineAt ?? null, limitation: '旧执行期限仅作历史说明。' }); if (artifact) nextRefs = [{ objectRef: ref('artifact', artifact.id, artifact.version), view: 'content', label: '已发布原成果' }]
    } else if (objectRef.kind === 'artifact' && artifact?.id === objectRef.id) {
      actualRef = ref('artifact', artifact.id, artifact.version); items = fragments({ name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, manifestDigest: artifact.manifestDigest ?? null }); file = { kind: 'artifact', row: artifact }
      if (job) nextRefs = [{ objectRef: ref('job', job.id), view: manifest && resultRefs.length !== new Set([...manifest.sources.map(row => row.resultId), manifest.analysis.resultId]).size ? 'summary' : 'manifest', label: '原生成来源记录' }]
    } else if (objectRef.kind === 'job' && job?.id === objectRef.id) {
      actualRef = ref('job', job.id); if (view === 'manifest' && manifest && resultRefs.length !== new Set([...manifest.sources.map(row => row.resultId), manifest.analysis.resultId]).size) throw unavailable()
      items = fragments(view === 'manifest' ? { jobId: job.id, inputDigest: job.inputDigest, sourceManifestDigest: job.sourceManifestDigest ?? null, sourceManifest: manifest ?? null, limitation: manifest ? '按原编码读取，不表示当前来源仍是现场实时状态。' : '此旧成果没有多来源manifest关系。' } : { jobId: job.id, instructionRevision: job.instructionRevision, state: job.state, inputDigest: job.inputDigest, manifestDigest: job.sourceManifestDigest ?? null }); nextRefs = resultRefs
    } else if (objectRef.kind === 'result' && resultRefs.some(row => row.objectRef.id === objectRef.id)) {
      const result = resultFor(objectRef.id); actualRef = ref('result', result.id, result.instructionRevision); items = fragments({ id: result.id, delegationId: result.delegationId, producerBinding: result.senderBinding, producerRevision: result.instructionRevision, schema: result.schema, payloadDigest: result.payloadDigest, payload: result.payload }); nextRefs = (result.payload.evidenceRefs ?? []).map(value => ({ objectRef: ref('evidence', value.id, value.version), view: 'content', label: '已封存原证据' }))
    } else if (objectRef.kind === 'evidence') {
      const entry = manifest?.sources.find(row => row.ref.id === objectRef.id)
      if (!entry || !resultRefs.some(row => row.objectRef.id === entry.resultId)) throw unavailable()
      const row = continuationEvidence(state, source, entry.ref, execution)
      if (row.resourceRevision !== entry.resourceRevision || row.resourceId !== entry.resourceId || row.instructionRevision !== entry.producerRevision || !sameBinding(row.producerBinding, entry.producerBinding)) throw unavailable()
      actualRef = ref('evidence', row.id, row.version); file = { kind: 'evidence', row }; items = fragments({ schema: row.schema, quality: row.quality, dataMode: row.dataMode, clockTrust: row.clockTrust, sourceTimestamp: row.sourceTimestamp, observedAt: row.observedAt, sha256: row.sha256 })
    } else throw unavailable()
    if (objectRef.version !== undefined && objectRef.version !== actualRef.version) throw error('CONTEXT_READ_VERSION_CHANGED', '资料版本已变化，请重新核对来源')
    return { source, actualRef, rootRef, items, nextRefs, file }
  }
  function assertPageRelations(state, execution, page, current) {
    for (const next of page.nextRefs) {
      if (!current.nextRefs.some(value => isDeepStrictEqual(value, next))) throw unavailable()
      graph(state, execution, next.objectRef, next.view)
    }
  }
  async function contents(access, view, transactionState) {
    let items = access.items
    if (access.file?.kind === 'evidence') {
      const payload = await evidence.readContextSnapshot(access.file.row)
      items = view === 'content' ? (access.file.row.kind === 'history' ? payload.entries.map((entry, entryIndex) => ({ entryIndex, ...entry })) : [...(payload.sections?.includes('collector_health') ? [{ type: 'collector_health', health: payload.health }] : []), ...(payload.events ?? []).map((event, eventIndex) => ({ eventIndex, ...event }))]) : access.items
    } else if (access.file?.kind === 'artifact') {
      const downloaded = transactionState ? await spreadsheetArtifacts.readReadyContextBytes(transactionState, access.source.actor, access.source.source.id, access.file.row.id) : await spreadsheetArtifacts.download(access.source.actor, access.source.source.id, access.file.row.id)
      if (view === 'content') { const book = new ExcelJS.Workbook(); await book.xlsx.load(downloaded.bytes); items = []; for (const sheet of book.worksheets) sheet.eachRow((row, rowIndex) => {
        let group = { sheet: sheet.name, row: rowIndex, cells: [] }
        row.eachCell((cell, column) => { if (cell.isMerged && cell.master.address !== cell.address) return; const points = typeof cell.value === 'string' ? Array.from(cell.value) : null, parts = points ? Math.max(1, Math.ceil(points.length / 1000)) : 1; for (let part = 0; part < parts; part++) { const value = { column, part, parts, value: points ? points.slice(part * 1000, (part + 1) * 1000).join('') : cell.value }; if (group.cells.length && Buffer.byteLength(JSON.stringify({ ...group, cells: [...group.cells, value] })) > 8000) { items.push(group); group = { sheet: sheet.name, row: rowIndex, cells: [] } }; group.cells.push(value) } })
        if (group.cells.length) items.push(group)
      }) }
    }
    return [...items, ...access.nextRefs.map(relation => ({ type: 'relation', relation }))]
  }
  async function read(execution, parameters, modelStep, nodeAuth) {
    contextReadParameters(parameters)
    let state = await store.read(); const access = gateway.authorizeContextModelStep(state, execution, modelStep), origin = continuationReaderSource(state, execution)
    if (nodeAuth) assertNodeCaller(state, nodeAuth, execution)
    const preview = structuredClone(state), instance = openContextInstance(preview, { continuationId: origin.link.id, actorId: origin.actor.id, threadId: origin.threadId, readerBinding: execution, sourceEventId: origin.link.sourceEventId, at: origin.link.createdAt }), window = currentContextWindow(preview, instance.id), approvedParent = window.parentReadId && preview.contextReads.find(row => row.id === window.parentReadId)
    const continuationTarget = window.continuationTarget ?? (approvedParent && { objectRef: approvedParent.objectRef, view: approvedParent.view, fromIndex: approvedParent.page.nextIndex, path: approvedParent.path })
    const defaultRef = approvedParent && !preview.contextReads.some(row => row.windowId === window.id) ? continuationTarget.objectRef : ref('continuation', origin.link.id)
    assertContextWindowAvailable(state, window, access.modelRequest)
    const objectRef = parameters.objectRef ?? defaultRef, object = graph(state, execution, objectRef, parameters.view), phaseKey = phase(access.modelRequest), id = key('context-read', instance.id, parameters.clientRequestId), requestDigest = digest(parameters)
    const old = state.contextReads.find(row => row.id === id)
    if (old) { if (old.requestDigest !== requestDigest) throw error('IDEMPOTENCY_CONFLICT'); if (old.phaseKey !== phaseKey) throw error('REVISION_CONFLICT'); assertPageRelations(state, execution, old.page, object); return structuredClone(old.page) }
    let start = 0, parent, path
    if (parameters.cursor !== undefined) { const cursor = decode(parameters.cursor); if (cursor.instanceId !== instance.id || cursor.windowId !== window.id || cursor.phaseKey !== phaseKey || cursor.expiresAt <= clock()) throw error('INVALID_CURSOR'); parent = state.contextReads.find(row => row.id === cursor.readId && row.windowId === window.id); if (!parent || !isDeepStrictEqual(parent.objectRef, object.actualRef) || parent.view !== parameters.view) throw error('INVALID_CURSOR'); start = parent.page.nextIndex; path = parent.path }
    else if (approvedParent && !preview.contextReads.some(row => row.windowId === window.id)) { parent = approvedParent; if (!isDeepStrictEqual(continuationTarget.objectRef, object.actualRef) || continuationTarget.view !== parameters.view) throw unavailable(); start = continuationTarget.fromIndex; path = continuationTarget.path }
    else if (object.actualRef.kind === 'continuation') path = [contextObjectKey(object.actualRef)]
    else { parent = state.contextReads.findLast(row => row.contextInstanceId === instance.id && row.page.nextRefs.some(next => isDeepStrictEqual(next.objectRef, object.actualRef))); if (!parent) throw unavailable(); path = [...parent.path, contextObjectKey(object.actualRef)] }
    const items = await contents(object, parameters.view), objectDigest = digest(items), expiresAt = budgetTokenExpiry(access.work, clock() + 300000, clock())
    if (parent && isDeepStrictEqual(parent.objectRef, object.actualRef) && parent.objectDigest !== objectDigest) throw error('REVISION_CONFLICT', '原资料或可见关系已变化，请重新核对')
    const sourceMetadata = object.file?.kind === 'evidence' ? { schema: object.file.row.schema, sha256: object.file.row.sha256, producerBinding: object.file.row.producerBinding, producerInstructionRevision: object.file.row.instructionRevision, resourceId: object.file.row.resourceId, resourceRevision: object.file.row.resourceRevision, quality: object.file.row.quality, dataMode: object.file.row.dataMode, clockTrust: object.file.row.clockTrust, sourceTimestamp: object.file.row.sourceTimestamp, observedAt: object.file.row.observedAt } : object.file?.kind === 'artifact' ? { sha256: object.file.row.sha256, instructionRevision: object.file.row.instructionRevision, manifestDigest: object.file.row.manifestDigest ?? null } : null
    let selected = [], page
    function envelope(values, limitReason = null, fromIndex = start) { const nextIndex = fromIndex + values.length, partial = nextIndex < items.length; let bytes = 0; for (let pass = 0; pass < 12; pass++) { const result = { schema: 'geneway.context-page/1', readId: id, contextInstanceId: instance.id, windowId: window.id, objectRef: object.actualRef, view: parameters.view, historical: object.actualRef.kind !== 'continuation', source: sourceMetadata, items: values, nextRefs: values.filter(row => row.type === 'relation').map(row => row.relation), totalItems: items.length, nextIndex, partial, nextCursor: partial && !limitReason ? encode({ instanceId: instance.id, windowId: window.id, phaseKey, readId: id, expiresAt }) : null, limitReason, bytes, tokenEstimate: bytes, estimateOnly: true }; const actual = Buffer.byteLength(JSON.stringify(result)); if (actual === bytes) return result; bytes = actual }; throw error('INVALID_STATE') }
    function buildPage(usage) {
      if (usage.reads >= L.maxReads || usage.objectPages >= L.objectPages) throw error('CONTEXT_READ_LIMIT', '本次资料窗口已到边界，请用户明确继续读取资料')
      selected = []
      while (selected.length < (parameters.maxItems ?? L.pageItems) && start + selected.length < items.length) { const next = [...selected, items[start + selected.length]], candidate = envelope(next); if (candidate.bytes > Math.min(L.pageBytes, parameters.maxTokens ?? L.pageBytes) || usage.bytes + candidate.bytes > L.maxBytes || usage.tokens + candidate.bytes > L.maxTokens || usage.objectBytes + candidate.bytes > L.objectBytes) break; selected = next }
      let result = envelope(selected)
      if (!selected.length && start < items.length || result.bytes > L.pageBytes) throw error('CONTEXT_READ_LIMIT', '下一条完整资料超出当前剩余额度，请用户明确继续读取资料')
      if (result.partial) {
        const next = envelope([items[result.nextIndex]], null, result.nextIndex)
        if (usage.reads + 1 >= L.maxReads || usage.objectPages + 1 >= L.objectPages || usage.bytes + result.bytes + next.bytes > L.maxBytes || usage.tokens + result.bytes + next.bytes > L.maxTokens || usage.objectBytes + result.bytes + next.bytes > L.objectBytes) result = envelope(selected, '需要明确继续读取资料')
      }
      return result
    }
    let reply, quotaError
    await store.update(draft => {
      if (nodeAuth) assertNodeCaller(draft, nodeAuth, execution)
      const latest = gateway.authorizeContextModelStep(draft, execution, modelStep), current = graph(draft, execution, object.actualRef, parameters.view)
      assertContextWindowAvailable(draft, currentContextWindow(draft, instance.id) ?? window, latest.modelRequest)
      if (phase(latest.modelRequest) !== phaseKey || !isDeepStrictEqual(current.actualRef, object.actualRef)) throw error('REVISION_CONFLICT')
      const activeWindow = currentContextWindow(draft, instance.id)
      if (activeWindow && activeWindow.id !== window.id) throw error('REVISION_CONFLICT')
      try { page = buildPage(contextWindowUsage(draft, window.id, object.actualRef)) } catch (cause) {
        if (cause.code !== 'CONTEXT_READ_LIMIT') throw cause
        // A failed page consumes no read credit. Preserve only a proven reachable
        // first relation that a fresh, explicitly approved window can actually fit.
        if (parent && path.length <= L.maxHops + 1 && new Set(path).size === path.length && !isDeepStrictEqual(parent.objectRef, object.actualRef) && parent.page.nextRefs.some(next => isDeepStrictEqual(next.objectRef, object.actualRef) && next.view === parameters.view) && !draft.contextReads.some(row => row.contextInstanceId === instance.id && isDeepStrictEqual(row.objectRef, object.actualRef) && row.view === parameters.view)) {
          try {
            buildPage({ reads: 0, bytes: 0, tokens: 0, objectPages: 0, objectBytes: 0 })
            assertPageRelations(draft, execution, parent.page, graph(draft, execution, parent.objectRef, parent.view))
            activeWindow.blockedFrontier ??= { parentReadId: parent.id, objectRef: structuredClone(object.actualRef), view: parameters.view, fromIndex: 0, path: [...parent.path, contextObjectKey(object.actualRef)] }
          } catch (freshFailure) { if (freshFailure.code !== 'CONTEXT_READ_LIMIT') throw freshFailure }
        }
        quotaError = cause; return draft
      }
      assertPageRelations(draft, execution, page, current)
      openContextInstance(draft, { continuationId: origin.link.id, actorId: origin.actor.id, threadId: origin.threadId, readerBinding: execution, sourceEventId: origin.link.sourceEventId, at: origin.link.createdAt })
      reply = recordContextPage(draft, { id, requestDigest, contextInstanceId: instance.id, windowId: window.id, receiverBinding: binding(execution), instructionRevision: latest.current.instruction_revision, purpose: latest.modelRequest.purpose ?? 'execution', intentFence: latest.modelRequest.intentFence ?? null, phaseKey, modelRequestId: latest.modelRequest.id, inputMessageId: latest.modelRequest.inputMessageId, manualFence: structuredClone(modelStep.manualFence), objectRef: object.actualRef, objectDigest, view: parameters.view, parentReadId: parent?.id ?? null, path, fromIndex: start, page, pageDigest: digest(page), bytes: page.bytes, tokenEstimate: page.tokenEstimate, readAt: new Date(clock()).toISOString() }).page
      return draft
    })
    if (quotaError) throw quotaError
    return reply
  }
  function consumedPages(state, execution, body) {
    const calls = new Map(), ids = new Set()
    for (const message of body.messages) {
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) if (call.type === 'function') calls.set(call.id, call.function)
      if (message.role !== 'tool' || calls.get(message.tool_call_id)?.name !== CONTEXT_READ_TOOL) continue
      const content = typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
      let page, parameters; try { const value = JSON.parse(content); page = value.result ?? value; parameters = JSON.parse(calls.get(message.tool_call_id).arguments) } catch { continue }
      const row = state.contextReads.find(row => row.id === page?.readId)
      if (!row) continue
      if (!sameBinding(row.receiverBinding, execution)) throw unavailable()
      const current = graph(state, execution, row.objectRef, row.view); assertPageRelations(state, execution, row.page, current)
      if (row.pageDigest === digest(page) && row.requestDigest === digest(parameters)) ids.add(row.id)
    }
    return [...ids].sort()
  }
  function humanReadAccess(state, actor, threadId, readId) {
    const row = state.contextReads.find(row => row.id === readId), instance = row && state.contextReadInstances.find(value => value.id === row.contextInstanceId && value.actorId === actor.id && value.threadId === threadId)
    if (!instance) throw unavailable()
    authorizeContextSubscription(state, instance.readerBinding)
    const current = graph(state, instance.readerBinding, row.objectRef, row.view); assertPageRelations(state, instance.readerBinding, row.page, current)
    return { row, instance, current }
  }
  function approveWindow(state, actor, threadId, event, parameters) {
    const fields = ['clientRequestId', 'sourceEventId', 'version', 'expectedThreadRevision', 'text', 'continueContextRead']
    if (Object.keys(parameters).some(name => !fields.includes(name)) || Object.keys(parameters.continueContextRead ?? {}).some(name => name !== 'readId') || typeof parameters.continueContextRead?.readId !== 'string') throw error('INVALID_REQUEST')
    const { row, instance } = humanReadAccess(state, actor, threadId, parameters.continueContextRead.readId)
    const window = continueContextWindow(state, instance, row.id, event.id, new Date(clock()).toISOString())
    return { threadId, eventId: event.id, contextReadWindowId: window.id, readId: row.id, state: window.deliveredAt ? 'notified' : 'approved_waiting' }
  }
  async function verifyWindowApproval(state, actor, threadId, readId, windowId) {
    const access = humanReadAccess(state, actor, threadId, readId)
    const items = await contents(access.current, access.row.view, state)
    if (digest(items) !== access.row.objectDigest) throw error('REVISION_CONFLICT', '原资料或可见关系已变化，请刷新未读位置')
    const window = state.contextReadWindows.findLast(window => (!windowId || window.id === windowId) && window.parentReadId === readId && window.contextInstanceId === access.instance.id), position = window?.continuationTarget
    if (windowId && !window) throw unavailable()
    if (position && !isDeepStrictEqual(position.objectRef, access.row.objectRef)) await contents(graph(state, access.instance.readerBinding, position.objectRef, position.view), position.view, state)
    humanReadAccess(state, actor, threadId, readId)
  }
  function projection(state, actor, threadId) {
    const values = []
    for (const instance of state.contextReadInstances.filter(row => row.actorId === actor.id && row.threadId === threadId)) {
      const activeWindow = currentContextWindow(state, instance.id)
      const reads = state.contextReads.filter(row => row.contextInstanceId === instance.id && (row.page.partial || contextResumePosition(state, instance, row.id) || activeWindow?.parentReadId === row.id))
      for (const row of reads.slice().reverse()) {
        const pending = contextResumePosition(state, instance, row.id), approvedTarget = activeWindow?.continuationTarget ?? { parentReadId: row.id, objectRef: row.objectRef, view: row.view, fromIndex: row.page.nextIndex, path: row.path }
        const approved = activeWindow?.parentReadId === row.id && (!pending || isDeepStrictEqual(pending, approvedTarget)) ? activeWindow : null
        const position = pending ?? approved?.continuationTarget
        if (values.some(value => value.contextInstanceId === instance.id && value.objectKey === contextObjectKey(position?.objectRef ?? row.objectRef) && value.view === (position?.view ?? row.view))) continue
        if (!approved && !position) continue
        try { humanReadAccess(state, actor, threadId, row.id) } catch (cause) { if (['FORBIDDEN', 'UNAUTHORIZED', 'CONTEXT_READ_UNAVAILABLE', 'NOT_FOUND', 'MODEL_NOT_CONFIGURED', 'REVISION_CONFLICT'].includes(cause.code)) continue; throw cause }
        const attempt = state.multisite.attempts.find(value => sameBinding({ ...value, session_id: value.session_id ?? `geneway-${value.launch_id}` }, instance.readerBinding)), question = state.intentQuestions.some(value => value.state === 'open' && sameBinding(value.handlerBinding, instance.readerBinding))
        let waitingReason = question ? 'QUESTION_PENDING' : attempt?.status !== 'running' ? attempt?.status ?? 'UNAVAILABLE' : null
        try { authorizeMultisiteExecutionForProjection(state, instance.readerBinding) } catch (cause) { waitingReason ??= cause.code }
        const relationPending = position && !isDeepStrictEqual(position.objectRef, row.objectRef)
        if (relationPending) { try { graph(state, instance.readerBinding, position.objectRef, position.view) } catch (cause) { if (['FORBIDDEN', 'CONTEXT_READ_UNAVAILABLE', 'NOT_FOUND'].includes(cause.code)) continue; throw cause } }
        const continuationKey = key('context-continuation-slot', approved ? approved.sourceWindowId ?? row.windowId : activeWindow.id, row.id, position ?? approvedTarget)
        values.push({ readId: row.id, continuationKey, contextInstanceId: instance.id, objectKey: contextObjectKey(position?.objectRef ?? row.objectRef), objectKind: position?.objectRef.kind ?? row.objectRef.kind, view: position?.view ?? row.view, nextIndex: relationPending ? null : row.page.nextIndex, totalItems: relationPending ? null : row.page.totalItems, relationPending: !!relationPending, canContinue: !approved, state: approved ? approved.deliveredAt ? 'notified' : 'approved_waiting' : 'available', waitingReason })
      }
    }
    return values.slice(0, 16).map(({ objectKey, ...value }) => value)
  }
  return { read, graph, consumedPages, approveWindow, verifyWindowApproval, projection, queuePending: queueContextReadWindows }

}
