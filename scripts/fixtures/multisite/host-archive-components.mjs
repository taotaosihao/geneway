import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, readdir, rename, cp, utimes, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHostJournal } from '../../../packages/agent-host/journal.mjs'
import { archiveCandidates, HOST_ARCHIVE_LIMITS } from '../../../packages/agent-host/journal-archive.mjs'
import { createAgentHost, HOST_INBOX_LIMITS } from '../../../packages/agent-host/host.mjs'
import { seal, key, binding, SCHEMA } from '../../../packages/agent-contracts/index.mjs'
import { observeArchiveIO } from './host-archive-io.mjs'

const evidence = '/home/gewu/.codex/task-checkpoints/geneway-evidence'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const rowId = (kind, row) => kind === 'inbox' ? row.command.command_id : row.event.event_id
const reseal = (value, changes) => { const { payload_digest, ...body } = value; return seal({ ...body, ...changes }) }
async function seed(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(state) + '\n', { mode: 0o600 })
}

function smallSyntheticHistory(count) {
  const execution = { work_id: 'w', delegation_id: 'd', parent_delegation_id: null, attempt_id: 'a', execution_epoch: 1, agent_id: 'g', node_id: 'n', launch_id: 'l', session_id: 's', status: 'stopped', slotHeld: false }
  const inbox = Array.from({ length: count }, (_, index) => ({ command: seal({ schema: SCHEMA, command_id: key('small-archive-unit', index), workspace_id: 'local', ...binding(execution), operation: 'deliver', input_id: key('small-archive-input', index), instruction_revision: index + 1, observed_revision: 0, resource_refs: [], parameters: { text: 'x' }, employee_revision: 1 }), status: 'stopped', acceptedAt: '2026-11-07T00:00:00.000Z' }))
  const event = seal({ schema: SCHEMA, event_id: key('small-archive-terminal'), workspace_id: 'local', ...binding(execution), kind: 'stopped', input_id: null, instruction_revision: count, observed_revision: count, resource_refs: [], stop_evidence: 'idle_after_cancel' })
  return { version: 3, inbox, outbox: [{ event, acknowledged: true }], executions: [execution], jobs: [], captures: [] }
}

// Explicit synthetic unit cohort: not a Work producer or business-history claim.
// Original real small-row DTOs supply the supported launch/session shape only.
function syntheticCohort(sample) {
  const execution = { ...sample.executions[0], observed_revision: 200 }
  const inbox = [], outbox = []
  for (let index = 0; index < 200; index++) {
    const original = sample.inbox[index === 0 ? 0 : 1].command
    const parameters = structuredClone(original.parameters)
    parameters.text = '测'.repeat(16000)
    parameters.executionContext.goal = '验'.repeat(16000)
    const command = reseal(original, { command_id: key('archive-unit-command', index), input_id: key('archive-unit-input', index), instruction_revision: index + 1, parameters })
    inbox.push({ command, status: 'stopped', acceptedAt: sample.inbox[0].acceptedAt })
    const event = reseal(sample.outbox.find(row => row.event.kind === 'session_ingested').event, { kind: 'report', report: { summary: '报'.repeat(16000) }, event_id: key('archive-unit-event', index), input_id: command.input_id, instruction_revision: index + 1, observed_revision: index + 1 })
    outbox.push({ event, acknowledged: true })
  }
  // Interspersed control remains hot; positions must survive multiple cuts.
  inbox.splice(31, 0, structuredClone(sample.inbox.find(row => row.command.operation === 'cancel')))
  outbox.splice(37, 0, structuredClone(sample.outbox.find(row => row.event.kind === 'started')))
  outbox.push({ event: reseal(sample.outbox.find(row => row.event.kind === 'stopped').event, { instruction_revision: 200, observed_revision: 200 }), acknowledged: true })
  return { version: 3, inbox, outbox, executions: [execution], jobs: [], captures: [] }
}

