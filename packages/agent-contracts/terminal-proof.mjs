import { isDeepStrictEqual } from 'node:util'
import { assertSealed, binding, BINDING_FIELDS, error, exact, key, sameBinding, SCHEMA, seal, text } from './index.mjs'

export const MAX_TERMINAL_EVENT_BYTES = 262144
export const MAX_JOB_STOP_ITEM_BYTES = 50396
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const jobId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const check = condition => { if (!condition) throw error('INVALID_REQUEST', '停止证明格式无效') }
const kindFor = command => command.operation === 'cancel' ? 'stopped' : command.operation === 'settle' ? 'settled' : null

export function assertBridgeEventBytes(event) {
  if (bytes({ event }) > MAX_TERMINAL_EVENT_BYTES) throw error('COMMAND_TOO_LARGE', '完整节点回执超过普通传输上限，内容未截断')
  return event
}

export function assertJobStopItem(item, { settled = false } = {}) {
  exact(item, ['jobId', 'workerExit', 'output', 'temporaryFiles'])
  check(jobId(item.jobId) && ['exit_confirmed', 'never_started'].includes(item.workerExit) && ['verified_candidate', 'no_published_output'].includes(item.output))
  if (!settled || item.temporaryFiles !== undefined) {
    check(Array.isArray(item.temporaryFiles) && item.temporaryFiles.length <= 32)
    for (const file of item.temporaryFiles) { exact(file, ['name', 'sizeBytes']); check(typeof file.name === 'string' && file.name.length <= 255 && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0) }
  }
  check(bytes(item) <= MAX_JOB_STOP_ITEM_BYTES)
  return item
}

export function assertTerminalEventEnvelope(event) {
  const stopped = event?.kind === 'stopped', settled = event?.kind === 'settled'
  check(stopped || settled)
  const evidence = stopped ? 'stop_evidence' : 'settle_evidence', jobs = stopped ? 'job_stop_evidence' : 'job_settle_evidence'
  exact(event, ['schema', 'event_id', 'workspace_id', 'kind', ...BINDING_FIELDS, 'input_id', 'instruction_revision', 'observed_revision', 'resource_refs', evidence, jobs, 'payload_digest'])
  assertSealed(event); check(/^[a-f0-9]{32}$/.test(event.event_id)); text(event.workspace_id)
  for (const name of BINDING_FIELDS.filter(name => !['parent_delegation_id', 'session_id', 'execution_epoch'].includes(name))) text(event[name])
  for (const name of ['parent_delegation_id', 'session_id']) if (event[name] !== null) text(event[name])
  check(Number.isSafeInteger(event.execution_epoch) && event.execution_epoch > 0 && Number.isSafeInteger(event.instruction_revision) && event.instruction_revision > 0 && Number.isSafeInteger(event.observed_revision) && event.observed_revision >= 0 && event.observed_revision <= event.instruction_revision)
  if (event.input_id !== null) text(event.input_id)
  check(Array.isArray(event.resource_refs) && event.resource_refs.every(value => typeof value === 'string') && ['idle_after_cancel', 'never_started'].includes(event[evidence]))
  if (event[jobs] !== undefined) {
    check(Array.isArray(event[jobs]) && new Set(event[jobs].map(item => item.jobId)).size === event[jobs].length)
    for (const item of event[jobs]) assertJobStopItem(item, { settled })
  }
  return assertBridgeEventBytes(event)
}

