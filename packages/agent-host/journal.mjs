import { isDeepStrictEqual } from 'node:util'
import { createJournalArchive } from './journal-archive.mjs'
import { validateManualInboxFacts, assertManualInboxImmutable } from './manual-control.mjs'
import { validateSpreadsheetJobs, assertSpreadsheetJobsImmutable } from './spreadsheet-jobs.mjs'
import { validateCaptures, assertCapturesImmutable } from './evidence-captures.mjs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertSealed, error } from '../agent-contracts/index.mjs'

// A Host owns only its transport/execution journal. It never opens the cloud state file.
export function createHostJournal(path, operations = {}, { archive = true } = {}) {
  const io = { mkdir, open, readFile, rename, unlink, ...operations }
  const cold = createJournalArchive(path, operations)
  let queue = Promise.resolve(), unavailable, confirmed = false
  const enqueue = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result }
  async function read() {
    if (unavailable) throw error('STORE_UNAVAILABLE', 'Host 日志持久性待确认')
    if (!confirmed) {
      let handle
      try {
        try { handle = await io.open(path, 'r') } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
        if (handle) {
          await handle.sync(); await handle.close(); handle = undefined
          handle = await io.open(dirname(path), 'r'); await handle.sync(); await handle.close(); handle = undefined
        }
        confirmed = true
      } catch (cause) { unavailable = cause; throw cause }
      finally { await handle?.close().catch(() => {}) }
    }
    let raw
    try { raw = await io.readFile(path, 'utf8') } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause
      return { version: 3, inbox: [], executions: [], outbox: [], jobs: [], captures: [] }
    }
    const state = JSON.parse(raw)
    if (![1, 2, 3, 4].includes(state.version) || !['inbox', 'executions', 'outbox'].every(field => Array.isArray(state[field]))) throw error('INVALID_STATE', 'Host 日志无效')
    if (state.version === 1) { if (state.jobs?.length) throw error('INVALID_STATE', '旧 Host 日志不得丢弃 Job'); state.version = 2; state.jobs = [] }
    if (state.version === 2) { if (state.captures?.length) throw error('INVALID_STATE', '旧 Host 日志不得包含 capture'); state.version = 3; state.captures = [] }
    validateSpreadsheetJobs(state)
    validateCaptures(state)
    validateManualInboxFacts(state)
    // A missing/corrupt referenced segment is never an empty journal/not-found.
    await cold.validate(state)
    return state
  }
  return {
    read: () => enqueue(read),
    lookup: (kind, id) => enqueue(async () => cold.lookup(await read(), kind, id)),
    archiveMetadata: () => enqueue(async () => cold.metadata(await read())),
    update: fn => enqueue(async () => {
      const state = await read(), before = structuredClone(state)
      let replaySource = before
      const prepareArchive = async () => {
        // Admission may prepare a cut only before changing any business facts.
        if (!isDeepStrictEqual(state, replaySource)) throw error('INVALID_STATE', '归档准备前日志已变化')
        await cold.validate(state)
        if (archive) await cold.compact(state)
        replaySource = structuredClone(state)
      }
      const result = await fn(state, (kind, id) => cold.lookup(state, kind, id), prepareArchive)
      if (!isDeepStrictEqual(state.archive, replaySource.archive) || state.version !== replaySource.version) throw error('INVALID_STATE', '冷历史引用只能由 Journal 提交')
      // Appenders share this transaction with cold lookup; an old ACKed event
      // remains cold and cannot be re-enqueued with acknowledged:false.
      for (const kind of ['inbox', 'outbox']) {
        const id = row => kind === 'inbox' ? row.command.command_id : row.event.event_id
        const oldIds = new Set(replaySource[kind].map(id)), keep = []
        for (const row of state[kind]) {
          const prior = oldIds.has(id(row)) ? null : await cold.lookup(replaySource, kind, id(row))
          if (prior) {
            const field = kind === 'inbox' ? 'command' : 'event'
            assertSealed(row[field])
            if (prior[field].payload_digest !== row[field].payload_digest) throw error('IDEMPOTENCY_CONFLICT')
          } else keep.push(row)
        }
        state[kind] = keep
      }
      validateSpreadsheetJobs(state); assertSpreadsheetJobsImmutable(before, state)
      validateCaptures(state); assertCapturesImmutable(before, state)
      validateManualInboxFacts(state); assertManualInboxImmutable(before, state)
      await cold.validate(state)
      if (archive) await cold.compact(state)
      await cold.validate(state)
      await io.mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temp = join(dirname(path), `.${path.split('/').pop()}.${process.pid}.tmp`)
      let handle, committed = false
      try {
        handle = await io.open(temp, 'w', 0o600)
        await handle.writeFile(JSON.stringify(state) + '\n'); await handle.sync(); await handle.close(); handle = undefined
        await io.rename(temp, path); committed = true
        handle = await io.open(dirname(path), 'r'); await handle.sync(); await handle.close(); handle = undefined
      } catch (cause) { if (committed) { confirmed = false; unavailable = cause }; throw cause }
      finally { await handle?.close().catch(() => {}); if (!committed) await io.unlink(temp).catch(() => {}) }
      return result
    }),
  }
}
