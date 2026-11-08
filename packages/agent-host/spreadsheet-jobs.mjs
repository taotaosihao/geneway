import { assertJobStopItem } from '../agent-contracts/terminal-proof.mjs'
import { assertLocalManualExecution, manualBlocked } from './manual-control.mjs'
import { spreadsheetJobProjection, spreadsheetJobEvent, assertSpreadsheetDeliverySize } from '../agent-contracts/spreadsheet.mjs'
import { fork } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, lstat, open, readFile, readdir, readlink } from 'node:fs/promises'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { binding, digest, error, key, sameBinding } from '../agent-contracts/index.mjs'
import { verifyIncidentSpreadsheet } from '../../src/spreadsheet-verification.mjs'

const states = ['accepted', 'running', 'candidate', 'stopping', 'stopped', 'unknown', 'failed']
const check = (condition, label) => { if (!condition) throw error('INVALID_STATE', `表格 Job 无效：${label}`) }
const immutable = row => ({ ...binding(row), id: row.id, clientRequestId: row.clientRequestId, requestDigest: row.requestDigest, instructionRevision: row.instructionRevision, template: row.template, historyRefs: row.historyRefs, inputDigest: row.inputDigest, input: row.input, ...(row.inputEncodingVersion === 2 ? { inputEncodingVersion: 2 } : {}), outputKind: row.outputKind, acceptedAt: row.acceptedAt })
export function validateSpreadsheetJobs(state) {
  check(Array.isArray(state.jobs) && state.jobs.length <= 10_000 && new Set(state.jobs.map(row => row.id)).size === state.jobs.length, '事务域或 ID')
  check(new Set(state.jobs.map(row => key(...Object.values(binding(row)), row.clientRequestId))).size === state.jobs.length, '受理命令重复')
  check(new Set(state.jobs.map(row => key(...Object.values(binding(row)), row.instructionRevision, row.outputKind))).size === state.jobs.length, '语义输出占用重复')
  for (const row of state.jobs) {
    check(row.id === key('spreadsheet-job', binding(row), row.clientRequestId) && states.includes(row.state) && Number.isSafeInteger(row.sequence) && row.sequence > 0 && row.inputDigest === digest(row.input) && row.instructionRevision === row.input.instructionRevision && row.outputKind === row.input.template.id, '不可变受理事实')
    check(state.executions.some(execution => sameBinding(execution, row)), '执行绑定')
    check(['not_started', 'reserved', 'worker_identified', 'never_started'].includes(row.launchState), '启动事实')
    check(row.worker === null || Number.isSafeInteger(row.worker.pid) && typeof row.worker.startTicks === 'string', 'worker 身份')
    if (row.output) check(row.output.name === 'incident-register.xlsx' && /^[a-f0-9]{64}$/.test(row.output.sha256) && Number.isSafeInteger(row.output.sizeBytes) && row.output.sizeBytes > 0 && row.output.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '输出事实')
  }
}
export function assertSpreadsheetJobsImmutable(before, after) {
  for (const row of before.jobs) {
    const current = after.jobs.find(item => item.id === row.id)
    check(current && isDeepStrictEqual(immutable(row), immutable(current)) && current.sequence >= row.sequence, '受理事实不可改写')
    if (row.workerExitConfirmedAt) check(current.workerExitConfirmedAt === row.workerExitConfirmedAt, 'worker 退出证明不可改写')
    if (row.worker) check(isDeepStrictEqual(row.worker, current.worker), 'worker 身份不可改写')
    if (row.output) check(isDeepStrictEqual(row.output, current.output), '输出不可覆盖')
    if (row.state === 'stopped') check(current.state === row.state && isDeepStrictEqual(current.stopEvidence, row.stopEvidence), '停止后不得重启或改写停止证明')
    if (['failed', 'unknown'].includes(row.state)) check([row.state, 'stopping', 'stopped'].includes(current.state), '不确定或失败后不得重算')
  }
}
function projection(job) {
  return spreadsheetJobProjection(job)
}
export function createSpreadsheetJobs({ journal, root, evidenceService, workspaceId = 'local', nodeId = 'local', clock = () => new Date().toISOString(), forkImpl = fork, fsOps = {}, onError = () => {} }) {
  root = resolve(root)
  const workers = new Map(), active = new Set(), launches = new Map()
  let initialized = false, processing, closed = false
  const directory = job => join(root, job.id)
  function append(state, job) {
    const event = spreadsheetJobEvent(job, workspaceId)
    state.outbox.push({ event, acknowledged: false })
  }
  async function change(id, mutate) {
    await journal.update(state => { const job = state.jobs.find(row => row.id === id); mutate(job); job.sequence++; job.updatedAt = clock(); append(state, job) })
  }
  async function inspectOutput(job) {
    await ensureDirectory(directory(job), fsOps)
    const path = join(directory(job), 'incident-register.xlsx')
    let handle
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 10 * 1024 * 1024) throw error('SPREADSHEET_OUTPUT_INVALID')
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const actual = await handle.stat(); if (actual.ino !== metadata.ino || actual.dev !== metadata.dev) throw error('SPREADSHEET_OUTPUT_INVALID')
      const bytes = await handle.readFile(), verification = await verifyIncidentSpreadsheet(bytes, job.input)
      await handle.sync(); await syncDirectory(directory(job))
      return { name: 'incident-register.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: bytes.length, sha256: verification.sha256 }
    } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause }
    finally { await handle?.close() }
  }
  async function quiesce(job) {
    const worker = workers.get(job.id)
    if (worker) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM')
      let timeout
      await Promise.race([worker.exited, new Promise(resolve => { timeout = setTimeout(resolve, 3000) })]); clearTimeout(timeout)
      if (!worker.closed) worker.child.kill('SIGKILL')
      await worker.exited
      return 'exit_confirmed'
    }
    if (!job.worker) {
      if (['not_started', 'never_started'].includes(job.launchState)) return 'never_started'
      throw error('JOB_PROCESS_UNKNOWN', '旧生成 worker 身份未确认')
    }
    const gone = current => !current || current.state === 'Z' || current.startTicks !== job.worker.startTicks
    const identity = await processIdentity(job.worker.pid, fsOps)
    if (gone(identity)) return 'exit_confirmed'
    try {
      if (await (fsOps.readlink ?? readlink)(`/proc/${job.worker.pid}/cwd`) !== directory(job) || !(await (fsOps.readFile ?? readFile)(`/proc/${job.worker.pid}/cmdline`, 'utf8')).includes('spreadsheet-worker.mjs')) throw error('JOB_PROCESS_UNKNOWN')
    } catch (cause) {
      if (['ENOENT', 'ESRCH'].includes(cause.code) && gone(await processIdentity(job.worker.pid, fsOps))) return 'exit_confirmed'
      throw cause
    }
    try { process.kill(job.worker.pid, 'SIGTERM') } catch (cause) { if (cause.code !== 'ESRCH') throw cause }
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) { const current = await processIdentity(job.worker.pid, fsOps); if (!current || current.state === 'Z' || current.startTicks !== job.worker.startTicks) return 'exit_confirmed'; await new Promise(resolve => setTimeout(resolve, 20)) }
    try { process.kill(job.worker.pid, 'SIGKILL') } catch (cause) { if (cause.code !== 'ESRCH') throw cause }
    while (true) { const current = await processIdentity(job.worker.pid, fsOps); if (!current || current.state === 'Z' || current.startTicks !== job.worker.startTicks) return 'exit_confirmed'; await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  async function preserveWorkerExit(job, workerExit) {
    if (workerExit === 'exit_confirmed' && !job.workerExitConfirmedAt) await journal.update(state => { state.jobs.find(row => row.id === job.id).workerExitConfirmedAt ??= clock() })
  }
  async function calibrate(job, stopped = false) {
    const workerExit = await quiesce(job)
    // Keep an observed exit even when files cannot support a valid stop proof.
    await preserveWorkerExit(job, workerExit)
    const output = await inspectOutput(job)
    const temporaryFiles = []
    for (const name of await readdir(directory(job))) if (name !== 'incident-register.xlsx') { const stat = await lstat(join(directory(job), name)); if (!stat.isFile() || stat.isSymbolicLink()) throw error('SPREADSHEET_OUTPUT_INVALID'); temporaryFiles.push({ name, sizeBytes: stat.size }) }
    if (stopped) assertJobStopItem({ jobId: job.id, workerExit, output: output ? 'verified_candidate' : 'no_published_output', temporaryFiles })
    await change(job.id, current => {
      if (output) current.output = output
      if (workerExit === 'exit_confirmed') current.workerExitConfirmedAt ??= clock()
      current.state = stopped ? 'stopped' : output ? 'candidate' : 'unknown'
      current.reason = stopped ? null : output ? null : 'SPREADSHEET_EXECUTION_UNCONFIRMED'
      if (stopped) current.stopEvidence = { workerExit, output: output ? 'verified_candidate' : 'no_published_output', temporaryFiles }
    })
  }
  async function launch(job) {
    try {
      assertLocalManualExecution(await journal.read(), job)
      await evidenceService.revalidate(job, job.input)
      await ensureDirectory(directory(job), fsOps)
      await evidenceService.revalidate(job, job.input)
    } catch (cause) {
      if (cause.retryableConnection || ['MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'MANUAL_RESUME_PENDING'].includes(cause.code)) return
      await change(job.id, current => { current.launchState = 'never_started'; if (!['stopping', 'stopped'].includes(current.state)) current.state = 'failed'; current.reason = cause.code ?? 'SPREADSHEET_NOT_STARTED' })
      return
    }
    let permitted = false
    await journal.update(state => {
      const current = state.jobs.find(row => row.id === job.id), execution = state.executions.find(row => row.launch_id === job.launch_id)
      if (manualBlocked(state, job)) return
      if (current.state !== 'accepted' || current.launchState !== 'not_started' || !execution || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(execution.status)) return
      current.state = 'running'; current.launchState = 'reserved'; current.sequence++; current.updatedAt = clock(); append(state, current); permitted = true
    })
    if (!permitted) return
    const latest = await journal.read(), current = latest.jobs.find(row => row.id === job.id), execution = latest.executions.find(row => row.launch_id === job.launch_id)
    if (manualBlocked(latest, job)) { await change(job.id, row => { if (row.state === 'running' && !row.worker) { row.state = 'accepted'; row.launchState = 'not_started' } }); return }
    if (current.state !== 'running' || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(execution.status)) {
      await change(job.id, row => { row.launchState = 'never_started' })
      return
    }

    const child = forkImpl(fileURLToPath(new URL('./spreadsheet-worker.mjs', import.meta.url)), [], { cwd: directory(job), env: { PATH: process.env.PATH, HOME: directory(job), LANG: 'C.UTF-8' }, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' })
    const worker = { child, result: null }
    worker.exited = new Promise(resolve => { child.once('close', () => { worker.closed = true; resolve() }); child.once('error', () => { child.kill('SIGKILL') }) })
    workers.set(job.id, worker)
    child.on('message', message => { if (message?.jobId === job.id && ['candidate', 'failed'].includes(message.kind)) worker.result = message })
    const identity = await processIdentity(child.pid)
    if (!identity) throw error('SPREADSHEET_EXECUTION_UNCONFIRMED')
    await change(job.id, current => { current.worker = { pid: child.pid, startTicks: identity.startTicks }; current.startedAt = clock(); current.launchState = 'worker_identified' })
    const beforeSend = await journal.read()
    if (beforeSend.jobs.find(row => row.id === job.id).state !== 'running' || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(beforeSend.executions.find(row => row.launch_id === job.launch_id).status)) return
    child.send({ operation: 'generate', jobId: job.id, directory: directory(job), input: job.input })
    const completion = worker.exited.then(async () => {
      const current = (await journal.read()).jobs.find(row => row.id === job.id)
      if (current.state !== 'running') return
      const output = await inspectOutput(current)
      await change(job.id, row => { if (row.state !== 'running') return; row.workerExitConfirmedAt ??= clock(); row.output = output; row.state = output ? 'candidate' : 'unknown'; row.reason = output ? null : worker.result?.code ?? 'SPREADSHEET_EXECUTION_UNCONFIRMED' })
    }).catch(async cause => { await change(job.id, current => { if (current.state !== 'stopping' && current.state !== 'stopped') { current.state = 'unknown'; current.reason = cause.code ?? 'SPREADSHEET_OUTPUT_INVALID' } }) }).finally(() => active.delete(completion))
    active.add(completion)
  }
  async function initialize() {
    if (initialized) return
    for (const job of (await journal.read()).jobs.filter(job => ['running', 'stopping'].includes(job.state))) {
      try { await calibrate(job, job.state === 'stopping') }
      catch (cause) { await change(job.id, current => { current.state = 'unknown'; current.reason = cause.code ?? 'SPREADSHEET_EXECUTION_UNCONFIRMED' }) }
    }
    initialized = true
  }
  const api = {
    async start(execution, parameters, { beforeAccept } = {}) {
      if (closed) throw error('INVALID_STATE')
      await initialize()
      if (typeof parameters?.clientRequestId !== 'string') throw error('INVALID_REQUEST')
      const id = key('spreadsheet-job', binding(execution), parameters.clientRequestId), prior = (await journal.read()).jobs.find(job => job.id === id)
      if (prior) { await evidenceService.authorize(execution); if (prior.requestDigest !== digest(parameters)) throw error('IDEMPOTENCY_CONFLICT'); return projection(prior) }
      const prepared = await evidenceService.prepare(execution, parameters)
      if (prepared.input.inputEncodingVersion === 2) assertSpreadsheetDeliverySize(execution, parameters, prepared, workspaceId)
      let result
      await journal.update(async state => {
        assertLocalManualExecution(state, execution)
        const old = state.jobs.find(job => job.id === id)
        if (old) { if (old.requestDigest !== digest(parameters)) throw error('IDEMPOTENCY_CONFLICT'); result = old; return }
        await evidenceService.revalidate(execution, prepared.input)
        beforeAccept?.(state)
        if (state.jobs.some(job => sameBinding(job, execution) && job.instructionRevision === prepared.input.instructionRevision && job.outputKind === prepared.input.template.id)) throw error('IDEMPOTENCY_CONFLICT', '本版本整改表已有生成请求')
        result = { id, ...binding(execution), clientRequestId: prepared.clientRequestId, requestDigest: digest(parameters), instructionRevision: prepared.input.instructionRevision, template: prepared.input.template, historyRefs: prepared.input.historyRefs, inputDigest: prepared.inputDigest, input: prepared.input, ...(prepared.input.inputEncodingVersion === 2 ? { inputEncodingVersion: 2 } : {}), outputKind: prepared.input.template.id, state: 'accepted', sequence: 1, acceptedAt: clock(), updatedAt: clock(), startedAt: null, worker: null, output: null, reason: null, stopEvidence: null, launchState: 'not_started' }
        state.jobs.push(result); append(state, result)
      })
      queueMicrotask(() => { api.process().catch(onError) })
      return projection(result)
    },
    async readEvidence(execution, parameters) { return evidenceService.readEvidence(execution, parameters) },
    async get(execution, parameters) {
      if (!parameters || Object.keys(parameters).join(',') !== 'jobId' || typeof parameters.jobId !== 'string') throw error('INVALID_REQUEST')
      const job = (await journal.read()).jobs.find(job => job.id === parameters.jobId && sameBinding(job, execution))
      if (!job) throw error('NOT_FOUND')
      await evidenceService.authorize(execution)
      const result = projection(job)
      if (job.input.sourceManifest && job.state === 'candidate' && evidenceService.candidateReceipt) result.candidate = await evidenceService.candidateReceipt(execution, job.id)
      return result
    },
    process() {
      if (closed) return Promise.resolve()
      return processing ??= (async () => {
        await initialize()
        for (const job of (await journal.read()).jobs.filter(job => job.state === 'accepted')) {
          const operation = Promise.resolve().then(() => launch(job)); launches.set(job.id, operation)
          try { await operation } catch (cause) { await change(job.id, current => { if (!['stopping', 'stopped'].includes(current.state)) { current.state = 'unknown'; current.reason = cause.code ?? 'SPREADSHEET_EXECUTION_UNCONFIRMED' } }) }
          finally { if (launches.get(job.id) === operation) launches.delete(job.id) }
        }
      })().finally(() => { processing = undefined })
    },
    async stopExecution(execution) {
      await initialize()
      const evidence = []
      for (const job of (await journal.read()).jobs.filter(job => sameBinding(job, execution))) {
        if (job.state === 'stopped') { evidence.push(assertJobStopItem({ jobId: job.id, ...job.stopEvidence })); continue }
        await change(job.id, current => { current.state = 'stopping' })
        await launches.get(job.id)?.catch(() => {})
        const currentJob = (await journal.read()).jobs.find(row => row.id === job.id)
        await calibrate(currentJob, true)
        const current = (await journal.read()).jobs.find(row => row.id === job.id)
        evidence.push(assertJobStopItem({ jobId: job.id, ...current.stopEvidence }))
      }
      return evidence
    },
    async settleExecution(execution) {
      await initialize()
      const evidence = []
      for (const job of (await journal.read()).jobs.filter(row => sameBinding(row, execution))) {
        if (['accepted', 'running', 'stopping', 'unknown'].includes(job.state)) throw error('JOBS_PENDING')
        const workerExit = await quiesce(job)
        await preserveWorkerExit(job, workerExit)
        const output = await inspectOutput(job)
        if (!isDeepStrictEqual(output, job.output)) throw error('SPREADSHEET_OUTPUT_INVALID')
        evidence.push(assertJobStopItem({ jobId: job.id, workerExit, output: output ? 'verified_candidate' : 'no_published_output' }, { settled: true }))
      }
      return evidence
    },
    async close() {
      closed = true; await processing
      for (const job of (await journal.read()).jobs.filter(job => job.state === 'running')) { await quiesce(job); const current = (await journal.read()).jobs.find(row => row.id === job.id); if (current.state === 'running') await calibrate(current) }
      await Promise.all([...active])
    },
    async readCandidate(id) { const job = (await journal.read()).jobs.find(row => row.id === id); if (!job || !job.output) throw error('NOT_FOUND'); const actual = await inspectOutput(job); if (!isDeepStrictEqual(actual, job.output)) throw error('SPREADSHEET_OUTPUT_INVALID'); const path = join(directory(job), 'incident-register.xlsx'), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const bytes = await handle.readFile(); if (bytes.length !== actual.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== actual.sha256) throw error('SPREADSHEET_OUTPUT_INVALID'); return { job: projection(job), path, bytes } } finally { await handle.close() } },
  }
  return api
}
async function processIdentity(pid, operations = {}) { try { const raw = await (operations.readFile ?? readFile)(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' '); return { state: fields[0], startTicks: fields[19] } } catch (cause) { if (['ENOENT', 'ESRCH'].includes(cause.code)) return null; throw cause } }
async function syncDirectory(path) { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
async function ensureDirectory(path, fsOps = {}) {
  const io = { lstat, mkdir, ...fsOps }
  let cursor = sep
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part); let created = false
    try { await io.lstat(cursor) } catch (cause) { if (cause.code !== 'ENOENT') throw cause; try { await io.mkdir(cursor, { mode: 0o700 }) } catch (other) { if (other.code !== 'EEXIST') throw other }; created = true }
    const stat = await io.lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('SPREADSHEET_OUTPUT_INVALID', 'Job 目录不安全')
    if (created) await syncDirectory(dirname(cursor))
  }
}
