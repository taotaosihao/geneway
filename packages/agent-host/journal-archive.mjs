import { constants } from 'node:fs'
import { mkdir, open, readFile, readdir, lstat, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assertSealed, sameBinding, error } from '../agent-contracts/index.mjs'

// Segment size bounds a single read/verification; the total includes incomplete
// and unreferenced files, so failed commits cannot grow a second unbounded log.
export const HOST_ARCHIVE_LIMITS = Object.freeze({ triggerBytes: 8 * 1024 * 1024, targetBytes: 4 * 1024 * 1024, triggerCount: 8192, targetCount: 4096, segmentBytes: 8 * 1024 * 1024, maxSegments: 64, physicalBytes: 512 * 1024 * 1024 })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const failed = () => error('ARCHIVE_UNAVAILABLE', 'Host 冷历史无法确认')
const rowId = (kind, row) => kind === 'inbox' ? row.command.command_id : row.event.event_id
const ordinaryEvents = new Set(['session_delivered', 'session_ingested', 'message_delivered', 'message_ingested', 'report'])
const matches = (value, execution) => sameBinding(value, execution) || sameBinding(value, execution, { firstSession: true })
export function archiveCandidates(state) {
  const eligible = state.executions.filter(execution => {
    if (!['stopped', 'settled'].includes(execution.status) || execution.slotHeld !== false || execution.unavailableReason) return false
    const events = state.outbox.filter(row => row.event.launch_id === execution.launch_id)
    if (events.some(row => !row.acknowledged || !matches(row.event, execution) || row.event.kind === 'runtime_unavailable')) return false
    const terminal = events.find(row => row.acknowledged && sameBinding(row.event, execution) && row.event.kind === execution.status && ['idle_after_cancel', 'never_started'].includes(row.event[execution.status === 'stopped' ? 'stop_evidence' : 'settle_evidence']))
    if (!terminal) return false
    assertSealed(terminal.event)
    if (state.jobs.some(row => row.launch_id === execution.launch_id && (!sameBinding(row, execution) || row.state !== 'stopped' || !['exit_confirmed', 'never_started'].includes(row.stopEvidence?.workerExit)))) return false
    if (state.captures.some(row => row.producerBinding.launch_id === execution.launch_id && (!sameBinding(row.producerBinding, execution) || !['published', 'failed'].includes(row.state)))) return false
    return !state.inbox.some(row => row.command.launch_id === execution.launch_id && (!matches(row.command, execution) || !['stopped', 'settled', 'manual_idle', 'manual_released', 'control_consumed', 'budget_idle'].includes(row.status)))
  })
  const records = []
  for (const [kind, rows] of [['inbox', state.inbox], ['outbox', state.outbox]]) rows.forEach((row, position) => {
    const value = kind === 'inbox' ? row.command : row.event
    if (!eligible.some(execution => value.launch_id === execution.launch_id && matches(value, execution))) return
    if (kind === 'inbox' ? !['launch', 'deliver'].includes(value.operation) || !['stopped', 'settled'].includes(row.status) : !ordinaryEvents.has(value.kind) || row.acknowledged !== true) return
    assertSealed(value)
    records.push({ kind, position, row })
  })
  return records
}

