import { expandedSpreadsheetInput } from '../packages/agent-contracts/spreadsheet-collaboration.mjs'
import ExcelJS from 'exceljs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { canonical, digest, error } from '../packages/agent-contracts/index.mjs'
import { COLLABORATION_TEMPLATE, collaborationTemplateReference, validCalendarDate } from './spreadsheet-template.mjs'
import { inspectSpreadsheetArchive } from './spreadsheet-verification.mjs'
const check = (condition, label) => { if (!condition) throw error('SPREADSHEET_VERIFICATION_FAILED', `多来源整改表核验失败：${label}`) }
export async function verifyCollaborationSpreadsheet(bytes, value) {
  const expected = expandedSpreadsheetInput(value)
  const archive = await inspectSpreadsheetArchive(bytes, { allowCollaboration: true }); check(isDeepStrictEqual(expected.template, collaborationTemplateReference()) && expected.calculationVersion === 1 && validCalendarDate(expected.dueDate) && expected.sourceManifestDigest === digest(expected.sourceManifest), '可信输入与manifest')
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes); const definitions = Object.values(COLLABORATION_TEMPLATE.sheets)
  check(book.worksheets.length === 4, '固定工作表数量')
  for (const [index, definition] of definitions.entries()) { const sheet = book.worksheets[index]; check(sheet.name === definition.name && sheet.columnCount === definition.columns.length && sheet.views.some(view => view.state === 'frozen' && view.ySplit === 1), '固定工作表与表头'); definition.columns.forEach((title, column) => check(sheet.getCell(1, column + 1).value === title && sheet.getCell(1, column + 1).font.bold, '固定标题')); sheet.eachRow(row => row.eachCell(cell => check(cell.value === null || ['string', 'number', 'boolean'].includes(typeof cell.value), '不得含公式或外部对象'))) }
  const history = book.worksheets[0], entries = expected.sources.filter(source => source.payload.format === 'geneway.incident-history').flatMap(source => source.payload.entries.map((entry, index) => ({ ref: source.ref, index, entry }))), owners = new Set(), descriptions = new Set()
  check(history.rowCount === entries.length + 2 && expected.rows.length === entries.length, '历史完整覆盖')
  const displayRef = ref => `${ref.id ?? ref.attachmentId}@${ref.version}:${ref.sha256}`
  for (const [index, source] of entries.entries()) {
    const row = expected.rows[index]; check(isDeepStrictEqual(row.sourceRef, source.ref) && row.entryIndex === source.index && row.dueDate === expected.dueDate, '历史来源索引与期限')
    const count = entries.filter(item => item.entry.description === source.entry.description).length, values = [index + 1, source.entry.date, source.entry.description, source.entry.owner, expected.dueDate, count, displayRef(source.ref), source.index, row.photoRefs.map(displayRef).join('\n')]
    values.forEach((value, column) => check(history.getCell(index + 2, column + 1).value === value, `原历史条目${index}/${column}`)); owners.add(source.entry.owner); descriptions.add(source.entry.description)
  }
  ;['记录数', entries.length, '责任人数', owners.size, '异常种类', descriptions.size].forEach((value, column) => check(history.getCell(entries.length + 2, column + 1).value === value, '历史汇总'))
  const parts = text => { const result = [], points = [...text]; for (let offset = 0; offset < points.length; offset += 1000) result.push(points.slice(offset, offset + 1000).join('')); return result.length ? result : [''] }, siteRows = []
  for (const source of expected.sourceManifest.sources.filter(source => source.kind === 'site_snapshot')) {
    const payload = expected.sources.find(row => row.ref.id === source.ref.id).payload
    for (const field of ['quality', 'observedAt', 'sourceTimestamp', 'clockTrust', 'dataMode']) siteRows.push([displayRef(source.ref), field, source[field] === null ? 'unknown' : String(source[field])])
    for (const field of ['sections', 'health']) if (Object.hasOwn(payload, field)) for (const part of parts(JSON.stringify(payload[field]))) siteRows.push([displayRef(source.ref), field, part])
    for (const event of payload.events ?? []) for (const part of parts(JSON.stringify(event))) siteRows.push([displayRef(source.ref), 'event:' + event.sourceEventId, part])
  }
  const analysisRows = [['摘要', '', expected.analysis.summary, '', '']]
  for (const finding of expected.analysis.findings) parts(JSON.stringify(finding.basis)).forEach((part, index) => analysisRows.push([index ? '' : finding.category, index ? '' : finding.certainty, index ? '' : finding.statement, part, '']))
  for (const limitation of expected.analysis.limitations) analysisRows.push(['限制', '', '', '', limitation])
  for (const [sheet, values] of [[book.worksheets[1], siteRows], [book.worksheets[2], analysisRows]]) { check(sheet.rowCount === values.length + 1, '现场与分析完整范围'); for (const [index, row] of values.entries()) row.forEach((value, column) => check((sheet.getCell(index + 2, column + 1).value ?? '') === value, '原现场与immutable分析内容')) }
  const manifest = book.worksheets[3], expectedParts = parts(JSON.stringify(canonical(expected.sourceManifest))); check(manifest.rowCount === expectedParts.length + 1, '来源manifest完整范围')
  expectedParts.forEach((part, index) => { check(manifest.getCell(index + 2, 1).value === index && manifest.getCell(index + 2, 2).value === part, '来源manifest原内容') })
  return { verificationVersion: 1, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, rowCount: entries.length, manifestDigest: expected.sourceManifestDigest, summary: { records: entries.length, owners: owners.size, descriptions: descriptions.size, siteRows: siteRows.length, analysisRows: analysisRows.length }, archive }
}
