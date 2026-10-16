import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { recoverActionFacts } from '../src/work-service.mjs'
import { resolveCredentialFile } from '../src/execution-grant.mjs'
import { KIVO_EVENT_SOURCES_FILE, KIVO_EVENT_TRIGGER, readKivoEventSources } from '../src/kivo-events.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const root = dirname(dirname(scriptPath))
const command = process.argv[2]
const args = parseArgs(process.argv.slice(3))
const MANIFEST_VERSION = 2
const STATE_PATH = 'state.json'
const SESSION_PATH = /^dsh\/sessions\/[^/]+\/([^/]+)\/session\.v[1-9]\d*\.jsonl(?:\.(?:gz|zstd))?$/
const ACTIVE_STATUS = new Set(['accepted', 'running', 'cancel_requested'])

if (resolve(process.argv[1] ?? '') === scriptPath) {
  if (command === 'backup') await backup(args.output, args)
  else if (command === 'restore') await restore(args.input, args.dataRoot, args)
  else {
    console.error('用法：node scripts/state-transfer.mjs backup --output <空目录> [--secret-output <独立空目录> --secret-root <秘密根>] | restore --input <备份目录> --data-root <空目录> [--secret-input <秘密包> --secret-root <独立空目录>]')
    process.exitCode = 2
  }
}