export function createJournalArchive(path, operations = {}) {
  const io = { mkdir, open, readFile, readdir, lstat, rename, ...operations }, directory = join(dirname(path), 'journal-archive')
  const cache = new Map()
  let reason = null
  async function physical() {
    let names
    try { names = await io.readdir(directory) } catch (cause) { if (cause.code === 'ENOENT') return { physicalBytes: 0, logicalBytes: 0 }; throw failed() }
    const directoryStat = await io.lstat(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failed()
    let physicalBytes = directoryStat.blocks * 512, logicalBytes = 0
    for (const name of names) {
      const stat = await io.lstat(join(directory, name))
      if (!stat.isFile() || stat.isSymbolicLink()) throw failed()
      physicalBytes += stat.blocks * 512; logicalBytes += stat.size
    }
    return { physicalBytes, logicalBytes }
  }
  function manifest(state) {
    if (state.version !== 4) { if (state.archive !== undefined) throw failed(); return [] }
    const value = state.archive
    if (value?.version !== 1 || !Array.isArray(value.segments) || !value.segments.length || value.segments.length > HOST_ARCHIVE_LIMITS.maxSegments || new Set(value.segments.map(row => row.id)).size !== value.segments.length) throw failed()
    for (const row of value.segments) if (!/^[a-f0-9]{64}$/.test(row.id) || row.sha256 !== row.id || !/^[a-f0-9]{64}$/.test(row.indexSha256) || !['bytes', 'indexBytes', 'inboxRows', 'outboxRows'].every(field => Number.isSafeInteger(row[field]) && row[field] >= 0) || !row.bytes || row.bytes > HOST_ARCHIVE_LIMITS.segmentBytes || !row.indexBytes || row.indexBytes > HOST_ARCHIVE_LIMITS.segmentBytes || row.inboxRows + row.outboxRows < 1) throw failed()
    return value.segments
  }
  async function bytes(name, expectedSize) {
    let handle
    try {
      handle = await io.open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== expectedSize || stat.size > HOST_ARCHIVE_LIMITS.segmentBytes) throw failed()
      return await handle.readFile()
    } catch { throw failed() } finally { await handle?.close().catch(() => {}) }
  }
  async function segment(ref) {
    try {
      const directoryStat = await io.lstat(directory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failed()
      const paths = [join(directory, ref.id + '.jsonl'), join(directory, ref.id + '.index.json')]
      const stats = await Promise.all(paths.map(file => io.lstat(file, { bigint: true })))
      if (stats.some(stat => !stat.isFile() || stat.isSymbolicLink())) throw failed()
      const fingerprint = stats.map(stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs]).flat().join(':')
      const prior = cache.get(ref.id)
      if (prior?.fingerprint === fingerprint && isDeepStrictEqual(prior.ref, ref)) return prior.index
      const data = await bytes(ref.id + '.jsonl', ref.bytes), rawIndex = await bytes(ref.id + '.index.json', ref.indexBytes)
      if (hash(data) !== ref.sha256 || hash(rawIndex) !== ref.indexSha256) throw failed()
      const index = JSON.parse(rawIndex)
      if (index.version !== 1 || index.segment !== ref.id || !Array.isArray(index.rows) || index.rows.length !== ref.inboxRows + ref.outboxRows) throw failed()
      const ids = new Set(), counts = { inbox: 0, outbox: 0 }, positions = { inbox: -1, outbox: -1 }
      let offset = 0
      for (const item of index.rows) {
        if (!['inbox', 'outbox'].includes(item.kind) || !Number.isSafeInteger(item.offset) || item.offset !== offset || !Number.isSafeInteger(item.length) || item.length <= 0 || item.offset + item.length > data.length || !/^[a-f0-9]{64}$/.test(item.sha256) || typeof item.id !== 'string' || ids.has(item.kind + ':' + item.id)) throw failed()
        const raw = data.subarray(item.offset, item.offset + item.length)
        if (hash(raw) !== item.sha256) throw failed()
        const record = JSON.parse(raw)
        if (record.kind !== item.kind || !Number.isSafeInteger(record.position) || record.position !== item.position || record.position <= positions[item.kind] || !record.row || rowId(item.kind, record.row) !== item.id) throw failed()
        positions[item.kind] = record.position
        assertSealed(item.kind === 'inbox' ? record.row.command : record.row.event)
        if (item.kind === 'inbox' ? !['launch', 'deliver'].includes(record.row.command.operation) || !['stopped', 'settled'].includes(record.row.status) : !ordinaryEvents.has(record.row.event.kind) || record.row.acknowledged !== true) throw failed()
        ids.add(item.kind + ':' + item.id); counts[item.kind]++; offset += item.length
      }
      if (offset !== data.length || counts.inbox !== ref.inboxRows || counts.outbox !== ref.outboxRows) throw failed()
      cache.set(ref.id, { fingerprint, ref: structuredClone(ref), index })
      return index
    } catch { throw failed() }
  }
  async function validate(state) {
    const refs = manifest(state), ids = new Set(), positions = new Set()
    const hotIds = new Set(['inbox', 'outbox'].flatMap(kind => state[kind].map(row => kind + ':' + rowId(kind, row))))
    for (const ref of refs) for (const row of (await segment(ref)).rows) {
      const id = row.kind + ':' + row.id
      const position = row.kind + ':' + row.position
      if (positions.has(position) || ids.has(id) || hotIds.has(id)) throw failed()
      ids.add(id); positions.add(position)
    }
    return refs
  }
  async function lookup(state, kind, id) {
    if (!['inbox', 'outbox'].includes(kind) || typeof id !== 'string' || !id) throw error('INVALID_REQUEST')
    const hot = state[kind].find(row => rowId(kind, row) === id)
    if (hot) return structuredClone(hot)
    for (const ref of manifest(state)) {
      const item = (await segment(ref)).rows.find(row => row.kind === kind && row.id === id)
      if (!item) continue
      let handle
      try {
        handle = await io.open(join(directory, ref.id + '.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW)
        const raw = Buffer.alloc(item.length), { bytesRead } = await handle.read(raw, 0, raw.length, item.offset)
        if (bytesRead !== raw.length || hash(raw) !== item.sha256) throw failed()
        const record = JSON.parse(raw); assertSealed(kind === 'inbox' ? record.row.command : record.row.event)
        if (record.kind !== kind || rowId(kind, record.row) !== id) throw failed()
        return record.row
      } catch { throw failed() } finally { await handle?.close().catch(() => {}) }
    }
    return null
  }
  async function durable(name, data) {
    const final = join(directory, name), temporary = join(directory, '.' + name + '.tmp')
    let handle
    try {
      try {
        const previous = await io.readFile(final)
        if (!previous.equals(data)) throw failed()
        handle = await io.open(final, 'r'); await handle.sync(); await handle.close(); handle = undefined
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause
        handle = await io.open(temporary, 'w', 0o600); await handle.writeFile(data); await handle.sync(); await handle.close(); handle = undefined
        await io.rename(temporary, final)
      }
      handle = await io.open(directory, 'r'); await handle.sync(); await handle.close(); handle = undefined
    } finally { await handle?.close().catch(() => {}) }
  }
  async function compact(state, continuing = false) {
    reason = null
    const refs = manifest(state), hotBytes = Buffer.byteLength(JSON.stringify(state) + '\n')
    if (!continuing && hotBytes < HOST_ARCHIVE_LIMITS.triggerBytes && state.inbox.length < HOST_ARCHIVE_LIMITS.triggerCount) return
    const candidates = archiveCandidates(state)
    // Positions remain in the original logical arrays even after earlier cuts.
    const occupied = { inbox: new Set(), outbox: new Set() }
    for (const ref of refs) for (const row of (await segment(ref)).rows) occupied[row.kind].add(row.position)
    const positions = { inbox: [], outbox: [] }
    for (const kind of ['inbox', 'outbox']) {
      let position = 0
      for (const row of state[kind]) { while (occupied[kind].has(position)) position++; positions[kind].push(position++) }
    }
    for (const record of candidates) record.position = positions[record.kind][record.position]
    if (!candidates.length) { reason = 'no_eligible_rows'; return }
    if (refs.length >= HOST_ARCHIVE_LIMITS.maxSegments) { reason = 'cold_capacity'; return }
    const selected = [], chunks = []
    let size = 0, removed = 0, removedInbox = 0
    for (const record of candidates) {
      const chunk = Buffer.from(JSON.stringify(record) + '\n')
      if (size + chunk.length > HOST_ARCHIVE_LIMITS.segmentBytes) break
      selected.push(record); chunks.push(chunk); size += chunk.length; removed += Buffer.byteLength(JSON.stringify(record.row)) + 1
      if (record.kind === 'inbox') removedInbox++
      if (hotBytes - removed <= HOST_ARCHIVE_LIMITS.targetBytes && state.inbox.length - removedInbox <= HOST_ARCHIVE_LIMITS.targetCount) break
    }
    if (!selected.length) { reason = 'cold_capacity'; return }
    const data = Buffer.concat(chunks), id = hash(data), rows = [], counts = { inbox: 0, outbox: 0 }
    let offset = 0
    for (let i = 0; i < selected.length; i++) {
      const record = selected[i], chunk = chunks[i]
      rows.push({ kind: record.kind, id: rowId(record.kind, record.row), position: record.position, offset, length: chunk.length, sha256: hash(chunk) })
      counts[record.kind]++; offset += chunk.length
    }
    const index = Buffer.from(JSON.stringify({ version: 1, segment: id, rows }) + '\n')
    if (index.length > HOST_ARCHIVE_LIMITS.segmentBytes) { reason = 'cold_capacity'; return }
    async function allocationNeeded(name, value) {
      try {
        const stat = await io.lstat(join(directory, name))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== value.length || !(await bytes(name, value.length)).equals(value)) throw failed()
        return 0
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      let retained = 0
      try {
        const stat = await io.lstat(join(directory, '.' + name + '.tmp'))
        if (!stat.isFile() || stat.isSymbolicLink()) throw failed()
        retained = stat.blocks * 512
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      return Math.max(0, Math.ceil(value.length / 4096) * 4096 - retained)
    }
    const current = await physical()
    const allocation = await allocationNeeded(id + '.jsonl', data) + await allocationNeeded(id + '.index.json', index)
    // Existing complete pairs are already included in physical(). Only reserve
    // new blocks (and directory growth); failed retries reuse the original pair.
    if (current.physicalBytes + allocation + (allocation ? 4096 : 0) > HOST_ARCHIVE_LIMITS.physicalBytes) { reason = 'cold_capacity'; return }
    await io.mkdir(directory, { recursive: true, mode: 0o700 })
    let parent = await io.open(dirname(directory), 'r'); try { await parent.sync() } finally { await parent.close() }
    await durable(id + '.jsonl', data); await durable(id + '.index.json', index)
    const ref = { id, sha256: id, bytes: data.length, indexBytes: index.length, indexSha256: hash(index), inboxRows: counts.inbox, outboxRows: counts.outbox }
    await segment(ref)
    if ((await physical()).physicalBytes > HOST_ARCHIVE_LIMITS.physicalBytes) { reason = 'cold_capacity'; return }
    const moved = { inbox: new Set(), outbox: new Set() }
    for (const record of selected) moved[record.kind].add(rowId(record.kind, record.row))
    state.inbox = state.inbox.filter(row => !moved.inbox.has(row.command.command_id))
    state.outbox = state.outbox.filter(row => !moved.outbox.has(row.event.event_id))
    state.version = 4; state.archive = { version: 1, segments: [...refs, ref] }
    if (Buffer.byteLength(JSON.stringify(state) + '\n') > HOST_ARCHIVE_LIMITS.targetBytes || state.inbox.length > HOST_ARCHIVE_LIMITS.targetCount) await compact(state, true)
  }
  async function metadata(state) {
    const refs = await validate(state), usage = await physical()
    let observedReason = reason
    if (!observedReason && (Buffer.byteLength(JSON.stringify(state) + '\n') >= HOST_ARCHIVE_LIMITS.triggerBytes || state.inbox.length >= HOST_ARCHIVE_LIMITS.triggerCount)) {
      if (refs.length >= HOST_ARCHIVE_LIMITS.maxSegments || usage.physicalBytes >= HOST_ARCHIVE_LIMITS.physicalBytes) observedReason = 'cold_capacity'
      else if (!archiveCandidates(state).length) observedReason = 'no_eligible_rows'
    }
    return { state: refs.length ? 'readable' : 'not_applicable', segments: refs.length, inboxRows: refs.reduce((sum, row) => sum + row.inboxRows, 0), outboxRows: refs.reduce((sum, row) => sum + row.outboxRows, 0), referencedBytes: refs.reduce((sum, row) => sum + row.bytes + row.indexBytes, 0), ...usage, limits: HOST_ARCHIVE_LIMITS, reason: observedReason }
  }
  return { validate, lookup, compact: async state => {
    try { await compact(state) } catch { reason = 'cold_write_unconfirmed' }
  }, metadata }
}
