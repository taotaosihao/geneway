import { isDeepStrictEqual } from 'node:util'
import { digest, error, exact, sameBinding, BINDING_FIELDS } from '../packages/agent-contracts/index.mjs'
import { knownUsageCost, budgetPolicy } from './work-budget.mjs'
import { validateModelSnapshot } from './model-route.mjs'

export const SUPERVISION_DIAGNOSIS_LIMITS = Object.freeze({ maxCalls: 3, maxReservedTokens: 262144, maxReservedCostMicros: 1000, timeoutMs: 120000, maxBodyBytes: 16384, maxOutputTokens: 512, maxFacts: 16, maxRefs: 4, cooldownMs: 60000, maxTextChars: 160, maxInputChars: 600 })
export const SUPERVISION_DIAGNOSIS_PROMPT = '你是受限的工作监督诊断者。只依据本次事实包判断当前义务是否存在有证据的风险。报告是执行者陈述，不是完成证明；缺资料不等于没有成果。不得调用工具、执行动作或请求更多资料。返回一个JSON对象：kind只能为insufficient_evidence、possible_drift、no_progress、repeated_error、no_issue；refs是本包事实ID数组，最多4个；reason和advice为各不超过160字符的中文解释和人工建议。证据不全必须insufficient_evidence，不得编造引用或把建议说成已经执行。'
export const DIAGNOSIS_KINDS = ['insufficient_evidence', 'possible_drift', 'no_progress', 'repeated_error', 'no_issue']
export const emptySupervisionDiagnosisState = () => ({ supervisionDiagnosisGrants: [], supervisionDiagnoses: [], supervisionDiagnosisFeedback: [], supervisionToolRejections: [] })
const valid = (condition, label) => { if (!condition) throw error('INVALID_STATE', '监督诊断事实无效：' + label) }
const at = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const fields = (row, required) => { exact(row, required); valid(required.every(name => Object.hasOwn(row, name)), '缺少字段') }

