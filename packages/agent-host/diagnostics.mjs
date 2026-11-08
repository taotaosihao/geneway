import { lstat, open, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOST_INBOX_LIMITS, hostInboxPressure } from './host.mjs'
import { createHostJournal } from './journal.mjs'
import { HOST_ARCHIVE_LIMITS } from './journal-archive.mjs'

const count = value => Array.isArray(value) ? Math.min(value.length, 1000000) : 'unknown'
const readCodes = new Set(['STORE_UNAVAILABLE', 'ARCHIVE_UNAVAILABLE', 'INVALID_STATE', 'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'EROFS'])
const unknownPending = () => ({ count: 'unknown', bytes: 'unknown', remainingCount: 'unknown', remainingBytes: 'unknown' })
const archiveCounters = ['segments', 'inboxRows', 'outboxRows', 'referencedBytes', 'physicalBytes', 'logicalBytes']
async function snapshotJournal(root) {
  const path = join(root, 'host-journal.json')
  if (!(await lstat(path)).isFile()) throw Object.assign(new Error('Invalid journal'), { code: 'INVALID_STATE' })
  return createHostJournal(path, {}, { archive: false })
}
function archiveProjection(metadata) {
  if (!metadata || !['not_applicable', 'readable'].includes(metadata.state) || !archiveCounters.every(field => Number.isSafeInteger(metadata[field]) && metadata[field] >= 0) || ![null, 'cold_capacity', 'no_eligible_rows', 'cold_write_unconfirmed'].includes(metadata.reason)) throw Object.assign(new Error('Invalid archive metadata'), { code: 'ARCHIVE_UNAVAILABLE' })
  return { state: metadata.state, ...Object.fromEntries(archiveCounters.map(field => [field, metadata[field]])), limits: HOST_ARCHIVE_LIMITS, reason: metadata.reason }
}
function pressureReasons(pressure) {
  const { history, ordinary, control, limits } = pressure
  return [
    [ordinary.count >= limits.ordinaryCount, 'ordinary_pending_count'],
    [ordinary.bytes >= limits.ordinaryBytes, 'ordinary_pending_bytes'],
    [history.count >= limits.ordinaryHistoryCount, 'ordinary_history_count'],
    [control.count >= limits.controlCount, 'control_pending_count'],
    [control.bytes >= limits.controlBytes, 'control_pending_bytes'],
    [history.count >= limits.historyCount, 'history_count'],
  ].filter(([reached]) => reached).map(([, reason]) => reason)
}
export async function collectHostDiagnostics({ root, journal }) {
  let build, counters
  try { build = JSON.parse(await readFile(new URL('../../build-manifest.json', import.meta.url), 'utf8')) } catch {}
  // Only the structural counters below may leave the local machine; no identity/profile/session data.
  const scope = journal === undefined ? 'snapshotOnly' : 'liveJournal'
  try {
    const reader = journal === undefined ? await snapshotJournal(root) : journal
    const state = await reader.read()
    if (![1, 2, 3, 4].includes(state?.version) || !['inbox', 'outbox', 'executions'].every(field => Array.isArray(state[field])) || state.jobs !== undefined && !Array.isArray(state.jobs)) throw Object.assign(new Error('Invalid journal'), { code: 'INVALID_STATE' })
    const archive = archiveProjection(await reader.archiveMetadata())
    // These bytes measure UTF-8 JSON inbox rows, not disk usage or the whole Journal.
    const pressure = hostInboxPressure(state.inbox)
    counters = { version: state.version, inbox: count(state.inbox), outbox: count(state.outbox), jobs: count(state.jobs), unknown: count(state.executions.filter(row => row.state === 'unknown' || row.status === 'unknown')), scope, rowsScope: 'hot', storage: { state: 'readable', reason: null }, pressure: { ...pressure, reasons: pressureReasons(pressure) }, archive }
  } catch (cause) {
    const reason = readCodes.has(cause?.code) ? cause.code : cause instanceof SyntaxError ? 'INVALID_STATE' : 'JOURNAL_READ_UNAVAILABLE'
    counters = { version: 'unknown', inbox: 'unknown', outbox: 'unknown', jobs: 'unknown', unknown: 'unknown', scope, rowsScope: 'hot', storage: { state: 'unknown', reason }, pressure: { history: { count: 'unknown', bytes: 'unknown' }, ordinary: unknownPending(), control: unknownPending(), limits: HOST_INBOX_LIMITS, reasons: [reason] }, archive: { state: 'unknown', ...Object.fromEntries(archiveCounters.map(field => [field, 'unknown'])), limits: HOST_ARCHIVE_LIMITS, reason } }
  }
  return { schema: 'geneway.host-diagnostics/1', observedAt: new Date().toISOString(), build: { version: typeof build?.version === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(build.version) ? build.version : 'unknown', profile: 'linux-x64-g-office-disabled', dsh: build?.dependencies?.['@deepseek-ai/dsh'] ?? 'unknown' }, runtime: { os: process.platform, arch: process.arch, node: process.versions.node }, journal: counters }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const root = resolve(process.argv[2]), args = process.argv.slice(3)
    if (args[0] === '--lookup') {
      if (args.length !== 6 || !['inbox', 'outbox'].includes(args[1]) || args[2] !== '--id' || !args[3].trim() || args[3].length > 16000 || args[4] !== '--output' || !args[5]) throw new Error('Invalid lookup')
      const journal = await snapshotJournal(root), row = await journal.lookup(args[1], args[3])
      const output = await open(resolve(args[5]), 'wx', 0o600)
      try { await output.writeFile(JSON.stringify(row, null, 2) + '\n'); await output.sync() } finally { await output.close() }
      console.log(JSON.stringify({ kind: args[1], found: row !== null }))
    } else {
      if (args.length > 1) throw new Error('Invalid diagnostics arguments')
      const result = await collectHostDiagnostics({ root })
      if (args[0]) await writeFile(resolve(args[0]), JSON.stringify(result, null, 2), { mode: 0o600 })
      else console.log(JSON.stringify(result, null, 2))
    }
  } catch { console.error('{"code":"DIAGNOSTICS_UNAVAILABLE"}'); process.exitCode = 1 }
}