async function backup(outputArg, options = {}) {
  if (!outputArg) throw new Error('backup 需要 --output')
  const output = resolve(outputArg)
  const statePath = resolve(process.env.GENEWAY_STATE ?? join(root, 'var', STATE_PATH))
  const dataRoot = dirname(statePath)
  const dshHome = resolve(process.env.GENEWAY_DSH_HOME ?? join(root, 'var', 'dsh'))
  const target = await emptyTarget(output)
  await requireNoSymlinkComponents(output, '备份输出路径')
  const secretPaths = await secretOptions(options, 'backup', [output, statePath, dshHome])
  const opened = []
  try {
    const stateFile = await openRegular(statePath)
    opened.push(stateFile)
    const sourceStateBuffer = await readFileFromStart(stateFile.handle)
    const sourceState = parseState(sourceStateBuffer, { versions: [STATE_VERSION] })
    const sourceHash = digest(sourceStateBuffer)
    const eventSources = await readKivoEventSources(dataRoot)
    requireEventSources(sourceState, eventSources.sources)
    const createdAt = new Date().toISOString()
    const state = interruptActiveForBackup(sourceState, createdAt)
    migrateState(structuredClone(state))
    const stateBuffer = state === sourceState ? sourceStateBuffer : Buffer.from(JSON.stringify(state, null, 2) + '\n')
    const sessionRefs = collectSessionRefs(state)
    const files = [{ path: STATE_PATH, buffer: stateBuffer, bytes: stateBuffer.length, sha256: digest(stateBuffer) }]
    if (eventSources.buffer !== null) files.push({ path: KIVO_EVENT_SOURCES_FILE, buffer: eventSources.buffer, bytes: eventSources.buffer.length, sha256: eventSources.sha256 })
    const sessionsRoot = join(dshHome, 'sessions')
    if (await pathExists(dshHome)) await requireDirectory(dshHome, 'DSH 根目录')
    if (await pathExists(sessionsRoot)) {
      await requireDirectory(sessionsRoot, 'DSH Session 根目录')
      for (const source of await filesUnder(sessionsRoot)) {
        const path = `dsh/sessions/${relative(sessionsRoot, source).split(sep).join('/')}`
        const match = SESSION_PATH.exec(path)
        if (!match || !sessionRefs.includes(match[1])) continue
        const file = await openRegular(source)
        opened.push(file)
        files.push({ path, file, bytes: file.stat.size, sha256: await sha256(file.handle) })
      }
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const includedSessionRefs = [...new Set(files.flatMap(item => SESSION_PATH.exec(item.path)?.[1] ?? []))].sort()
    const missing = sessionRefs.filter(id => !includedSessionRefs.includes(id))
    if (missing.length) throw new Error(`缺少关联 DSH Session：${missing.join(', ')}`)
    const manifest = {
      format: 'geneway-state-transfer',
      version: MANIFEST_VERSION,
      createdAt,
      candidate: candidate(),
      schema: schemaSummary(state, sessionRefs),
      entries: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    }
    let secrets
    if (secretPaths) {
      // Reopen the live path: the original descriptor can point at a pre-rename state inode.
      await unchangedState(statePath, sourceHash)
      await unchangedSources(dataRoot, eventSources.sha256)
      secrets = await openSecrets(secretPaths.root, collectSecretRefs(state, eventSources.sources), opened)
      await unchangedState(statePath, sourceHash)
      await unchangedSources(dataRoot, eventSources.sha256)
    }
    await buildAndPublish(output, target, async stage => {
      for (const file of files) await copyOpenFile(file, join(stage, ...file.path.split('/')))
      const manifestPath = join(stage, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      await chmod(manifestPath, 0o600)
      await verifyBuilt(stage, manifest.entries)
      await unchangedSources(dataRoot, eventSources.sha256)
    })
    if (secretPaths) {
      try {
        await unchangedState(statePath, sourceHash)
        await unchangedSources(dataRoot, eventSources.sha256)
        await publishSecrets(secretPaths.package, secretPaths.target, secrets, { stateSha256: digest(stateBuffer), sourcesSha256: eventSources.sha256, createdAt }, dataRoot)
      } catch (cause) { throw new Error('普通备份已写入，秘密包未完成；请使用新目标重新制作配对备份', { cause }) }
    }
    console.log(JSON.stringify({ command: 'backup', output, entries: files.length, bytes: files.reduce((total, item) => total + item.bytes, 0), sessionRefs: includedSessionRefs.length }))
  } finally {
    await Promise.allSettled(opened.map(item => item.handle.close()))
  }
}

async function restore(inputArg, dataRootArg, options = {}) {
  if (!inputArg || !dataRootArg) throw new Error('restore 需要 --input 和 --data-root')
  const input = resolve(inputArg)
  const dataRoot = resolve(dataRootArg)
  if (overlaps(input, dataRoot)) throw new Error('备份目录与恢复目录不得重叠')
  await requireDirectory(input, '备份根目录')
  const target = await emptyTarget(dataRoot)
  await requireNoSymlinkComponents(input, '备份路径')
  await requireNoSymlinkComponents(dataRoot, '恢复路径')
  const secretPaths = await secretOptions(options, 'restore', [input, dataRoot])
  const opened = []
  try {
    const manifestFile = await openRegularPath(input, 'manifest.json')
    opened.push(manifestFile)
    const manifest = parseManifest(await readFileFromStart(manifestFile.handle))
    const seen = new Set()
    const files = []
    for (const entry of manifest.entries) {
      validateEntry(entry)
      const path = safeRelative(entry.path)
      if (seen.has(path)) throw new Error(`备份 entry 重复：${path}`)
      seen.add(path)
      if (path !== STATE_PATH && path !== KIVO_EVENT_SOURCES_FILE && !SESSION_PATH.test(path)) throw new Error(`备份路径不在允许范围：${path}`)
      const file = await openRegularPath(input, path)
      opened.push(file)
      const actualHash = await sha256(file.handle)
      if (file.stat.size !== entry.bytes || actualHash !== entry.sha256) throw new Error(`备份校验失败：${entry.path}`)
      files.push({ ...entry, path, file })
    }
    if (!seen.has(STATE_PATH)) throw new Error('备份缺少 state.json')
    const stateFile = files.find(item => item.path === STATE_PATH)
    const sourceStateBuffer = await readFileFromStart(stateFile.file.handle)
    const sourceState = parseState(sourceStateBuffer, { versions: [4, 5, 6, 7, 8, 9, 10, 11, STATE_VERSION], migrate: false })
    const eventSources = await readKivoEventSources(input)
    if (eventSources.sha256 !== (files.find(file => file.path === KIVO_EVENT_SOURCES_FILE)?.sha256 ?? null)) throw new Error('备份事件来源未列入 manifest 或摘要不匹配')
    requireEventSources(sourceState, eventSources.sources)
    const secrets = secretPaths ? await verifySecretPackage(secretPaths.package, { stateSha256: digest(sourceStateBuffer), sourcesSha256: eventSources.sha256 }, collectSecretRefs(sourceState, eventSources.sources), opened) : undefined
    const sessionRefs = collectSessionRefs(sourceState)
    const expectedSchema = schemaSummary(sourceState, sessionRefs)
    if (JSON.stringify(manifest.schema) !== JSON.stringify(expectedSchema)) throw new Error('备份 schema 摘要不匹配')
    for (const file of files) {
      const match = SESSION_PATH.exec(file.path)
      if (match && !sessionRefs.includes(match[1])) throw new Error(`备份包含未关联 DSH Session：${match[1]}`)
    }
    const includedSessionRefs = [...new Set(files.flatMap(item => SESSION_PATH.exec(item.path)?.[1] ?? []))].sort()
    const missing = sessionRefs.filter(id => !includedSessionRefs.includes(id))
    if (missing.length) throw new Error(`备份缺少关联 DSH Session：${missing.join(', ')}`)

    const state = prepareRestoredState(sourceState)
    assertNoSecretKeys(state)
    const restoredStateBuffer = Buffer.from(JSON.stringify(state, null, 2) + '\n')
    const restoredSourcesBuffer = Buffer.from(JSON.stringify({ version: 1, sources: eventSources.sources.map(source => ({ ...source, enabled: false })) }, null, 2) + '\n')
    const restoredEntries = files.map(file => file.path === STATE_PATH
      ? { path: STATE_PATH, buffer: restoredStateBuffer, bytes: restoredStateBuffer.length, sha256: digest(restoredStateBuffer) }
      : file.path === KIVO_EVENT_SOURCES_FILE
        ? { path: KIVO_EVENT_SOURCES_FILE, buffer: restoredSourcesBuffer, bytes: restoredSourcesBuffer.length, sha256: digest(restoredSourcesBuffer) }
        : file)

    // All manifest, path, type, byte, hash, source schema and migration checks finish before the first target byte is written.
    await buildAndPublish(dataRoot, target, async stage => {
      for (const file of restoredEntries) await copyOpenFile(file, join(stage, ...file.path.split('/')))
      await verifyBuilt(stage, restoredEntries)
    })
    if (secretPaths) {
      try { await buildAndPublish(secretPaths.root, secretPaths.target, async stage => {
        const entries = secrets.map(file => ({ ...file, path: basename(file.path) }))
        for (const file of entries) await copyOpenFile(file, join(stage, file.path))
        await verifyBuilt(stage, entries)
      }) } catch (cause) { throw new Error('产品状态已恢复且外部收发关闭，秘密恢复未完成；请使用新目标重新恢复配对备份', { cause }) }
    }
    console.log(JSON.stringify({ command: 'restore', input, dataRoot, entries: files.length, sessionRefs: includedSessionRefs.length }))
  } finally {
    await Promise.allSettled(opened.map(item => item.handle.close()))
  }
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--') continue
    if (!key.startsWith('--') || typeof argv[index + 1] !== 'string') continue
    result[key.slice(2).replaceAll('-', '')] = argv[++index]
  }
  return { output: result.output, input: result.input, dataRoot: result.dataroot, secretOutput: result.secretoutput, secretInput: result.secretinput, secretRoot: result.secretroot }
}

function parseState(buffer, { versions, migrate = true } = {}) {
  let state
  try { state = JSON.parse(buffer.toString('utf8')) } catch { throw new Error('产品状态 JSON 无效') }
  if (!record(state) || !versions?.includes(state.version)) throw new Error(`产品状态版本不受支持：${state?.version ?? 'unknown'}`)
  const normalized = migrateState(structuredClone(state))
  assertNoSecretKeys(state)
  return migrate ? normalized : state
}

function interruptActiveForBackup(state, interruptedAt) {
  let changed = false
  const activeTrees = new Set(state.works.filter(work => work.collaboration && (
    ACTIVE_STATUS.has(work.status)
    || ACTIVE_STATUS.has(work.collaboration.status)
    || work.executions.some(execution => ACTIVE_STATUS.has(execution.status))
    || state.works.some(child => child.rootWorkId === work.id && (ACTIVE_STATUS.has(child.status) || child.executions.some(execution => ACTIVE_STATUS.has(execution.status))))
  )).map(work => work.id))
  const interruptibleChildren = new Set(state.works.filter(work => activeTrees.has(work.id)).flatMap(work =>
    work.plan.items.filter(item => ['not_started', 'running', 'waiting_input'].includes(item.status)).map(item => item.childWorkId)))
  const works = state.works.map(work => {
    const executions = work.executions.map(execution => {
      if (!ACTIVE_STATUS.has(execution.status)) return execution
      changed = true
      return { ...execution, status: 'interrupted', interruptedAt, error: { code: 'BACKUP_INTERRUPTED', message: '备份时执行未完成' } }
    })
    if (activeTrees.has(work.id)) {
      changed = true
      return {
        ...work,
        status: 'interrupted',
        executions,
        collaboration: { ...work.collaboration, status: 'interrupted', summaryResultRefs: [] },
        plan: { ...work.plan, items: work.plan.items.map(item => ['not_started', 'running', 'waiting_input'].includes(item.status) ? { ...item, status: 'interrupted' } : item) },
      }
    }
    if (activeTrees.has(work.rootWorkId)) return interruptibleChildren.has(work.id) ? { ...work, status: 'interrupted', executions } : work
    if (!ACTIVE_STATUS.has(work.status) && executions.every((execution, index) => execution === work.executions[index])) return work
    changed = true
    return { ...work, status: 'interrupted', executions }
  })
  const conversations = (state.conversations ?? []).map(conversation => {
    const next = interruptConversation(conversation, interruptedAt)
    if (next !== conversation) changed = true
    return next
  })
  return changed ? { ...state, works, ...(state.version >= 9 ? { conversations } : {}) } : state
}

export function prepareRestoredState(sourceState, timestamp = new Date().toISOString()) {
  const state = sourceState.version === STATE_VERSION ? structuredClone(sourceState) : migrateState(structuredClone(sourceState))
  const closingLinks = new Set(state.linkCodes.filter(link => ['active', 'matched'].includes(link.status)).map(link => link.id))
  const identityIds = new Set(state.linkCodes.filter(link => closingLinks.has(link.id)).map(link => link.matchedIdentityId).filter(Boolean))
  const rebindIds = new Set(state.channelIdentities.filter(identity => identity.status !== 'unlinked' && (identity.weixin || identityIds.has(identity.id) && identity.status === 'pending')).map(identity => identity.id))
  return migrateState(recoverActionFacts({
    ...state,
    conversations: state.conversations.map(conversation => interruptConversation(conversation, timestamp)),
    automationRules: state.automationRules.map(rule => rule.status === 'active'
      ? { ...rule, status: 'paused', revision: rule.revision + 1, updatedAt: timestamp }
      : rule),
    automationInbox: state.automationInbox.map(entry => ({ ...entry, targets: entry.targets.map(target => target.status === 'pending'
      ? { ...target, status: 'restore-suppressed', reason: 'restore-suppressed', occurrenceId: null }
      : target) })),
    channelApps: state.channelApps.map(app => app.enabled || app.status !== 'disabled'
      ? { ...app, enabled: false, status: 'disabled', revision: app.revision + 1, updatedAt: timestamp }
      : app),
    channelIdentities: state.channelIdentities.map(identity => rebindIds.has(identity.id) && identity.status !== 'rebind-required'
      ? { ...identity, status: 'rebind-required', activeConversationId: null, revision: identity.revision + 1, updatedAt: timestamp,
        ...(identity.weixin ? { weixin: { ...identity.weixin, runtimeState: 'unavailable', error: { code: 'RESTORE_REBIND_REQUIRED' } } } : {}),
      }
      : identity),
    channelConversations: state.channelConversations.map(conversation => rebindIds.has(conversation.identityId) && ['active', 'pending'].includes(conversation.status)
      ? { ...conversation, status: 'rebind-required', revision: conversation.revision + 1, updatedAt: timestamp }
      : conversation),
    deliveries: state.deliveries.map(delivery => delivery.status === 'sending'
      ? { ...delivery, status: 'unknown', error: { code: 'RECOVERY_UNKNOWN', message: '发送效果待核对' }, updatedAt: timestamp }
      : delivery.status === 'pending' && rebindIds.has(delivery.targetIdentityId)
        ? { ...delivery, status: 'blocked', error: { code: 'RESTORE_REBIND_REQUIRED', message: '恢复后请重新绑定渠道身份' }, updatedAt: timestamp }
        : delivery),
    linkCodes: state.linkCodes.map(link => closingLinks.has(link.id) ? { ...link, status: 'cancelled', error: { code: 'RESTORE_BINDING_CLOSED', message: '恢复后请重新绑定渠道身份' }, updatedAt: timestamp } : link),
  }, timestamp))
}

function interruptConversation(conversation, interruptedAt) {
  if (!conversation.turns.some(turn => ACTIVE_STATUS.has(turn.status))) return conversation
  return { ...conversation, updatedAt: interruptedAt, turns: conversation.turns.map(turn => ACTIVE_STATUS.has(turn.status)
    ? { ...turn, status: 'interrupted', completedAt: interruptedAt, error: { code: 'BACKUP_INTERRUPTED', message: '备份时回复未完成' } } : turn) }
}

function parseManifest(buffer) {
  let value
  try { value = JSON.parse(buffer.toString('utf8')) } catch { throw new Error('备份 manifest JSON 无效') }
  if (!record(value) || Object.keys(value).sort().join(',') !== 'candidate,createdAt,entries,format,schema,version' || value.format !== 'geneway-state-transfer' || value.version !== MANIFEST_VERSION || !Array.isArray(value.entries) || !record(value.schema) || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)) throw new Error('备份 manifest 无效')
  if (value.candidate !== null && (typeof value.candidate !== 'string' || !/^[A-Za-z0-9._/-]{1,128}$/.test(value.candidate))) throw new Error('备份 candidate 无效')
  return value
}

