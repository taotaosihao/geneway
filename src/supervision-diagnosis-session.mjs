import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateModelSnapshot } from './model-route.mjs'
import { SUPERVISION_DIAGNOSIS_LIMITS } from './supervision-diagnosis-state.mjs'

const workerPath = fileURLToPath(new URL('./supervision-diagnosis-worker.mjs', import.meta.url))
const failure = (code, evidence = {}) => Object.assign(new Error(code), { code, ...evidence })
async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid)) return null
  try { const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' '); return { pid, startTicks: fields[19] } }
  catch (cause) { if (['ENOENT', 'ESRCH'].includes(cause.code)) return null; throw cause }
}
async function privateDirectory(path, recursive = false) {
  await mkdir(path, { recursive, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid() || await realpath(path) !== path) throw failure('DIAGNOSIS_ROOT_INVALID')
}

// A private child confines SDK process-wide boot state; it is not an OS sandbox.
export function createSupervisionDiagnosisSessions({ root, gatewayOrigin }) {
  if (process.platform !== 'linux' || !isAbsolute(root ?? '') || resolve(root) !== root) throw failure('DIAGNOSIS_ROOT_INVALID')
  const gateway = new URL(gatewayOrigin)
  if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash) throw failure('DIAGNOSIS_GATEWAY_INVALID')
  const active = new Set()
  let closing = false
  async function run({ diagnosisId, sessionId, modelSnapshot, token, packet, deadlineAt }) {
    if (closing) throw failure('DIAGNOSIS_SESSIONS_CLOSED')
    if (![diagnosisId, sessionId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')) || typeof token !== 'string' || !token || token.length > 8192 || !packet || typeof packet !== 'object' || Array.isArray(packet)) throw failure('DIAGNOSIS_RUN_INVALID')
    validateModelSnapshot(modelSnapshot)
    const deadline = typeof deadlineAt === 'string' ? Date.parse(deadlineAt) : NaN, remaining = deadline - Date.now()
    if (!Number.isFinite(deadline) || remaining <= 0 || remaining > SUPERVISION_DIAGNOSIS_LIMITS.timeoutMs) throw failure('DIAGNOSIS_DEADLINE_INVALID')
    if (Buffer.byteLength(JSON.stringify(packet)) > SUPERVISION_DIAGNOSIS_LIMITS.maxBodyBytes) throw failure('DIAGNOSIS_PACKET_TOO_LARGE')
    await privateDirectory(root, true)
    const directory = join(root, createHash('sha256').update(sessionId).digest('hex'))
    // Existing session directories are retained and never silently replaced or retried.
    await privateDirectory(directory)
    const cwd = join(directory, 'workspace'), home = join(directory, 'home'), dshHome = join(directory, 'dsh')
    for (const path of [cwd, home, dshHome]) await privateDirectory(path)
    if (closing || Date.now() >= deadline) throw failure(closing ? 'DIAGNOSIS_SESSIONS_CLOSED' : 'DIAGNOSIS_TIMEOUT')
    const child = fork(workerPath, [], { cwd, execArgv: [], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: 'true', GENEWAY_DIAGNOSIS_GATEWAY: gateway.origin }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let result, remoteError, cancelled, exitAt, stopping
    child.on('error', () => { remoteError = { code: 'DIAGNOSIS_CHILD_UNAVAILABLE' } })
    const ended = new Promise(done => { child.once('exit', () => { exitAt = new Date().toISOString() }); child.once('close', (code, signal) => done({ code, signal })) })
    child.on('message', message => {
      if (message?.kind === 'diagnosis-result') result = message.value
      if (message?.kind === 'diagnosis-error') remoteError = { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(message.code ?? '') ? message.code : 'DIAGNOSIS_SESSION_FAILED', stage: message.stage, tail: message.tail }
    })
    let identity
    async function stop(code) {
      cancelled ??= code
      return stopping ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          if (child.connected) child.send({ kind: 'cancel' }, () => {})
          if (identity && (await processIdentity(identity.pid))?.startTicks === identity.startTicks) child.kill('SIGTERM')
          let timer
          await Promise.race([ended, new Promise(done => { timer = setTimeout(done, 1500) })]); clearTimeout(timer)
          if (child.exitCode === null && child.signalCode === null && identity && (await processIdentity(identity.pid))?.startTicks === identity.startTicks) child.kill('SIGKILL')
        }
        await ended
      })()
    }
    const item = { stop }; active.add(item)
    const timer = setTimeout(() => { void stop('DIAGNOSIS_TIMEOUT') }, Math.max(1, deadline - Date.now()))
    try {
      identity = await processIdentity(child.pid)
      if (!identity) { await stop('DIAGNOSIS_CHILD_UNAVAILABLE'); throw failure('DIAGNOSIS_CHILD_UNAVAILABLE') }
      if (closing) await stop('DIAGNOSIS_SESSIONS_CLOSED')
      else child.send({ kind: 'diagnose', diagnosisId, sessionId, modelSnapshot, token, packet, deadlineAt }, cause => { if (cause) void stop('DIAGNOSIS_IPC_UNAVAILABLE') })
      const exited = await ended
      const current = await processIdentity(identity.pid)
      if (current?.startTicks === identity.startTicks) throw failure('DIAGNOSIS_CHILD_NOT_GONE', { childIdentity: identity })
      const childIdentity = { ...identity, cwd, home, dshHome, exitAt, code: exited.code, signal: exited.signal, gone: true }
      if (cancelled) throw failure(cancelled, { childIdentity })
      if (remoteError || exited.code !== 0 || exited.signal) throw failure(remoteError?.code ?? 'DIAGNOSIS_SESSION_FAILED', { stage: remoteError?.stage, tail: remoteError?.tail, childIdentity })
      if (!result || result.sessionId !== sessionId || result.diagnosisId !== diagnosisId || typeof result.text !== 'string' || !result.text || result.tail?.reason?.kind !== 'completed' || result.tail.toolCalls !== 0 || result.tail.requestCount !== 1) throw failure('DIAGNOSIS_RESULT_UNCONFIRMED', { childIdentity })
      return { sessionId, text: result.text, tail: result.tail, childIdentity, history: result.history }
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) await stop('DIAGNOSIS_SESSION_FAILED'); active.delete(item) }
  }
  return { run, async close() { closing = true; await Promise.all([...active].map(item => item.stop('DIAGNOSIS_SESSIONS_CLOSED'))) } }
}
