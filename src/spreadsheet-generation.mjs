import { generateCollaborationSpreadsheet } from './spreadsheet-collaboration-generation.mjs'
import ExcelJS from 'exceljs'
import { INCIDENT_TEMPLATE, readIncidentTemplate } from './spreadsheet-template.mjs'
import { error } from '../packages/agent-contracts/index.mjs'

export async function generateIncidentSpreadsheet(input) {
  if (input.template?.id === 'incident-collaboration-v1') return generateCollaborationSpreadsheet(input)
  const { bytes } = await readIncidentTemplate(), book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes)
  const sheet = book.getWorksheet(INCIDENT_TEMPLATE.sheetName)
  const descriptions = new Map()
  for (const evidence of input.evidence) for (const entry of evidence.entries) descriptions.set(entry.description, (descriptions.get(entry.description) ?? 0) + 1)
  const owners = new Set(), types = new Set()
  let photos = 0
  for (let index = 0; index < input.rows.length; index++) {
    const request = input.rows[index], source = input.evidence.find(item => sameRef(item.sourceRef, request.sourceRef)), entry = source?.entries[request.entryIndex]
    if (!entry || request.dueDate !== input.dueDate) throw error('INVALID_INPUT', '生成输入与受控历史或期限不一致')
    const values = [index + 1, entry.date, entry.description, entry.owner, input.dueDate, descriptions.get(entry.description), referenceText(request.sourceRef), request.entryIndex + 1, request.photoRefs.map(referenceText).join('\n'), request.photoRefs.length]
    const row = sheet.getRow(index + 3)
    row.values = values; row.height = 36
    row.eachCell(cell => { cell.font = { name: '等线', size: 11 }; cell.alignment = { vertical: 'middle', wrapText: true }; cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9E2F3' } } } })
    owners.add(entry.owner); types.add(entry.description); photos += request.photoRefs.length
  }
  const total = sheet.getRow(input.rows.length + 3)
  total.values = ['记录数', input.rows.length, '责任人数', owners.size, '异常种类', types.size, '照片引用数', photos]
  total.height = 26
  total.eachCell(cell => { cell.font = { name: '等线', bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } }; cell.alignment = { vertical: 'middle' } })
  sheet.autoFilter = { from: 'A2', to: { row: Math.max(2, input.rows.length + 2), column: 10 } }
  const output = Buffer.from(await book.xlsx.writeBuffer())
  if (output.length > 10 * 1024 * 1024) throw error('CAPACITY_EXCEEDED', '生成文件超出受控限额')
  return output
}
function sameRef(left, right) { return left.attachmentId === right.attachmentId && left.version === right.version && left.sha256 === right.sha256 }
function referenceText(ref) { return `${ref.attachmentId}@${ref.version}:${ref.sha256}` }
