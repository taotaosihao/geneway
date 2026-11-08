import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digest } from '../../packages/agent-contracts/index.mjs'
import { messageId } from '../../packages/agent-host/delivery.mjs'
import { arms, events, scenario } from './fixture.mjs'

const tailCode = '西廊-鹤鸣-2719'
const expected = {
  'known-tail': ['history', 'accept', 1], 'known-status': ['history', 'accept', 1],
  'topic-switch': ['maintenance', 'explicit', 0],
  'first-unknown': [null, 'clarify', 0], 'ambiguous-date': [null, 'clarify', 0],
  'ambiguous-item': [null, 'clarify', 0], 'ambiguous-site': [null, 'clarify', 0],
  unrelated: [null, 'ignore', 0], 'known-dense-1': ['history', 'accept', 1],
  'known-dense-2': ['maintenance', 'accept', 1], 'known-dense-replay': ['maintenance', 'replay', 0],
  answer: ['maintenance', 'answer', 1], revision: ['maintenance', 'explicit', 0],
  stop: ['maintenance', 'stop', 0], 'after-stop': ['maintenance', 'proposal', 0],
}
assert.deepEqual(events.map(event => event.id), Object.keys(expected))

const read = async path => JSON.parse(await readFile(path, 'utf8'))
const num = value => Number.isSafeInteger(value) && value >= 0
const ms = (a, b) => typeof a === 'string' && typeof b === 'string' && Number.isFinite(Date.parse(a) - Date.parse(b)) ? Date.parse(a) - Date.parse(b) : null
const known = values => {
  const reported = values.filter(num), sum = reported.reduce((a, b) => a + b, 0)
  return { total: reported.length === values.length ? sum : null, knownSubtotal: reported.length || !values.length ? sum : null, unknownCalls: values.length - reported.length }
}
export function usageTotals(calls) {
  return {
    forwards: calls.length,
    bodyBytes: calls.reduce((total, call) => total + call.bytes, 0),
    estimatedTokens: known(calls.map(call => call.ledger?.estimate?.totalTokens)),
    estimatedCostMicros: known(calls.map(call => call.ledger?.estimate?.costMicros)),
    reportedInputTokens: known(calls.map(call => call.ledger?.usage?.prompt_tokens)),
    reportedOutputTokens: known(calls.map(call => call.ledger?.usage?.completion_tokens)),
    reportedTotalTokens: known(calls.map(call => call.ledger?.usage?.total_tokens)),
    usageCostMicros: known(calls.map(call => call.ledger?.usageCostMicros)),
    cachedInputTokens: known(calls.map(() => null)),
    uncachedInputTokens: known(calls.map(() => null)),
  }
}

function toolContent(body) {
  return body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
}
function forwardCalls(records, state, ready, failures) {
  const seen = new Set(), responses = new Map(records.filter(row => row.type === 'provider-response').map(row => [row.sequence, row]))
  const ledger = state?.modelRequests.filter(row => Object.values(ready?.works ?? {}).includes(row.work_id) || Object.values(ready?.threads ?? {}).includes(row.threadId)) ?? []
  const calls = records.filter(row => row.type === 'provider').map(row => {
    const input = JSON.parse(row.body.messages.findLast(message => message.role === 'user').content)
    const router = input.schema === 'geneway.routing-batch/1', response = responses.get(row.sequence)
    const matches = ledger.filter(item => item.bodyDigest === row.bodyDigest && (item.purpose === 'routing') === router)
    const item = matches.length === 1 ? matches[0] : null
    if (!item || seen.has(item.id) || digest(row.body) !== row.bodyDigest || Buffer.byteLength(JSON.stringify(row.body)) !== row.bodyBytes || item.forwardedBodyBytes !== row.bodyBytes || !response) failures.push('provider-ledger-' + row.sequence)
    if (item) seen.add(item.id)
    if (item && response) {
      const usage = response.stream.findLast(chunk => chunk.usage)?.usage ?? null
      if (digest(usage) !== digest(item.usage) || item.outcome !== 'completed') failures.push('provider-usage-' + row.sequence)
    }
    if (router && item) {
      const requestIds = input.events.map(event => event.requestId)
      const batch = state.routingBatches.find(value => value.id === item.batchId)
      if (digest(requestIds) !== digest(item.members?.map(member => member.requestId)) || digest(requestIds) !== digest(batch?.members?.map(member => member.requestId))) failures.push('batch-members-' + row.sequence)
      for (const event of input.events) {
        const request = state.routingRequests.find(candidate => candidate.id === event.requestId)
        if (!request || request.sourceEventId !== event.sourceEventId || request.eventVersion !== event.eventVersion) failures.push('batch-source-' + row.sequence)
      }
    }
    return { kind: router ? 'router' : 'worker', sequence: row.sequence, sourceIds: router ? input.events.map(event => event.sourceEventId) : [input.sourceEventId],
      arrivedAt: row.arrivedAt, durationMs: ms(response?.finishedAt, row.arrivedAt), bytes: row.bodyBytes, ledger: item, body: row.body }
  })
  for (const row of ledger) if (!row.noForwardReason && !seen.has(row.id)) failures.push('ledger-without-provider-' + row.id)
  return calls
}

