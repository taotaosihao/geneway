import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readlink, readdir, lstat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const exec = promisify(execFile)
let clockTicks
async function clockTicksPerSecond() {
  clockTicks ??= exec('getconf', ['CLK_TCK']).then(({ stdout }) => {
    const value = Number(stdout.trim())
    if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid OS CLK_TCK')
    return value
  })
  return clockTicks
}
function processStat(text) {
  const close = text.lastIndexOf(') ')
  if (close < 0) throw Error('Malformed /proc stat')
  const fields = text.slice(close + 2).trim().split(/\s+/)
  if (fields.length < 22) throw Error('Incomplete /proc stat')
  return { state: fields[0], parentPid: Number(fields[1]), processGroupId: Number(fields[2]),
    userTicks: fields[11], systemTicks: fields[12], threads: Number(fields[17]), startTicks: fields[19] }
}
const unavailable = cause => ({ available: false, reason: cause.code ?? cause.name })

// 读取目标PID两次身份，不把PID复用或采样途中退出解释成同进程资源下降。
export async function measureProcess(pid, { expectedStartTicks } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('pid must be a positive integer')
  const sampledAt = new Date().toISOString(), root = `/proc/${pid}`
  let first
  try { first = processStat(await readFile(join(root, 'stat'), 'utf8')) }
  catch (cause) { if (['ENOENT', 'ESRCH'].includes(cause.code)) return { sampledAt, pid, available: false, reason: 'PROCESS_EXITED' }; throw cause }
  if (expectedStartTicks !== undefined && String(expectedStartTicks) !== first.startTicks) return { sampledAt, pid, available: false, reason: 'PID_REUSED', expectedStartTicks: String(expectedStartTicks), actualStartTicks: first.startTicks }
  const [statusResult, ioResult, exeResult, hz] = await Promise.all([
    readFile(join(root, 'status'), 'utf8').then(value => ({ value }), unavailable),
    readFile(join(root, 'io'), 'utf8').then(value => ({ value }), unavailable),
    readlink(join(root, 'exe')).then(value => ({ value }), unavailable), clockTicksPerSecond(),
  ])
  let second
  try { second = processStat(await readFile(join(root, 'stat'), 'utf8')) }
  catch (cause) { if (['ENOENT', 'ESRCH'].includes(cause.code)) return { sampledAt, pid, available: false, reason: 'PROCESS_EXITED_DURING_SAMPLE', startTicks: first.startTicks }; throw cause }
  if (second.startTicks !== first.startTicks) return { sampledAt, pid, available: false, reason: 'PID_REUSED_DURING_SAMPLE', expectedStartTicks: first.startTicks, actualStartTicks: second.startTicks }
  const statusBytes = name => { const value = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(statusResult.value ?? ''); return value ? Number(value[1]) * 1024 : null }
  const ioCounter = name => { const value = new RegExp(`^${name}:\\s+(\\d+)$`, 'm').exec(ioResult.value ?? ''); return value ? value[1] : null }
  return { sampledAt, pid, available: true, startTicks: first.startTicks, state: second.state,
    parentPid: second.parentPid, processGroupId: second.processGroupId, threads: second.threads,
    executable: exeResult.value ?? exeResult,
    cpu: { userTicks: second.userTicks, systemTicks: second.systemTicks, clockTicksPerSecond: hz },
    memory: { rssBytes: statusBytes('VmRSS'), highWaterBytes: statusBytes('VmHWM'), unavailable: statusResult.value === undefined ? statusResult : null },
    io: ioResult.value === undefined ? ioResult : { available: true, readBytes: ioCounter('read_bytes'), writeBytes: ioCounter('write_bytes'), readChars: ioCounter('rchar'), writeChars: ioCounter('wchar') } }
}

