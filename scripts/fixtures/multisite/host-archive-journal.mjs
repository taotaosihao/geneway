import { createHostJournal as createProductionJournal } from '../../../packages/agent-host/journal.mjs'
import { observeArchiveIO } from './host-archive-io.mjs'

let io
export function createHostJournal(path) {
  io = observeArchiveIO()
  return createProductionJournal(path, io.operations)
}
export function archiveIOPhase(value) { io.phase(value) }
export function archiveIOFacts() { return { summary: io.summary(), events: io.events } }
