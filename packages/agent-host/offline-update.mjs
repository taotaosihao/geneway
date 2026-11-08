import { constants } from 'node:fs'
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireHostOwner } from './ownership.mjs'
import { createHostJournal } from './journal.mjs'
import { sameBinding } from '../agent-contracts/index.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const mutableCode = name => name === 'README.md' || name.startsWith('bin/') || name === 'packages/agent-host/distribution.mjs' || name === 'packages/agent-host/offline-update.mjs'
export async function packageIdentity(root) {
  const manifest = JSON.parse(await readFile(join(root, 'build-manifest.json'), 'utf8')), records = [], core = []
  for (const row of [...manifest.files].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    if (!row.path || isAbsolute(row.path) || row.path.split('/').includes('..')) fail('PACKAGE_INVALID')
    const path = join(root, row.path), stat = await lstat(path)
    let value
    if (stat.isSymbolicLink()) {
      if (!(await realpath(path)).startsWith(await realpath(root) + sep)) fail('PACKAGE_INVALID')
      value = 'link:' + await readlink(path)
    } else { if (!stat.isFile()) fail('PACKAGE_INVALID'); value = hash(await readFile(path)) }
    const record = [row.path, value]; records.push(record); if (!mutableCode(row.path)) core.push(record)
  }
  const buildId = hash(JSON.stringify(records)), compatibility = hash(JSON.stringify(core))
  if (manifest.buildId && manifest.buildId !== buildId) fail('PACKAGE_INVALID')
  if (manifest.platform !== 'linux' || manifest.arch !== 'x64' || manifest.profile !== 'g-office-disabled') fail('PACKAGE_INCOMPATIBLE')
  return { buildId, compatibility, manifest }
}
async function regularJson(path, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const stat = await file.stat(); if (!stat.isFile() || stat.uid !== process.getuid() || privateFile && (stat.mode & 0o777) !== 0o600) fail('LOCAL_STATE_UNCONFIRMED'); return JSON.parse(await file.readFile('utf8')) } finally { await file.close() }
}
async function canonicalRoot(root) {
  if (!isAbsolute(root ?? '') || resolve(root) !== root || await realpath(root) !== root || !(await lstat(root)).isDirectory()) fail('DATA_ROOT_INVALID')
  return root
}
async function stopped(root) {
  const identity = await regularJson(join(root, 'node-identity.json'), true)
  if (identity.version !== 1 || !identity.nodeId || !identity.nodeInstanceId || !identity.credentialVersion || !/^[A-Za-z0-9_-]{43}$/.test(identity.credential)) fail('LOCAL_STATE_UNCONFIRMED')
  const raw = await regularJson(join(root, 'host-journal.json'))
  if (raw.version !== 3) fail('FORMAT_INCOMPATIBLE')
  const state = await createHostJournal(join(root, 'host-journal.json')).read()
  if (state.executions.some(row => !['stopped', 'settled'].includes(row.status) || row.slotHeld !== false) || state.inbox.some(row => !['stopped', 'settled'].includes(row.status)) || state.outbox.some(row => row.acknowledged !== true) || state.jobs.some(row => row.state !== 'stopped' || !['exit_confirmed', 'never_started'].includes(row.stopEvidence?.workerExit)) || state.captures.some(row => !['published', 'failed'].includes(row.state))) fail('LOCAL_STATE_UNCONFIRMED')
  for (const execution of state.executions) if (!state.outbox.some(row => row.acknowledged && sameBinding(row.event, execution) && row.event.kind === execution.status && ['idle_after_cancel', 'never_started'].includes(row.event[execution.status === 'stopped' ? 'stop_evidence' : 'settle_evidence']))) fail('LOCAL_STATE_UNCONFIRMED')
  // A dead parent can release its lock before an orphan worker has exited.
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try { const cwd = await readlink(`/proc/${pid}/cwd`); if (cwd === root || cwd.startsWith(root + sep)) fail('WORKER_STILL_PRESENT') } catch (cause) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(cause.code)) throw cause }
  }
  const sessions = new Set()
  async function inspectSessions(path) {
    const entries = await readdir(path, { withFileTypes: true }).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause })
    for (const entry of entries) {
      const file = join(path, entry.name)
      if (entry.isSymbolicLink()) fail('FORMAT_INCOMPATIBLE')
      if (entry.isDirectory()) await inspectSessions(file)
      else if (/^session\.v/.test(entry.name)) {
        if (entry.name !== 'session.v4.jsonl.zstd' || !entry.isFile()) fail('FORMAT_INCOMPATIBLE')
        const lines = zstdDecompressSync(await readFile(file)).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
        if (lines[0]?.type !== 'session' || lines[0]?.version !== 4 || typeof lines[0]?.id !== 'string') fail('FORMAT_INCOMPATIBLE')
        sessions.add(lines[0].id)
      }
    }
  }
  await inspectSessions(join(root, 'multisite-executions'))
  for (const execution of state.executions) if (execution.runtimeStarted && !sessions.has(execution.session_id) && !state.outbox.some(row => sameBinding(row.event, execution) && row.event.kind === execution.status && row.event[execution.status === 'stopped' ? 'stop_evidence' : 'settle_evidence'] === 'never_started')) fail('FORMAT_INCOMPATIBLE')
  return { executions: state.executions.length, outbox: state.outbox.length }
}
async function acquireSelection(install) {
  const file = await open(join(install, '.agent-host.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid()) fail('INSTALL_INVALID')
    const child = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', file.fd] })
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
    if (code !== 0) fail(code === 73 ? 'HOST_ALREADY_RUNNING' : 'INSTALL_LOCK_UNAVAILABLE')
    return { fd: file.fd, release: () => file.close() }
  } catch (cause) { await file.close(); throw cause }
}
async function metadata(install) {
  const value = await regularJson(join(install, 'install.json'))
  if (value.schema !== 'geneway.host-install/1' || !Array.isArray(value.releases) || value.releases.length !== 2) fail('INSTALL_INVALID')
  await canonicalRoot(value.dataRoot)
  return value
}
async function selected(install, meta) {
  const link = await readlink(join(install, 'current')), id = link.replace(/^releases\//, '')
  if (link !== 'releases/' + id || !meta.releases.includes(id)) fail('INSTALL_INVALID')
  return id
}
async function point(install, id) {
  const temporary = join(install, '.current-' + randomUUID())
  try { await symlink('releases/' + id, temporary); await rename(temporary, join(install, 'current')); const directory = await open(install, 'r'); try { await directory.sync() } finally { await directory.close() } } finally { await unlink(temporary).catch(cause => { if (cause.code !== 'ENOENT') throw cause }) }
}
function runtime() { if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node !== '26.5.0') fail('RUNTIME_INCOMPATIBLE') }
export async function prepareInstall({ install, dataRoot, previous, next }) {
  runtime(); await canonicalRoot(dataRoot)
  if (!isAbsolute(install) || resolve(install) !== install || install === dataRoot || install.startsWith(dataRoot + sep) || dataRoot.startsWith(install + sep)) fail('INSTALL_INVALID')
  const [a, b] = await Promise.all([packageIdentity(previous), packageIdentity(next)])
  if (a.buildId === b.buildId || a.compatibility !== b.compatibility || b.manifest.offlineUpdate?.pairedBuildId !== a.buildId || b.manifest.offlineUpdate?.journalVersion !== 3 || b.manifest.offlineUpdate?.node !== process.versions.node || b.manifest.dependencies?.['@deepseek-ai/dsh'] !== '0.2.0-rc.2') fail('PACKAGE_INCOMPATIBLE')
  await mkdir(install, { recursive: false, mode: 0o700 })
  const lock = await acquireSelection(install)
  try {
    await mkdir(join(install, 'releases'))
    for (const [source, release] of [[previous, a], [next, b]]) await cp(source, join(install, 'releases', release.buildId), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    await writeFile(join(install, 'install.json'), JSON.stringify({ schema: 'geneway.host-install/1', dataRoot, releases: [a.buildId, b.buildId], compatibility: a.compatibility, maintenanceBuildId: b.buildId }) + '\n', { mode: 0o600, flag: 'wx' })
    await point(install, a.buildId)
    return { status: 'PREPARED', previous: a.buildId, next: b.buildId, dataRoot }
  } finally { await lock.release() }
}
export async function activate({ install, expected, target }) {
  runtime(); let selection, owner
  try {
    await canonicalRoot(install)
    selection = await acquireSelection(install)
    const meta = await metadata(install), current = await selected(install, meta)
    if (current !== expected) fail('EXPECTED_BUILD_MISMATCH')
    if (!meta.releases.includes(target)) fail('PACKAGE_INCOMPATIBLE')
    owner = await acquireHostOwner(meta.dataRoot)
    const [old, next] = await Promise.all([packageIdentity(join(install, 'releases', current)), packageIdentity(join(install, 'releases', target))])
    if (old.buildId !== current || next.buildId !== target || old.compatibility !== meta.compatibility || next.compatibility !== meta.compatibility) fail('PACKAGE_INCOMPATIBLE')
    const facts = await stopped(meta.dataRoot)
    await point(install, target)
    return { status: 'ACTIVATED', previous: current, current: target, ...facts }
  } catch (cause) { return { status: 'DEFER', code: cause.code ?? 'LOCAL_STATE_UNCONFIRMED' } } finally { await owner?.release(); await selection?.release() }
}
export async function launchManaged({ install, profile }) {
  runtime(); await canonicalRoot(install); const selection = await acquireSelection(install)
  try {
    const meta = await metadata(install), current = await selected(install, meta), config = await regularJson(profile)
    if (config.root !== meta.dataRoot || config.officeEnabled !== false) fail('DATA_ROOT_MISMATCH')
    const packageRoot = join(install, 'releases', current), identity = await packageIdentity(packageRoot)
    if (identity.buildId !== current || identity.compatibility !== meta.compatibility) fail('PACKAGE_INCOMPATIBLE')
    // The actual Host inherits the same flock description across its original shell/Node exec.
    // It retains selection ownership even if this managed-launch parent dies before the root lock.
    const child = spawn(join(packageRoot, 'bin/host'), [profile], { stdio: ['inherit', 'inherit', 'inherit', selection.fd], env: process.env })
    const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal) }
    const signals = ['SIGINT', 'SIGTERM'], handlers = signals.map(signal => () => forward(signal))
    signals.forEach((signal, index) => process.on(signal, handlers[index]))
    try { return await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code: code ?? 1, signal })) }) } finally { signals.forEach((signal, index) => process.off(signal, handlers[index])) }
  } finally { await selection.release() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, install, a, b, c] = process.argv.slice(2)
    let result
    if (operation === 'prepare') result = await prepareInstall({ install, dataRoot: a, previous: b, next: c })
    else if (operation === 'activate') result = await activate({ install, expected: a, target: b })
    else if (operation === 'launch') { const exited = await launchManaged({ install, profile: a }); process.exitCode = exited.code }
    else fail('INVALID_UPDATE_COMMAND')
    if (result) { console.log(JSON.stringify(result)); if (result.status === 'DEFER') process.exitCode = 75 }
  } catch (cause) { console.error(JSON.stringify({ status: 'DEFER', code: cause.code ?? 'UPDATE_UNAVAILABLE' })); process.exitCode = 75 }
}
