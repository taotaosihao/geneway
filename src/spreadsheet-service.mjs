import { createSpreadsheetCollaborationService } from './spreadsheet-collaboration-service.mjs'
import { assertManualJobAdmission } from './manual-control.mjs'
import { isCollaborationSpreadsheet } from './spreadsheet-template.mjs'
import { assertOutputProducer } from './spreadsheet-sources.mjs'
import { assertSpreadsheetAuthority } from '../packages/agent-contracts/tools.mjs'
import { isDeepStrictEqual } from 'node:util'
import { attachmentRefs, digest, error, exact } from '../packages/agent-contracts/index.mjs'
import { templateReference, INCIDENT_TEMPLATE } from './spreadsheet-template.mjs'

const refEqual = (left, right) => isDeepStrictEqual(left, right)
export function createSpreadsheetService({ store, attachments, gateway, evidence }) {
  const collaboration = createSpreadsheetCollaborationService({ store, attachments, evidence })
  async function access(execution, { job } = {}) {
    const result = await gateway.authorize(execution)
    assertManualJobAdmission(result.state, execution, job)
    assertSpreadsheetAuthority(result.current)
    if (!result.work.spreadsheetRequest) throw error('FORBIDDEN', '本工作尚未选择生成整改表')
    if (isCollaborationSpreadsheet(result.work.spreadsheetRequest)) assertOutputProducer(result.state, execution)
    else if (result.state.multisite.attempts.filter(attempt => attempt.work_id === result.work.id).length !== 1) throw error('INVALID_REQUEST', '整改表场景只支持一个执行员工')
    return result
  }
  async function read(execution, ref) {
    const result = await access(execution)
    if (!result.refs.some(item => refEqual(item, ref))) throw error('FORBIDDEN', '资料不属于当前工作')
    const file = await attachments.download(result.owner, ref.attachmentId)
    await access(execution)
    if (file.metadata.mediaType === 'application/json') return { ref, mediaType: file.metadata.mediaType, name: file.metadata.name, entries: JSON.parse(file.bytes.toString('utf8')).entries }
    return { ref, mediaType: file.metadata.mediaType, name: file.metadata.name, sizeBytes: file.metadata.sizeBytes }
  }
  return {
    authorize: access,
    async readEvidence(execution, parameters) {
      exact(parameters, ['ref', 'selection'])
      const ref = attachmentRefs([parameters.ref])[0], result = await read(execution, ref), current = await access(execution)
      if (parameters.selection !== undefined) {
        exact(parameters.selection, ['entryIndexes'])
        const indexes = parameters.selection.entryIndexes
        if (!result.entries || !Array.isArray(indexes) || indexes.length > 200 || new Set(indexes).size !== indexes.length || indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= result.entries.length)) throw error('INVALID_REQUEST', '资料选择范围无效')
        result.entries = indexes.map(entryIndex => ({ entryIndex, ...result.entries[entryIndex] }))
      } else if (result.entries) result.entries = result.entries.map((entry, entryIndex) => ({ entryIndex, ...entry }))
      return { ...result, instructionRevision: current.current.instruction_revision, spreadsheetRequest: current.work.spreadsheetRequest, template: templateReference() }
    },
    async prepare(execution, parameters) {
      if (isCollaborationSpreadsheet((await store.read()).works.find(work => work.id === execution.work_id)?.spreadsheetRequest)) return collaboration.prepare(execution, parameters)
      exact(parameters, ['clientRequestId', 'instructionRevision', 'template', 'historyRefs', 'rows'])
      if (typeof parameters.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(parameters.clientRequestId)) throw error('INVALID_REQUEST', '表格请求 ID 无效')
      exact(parameters.template, ['id', 'version', 'sha256'])
      if (!isDeepStrictEqual(parameters.template, templateReference())) throw error('REVISION_CONFLICT', '模板快照不匹配')
      const initial = await access(execution), request = initial.work.spreadsheetRequest
      if (initial.work.modelRequestBudget.exhaustedAt) throw error('BUDGET_EXHAUSTED')
      if (parameters.instructionRevision !== initial.current.instruction_revision) throw error('REVISION_CONFLICT', '资料版本已变化')
      const input = initial.state.multisite.inputs.find(input => input.workId === initial.work.id && input.revision === parameters.instructionRevision)
      if (!input || !isDeepStrictEqual(input.spreadsheetRequest, request)) throw error('REVISION_CONFLICT', '用户要求快照不匹配')
      if (request.dueDate === null) throw error('MISSING_INPUT', '请用户明确整改期限后再生成')
      const expectedRefs = initial.refs.filter(ref => initial.state.attachments.find(file => file.id === ref.attachmentId)?.mediaType === 'application/json')
      const suppliedRefs = attachmentRefs(parameters.historyRefs)
      if (!expectedRefs.length || suppliedRefs.length !== expectedRefs.length || expectedRefs.some(ref => !suppliedRefs.some(item => refEqual(item, ref)))) throw error('INVALID_REQUEST', '必须覆盖本工作全部历史资料')
      const evidence = []
      for (const sourceRef of expectedRefs) { const history = await read(execution, sourceRef); evidence.push({ sourceRef, entries: history.entries }) }
      if (!Array.isArray(parameters.rows) || parameters.rows.length !== evidence.reduce((sum, item) => sum + item.entries.length, 0) || parameters.rows.length > 1600) throw error('INVALID_REQUEST', '整改表条目必须完整且不重复')
      const rows = [], seen = new Set()
      for (const row of parameters.rows) {
        exact(row, ['sourceRef', 'entryIndex', 'dueDate', 'photoRefs'])
        attachmentRefs([row.sourceRef]); attachmentRefs(row.photoRefs)
        const source = evidence.find(item => refEqual(item.sourceRef, row.sourceRef)), identity = `${row.sourceRef.attachmentId}#${row.entryIndex}`
        if (!source || !Number.isSafeInteger(row.entryIndex) || !source.entries[row.entryIndex] || row.dueDate !== request.dueDate || seen.has(identity)) throw error('INVALID_REQUEST', '条目来源、期限或唯一性无效')
        for (const photo of row.photoRefs) if (!initial.refs.some(ref => refEqual(ref, photo)) || !['image/png', 'image/jpeg'].includes(initial.state.attachments.find(file => file.id === photo.attachmentId)?.mediaType)) throw error('FORBIDDEN', '照片引用未获准')
        seen.add(identity)
      }
      for (const source of evidence) for (let entryIndex = 0; entryIndex < source.entries.length; entryIndex++) {
        const supplied = parameters.rows.find(row => refEqual(row.sourceRef, source.sourceRef) && row.entryIndex === entryIndex)
        if (!supplied) throw error('INVALID_REQUEST', '缺少历史条目')
        rows.push({ sourceRef: source.sourceRef, entryIndex, dueDate: request.dueDate, photoRefs: attachmentRefs(supplied.photoRefs) })
      }
      const current = await access(execution)
      if (current.current.instruction_revision !== parameters.instructionRevision || !isDeepStrictEqual(current.work.spreadsheetRequest, request)) throw error('REVISION_CONFLICT')
      const value = { inputId: input.id, instructionRevision: parameters.instructionRevision, template: templateReference(), calculationVersion: INCIDENT_TEMPLATE.calculationVersion, dueDate: request.dueDate, historyRefs: expectedRefs, evidence, rows }
      return { clientRequestId: parameters.clientRequestId, input: value, inputDigest: digest(value) }
    },
    async revalidate(execution, input, options = {}) {
      const job = options.job ?? (execution.id && execution.inputDigest ? { id: execution.id, inputDigest: execution.inputDigest } : undefined)
      if (isCollaborationSpreadsheet((await store.read()).works.find(work => work.id === execution.work_id)?.spreadsheetRequest)) return collaboration.revalidate(execution, input, { job })
      const result = await access(execution, { job })
      if (result.current.instruction_revision !== input.instructionRevision || result.work.spreadsheetRequest.dueDate !== input.dueDate) throw error('REVISION_CONFLICT')
      return true
    },
  }
}
