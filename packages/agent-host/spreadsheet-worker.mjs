import { constants } from 'node:fs'
import { open, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { generateIncidentSpreadsheet } from '../../src/spreadsheet-generation.mjs'

let assigned = false
process.on('message', async message => {
  if (assigned || message?.operation !== 'generate') return
  assigned = true
  const temporary = join(message.directory, `.incident-register.${randomUUID()}.tmp`), destination = join(message.directory, 'incident-register.xlsx')
  let handle
  try {
    const bytes = await generateIncidentSpreadsheet(message.input)
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined
    await link(temporary, destination)
    handle = await open(message.directory, 'r'); await handle.sync(); await handle.close(); handle = undefined
    await unlink(temporary)
    handle = await open(message.directory, 'r'); await handle.sync(); await handle.close(); handle = undefined
    process.send?.({ kind: 'candidate', jobId: message.jobId, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length })
    process.disconnect()
  } catch (cause) {
    await handle?.close().catch(() => {})
    process.send?.({ kind: 'failed', jobId: message.jobId, code: cause.code ?? 'SPREADSHEET_GENERATION_FAILED' })
    if (process.connected) process.disconnect()
    process.exitCode = 1
  }
})
process.on('disconnect', () => process.exit(process.exitCode ?? 0))
process.on('SIGTERM', () => process.exit(0))
