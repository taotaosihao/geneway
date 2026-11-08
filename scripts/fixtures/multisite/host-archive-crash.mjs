import { createHostJournal } from '../../../packages/agent-host/journal.mjs'
import { observeArchiveIO } from './host-archive-io.mjs'
import { dirname } from 'node:path'

const [path, mode] = process.argv.slice(2)
let armed = false, renamed = false
async function barrier() {
  // Keep the process alive at the syscall barrier until its parent kills it.
  setInterval(() => {}, 1000)
  process.send({ kind: 'barrier', mode, pid: process.pid })
  await new Promise(() => {})
}
const io = observeArchiveIO({ async fault(operation, from, to) {
  if (!armed) return
  if (operation === 'rename' && to === path) {
    if (mode === 'before-manifest-rename') await barrier()
    renamed = true
  }
  if (renamed && operation === 'sync' && from === dirname(path) && mode === 'after-manifest-rename') await barrier()
} })
try {
  const journal = createHostJournal(path, io.operations)
  await journal.read(); armed = true
  await journal.update(() => {})
  throw Error('Expected crash barrier was not reached')
} catch (cause) {
  process.send?.({ kind: 'failure', message: cause.message, code: cause.code })
  process.exitCode = 1
}