async function verifyRows(path, original, journal) {
  const hot = await journal.read(), restored = { inbox: new Array(original.inbox.length), outbox: new Array(original.outbox.length) }
  const positions = { inbox: new Set(), outbox: new Set() }, records = []
  for (const ref of hot.archive.segments) {
    const raw = await readFile(join(dirname(path), 'journal-archive', ref.id + '.jsonl'))
    const index = JSON.parse(await readFile(join(dirname(path), 'journal-archive', ref.id + '.index.json'), 'utf8'))
    assert.equal(digest(raw), ref.sha256)
    for (const item of index.rows) {
      const bytes = raw.subarray(item.offset, item.offset + item.length)
      assert.equal(digest(bytes), item.sha256)
      const record = JSON.parse(bytes)
      assert.equal(record.position, item.position)
      assert.equal(rowId(item.kind, record.row), item.id)
      assert.deepEqual(record.row, original[item.kind][item.position])
      assert.equal(positions[item.kind].has(item.position), false)
      positions[item.kind].add(item.position); restored[item.kind][item.position] = record.row
      records.push(record)
      assert.deepEqual(await journal.lookup(item.kind, item.id), record.row)
    }
  }
  for (const kind of ['inbox', 'outbox']) {
    let position = 0
    for (const row of hot[kind]) {
      while (positions[kind].has(position)) position++
      restored[kind][position++] = row
    }
    assert.deepEqual(restored[kind], original[kind])
  }
  assert.deepEqual(hot.executions, original.executions)
  assert.deepEqual(hot.jobs, original.jobs); assert.deepEqual(hot.captures, original.captures)
  return { hot, records }
}

