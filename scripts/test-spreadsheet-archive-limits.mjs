import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { inspectSpreadsheetArchive } from '../src/spreadsheet-verification.mjs'
const requireFromExcel = createRequire(import.meta.resolve('exceljs/package.json')), JSZip = requireFromExcel('jszip'), unzipper = requireFromExcel('unzipper')
const results = []
for (const [name, declaredBytes, directoryEntry] of [['xl/oversized.xml', 1, false], ['xl/hidden-directory/', 0, true]]) {
  const zip = await JSZip.loadAsync(await readFile('templates/incident-register-v1.xlsx')), xml = '<oversized>' + ' '.repeat(9 * 1024 * 1024) + '</oversized>', actualBytes = Buffer.byteLength(xml)
  zip.file(name, xml, { dir: false })
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  let patched = 0
  for (const [signature, nameLengthOffset, nameOffset, sizeOffset] of [[Buffer.from([80,75,3,4]),26,30,22],[Buffer.from([80,75,1,2]),28,46,24]]) {
    for (let offset = bytes.indexOf(signature); offset >= 0; offset = bytes.indexOf(signature, offset + 4)) if (bytes.subarray(offset + nameOffset, offset + nameOffset + bytes.readUInt16LE(offset + nameLengthOffset)).toString() === name) { bytes.writeUInt32LE(declaredBytes, offset + sizeOffset); patched++ }
  }
  assert.equal(patched, 2); assert(bytes.length < 30_000)
  const originalOpen = unzipper.Open.buffer, originalLoad = JSZip.loadAsync
  let observedBytes = 0, streamDestroyed = false, crcLoads = 0
  unzipper.Open.buffer = async (...args) => {
    const archive = await originalOpen(...args), file = archive.files.find(file => file.path === name), originalStream = file.stream
    assert.equal(file.uncompressedSize, declaredBytes); assert.equal(file.type === 'Directory', directoryEntry)
    file.stream = function (...args) {
      const stream = originalStream.apply(this, args)
      return (async function* () { try { for await (const chunk of stream) { observedBytes += chunk.length; yield chunk } } finally { streamDestroyed = stream.destroyed } })()
    }
    return archive
  }
  JSZip.loadAsync = (...args) => { crcLoads++; return originalLoad.apply(JSZip, args) }
  try { await assert.rejects(inspectSpreadsheetArchive(bytes), { code: 'SPREADSHEET_VERIFICATION_FAILED' }) } finally { unzipper.Open.buffer = originalOpen; JSZip.loadAsync = originalLoad }
  if (directoryEntry) assert(observedBytes > 0 && observedBytes <= 64 * 1024, 'directory payload is refused on its first bounded chunk')
  else assert(observedBytes > 8 * 1024 * 1024 && observedBytes <= 8 * 1024 * 1024 + 64 * 1024, 'stop at limit plus one bounded inflater chunk')
  assert(observedBytes < actualBytes); assert(streamDestroyed); assert.equal(crcLoads, 0)
  results.push({ compressedBytes: bytes.length, declaredUncompressedBytes: declaredBytes, actualUncompressedBytes: actualBytes, directoryEntry, observedBeforeRejection: observedBytes, crcLoads, streamDestroyed })
}
console.log(JSON.stringify({ result: 'passed', cases: results }, null, 2))