function validateEntry(entry) {
  if (!record(entry) || Object.keys(entry).sort().join(',') !== 'bytes,path,sha256') throw new Error('备份 entry 无效')
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`备份 entry 元数据无效：${entry.path ?? ''}`)
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || posix.isAbsolute(value) || posix.normalize(value) !== value || value === '..' || value.startsWith('../')) throw new Error('备份路径越界')
  return value
}

function collectSessionRefs(state) {
  const refs = new Set()
  visit(state.works ?? [], (key, value) => {
    if ((key === 'dshSessionRef' || key === 'continuedFromDshSessionRef') && typeof value === 'string' && value.trim()) refs.add(value)
  })
  for (const conversation of state.conversations ?? []) for (const session of conversation.sessions) refs.add(session.id)
  return [...refs].sort()
}

function requireEventSources(state, sources) {
  const ids = new Set(sources.map(source => source.id))
  const required = new Set((state.automationRules ?? []).filter(rule => rule.capabilityId === 'kivo-tpm-record-read' && rule.trigger.kind === KIVO_EVENT_TRIGGER && rule.status !== 'revoked').map(rule => rule.trigger.sourceId))
  for (const entry of state.automationInbox ?? []) if (entry.targets.some(target => target.status === 'pending')) required.add(entry.event.sourceId)
  if ([...required].some(id => !ids.has(id))) throw new Error('可恢复事件规则或待处理目标缺少事件来源配置')
}

