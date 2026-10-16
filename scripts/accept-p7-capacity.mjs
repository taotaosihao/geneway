import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { cpus, tmpdir } from 'node:os'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import { createDshRunner } from '../src/dsh-runner.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createConversationService } from '../src/conversation-service.mjs'
import { createAutomationService } from '../src/automation-service.mjs'
import { activeTopLevelCount } from '../src/execution-runtime.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { getCapability } from '../src/capabilities.mjs'
import { normalizeTpmObservation } from '../src/domain/tpm.mjs'
import { normalizeKivoEventSources, verifyKivoEvent } from '../src/kivo-events.mjs'
import { createILinkSimulator } from './fixtures/ilink-server.mjs'
import { acquireWeixinBot } from '../plugins/weixin.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const script = fileURLToPath(import.meta.url)
const require = createRequire(join(root, 'package.json'))
const model = 'deepseek/deepseek-v4.1-flash'
const dummyKey = 'controlled-no-real-credential-p7'

if (resolve(process.argv[1] ?? '') === script) {
  const options = args(process.argv.slice(2))
  if (options.help) console.log('P7 capacity probes: --harness-check, --run (controlled native SDK idle/races), or --host-run (20 formally provisioned members, 5 Agents, 20 iLink identities and one Feishu consumer). Both runtime modes require --output <new absolute directory> --candidate <0600 manifest> --expected-head <sha> --network-guard <pinned one-port loopback guard> --guard-sha256 <sha>. They do not contact a real model or external channel.')
  else if (options['harness-check']) await harnessCheck()
  else if (options['host-run']) await hostRun(options)
  else await run(options)
}

function args(argv) {
  if (!argv.length) return { help: true }
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' }, 'harness-check': { type: 'boolean' }, run: { type: 'boolean' }, 'host-run': { type: 'boolean' }, output: { type: 'string' }, candidate: { type: 'string' }, 'expected-head': { type: 'string' }, 'network-guard': { type: 'string' }, 'guard-sha256': { type: 'string' } } })
  assert.equal([values.help, values['harness-check'], values.run, values['host-run']].filter(Boolean).length, 1)
  if (!values.run && !values['host-run']) { assert(Object.keys(values).every(key => key === 'help' || key === 'harness-check')); return values }
  for (const key of ['output', 'candidate', 'network-guard']) {
    assert(isAbsolute(values[key] ?? ''), key + ' must be absolute')
    values[key] = resolve(values[key]); assert(!within(root, values[key]), key + ' must be outside repository')
  }
  assert(/^[a-f0-9]{40}$/.test(values['expected-head'] ?? ''))
  assert(/^[a-f0-9]{64}$/.test(values['guard-sha256'] ?? ''))
  return values
}
function within(parent, child) { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path) }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex') }
async function privateJson(path) { const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await fd.stat(); assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600); const bytes = await fd.readFile(); return { value: JSON.parse(bytes), sha256: sha(bytes) } } finally { await fd.close() } }
async function candidateCheck(options, manifest) {
  assert.equal((await command('git', ['rev-parse', 'HEAD'])).trim(), options['expected-head'])
  assert(manifest.files.some(file => file.path === 'scripts/accept-p7-capacity.mjs'))
  for (const file of manifest.files) {
    assert(typeof file.path === 'string' && !file.path.split('/').includes('..') && !isAbsolute(file.path) && /^[a-f0-9]{64}$/.test(file.sha256))
    assert.equal(sha(await readFile(join(root, file.path))), file.sha256, 'candidate changed: ' + file.path)
  }
  assert.equal(sha(await readFile(options['network-guard'])), options['guard-sha256'])
}
async function command(name, argv) { const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const { stdout } = await promisify(execFile)(name, argv, { cwd: root }); return stdout }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function deadline(promise, label, ms = 30_000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms) })]) }
  finally { clearTimeout(timer) }
}
async function until(fn, label) { for (let i = 0; i < 1500; i++) { const found = await fn(); if (found) return found; await sleep(20) } throw new Error(label + ' timed out') }
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }

function nativeCapacitySeed(state, now) {
  return { ...state,
    members: [{ id: 'owner', loginName: 'owner', displayName: 'Capacity owner', role: 'member', enabled: true, authRef: 'owner', sessionVersion: 1, employeeIds: ['agent'], createdAt: now, updatedAt: now }],
    employees: [{ id: 'agent', name: 'Capacity agent', enabled: true, revision: 1, instructions: 'CONTROLLED_LOOPBACK_ONLY', modelRouteId: 'route', skillIds: ['skill-cycle-time-calculate'], connectionIds: [] }],
    modelRoutes: [{ id: 'route', provider: 'zenmux', model, credentialRef: 'ZENMUX_API_KEY', parameters: { maxOutputTokens: 4096 }, enabled: true }],
    skills: [{ id: 'skill-cycle-time-calculate', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }],
  }
}

