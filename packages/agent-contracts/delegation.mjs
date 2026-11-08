import { SPREADSHEET_CANDIDATE_SCHEMA, spreadsheetCandidateResult } from './spreadsheet-collaboration.mjs'
import { isDeepStrictEqual } from 'node:util'
import { assertResultBytes } from './command-bytes.mjs'
import { evidenceRef } from './evidence.mjs'
import { exact, text, error } from './index.mjs'

export const DELEGATION_CAPABILITIES = Object.freeze(['collaboration.coordinate.v1', 'evidence.history.read.v1', 'evidence.site.inspect.v1', 'analysis.classify.v1', 'office.xlsx.render.v1'])
export const DELEGATION_RESULT_SCHEMA = 'geneway.delegation-result/1'
export const ANALYSIS_RESULT_SCHEMA = 'geneway.analysis-result/1'
export function ids(value, label, allowed) {
  if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 200 || allowed && !allowed.includes(id)) || new Set(value).size !== value.length) throw error('INVALID_REQUEST', `${label}无效`)
  return [...value]
}
export function multisitePolicy(value) {
  exact(value, ['execution', 'delegation']); exact(value.execution, ['capabilityIds', 'resourceRefs']); exact(value.delegation, ['agentIds', 'capabilityIds', 'resourceRefs'])
  return { execution: { capabilityIds: ids(value.execution.capabilityIds, '执行能力', DELEGATION_CAPABILITIES), resourceRefs: ids(value.execution.resourceRefs, '执行资源') },
    delegation: { agentIds: ids(value.delegation.agentIds, '可委派 Agent'), capabilityIds: ids(value.delegation.capabilityIds, '委派能力', DELEGATION_CAPABILITIES), resourceRefs: ids(value.delegation.resourceRefs, '委派资源') } }
}
export function delegationRequest(value) {
  exact(value, ['clientRequestId', 'targetAgentId', 'goal', 'requestedCapabilityId', 'resourceRefs', 'resultSchema', 'instructionRevision', 'evidenceRefs'])
  const request = { ...value, resultSchema: value.resultSchema ?? (value.requestedCapabilityId === 'analysis.classify.v1' ? ANALYSIS_RESULT_SCHEMA : undefined), clientRequestId: text(value.clientRequestId), targetAgentId: text(value.targetAgentId), goal: text(value.goal), resourceRefs: ids(value.resourceRefs, '委派资源') }
  if (!DELEGATION_CAPABILITIES.includes(request.requestedCapabilityId) || ![DELEGATION_RESULT_SCHEMA, ANALYSIS_RESULT_SCHEMA, SPREADSHEET_CANDIDATE_SCHEMA].includes(request.resultSchema) || request.resultSchema === SPREADSHEET_CANDIDATE_SCHEMA && request.requestedCapabilityId !== 'office.xlsx.render.v1' || request.resultSchema === ANALYSIS_RESULT_SCHEMA && request.requestedCapabilityId !== 'analysis.classify.v1' || request.requestedCapabilityId === 'analysis.classify.v1' && request.resultSchema !== ANALYSIS_RESULT_SCHEMA || !Number.isSafeInteger(request.instructionRevision) || request.instructionRevision < 1) throw error('INVALID_REQUEST', '委派能力、结果格式或版本无效')
  if (value.evidenceRefs !== undefined) { evidenceReferences(value.evidenceRefs); request.evidenceRefs = structuredClone(value.evidenceRefs) }
  return request
}
export function delegationResult(value, { admission = false } = {}) {
  exact(value, ['summary', 'evidenceRefs'])
  const summary = text(value.summary, '回报摘要')
  if (summary.length > 4000 || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 32) throw error('INVALID_REQUEST', '委派回报无效')
  for (const ref of value.evidenceRefs) { exact(ref, ['kind', 'id', 'version', 'sha256']); if (ref.kind === 'evidence') { evidenceRef(ref); continue }; if (!['attachment', 'artifact'].includes(ref.kind) || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.version) || ref.version < 1 || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw error('INVALID_REQUEST', '证据引用无效') }
  const result = { summary, evidenceRefs: structuredClone(value.evidenceRefs) }
  return admission ? assertResultBytes(result) : result
}

export function evidenceReferences(value) {
  if (!Array.isArray(value) || value.length > 32) throw error('INVALID_REQUEST', '证据引用无效')
  for (const ref of value) evidenceRef(ref)
  if (new Set(value.map(ref => `${ref.kind}:${ref.id}:${ref.version}:${ref.sha256}`)).size !== value.length) throw error('INVALID_REQUEST', '证据引用重复')
  return value
}
export function analysisResult(value, { admission = false } = {}) {
  exact(value, ['summary', 'evidenceRefs', 'findings', 'limitations'])
  evidenceReferences(value.evidenceRefs)
  text(value.summary)
  if (value.summary.length > 4000 || !Array.isArray(value.findings) || value.findings.length > 64 || !Array.isArray(value.limitations) || value.limitations.length > 32 || value.limitations.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) throw error('INVALID_REQUEST', '分析回报无效')
  for (const finding of value.findings) {
    exact(finding, ['category', 'statement', 'basis', 'certainty'])
    text(finding.statement)
    if (!['history_match', 'collector_issue', 'stale_data', 'insufficient_evidence'].includes(finding.category) || !['supported', 'limited', 'unknown'].includes(finding.certainty) || finding.statement.length > 4000 || !Array.isArray(finding.basis) || finding.basis.length > 32) throw error('INVALID_REQUEST')
    if (!finding.basis.length && (finding.category !== 'insufficient_evidence' || finding.certainty !== 'unknown')) throw error('INVALID_REQUEST')
    for (const basis of finding.basis) {
      exact(basis, ['evidenceRef', 'entryIndexes', 'sourceEventIds']); evidenceRef(basis.evidenceRef)
      if (!value.evidenceRefs.some(ref => isDeepStrictEqual(ref, basis.evidenceRef)) || !!basis.entryIndexes === !!basis.sourceEventIds) throw error('INVALID_REQUEST')
      if (basis.entryIndexes && (!Array.isArray(basis.entryIndexes) || !basis.entryIndexes.length || basis.entryIndexes.length > 200 || new Set(basis.entryIndexes).size !== basis.entryIndexes.length || basis.entryIndexes.some(index => !Number.isSafeInteger(index) || index < 0))) throw error('INVALID_REQUEST')
      if (basis.sourceEventIds && (!Array.isArray(basis.sourceEventIds) || !basis.sourceEventIds.length || basis.sourceEventIds.length > 200 || new Set(basis.sourceEventIds).size !== basis.sourceEventIds.length || basis.sourceEventIds.some(id => typeof id !== 'string' || !id || id.length > 128))) throw error('INVALID_REQUEST')
    }
  }
  const result = structuredClone(value)
  return admission ? assertResultBytes(result) : result
}
export const resultPayload = (value, schema, options) => schema === SPREADSHEET_CANDIDATE_SCHEMA ? spreadsheetCandidateResult(value, options) : schema === ANALYSIS_RESULT_SCHEMA ? analysisResult(value, options) : delegationResult(value, options)
