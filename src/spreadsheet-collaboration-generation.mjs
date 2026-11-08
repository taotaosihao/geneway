import { expandedSpreadsheetInput } from '../packages/agent-contracts/spreadsheet-collaboration.mjs'
import ExcelJS from 'exceljs'
import { COLLABORATION_TEMPLATE, readCollaborationTemplate } from './spreadsheet-template.mjs'
import { canonical, error } from '../packages/agent-contracts/index.mjs'
const refText = ref => `${ref.id ?? ref.attachmentId}@${ref.version}:${ref.sha256}`
const fragments = text => { const points = Array.from(String(text)), result = []; for (let offset = 0; offset < points.length; offset += 1000) result.push(points.slice(offset, offset + 1000).join('')); return result.length ? result : [''] }
// OOXML decodes _xHHHH_ in strings. Protect existing literal sequences first,
// then represent code units that XML/ExcelJS would otherwise remove or normalize.
function spreadsheetText(value) {
  const protectedText = value.replace(/_(?=x[0-9a-f]{4}_)/gi, '_x005F_')
  let result = ''
  for (const character of protectedText) { const code = character.charCodeAt(0); result += character.length === 1 && (code < 32 && code !== 9 && code !== 10 || code === 127 || code === 0xFFFE || code === 0xFFFF || code >= 0xD800 && code <= 0xDFFF) ? '_x' + code.toString(16).toUpperCase().padStart(4, '0') + '_' : character }
  return result
}
export async function generateCollaborationSpreadsheet(value) {
  const input = expandedSpreadsheetInput(value)
  const { bytes } = await readCollaborationTemplate(), book = new ExcelJS.Workbook(); await book.xlsx.load(bytes)
  const history = book.getWorksheet(COLLABORATION_TEMPLATE.sheets.history.name), site = book.getWorksheet(COLLABORATION_TEMPLATE.sheets.site.name), analysis = book.getWorksheet(COLLABORATION_TEMPLATE.sheets.analysis.name), manifest = book.getWorksheet(COLLABORATION_TEMPLATE.sheets.manifest.name)
  const counts = new Map(), owners = new Set()
  for (const source of input.sources.filter(row => row.payload.format === 'geneway.incident-history')) for (const entry of source.payload.entries) counts.set(entry.description, (counts.get(entry.description) ?? 0) + 1)
  for (const [index, row] of input.rows.entries()) {
    const entry = input.sources.find(source => source.ref.id === row.sourceRef.id)?.payload.entries[row.entryIndex]
    if (!entry || row.dueDate !== input.dueDate) throw error('INVALID_INPUT')
    owners.add(entry.owner); history.addRow([index + 1, entry.date, entry.description, entry.owner, input.dueDate, counts.get(entry.description), refText(row.sourceRef), row.entryIndex, row.photoRefs.map(refText).join('\n')])
  }
  history.addRow(['记录数', input.rows.length, '责任人数', owners.size, '异常种类', counts.size])
  for (const source of input.sourceManifest.sources.filter(row => row.kind === 'site_snapshot')) {
    const payload = input.sources.find(row => row.ref.id === source.ref.id).payload
    for (const field of ['quality', 'observedAt', 'sourceTimestamp', 'clockTrust', 'dataMode']) site.addRow([refText(source.ref), field, source[field] === null ? 'unknown' : String(source[field])])
    for (const field of ['sections', 'health']) if (Object.hasOwn(payload, field)) for (const part of fragments(JSON.stringify(payload[field]))) site.addRow([refText(source.ref), field, part])
    for (const event of payload.events ?? []) for (const part of fragments(JSON.stringify(event))) site.addRow([refText(source.ref), 'event:' + event.sourceEventId, part])
  }
  analysis.addRow(['摘要', '', input.analysis.summary, '', ''])
  for (const finding of input.analysis.findings) fragments(JSON.stringify(finding.basis)).forEach((part, index) => analysis.addRow([index ? '' : finding.category, index ? '' : finding.certainty, index ? '' : finding.statement, part, '']))
  for (const limitation of input.analysis.limitations) analysis.addRow(['限制', '', '', '', limitation])
  fragments(JSON.stringify(canonical(input.sourceManifest))).forEach((part, index) => manifest.addRow([index, part]))
  for (const sheet of book.worksheets) { sheet.eachRow((row, index) => { row.height = index === 1 ? 26 : 36; row.eachCell(cell => { if (typeof cell.value === 'string') cell.value = spreadsheetText(cell.value); cell.alignment = { wrapText: true, vertical: 'middle' }; if (index > 1) cell.font = { name: '等线', size: 11 } }) }); sheet.autoFilter = { from: 'A1', to: { row: sheet.rowCount, column: sheet.columnCount } } }
  const output = Buffer.from(await book.xlsx.writeBuffer()); if (output.length > 10 * 1024 * 1024) throw error('CAPACITY_EXCEEDED'); return output
}