function collectSecretRefs(state, sources = []) {
  const refs = new Set()
  const add = ref => {
    if (ref === null || ref === undefined) return
    if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref) || ref === '.' || ref === '..') throw new Error('秘密引用无效')
    refs.add(ref)
  }
  for (const key of ['modelRoutes', 'connections', 'channelApps']) for (const item of state[key] ?? []) add(item.credentialRef)
  for (const identity of state.channelIdentities ?? []) if (identity.weixin) for (const key of ['tokenRef', 'cursorRef', 'contextRef']) add(identity.weixin[key])
  // QR references are allocated before login; only the published challenge exists at this stage.
  for (const link of state.linkCodes ?? []) if (link.kind === 'weixin-qr' && link.qrcodeUrl) add(link.loginRef)
  for (const source of sources) add(source.signingSecretRef)
  return [...refs].sort()
}

async function secretOptions(options, mode, ordinaryPaths) {
  const packageArg = mode === 'backup' ? options.secretOutput : options.secretInput
  if (mode === 'backup' && options.secretInput !== undefined || mode === 'restore' && options.secretOutput !== undefined) throw new Error('秘密包参数不适用于当前命令')
  if (packageArg === undefined && options.secretRoot === undefined) return undefined
  if (typeof packageArg !== 'string' || !packageArg.trim() || typeof options.secretRoot !== 'string' || !options.secretRoot.trim()) throw new Error('秘密包与 --secret-root 必须同时显式提供')
  const packagePath = resolve(packageArg), secretRoot = resolve(options.secretRoot)
  const paths = [...ordinaryPaths, packagePath, secretRoot]
  for (let left = 0; left < paths.length; left += 1) for (let right = left + 1; right < paths.length; right += 1) {
    if ((left >= ordinaryPaths.length || right >= ordinaryPaths.length) && overlaps(paths[left], paths[right])) throw new Error('秘密包、秘密根与普通数据路径不得重叠')
  }
  await requireNoSymlinkComponents(packagePath, '秘密包路径')
  await requireNoSymlinkComponents(secretRoot, '秘密根路径')
  const outputPath = mode === 'backup' ? packagePath : secretRoot
  const inputPath = mode === 'backup' ? secretRoot : packagePath
  await requirePrivateDirectory(inputPath)
  const target = await emptyTarget(outputPath)
  if (target.exists) await requirePrivateDirectory(outputPath)
  return { package: packagePath, root: secretRoot, target }
}