async function roundResult(arm, round, records) {
  const ready = records.find(row => row.type === 'ready'), terminal = records.find(row => row.type === 'terminal')
  const raw = terminal?.raw
  const [state, preCleanup, host, sessions, projections] = raw ? await Promise.all([read(raw.cloud), read(raw.beforeCleanup), read(raw.host), read(raw.sessions), read(raw.projections)]) : []
  const failures = records.filter(row => ['worker-failure', 'round-failure', 'provider-failure'].includes(row.type)).map(row => row.eventId ?? row.message)
  if (!raw || !ready) failures.push('轮次缺少终态或初始原件')
  const calls = forwardCalls(records, state, ready, failures)
  const eventRows = events.map(event => {
    const [target, kind, replyCount] = expected[event.id]
    const submitted = records.find(row => row.type === 'event' && row.eventId === event.id)
    const receipt = submitted?.receipt
    const notes = []
    const id = ready?.works[target] ?? null
    const threadId = ready?.threads[event.thread]
    const source = state?.sourceEvents.find(row => row.id === receipt?.eventId)
    const intent = state?.workIntents.find(row => row.id === receipt?.intentId)
    const intentCard = projections?.[event.thread]?.intents.find(row => row.id === intent?.id)
    const decision = state?.routingDecisions.find(row => row.id === intent?.decisionId)
    const input = state?.multisite.inputs.find(row => row.id === intent?.acceptedInputId)
    const inputDelivery = input?.deliveries[0]
    const sessionsRows = inputDelivery ? sessions?.[inputDelivery.sessionId]?.events ?? [] : []
    const inputMessage = inputDelivery ? messageId(input.id, inputDelivery.attemptId, inputDelivery.sessionId) : null
    const workerMessages = sessionsRows.filter(row => row.type === 'user/message' && row.data.id === inputMessage)
    const routerRequests = state?.routingRequests.filter(row => row.sourceEventId === source?.id) ?? []
    const physical = calls.filter(call => call.sourceIds.includes(source?.id))
    const router = physical.filter(call => call.kind === 'router')
    const worker = physical.filter(call => call.kind === 'worker')
    const output = []
    let correction = 0, neededAnswer = 0
    if (!receipt) notes.push('缺少 HTTP 受理回执')
    if (kind !== 'stop' && (!source || source.threadId !== threadId || source.actorId !== 'owner' || !intent || !intentCard)) notes.push('Source→Thread/actor/intent 投影缺失')
    if (kind === 'replay') {
      const original = records.find(row => row.type === 'event' && row.eventId === event.replay)?.receipt
      if (!original || digest(receipt) !== digest(original) || state?.sourceEvents.filter(row => row.threadId === threadId && row.sourceEventId === source?.sourceEventId).length !== 1) notes.push('重投未复用同一回执/Source')
    } else if (kind === 'stop') {
      const cancelled = preCleanup?.works.find(row => row.id === id)?.status === 'cancelled'
      const stopCommand = state?.multisite.outbox.find(row => row.command.work_id === id && row.command.operation === 'cancel')
      const stopProof = state?.multisite.receipts.find(row => row.event.work_id === id && row.event.kind === 'stopped' && !row.historical)
      if (!cancelled || !stopCommand?.acceptedAt || !stopProof) notes.push('缺少真实取消受理或 Host 停止证明')
      if (stopCommand && (calls.some(call => call.ledger?.work_id === id && ms(call.arrivedAt, stopCommand.createdAt) > 0) ||
          state.multisite.inputs.some(row => row.workId === id && ms(row.at, stopCommand.createdAt) > 0))) notes.push('停止后仍出现业务模型或正式输入')
      if (receipt) output.push({ kind: 'stop-receipt', noise: false })
    } else {
      const sent = intentCard?.replies ?? []
      if (intentCard?.state === 'accepted') output.push({ kind: 'accepted-status', id: intentCard.id, noise: false })
      if (sent.length !== replyCount) notes.push(sent.length > replyCount ? '重复对人回复' : '漏对人回复')
      for (const [index, reply] of sent.entries()) output.push({ kind: 'reply', id: reply.id, noise: index >= replyCount })
      if (kind === 'clarify' || kind === 'ignore' || kind === 'proposal') {
        const wanted = kind === 'proposal' ? 'create_proposal' : kind
        const ownerDecision = intentCard?.decision
        const ignoredOverlay = kind === 'ignore' && ownerDecision?.action === 'clarify' && ownerDecision.scopeChanged === true && ownerDecision.id === decision?.id
        const ignoredEffect = kind === 'ignore' && (decision?.action !== 'ignore' || intent?.state !== 'ignored' || intent?.workId || decision?.targetWorkId ||
          state?.multisite.outbox.some(row => row.command.parameters.sourceEvent?.id === source?.id && !!source ||
            row.command.parameters.intentFence?.intentId === intent?.id && !!intent))
        if (ownerDecision?.action !== wanted && !ignoredOverlay || ignoredEffect || intent?.acceptedInputId || worker.length || kind === 'proposal' && intent?.workId !== id) notes.push('错误定位/澄清或发生不应有的执行')
        if (kind === 'clarify' && !ownerDecision?.question) notes.push('缺少必要澄清问题')
        if (ownerDecision) output.push({ kind: 'routing-notice', id: ownerDecision.id, noise: kind === 'ignore',
          persistedAction: decision?.action ?? null, visibleAction: ownerDecision.action, scopeChanged: ownerDecision.scopeChanged === true })
      } else if (intent?.workId !== id || input?.workId !== id || workerMessages.length !== 1 || !inputDelivery?.ingestedAt || worker.length < 1 || worker.some(call => call.ledger?.work_id !== id || call.ledger?.session_id !== inputDelivery?.sessionId)) {
        notes.push('错归 Work、正式输入未消费、重复消费或 Worker 链缺失')
      }
      if (input && source && state) {
        const originals = state.multisite.inputs.filter(row => row.workId === id && row.text === input.text)
        if (originals.length !== 1) notes.push('同一要求有多个正式输入')
        for (const call of worker) {
          const ledger = call.ledger, command = state.multisite.outbox.find(row => row.id === ledger?.intentReviewCommandId)?.command
          const reviewId = command && messageId(command.input_id, inputDelivery?.attemptId, inputDelivery?.sessionId)
          if (ledger?.purpose === 'intent_review' ? !command || command.parameters.intentFence?.intentId !== intent?.id || ledger.inputMessageId !== reviewId ||
            (kind === 'answer' ? command.parameters.intentAnswer?.eventId : command.parameters.sourceEvent?.id) !== source.id : ledger?.inputMessageId !== inputMessage) notes.push('实际 Worker 请求的 Session 消息绑定不符')
        }
      }
      if (kind === 'answer') {
        const question = state?.intentQuestions.find(row => row.id === ready?.question?.id)
        if (!sent.some(reply => reply.text.includes('周二上午的维护台账'))) notes.push('责任回答未进入面向 owner 的范围确认')
        if (question?.answeredByEventId !== source?.id || question?.state !== 'answered' || receipt?.answeredIntentQuestionId !== question?.id) notes.push('责任问题未由正式 Source 回答')
        const original = projections?.questions?.intents.find(row => row.id === ready?.seeds['question-seed']?.intentId)?.questions.find(row => row.id === question?.id)
        if (original) output.push({ kind: 'required-question', id: original.id, noise: false })
        neededAnswer = question?.answeredByEventId === source?.id && !!source ? 1 : 0
      }
      correction = source ? state.intentHandbacks.filter(row => row.intentId === intent?.id).length : 0
      if (correction) notes.push('发生非预期纠错交回')
    }
    if (kind === 'accept') {
      if (arm === 'A' ? router.length !== 1 || decision?.method !== 'semantic' || decision.modelRequestId !== router[0]?.ledger?.id || decision.targetWorkId !== id
        : router.length !== 0 || decision?.method !== 'deterministic') notes.push('已知订阅未走指定实验路径')
    } else if (['explicit', 'answer', 'proposal'].includes(kind) && router.length) notes.push('确定入口误进 Router')
    if (['clarify', 'ignore'].includes(kind) && (router.length !== 1 || decision?.method !== 'semantic' || decision.modelRequestId !== router[0]?.ledger?.id)) notes.push('缺少真实语义 Router 决定')
    if (event.id === 'known-tail') {
      const reads = records.filter(row => row.type === 'tool' && row.sourceEventId === source?.id && row.op === 'read_shared_evidence')
      const pages = reads.map(row => row.result)
      const tail = pages.at(-1)
      const grant = state?.evidenceAccessReceipts.find(row => row.evidenceRef.id === tail?.ref.id && row.receiverBinding.work_id === id && row.receiverBinding.session_id === inputDelivery?.sessionId && row.receiverInstructionRevision === input?.revision)
      const indices = pages.flatMap(page => page.entries.map(item => item.entryIndex))
      const actual = worker.findLast(call => pages.length && pages.every(page => toolContent(call.body).some(item => digest(item) === digest(page))))
      if (!tail || tail.partial || indices.length !== 48 || indices.some((value, index) => value !== index) ||
          reads.some((row, index) => index ? row.args.cursor !== pages[index - 1].nextCursor : row.args.cursor !== undefined) ||
          !tail.entries.at(-1)?.description.includes(tailCode) || !grant || !actual || worker.slice(0, -1).some(call => JSON.stringify(call.body).includes(tailCode)) ||
          !intentCard?.replies.some(reply => reply.text.includes(tailCode))) notes.push('尾页召回缺少授权、连续读页、真实模型正文或对人答复')
    }
    if (event.id === 'revision' && input && preCleanup?.artifacts.some(row => row.workId === id && row.status === 'ready' && row.instructionRevision < input.revision)) notes.push('旧要求的成果在新要求下被接受')
    const handoff = state?.contextSubscriptions.find(row => row.id === intent?.handlerSubscriptionId)
    const routeQueued = routerRequests[0]?.createdAt
    const firstRouter = router[0]?.arrivedAt
    const lastReply = intentCard?.replies.at(-1)
    return { id: event.id, kind, phase: event.segment, notes, output, correction, neededAnswer,
      sourceId: source?.id ?? null, threadId: threadId ?? null, intentId: intent?.id ?? null, workId: intent?.workId ?? (kind === 'stop' ? id : null),
      sessionId: inputDelivery?.sessionId ?? handoff?.handlerBinding?.session_id ?? null, inputId: input?.id ?? null, inputMessage,
      sessionMessageCount: workerMessages.length, hostCommandIds: host?.inbox.filter(row => row.command.input_id === input?.id || row.command.parameters.intentFence?.intentId === intent?.id && !!intent).map(row => row.command.command_id) ?? [],
      providerSequences: physical.map(call => call.sequence), ledgerIds: physical.flatMap(call => call.ledger?.id ?? []), routerDecisionId: decision?.id ?? null,
      scheduledMs: submitted?.scheduledMs ?? null, submittedMs: submitted?.submittedMs ?? null, receiptMs: submitted?.receivedMs ?? null,
      routingQueueMs: ms(firstRouter, routeQueued), deliveryMs: ms(handoff?.ingestedAt ?? inputDelivery?.ingestedAt, source?.createdAt),
      formalInputIngestMs: ms(inputDelivery?.ingestedAt, source?.createdAt), endToEndMs: ms(lastReply?.sentAt ?? inputDelivery?.ingestedAt ?? routerRequests[0]?.finishedAt, source?.createdAt) }
  })
  const routers = calls.filter(call => call.kind === 'router'), workers = calls.filter(call => call.kind === 'worker')
  const batches = routers.map(call => ({ sequence: call.sequence, size: call.sourceIds.length, bytes: call.bytes, durationMs: call.durationMs, sourceIds: call.sourceIds, ledgerId: call.ledger?.id ?? null }))
  if (arm !== 'C' && batches.some(batch => batch.size > 1)) failures.push('单项比较臂发生合批')
  const output = eventRows.flatMap(row => row.output)
  const noise = output.filter(row => row.noise).length
  const fast = eventRows.filter(row => row.kind === 'accept' && row.notes.length === 0 && arm !== 'A').length
  const scheduleLagMs = eventRows.flatMap(row => row.submittedMs === null ? [] : [row.submittedMs - row.scheduledMs])
  const kinds = Object.fromEntries([...new Set(eventRows.map(row => row.kind))].map(kind => [kind, eventRows.filter(row => row.kind === kind).length]))
  const candidateCount = eventRows.filter(row => row.routingQueueMs !== null).length
  return { round, raw, compared: ready?.comparisonInputs ?? null, works: ready?.works ?? {}, threads: ready?.threads ?? {}, tasks: Object.keys(ready?.works ?? {}).length, messageCount: events.length, kinds, maxScheduleLagMs: scheduleLagMs.length ? Math.max(...scheduleLagMs) : null,
    failures: [...new Set([...failures, ...eventRows.filter(row => row.notes.length).map(row => row.id)])],
    fastPathCount: fast, fastPathRate: fast / events.length, routerCandidateCount: candidateCount, routerCandidateRate: candidateCount / events.length, noise: { outputs: output.length, noise, rate: output.length ? noise / output.length : null },
    necessaryAnswers: eventRows.reduce((sum, row) => sum + row.neededAnswer, 0), correctionInterventions: eventRows.reduce((sum, row) => sum + row.correction, 0),
    stats: { router: usageTotals(routers), worker: usageTotals(workers), all: usageTotals(calls) }, batches, observedMultiMemberBatches: batches.filter(batch => batch.size > 1).length, events: eventRows }
}

