import ExcelJS from 'exceljs'
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { binding, digest, error, exact, key } from '../packages/agent-contracts/index.mjs'
import { EVIDENCE_LIMITS as L } from '../packages/agent-contracts/evidence.mjs'
import { assertNodeCaller } from '../packages/agent-contracts/nodes.mjs'
import { assertCoordinatorCandidate, assertCandidatePageContext } from './spreadsheet-sources.mjs'
import { budgetTokenExpiry } from './work-budget.mjs'
import { assertManualExecution, manualFence } from './manual-control.mjs'
const sections = ['history', 'site', 'analysis', 'manifest']
export async function spreadsheetCells(bytes) {
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes)
  return Object.fromEntries(book.worksheets.map((sheet, index) => {
    const cells = []
    for (let row = 1; row <= sheet.rowCount; row++) for (let column = 1; column <= sheet.columnCount; column++) {
      const value = sheet.getCell(row, column).value ?? '', points = typeof value === 'string' ? Array.from(value) : null, parts = points ? Math.max(1, Math.ceil(points.length / 1000)) : 1
      for (let part = 0; part < parts; part++) cells.push({ row, column, part, parts, value: points ? points.slice(part * 1000, (part + 1) * 1000).join('') : value })
    }
    return [sections[index], cells]
  }))
}
export function createSpreadsheetCandidateReader({ store, readBytes, clock = () => Date.now() }) {
  const cursorKey = randomBytes(32)
  function encode(value) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return body + '.' + createHmac('sha256', cursorKey).update(body).digest('base64url') }
  function decode(value) { try { if (typeof value !== 'string' || Buffer.byteLength(value) > L.cursorBytes) throw error('INVALID_CURSOR'); const [body, signature, extra] = value.split('.'), actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', cursorKey).update(body).digest(); if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw error('INVALID_CURSOR'); return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { throw error('INVALID_CURSOR') } }
  return { async read(execution, parameters, nodeAuth, capturedFence) {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'candidateId', 'section', 'cursor', 'startIndex'])
    if (typeof parameters.clientRequestId !== 'string' || !parameters.clientRequestId || parameters.clientRequestId.length > 128 || !sections.includes(parameters.section) || parameters.cursor !== undefined && parameters.startIndex !== undefined) throw error('INVALID_REQUEST')
    let state = await store.read(); if (nodeAuth) assertNodeCaller(state, nodeAuth, execution)
    if (capturedFence === undefined) capturedFence = manualFence(state, execution)
    const namespace = key(state.works.find(row => row.id === execution.work_id)?.workspaceId, execution.attempt_id, parameters.clientRequestId)
    const accepted = state.multisite.commands.find(row => row.key === namespace)
    if (!accepted) assertManualExecution(state, execution, capturedFence)
    let access = assertCoordinatorCandidate(state, execution, parameters.candidateId)
    if (parameters.instructionRevision !== access.work.instructionRevision) throw error('REVISION_CONFLICT')
    const bytes = await readBytes(access.artifact), all = await spreadsheetCells(bytes), cells = all[parameters.section], commandDigest = digest({ operation: 'read_spreadsheet_candidate', parameters }), id = key('spreadsheet-read', namespace)
    let start = parameters.startIndex ?? 0, pages = 0, used = 0
    if (parameters.cursor !== undefined) { const value = decode(parameters.cursor); if (value.candidateId !== access.artifact.id || value.sha256 !== access.artifact.sha256 || value.bindingDigest !== digest(binding(execution)) || value.revision !== parameters.instructionRevision || value.section !== parameters.section || clock() >= value.expiresAt) throw error('INVALID_CURSOR'); start = value.nextIndex; pages = value.pages; used = value.bytes }
    if (!Number.isSafeInteger(start) || start < 0 || start > cells.length || pages >= L.chainPages || used >= L.chainBytes) throw error('EVIDENCE_READ_LIMIT')
    const expiresAt = budgetTokenExpiry(access.work, clock() + 300000, clock()), selected = []
    const envelope = values => {
      const nextIndex = start + values.length, more = nextIndex < cells.length, canContinue = more && pages + 1 < L.chainPages && used + L.pageBytes <= L.chainBytes
      let size = 0
      for (let attempt = 0; attempt < 12; attempt++) {
        const result = { schema: 'geneway.spreadsheet-candidate-page/1', workId: access.work.id, readReceiptId: id, candidateId: access.artifact.id, sha256: access.artifact.sha256, manifestDigest: access.artifact.manifestDigest, instructionRevision: parameters.instructionRevision, section: parameters.section, totalCells: cells.length, startIndex: start, nextIndex, cells: values, partial: more, nextCursor: canContinue ? encode({ candidateId: access.artifact.id, sha256: access.artifact.sha256, bindingDigest: digest(binding(execution)), revision: parameters.instructionRevision, section: parameters.section, nextIndex, pages: pages + 1, bytes: used + size, expiresAt }) : null, nextChainStart: more && !canContinue ? nextIndex : null, bytes: size }
        const actual = Buffer.byteLength(JSON.stringify(result)); if (actual === size) return result; size = actual
      }
      throw error('INVALID_STATE')
    }
    while (selected.length < L.pageItems && start + selected.length < cells.length) { const next = [...selected, cells[start + selected.length]], candidate = envelope(next); if (Buffer.byteLength(JSON.stringify(candidate)) > L.pageBytes || used + candidate.bytes > L.chainBytes) break; selected.push(next.at(-1)) }
    if (!selected.length && start < cells.length) throw error('EVIDENCE_READ_LIMIT')
    const result = envelope(selected)
    if (Buffer.byteLength(JSON.stringify(result)) > L.pageBytes) throw error('EVIDENCE_READ_LIMIT')
    state = await store.read(); if (nodeAuth) assertNodeCaller(state, nodeAuth, execution); access = assertCoordinatorCandidate(state, execution, parameters.candidateId)
    if (!accepted) assertManualExecution(state, execution, capturedFence)
    if (access.work.instructionRevision !== parameters.instructionRevision) throw error('REVISION_CONFLICT')
    let reply
    await store.update(draft => {
      if (nodeAuth) assertNodeCaller(draft, nodeAuth, execution)
      const current = assertCoordinatorCandidate(draft, execution, parameters.candidateId)
      if (current.work.instructionRevision !== parameters.instructionRevision) throw error('REVISION_CONFLICT')
      const old = draft.multisite.commands.find(row => row.key === namespace)
      if (old) { if (old.digest !== commandDigest) throw error('IDEMPOTENCY_CONFLICT'); reply = old.reply; return draft }
      assertManualExecution(draft, execution, capturedFence)
      draft.spreadsheetReads.push({ id, ...binding(execution), instructionRevision: parameters.instructionRevision, candidateId: access.artifact.id, sha256: access.artifact.sha256, manifestDigest: access.artifact.manifestDigest, section: parameters.section, fromIndex: start, toIndex: start + selected.length, totalCells: cells.length, pageDigest: digest(result), sourceCommandKey: namespace, readAt: new Date(clock()).toISOString() })
      draft.multisite.commands.push({ key: namespace, workspaceId: current.work.workspaceId, issuerId: execution.attempt_id, issuerKind: 'agent', senderBinding: binding(execution), commandId: parameters.clientRequestId, digest: commandDigest, reply: result, acceptedAt: new Date(clock()).toISOString() }); reply = result; return draft
    })
    return reply
  } }
}
export function consumedSpreadsheetPages(state, execution, body) {
  const ids = new Set(), calls = new Map()
  for (const message of body.messages) {
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) if (call.type === 'function') calls.set(call.id, call.function)
    if (message.role !== 'tool' || calls.get(message.tool_call_id)?.name !== 'geneway_read_spreadsheet_candidate') continue
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text).join('') : ''
    let page, parameters; try { const value = JSON.parse(text); page = value.result ?? value; parameters = JSON.parse(calls.get(message.tool_call_id).arguments) } catch { continue }
    { const row = state.spreadsheetReads.find(row => row.id === page?.readReceiptId); if (row && isDeepStrictEqual(binding(row), binding(execution)) && row.instructionRevision === page.instructionRevision && row.pageDigest === digest(page) && state.multisite.commands.some(command => command.key === row.sourceCommandKey && command.digest === digest({ operation: 'read_spreadsheet_candidate', parameters }))) { assertCandidatePageContext(state, execution, row); if (row.instructionRevision === state.works.find(work => work.id === execution.work_id).instructionRevision) ids.add(row.id) } }
  }
  return [...ids].sort()
}
