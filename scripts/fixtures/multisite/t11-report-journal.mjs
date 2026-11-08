import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getCallSites } from 'node:util'
import { createHostJournal as productionJournal } from '../../../packages/agent-host/journal.mjs'
import { digest } from '../../../packages/agent-contracts/index.mjs'
import { reportSelection } from './t11-report-control.mjs'

const hostUrl = new URL('../../../packages/agent-host/host.mjs', import.meta.url).href
const source = readFileSync(new URL(hostUrl), 'utf8'), needle = 'for (const row of (await journal.read()).outbox.filter(item => !item.acknowledged)) {'
assert.equal(source.split(needle).length, 2, 'The selection seam must match exactly the production sender iteration')
const senderLine = source.slice(0, source.indexOf(needle)).split('\n').length
export function createHostJournal(path, operations) {
  const fullJournal = productionJournal(path, operations)
  return { ...fullJournal, async read() {
    // Capture before await. Only this direct call is the sender's iteration;
    // even flushReceipts' cleanup read on a different line keeps the full tree.
    const caller = getCallSites(2)[1], sending = caller?.scriptName === hostUrl && caller.functionName === 'flushReceipts' && caller.lineNumber === senderLine
    const state = await fullJournal.read(), target = state.outbox.find(row => row.event.kind === 'report' && row.event.agent_id === 'desktop-office' && row.event.report?.summary === 'H07_OLD_B_SEALED_REPORT')
    if (!target) return state
    reportSelection.targetId ??= target.event.event_id
    assert.equal(reportSelection.targetId, target.event.event_id)
    if (sending && reportSelection.held) {
      assert.equal(target.acknowledged, false)
      const selected = { ...state, outbox: state.outbox.filter(row => row.event.event_id !== target.event.event_id) }
      reportSelection.selectedReads++
      process.send?.({ kind: 'report-selection-witness', caller, senderLine, fullOutboxHash: digest(state.outbox), selectedOutboxHash: digest(selected.outbox), target: structuredClone(target), selectedReads: reportSelection.selectedReads })
      return selected
    }
    const reader = `${caller?.functionName}:${caller?.lineNumber}`
    if (!reportSelection.seenFullReaders.has(reader)) {
      reportSelection.seenFullReaders.add(reader)
      process.send?.({ kind: 'report-full-read-witness', caller, senderLine, targetStillPresent: true, targetAcknowledged: target.acknowledged, fullOutboxHash: digest(state.outbox) })
    }
    return state
  } }
}