async function run(options) {
  const manifest = await privateJson(options.candidate)
  await candidateCheck(options, manifest.value)
  await mkdir(options.output, { mode: 0o700 })
  const outputStat = await (await import('node:fs/promises')).lstat(options.output)
  assert(outputStat.isDirectory() && !outputStat.isSymbolicLink() && outputStat.uid === process.getuid() && (outputStat.mode & 0o777) === 0o700)
  const { DeepSeekHarness } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-sdk-client')).href)
  const evidence = { phase: 'P7-capacity-native', provider: 'controlled-loopback-http', actualModel: false, host: { platform: process.platform, arch: process.arch, node: process.execPath, version: process.version, cpuCount: cpus().length }, candidate: manifest.sha256, guardSha256: options['guard-sha256'], resourceScope: 'owned parent, SDK descendants and same-process loopback capture/FD overhead', samples: [], resourceWindows: [], checks: [], requests: [], ok: false }
  const secretRoot = join(options.output, 'secrets'), dshHome = join(options.output, 'dsh')
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(join(secretRoot, 'ZENMUX_API_KEY'), dummyKey, { mode: 0o600, flag: 'wx' })
  const originalEnv = { ...process.env }
  const resources = []
  let capture, failure
  try {
    capture = await createCapture()
    Object.assign(process.env, { DSH_HOME: dshHome, GENEWAY_DSH_HOME: dshHome, GENEWAY_STATE: join(options.output, 'state.json'), GENEWAY_SECRET_ROOT: secretRoot,
      GENEWAY_MODEL_CREDENTIAL_REF: 'ZENMUX_API_KEY', P7_LOOPBACK_PORT: String(capture.port), P7_NETWORK_LOG: join(options.output, 'network.jsonl') })
    await writeFile(process.env.P7_NETWORK_LOG, '', { mode: 0o600, flag: 'wx' })
    const patchPath = await makePatch(options.output, capture.port)
    const store = createFileStore(process.env.GENEWAY_STATE)
    const now = new Date().toISOString()
    await store.update(state => nativeCapacitySeed(state, now))
    const actor = { id: 'owner' }, config = readRuntimeConfig(process.env, root)
    const harnesses = [], closedHarnesses = new Set()
    const runner = createDshRunner({ root, config, harnessFactory: input => {
      const harness = new DeepSeekHarness({ ...input, patches: [...input.patches, patchPath], env: { ...input.env, PATH: process.env.PATH, HOME: process.env.HOME,
        DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED', ZENMUX_API_KEY: dummyKey, P7_LOOPBACK_PORT: String(capture.port), P7_NETWORK_LOG: process.env.P7_NETWORK_LOG,
        NODE_OPTIONS: '--import=' + pathToFileURL(options['network-guard']).href } })
      const close = harness.close.bind(harness)
      harness.close = async (...args) => { const result = await close(...args); closedHarnesses.add(harness); return result }
      harnesses.push(harness)
      return harness
    } })
    const work = createWorkService({ store, runner, policyPaths: { stateFile: process.env.GENEWAY_STATE, dataRoot: options.output, secretRoot } })
    resources.push(work)
    const workIds = []
    let beforeB, bPid
    const resourceMonitor = monitorOwnedTree('native-batches-and-active-race', process.pid)
    let nativeFailure
    try {
    for (let i = 1; i <= 12; i++) {
      const accepted = await work.createWork(actor, { employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 120 + i, quantity: 2 }, clientRequestId: 'capacity-' + i })
      assert.equal(accepted.ok, true, JSON.stringify(accepted))
      workIds.push(accepted.value.id)
      await waitWork(store, accepted.value.id)
      if (i === 9) beforeB = await sample('before-B-native-child')
      if (i === 10) {
        const afterB = await sample('after-B-native-child')
        bPid = afterB.children.find(item => !beforeB.children.some(previous => previous.pid === item.pid))?.pid
        assert(Number.isSafeInteger(bPid) && alive(bPid), 'B native PID not identified')
      }
      if ([4, 8, 12].includes(i)) {
        const idleWindow = await idleTree('idle-after-' + i, process.pid, 2000)
        evidence.samples.push(idleWindow.last)
        evidence.resourceWindows.push(idleWindow)
        assert(idleWindow.last.children.length <= 4, 'idle SDK child cap exceeded')
        assert(idleWindow.peakRssKiB <= 4 * 1024 * 1024 && idleWindow.idleCpuCores <= 1, 'native idle owned tree exceeded RSS or one-core target')
      }
    }
    const idle = evidence.samples
    assert(idle[2].totalRssKiB < idle[0].totalRssKiB * 1.6, 'native RSS still grows linearly after idle cap')
    evidence.checks.push({ case: 'idle-4-8-12', sdkChildren: idle.map(item => item.children.length), totalRssKiB: idle.map(item => item.totalRssKiB), totalFds: idle.map(item => item.totalFds) })

    // The first idle session was already retired by the 12-work sample. Use the newest four.
    const a = workIds[8], b = workIds[9], aHarness = harnesses[8], bHarness = harnesses[9]
    assert(!closedHarnesses.has(aHarness) && !closedHarnesses.has(bHarness))
    capture.holdNext = 1
    const followA = await work.followUp(actor, a, 'P7_ACTIVE_IDLE_EVICTION_CANARY', { clientRequestId: 'active-follow-a' })
    assert.equal(followA.ok, true)
    await until(() => capture.pending.size === 1, 'active A provider request')
    const createdE = await work.createWork(actor, { employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 200, quantity: 2 }, clientRequestId: 'active-e' })
    assert.equal(createdE.ok, true)
    await waitWork(store, createdE.value.id)
    assert(!closedHarnesses.has(bHarness), 'E alone must not trigger B eviction')
    const createdF = await work.createWork(actor, { employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 202, quantity: 2 }, clientRequestId: 'active-f' })
    assert.equal(createdF.ok, true)
    await waitWork(store, createdF.value.id)
    assert(closedHarnesses.has(bHarness), 'F must retire B, the oldest eligible idle harness')
    assert(!closedHarnesses.has(aHarness), 'active A was retired')
    await until(() => !alive(bPid), 'retired B native PID exit')
    const activeSample = await sample('A-active-F-complete-B-retired')
    assert(activeSample.children.length <= 5, 'active A plus four idle SDK children exceeded cap')
    capture.releaseAll()
    const sameA = await waitExecution(store, a)
    assert.equal(sameA.continuity, 'same-session', 'active A was evicted')
    evidence.samples.push(activeSample)
    evidence.checks.push({ case: 'active-A-not-evicted', continuity: sameA.continuity, childrenDuringRace: activeSample.children.length, idleBWorkId: b, idleBRetiredAfterF: true, bPidGone: true })

    await work.close()
    assert.equal((await sample('after-first-runner-close')).children.length, 0)
    } catch (error) { nativeFailure = error; throw error }
    finally { await recordResourceWindow(resourceMonitor, evidence, 'native active or close', nativeFailure) }
    const second = await collisionRun({ root, config, DeepSeekHarness, capture, options, store, actor, patchPath, evidence })
    resources.push(second)
  } catch (error) { failure = error; evidence.failure = { code: error.code ?? 'CAPACITY_FAILED', message: String(error.message).slice(0, 2048) } }
  finally {
    for (const resource of resources.reverse()) try { await resource.close() } catch (error) { failure ??= error; evidence.cleanupFailure ??= []; evidence.cleanupFailure.push(String(error.message)) }
    try { await capture?.close() } catch (error) { failure ??= error }
    try {
      assert(!capture?.failure, 'loopback provider failed: ' + capture?.failure)
      const rows = (await readFile(join(options.output, 'network.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert(rows.length && rows.every(row => row.allowed === true && row.host === '127.0.0.1' && row.port === capture.port), 'native process escaped owned loopback')
      evidence.network = { attempts: rows.length, blocked: 0, ownedPort: capture.port }
    } catch (error) { failure ??= error }
    Object.assign(process.env, originalEnv)
    evidence.requests = capture?.requests.map(row => ({ model: row.model, maxTokens: row.maxTokens, toolNames: row.toolNames, held: row.held })) ?? []
    try { const finalManifest = await privateJson(options.candidate); assert.equal(finalManifest.sha256, manifest.sha256); await candidateCheck(options, finalManifest.value) } catch (error) { failure ??= error }
    if (failure && !evidence.failure) evidence.failure = { code: failure.code ?? 'CAPACITY_FAILED', message: String(failure.message).slice(0, 2048) }
    evidence.ok = !failure
    await writeFile(join(options.output, 'capacity.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ ok: evidence.ok, output: options.output, checks: evidence.checks.map(item => item.case), failure: evidence.failure }))
    if (failure) process.exitCode = 1
  }
}

async function collisionRun({ root, config, DeepSeekHarness, capture, options, store, actor, patchPath, evidence }) {
  let firstHarness, release, entered, hold = false
  const closeGate = new Promise(done => { release = done })
  const enteredGate = new Promise(done => { entered = done })
  const runner = createDshRunner({ root, config, harnessFactory: input => {
    const harness = new DeepSeekHarness({ ...input, patches: [...input.patches, patchPath], env: { ...input.env, PATH: process.env.PATH, HOME: process.env.HOME,
      DSH_HOME: process.env.DSH_HOME, DSH_TELEMETRY_MODE: 'DISABLED', ZENMUX_API_KEY: dummyKey, P7_LOOPBACK_PORT: String(capture.port), P7_NETWORK_LOG: process.env.P7_NETWORK_LOG,
      NODE_OPTIONS: '--import=' + pathToFileURL(options['network-guard']).href } })
    if (!firstHarness) { firstHarness = harness; const close = harness.close.bind(harness); harness.close = async (...args) => { if (hold) { entered(); await closeGate } return close(...args) } }
    return harness
  } })
  const work = createWorkService({ store, runner, policyPaths: { stateFile: process.env.GENEWAY_STATE, dataRoot: options.output, secretRoot: join(options.output, 'secrets') } })
  const resourceMonitor = monitorOwnedTree('native-close-successor-race', process.pid)
  let closePromise
  const closeLocal = () => closePromise ??= (async () => { capture.releaseAll(); release(); await work.close() })()
  let succeeded = false
  try {
  const ids = []
  let firstPid
  for (let i = 1; i <= 4; i++) {
    const accepted = await work.createWork(actor, { employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 300 + i, quantity: 2 }, clientRequestId: 'collision-' + i })
    assert.equal(accepted.ok, true)
    ids.push(accepted.value.id)
    await waitWork(store, accepted.value.id)
    if (i === 1) firstPid = (await sample('collision-A-first-idle')).children[0]?.pid
  }
  const fourIdle = await sample('collision-four-idle')
  evidence.samples.push(fourIdle)
  assert(Number.isSafeInteger(firstPid) && alive(firstPid))
  hold = true
  const e = await work.createWork(actor, { employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 399, quantity: 2 }, clientRequestId: 'collision-e' })
  assert.equal(e.ok, true)
  await enteredGate
  const successor = await work.followUp(actor, ids[0], 'P7_OLD_CLOSING_SUCCESSOR_CANARY', { clientRequestId: 'closing-follow-a' })
  assert.equal(successor.ok, true)
  const resumed = await waitExecution(store, ids[0])
  assert.equal(resumed.continuity, 'successor')
  release()
  await waitWork(store, e.value.id)
  await until(() => !alive(firstPid), 'retired native PID exit')
  const closedSample = await sample('old-close-new-successor')
  evidence.samples.push(closedSample)
  assert(closedSample.children.length <= 4)
  evidence.checks.push({ case: 'closing-A-new-successor', continuity: resumed.continuity, retiredPidGone: true, closeCompleted: true })
  const handedOff = await verifiedResourceHandoff(work, resourceMonitor, evidence, closeLocal)
  succeeded = true
  return handedOff
  } finally {
    if (!succeeded) { await resourceMonitor.stop().catch(() => undefined); await closeLocal().catch(() => undefined) }
  }
}

async function verifiedResourceHandoff(resource, monitor, evidence, close) {
  try {
    const observed = await monitor.stop(); evidence.resourceWindows.push(observed)
    assertResourceWindow(observed, 'native close/successor')
    return resource
  } catch (error) {
    try { await close() } catch (cleanupError) { evidence.cleanupFailure ??= []; evidence.cleanupFailure.push(String(cleanupError.message)) }
    throw error
  }
}

function assertResourceWindow(observed, label) {
  assert(observed.sampleCount >= 2, label + ' had insufficient owned-tree samples')
  assert(observed.peakRssKiB <= 4 * 1024 * 1024, label + ' sampled owned-tree RSS exceeded 4 GiB')
}

async function recordResourceWindow(monitor, evidence, label, priorError) {
  try {
    const observed = await monitor.stop(); evidence.resourceWindows.push(observed)
    assertResourceWindow(observed, label)
  } catch (error) {
    evidence.resourceGateFailure = { code: error.code ?? 'CAPACITY_RESOURCE_GATE_FAILED', message: String(error.message) }
    if (!priorError) throw error
  }
}

async function waitWork(store, id) { return until(async () => { const work = (await store.read()).works.find(item => item.id === id); if (work?.status === 'failed') throw new Error('work failed: ' + JSON.stringify(work.executions.at(-1)?.error)); return work?.status === 'completed' && work.executions.at(-1)?.closePending === false ? work : null }, 'work ' + id) }
async function waitExecution(store, id) { return until(async () => { const execution = (await store.read()).works.find(item => item.id === id)?.executions.at(-1); if (execution?.status === 'failed') throw new Error('execution failed: ' + JSON.stringify(execution.error)); return execution?.status === 'completed' && execution.closePending === false ? execution : null }, 'execution ' + id) }

function procStat(raw) {
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
  const ppid = Number(fields[1]), cpuTicks = Number(fields[11]) + Number(fields[12]), starttime = fields[19]
  assert(Number.isSafeInteger(ppid) && Number.isSafeInteger(cpuTicks) && cpuTicks >= 0 && /^\d+$/.test(starttime ?? ''), 'invalid owned process stat')
  return { state: fields[0], ppid, cpuTicks, starttime }
}

async function readOwnedSample(stage, rootPid, io = { readFile, readdir, mono: () => process.hrtime.bigint() }) {
  const started = io.mono(), queue = [rootPid], seen = new Set(), values = [], missing = [], exitedDuringSample = []
  while (queue.length) {
    const pid = queue.shift()
    if (seen.has(pid)) continue
    seen.add(pid)
    const statPath = '/proc/' + pid + '/stat'
    let stat, statReadMonoNs, status, fds, failedPart = 'stat'
    const recordExit = () => {
      const rss = status && /VmRSS:\s*(\d+)/.exec(status)
      exitedDuringSample.push({ pid, starttime: stat?.starttime ?? null, reason: 'EXITED',
        cpuTicks: stat?.cpuTicks ?? null, rssKiB: rss ? Number(rss[1]) : null, fds: fds?.length ?? null })
    }
    try {
      stat = procStat(await io.readFile(statPath, 'utf8')); statReadMonoNs = io.mono()
      failedPart = 'task'
      for (const tid of await io.readdir('/proc/' + pid + '/task')) {
        failedPart = 'task/' + tid + '/children'
        const children = await io.readFile('/proc/' + pid + '/task/' + tid + '/children', 'utf8')
        for (const child of children.trim().split(/\s+/).filter(Boolean)) {
          assert(/^\d+$/.test(child), 'invalid owned child PID')
          queue.push(Number(child))
        }
      }
      failedPart = 'status'; status = await io.readFile('/proc/' + pid + '/status', 'utf8')
      failedPart = 'fd'; fds = await io.readdir('/proc/' + pid + '/fd')
      failedPart = 'stat-recheck'
      const final = procStat(await io.readFile(statPath, 'utf8'))
      if (final.starttime !== stat.starttime) {
        missing.push({ pid, part: 'identity', code: 'PID_REUSED' })
        continue
      }
      if (['Z', 'X', 'x'].includes(final.state)) {
        if (pid === rootPid) missing.push({ pid, part: 'stat-recheck', code: 'ROOT_EXITED' })
        else recordExit()
        continue
      }
      const rss = /VmRSS:\s*(\d+)/.exec(status)
      if (!rss) { missing.push({ pid, part: 'VmRSS', code: 'NOT_PRESENT' }); continue }
      values.push({ pid, ppid: stat.ppid, starttime: stat.starttime, statReadMonoNs: statReadMonoNs.toString(),
        cpuTicks: stat.cpuTicks, rssKiB: Number(rss[1]), fds: fds.length })
    } catch (error) {
      if (error.code === 'EACCES' && failedPart === 'fd') {
        let recheck
        try { recheck = procStat(await io.readFile(statPath, 'utf8')) }
        catch (recheckError) {
          if (pid !== rootPid && ['ENOENT', 'ESRCH'].includes(recheckError.code)) { recordExit(); continue }
          error.message += `; owned pid=${pid} fd recheck=${recheckError.code ?? recheckError.message}`
          throw error
        }
        if (pid !== rootPid && recheck.starttime === stat.starttime && ['Z', 'X', 'x'].includes(recheck.state)) { recordExit(); continue }
        error.message += `; owned pid=${pid} fd recheck state=${recheck.state} starttime=${recheck.starttime} expected=${stat.starttime}${pid === rootPid ? ' root' : ''}`
        throw error
      }
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
      if (pid === rootPid) { missing.push({ pid, part: failedPart, code: error.code }); continue }
      let stillThere
      try { stillThere = procStat(await io.readFile(statPath, 'utf8')) }
      catch (recheckError) { if (recheckError.code !== 'ENOENT' && recheckError.code !== 'ESRCH') throw recheckError }
      if (stillThere && stat && stillThere.starttime !== stat.starttime) {
        missing.push({ pid, part: 'identity', code: 'PID_REUSED' })
      } else if (stillThere && ['Z', 'X', 'x'].includes(stillThere.state)) {
        recordExit()
      } else if (stillThere) {
        missing.push({ pid, part: failedPart, code: error.code })
      } else recordExit()
    }
  }
  const finished = io.mono(), parent = values.find(item => item.pid === rootPid)
  const complete = Boolean(parent) && missing.length === 0
  const children = values.filter(item => item.pid !== rootPid).sort((a, b) => a.pid - b.pid)
  return { stage, at: new Date().toISOString(), cpuCount: cpus().length, rootPid, parent, children,
    complete, missing, exitedDuringSample, sampleMonoStartNs: started.toString(), sampleMonoEndNs: finished.toString(), sampleSpanMs: Number(finished - started) / 1e6,
    totalRssKiB: complete ? values.reduce((sum, item) => sum + item.rssKiB, exitedDuringSample.reduce((sum, item) => sum + (item.rssKiB ?? 0), 0)) : null,
    totalFds: complete ? values.reduce((sum, item) => sum + item.fds, exitedDuringSample.reduce((sum, item) => sum + (item.fds ?? 0), 0)) : null,
    totalCpuTicks: complete ? values.reduce((sum, item) => sum + item.cpuTicks, exitedDuringSample.reduce((sum, item) => sum + (item.cpuTicks ?? 0), 0)) : null }
}

async function sample(stage, rootPid = process.pid, io) {
  const result = await readOwnedSample(stage, rootPid, io)
  assert(result.complete, stage + ' owned process tree incomplete: ' + JSON.stringify(result.missing))
  return result
}

function monitorOwnedTree(stage, rootPid) {
  let stopped = false
  const readings = []
  const task = (async () => { while (!stopped) { readings.push(await sample(stage, rootPid)); if (!stopped) await sleep(100) } })()
  task.catch(() => undefined)
  return { async stop() { stopped = true; await task; assert(readings.length); assert(readings.every(item => item.complete), stage + ' owned process tree incomplete'); return { stage, sampleCount: readings.length,
    peakRssKiB: Math.max(...readings.map(item => item.totalRssKiB)), peakFds: Math.max(...readings.map(item => item.totalFds)),
    maxSampleSpanMs: Math.max(...readings.map(item => item.sampleSpanMs)),
    exitedDuringSample: readings.flatMap((item, sampleIndex) => item.exitedDuringSample.map(exit => ({ sampleIndex, ...exit }))),
    first: readings[0], last: readings.at(-1) } } }
}

async function makePatch(directory, port) {
  let yaml = (await readFile(join(root, 'config/p1-runtime.patch.yml'), 'utf8')).replaceAll('name: ../plugins/', 'name: ' + root + '/plugins/')
  yaml += `\n- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        displayName: Controlled loopback only\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: http://127.0.0.1:${port}/v1\n        compat:\n          supportsUsageInStreaming: true\n          supportsFinishReason: true\n          maxTokensField: max_tokens\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n        models:\n          - id: ${model}\n            contextWindow: 200000\n            maxTokens: 4096\n`
  const path = join(directory, 'capacity.patch.yml')
  await writeFile(path, yaml, { mode: 0o600, flag: 'wx' })
  return path
}

async function createCapture() {
  const requests = [], pending = new Map(), value = { requests, pending, holdNext: 0 }
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer ' + dummyKey)
      let raw = ''; for await (const part of request) raw += part
      const body = JSON.parse(raw), messages = body.messages ?? [], tools = (body.tools ?? []).map(item => item.function?.name ?? item.name)
      assert.equal(body.model, model); assert.equal(body.max_tokens, 4096); assert(!raw.includes(dummyKey))
      const lastUser = messages.findLastIndex(item => item.role === 'user')
      const user = messages[lastUser], content = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(part => part.text ?? '').join('\n')
      const hasToolResult = messages.slice(lastUser + 1).some(item => item.role === 'tool')
      const match = /参数必须精确为\s*(\{[^}]*\})/.exec(content)
      const tool = !hasToolResult && tools.includes('geneway_calculate_cycle_time') && match ? 'geneway_calculate_cycle_time' : null
      const row = { model: body.model, maxTokens: body.max_tokens, toolNames: tools, held: false }; requests.push(row)
      const send = () => {
        if (response.destroyed) return
        const id = 'controlled-' + randomUUID(), base = { id, object: 'chat.completion.chunk', created: 0, model }
        const chunk = (delta, finish_reason) => response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        chunk(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'tool-' + randomUUID(), type: 'function', function: { name: tool, arguments: match[1] } }] } : { role: 'assistant', content: 'Controlled loopback reply completed' }, null)
        chunk({}, tool ? 'tool_calls' : 'stop')
        response.write('data: ' + JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) + '\n\n')
        response.end('data: [DONE]\n\n')
      }
      if (value.holdNext > 0) { const requestId = requests.length; value.holdNext--; row.held = true; pending.set(requestId, send); response.once('close', () => pending.delete(requestId)) }
      else send()
    } catch (error) { response.writeHead(500); response.end('controlled provider assertion failed'); value.failure = error.message }
  })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  value.port = server.address().port
  value.releaseAll = () => { const sends = [...pending.values()]; pending.clear(); for (const send of sends) send() }
  value.close = async () => { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  return value
}