export async function summarize(directories) {
  assert.equal(directories.length, arms.length)
  const results = []
  for (const [index, directory] of directories.entries()) {
    const wire = join(directory, 'raw.jsonl')
    const records = (await readFile(wire, 'utf8')).trimEnd().split('\n').map(JSON.parse)
    const arm = arms[index], start = records.find(row => row.type === 'start'), proof = start?.proof
    assert(start && proof?.arm === arm && records.every(row => row.arm === arm))
    const close = records.find(row => row.type === 'close')
    const failures = records.filter(row => row.type === 'fatal').map(row => row.message)
    if (!close || close.errors.length || close.ports?.length !== 2 || close.ports.some(port => port.status !== 'closed') || !records.find(row => row.type === 'source-end')?.matching) failures.push('未证明清理或候选前后相同')
    const rounds = await Promise.all([1, 2].map(round => roundResult(arm, round, records.filter(row => row.round === round))))
    results.push({ arm, wire, start, failures, rounds })
  }
  const common = results.every(row => digest(row.start.context) === digest(results[0].start.context))
  const isolated = new Set(results.map(row => row.start.pid)).size === arms.length
  const allRounds = results.flatMap(row => row.rounds)
  const fixedInputs = allRounds.every(round => round.compared && digest(round.compared) === digest(allRounds[0].compared))
  const workIds = allRounds.flatMap(round => Object.values(round.works)), threadIds = allRounds.flatMap(round => Object.values(round.threads))
  const freshRounds = workIds.length === allRounds.length * scenario.workNames.length && threadIds.length === allRounds.length * 5 &&
    new Set(workIds).size === workIds.length && new Set(threadIds).size === threadIds.length
  const passed = common && isolated && fixedInputs && freshRounds && results.every(row => !row.failures.length && row.rounds.every(round => !round.failures.length))
  const comparison = (a, b) => a.rounds.map((left, index) => {
    const right = b.rounds[index]
    return { round: left.round,
      routerForwardReduction: left.stats.router.forwards - right.stats.router.forwards,
      allForwardReduction: left.stats.all.forwards - right.stats.all.forwards,
      wireByteReduction: left.stats.all.bodyBytes - right.stats.all.bodyBytes,
      usageCostReductionMicros: left.stats.all.usageCostMicros.total === null || right.stats.all.usageCostMicros.total === null ? null : left.stats.all.usageCostMicros.total - right.stats.all.usageCostMicros.total,
      eventDifferences: left.events.map((event, eventIndex) => {
        const other = right.events[eventIndex]
        return { id: event.id, submitSkewMs: event.submittedMs === null || other.submittedMs === null ? null : other.submittedMs - event.submittedMs,
          endToEndMsReduction: event.endToEndMs === null || other.endToEndMs === null ? null : event.endToEndMs - other.endToEndMs }
      }) }
  })
  return { passed, commonCandidate: common, isolatedArmProcesses: isolated, fixedInputs, freshRounds, roundsPerProcess: scenario.rounds, armOrder: arms, results,
    comparison: passed ? { direct: comparison(results[0], results[1]), batch: comparison(results[1], results[2]) } : null,
    boundary: '同进程重复；模拟用量和内部价格快照，缓存拆分未提供；未分摊批用量至单事件。每轮各列实发节拍；顺序或节拍漂移可影响归因。通过时只比较本次样本，不代表生产 p95、容量或账单。噪声按 owner 投影的受理状态、回复、定位提示、必要问题和停止回执计数；资料模拟，读页和网关真实。旧 XLSX 原件须独立复测。' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await summarize(process.argv.slice(2).map(path => resolve(path)))
  console.log(JSON.stringify(result, null, 2))
  if (!result.passed) process.exitCode = 1
}