async function requirePrivateDirectory(path) {
  await requireDirectory(path, '受限秘密目录')
  const metadata = await lstat(path)
  if (metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o700) throw new Error('秘密目录必须由当前用户持有且权限为 0700')
}

function requirePrivateFile(file) {
  if (file.stat.uid !== process.getuid() || (file.stat.mode & 0o077) !== 0) throw new Error('秘密文件权限不安全')
}

async function unchangedState(statePath, expectedHash) {
  const current = await openRegular(statePath)
  try { if (await sha256(current.handle) !== expectedHash) throw new Error('秘密备份期间产品状态已变化，请重新备份') }
  finally { await current.handle.close() }
}

async function unchangedSources(dataRoot, expectedHash) {
  if ((await readKivoEventSources(dataRoot)).sha256 !== expectedHash) throw new Error('事件来源配置在备份期间变化，请重新备份')
}

async function openSecrets(secretRoot, refs, opened) {
  const files = []
  for (const ref of refs) {
    const source = await resolveCredentialFile(secretRoot, ref)
    const file = await openRegular(source)
    opened.push(file)
    requirePrivateFile(file)
    files.push({ path: `secrets/${ref}`, bytes: file.stat.size, sha256: await sha256(file.handle), file })
  }
  return files
}

async function publishSecrets(packagePath, target, files, { stateSha256, sourcesSha256, createdAt }, dataRoot) {
  const manifest = { format: 'geneway-secret-transfer', version: sourcesSha256 === null ? 1 : 2, createdAt, stateSha256, ...(sourcesSha256 === null ? {} : { sourcesSha256 }), entries: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) }
  await buildAndPublish(packagePath, target, async stage => {
    for (const file of files) await copyOpenFile(file, join(stage, ...file.path.split('/')))
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await verifyBuilt(stage, manifest.entries)
    await unchangedSources(dataRoot, sourcesSha256)
  })
}