export function processDelta(before, after) {
  if (!before.available || !after.available || before.pid !== after.pid || before.startTicks !== after.startTicks) return { available: false, reason: 'PROCESS_IDENTITY_NOT_CONTINUOUS' }
  const elapsedMs = Date.parse(after.sampledAt) - Date.parse(before.sampledAt)
  if (elapsedMs <= 0 || before.cpu.clockTicksPerSecond !== after.cpu.clockTicksPerSecond) return { available: false, reason: 'INVALID_SAMPLE_INTERVAL' }
  const ticks = BigInt(after.cpu.userTicks) + BigInt(after.cpu.systemTicks) - BigInt(before.cpu.userTicks) - BigInt(before.cpu.systemTicks)
  if (ticks < 0n) return { available: false, reason: 'CPU_COUNTER_REGRESSED' }
  const cpuSeconds = Number(ticks) / after.cpu.clockTicksPerSecond
  const counterDelta = name => before.io.available && after.io.available && before.io[name] !== null && after.io[name] !== null ? (BigInt(after.io[name]) - BigInt(before.io[name])).toString() : null
  return { available: true, pid: after.pid, startTicks: after.startTicks, elapsedMs, cpuSeconds,
    cpuPercentOneCore: cpuSeconds / (elapsedMs / 1000) * 100,
    rssBytesBefore: before.memory.rssBytes, rssBytesAfter: after.memory.rssBytes,
    readBytes: counterDelta('readBytes'), writeBytes: counterDelta('writeBytes') }
}

// 所有给定root都完整计入；不忽略node_modules/venv/sidecar，不追随符号链接。
export async function snapshotTree(root) {
  root = resolve(root)
  const files = [], errors = [], seen = new Set()
  let logicalBytes = 0, allocatedBytes = 0, directories = 0, symlinks = 0
  async function visit(path) {
    let stat
    try { stat = await lstat(path) } catch (cause) { errors.push({ path: relative(root, path) || '.', reason: cause.code ?? cause.name }); return }
    if (stat.isSymbolicLink()) {
      symlinks++; const target = await readlink(path), resolvedTarget = resolve(dirname(path), target)
      files.push({ path: relative(root, path), kind: 'symlink', target, resolvedTarget, outsideRoot: resolvedTarget !== root && !resolvedTarget.startsWith(root + sep), logicalBytes: stat.size }); return
    }
    if (stat.isDirectory()) {
      directories++
      let entries
      try { entries = await readdir(path) } catch (cause) { errors.push({ path: relative(root, path) || '.', reason: cause.code ?? cause.name }); return }
      for (const entry of entries.sort()) await visit(join(path, entry))
      return
    }
    if (!stat.isFile()) { files.push({ path: relative(root, path), kind: 'special' }); return }
    const identity = `${stat.dev}:${stat.ino}`, duplicateHardlink = seen.has(identity)
    seen.add(identity)
    files.push({ path: relative(root, path), kind: 'file', device: String(stat.dev), inode: String(stat.ino), logicalBytes: stat.size, allocatedBytes: stat.blocks * 512, modifiedAtMs: stat.mtimeMs, duplicateHardlink })
    if (!duplicateHardlink) { logicalBytes += stat.size; allocatedBytes += stat.blocks * 512 }
  }
  await visit(root)
  return { sampledAt: new Date().toISOString(), root, complete: errors.length === 0, logicalBytes, allocatedBytes, directories, symlinks, files, errors, externalSymlinkTargets: files.filter(row => row.kind === 'symlink' && row.outsideRoot).map(row => row.resolvedTarget),
    boundary: 'unique regular-file inode bytes; symlink targets listed but not followed; concurrent mutation is not an atomic disk snapshot' }
}