async function harnessCheck() {
  assert.deepEqual(args([]), { help: true })
  assert.throws(() => args(['--run']))
  assert.throws(() => args(['--harness-check', '--output', '/tmp/invalid']))
  assert.equal(args(['--run', '--output', '/tmp/p7', '--candidate', '/tmp/candidate', '--expected-head', 'a'.repeat(40), '--network-guard', '/tmp/guard', '--guard-sha256', 'b'.repeat(64)]).run, true)
  assert.equal(args(['--host-run', '--output', '/tmp/p7', '--candidate', '/tmp/candidate', '--expected-head', 'a'.repeat(40), '--network-guard', '/tmp/guard', '--guard-sha256', 'b'.repeat(64)])['host-run'], true)
  const stat = (pid, ppid, starttime, ticks = 10, state = 'S') => {
    const fields = Array(20).fill('0'); fields[0] = state; fields[1] = String(ppid); fields[11] = String(ticks); fields[19] = String(starttime)
    return pid + ' (owned fixture) ' + fields.join(' ')
  }
  const files = new Map([
    ['/proc/100/stat', stat(100, 1, 1000)], ['/proc/100/status', 'VmRSS:\t100 kB'],
    ['/proc/100/task/100/children', ''], ['/proc/100/task/101/children', '200'],
    ['/proc/200/stat', stat(200, 100, 2000)], ['/proc/200/status', 'VmRSS:\t200 kB'], ['/proc/200/task/200/children', '300'],
    ['/proc/300/stat', stat(300, 200, 3000)], ['/proc/300/status', 'VmRSS:\t300 kB'], ['/proc/300/task/300/children', ''],
  ])
  const directories = new Map([
    ['/proc/100/task', ['100', '101']], ['/proc/100/fd', ['0', '1']],
    ['/proc/200/task', ['200']], ['/proc/200/fd', ['0']], ['/proc/300/task', ['300']], ['/proc/300/fd', ['0']],
  ])
  const gone = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  let mockMono = 1_000_000_000n
  const procIo = { readFile: async path => { if (!files.has(path)) throw gone(); return files.get(path) },
    readdir: async path => { if (!directories.has(path)) throw gone(); return directories.get(path) }, mono: () => { mockMono += 1_000n; return mockMono } }
  const tree = await sample('pure-owned-tree', 100, procIo)
  assert(tree.complete && tree.missing.length === 0 && tree.exitedDuringSample.length === 0)
  assert.deepEqual(tree.children.map(item => item.pid), [200, 300], 'non-leader thread and nested helper were not discovered')
  assert.equal(tree.totalRssKiB, 600); assert.equal(tree.totalFds, 4)
  assert(tree.children.every(item => item.starttime && item.statReadMonoNs))
  const exitIo = { ...procIo, readFile: async path => {
    if (path === '/proc/200/stat') return exitIo.childStatReads++ === 0 ? files.get(path) : Promise.reject(gone())
    if (path === '/proc/200/task/200/children') return ''
    return procIo.readFile(path)
  }, readdir: async path => path === '/proc/200/fd' ? Promise.reject(gone()) : procIo.readdir(path), childStatReads: 0 }
  const exited = await sample('pure-child-exit', 100, exitIo)
  assert(exited.complete && exited.children.length === 0 && exited.exitedDuringSample[0]?.pid === 200)
  assert.equal(exited.exitedDuringSample[0].rssKiB, 200); assert.equal(exited.totalRssKiB, 300)
  const zombieIo = { ...procIo, childStatReads: 0, readFile: async path => {
    if (path === '/proc/200/stat') return zombieIo.childStatReads++ === 0 ? files.get(path) : stat(200, 100, 2000, 10, 'Z')
    if (path === '/proc/200/task/200/children') return ''
    if (path === '/proc/200/status') return 'State:\tZ\n'
    return procIo.readFile(path)
  } }
  const zombie = await sample('pure-child-zombie', 100, zombieIo)
  assert(zombie.complete && zombie.children.length === 0 && zombie.exitedDuringSample[0]?.reason === 'EXITED')
  assert.equal(zombie.exitedDuringSample[0].rssKiB, null)
  const reusedIo = { ...procIo, childStatReads: 0, readFile: async path => {
    if (path === '/proc/200/stat') return reusedIo.childStatReads++ === 0 ? files.get(path) : stat(200, 999, 2001)
    if (path === '/proc/200/task/200/children') return ''
    return procIo.readFile(path)
  } }
  const reused = await readOwnedSample('pure-pid-reused', 100, reusedIo)
  assert(!reused.complete && reused.missing[0]?.code === 'PID_REUSED' && reused.children.length === 0)
  await assert.rejects(sample('pure-root-missing', 100, { ...procIo, readFile: async path => path === '/proc/100/stat' ? Promise.reject(gone()) : procIo.readFile(path) }), /owned process tree incomplete/)
  await assert.rejects(sample('pure-live-child-unreadable', 100, { ...procIo, readFile: async path => path === '/proc/200/status' ? Promise.reject(gone()) : procIo.readFile(path) }), /owned process tree incomplete/)
  const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' })
  await assert.rejects(sample('pure-live-child-denied', 100, { ...procIo, readFile: async path => path === '/proc/200/status' ? Promise.reject(denied) : procIo.readFile(path) }), error => error === denied)
  const deniedFdIo = recheckStat => {
    let childStatReads = 0
    const fdError = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    return { fdError, io: { ...procIo,
      readFile: async path => {
        if (path === '/proc/200/stat') return childStatReads++ === 0 ? files.get(path) : recheckStat()
        if (path === '/proc/200/task/200/children') return ''
        return procIo.readFile(path)
      },
      readdir: async path => path === '/proc/200/fd' ? Promise.reject(fdError) : procIo.readdir(path),
    } }
  }
  const fdGone = deniedFdIo(() => Promise.reject(gone()))
  const goneOnFd = await sample('pure-fd-eacces-gone', 100, fdGone.io)
  assert(goneOnFd.complete && goneOnFd.exitedDuringSample[0]?.pid === 200)
  const fdZombie = deniedFdIo(() => stat(200, 100, 2000, 10, 'Z'))
  const zombieOnFd = await sample('pure-fd-eacces-zombie', 100, fdZombie.io)
  assert(zombieOnFd.complete && zombieOnFd.exitedDuringSample[0]?.reason === 'EXITED')
  const fdLive = deniedFdIo(() => files.get('/proc/200/stat'))
  await assert.rejects(sample('pure-fd-eacces-live', 100, fdLive.io), error => error === fdLive.fdError && error.code === 'EACCES' && /state=S/.test(error.message))
  const fdReused = deniedFdIo(() => stat(200, 999, 2001))
  await assert.rejects(sample('pure-fd-eacces-reused', 100, fdReused.io), error => error === fdReused.fdError && /expected=2000/.test(error.message))
  await assert.rejects(sample('pure-root-fd-eacces', 100, { ...procIo, readdir: async path => path === '/proc/100/fd' ? Promise.reject(denied) : procIo.readdir(path) }), error => error === denied && /root/.test(error.message))
  const frame = (at, parentTicks, childTicks, childStarttime = '2000', includeChild = true, exits = []) => ({
    complete: true, sampleMonoStartNs: String(at), sampleMonoEndNs: String(at + 10_000n), sampleSpanMs: 0.01,
    parent: { pid: 100, starttime: '1000', statReadMonoNs: String(at + 2_000n), cpuTicks: parentTicks },
    children: includeChild ? [{ pid: 200, starttime: childStarttime, statReadMonoNs: String(at + 3_000n), cpuTicks: childTicks }] : [],
    exitedDuringSample: exits, totalRssKiB: 300, totalFds: 3,
  })
  const beginning = frame(1_000_000_000n, 10, 5), ending = frame(2_000_000_000n, 20, 5)
  assert.equal(idleReadings([beginning, ending], 100).idleCpuCores, 0.1)
  assert.throws(() => idleReadings([beginning, frame(2_000_000_000n, 20, 5, '2000', false)], 100), /topology changed/)
  assert.throws(() => idleReadings([beginning, frame(2_000_000_000n, 20, 5, 'reused')], 100), /topology changed/)
  assert.throws(() => idleReadings([beginning, frame(2_000_000_000n, 9, 5)], 100), /ticks moved backward/)
  assert.throws(() => idleReadings([beginning, frame(2_000_000_000n, 20, 5, '2000', false, exited.exitedDuringSample)], 100), /incomplete or changed/)
  const gateError = new Error('RESOURCE_GATE_FAILURE'), failedEvidence = { resourceWindows: [] }
  let localCloseCount = 0
  await assert.rejects(verifiedResourceHandoff({}, { stop: async () => { throw gateError } }, failedEvidence, async () => { localCloseCount++ }), error => error === gateError)
  assert.equal(localCloseCount, 1, 'failed resource gate lost local close ownership')
  await assert.rejects(verifiedResourceHandoff({}, { stop: async () => ({ sampleCount: 2, peakRssKiB: 4 * 1024 * 1024 + 1 }) }, failedEvidence, async () => { localCloseCount++ }), /exceeded 4 GiB/)
  assert.equal(localCloseCount, 2, 'over-limit RSS did not close the local resource')
  const originalFailure = new Error('work failed: INVALID_REQUEST'), sparseEvidence = { resourceWindows: [] }
  await assert.rejects(async () => {
    let priorError
    try { throw originalFailure }
    catch (error) { priorError = error; throw error }
    finally { await recordResourceWindow({ stop: async () => ({ sampleCount: 1, peakRssKiB: 194908 }) }, sparseEvidence, 'native active or close', priorError) }
  }, error => error === originalFailure)
  assert.match(sparseEvidence.resourceGateFailure.message, /insufficient owned-tree samples/)
  await assert.rejects(recordResourceWindow({ stop: async () => ({ sampleCount: 2, peakRssKiB: 4 * 1024 * 1024 + 1 }) }, { resourceWindows: [] }, 'native active or close'), /RSS exceeded 4 GiB/)
  const temporary = await mkdtemp(join(tmpdir(), 'p7-capacity-schema-'))
  try {
    const nativeStateFile = join(temporary, 'native-state.json'), nativeSecretRoot = join(temporary, 'native-secrets')
    await mkdir(nativeSecretRoot, { mode: 0o700 })
    await writeFile(join(nativeSecretRoot, 'ZENMUX_API_KEY'), dummyKey, { mode: 0o600 })
    const nativeStore = createFileStore(nativeStateFile)
    await nativeStore.update(state => nativeCapacitySeed(state, new Date().toISOString()))
    const nativeConfig = readRuntimeConfig({ ...process.env, DSH_HOME: join(temporary, 'native-dsh'), GENEWAY_DSH_HOME: join(temporary, 'native-dsh'),
      GENEWAY_STATE: nativeStateFile, GENEWAY_SECRET_ROOT: nativeSecretRoot, GENEWAY_MODEL_CREDENTIAL_REF: 'ZENMUX_API_KEY' }, root)
    let nativeHarnessCalls = 0
    const nativeRunner = createDshRunner({ root, config: nativeConfig, harnessFactory: () => { nativeHarnessCalls++; throw new Error('CONTROLLED_FACTORY_STOP') } })
    const nativeService = createWorkService({ store: nativeStore, runner: nativeRunner, policyPaths: { stateFile: nativeStateFile, dataRoot: temporary, secretRoot: nativeSecretRoot } })
    try {
      const accepted = await nativeService.createWork({ id: 'owner' }, { employeeId: 'agent', skillId: 'skill-cycle-time-calculate',
        input: { availableSeconds: 121, quantity: 2 }, clientRequestId: 'capacity-1' })
      assert.equal(accepted.ok, true)
      const first = await until(async () => { const work = (await nativeStore.read()).works.find(item => item.id === accepted.value.id); return work?.status === 'failed' ? work : null }, 'pure native fixture boundary')
      assert.equal(first.executions.at(-1).error.code, 'INTERNAL_ERROR')
      assert.equal(nativeHarnessCalls, 1, 'first native fixture never reached the controlled harness boundary')
    } finally { await nativeService.close() }
    const store = createFileStore(join(temporary, 'state.json')), now = new Date().toISOString()
    await store.update(state => ({ ...state,
      members: [{ id: 'capacity-member-1', loginName: 'capacity1', displayName: '容量成员', role: 'admin', enabled: true, authRef: 'capacity-auth-1', employeeIds: ['capacity-agent-1'], sessionVersion: 1, createdAt: now, updatedAt: now }],
      modelRoutes: [{ id: 'capacity-route', provider: 'zenmux', model, credentialRef: 'ZENMUX_API_KEY', parameters: { maxOutputTokens: 4096 }, enabled: true }],
      skills: [{ id: 'capacity-skill', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }, { id: 'skill-cycle-time-calculate', name: '正式节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }],
      connections: [{ id: 'capacity-connection', kind: 'capacity-fixture', enabled: true, revision: 1 }],
      employees: [{ id: 'capacity-agent-1', name: '容量 Agent 1', enabled: true, revision: 1, modelRouteId: 'capacity-route', instructions: 'CAPACITY_SYNTHETIC_ONLY', skillIds: ['capacity-skill', 'skill-cycle-time-calculate'], connectionIds: ['capacity-connection'] }],
    }))
    await store.update(state => capacityHistory(state, now))
    const state = await store.read()
    assert.deepEqual([state.works.length, state.conversations.length, state.conversations.reduce((n, item) => n + item.turns.length, 0), state.knowledgeMaterials.length, state.automationRules.length], [1000, 200, 5000, 100, 20])
    assert.equal((await controlledAutomationCapacity(join(temporary, 'state.json'), temporary)).accepted, 2)
    const controlled = await controlledCapacity(join(temporary, 'state.json'), temporary, { admissionSamples: 4, requireP95: false })
    assert.equal(controlled.check.active, 4)
    const source = { id: 'capacity-source', connectionId: 'capacity-kivo', resource: 'http://127.0.0.1:41001/api/v1/mes/mcp', sourceInstance: 'capacity-pure', signingSecretRef: 'capacity-event.key', subscriptionIds: [randomUUID()], enabled: true }
    const key = randomBytes(32), wire = signedCapacityEvent({ source, signingKey: key, subscriptionId: source.subscriptionIds[0], objectId: randomUUID(), deviceId: randomUUID(), index: 0 })
    const verified = verifyKivoEvent({ rawBody: wire.raw, rawHeaders: wire.rawHeaders, source, signingKey: key })
    assert.equal(verified.event.eventId, wire.eventId); assert.equal(verified.rawDigest, sha(wire.raw))
  } finally { await rm(temporary, { recursive: true, force: true }) }
  console.log('P7 capacity harness checks passed (explicit isolated run guard and target history schema; native/provider/Host calls=0)')
}

async function hostRun(options) {
  const manifest = await privateJson(options.candidate)
  await candidateCheck(options, manifest.value)
  await mkdir(options.output, { mode: 0o700 })
  const secretRoot = join(options.output, 'secrets'), dataRoot = join(options.output, 'data')
  await mkdir(secretRoot, { mode: 0o700 }); await mkdir(dataRoot, { mode: 0o700 })
  const stateFile = join(dataRoot, 'state.json'), authFile = join(options.output, 'auth.json'), dshHome = join(dataRoot, 'dsh')
  const hostConfig = join(options.output, 'host.json'), networkFile = join(options.output, 'network.jsonl')
  const report = { phase: 'P7-capacity-host', host: { platform: process.platform, arch: process.arch, node: process.execPath, version: process.version, cpuCount: cpus().length }, candidate: manifest.sha256, provider: 'none', channel: 'synthetic-iLink-plus-official-Feishu-SDK', target: { members: 20, agents: 5, weixin: 20, feishuConsumers: 1, endedWorks: 1000, conversations: 200, turns: 5000, knowledge: 100, rules: 20 }, samples: [], bindingSamples: [], checks: [], latencies: {}, ok: false }
  const store = createFileStore(stateFile)
  const now = new Date().toISOString(), feishuRef = 'P7_CAPACITY_FEISHU'
  const members = Array.from({ length: 20 }, (_, index) => ({ id: 'capacity-member-' + (index + 1), loginName: 'capacity' + (index + 1), displayName: '容量成员 ' + (index + 1), role: index === 0 ? 'admin' : 'member', enabled: true,
    authRef: 'capacity-auth-' + (index + 1), employeeIds: ['capacity-agent-' + (index % 5 + 1)] }))
  const passwords = Object.fromEntries(members.map(item => [item.authRef, randomBytes(24).toString('base64url')]))
  const accounts = members.map((item, index) => ({ id: 'capacity-bot-' + (index + 1), ownerUserId: 'capacity-wx-' + (index + 1), token: 'SYNTHETIC_TOKEN_' + randomBytes(24).toString('hex') }))
  const sessions = new Map()
  let simulator, host, origin, failure, hostStopped = false
  try {
    await writeFile(join(secretRoot, 'ZENMUX_API_KEY'), dummyKey, { mode: 0o600, flag: 'wx' })
    await writeFile(join(secretRoot, feishuRef), JSON.stringify({ appId: 'cli_aaaaaaaaaaaaaaaa', appSecret: 'synthetic_' + randomBytes(24).toString('hex') }), { mode: 0o600, flag: 'wx' })
    await store.update(state => ({ ...state,
      modelRoutes: [{ id: 'capacity-route', provider: 'zenmux', model, credentialRef: 'ZENMUX_API_KEY', parameters: { maxOutputTokens: 4096 }, enabled: true }],
      skills: [{ id: 'capacity-skill', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }, { id: 'skill-cycle-time-calculate', name: '正式节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }],
      connections: [{ id: 'capacity-connection', kind: 'capacity-fixture', enabled: true, revision: 1 }],
      employees: Array.from({ length: 5 }, (_, index) => ({ id: 'capacity-agent-' + (index + 1), name: '容量 Agent ' + (index + 1), enabled: true, revision: 1, modelRouteId: 'capacity-route', instructions: 'CAPACITY_SYNTHETIC_ONLY', skillIds: ['capacity-skill', 'skill-cycle-time-calculate'], connectionIds: ['capacity-connection'] })),
      channelApps: [{ id: 'capacity-weixin', provider: 'weixin', providerAppId: 'ilink', providerTenantId: 'personal', credentialRef: null, enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now },
        { id: 'capacity-feishu', provider: 'feishu', providerAppId: 'cli_aaaaaaaaaaaaaaaa', providerTenantId: 'capacity', credentialRef: feishuRef, enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }],
    }))
    const roster = join(options.output, 'members.json')
    await writeFile(roster, JSON.stringify(members), { mode: 0o600, flag: 'wx' })
    await promisify(execFile)(process.execPath, [join(root, 'scripts/init-p2-auth.mjs'), '--mode', 'bootstrap', '--state', stateFile, '--auth', authFile, '--members', roster],
      { cwd: root, env: { PATH: process.env.PATH, HOME: options.output, LANG: 'C.UTF-8', GENEWAY_MEMBER_PASSWORDS: JSON.stringify(passwords) }, timeout: 60_000 })
    const provisioned = await store.read()
    assert.equal(provisioned.members.length, 20)
    await store.update(state => capacityHistory(state, now))
    const historical = await store.read()
    assert.deepEqual([historical.works.length, historical.conversations.length, historical.conversations.reduce((n, item) => n + item.turns.length, 0), historical.knowledgeMaterials.length, historical.automationRules.length], [1000, 200, 5000, 100, 20])
    report.historyBytes = Buffer.byteLength(JSON.stringify(historical))
    await copyFile(stateFile, join(options.output, 'controlled-state.json'))
    const controlled = await controlledCapacity(join(options.output, 'controlled-state.json'), options.output)
    report.checks.push(controlled.check)
    report.latencies.admission = controlled.latencies
    report.checks.push(await controlledAutomationCapacity(stateFile, options.output, { ackHttp: true }))
    simulator = await createILinkSimulator({ holdMs: 1000 })
    for (const account of accounts) simulator.addAccount(account)
    await writeFile(hostConfig, JSON.stringify({ ilinkUrl: simulator.url }), { mode: 0o600, flag: 'wx' })
    await writeFile(networkFile, '', { mode: 0o600, flag: 'wx' })
    const port = await freeTcpPort(); origin = 'http://127.0.0.1:' + port
    const baseEnv = { PATH: process.env.PATH, HOME: options.output, LANG: 'C.UTF-8', DSH_HOME: dshHome, GENEWAY_DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED',
      GENEWAY_STATE: stateFile, GENEWAY_AUTH_FILE: authFile, GENEWAY_PORT: String(port), GENEWAY_HOST: '127.0.0.1', GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_SECRET_ROOT: secretRoot,
      GENEWAY_MODEL_CREDENTIAL_REF: 'ZENMUX_API_KEY', GENEWAY_CHANNEL_ACCEPT_HOST: '1', GENEWAY_CHANNEL_HOST_CONFIG: hostConfig,
      GENEWAY_NETWORK_AUDIT_ROLE: 'host', P7_LOOPBACK_PORT: String(new URL(simulator.url).port), P7_NETWORK_LOG: networkFile,
      NODE_OPTIONS: '--import=' + pathToFileURL(options['network-guard']).href }
    host = startHost(baseEnv)
    await until(async () => { if (host.exitCode !== null || host.signalCode !== null) throw new Error('Host exited before readiness'); try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).status === 200 } catch { return false } }, 'capacity Host startup')
    const snapshot = await hostIpc(host, 'snapshot')
    assert(snapshot.sdkDispatcher && snapshot.consumers.maxActive === 1 && snapshot.consumers.active === 1)
    for (let index = 0; index < members.length; index++) {
      const member = members[index], account = accounts[index]
      const login = await hostRequest(origin, null, '/api/session', 'POST', { loginName: member.loginName, password: passwords[member.authRef] })
      assert.equal(login.status, 200)
      sessions.set(member.id, { cookie: login.cookie.split(';')[0], csrf: login.body.csrfToken })
      const link = await hostRequest(origin, sessions.get(member.id), '/api/channels/weixin/bindings', 'POST', { channelAppId: 'capacity-weixin' })
      assert.equal(link.status, 201)
      simulator.queueLogin(simulator.confirmedLogin(account.id))
      await until(async () => { const channels = await hostRequest(origin, sessions.get(member.id), '/api/channels'); return channels.body.linkCodes.some(item => item.id === link.body.id && item.status === 'matched') }, 'matched iLink binding ' + index)
      const confirmed = await hostRequest(origin, sessions.get(member.id), '/api/channels/link-codes/' + link.body.id + '/confirm', 'POST', { employeeId: member.employeeIds[0] })
      assert.equal(confirmed.status, 200)
      report.bindingSamples.push(await sample('bound-' + (index + 1), host.pid))
      if (index === 1 || index === 19) {
        const count = index + 1
        await until(() => accounts.slice(0, count).every(item => simulator.calls.filter(call => call.botId === item.id && call.endpoint === '/ilink/bot/getupdates' && call.completed).length >= 10), count + ' complete iLink poll cycles')
        report.samples.push(await idleTree('online-' + count, host.pid, 3000))
      }
    }
    for (const account of accounts) {
      const polls = simulator.calls.filter(call => call.botId === account.id && call.endpoint === '/ilink/bot/getupdates')
      assert(polls.filter(call => call.completed && call.heldMs >= 800).length >= 10 && simulator.maxActivePolls(account.id) === 1, account.id + ' waiting poll condition')
    }
    const reconnectBot = accounts[0]
    const beforeReconnect = simulator.calls.filter(call => call.botId === reconnectBot.id && call.endpoint === '/ilink/bot/getupdates').length
    simulator.queuePoll(reconnectBot.id, { drop: true })
    await until(() => simulator.calls.filter(call => call.botId === reconnectBot.id && call.endpoint === '/ilink/bot/getupdates').some((call, index) => index >= beforeReconnect && call.aborted), 'iLink controlled disconnect')
    await until(() => simulator.calls.filter(call => call.botId === reconnectBot.id && call.endpoint === '/ilink/bot/getupdates').slice(beforeReconnect + 1).some(call => call.completed), 'iLink reconnect completed poll')
    await assert.rejects(acquireWeixinBot(reconnectBot.id), { code: 'OWNER_ALREADY_RUNNING' }, 'second instance of the same bot acquired its lock')
    assert.equal(simulator.maxActivePolls(reconnectBot.id), 1)
    assert.equal((await hostIpc(host, 'snapshot')).consumers.maxActive, 1)
    report.checks.push({ case: '20-formal-members-5-agents-20-ilink-one-feishu', completeWaitingPolls: accounts.map(item => simulator.calls.filter(call => call.botId === item.id && call.completed && call.heldMs >= 800).length), maxActivePolls: accounts.map(item => simulator.maxActivePolls(item.id)), reconnectBotId: reconnectBot.id, duplicateBotLockRejected: true })
    const warm = await hostRequest(origin, sessions.get(members[0].id), '/api/works'); assert.equal(warm.status, 200)
    const timings = []
    for (let index = 0; index < 80; index++) {
      const path = index % 2 ? '/api/conversations' : '/api/works'
      const started = performance.now(), response = await hostRequest(origin, sessions.get(members[0].id), path)
      assert.equal(response.status, 200)
      timings.push({ path, ms: performance.now() - started })
    }
    report.latencies.read = { count: timings.length, p95Ms: percentile(timings.map(item => item.ms), 95), raw: timings }
    assert(report.latencies.read.p95Ms <= 1000, 'target history read p95 exceeds one second')
    const online20 = report.samples.at(-1)
    report.ownedPeakRssKiB = Math.max(...report.bindingSamples.map(item => item.totalRssKiB), ...report.samples.map(item => item.peakRssKiB))
    assert(report.ownedPeakRssKiB <= 4 * 1024 * 1024, 'owned Host/SDK/lock sampled peak RSS exceeds 4 GiB')
    assert(online20.idleCpuCores <= 1, 'owned Host/SDK/lock stable CPU exceeds one core')
    await stopHost(host); hostStopped = true
    assert(accounts.every(account => simulator.activePolls(account.id) === 0), 'stopped Host kept iLink poll open')
    const backup = join(options.output, 'backup'), backupSecrets = join(options.output, 'backup-secrets'), restored = join(options.output, 'restored'), restoredSecrets = join(options.output, 'restored-secrets')
    const transferEnv = { PATH: process.env.PATH, HOME: options.output, LANG: 'C.UTF-8', GENEWAY_STATE: stateFile, GENEWAY_DSH_HOME: dshHome, GENEWAY_MODEL_CREDENTIAL_REF: 'ZENMUX_API_KEY', GENEWAY_CANDIDATE: manifest.sha256 }
    const backupStart = performance.now()
    await promisify(execFile)(process.execPath, [join(root, 'scripts/state-transfer.mjs'), 'backup', '--output', backup, '--secret-output', backupSecrets, '--secret-root', secretRoot], { cwd: root, env: transferEnv, timeout: 600_000 })
    const backupMs = performance.now() - backupStart
    const restoreStart = performance.now()
    await promisify(execFile)(process.execPath, [join(root, 'scripts/state-transfer.mjs'), 'restore', '--input', backup, '--data-root', restored, '--secret-input', backupSecrets, '--secret-root', restoredSecrets], { cwd: root, env: transferEnv, timeout: 600_000 })
    const restoredStateFile = join(restored, 'state.json'), restoredAuth = join(options.output, 'restored-auth.json')
    const rekeyRoster = join(options.output, 'rekey-members.json')
    await writeFile(rekeyRoster, JSON.stringify(members.map(item => ({ id: item.id, authRef: item.authRef }))), { mode: 0o600, flag: 'wx' })
    await promisify(execFile)(process.execPath, [join(root, 'scripts/init-p2-auth.mjs'), '--mode', 'rekey', '--state', restoredStateFile, '--auth', restoredAuth, '--members', rekeyRoster],
      { cwd: root, env: { PATH: process.env.PATH, HOME: options.output, LANG: 'C.UTF-8', GENEWAY_MEMBER_PASSWORDS: JSON.stringify(passwords) }, timeout: 60_000 })
    const restoredPort = await freeTcpPort(), restoredOrigin = 'http://127.0.0.1:' + restoredPort
    const restoredConfig = join(options.output, 'restored-host.json')
    await writeFile(restoredConfig, JSON.stringify({ ilinkUrl: simulator.url }), { mode: 0o600, flag: 'wx' })
    host = startHost({ ...baseEnv, DSH_HOME: join(restored, 'dsh'), GENEWAY_DSH_HOME: join(restored, 'dsh'), GENEWAY_STATE: restoredStateFile, GENEWAY_AUTH_FILE: restoredAuth, GENEWAY_PORT: String(restoredPort), GENEWAY_TRUSTED_ORIGIN: restoredOrigin,
      GENEWAY_SECRET_ROOT: restoredSecrets, GENEWAY_CHANNEL_HOST_CONFIG: restoredConfig })
    hostStopped = false
    await until(async () => { if (host.exitCode !== null || host.signalCode !== null) throw new Error('restored Host exited'); try { return (await fetch(restoredOrigin, { signal: AbortSignal.timeout(1000) })).status === 200 } catch { return false } }, 'restored Host startup')
    const restoredLogin = await hostRequest(restoredOrigin, null, '/api/session', 'POST', { loginName: members[0].loginName, password: passwords[members[0].authRef] })
    assert.equal(restoredLogin.status, 200)
    const restoredSession = { cookie: restoredLogin.cookie.split(';')[0], csrf: restoredLogin.body.csrfToken }
    const restoredRead = await hostRequest(restoredOrigin, restoredSession, '/api/works')
    assert.equal(restoredRead.status, 200)
    const restoreToReadMs = performance.now() - restoreStart
    assert(backupMs <= 600_000 && restoreToReadMs <= 600_000)
    const recoveredState = await createFileStore(restoredStateFile).read()
    assert.equal(recoveredState.works.length, 1000)
    assert.equal(recoveredState.conversations.reduce((n, item) => n + item.turns.length, 0), 5000)
    report.checks.push({ case: 'target-history-backup-empty-restore-login-read', backupMs, restoreToReadMs, restoredRoot: restored, counts: { works: recoveredState.works.length, conversations: recoveredState.conversations.length, turns: 5000, knowledge: recoveredState.knowledgeMaterials.length, rules: recoveredState.automationRules.length } })
    await stopHost(host); hostStopped = true
    assert.equal(simulator.failures.length, 0)
    const audit = (await readFile(networkFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert(audit.length && audit.every(row => row.allowed === true && row.host === '127.0.0.1' && row.port === Number(new URL(simulator.url).port)))
    report.network = { attempts: audit.length, blocked: 0 }
    assert.equal((await privateJson(options.candidate)).sha256, manifest.sha256)
    await candidateCheck(options, manifest.value)
    report.ok = true
  } catch (error) { failure = error; report.failure = { code: error.code ?? 'HOST_CAPACITY_FAILED', message: String(error.message).slice(0, 2048) } }
  finally {
    if (host && !hostStopped) try { await stopHost(host) } catch (error) { failure ??= error; report.cleanupFailure = String(error.message) }
    try { await simulator?.close() } catch (error) { failure ??= error; report.cleanupFailure = String(error.message) }
    report.ok = !failure
    await writeFile(join(options.output, 'capacity-host.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ ok: report.ok, output: options.output, checks: report.checks.map(item => item.case), failure: report.failure }))
    if (failure) process.exitCode = 1
  }
}

export function capacityHistory(state, now) {
  const definition = { employeeRevision: 1, instructions: 'CAPACITY_SYNTHETIC_ONLY', modelRouteId: 'capacity-route' }
  const fingerprint = sha(JSON.stringify(definition))
  const works = Array.from({ length: 1000 }, (_, index) => ({ id: 'capacity-work-' + index, ownerMemberId: 'capacity-member-1', employeeId: 'capacity-agent-1', skillId: 'capacity-skill', capabilityId: 'cycle-time-calculate', connectionId: 'capacity-connection',
    goal: 'Synthetic ended capacity work', input: { availableSeconds: 120, quantity: 2 }, requiredInputs: [], status: 'cancelled', acceptedAt: now, results: [], actions: [],
    executions: [{ id: 'capacity-execution-' + index, operation: 'create', clientRequestId: 'capacity-ended-' + index, input: { availableSeconds: 120, quantity: 2 }, status: 'cancelled', acceptedAt: now, completedAt: now, closePending: false, error: { code: 'CANCELLED', message: 'Synthetic ended work' } }] }))
  const conversations = Array.from({ length: 200 }, (_, index) => ({ id: 'capacity-conversation-' + index, ownerMemberId: 'capacity-member-1', employeeId: 'capacity-agent-1', employeeName: '容量 Agent 1', title: 'Synthetic capacity history ' + index,
    source: 'web', channelIdentityId: null, createdAt: now, updatedAt: now, archivedAt: null, sessions: [], turns: Array.from({ length: 25 }, (_, turn) => ({ id: `capacity-turn-${index}-${turn}`,
      clientRequestId: `capacity-request-${index}-${turn}`, userText: 'Synthetic ended capacity turn', status: 'failed', createdAt: now, startedAt: now, completedAt: now,
      error: { code: 'UPSTREAM_ERROR', message: 'Synthetic ended turn' }, definition, definitionFingerprint: fingerprint, sessionId: null, userMessageId: null, assistantMessageIds: [] })) }))
  const knowledgeMaterials = Array.from({ length: 100 }, (_, index) => ({ id: 'capacity-knowledge-' + index, ownerMemberId: 'capacity-member-1', employeeIds: ['capacity-agent-1'], sharedMemberIds: [], sharedEmployeeIds: [],
    title: '容量资料 ' + index, body: 'K'.repeat(32 * 1024), format: 'text', sourceLabel: 'synthetic capacity', authorizationBasis: 'isolated capacity fixture', revision: 1, status: 'active', createdAt: now, updatedAt: now }))
  const automationRules = Array.from({ length: 20 }, (_, index) => ({ id: 'capacity-rule-' + index, ownerMemberId: 'capacity-member-1', revision: 1, status: 'draft', employeeId: 'capacity-agent-1', skillId: 'capacity-skill', connectionId: 'capacity-connection',
    workOrderId: 'capacity-' + index, trigger: { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' }, maxRuns: 1, notificationIdentityId: null, effectiveFrom: null, eventAcceptAfter: null, createdAt: now, updatedAt: now, revokedAt: null }))
  return { ...state, works, conversations, knowledgeMaterials, automationRules }
}

async function controlledAutomationCapacity(stateFile, dataRoot, { ackHttp = false } = {}) {
  const path = join(dataRoot, 'automation-state-' + randomUUID() + '.json')
  await copyFile(stateFile, path)
  const store = createFileStore(path), cap = getCapability('kivo-tpm-record-read'), now = new Date().toISOString()
  const automationSecrets = join(dataRoot, 'automation-secrets-' + randomUUID())
  await mkdir(automationSecrets, { mode: 0o700 })
  await writeFile(join(automationSecrets, 'ZENMUX_API_KEY'), dummyKey, { mode: 0o600, flag: 'wx' })
  await writeFile(join(automationSecrets, 'capacity-only.pem'), 'synthetic-capacity-credential', { mode: 0o600, flag: 'wx' })
  const objectId = randomUUID(), deviceId = randomUUID(), actor = { id: 'capacity-member-1' }
  const connection = { id: 'capacity-kivo', name: '容量受控实例', kind: 'kivo-mcp', targetIdentity: 'capacity-loopback', baseUrl: 'http://127.0.0.1:41001/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41001', clientId: randomUUID(), credentialRef: 'capacity-only.pem', allowedObjectIds: [], enabled: true, status: 'ready', revision: 1, skillIds: [cap.skillId], sourceSystem: 'Kivo', sourceInstance: 'capacity-pure', sourceEnvironment: 'pure-test', dataMode: 'synthetic', evidenceMode: 'controlled-function' }
  const catalog = [Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, connection[key]]))]
  await store.update(state => ({ ...state,
    automationRules: state.automationRules.slice(4),
    connections: [...state.connections, connection],
    skills: [...state.skills, { id: cap.skillId, name: '容量单据查询', capabilityId: cap.id, enabled: true }],
    employees: state.employees.map(item => item.id === 'capacity-agent-1' ? { ...item, skillIds: [...item.skillIds, cap.skillId], connectionIds: [...item.connectionIds, connection.id] } : item),
  }))
  const modelEntered = gate(), modelHeld = gate(), mcpEntered = gate(), mcpHeld = gate()
  let holdMcp = false
  const actualWork = createWorkService({ store, runner: { configured: true, async run() { modelEntered.resolve(); return modelHeld.promise }, async cancel() { modelHeld.reject(Object.assign(new Error('controlled cancellation'), { code: 'CANCELLED' })) }, async close() { modelHeld.reject(Object.assign(new Error('controlled close'), { code: 'CANCELLED' })) } }, connectionCatalog: catalog,
    policyPaths: { stateFile: path, dataRoot, secretRoot: automationSecrets } })
  const subscriptionId = randomUUID(), signingKey = randomBytes(32), source = { id: 'capacity-source', connectionId: connection.id, resource: connection.baseUrl, sourceInstance: connection.sourceInstance,
    signingSecretRef: 'capacity-event.key', subscriptionIds: [subscriptionId], enabled: true }
  const sources = normalizeKivoEventSources({ version: 1, sources: [source] })
  const sourceBytes = Buffer.from(JSON.stringify(sources)), sourceConfig = { ...sources, sha256: sha(sourceBytes) }
  const automation = createAutomationService({ store, clock: () => now, connectionCatalog: catalog,
    workService: { ...actualWork, async ensureReady() {}, async dispatchAutomationWork() {} },
    readEventSources: async () => sourceConfig,
    async readCurrentRecord(options) {
      await options.authorize()
      if (holdMcp) { mcpEntered.resolve(); await mcpHeld.promise }
      const source = { system: 'kivo', path: '/api/v1/mes/tpm/repairs/R-1', queriedAt: now, traceId: 'capacity-read' }
      return normalizeTpmObservation({ mode: 'record', input: options.input, connection: options.connection,
        result: { status: 'ok', source, value: { id: objectId, orderNo: 'R-1', deviceId, status: 'reported', revision: 1, updatedAt: now } },
        deviceResult: { status: 'ok', source: { ...source, path: '/api/v1/mes/equipment/ledger/devices/' + deviceId }, value: { id: deviceId, code: 'D-1', name: '容量设备', lifecycleStatus: 'active', revision: 1 } } })
    } })
  let heldRead
  try {
    const rules = []
    for (let i = 0; i < 4; i++) {
      const draft = await automation.createRule(actor, { employeeId: 'capacity-agent-1', skillId: cap.skillId, connectionId: connection.id,
        input: { recordType: 'repair', reference: 'R-1' }, trigger: i === 3 ? { kind: 'kivo-record-update', sourceId: source.id } : { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' }, maxRuns: 10 })
      rules.push(await automation.enableRule(actor, draft.id, { expectedRevision: draft.revision }))
    }
    const outcomes = await Promise.all(rules.slice(0, 3).map((rule, index) => automation.acceptManualOccurrence(actor, rule.id, { expectedRevision: rule.revision, clientRequestId: 'capacity-auto-' + index })))
    const accepted = outcomes.filter(item => item.accepted), skipped = outcomes.filter(item => item.skipped && item.reason === 'capacity')
    assert.equal(accepted.length, 2, 'automatic execution exceeded two in flight')
    assert.equal(skipped.length, 1, 'third automatic occurrence did not persist a capacity skip')
    const saved = await store.read()
    assert.equal(saved.automationRules.length, 20)
    assert.equal(saved.automationOccurrences.length, 3)
    assert.equal(activeTopLevelCount(saved), 2, 'two automation works must count in global capacity')
    assert.equal(saved.works.length, 1002)
    let eventAck
    if (ackHttp) {
      const ordinary = await actualWork.createWork(actor, { employeeId: 'capacity-agent-1', skillId: cap.skillId, connectionId: connection.id,
        input: { recordType: 'repair', reference: 'R-1' }, clientRequestId: 'capacity-model-held' })
      assert.equal(ordinary.ok, true)
      await deadline(modelEntered.promise, 'controlled model dispatch hold')
      holdMcp = true
      heldRead = automation.acceptManualOccurrence(actor, rules[2].id, { expectedRevision: rules[2].revision, clientRequestId: 'capacity-mcp-held' })
      void heldRead.catch(() => undefined)
      await deadline(Promise.race([mcpEntered.promise, heldRead.then(() => { throw new Error('controlled MCP read did not remain held') })]), 'controlled MCP read hold')
      assert.equal(activeTopLevelCount(await store.read()), 3)
      eventAck = await capacityEventAck({ store, automation, source, sourceConfig, signingKey, subscriptionId, objectId, deviceId, now, dataRoot })
      mcpHeld.resolve(); await heldRead
      modelHeld.resolve({ stopReason: 'completed' })
    }
    return { case: 'target-history-automatic-two-cap-and-global-slots', accepted: accepted.length, skipped: skipped.length, reason: skipped[0].reason,
      globalActive: activeTopLevelCount(saved), persistedOccurrences: saved.automationOccurrences.length, ...(eventAck ? { eventAck } : {}) }
  } finally {
    mcpHeld.resolve(); modelHeld.reject(Object.assign(new Error('controlled close'), { code: 'CANCELLED' }))
    await Promise.allSettled([heldRead, actualWork.close()])
  }
}

async function capacityEventAck({ store, automation, source, sourceConfig, signingKey, subscriptionId, objectId, deviceId, dataRoot }) {
  const secretRoot = join(dataRoot, 'ack-secrets-' + randomUUID())
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(join(secretRoot, source.signingSecretRef), 'whsec_' + signingKey.toString('base64'), { mode: 0o600, flag: 'wx' })
  const server = createGenewayServer({ service: {}, channel: {}, store, auth: {}, trustedOrigin: 'http://127.0.0.1:1', secretRoot,
    automationRuntime: { ownsLock: () => true, acceptKivoEvent: verified => automation.acceptKivoEvent(verified) }, readEventSources: async () => sourceConfig })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const origin = 'http://127.0.0.1:' + server.address().port, timings = [], receipts = []
  try {
    for (let index = 0; index < 80; index++) {
      const wire = signedCapacityEvent({ source, signingKey, subscriptionId, objectId, deviceId, index })
      const started = performance.now()
      const response = await fetch(origin + '/api/events/kivo/' + source.id, { method: 'POST', headers: wire.headers, body: wire.raw, signal: AbortSignal.timeout(10_000) })
      const result = await response.json(), duration = performance.now() - started
      assert.equal(response.status, 202, JSON.stringify(result))
      assert.equal(result.accepted, true); assert.equal(result.eventId, wire.eventId)
      assert(duration < 10_000, 'durable event ACK exceeded ten seconds while model and MCP were held')
      const entry = (await store.read()).automationInbox.find(item => item.event.eventId === wire.eventId)
      assert(entry && Number.isFinite(Date.parse(entry.acceptedAt)) && entry.targets.some(item => item.status === 'pending'), 'HTTP ACK preceded durable targeted inbox')
      assert.equal(entry.deliveries.find(item => item.id === wire.deliveryId)?.rawDigest, sha(wire.raw))
      timings.push(duration); receipts.push({ eventId: wire.eventId, deliveryId: wire.deliveryId, rawDigest: sha(wire.raw), acceptedAt: entry.acceptedAt, ackDurationMs: duration })
    }
    const p95Ms = percentile(timings, 95)
    assert(p95Ms <= 1000, 'target history durable HTTP event ACK p95 exceeds one second')
    return { entrypoint: 'product HTTP route with injected owner and held model/MCP dependencies', count: timings.length, p95Ms, rawMs: timings, receipts,
      modelHeld: true, mcpHeld: true, targetPending: true }
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
}

function signedCapacityEvent({ source, signingKey, subscriptionId, objectId, deviceId, index }) {
  const occurredAt = new Date().toISOString(), deliveryId = randomUUID(), eventId = randomUUID(), organizationId = randomUUID()
  const subject = { id: objectId, type: 'repair', label: 'CAPACITY-SYNTHETIC', deviceId, deviceName: 'capacity device', organizationId, organizationAncestorIds: [organizationId] }
  const body = { version: 2, deliveryId, type: 'notification.business_event', timestamp: occurredAt, data: {
    source: { authority: 'mes.native.repair', adapter: 'mes.native', revision: '2' }, object: structuredClone(subject),
    message: { templateVersion: 1, title: 'capacity synthetic', body: 'capacity synthetic' }, rule: { id: subscriptionId, revision: 1, name: 'capacity' },
    businessEvent: { version: 1, eventId, sourceKind: 'native_audit', objectType: 'repair', objectId, sourceRevision: '2', occurredAt, timezone: 'Asia/Shanghai', actorId: randomUUID(), traceId: 'capacity-held-' + index, action: null,
      before: { status: 'reported', executorId: null }, after: { status: 'dispatched', executorId: randomUUID() }, subject: structuredClone(subject), businessLink: {}, displayBefore: {}, displayAfter: {} },
    basis: {}, businessLink: {},
  } }
  const raw = Buffer.from(JSON.stringify(body)), stamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', signingKey).update(`${deliveryId}.${stamp}.`).update(raw).digest('base64')
  const headers = { 'content-type': 'application/json', 'webhook-id': deliveryId, 'webhook-timestamp': stamp, 'webhook-signature': 'v1,' + signature }
  return { raw, headers, rawHeaders: Object.entries(headers).flat(), eventId, deliveryId }
}

async function controlledCapacity(stateFile, dataRoot, { admissionSamples = 80, requireP95 = true } = {}) {
  const store = createFileStore(stateFile), actor = { id: 'capacity-member-1' }, pending = new Map(), chats = new Map(), roots = new Map(), closeGate = gate()
  const runner = { configured: true,
    run(options) { const entry = gate(); pending.set(options.executionId, entry); entry.promise.then(() => pending.delete(options.executionId), () => pending.delete(options.executionId)); return entry.promise },
    async cancel(id) { await closeGate.promise; pending.get(id)?.reject(Object.assign(new Error('controlled cancelled'), { code: 'CANCELLED' })) },
    async close() { closeGate.resolve(); for (const entry of pending.values()) entry.reject(Object.assign(new Error('controlled shutdown'), { code: 'CANCELLED' })) },
  }
  const shared = { run(rootId) { const entry = gate(); roots.set(rootId, entry); return entry.promise },
    runChatTurn(options) { const entry = gate(); chats.set(options.turnId, entry); return entry.promise },
    async cancelChatTurn(_id, turnId) { chats.get(turnId)?.resolve({ stopReason: 'aborted' }); return true },
    async readChatHistory() { return [] },
    async close() { for (const entry of [...chats.values(), ...roots.values()]) entry.resolve({ stopReason: 'aborted' }) },
  }
  const work = createWorkService({ store, runner, collaborationRunner: shared, policyPaths: { stateFile, dataRoot, secretRoot: join(dataRoot, 'secrets') } })
  const chat = createConversationService({ store, runner: shared })
  try {
    await work.ensureReady(); await chat.ensureReady()
    const conversation = await chat.createConversation(actor, { employeeId: 'capacity-agent-1' })
    const body = id => ({ employeeId: 'capacity-agent-1', skillId: 'skill-cycle-time-calculate', goal: 'CONTROLLED_CAPACITY_ONLY', input: { availableSeconds: 120, quantity: 2 }, clientRequestId: id })
    const [one, two, turn, rootWork] = await Promise.all([
      work.createWork(actor, body('controlled-one')), work.createWork(actor, body('controlled-two')),
      chat.sendTurn(actor, conversation.id, { text: 'CONTROLLED_CAPACITY_TURN', clientRequestId: 'controlled-turn' }),
      work.createCollaboration(actor, { employeeId: 'capacity-agent-1', skillId: 'capacity-skill', goal: 'CONTROLLED_CAPACITY_ROOT', clientRequestId: 'controlled-root',
        items: [{ id: 'child', employeeId: 'capacity-agent-1', skillId: 'capacity-skill', input: { availableSeconds: 120, quantity: 2 } }] }),
    ])
    assert(one.ok && two.ok && rootWork.ok)
    await until(() => pending.size === 2 && chats.size === 1 && roots.size === 1, 'four controlled entrypoints')
    assert.equal(activeTopLevelCount(await store.read()), 4, 'child must not consume a fifth top-level slot')
    const admissionMs = []
    for (let i = 0; i < admissionSamples; i++) {
      const start = performance.now(), fifth = await work.createWork(actor, body('controlled-fifth-' + i))
      admissionMs.push(performance.now() - start)
      assert.equal(fifth.error?.code, 'BUSY')
    }
    const p95Ms = percentile(admissionMs, 95)
    if (requireP95) assert(p95Ms <= 1000, 'target history admission p95 exceeds one second')
    assert.equal((await work.createWork(actor, body('controlled-one'))).deduplicated, true)
    assert.equal((await work.continueWork(actor, one.value.id, {})).deduplicated, true)
    assert.equal((await chat.sendTurn(actor, conversation.id, { text: 'CONTROLLED_CAPACITY_TURN', clientRequestId: 'controlled-turn' })).deduplicated, true)
    const cancelling = work.cancel(actor, one.value.id)
    await until(async () => (await store.read()).works.find(item => item.id === one.value.id).status === 'cancel_requested', 'cancel close barrier')
    assert.equal(activeTopLevelCount(await store.read()), 4)
    assert.equal((await work.createWork(actor, body('controlled-during-close'))).error?.code, 'BUSY')
    closeGate.resolve(); await cancelling
    await until(async () => activeTopLevelCount(await store.read()) === 3, 'cancelled slot release')
    const accepted = await work.createWork(actor, body('controlled-after-close'))
    assert.equal(accepted.ok, true)
    const surviving = (await store.read()).works.find(item => item.id === two.value.id)
    assert(surviving?.status === 'running' && surviving.executions.at(-1).status === 'running' && pending.has(surviving.executions.at(-1).id), 'W2 was cancelled by W1 close')
    assert.equal(activeTopLevelCount(await store.read()), 4)
    pending.get(surviving.executions.at(-1).id).resolve(controlledCycleResult(surviving.executions.at(-1).id, surviving.input))
    const successfulW2 = await waitWork(store, two.value.id)
    assert.equal(successfulW2.results.at(-1).kind, 'manufacturing.takt', 'W2 did not complete independently after W1 cancellation')
    assert.equal(activeTopLevelCount(await store.read()), 3)
    const acceptedMs = []
    for (let i = 0; i < admissionSamples; i++) {
      const started = performance.now(), result = await work.createWork(actor, body('controlled-admitted-' + i))
      const duration = performance.now() - started
      assert.equal(result.ok, true, 'successful admission was rejected')
      const durable = (await store.read()).works.find(item => item.id === result.value.id)
      assert(durable && ['accepted', 'running'].includes(durable.status) && durable.executions.at(-1).clientRequestId === 'controlled-admitted-' + i, 'successful admission was not durable')
      acceptedMs.push(duration)
      const executionId = durable.executions.at(-1).id
      await until(() => pending.has(executionId), 'admitted execution reached controlled runner')
      pending.get(executionId).resolve(controlledCycleResult(executionId, durable.input))
      const completed = await waitWork(store, durable.id)
      assert.equal(completed.results.at(-1).kind, 'manufacturing.takt')
      assert.equal(activeTopLevelCount(await store.read()), 3, 'completed admission did not release its slot')
    }
    const acceptedP95Ms = percentile(acceptedMs, 95)
    if (requireP95) assert(acceptedP95Ms <= 1000, 'target history successful durable admission p95 exceeds one second')
    return { check: { case: 'target-history-four-top-hard-BUSY-idempotency-close', active: 4, fifthBusy: true, childNotCounted: true, cancellationHeldSlot: true, independentW2StillRunning: true, newAfterClose: true },
      latencies: { successfulAdmission: { count: acceptedMs.length, p95Ms: acceptedP95Ms, rawMs: acceptedMs, durableAndReleased: true }, busyRejection: { count: admissionMs.length, p95Ms, rawMs: admissionMs } } }
  } finally {
    closeGate.resolve()
    await Promise.allSettled([chat.close(), work.close()])
  }
}

function controlledCycleResult(executionId, input) {
  return { result: { kind: 'manufacturing.takt', payload: { ...input, secondsPerUnit: input.availableSeconds / input.quantity, unit: 'seconds/unit' },
    toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '2' }, explanation: 'Controlled capacity result',
    dshSessionRef: 'capacity-session-' + executionId, continuity: 'new', contextConfirmationRefs: [], eventCount: 1 }
}

function gate() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); promise.catch(() => undefined); return { promise, resolve, reject } }

async function freeTcpPort() { const server = createServer(); await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) }); const port = server.address().port; await new Promise(done => server.close(done)); return port }
function startHost(env) { const child = spawn(process.execPath, [join(root, 'scripts/accept-p4.mjs'), '--host'], { cwd: root, env, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); child.stderr.on('data', () => {}); return child }
async function hostIpc(child, method) { const id = randomUUID(); assert(child.connected && child.exitCode === null); return new Promise((done, fail) => { const finish = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited) }; const receive = message => { if (message?.kind === 'channel-acceptance' && message.id === id) { finish(); message.ok ? done(message.value) : fail(new Error('Host IPC rejected ' + method)) } }; const exited = () => { finish(); fail(new Error('Host exited during IPC')) }; const timer = setTimeout(() => { finish(); fail(new Error('Host IPC timeout')) }, 20_000); child.on('message', receive); child.once('exit', exited); child.send({ kind: 'channel-acceptance', id, method }, error => { if (error) { finish(); fail(error) } }) }) }
async function hostRequest(origin, session, path, method = 'GET', body) { const response = await fetch(origin + path, { method, headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) }); const raw = await response.text(); return { status: response.status, body: raw ? JSON.parse(raw) : null, cookie: response.headers.get('set-cookie') } }
async function stopHost(child) { if (!child?.pid) return; if (alive(child.pid)) process.kill(-child.pid, 'SIGTERM'); await until(() => !alive(child.pid), 'Host normal exit'); await until(() => !alive(-child.pid), 'Host process group exit') }
function percentile(values, p) { assert(values.length); const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * p / 100) - 1] }
function idleReadings(readings, ticksPerSecond) {
  assert(readings.length >= 2 && Number.isSafeInteger(ticksPerSecond) && ticksPerSecond > 0, 'idle sampling is incomplete')
  const first = readings[0], last = readings.at(-1), identities = value => [value.parent, ...value.children].map(item => item.pid + ':' + item.starttime).sort()
  assert(first.complete && first.parent && first.exitedDuringSample.length === 0, 'idle owned process tree is incomplete or changed')
  const expected = identities(first)
  for (const reading of readings) {
    assert(reading.complete && reading.parent && reading.exitedDuringSample.length === 0, 'idle owned process tree is incomplete or changed')
    assert.deepEqual(identities(reading), expected, 'owned process topology changed during idle window')
    const started = BigInt(reading.sampleMonoStartNs), finished = BigInt(reading.sampleMonoEndNs)
    assert(finished >= started && reading.sampleSpanMs >= 0, 'owned sample clock moved backward')
    for (const item of [reading.parent, ...reading.children]) {
      const at = BigInt(item.statReadMonoNs)
      assert(at >= started && at <= finished, 'owned stat read is outside sample span')
    }
  }
  let idleCpuCores = 0
  for (const id of expected) {
    const nodes = readings.map(reading => [reading.parent, ...reading.children].find(item => item.pid + ':' + item.starttime === id))
    for (let index = 1; index < nodes.length; index++) {
      assert(nodes[index].cpuTicks >= nodes[index - 1].cpuTicks, 'owned CPU ticks moved backward')
      assert(BigInt(nodes[index].statReadMonoNs) > BigInt(nodes[index - 1].statReadMonoNs), 'owned stat read clock did not advance')
    }
    const elapsed = Number(BigInt(nodes.at(-1).statReadMonoNs) - BigInt(nodes[0].statReadMonoNs)) / 1e9
    idleCpuCores += (nodes.at(-1).cpuTicks - nodes[0].cpuTicks) / ticksPerSecond / elapsed
  }
  return { durationMs: Number(BigInt(last.sampleMonoEndNs) - BigInt(first.sampleMonoEndNs)) / 1e6,
    peakRssKiB: Math.max(...readings.map(item => item.totalRssKiB)), peakFds: Math.max(...readings.map(item => item.totalFds)), idleCpuCores }
}

async function idleTree(stage, pid, durationMs) {
  const readings = [], start = performance.now()
  while (performance.now() - start < durationMs) { readings.push(await sample(stage, pid)); await sleep(100) }
  const ticksPerSecond = Number((await command('getconf', ['CLK_TCK'])).trim())
  return { stage, sampleCount: readings.length, ...idleReadings(readings, ticksPerSecond), first: readings[0], last: readings.at(-1) }
}