async function verifySecretPackage(packagePath, { stateSha256, sourcesSha256 }, refs, opened) {
  const manifestFile = await openRegularPath(packagePath, 'manifest.json')
  opened.push(manifestFile)
  requirePrivateFile(manifestFile)
  let manifest
  try { manifest = JSON.parse((await readFileFromStart(manifestFile.handle)).toString('utf8')) } catch { throw new Error('秘密包 manifest JSON 无效') }
  const keys = sourcesSha256 === null ? 'createdAt,entries,format,stateSha256,version' : 'createdAt,entries,format,sourcesSha256,stateSha256,version'
  if (!record(manifest) || Object.keys(manifest).sort().join(',') !== keys
    || manifest.format !== 'geneway-secret-transfer' || manifest.version !== (sourcesSha256 === null ? 1 : 2) || manifest.stateSha256 !== stateSha256
    || sourcesSha256 !== null && manifest.sourcesSha256 !== sourcesSha256
    || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.entries)) throw new Error('秘密包与普通备份不匹配')
  const paths = manifest.entries.map(entry => { validateEntry(entry); return safeRelative(entry.path) })
  if (JSON.stringify(paths) !== JSON.stringify(refs.map(ref => `secrets/${ref}`))) throw new Error('秘密包引用集合与产品状态不匹配')
  if (refs.length) await requirePrivateDirectory(join(packagePath, 'secrets'))
  const files = []
  for (const entry of manifest.entries) {
    const file = await openRegularPath(packagePath, entry.path)
    opened.push(file)
    requirePrivateFile(file)
    if (file.stat.size !== entry.bytes || await sha256(file.handle) !== entry.sha256) throw new Error('秘密包文件校验失败')
    files.push({ ...entry, file })
  }
  return files
}