export function countWire(rows) {
  const errors = [], totals = { requests: 0, requestBytes: 0, responseBytes: 0 }
  const ids = new Set()
  for (const row of rows) {
    if (!row.id || ids.has(row.id) || !Number.isSafeInteger(row.requestBytes) || row.requestBytes < 0 || !Number.isSafeInteger(row.responseBytes) || row.responseBytes < 0) { errors.push({ id: row.id ?? null, reason: 'MISSING_DUPLICATE_OR_INVALID_WIRE_MEASUREMENT' }); continue }
    ids.add(row.id); totals.requests++; totals.requestBytes += row.requestBytes; totals.responseBytes += row.responseBytes
  }
  return { ...totals, complete: errors.length === 0, errors, boundary: 'caller supplies actual serialized HTTP/stream byte counters; no inference from object counts or protocol acceptance' }
}

export async function collectSnapshot({ phase, processes, roots }) {
  if (!['cold-start', 'ready', 'idle', 'busy', 'after-fault', 'stopped'].includes(phase) || !Array.isArray(processes) || !Array.isArray(roots)) throw Error('Explicit phase, owned processes and all code/data/dependency roots are required')
  const processSamples = await Promise.all(processes.map(async process => ({ id: process.id, role: process.role,
    ...await measureProcess(process.pid, { expectedStartTicks: process.startTicks }) })))
  const trees = await Promise.all(roots.map(root => snapshotTree(root)))
  return { schema: 'geneway.protocol-measurement/1', phase, sampledAt: new Date().toISOString(), processes: processSamples,
    declaredProcesses: processes.length, observedLiveProcesses: processSamples.filter(row => row.available && row.state !== 'Z').length,
    processInventoryComplete: processSamples.every(row => row.available), trees,
    boundary: 'only caller-declared owned PID inventory and roots; missing sidecars/dependency roots cannot be inferred or treated as zero' }
}

export function coldStart({ spawnedAt, readyAt }) {
  const elapsedMs = Date.parse(readyAt) - Date.parse(spawnedAt)
  return Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? { available: true, spawnedAt, readyAt, elapsedMs, boundary: 'caller must use actual child-spawn and real readiness barrier timestamps' }
    : { available: false, reason: 'MISSING_OR_INVALID_SPAWN_READY_BARRIERS' }
}

// 跨根共享安装、重叠目录与硬链接按同一dev/ino只计一次；外链未显式覆盖不假装完整。
export async function snapshotRoots(roots, { externalRoots = [] } = {}) {
  if (!Array.isArray(roots) || !Array.isArray(externalRoots)) throw Error('roots and externalRoots must be arrays')
  const requested = [...new Set(roots.map(root => resolve(root)))], external = [...new Set(externalRoots.map(root => resolve(root)))]
  const details = await Promise.all([...new Set([...requested, ...external])].map(root => snapshotTree(root)))
  const seen = new Map()
  for (const tree of details) for (const row of tree.files) if (row.kind === 'file') {
    const key = `${row.device}:${row.inode}`, first = seen.get(key)
    if (first && (first.logicalBytes !== row.logicalBytes || first.allocatedBytes !== row.allocatedBytes)) throw Error(`Inode changed during cross-root snapshot: ${key}`)
    if (!first) seen.set(key, { ...row, root: tree.root })
  }
  const targets = [...new Set(details.flatMap(tree => tree.externalSymlinkTargets))]
  const pendingExternalTargets = targets.filter(target => !details.some(tree => tree.complete && (target === tree.root || target.startsWith(tree.root + sep))))
  return { sampledAt: new Date().toISOString(), roots: details.map(tree => ({ ...tree, purpose: requested.includes(tree.root) ? 'requested' : 'external-target' })),
    union: { uniqueRegularFileInodes: seen.size, logicalBytes: [...seen.values()].reduce((sum, row) => sum + row.logicalBytes, 0), allocatedBytes: [...seen.values()].reduce((sum, row) => sum + row.allocatedBytes, 0) },
    pendingExternalTargets, complete: details.every(tree => tree.complete) && pendingExternalTargets.length === 0,
    boundary: 'global dev/ino union of regular files; explicit external roots only, links not followed; non-atomic observations; RSS sums are not physical memory' }
}
