import { readFile, rename } from 'node:fs/promises'
import { createHostJournal as productionJournal } from '../../../packages/agent-host/journal.mjs'
import { faultControl } from './t11-host-fault-control.mjs'
// This constructor-only test seam leaves production profile/environment/API untouched.
export function createHostJournal(path, operations = {}) {
  return productionJournal(path, { ...operations, async rename(from, to) {
    const next = JSON.parse(await readFile(from, 'utf8'))
    const target = faultControl.armed && !faultControl.hit && next.inbox.find(row => row.command.operation === 'launch')
    if (target) {
      faultControl.hit = { command: target.command, at: new Date().toISOString(), path, tempPath: from, beforeRename: true }
      process.send?.({ kind: 'inbox-precommit-hit', ...faultControl.hit })
      throw Object.assign(new Error('T11 fixture: target Inbox rename rejected before commit'), { code: 'EIO' })
    }
    return (operations.rename ?? rename)(from, to)
  } })
}
