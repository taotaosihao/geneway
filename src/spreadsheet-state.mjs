import { isCollaborationSpreadsheet } from './spreadsheet-template.mjs'
import { isDeepStrictEqual } from 'node:util'
import { binding, sameBinding, attachmentRefs, error } from '../packages/agent-contracts/index.mjs'
import { assertSpreadsheetJobProjection } from '../packages/agent-contracts/spreadsheet.mjs'

const check = (condition, label) => { if (!condition) throw error('INVALID_STATE', `表格投影无效：${label}`) }
const fixed = row => ({ ...binding(row), id: row.id, clientRequestId: row.clientRequestId, requestDigest: row.requestDigest, instructionRevision: row.instructionRevision, template: row.template, historyRefs: row.historyRefs, rows: row.rows, inputDigest: row.inputDigest, outputKind: row.outputKind, acceptedAt: row.acceptedAt, inputId: row.inputId, ...(row.inputEncodingVersion === 2 ? { inputEncodingVersion: 2 } : {}), ...(row.sourceManifest ? { sourceManifest: row.sourceManifest, sourceManifestDigest: row.sourceManifestDigest } : {}) })
export function applySpreadsheetJobEvent(state, event) {
  const job = event.job
  assertSpreadsheetJobProjection(job)
  check(job && sameBinding(job, event) && job.instructionRevision === event.instruction_revision && typeof job.id === 'string' && Number.isSafeInteger(job.sequence), 'Job event绑定')
  const old = state.multisite.jobs.find(row => row.id === job.id)
  const next = { ...structuredClone(job), inputId: event.input_id, eventId: event.event_id, nodeId: event.node_id }
  if (old) {
    check(job.sequence === old.sequence + 1 && isDeepStrictEqual(fixed(old), fixed(next)), 'Job序号或受理事实')
    Object.assign(old, next)
  } else { check(job.sequence === 1 && job.state === 'accepted', 'Job首事件'); state.multisite.jobs.push(next) }
}
export function validateSpreadsheetState(state) {
  check(Array.isArray(state.artifacts), '成果域缺失')
  check(new Set(state.artifacts.map(row => row.id)).size === state.artifacts.length && new Set(state.artifacts.map(row => row.jobId)).size === state.artifacts.length, '成果身份或Job重复')
  for (const row of state.artifacts) {
    const work = state.works.find(work => work.id === row.workId), job = state.multisite.jobs.find(job => job.id === row.jobId)
    check(work?.workType === 'multisite' && work.origin !== 'rule' && job && row.work_id === work.id && sameBinding(job, row) && row.ownerMemberId === work.ownerMemberId && row.workspaceId === work.workspaceId && row.instructionRevision === job.instructionRevision && row.inputDigest === job.inputDigest, '成果来源绑定')
    check(row.version === 1 && ['pending', 'candidate', 'ready', 'rejected'].includes(row.status) && /^[a-f0-9]{64}$/.test(row.sha256) && row.sha256 === job.output?.sha256 && row.sizeBytes === job.output?.sizeBytes && row.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '成果版本或字节声明')
    if (row.status === 'ready' && isCollaborationSpreadsheet(work.spreadsheetRequest)) check(row.candidateVerification && state.spreadsheetReviews.some(review => review.id === row.verification?.reviewId && review.candidateId === row.id && review.sha256 === row.sha256 && review.manifestDigest === row.manifestDigest), '多来源完成必须同事务有关联协调核验')
    if (row.status === 'ready') check(row.verification?.version === 1 && Number.isFinite(Date.parse(row.verification.at)) && work.status === 'completed' && work.artifactRefs?.some(ref => ref.artifactId === row.id && ref.version === row.version && ref.sha256 === row.sha256), 'ready必须与Work完成同事务')
  }
  for (const work of state.works.filter(work => work.workType === 'multisite' && work.status === 'completed')) {
    if (work.origin === 'rule') {
      check(!work.artifactRefs?.length && state.siteDiagnosisDrafts?.some(draft => draft.workId === work.id && draft.version === 1 && draft.kind === 'site_connection_diagnosis' && draft.createdAt === work.completedAt), '受管诊断完成必须关联已核验草稿')
    } else {
      check(work.artifactRefs?.length === 1 && Number.isFinite(Date.parse(work.completedAt)) && work.artifactRefs.every(ref => state.artifacts.some(row => row.id === ref.artifactId && row.workId === work.id && row.status === 'ready' && row.sha256 === ref.sha256 && row.version === ref.version)), 'Work完成必须关联唯一ready成果')
    }
    check(state.multisite.attempts.filter(attempt => attempt.work_id === work.id).every(attempt => isCollaborationSpreadsheet(work.spreadsheetRequest) ? ['completed', 'cancelled'].includes(attempt.status) : attempt.status === 'completed') && state.multisite.delegations.filter(item => item.workId === work.id).every(item => isCollaborationSpreadsheet(work.spreadsheetRequest) ? ['completed', 'cancelled'].includes(item.status) : item.status === 'completed'), 'Work完成必须关闭执行和委派')
    check(state.multisite.outbox.some(row => row.command.work_id === work.id && row.command.operation === 'settle'), '完成必须同事务写settle')
  }
  check(Array.isArray(state.multisite.jobs) && state.multisite.jobs.length <= 10_000 && new Set(state.multisite.jobs.map(row => row.id)).size === state.multisite.jobs.length, 'Job投影域')
  for (const row of state.multisite.jobs) {
    const receipt = state.multisite.receipts.find(receipt => receipt.event.event_id === row.eventId && receipt.nodeId === row.nodeId)
    check(receipt?.event.kind === 'spreadsheet_job' && receipt.event.job.id === row.id && receipt.event.job.sequence === row.sequence && sameBinding(receipt.event, row) && receipt.event.input_id === row.inputId, 'Job投影必须关联sealed receipt')
    const { inputId, eventId, nodeId, ...value } = row
    check(isDeepStrictEqual(value, receipt.event.job), '投影不得改写来源事实')
    attachmentRefs(row.historyRefs)
  }
  return state
}
export function assertSpreadsheetStateImmutable(before, after) {
  for (const row of before.artifacts) {
    const current = after.artifacts.find(item => item.id === row.id)
    const fixed = value => value && Object.fromEntries(Object.entries(value).filter(([field]) => !['status', 'candidateAt', 'verification', 'rejectionReason', 'candidateVerification'].includes(field)))
    check(current && isDeepStrictEqual(fixed(row), fixed(current)), '成果声明不可改写')
    if (row.candidateVerification) check(isDeepStrictEqual(current.candidateVerification, row.candidateVerification), '候选核验事实不可改写')
    if (['ready', 'rejected'].includes(row.status)) check(isDeepStrictEqual(current, row), '成果终态不可改写')
  }
  for (const work of before.works.filter(work => work.workType === 'multisite' && work.status === 'completed')) {
    const current = after.works.find(row => row.id === work.id)
    check(current?.status === 'completed' && current.completedAt === work.completedAt && isDeepStrictEqual(current.artifactRefs, work.artifactRefs), '已完成Work不得回退')
  }
  for (const job of before.multisite.jobs) {
    const current = after.multisite.jobs.find(row => row.id === job.id)
    check(current && current.sequence >= job.sequence && isDeepStrictEqual(fixed(job), fixed(current)), 'Job投影不可改写受理事实')
  }
}
