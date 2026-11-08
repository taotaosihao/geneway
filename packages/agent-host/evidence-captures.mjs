import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createArtifactFiles } from '../../src/artifact-files.mjs'
import { binding, digest, error, exact, key, sameBinding } from '../agent-contracts/index.mjs'
import { EVIDENCE_CAPABILITIES, evidenceCheck as check, evidenceReaders, evidenceRef, evidenceDeclaration, evidenceDeclarationDigest, hashValue, timestamp, validateEvidenceBytes, validateSite, validateSiteEvents } from '../agent-contracts/evidence.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function validateCaptures(state) {
  check(Array.isArray(state.captures) && state.captures.length <= 10000 && new Set(state.captures.map(row => row.id)).size === state.captures.length)
  for (const row of state.captures) {
    check(/^[a-f0-9]{32}$/.test(row.id) && ['accepted', 'sealed', 'published', 'failed'].includes(row.state) && state.executions.some(execution => sameBinding(execution, row.producerBinding)))
    if (row.captureFormatVersion !== undefined) { check(row.captureFormatVersion === 2 && hashValue(row.profileDigest)); if (['sealed', 'published'].includes(row.state)) check(row.declarationDigest === evidenceDeclarationDigest(evidenceDeclaration(row))) }
  }
}
export function assertCapturesImmutable(before, after) {
  for (const row of before.captures) {
    const next = after.captures.find(item => item.id === row.id), fixed = value => Object.fromEntries(Object.entries(value).filter(([field]) => !['state', 'sourceSha256', 'snapshotSha256', 'sizeBytes', 'sourceTimestamp', 'sealedAt', 'declarationDigest', 'evidenceRef', 'reason'].includes(field)))
    check(next && isDeepStrictEqual(fixed(row), fixed(next)))
    if (['sealed', 'published'].includes(row.state)) for (const field of ['sourceSha256', 'snapshotSha256', 'sizeBytes', 'sourceTimestamp', 'sealedAt', 'declarationDigest']) check(isDeepStrictEqual(row[field], next[field]))
    if (row.state === 'published' || row.state === 'failed') check(isDeepStrictEqual(row, next))
  }
}
export function evidenceProfile(value) {
  exact(value, ['profileVersion', 'resources']); check(Number.isSafeInteger(value.profileVersion) && value.profileVersion > 0 && Array.isArray(value.resources) && value.resources.length <= 32)
  const resources = value.resources.map(row => {
    exact(row, ['resourceId', 'capabilityIds', 'adapterKind', 'root', 'datasets', 'fixedFiles', 'allowedSections', 'maxBytes', 'maxEntries', 'maxWindowSeconds', 'exportToAgentIds', 'clockTrust'])
    check(typeof row.resourceId === 'string' && row.resourceId.length > 0 && row.resourceId.length <= 16000 && ['history_json', 'site_snapshot_json'].includes(row.adapterKind) && typeof row.root === 'string' && row.root === resolve(row.root))
    check(Array.isArray(row.capabilityIds) && row.capabilityIds.every(capability => Object.values(EVIDENCE_CAPABILITIES).includes(capability)) && Number.isSafeInteger(row.maxBytes) && row.maxBytes > 0 && row.maxBytes <= 65536 && Number.isSafeInteger(row.maxEntries) && row.maxEntries > 0 && row.maxEntries <= 200 && Number.isSafeInteger(row.maxWindowSeconds) && row.maxWindowSeconds >= 1 && row.maxWindowSeconds <= 86400 && ['fixture', 'verified', 'unknown'].includes(row.clockTrust))
    const mapping = row.adapterKind === 'history_json' ? row.datasets : row.fixedFiles
    check(mapping && typeof mapping === 'object' && !Array.isArray(mapping) && Object.keys(mapping).length <= 32 && Object.entries(mapping).every(([id, file]) => /^[A-Za-z0-9._-]{1,128}$/.test(id) && typeof file === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(file) && file !== '.' && file !== '..'))
    check(Array.isArray(row.allowedSections) && row.allowedSections.every(section => ['collector_health', 'recent_events'].includes(section)))
    return { ...structuredClone(row), exportToAgentIds: evidenceReaders(row.exportToAgentIds ?? []) }
  })
  check(new Set(resources.map(row => row.resourceId)).size === resources.length)
  return { profileVersion: value.profileVersion, resources }
}
async function sourceBytes(root, name, maxBytes) {
  let cursor = sep
  for (const part of root.split(sep).filter(Boolean)) { cursor = join(cursor, part); const stat = await lstat(cursor); check(stat.isDirectory() && !stat.isSymbolicLink(), '资料目录不可经过符号链接') }
  const path = join(root, name), stat = await lstat(path); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, '资料文件无效或超限')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const before = await handle.stat(); check(before.ino === stat.ino && before.dev === stat.dev && before.isFile() && before.size <= maxBytes); const bytes = await handle.readFile(), after = await handle.stat(); check(bytes.length <= maxBytes && before.size === after.size && before.mtimeMs === after.mtimeMs); return bytes } finally { await handle.close() }
}
export function createEvidenceCaptures({ journal, root, profile: rawProfile, client, clock = () => new Date().toISOString() }) {
  const profile = evidenceProfile(rawProfile), active = new Map()
  const siteRuleResource = profile.resources.find(row => row.resourceId === 'fixture:site' && row.adapterKind === 'site_snapshot_json' && row.clockTrust === 'fixture' && row.capabilityIds.includes(EVIDENCE_CAPABILITIES.site_snapshot) && row.allowedSections.includes('recent_events') && Object.hasOwn(row.fixedFiles, 'snapshot'))
  async function readSiteRuleEvents() {
    const bytes = await sourceBytes(siteRuleResource.root, siteRuleResource.fixedFiles.snapshot, siteRuleResource.maxBytes)
    const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    check(Array.isArray(source.events) && source.events.length <= siteRuleResource.maxEntries)
    const events = source.events.map(({ sourceEventId, sourceTimestamp, code, severity, message }) => ({ sourceEventId, sourceTimestamp, code, severity, message }))
    validateSiteEvents(events)
    return { profileVersion: profile.profileVersion, sourceSha256: hash(bytes), events: events.filter(event => event.code === 'COLLECTOR_LINK_DOWN' && event.severity === 'error' && timestamp(event.sourceTimestamp)) }
  }
  const profileDigest = resource => digest({ profileVersion: profile.profileVersion, resource })
  const files = createArtifactFiles({ root, maxBytes: 65536, validate: bytes => { const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); validateEvidenceBytes(bytes, raw.format === 'geneway.incident-history' ? 'history' : 'site_snapshot') } })
  let initialized = false
  async function initialize() { if (initialized) return; await journal.update(state => { for (const row of state.captures) if (row.state === 'accepted') { row.state = 'failed'; row.reason = 'CAPTURE_NOT_SEALED' } }); initialized = true }
  function localPermission(state, execution) { const current = state.executions.find(row => sameBinding(row, execution)); if (!current?.runtimeStarted || ['stopping', 'stopped', 'settling', 'settled', 'unknown'].includes(current.status)) throw error('FORBIDDEN') }
  async function capture(execution, operation, parameters) {
    exact(parameters, operation === 'read_history' ? ['clientRequestId', 'instructionRevision', 'resourceId', 'datasetId'] : ['clientRequestId', 'instructionRevision', 'resourceId', 'sections', 'window'])
    check(typeof parameters.clientRequestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(parameters.clientRequestId))
    const kind = operation === 'read_history' ? 'history' : 'site_snapshot', resource = profile.resources.find(row => row.resourceId === parameters.resourceId)
    if (!resource || !resource.capabilityIds.includes(EVIDENCE_CAPABILITIES[kind]) || resource.adapterKind !== (kind === 'history' ? 'history_json' : 'site_snapshot_json')) throw error('FORBIDDEN')
    const sourceId = kind === 'history' ? parameters.datasetId : 'snapshot', mapping = kind === 'history' ? resource.datasets : resource.fixedFiles
    if (typeof sourceId !== 'string' || !Object.hasOwn(mapping, sourceId)) throw error('FORBIDDEN')
    const file = mapping[sourceId]
    if (kind === 'site_snapshot') {
      check(Array.isArray(parameters.sections) && parameters.sections.length > 0 && parameters.sections.length <= 2 && new Set(parameters.sections).size === parameters.sections.length && parameters.sections.every(section => resource.allowedSections.includes(section)))
      if (parameters.window !== undefined) { exact(parameters.window, ['from', 'to']); check(timestamp(parameters.window.from) && timestamp(parameters.window.to) && Date.parse(parameters.window.to) >= Date.parse(parameters.window.from) && (Date.parse(parameters.window.to) - Date.parse(parameters.window.from)) / 1000 <= resource.maxWindowSeconds) }
    }
    const requestDigest = digest({ operation, parameters }), id = key('evidence-capture', binding(execution), parameters.clientRequestId)
    const authorized = await client.evidence.authorize(execution, parameters.instructionRevision, resource.resourceId, kind === 'site_snapshot' ? parameters.window : undefined)
    if (authorized.kind !== kind) throw error('FORBIDDEN')
    await initialize(); let row = (await journal.read()).captures.find(row => row.id === id)
    if (row && row.requestDigest !== requestDigest) throw error('IDEMPOTENCY_CONFLICT')
    if (row?.state === 'failed') throw error('CAPTURE_NOT_SEALED', '该采集请求未完成封存；请使用新的采集请求重新读取。')
    if (!row) {
      row = { id, captureFormatVersion: 2, profileDigest: profileDigest(resource), declarationDigest: null, requestId: parameters.clientRequestId, requestDigest, producerBinding: binding(execution), instructionRevision: parameters.instructionRevision, resourceId: resource.resourceId, resourceRevision: authorized.resource.revision, profileVersion: profile.profileVersion, exportToAgentIds: resource.exportToAgentIds, clockTrust: resource.clockTrust, kind, state: 'accepted', sourceId, sourceSha256: null, snapshotSha256: null, sizeBytes: null, observedAt: clock(), sourceTimestamp: null, sealedAt: null, evidenceRef: null, reason: null }
      await journal.update(state => { localPermission(state, execution); check(!state.captures.some(item => item.id === id)); state.captures.push(row) })
      try {
        const rawBytes = await sourceBytes(resource.root, file, resource.maxBytes)
        let bytes = rawBytes, sourceTimestamp = null
        if (kind === 'history') { const value = validateEvidenceBytes(bytes, kind); check(value.entries.length <= resource.maxEntries) }
        else {
          const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes))
          if (parameters.sections.includes('recent_events')) check(Array.isArray(source.events) && source.events.length <= resource.maxEntries)
          const selected = parameters.sections.includes('recent_events') ? source.events.map(event => ({ sourceEventId: event.sourceEventId, sourceTimestamp: event.sourceTimestamp, code: event.code, severity: event.severity, message: event.message })) : []
          validateSiteEvents(selected)
          const sourceTime = timestamp(source.sourceTime) ? source.sourceTime : null, age = sourceTime === null ? null : Date.parse(row.observedAt) - Date.parse(sourceTime), events = selected.filter(event => !parameters.window || event.sourceTimestamp === null || Date.parse(event.sourceTimestamp) >= Date.parse(parameters.window.from) && Date.parse(event.sourceTimestamp) <= Date.parse(parameters.window.to))
          const health = parameters.sections.includes('collector_health') ? { connection: source.health?.connection ?? 'unknown', lastSuccessAt: source.health?.lastSuccessAt ?? null, queueDepth: source.health?.queueDepth ?? null } : null
          const value = { format: 'geneway.site-snapshot', version: 1, resourceId: resource.resourceId, sourceId, sourceTime, captureTime: row.observedAt, window: parameters.window ?? null, cacheMode: 'fixture', quality: resource.clockTrust === 'unknown' || age === null || age < 0 ? 'unknown' : age > 120000 ? 'stale' : 'current', sections: parameters.sections, ...(parameters.sections.includes('collector_health') ? { health } : {}), ...(parameters.sections.includes('recent_events') ? { events } : {}) }
          validateSite(value); check(events.length <= resource.maxEntries); bytes = Buffer.from(JSON.stringify(value)); sourceTimestamp = sourceTime
        }
        check(bytes.length <= 65536)
        const latest = await client.evidence.authorize(execution, parameters.instructionRevision, resource.resourceId, kind === 'site_snapshot' ? parameters.window : undefined); if (latest.resource.revision !== row.resourceRevision) throw error('REVISION_CONFLICT')
        localPermission(await journal.read(), execution)
        const sealed = { sourceSha256: hash(rawBytes), snapshotSha256: hash(bytes), sizeBytes: bytes.length, sourceTimestamp, sealedAt: clock() }
        await files.write({ id: `evidence-${id}`, mediaType: 'application/json', sizeBytes: bytes.length, sha256: sealed.snapshotSha256 }, Readable.from([bytes]))
        // Durable cloud admission precedes local sealed, so restart never invents a declaration.
        const declaration = evidenceDeclaration({ ...row, ...sealed }), declarationDigest = evidenceDeclarationDigest(declaration)
        await client.evidence.init(declaration)
        await journal.update(state => { localPermission(state, execution); Object.assign(state.captures.find(item => item.id === id), sealed, { declarationDigest, state: 'sealed' }) })
      } catch (cause) { await journal.update(state => { const current = state.captures.find(item => item.id === id); if (current.state === 'accepted') { current.state = 'failed'; current.reason = cause.code ?? 'CAPTURE_FAILED' } }); throw cause }
      row = (await journal.read()).captures.find(item => item.id === id)
    }
    const declaration = evidenceDeclaration(row)
    if (row.captureFormatVersion === undefined) {
      // This flag belongs to an existing persistent v1 capture, never model arguments.
      await files.read({ id: `evidence-${id}`, mediaType: 'application/json', sizeBytes: row.sizeBytes, sha256: row.snapshotSha256 }, { sync: true })
      declaration.legacyRetry = true
    }
    const initialized = await client.evidence.init(declaration)
    const reply = initialized.status === 'ready' ? initialized : await client.evidence.publish(initialized, await files.read({ id: `evidence-${id}`, mediaType: 'application/json', sizeBytes: row.sizeBytes, sha256: row.snapshotSha256 }, { sync: true }))
    await journal.update(state => { localPermission(state, execution); Object.assign(state.captures.find(item => item.id === id), { state: 'published', evidenceRef: reply.ref }) })
    return { ref: reply.ref, status: 'ready', quality: reply.quality, observedAt: row.observedAt, sourceTimestamp: row.sourceTimestamp }
  }
  async function recoverSealed({ signal, onError = () => {} } = {}) {
    await initialize()
    for (const row of (await journal.read()).captures.filter(row => row.state === 'sealed')) {
      if (signal?.aborted) return
      if (active.has(row.id)) continue
      const local = await journal.read(), execution = local.executions.find(item => sameBinding(item, row.producerBinding))
      if (!execution || ['stopping', 'stopped', 'settling', 'settled'].includes(execution.status) || local.inbox.some(item => item.command.operation === 'cancel' && item.command.attempt_id === execution.attempt_id)) continue
      try {
        if (row.captureFormatVersion !== 2 || !row.declarationDigest) throw error('CAPTURE_RECOVERY_UNAVAILABLE')
        const resource = profile.resources.find(item => item.resourceId === row.resourceId)
        if (!resource || row.profileDigest !== profileDigest(resource)) throw error('CAPTURE_PROFILE_CHANGED')
        if (row.declarationDigest !== evidenceDeclarationDigest(evidenceDeclaration(row))) throw error('IDEMPOTENCY_CONFLICT')
        const bytes = await files.read({ id: `evidence-${row.id}`, mediaType: 'application/json', sizeBytes: row.sizeBytes, sha256: row.snapshotSha256 }, { sync: true })
        const issued = await client.evidence.resume(row, signal), reply = issued.status === 'ready' ? issued : await client.evidence.publish(issued, bytes, signal)
        await journal.update(state => {
          const current = state.executions.find(item => sameBinding(item, row.producerBinding))
          if (!current || ['stopping', 'stopped', 'settling', 'settled'].includes(current.status) || state.inbox.some(item => item.command.operation === 'cancel' && item.command.attempt_id === current.attempt_id)) throw error('FORBIDDEN')
          Object.assign(state.captures.find(item => item.id === row.id), { state: 'published', evidenceRef: reply.ref })
        })
      } catch (cause) { if (!signal?.aborted) onError(error(cause.code ?? 'EVIDENCE_TRANSPORT_UNAVAILABLE', '已封存证据传输尚未完成')) }
    }
  }
  return { recoverSealed, ...(siteRuleResource ? { readSiteRuleEvents } : {}), async call(execution, operation, parameters, instructionRevision) {
    if (operation === 'read_shared_evidence') { exact(parameters, ['ref', 'cursor']); evidenceRef(parameters.ref); if (parameters.cursor !== undefined) check(typeof parameters.cursor === 'string' && Buffer.byteLength(parameters.cursor) <= 1024); return client.evidence.read(execution, instructionRevision, parameters) }
    if (!['read_history', 'inspect_site'].includes(operation)) throw error('INVALID_REQUEST')
    const id = key('evidence-capture', binding(execution), parameters.clientRequestId), old = active.get(id)
    if (old) { if (old.digest !== digest({ operation, parameters })) throw error('IDEMPOTENCY_CONFLICT'); return old.promise }
    const promise = capture(execution, operation, parameters).finally(() => active.delete(id)); active.set(id, { digest: digest({ operation, parameters }), promise }); return promise
  } }
}
