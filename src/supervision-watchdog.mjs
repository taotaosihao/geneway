import { readFile, mkdir, open, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digest, key } from '../packages/agent-contracts/index.mjs'

const failureCode = cause => cause.name === 'TimeoutError' ? 'HTTP_TIMEOUT' : typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code) ? cause.code : 'HTTP_UNAVAILABLE'

export async function observeProcess({ name, pid, startTicks, nodeId }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(String(startTicks))) throw new Error('监督进程身份必须包含PID和startTicks')
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '), current = fields[19]
    return { name, nodeId: nodeId ?? null, pid, expectedStartTicks: String(startTicks), startTicks: current, osState: fields[0], observation: current !== String(startTicks) ? 'identity_changed' : fields[0] === 'Z' ? 'exited' : ['T', 't'].includes(fields[0]) ? 'stopped' : 'present' }
  } catch (cause) { return { name, nodeId: nodeId ?? null, pid, expectedStartTicks: String(startTicks), startTicks: null, osState: null, observation: ['ENOENT', 'ESRCH'].includes(cause.code) ? 'exited' : 'unavailable' } }
}
async function persist(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + process.pid + '.tmp', handle = await open(temporary, 'w', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r'); try { await directory.sync() } finally { await directory.close() }
}
export async function createSupervisionWatchdog(config, { fetchImpl = fetch, clock = () => Date.now() } = {}) {
  const url = new URL(config.origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('监督入口必须是HTTPS或本机loopback')
  for (const field of ['intervalMs', 'timeoutMs', 'stageDeadlineMs']) if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error('监督采样/超时/阶段期限须显式配置')
  const token = (await readFile(config.credentialFile, 'utf8')).trim(), recoveryToken = config.recoveryCredentialFile ? (await readFile(config.recoveryCredentialFile, 'utf8')).trim() : null
  const diagnosisToken = config.diagnosisCredentialFile ? (await readFile(config.diagnosisCredentialFile, 'utf8')).trim() : null
  if (diagnosisToken !== null && (diagnosisToken.length < 24 || diagnosisToken === token || diagnosisToken === recoveryToken)) throw new Error('监督诊断凭据须独立')
  if (token.length < 24 || recoveryToken && recoveryToken === token) throw new Error('监督观察与处置凭据须独立')
  const path = join(resolve(config.root), 'watchdog-state.json'); let state
  try { state = JSON.parse(await readFile(path, 'utf8')) } catch (cause) { if (cause.code !== 'ENOENT') throw cause; state = { version: 1, lastSnapshot: null, lastSuccessAt: null, stale: true, currentBusiness: 'unknown', episodes: [], samples: [] } }
  if (state.version !== 1 || !Array.isArray(state.episodes)) throw new Error('监督器本地记录无效')
  let closed = false, timer, running
  const scopeFor = attempt => attempt ? { workId: attempt.binding.work_id, attemptId: attempt.binding.attempt_id, nodeId: attempt.binding.node_id, nodeInstanceId: attempt.nodeInstanceId } : config.scope
  async function request(pathname, body, credential = token) {
    const response = await fetchImpl(new URL(pathname, url), { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + credential, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(config.timeoutMs) })
    const value = await response.json()
    if (!response.ok) throw Object.assign(new Error('监督请求未完成'), { code: value.error?.code ?? 'HTTP_UNAVAILABLE' })
    return value
  }
  function episode(classification, scope, checkpointAt, factRefs, code, now, discriminator = '') {
    if (!scope) return null
    const id = key('supervision-episode', classification, scope, checkpointAt, discriminator), old = state.episodes.find(row => row.id === id)
    if (old) { old.finding.lastObservedAt = now; return old }
    const row = { id, finding: { episodeId: id, scope, classification, firstObservedAt: now, lastObservedAt: now, checkpointAt, factRefs: factRefs.slice(-16), code }, submittedAt: null, actionAttemptedAt: null, action: null }
    state.episodes.push(row); return row
  }
  async function sample() {
    const now = new Date(clock()).toISOString(), processes = await Promise.all((config.processes ?? []).map(observeProcess)); let snapshot, unavailable = null
    try { snapshot = await request('/internal/supervision/snapshot'); state.lastSnapshot = snapshot; state.lastSuccessAt = now; state.stale = false; state.currentBusiness = 'observed' }
    catch (cause) { unavailable = failureCode(cause); state.stale = true; state.currentBusiness = 'unknown' }
    const fallback = scopeFor(state.lastSnapshot?.attempts?.find(row => !row.waits.includes('TERMINAL'))) ?? config.scope
    if (unavailable) {
      state.unavailableSince ??= now
      episode(unavailable === 'STORE_UNAVAILABLE' ? 'STORAGE_UNRELIABLE' : 'API_UNREACHABLE', fallback, state.lastSuccessAt, [], unavailable, now, state.unavailableSince)
    } else state.unavailableSince = null
    for (const process of processes) if (['stopped', 'exited', 'identity_changed'].includes(process.observation)) {
      const localScope = process.nodeId ? scopeFor(state.lastSnapshot?.attempts.find(row => row.binding.node_id === process.nodeId)) ?? { workId: null, attemptId: null, nodeId: process.nodeId, nodeInstanceId: null } : fallback
      episode(({ stopped: 'PROCESS_STOPPED', exited: 'PROCESS_EXITED', identity_changed: 'PROCESS_IDENTITY_CHANGED' })[process.observation], localScope, null, [], null, now, `${process.pid}:${process.expectedStartTicks}`)
    }
    const recoveries = []
    if (snapshot) for (const attempt of snapshot.attempts) {
      const scope = scopeFor(attempt), knownWaiting = attempt.waits.length > 0, at = attempt.checkpointAt ?? attempt.startedAt
      if (!knownWaiting && !attempt.connection) episode('HOST_UNREACHABLE', scope, at, [], null, now)
      if (!knownWaiting && at && clock() - Date.parse(at) > (attempt.jobs.some(job => ['running', 'stopping'].includes(job.state)) ? config.jobDeadlineMs ?? config.stageDeadlineMs : config.stageDeadlineMs)) episode('STAGE_STALLED', scope, at, attempt.factRefs.map(row => row.id), null, now)
      const codes = new Map(); for (const item of attempt.errors) { const ids = codes.get(item.code) ?? new Set(); ids.add(item.id); codes.set(item.code, ids) }
      for (const [code, ids] of codes) if (ids.size >= (config.repeatedErrorCount ?? 3)) episode('REPEATED_ERROR', scope, at, [...ids], code, now)
      const baselineKey = digest([attempt.binding, attempt.instructionRevision])
      state.budgetBaselines ??= {}; let baseline = state.budgetBaselines[baselineKey]
      if (!baseline || baseline.checkpointId !== attempt.checkpointId) baseline = state.budgetBaselines[baselineKey] = { checkpointId: attempt.checkpointId, requests: attempt.modelAccounting.requests }
      if (!knownWaiting && attempt.modelAccounting.requests - baseline.requests >= (config.budgetWithoutProgressRequests ?? 3)) episode('BUDGET_WITHOUT_PROGRESS', scope, at, [], null, now)
      for (const command of snapshot.pendingCommands.filter(command => command.binding.attempt_id === attempt.binding.attempt_id)) {
        if (knownWaiting || attempt.modelAccounting.unknown.length || !command.sent || !command.generation || !['launch', 'deliver'].includes(command.operation) || clock() - Date.parse(command.createdAt) < (config.commandDeadlineMs ?? config.stageDeadlineMs)) continue
        const row = episode('COMMAND_UNACKNOWLEDGED', scope, at, [command.commandId], null, now, command.commandId)
        if (row && recoveryToken && !row.actionAttemptedAt && processes.every(process => process.observation === 'present')) recoveries.push({ row, command })
      }
    }
    state.processes = processes; state.sampledAt = now
    state.samples.push({ sampledAt: now, stale: state.stale, currentBusiness: state.currentBusiness, lastSuccessAt: state.lastSuccessAt, processObservations: processes.map(row => ({ name: row.name, observation: row.observation, osState: row.osState })) }); state.samples = state.samples.slice(-32)
    await persist(path, state)
    if (!unavailable) {
      for (const row of state.episodes.filter(row => !row.submittedAt || row.lastSubmittedObservedAt !== row.finding.lastObservedAt)) {
        try { const receipt = await request('/internal/supervision/findings', row.finding); row.submittedAt ??= new Date(clock()).toISOString(); row.findingId = receipt.finding.id; row.lastSubmittedObservedAt = row.finding.lastObservedAt; delete row.submitError; await persist(path, state) } catch (cause) { row.submitError = failureCode(cause) }
      }
      if (diagnosisToken) for (const row of state.episodes) {
        if (!row.findingId || !row.submittedAt || row.diagnosisAttemptedAt || row.diagnosisAdmission?.notBefore && clock() < Date.parse(row.diagnosisAdmission.notBefore) || state.episodes.some(other => other !== row && other.findingId === row.findingId && other.diagnosisAttemptedAt) || !['STAGE_STALLED', 'REPEATED_ERROR', 'BUDGET_WITHOUT_PROGRESS'].includes(row.finding.classification)) continue
        // Persist before sending: an uncertain response must not trigger another diagnosis.
        row.diagnosisAttemptedAt = new Date(clock()).toISOString(); delete row.diagnosisAdmission; await persist(path, state)
        try {
          const receipt = await request('/internal/supervision/diagnose', { findingId: row.findingId }, diagnosisToken)
          if (receipt.findingId !== row.findingId) throw Object.assign(new Error('监督诊断响应无效'), { code: 'INVALID_RESPONSE' })
          if (receipt.admitted === false && Object.keys(receipt).every(name => ['findingId', 'admitted', 'state', 'reason', 'notBefore'].includes(name)) && receipt.state === 'not_admitted' && typeof receipt.reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(receipt.reason) && (receipt.notBefore === null || typeof receipt.notBefore === 'string' && Number.isFinite(Date.parse(receipt.notBefore)) && new Date(receipt.notBefore).toISOString() === receipt.notBefore)) {
            row.diagnosisAdmission = { state: 'not_admitted', reason: receipt.reason, notBefore: receipt.notBefore }
            delete row.diagnosisAttemptedAt; delete row.diagnosisError
          } else {
            if (receipt.admitted !== true || typeof receipt.diagnosis?.id !== 'string' || typeof receipt.diagnosis?.state !== 'string' || receipt.diagnosis.id.length > 256 || receipt.diagnosis.state.length > 64) throw Object.assign(new Error('监督诊断响应无效'), { code: 'INVALID_RESPONSE' })
            row.diagnosis = { id: receipt.diagnosis.id, state: receipt.diagnosis.state }
          }
        } catch (cause) { row.diagnosisError = failureCode(cause) }
        await persist(path, state)
      }
      for (const { row, command } of recoveries) if (row.submittedAt) {
        row.actionAttemptedAt = new Date(clock()).toISOString(); await persist(path, state)
        try { row.action = await request('/internal/supervision/reoffer', { episodeId: row.id, commandId: command.commandId, payloadDigest: command.payloadDigest, generation: command.generation, nodeInstanceId: command.nodeInstanceId }, recoveryToken) } catch (cause) { row.actionError = failureCode(cause) }
      }
      await persist(path, state)
    }
    return structuredClone(state)
  }
  function tick() { if (closed || running) return running; running = sample().finally(() => { running = null }); return running }
  return { sample: tick, statePath: path, start() { if (timer) return; timer = setInterval(() => { void tick().catch(cause => console.error('监督采样未持久完成', cause.code ?? 'LOCAL_STORAGE_UNAVAILABLE')) }, config.intervalMs); void tick().catch(cause => console.error('监督采样未持久完成', cause.code ?? 'LOCAL_STORAGE_UNAVAILABLE')) }, async close() { closed = true; clearInterval(timer); await running } }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8')), watchdog = await createSupervisionWatchdog(config)
  const close = async () => { await watchdog.close(); process.exit(0) }
  process.once('SIGTERM', close); process.once('SIGINT', close); watchdog.start()
}