export async function runArchiveComponents({ directory, save }) {
  const cases = [], mark = name => { cases.push({ name, result: 'passed' }); console.log(JSON.stringify({ stage: 'component', name })) }
  assert.deepEqual(HOST_ARCHIVE_LIMITS, { triggerBytes: 8388608, targetBytes: 4194304, triggerCount: 8192, targetCount: 4096, segmentBytes: 8388608, maxSegments: 64, physicalBytes: 536870912 })
  const smallPath = join(evidence, 't11-host-pressure-uGxfMY/terminal-host.json'), smallRaw = await readFile(smallPath), small = JSON.parse(smallRaw)
  const oldPath = join(directory, 'real-v3/host-journal.json'); await seed(oldPath, small)
  const oldJournal = createHostJournal(oldPath); await oldJournal.update(() => {})
  assert.equal((await oldJournal.read()).version, 3)
  assert.deepEqual(await oldJournal.read(), small)
  const unknownPath = join(evidence, 't11-host-pressure-qm6P7U/terminal-host.json'), unknownRaw = await readFile(unknownPath), unknown = JSON.parse(unknownRaw)
  const protectedLaunches = unknown.executions.filter(row => row.unavailableReason || row.status === 'unknown').map(row => row.launch_id)
  assert(protectedLaunches.length)
  assert(archiveCandidates(unknown).every(record => !protectedLaunches.includes((record.row.command ?? record.row.event).launch_id)))
  await save('real-sample-provenance.json', { scope: 'original archived real samples; read and qualification only, no producer or state repair', samples: [{ path: smallPath, sha256: digest(smallRaw) }, { path: unknownPath, sha256: digest(unknownRaw) }], protectedLaunches })
  mark('real v3 reads unchanged; historical unknown cohort excluded without editing its reason')

  const synthetic = syntheticCohort(small)
  await save('synthetic-unit-scope.json', { scope: 'synthetic sealed unit rows and synthetic ACK/terminal facts; isolated local Journal persistence only; not actual Work history', inboxRows: synthetic.inbox.length, bytes: Buffer.byteLength(JSON.stringify(synthetic)), productionLimits: HOST_ARCHIVE_LIMITS })
  assert(Buffer.byteLength(JSON.stringify(synthetic)) > HOST_ARCHIVE_LIMITS.segmentBytes * 2)
  assert.equal(archiveCandidates(synthetic).length, 400)
  for (const variation of ['active', 'unknown', 'unacked']) {
    const value = structuredClone(synthetic)
    if (variation === 'active') { value.executions[0].status = 'running'; value.executions[0].slotHeld = true }
    if (variation === 'unknown') value.executions[0].unavailableReason = 'RECOVERY_EXECUTION_UNCONFIRMED'
    if (variation === 'unacked') value.outbox[0].acknowledged = false
    assert.equal(archiveCandidates(value).length, 0)
  }
  mark('synthetic active, unknown and unacknowledged clusters stay hot')

  const path = join(directory, 'multisegment/host-journal.json'); await seed(path, synthetic)
  const io = observeArchiveIO(), journal = createHostJournal(path, io.operations)
  io.phase('cut'); await journal.update(() => {})
  io.phase('independent-full-row-oracle')
  const { hot, records } = await verifyRows(path, synthetic, journal)
  assert.equal(hot.version, 4); assert(hot.archive.segments.length >= 2)
  assert(Buffer.byteLength(JSON.stringify(hot)) <= HOST_ARCHIVE_LIMITS.targetBytes)
  const coldCommand = records.find(row => row.kind === 'inbox').row.command
  const coldEvent = records.find(row => row.kind === 'outbox')?.row.event
  assert(coldEvent, 'This synthetic unit includes cold outbox rows as well as inbox')
  io.phase('warm-read'); await journal.read()
  io.phase('new-id-index-miss'); assert.equal(await journal.lookup('inbox', key('never-seen-archive-unit')), null)
  io.phase('cold-hit'); assert.deepEqual(await journal.lookup('inbox', coldCommand.command_id), records.find(row => row.kind === 'inbox').row)
  const reopenedIO = observeArchiveIO(); reopenedIO.phase('reopen-full-validation')
  const reopened = createHostJournal(path, reopenedIO.operations, { archive: false })
  assert.deepEqual(await reopened.read(), hot)
  const summary = io.summary()
  for (const phase of ['warm-read', 'new-id-index-miss']) {
    assert.equal(summary[phase].cold?.['handle.readFile']?.bytes ?? 0, 0)
    assert.equal(summary[phase].cold?.pread?.bytes ?? 0, 0)
    assert((summary[phase].cold?.lstat?.calls ?? 0) >= hot.archive.segments.length * 2)
  }
  assert.equal(summary['cold-hit'].cold.pread.calls, 1)
  assert((reopenedIO.summary()['reopen-full-validation'].cold['handle.readFile'].bytes) > 0)
  io.phase('fingerprint-change-revalidation')
  const touched = join(dirname(path), 'journal-archive', hot.archive.segments[0].id + '.jsonl')
  const changedTime = new Date(Date.now() + 2000); await utimes(touched, changedTime, changedTime)
  await journal.read()
  assert((io.summary()['fingerprint-change-revalidation'].cold['handle.readFile'].bytes) > 0)
  mark('multiple real filesystem segments preserve complete rows and global positions; warm/cold read costs measured')

  let starts = 0
  const runtime = { async start() { starts++; throw Error('No runtime allowed in component') }, async close() {} }
  const host = createAgentHost({ nodeId: coldCommand.node_id, journal, runtime }), auth = { workspaceId: 'local', nodeId: coldCommand.node_id }
  io.phase('cold-command-accept-replay')
  const before = await journal.read()
  const ack = await host.accept(auth, coldCommand)
  assert.deepEqual(binding(ack), binding(coldCommand)); assert.equal(ack.command_id, coldCommand.command_id)
  assert.deepEqual(await journal.read(), before)
  await assert.rejects(host.accept(auth, reseal(coldCommand, { parameters: { ...coldCommand.parameters, text: 'changed old ID' } })), { code: 'IDEMPOTENCY_CONFLICT' })
  assert.equal(starts, 0)
  await assert.rejects(journal.update(state => { state.archive = { version: 1, segments: [] } }), { code: 'INVALID_STATE' })
  io.phase('cold-event-append-replay')
  await journal.update(state => state.outbox.push({ event: coldEvent, acknowledged: false }))
  assert.deepEqual(await journal.read(), before)
  await assert.rejects(journal.update(state => state.outbox.push({ event: reseal(coldEvent, { observed_revision: coldEvent.observed_revision + 1 }), acknowledged: false })), { code: 'IDEMPOTENCY_CONFLICT' })
  io.phase('new-id-accept')
  const newCommand = reseal(coldCommand, { command_id: key('archive-unit-new-id-accept'), input_id: key('archive-unit-new-input') })
  assert.equal((await host.accept(auth, newCommand)).command_id, newCommand.command_id)
  const newAccept = io.summary()['new-id-accept']
  assert.equal(newAccept.cold?.['handle.readFile']?.bytes ?? 0, 0)
  assert.equal(newAccept.cold?.pread?.bytes ?? 0, 0)
  await save('io-stages.json', { scope: 'actual completed syscalls/bytes, independent row oracle separate from cut; no elapsed-time or device-total estimate', stages: io.summary(), reopen: reopenedIO.summary() })
  await save('io-events.json', { operations: io.events, reopen: reopenedIO.events })
  await host.close()
  mark('production accept exact cold metadata ACK and changed digest conflict without reheat or execution; manifest writer rejected')

  for (const variant of ['missing-data', 'corrupt-data', 'missing-index', 'corrupt-index']) {
    const target = join(directory, variant); await cp(dirname(path), target, { recursive: true })
    const dataPath = join(target, 'journal-archive', hot.archive.segments[0].id + (variant.endsWith('index') ? '.index.json' : '.jsonl'))
    const bad = createHostJournal(join(target, 'host-journal.json')); await bad.read()
    if (variant.startsWith('missing')) await rename(dataPath, dataPath + '.retained')
    else { const data = await readFile(dataPath); data[0] ^= 1; await writeFile(dataPath, data) }
    await assert.rejects(bad.read(), { code: 'ARCHIVE_UNAVAILABLE' })
    await assert.rejects(bad.lookup('inbox', coldCommand.command_id), { code: 'ARCHIVE_UNAVAILABLE' })
    await assert.rejects(createHostJournal(join(target, 'host-journal.json')).read(), { code: 'ARCHIVE_UNAVAILABLE' })
  }
  mark('missing or corrupt referenced segment fails closed for read and lookup')

  for (const mode of ['before-manifest-rename', 'after-manifest-rename']) {
    const target = join(directory, mode, 'host-journal.json'); await seed(target, synthetic)
    let armed = false, renamed = false
    const crashIO = observeArchiveIO({ fault(operation, from, to) {
      if (!armed) return
      if (operation === 'rename' && to === target) {
        if (mode === 'before-manifest-rename') throw Object.assign(Error('component pre-manifest crash'), { code: 'EIO' })
        renamed = true
      }
      if (mode === 'after-manifest-rename' && renamed && operation === 'sync' && from === dirname(target)) throw Object.assign(Error('component post-manifest dirsync uncertainty'), { code: 'EIO' })
    } })
    const crashing = createHostJournal(target, crashIO.operations); await crashing.read(); armed = true
    await assert.rejects(crashing.update(() => {}), { code: 'EIO' }); armed = false
    const originalNames = (await readdir(join(dirname(target), 'journal-archive'))).sort()
    if (mode === 'before-manifest-rename') {
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), synthetic)
      await crashing.update(() => {})
      assert.deepEqual((await readdir(join(dirname(target), 'journal-archive'))).sort(), originalNames)
    } else await assert.rejects(crashing.read(), { code: 'STORE_UNAVAILABLE' })
    const recovered = createHostJournal(target)
    await verifyRows(target, synthetic, recovered)
  }
  mark('pre-manifest failure retains original hot transaction and retries same segment names; post-rename latch needs new constructor')

  const crashes = []
  for (const mode of ['before-manifest-rename', 'after-manifest-rename']) {
    const target = join(directory, 'sigkill-' + mode, 'host-journal.json'); await seed(target, synthetic)
    const child = fork(fileURLToPath(new URL('./host-archive-crash.mjs', import.meta.url)), [target, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    const terminal = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Crash barrier timeout')), 30000)
        child.once('error', reject)
        child.on('message', message => { clearTimeout(timeout); message.kind === 'barrier' ? resolve(message) : reject(Error(JSON.stringify(message))) })
        child.once('exit', () => { clearTimeout(timeout); reject(Error('Child exited before barrier')) })
      })
      const at = new Date().toISOString(); child.kill('SIGKILL')
      const exit = await terminal
      assert.equal(exit.signal, 'SIGKILL')
      await assert.rejects(readFile('/proc/' + child.pid + '/stat'), { code: 'ENOENT' })
      const actual = JSON.parse(await readFile(target, 'utf8'))
      assert.equal(actual.version, mode === 'before-manifest-rename' ? 3 : 4)
      if (actual.version === 3) assert.deepEqual(actual, synthetic)
      const recovered = createHostJournal(target)
      await recovered.update(() => {}); await verifyRows(target, synthetic, recovered)
      crashes.push({ mode, pid: child.pid, signalAt: at, exit, osGone: true, manifestVersionAtExit: actual.version, output })
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await terminal }
    }
  }
  await save('process-crashes.json', { scope: 'actual SIGKILL of private synthetic-unit Journal child at real filesystem barrier; no business Host restart claim', crashes })
  mark('actual child SIGKILL before/after manifest leaves original file or valid cold references; same-file recovery preserves all rows')

  const capacityPath = join(directory, 'cold-capacity/host-journal.json'); await seed(capacityPath, synthetic)
  const coldDirectory = join(dirname(capacityPath), 'journal-archive'); await mkdir(coldDirectory); await writeFile(join(coldDirectory, '.retained-orphan'), 'x')
  const capacityIO = observeArchiveIO({ transformStat(target, stat) {
    if (target !== join(coldDirectory, '.retained-orphan')) return stat
    return new Proxy(stat, { get(value, name) { return name === 'blocks' ? HOST_ARCHIVE_LIMITS.physicalBytes / 512 : Reflect.get(value, name) } })
  } })
  const full = createHostJournal(capacityPath, capacityIO.operations)
  await full.update(() => {}); assert.deepEqual(await full.read(), synthetic)
  assert.equal((await full.archiveMetadata()).reason, 'cold_capacity')
  const controlHost = createAgentHost({ nodeId: synthetic.executions[0].node_id, journal: full, runtime })
  const cancel = reseal(small.inbox.find(row => row.command.operation === 'cancel').command, { command_id: key('archive-unit-control-after-cold-cap') })
  assert.equal((await controlHost.accept(auth, cancel)).command_id, cancel.command_id)
  assert.equal((await full.read()).inbox.at(-1).command.command_id, cancel.command_id)
  assert.equal(starts, 0); await controlHost.close()
  await save('capacity-scope.json', { scope: 'test-only lstat.blocks accounting fault for one actual orphan file; no physical disk fill, no production threshold override', io: capacityIO.summary() })
  mark('cold physical capacity keeps hot update and legal control admission available')

  for (const operation of ['deliver', 'cancel']) {
    const count = operation === 'deliver' ? HOST_INBOX_LIMITS.ordinaryHistoryCount : HOST_INBOX_LIMITS.historyCount
    const value = smallSyntheticHistory(count), bytes = Buffer.byteLength(JSON.stringify(value))
    assert(bytes < HOST_ARCHIVE_LIMITS.triggerBytes, 'Count-trigger unit must stay below byte trigger')
    const target = join(directory, 'count-before-' + operation, 'host-journal.json'); await seed(target, value)
    const counted = createHostJournal(target), componentHost = createAgentHost({ nodeId: 'n', journal: counted, runtime })
    const candidate = reseal(value.inbox[0].command, { command_id: key('small-archive-new', operation), operation, input_id: operation === 'cancel' ? null : key('small-archive-new-input'), parameters: operation === 'cancel' ? {} : { text: 'new' } })
    assert.equal((await componentHost.accept({ workspaceId: 'local', nodeId: 'n' }, candidate)).command_id, candidate.command_id)
    const accepted = await counted.read(); assert.equal(accepted.version, 4)
    assert(accepted.inbox.some(row => row.command.command_id === candidate.command_id))
    assert(accepted.inbox.length <= HOST_ARCHIVE_LIMITS.targetCount + 1)
    assert.equal(accepted.archive.segments.length, 1, 'Small-row count recovery must move a batch, without consuming many tiny segments')
    await componentHost.close()
    await save('count-before-' + operation + '.json', { scope: 'synthetic sealed history / synthetic terminal proof only, not actual Work history', initialCount: count, initialBytes: bytes, finalHotCount: accepted.inbox.length, segments: accepted.archive.segments.length })
  }
  const blocked = smallSyntheticHistory(HOST_INBOX_LIMITS.ordinaryHistoryCount)
  blocked.executions[0].status = 'unknown'; blocked.executions[0].slotHeld = true; blocked.executions[0].unavailableReason = 'RECOVERY_EXECUTION_UNCONFIRMED'
  const blockedPath = join(directory, 'count-unknown/host-journal.json'); await seed(blockedPath, blocked)
  const blockedJournal = createHostJournal(blockedPath), blockedHost = createAgentHost({ nodeId: 'n', journal: blockedJournal, runtime }), blockedAuth = { workspaceId: 'local', nodeId: 'n' }
  assert.equal((await blockedHost.accept(blockedAuth, blocked.inbox[0].command)).command_id, blocked.inbox[0].command.command_id)
  const different = reseal(blocked.inbox[0].command, { command_id: key('count-unknown-new') })
  await assert.rejects(blockedHost.accept(blockedAuth, different), cause => cause.code === 'CAPACITY_EXCEEDED' && cause.capacity?.reason === 'history_count')
  assert.deepEqual(await blockedJournal.read(), blocked); await blockedHost.close(); assert.equal(starts, 0)
  mark('below-8MiB synthetic history 9936 ordinary / 10000 control prepares archive before admission; old-ID priority and unknown refusal preserved')

  const retryPath = join(directory, 'near-cap-retry/host-journal.json'); await seed(retryPath, synthetic)
  let rejectRename = true
  const failedWrite = createHostJournal(retryPath, observeArchiveIO({ fault(operation, from, to) {
    if (rejectRename && operation === 'rename' && to === retryPath) throw Object.assign(Error('synthetic manifest rename fault retaining durable pairs'), { code: 'EIO' })
  } }).operations)
  await assert.rejects(failedWrite.update(() => {}), { code: 'EIO' }); rejectRename = false
  const retryDirectory = join(dirname(retryPath), 'journal-archive'), retained = join(retryDirectory, '.accounting-only-orphan')
  await writeFile(retained, 'x')
  let otherBlocks = (await lstat(retryDirectory)).blocks
  for (const name of await readdir(retryDirectory)) if (join(retryDirectory, name) !== retained) otherBlocks += (await lstat(join(retryDirectory, name))).blocks
  const virtualBlocks = (HOST_ARCHIVE_LIMITS.physicalBytes - 4096) / 512 - otherBlocks
  assert(virtualBlocks > 0)
  const retryIO = observeArchiveIO({ transformStat(target, stat) {
    if (target !== retained) return stat
    return new Proxy(stat, { get(value, name) { return name === 'blocks' ? virtualBlocks : Reflect.get(value, name) } })
  } })
  retryIO.phase('reuse-at-cap'); const retry = createHostJournal(retryPath, retryIO.operations)
  const namesBefore = (await readdir(retryDirectory)).sort(); await retry.update(() => {})
  assert.equal((await retry.read()).version, 4)
  assert.deepEqual((await readdir(retryDirectory)).sort(), namesBefore)
  assert.equal(retryIO.summary()['reuse-at-cap'].cold?.writeFile?.calls ?? 0, 0)
  await verifyRows(retryPath, synthetic, retry)
  await save('near-cap-retry.json', { scope: 'synthetic local rows and lstat.blocks accounting fault, not physical disk fill', accountedPhysicalBytes: HOST_ARCHIVE_LIMITS.physicalBytes - 4096, virtualBlocks, originalNames: namesBefore, io: retryIO.summary() })
  // Corrupt retained bytes must not receive the complete-pair budget exemption.
  const badRetryPath = join(directory, 'near-cap-bad-pair/host-journal.json'); await cp(dirname(retryPath), dirname(badRetryPath), { recursive: true }); await seed(badRetryPath, synthetic)
  const badDirectory = join(dirname(badRetryPath), 'journal-archive'), dataName = (await retry.read()).archive.segments[0].id + '.jsonl', corruptPath = join(badDirectory, dataName)
  const corrupt = await readFile(corruptPath); corrupt[0] ^= 1; await writeFile(corruptPath, corrupt)
  const badPair = createHostJournal(badRetryPath); await badPair.update(() => {})
  assert.deepEqual(await badPair.read(), synthetic)
  assert.equal((await badPair.archiveMetadata()).reason, 'cold_write_unconfirmed')
  mark('near-cap retry reuses verified durable original pairs with zero cold writes; corrupted retained pair never gains reuse exemption')
  return cases
}