function visit(value, inspect, key = '') {
  inspect(key, value)
  if (Array.isArray(value)) for (const item of value) visit(item, inspect)
  else if (record(value)) for (const [childKey, child] of Object.entries(value)) visit(child, inspect, childKey)
}

function assertNoSecretKeys(state) {
  visit(state, (key, value) => {
    const compact = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
    if (compact === 'authorizationrevisions') {
      if (record(value)
        && Object.keys(value).sort().join(',') === 'app,conversation,identity'
        && Object.values(value).every(item => Number.isSafeInteger(item) && item > 0)) return
      throw new Error(`产品状态包含秘密字段：${key}`)
    }
    if (!compact || ['authref', 'credentialref', 'secretref', 'authorizationbasis'].includes(compact)) return
    if (/password|verifier|secret|token$|cookie|grant|apikey|apisecret|hmac|claude|credential|^auth/.test(compact)) throw new Error(`产品状态包含秘密字段：${key}`)
  })
}

function schemaSummary(state, sessionRefs) {
  const count = key => Array.isArray(state[key]) ? state[key].length : 0
  return {
    stateVersion: state.version,
    members: count('members'),
    modelRoutes: count('modelRoutes'),
    employees: count('employees'),
    connections: count('connections'),
    skills: count('skills'),
    confirmations: count('confirmations'),
    ...(state.version >= 5 ? { knowledgeMaterials: count('knowledgeMaterials') } : {}),
    ...(state.version >= 6 ? {
      channelApps: count('channelApps'),
      channelIdentities: count('channelIdentities'),
      channelConversations: count('channelConversations'),
      channelMessages: count('channelMessages'),
      deliveries: count('deliveries'),
      linkCodes: count('linkCodes'),
    } : {}),
    ...(state.version >= 7 ? {
      automationRules: count('automationRules'),
      automationOccurrences: count('automationOccurrences'),
    } : {}),
    ...(state.version >= 9 ? { conversations: count('conversations') } : {}),
    works: count('works'),
    sessionRefs,
  }
}

