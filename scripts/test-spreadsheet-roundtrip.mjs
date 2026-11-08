import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { INCIDENT_TEMPLATE, templateReference } from '../src/spreadsheet-template.mjs'
import { generateIncidentSpreadsheet } from '../src/spreadsheet-generation.mjs'
import { verifyIncidentSpreadsheet } from '../src/spreadsheet-verification.mjs'

const JSZip = createRequire(import.meta.resolve('exceljs/package.json'))('jszip')
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-roundtrip-')
// Independent acceptance oracle: neither product generator nor verifier imports this test.
const samples = [
  { entries: [{ date: '2026-11-01', description: '护罩松动', owner: '张工' }, { date: '2026-11-02', description: '漏油', owner: '李工' }, { date: '2026-11-03', description: '护罩松动', owner: '张工' }], dueDate: '2026-11-12', oracle: { dates: ['2026-11-01', '2026-11-02', '2026-11-03'], descriptions: ['护罩松动', '漏油', '护罩松动'], owners: ['张工', '李工', '张工'], counts: [2, 1, 2], records: 3, distinctOwners: 2, types: 2 } },
  { entries: [{ date: '2026-10-21', description: '传感器遮挡', owner: '王工' }, { date: '2026-10-24', description: '传感器遮挡 ', owner: '赵工' }], dueDate: '2026-11-18', oracle: { dates: ['2026-10-21', '2026-10-24'], descriptions: ['传感器遮挡', '传感器遮挡 '], owners: ['王工', '赵工'], counts: [1, 1], records: 2, distinctOwners: 2, types: 2 } },
]
for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
  const sample = samples[sampleIndex], sourceBytes = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: sample.entries }))
  const sourceRef = { attachmentId: `attachment-00000000-0000-4000-8000-${String(sampleIndex + 1).padStart(12, '0')}`, version: 1, sha256: createHash('sha256').update(sourceBytes).digest('hex') }
  const input = { template: templateReference(), calculationVersion: 1, dueDate: sample.dueDate, instructionRevision: 1, historyRefs: [sourceRef], evidence: [{ sourceRef, entries: sample.entries }], rows: sample.entries.map((_, entryIndex) => ({ sourceRef, entryIndex, dueDate: sample.dueDate, photoRefs: [] })) }
  for (const [revision, deadline] of [[1, sample.dueDate], [2, '2026-12-03']]) {
    const request = { ...input, instructionRevision: revision, dueDate: deadline, rows: input.rows.map(row => ({ ...row, dueDate: deadline })) }
    const bytes = await generateIncidentSpreadsheet(request), path = `${directory}/sample-${sampleIndex + 1}-revision-${revision}.xlsx`
    await writeFile(path, bytes)
    const verdict = await verifyIncidentSpreadsheet(await readFile(path), request)
    assert.equal(verdict.rowCount, sample.oracle.records)
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(path); const sheet = book.getWorksheet('异常整改台账')
    for (let index = 0; index < sample.oracle.records; index++) {
      assert.equal(sheet.getCell(index + 3, 2).value, sample.oracle.dates[index]); assert.equal(sheet.getCell(index + 3, 3).value, sample.oracle.descriptions[index]); assert.equal(sheet.getCell(index + 3, 4).value, sample.oracle.owners[index]); assert.equal(sheet.getCell(index + 3, 5).value, deadline); assert.equal(sheet.getCell(index + 3, 6).value, sample.oracle.counts[index])
    }
    const footer = sample.oracle.records + 3
    assert.equal(sheet.getCell(footer, 2).value, sample.oracle.records); assert.equal(sheet.getCell(footer, 4).value, sample.oracle.distinctOwners); assert.equal(sheet.getCell(footer, 6).value, sample.oracle.types)
    for (const mutate of [target => { target.getCell('D3').value = '错误责任人' }, target => { target.getCell('E3').value = '2026-02-30' }, target => { target.getCell('F3').value = 0 }, target => { target.spliceRows(3, 1) }, target => { target.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } } }]) {
      const altered = new ExcelJS.Workbook(); await altered.xlsx.load(bytes); mutate(altered.worksheets[0]); await assert.rejects(verifyIncidentSpreadsheet(Buffer.from(await altered.xlsx.writeBuffer()), request), { code: 'SPREADSHEET_VERIFICATION_FAILED' })
    }
    if (sampleIndex === 0 && revision === 1) {
      const external = await JSZip.loadAsync(bytes), relationships = await external.file('xl/_rels/workbook.xml.rels').async('string')
      external.file('xl/_rels/workbook.xml.rels', relationships.replace('</Relationships>', '<Relationship Id="malicious" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="https://example.invalid/evil.xlsx" TargetMode="Exter&#110;al"/></Relationships>'))
      await assert.rejects(verifyIncidentSpreadsheet(await external.generateAsync({ type: 'nodebuffer' }), request), { code: 'SPREADSHEET_VERIFICATION_FAILED' })
      const macro = await JSZip.loadAsync(bytes), types = await macro.file('[Content_Types].xml').async('string')
      macro.file('[Content_Types].xml', types.replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'))
      await assert.rejects(verifyIncidentSpreadsheet(await macro.generateAsync({ type: 'nodebuffer' }), request), { code: 'SPREADSHEET_VERIFICATION_FAILED' })
    }
    assert.equal(INCIDENT_TEMPLATE.version, 1)
  }
}
console.log(JSON.stringify({ result: 'passed', directory, realXlsx: 4, samples: 2, userDeadlineRevision: true, independentOracle: true, criticalCellAndStructureNegatives: true, formulaRecalculationClaim: false }, null, 2))