export function validateSupervisionDiagnosisLedger(state, row) {
  fields(row, ['id', 'purpose', 'source', 'diagnosisSessionId', 'modelSnapshot', 'budgetPolicySnapshot', 'estimate', 'modelPriceSnapshot', 'forwardedBodyBytes', 'bodyDigest', 'reservedAt', 'outcome', 'usage', 'usageCostMicros', 'completedAt', 'noForwardReason'])
  fields(row.source, ['findingId', 'episodeId', 'grantId', 'grantRevision', 'subjectBinding', 'instructionRevision'])
  fields(row.source.subjectBinding, BINDING_FIELDS)
  const diagnosis = state.supervisionDiagnoses.find(item => item.sessionId === row.diagnosisSessionId && item.modelRequestId === row.id)
  const grant = state.supervisionDiagnosisGrants.find(item => item.id === row.source.grantId)
  valid(row.purpose === 'supervision_diagnosis' && diagnosis && grant && diagnosis.findingId === row.source.findingId && diagnosis.episodeId === row.source.episodeId && diagnosis.grantId === grant.id && row.source.grantRevision === grant.grantRevision && grant.instructionRevision === diagnosis.instructionRevision && grant.workspaceId === diagnosis.workspaceId && row.source.instructionRevision === diagnosis.instructionRevision && sameBinding(row.source.subjectBinding, diagnosis.subjectBinding), '用途来源')
  valid(isDeepStrictEqual(row.modelSnapshot, diagnosis.modelSnapshot) && isDeepStrictEqual(row.budgetPolicySnapshot, diagnosis.budgetPolicySnapshot), '冻结模型与预算')
  valid(at(row.reservedAt) && ['unknown', 'completed', 'failed'].includes(row.outcome) && (row.completedAt === null || at(row.completedAt)) && /^[a-f0-9]{64}$/.test(row.bodyDigest), '账本状态')
  valid(Number.isSafeInteger(row.forwardedBodyBytes) && row.forwardedBodyBytes > 0 && row.forwardedBodyBytes <= SUPERVISION_DIAGNOSIS_LIMITS.maxBodyBytes, '实际包络')
  valid(row.usage === null || row.usage && typeof row.usage === 'object' && !Array.isArray(row.usage) && Object.keys(row.usage).length > 0 && Object.entries(row.usage).every(([key, value]) => ['prompt_tokens', 'completion_tokens', 'total_tokens'].includes(key) && Number.isSafeInteger(value) && value >= 0), 'usage')
  fields(row.estimate, ['inputTokens', 'outputTokens', 'totalTokens', 'costMicros'])
  fields(row.modelPriceSnapshot, ['provider', 'model', 'inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens'])
  const policy = row.budgetPolicySnapshot, estimator = policy.estimator, numerator = BigInt(row.forwardedBodyBytes) * BigInt(estimator.inputBytesNumerator), denominator = BigInt(estimator.inputBytesDenominator)
  const input = Number((numerator + denominator - 1n) / denominator + BigInt(estimator.fixedInputTokens)), output = Math.min(SUPERVISION_DIAGNOSIS_LIMITS.maxOutputTokens, row.modelSnapshot.parameters.maxOutputTokens)
  const price = policy.modelPrices.find(item => item.provider === row.modelSnapshot.provider && item.model === row.modelSnapshot.model), ceil = value => (value + 999999n) / 1000000n
  valid(price && isDeepStrictEqual(price, row.modelPriceSnapshot) && row.estimate.inputTokens === input && row.estimate.outputTokens === output && row.estimate.totalTokens === input + output && row.estimate.costMicros === Number(ceil(BigInt(input) * BigInt(price.inputMicrosPerMillionTokens)) + ceil(BigInt(output) * BigInt(price.outputMicrosPerMillionTokens))) && row.usageCostMicros === knownUsageCost(row.usage, price), '保守独立计量')
  valid(row.noForwardReason === null || typeof row.noForwardReason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.noForwardReason) && row.outcome === 'failed' && row.usage === null && at(row.completedAt), '确定未转发')
  return row
}
export function validateSupervisionDiagnosisState(state) {
  for (const name of Object.keys(emptySupervisionDiagnosisState())) valid(Array.isArray(state[name]) && state[name].length <= 30000 && new Set(state[name].map(row => row.id)).size === state[name].length, name)
  for (const row of state.supervisionDiagnosisGrants) {
    fields(row, ['id', 'workspaceId', 'workId', 'actorId', 'coordinatorRevision', 'instructionRevision', 'diagnosisIdentityId', 'grantRevision', 'enabled', 'clientRequestId', 'requestDigest', 'acceptedAt'])
    valid(state.works.some(work => work.id === row.workId && work.workspaceId === row.workspaceId && work.ownerMemberId === row.actorId) && Number.isSafeInteger(row.grantRevision) && row.grantRevision > 0 && typeof row.enabled === 'boolean' && at(row.acceptedAt) && /^[a-f0-9]{64}$/.test(row.requestDigest), 'grant')
  }
  valid(new Set(state.supervisionDiagnosisGrants.map(row => row.workId + ':' + row.grantRevision)).size === state.supervisionDiagnosisGrants.length, 'grant代次')
  for (const row of state.supervisionDiagnoses) {
    fields(row, ['id', 'workspaceId', 'workId', 'findingId', 'episodeId', 'grantId', 'grantRevision', 'subjectBinding', 'instructionRevision', 'sessionId', 'modelRequestId', 'packet', 'packetDigest', 'progressDigest', 'modelSnapshot', 'budgetPolicySnapshot', 'claimedAt', 'deadlineAt', 'state', 'result', 'finishedAt', 'reviewRequired', 'errorCode'])
    fields(row.subjectBinding, BINDING_FIELDS)
    validateModelSnapshot(row.modelSnapshot)
    const { id: policyId, revision: policyRevision, ...configuration } = row.budgetPolicySnapshot
    budgetPolicy(configuration)
    valid(typeof policyId === 'string' && Number.isSafeInteger(policyRevision), '策略快照')
    valid(state.supervisionDiagnosisGrants.some(grant => grant.id === row.grantId && grant.workId === row.workId && grant.grantRevision === row.grantRevision && grant.instructionRevision === row.instructionRevision && grant.workspaceId === row.workspaceId) && state.supervisionFindings.some(finding => finding.id === row.findingId && finding.episodeId === row.episodeId && finding.scope.workId === row.workId && finding.scope.attemptId === row.subjectBinding.attempt_id && finding.scope.nodeId === row.subjectBinding.node_id) && state.multisite.attempts.some(attempt => sameBinding(attempt, row.subjectBinding)) && row.subjectBinding.work_id === row.workId && row.packetDigest === digest(row.packet), '诊断来源')
    valid(typeof row.sessionId === 'string' && typeof row.modelRequestId === 'string' && ['claimed', 'running', 'completed', 'failed', 'unknown'].includes(row.state) && at(row.claimedAt) && at(row.deadlineAt) && (row.finishedAt === null || at(row.finishedAt)) && typeof row.reviewRequired === 'boolean', '诊断生命周期')
    valid(row.result === null || DIAGNOSIS_KINDS.includes(row.result.kind) && typeof row.result.reason === 'string' && row.result.reason.length <= 160 && typeof row.result.advice === 'string' && row.result.advice.length <= 160 && Array.isArray(row.result.refs) && row.result.refs.length <= 4 && row.result.refs.every(id => row.packet.facts.some(fact => fact.id === id)), '有限结论')
    valid(Array.isArray(row.packet.facts) && row.packet.facts.length <= SUPERVISION_DIAGNOSIS_LIMITS.maxFacts && Buffer.byteLength(JSON.stringify(row.packet)) <= SUPERVISION_DIAGNOSIS_LIMITS.maxBodyBytes, '事实包')
  }
  valid(new Set(state.supervisionDiagnoses.map(row => row.sessionId)).size === state.supervisionDiagnoses.length && new Set(state.supervisionDiagnoses.map(row => row.episodeId + ':' + row.workId)).size === state.supervisionDiagnoses.length, '每episode一次')
  for (const row of state.supervisionDiagnosisFeedback) {
    fields(row, ['id', 'diagnosisId', 'actorId', 'kind', 'note', 'refs', 'clientRequestId', 'requestDigest', 'createdAt'])
    valid(state.supervisionDiagnoses.some(diagnosis => diagnosis.id === row.diagnosisId) && ['false_positive', 'new_evidence', 'acknowledged'].includes(row.kind) && typeof row.note === 'string' && row.note.length <= 160 && Array.isArray(row.refs) && row.refs.length <= 4 && row.refs.every(id => typeof id === 'string') && at(row.createdAt), '人工反馈')
  }
  for (const row of state.supervisionToolRejections) {
    fields(row, ['id', 'workspaceId', 'subjectBinding', 'instructionRevision', 'clientRequestId', 'tool', 'code', 'observedAt'])
    valid(row.tool === 'complete_delegation' && row.code === 'RESULT_SCHEMA_INVALID' && at(row.observedAt) && state.multisite.attempts.some(attempt => sameBinding(attempt, row.subjectBinding)), '合法结构拒绝')
  }
  return state
}
export function assertSupervisionDiagnosisImmutable(before, after) {
  for (const name of ['supervisionDiagnosisGrants', 'supervisionDiagnosisFeedback', 'supervisionToolRejections']) valid(isDeepStrictEqual(before[name] ?? [], after[name].slice(0, before[name]?.length ?? 0)), name + '不可改写')
  for (const row of before.supervisionDiagnoses ?? []) {
    const next = after.supervisionDiagnoses.find(item => item.id === row.id), mutable = ['state', 'result', 'finishedAt', 'reviewRequired', 'errorCode'], fixed = value => value && Object.fromEntries(Object.entries(value).filter(([key]) => !mutable.includes(key)))
    valid(isDeepStrictEqual(fixed(row), fixed(next)), '预约不可改写')
    if (['completed', 'failed', 'unknown'].includes(row.state)) valid(isDeepStrictEqual(row, next), '诊断终态不可改写')
  }
}