function candidate() {
  const value = process.env.GENEWAY_CANDIDATE?.trim()
  if (!value) return null
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(value)) throw new Error('GENEWAY_CANDIDATE 无效')
  return value
}

async function emptyTarget(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`目标根目录不得是符号链接：${path}`)
    if (!info.isDirectory()) throw new Error(`目标必须是目录：${path}`)
    if ((await readdir(path)).length) throw new Error(`目标目录必须为空：${path}`)
    return { exists: true, mode: info.mode & 0o777 }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    throw error
  }
}

async function requireDirectory(path, label) {
  let info
  try { info = await lstat(path) } catch (error) { if (error?.code === 'ENOENT') throw new Error(`${label}不存在：${path}`); throw error }
  if (info.isSymbolicLink()) throw new Error(`${label}不得是符号链接：${path}`)
  if (!info.isDirectory()) throw new Error(`${label}不是目录：${path}`)
}

async function requireNoSymlinkComponents(path, label) {
  const parts = resolve(path).split(sep).filter(Boolean)
  let cursor = sep
  for (const part of parts) {
    cursor = join(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`${label}不得经过符号链接：${cursor}`)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

async function openRegular(path) {
  const before = await lstat(path)
  if (before.isSymbolicLink()) throw new Error(`备份源不得是符号链接：${path}`)
  if (!before.isFile()) throw new Error(`备份源不是普通文件：${path}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error(`备份源在校验期间变化：${path}`)
    return { handle, stat }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function openRegularPath(rootPath, relativePath) {
  const path = safeRelative(relativePath)
  let cursor = rootPath
  const parts = path.split('/')
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = join(cursor, parts[index])
    await requireDirectory(cursor, '备份路径目录')
  }
  return openRegular(join(rootPath, ...parts))
}

async function filesUnder(path) {
  const files = []
  for (const entry of await readdir(path)) {
    const child = join(path, entry)
    const info = await lstat(child)
    if (info.isSymbolicLink()) throw new Error(`DSH Session 路径不得是符号链接：${child}`)
    if (info.isDirectory()) files.push(...await filesUnder(child))
    else if (info.isFile()) files.push(child)
    else throw new Error(`DSH Session 路径必须是普通文件或目录：${child}`)
  }
  return files
}

async function buildAndPublish(targetPath, target, build) {
  const parent = dirname(targetPath)
  await mkdir(parent, { recursive: true })
  const stage = await mkdtemp(join(parent, `.${basename(targetPath)}.transfer-`))
  await chmod(stage, 0o700)
  let published = false
  let removedTarget = false
  try {
    await build(stage)
    if (target.exists) {
      await rmdir(targetPath)
      removedTarget = true
    }
    try {
      await rename(stage, targetPath)
      published = true
    } catch (error) {
      if (removedTarget) {
        await mkdir(targetPath, { mode: target.mode })
        await chmod(targetPath, target.mode)
      }
      throw error
    }
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true })
  }
}

async function copyOpenFile(file, destination) {
  await secureMkdir(dirname(destination))
  if (file.buffer) await writeFile(destination, file.buffer, { flag: 'wx', mode: 0o600 })
  else await pipeline(
    file.file.handle.createReadStream({ start: 0, autoClose: false }),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  )
  await chmod(destination, 0o600)
}

async function secureMkdir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function verifyBuilt(stage, entries) {
  for (const entry of entries) {
    const file = await openRegularPath(stage, entry.path)
    try {
      if ((file.stat.mode & 0o777) !== 0o600 || file.stat.size !== entry.bytes || await sha256(file.handle) !== entry.sha256) throw new Error(`写入后校验失败：${entry.path}`)
    } finally {
      await file.handle.close()
    }
  }
}

async function readFileFromStart(handle) {
  const chunks = []
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function sha256(handle) {
  const hash = createHash('sha256')
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk)
  return hash.digest('hex')
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function pathExists(path) {
  try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

function overlaps(left, right) {
  const relation = relative(left, right)
  const reverse = relative(right, left)
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..') || (!reverse.startsWith(`..${sep}`) && reverse !== '..')
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