function terminalEvent({ execution, command, evidence, jobEvidence }, upperRevisions = false) {
  assertSealed(command)
  const kind = kindFor(command); check(/^[a-f0-9]{32}$/.test(command.command_id) && kind && (sameBinding(command, execution) || sameBinding(command, execution, { firstSession: true })))
  check(Number.isSafeInteger(command.instruction_revision) && command.instruction_revision > 0 && Number.isSafeInteger(command.observed_revision) && command.observed_revision >= 0 && command.observed_revision <= command.instruction_revision)
  return seal({ schema: SCHEMA, event_id: key('event', command.node_id, command.command_id, kind), workspace_id: command.workspace_id, kind, ...binding(execution),
    input_id: command.input_id, instruction_revision: upperRevisions ? Number.MAX_SAFE_INTEGER : command.instruction_revision, observed_revision: upperRevisions ? Number.MAX_SAFE_INTEGER : command.observed_revision,
    resource_refs: command.resource_refs, [kind === 'stopped' ? 'stop_evidence' : 'settle_evidence']: evidence,
    ...(jobEvidence === undefined && kind === 'stopped' ? {} : { [kind === 'stopped' ? 'job_stop_evidence' : 'job_settle_evidence']: jobEvidence ?? [] }) })
}

// Same fields/key/seal as the Host eventFor path; this creates no persisted fact.
export function buildTerminalEvent(options) { return terminalEvent(options) }

// Inputs are scoped facts from the caller's validated state, never caller claims
// from a model/HTTP body. Unknown legacy Jobs remain debt; no row is rewritten.
export function terminalProofProfile({ execution, commands, preparedJobIds = [], registeredJobs = [], sealedEvents = [] }) {
  check(Array.isArray(commands) && commands.length > 0 && Array.isArray(preparedJobIds) && Array.isArray(registeredJobs) && Array.isArray(sealedEvents))
  check(preparedJobIds.every(jobId) && registeredJobs.every(job => jobId(job.id) && sameBinding(job, execution)))
  const prepared = new Set(preparedJobIds), registered = new Map(registeredJobs.map(job => [job.id, job])), ids = [...new Set([...prepared, ...registered.keys()])]
  const legacyDebt = registeredJobs.some(job => !prepared.has(job.id))
  const jobs = ids.map(id => {
    const job = registered.get(id)
    if (job?.state === 'stopped' && job.stopEvidence) {
      const item = { jobId: id, ...job.stopEvidence }
      try {
        assertJobStopItem(item)
        for (const event of sealedEvents) {
          if (!sameBinding(event, execution) || !['stopped', 'settled'].includes(event.kind)) continue
          assertTerminalEventEnvelope(event)
          if ((event.job_stop_evidence ?? event.job_settle_evidence ?? []).some(value => isDeepStrictEqual(value, item))) return { jobId: id, bytes: bytes(item), source: 'sealed-stopped-item' }
        }
      } catch { /* No valid immutable item: reserve the full supported envelope. */ }
    }
    return { jobId: id, bytes: MAX_JOB_STOP_ITEM_BYTES, source: 'supported-upper-bound' }
  })
  const itemBytes = jobs.reduce((sum, job) => sum + job.bytes, 0) + Math.max(0, jobs.length - 1)
  const profiles = commands.map(command => {
    const event = terminalEvent({ execution, command, evidence: 'idle_after_cancel', jobEvidence: [] }, true)
    try { assertTerminalEventEnvelope(event) } catch (cause) { if (cause.code !== 'COMMAND_TOO_LARGE') throw cause }
    const baseBytes = bytes({ event })
    return { eventId: event.event_id, kind: event.kind, baseBytes, jobCount: jobs.length, bytes: baseBytes + itemBytes, fits: baseBytes + itemBytes <= MAX_TERMINAL_EVENT_BYTES }
  })
  return { fits: !legacyDebt && profiles.every(profile => profile.fits), legacyDebt, jobCount: jobs.length, jobs, profiles, maxBytes: MAX_TERMINAL_EVENT_BYTES }
}

export function assertTerminalProofProfile(options) {
  const profile = terminalProofProfile(options)
  if (!profile.fits) throw Object.assign(error('CAPACITY_EXCEEDED', '当前执行停止证明的空间未获保证，本次生成未受理'), { capacity: { domain: 'terminal-proof', reason: profile.legacyDebt ? 'legacy-proof-debt' : 'terminal-envelope' } })
  return profile
}
