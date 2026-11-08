import { verifyCollaborationSpreadsheet } from './spreadsheet-collaboration-verification.mjs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { INCIDENT_TEMPLATE, validCalendarDate } from './spreadsheet-template.mjs'
import { error } from '../packages/agent-contracts/index.mjs'

const requireFromExcel = createRequire(import.meta.resolve('exceljs/package.json'))
const unzipper = requireFromExcel('unzipper'), JSZip = requireFromExcel('jszip'), { SaxesParser } = requireFromExcel('saxes')
export const SPREADSHEET_VERIFICATION_VERSION = 1
const check = (condition, label) => { if (!condition) throw error('SPREADSHEET_VERIFICATION_FAILED', `整改表核验失败：${label}`) }
export async function inspectSpreadsheetArchive(bytes, { allowCollaboration = false } = {}) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 10 * 1024 * 1024, '文件大小')
  let archive
  try { archive = await unzipper.Open.buffer(bytes) } catch { throw error('SPREADSHEET_VERIFICATION_FAILED', '整改表不是有效 ZIP/OOXML') }
  check(archive.files.length <= 100, '压缩条目数量')
  const names = new Set(); let total = 0
  for (const file of archive.files) {
    check(typeof file.path === 'string' && !names.has(file.path) && !/[\\\x00-\x1f]/.test(file.path) && !file.path.startsWith('/') && !file.path.split('/').includes('..'), '压缩路径')
    names.add(file.path)
    check(Number.isSafeInteger(file.uncompressedSize) && file.uncompressedSize >= 0 && file.uncompressedSize <= 8 * 1024 * 1024 && file.flags % 2 === 0, '条目大小或加密')
    total += file.uncompressedSize
    check(total <= 20 * 1024 * 1024, '解压体积')
    check(!/vbaProject|externalLinks|embeddings|connections|activeX/i.test(file.path) && (file.type === 'Directory' || file.path.endsWith('.xml') || file.path.endsWith('.rels')), '只允许受控 OOXML 内容')
  }
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) check(names.has(required), '缺少 OOXML 结构')
  const worksheetCount = [...names].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length
  check(worksheetCount === 1 || allowCollaboration && worksheetCount === 4, '固定工作表数量')
  for (let index = 1; index <= worksheetCount; index++) check(names.has(`xl/worksheets/sheet${index}.xml`), '工作表序号')
  let actualTotal = 0
  for (const file of archive.files) {
    const chunks = []; let actualSize = 0
    try {
      for await (const chunk of file.stream()) {
        actualSize += chunk.length; actualTotal += chunk.length
        if (file.type === 'Directory') check(actualSize === 0, '目录不得含解压内容')
        check(actualSize <= 8 * 1024 * 1024 && actualTotal <= 20 * 1024 * 1024, '实际解压体积')
        chunks.push(chunk)
      }
      check(actualSize === file.uncompressedSize, '条目声明与实际体积不符')
      if (file.type === 'Directory') continue
      inspectXmlPart(file.path, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), names, worksheetCount)
    } catch (cause) { if (cause.code === 'SPREADSHEET_VERIFICATION_FAILED') throw cause; throw error('SPREADSHEET_VERIFICATION_FAILED', '整改表 XML 或压缩数据无效') }
  }
  try { await JSZip.loadAsync(bytes, { checkCRC32: true }) } catch { throw error('SPREADSHEET_VERIFICATION_FAILED', '整改表 ZIP 校验失败') }
  return { entries: names.size, uncompressedBytes: total }
}

function inspectXmlPart(path, text, names, worksheetCount) {
  const contentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types', relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
  const expectedTypes = {
    '/xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    '/xl/worksheets/sheet1.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
    '/xl/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
    '/xl/styles.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
    '/xl/sharedStrings.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
    '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml',
    '/docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  }
  const expectedRelations = path === '_rels/.rels' ? {
    [office + 'officeDocument']: 'xl/workbook.xml',
    ['http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties']: 'docProps/core.xml',
    [office + 'extended-properties']: 'docProps/app.xml',
  } : { [office + 'styles']: 'styles.xml', [office + 'theme']: 'theme/theme1.xml', [office + 'sharedStrings']: 'sharedStrings.xml', [office + 'worksheet']: 'worksheets/sheet1.xml' }
  for (let index = 2; index <= worksheetCount; index++) expectedTypes[`/xl/worksheets/sheet${index}.xml`] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
  const worksheetTargets = Array.from({ length: worksheetCount }, (_, index) => `worksheets/sheet${index + 1}.xml`)
  const parser = new SaxesParser({ xmlns: true }), seen = new Set(), ids = new Set()
  let depth = 0
  parser.on('doctype', () => { throw error('SPREADSHEET_VERIFICATION_FAILED', '整改表不得含 DTD 或实体声明') })
  parser.on('error', cause => { throw cause })
  parser.on('opentag', node => {
    depth++
    if (path !== '[Content_Types].xml' && !path.endsWith('.rels')) return
    const attrs = Object.fromEntries(Object.values(node.attributes).filter(attr => attr.uri !== 'http://www.w3.org/2000/xmlns/').map(attr => { check(!attr.prefix && !attr.uri, '属性命名空间'); return [attr.local, attr.value] }))
    if (path === '[Content_Types].xml') {
      check(node.uri === contentTypes && (depth === 1 ? node.local === 'Types' : depth === 2 && ['Default', 'Override'].includes(node.local)), '内容类型 XML')
      if (depth === 1) return
      if (node.local === 'Override') {
        check(Object.keys(attrs).sort().join(',') === 'ContentType,PartName' && expectedTypes[attrs.PartName] === attrs.ContentType && names.has(attrs.PartName.slice(1)) && !seen.has(attrs.PartName), '固定工作簿内容类型')
        seen.add(attrs.PartName)
      } else {
        const defaults = { rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml', vml: 'application/vnd.openxmlformats-officedocument.vmlDrawing' }
        check(Object.keys(attrs).sort().join(',') === 'ContentType,Extension' && defaults[attrs.Extension] === attrs.ContentType && !ids.has(attrs.Extension), '默认内容类型')
        ids.add(attrs.Extension)
      }
    } else {
      check(['_rels/.rels', 'xl/_rels/workbook.xml.rels'].includes(path) && node.uri === relationships && (depth === 1 ? node.local === 'Relationships' : depth === 2 && node.local === 'Relationship'), '固定关系结构')
      if (depth === 1) return
      check(Object.keys(attrs).every(field => ['Id', 'Type', 'Target', 'TargetMode'].includes(field)) && typeof attrs.Id === 'string' && !ids.has(attrs.Id) && (!attrs.TargetMode || attrs.TargetMode === 'Internal') && (attrs.Type === office + 'worksheet' ? worksheetTargets.includes(attrs.Target) : expectedRelations[attrs.Type] === attrs.Target) && !seen.has(attrs.Type === office + 'worksheet' ? attrs.Type + ':' + attrs.Target : attrs.Type), '关系目标或外部关系')
      ids.add(attrs.Id); seen.add(attrs.Type === office + 'worksheet' ? attrs.Type + ':' + attrs.Target : attrs.Type)
    }
  })
  parser.on('closetag', () => { depth-- })
  parser.write(text).close()
  if (path === '[Content_Types].xml') check(Object.keys(expectedTypes).every(part => seen.has(part)), '缺少固定内容类型')
  if (path.endsWith('.rels')) check(Object.keys(expectedRelations).every(type => type === office + 'worksheet' ? worksheetTargets.every(target => seen.has(type + ':' + target)) : seen.has(type)), '缺少固定关系')
}

// Independent business verification: read evidence and the user's deadline, never generator totals.
export async function verifyIncidentSpreadsheet(bytes, requirements) {
  if (requirements.template?.id === 'incident-collaboration-v1') return verifyCollaborationSpreadsheet(bytes, requirements)
  const archive = await inspectSpreadsheetArchive(bytes)
  check(validCalendarDate(requirements.dueDate) && requirements.calculationVersion === 1 && requirements.template.id === INCIDENT_TEMPLATE.id && requirements.template.version === INCIDENT_TEMPLATE.version && requirements.template.sha256 === INCIDENT_TEMPLATE.sha256, '可信要求')
  const book = new ExcelJS.Workbook()
  try { await book.xlsx.load(bytes) } catch { throw error('SPREADSHEET_VERIFICATION_FAILED', '整改表无法读取') }
  check(book.worksheets.length === 1, '工作表数量')
  const sheet = book.worksheets[0]
  check(sheet.name === INCIDENT_TEMPLATE.sheetName && sheet.getCell('A1').value === INCIDENT_TEMPLATE.title && JSON.stringify(sheet.model.merges) === JSON.stringify(['A1:J1']), '标题与合并')
  check(sheet.views.some(view => view.state === 'frozen' && view.ySplit === 2), '冻结表头')
  for (let index = 0; index < INCIDENT_TEMPLATE.columns.length; index++) {
    const column = INCIDENT_TEMPLATE.columns[index], cell = sheet.getCell(2, index + 1)
    check(cell.value === column.title && sheet.getColumn(index + 1).width === column.width && cell.font.bold === true && cell.fill.fgColor?.argb === 'FF17365D', '列与表头样式')
  }
  const expectedRows = []
  for (const evidence of requirements.evidence) for (let entryIndex = 0; entryIndex < evidence.entries.length; entryIndex++) expectedRows.push({ sourceRef: evidence.sourceRef, entryIndex, entry: evidence.entries[entryIndex] })
  check(requirements.rows.length === expectedRows.length && sheet.rowCount === expectedRows.length + 3 && sheet.columnCount === 10, '行列数量')
  const seen = new Set(), owners = new Set(), descriptions = new Set()
  let photoTotal = 0
  for (let index = 0; index < expectedRows.length; index++) {
    const expected = expectedRows[index], request = requirements.rows[index], identity = `${request.sourceRef.attachmentId}:${request.sourceRef.version}:${request.sourceRef.sha256}#${request.entryIndex}`
    check(!seen.has(identity) && expected.sourceRef.attachmentId === request.sourceRef.attachmentId && expected.sourceRef.version === request.sourceRef.version && expected.sourceRef.sha256 === request.sourceRef.sha256 && expected.entryIndex === request.entryIndex, '条目来源或重复')
    seen.add(identity)
    const entry = expected.entry
    let historical = 0
    for (const evidence of requirements.evidence) for (const item of evidence.entries) if (item.description === entry.description) historical++
    const ref = value => `${value.attachmentId}@${value.version}:${value.sha256}`
    const values = [index + 1, entry.date, entry.description, entry.owner, requirements.dueDate, historical, ref(expected.sourceRef), expected.entryIndex + 1, request.photoRefs.map(ref).join('\n'), request.photoRefs.length]
    for (let column = 1; column <= 10; column++) check(sheet.getCell(index + 3, column).value === values[column - 1], `第${index + 1}条第${column}列关键值`)
    owners.add(entry.owner); descriptions.add(entry.description); photoTotal += request.photoRefs.length
  }
  const footer = ['记录数', expectedRows.length, '责任人数', owners.size, '异常种类', descriptions.size, '照片引用数', photoTotal]
  for (let column = 1; column <= 8; column++) check(sheet.getCell(expectedRows.length + 3, column).value === footer[column - 1] && sheet.getCell(expectedRows.length + 3, column).font.bold, '汇总与样式')
  sheet.eachRow(row => row.eachCell(cell => check(!cell.value || typeof cell.value !== 'object', '不能包含公式、外链或未核验对象值')))
  return { verificationVersion: SPREADSHEET_VERIFICATION_VERSION, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, rowCount: expectedRows.length, summary: { records: expectedRows.length, owners: owners.size, descriptions: descriptions.size, photoRefs: photoTotal }, archive }
}
