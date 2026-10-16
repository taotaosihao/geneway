import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { resolveCredentialFile } from './execution-grant.mjs'

export const KIVO_EVENT_SOURCES_FILE = 'event-sources.json'
export const KIVO_EVENT_RECORD_TYPES = Object.freeze(['repair', 'maintenance', 'inspection'])
export const KIVO_EVENT_TRIGGER = 'kivo-record-update'
export const KIVO_RECONCILE_MS = 60_000
export const KIVO_EVENT_BODY_LIMIT = 64 * 1024
const FIELDS = { repair: ['status', 'executorId'], maintenance: ['status', 'assigneeId'], inspection: ['status', 'startedAt', 'completedAt'] }

export function normalizeKivoEventSources(value) {
  keys(value, ['version', 'sources'])
  if (value.version !== 1 || !Array.isArray(value.sources)) throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 事件来源配置无效', 503)
  const ids = new Set()
  const sources = value.sources.map(source => {
    keys(source, ['id', 'connectionId', 'resource', 'sourceInstance', 'signingSecretRef', 'subscriptionIds', 'enabled'])
    for (const field of ['id', 'connectionId', 'sourceInstance']) boundedText(source[field], field, 200)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(source.id) || ids.has(source.id)) throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 来源 ID 无效或重复', 503)
    ids.add(source.id)
    let resource
    try { resource = new URL(source.resource) } catch { throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 来源资源无效', 503) }
    if (!['http:', 'https:'].includes(resource.protocol) || resource.href !== source.resource || resource.username || resource.password || resource.search || resource.hash || resource.pathname !== '/api/v1/mes/mcp') throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 来源资源无效', 503)
    if (!secretRef(source.signingSecretRef) || typeof source.enabled !== 'boolean' || !Array.isArray(source.subscriptionIds) || !source.subscriptionIds.length
      || source.subscriptionIds.some(id => !uuid(id)) || new Set(source.subscriptionIds).size !== source.subscriptionIds.length) throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 来源签名或订阅配置无效', 503)
    return structuredClone(source)
  })
  return { version: 1, sources }
}

export async function readKivoEventSources(dataRoot) {
  if (!isAbsolute(dataRoot)) throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 来源必须使用当前 data root', 503)
  const path = join(dataRoot, KIVO_EVENT_SOURCES_FILE)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > KIVO_EVENT_BODY_LIMIT) throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 来源文件无效', 503)
    const buffer = await handle.readFile()
    const value = normalizeKivoEventSources(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)))
    return { ...value, path, buffer, sha256: digest(buffer) }
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, sources: [], path, buffer: null, sha256: null }
    if (error.code === 'SOURCE_NOT_CONFIGURED') throw error
    throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 来源文件不可用', 503)
  } finally { await handle?.close() }
}

export async function readKivoSigningSecret(secretRoot, ref) {
  const path = await resolveCredentialFile(secretRoot, ref)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const value = (await handle.readFile('utf8')).trim()
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 签名凭据不可用', 503)
    const encoded = value.slice(6), key = Buffer.from(encoded, 'base64')
    if (!key.length || key.toString('base64') !== encoded) throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 签名凭据不可用', 503)
    return key
  } finally { await handle.close() }
}

export function verifyKivoEvent({ rawBody, rawHeaders, source, signingKey, now = Date.now() }) {
  if (!source?.enabled) throw failure('SOURCE_NOT_CONFIGURED', 'Kivo 事件来源未启用', 503)
  if (!Buffer.isBuffer(rawBody) || rawBody.length > KIVO_EVENT_BODY_LIMIT) throw failure('EVENT_BODY_TOO_LARGE', '事件正文超出限制', 413)
  const header = name => {
    const values = []
    for (let index = 0; index < (rawHeaders?.length ?? 0); index += 2) if (String(rawHeaders[index]).toLowerCase() === name) values.push(rawHeaders[index + 1])
    if (values.length !== 1 || typeof values[0] !== 'string') throw failure('EVENT_SIGNATURE_INVALID', '事件签名无效', 401)
    return values[0]
  }
  const deliveryId = header('webhook-id'), stamp = header('webhook-timestamp'), signature = header('webhook-signature')
  if (!uuid(deliveryId) || !/^[1-9]\d{0,12}$/.test(stamp) || Math.abs(Number(stamp) * 1000 - Number(now)) > 300_000 || !/^v1,[A-Za-z0-9+/]{43}=$/.test(signature)) throw failure('EVENT_SIGNATURE_INVALID', '事件签名无效或已过期', 401)
  const expected = createHmac('sha256', signingKey).update(`${deliveryId}.${stamp}.`).update(rawBody).digest()
  const actual = Buffer.from(signature.slice(3), 'base64')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw failure('EVENT_SIGNATURE_INVALID', '事件签名无效', 401)
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) } catch { throw failure('EVENT_INVALID', 'Kivo 事件格式无效', 400) }
  const event = normalizeKivoBusinessEvent(value, source)
  if (value.deliveryId !== deliveryId) throw failure('EVENT_INVALID', '事件投递 ID 不一致', 400)
  return { deliveryId, rawDigest: digest(rawBody), event, fingerprint: digest(JSON.stringify(canonical(event))) }
}

export function normalizeKivoBusinessEvent(value, source) {
  keys(value, ['version', 'deliveryId', 'type', 'timestamp', 'data'])
  if (value.version !== 2 || value.type !== 'notification.business_event' || !uuid(value.deliveryId)) throw failure('EVENT_INVALID', '只接受 Kivo business_event v2', 400)
  const data = value.data
  keys(data, ['source', 'object', 'message', 'rule', 'businessEvent', 'basis', 'businessLink'])
  keys(data.source, ['authority', 'adapter', 'revision'])
  keys(data.rule, ['id', 'revision', 'name'])
  if (!source.subscriptionIds.includes(data.rule.id) || !Number.isSafeInteger(data.rule.revision) || data.rule.revision < 1) throw failure('EVENT_SOURCE_INVALID', '事件订阅不在当前来源允许范围内', 403)
  const event = data.businessEvent
  keys(event, ['version', 'eventId', 'sourceKind', 'objectType', 'objectId', 'sourceRevision', 'occurredAt', 'timezone', 'actorId', 'traceId', 'action', 'before', 'after', 'subject', 'businessLink', 'displayBefore', 'displayAfter', ...(Object.hasOwn(event, 'actorKind') ? ['actorKind'] : [])])
  const machineCreate = event.objectType === 'repair' && event.action === 'create' && event.actorKind === 'machine'
  if (event.version !== 1 || !uuid(event.eventId) || event.sourceKind !== 'native_audit' || !KIVO_EVENT_RECORD_TYPES.includes(event.objectType)
    || !uuid(event.objectId) || event.timezone !== 'Asia/Shanghai' || !canonicalRevision(event.sourceRevision)
    || (machineCreate ? !/^machine-account:[0-9a-f-]{36}$/i.test(event.actorId) || !uuid(event.actorId.slice(16)) : event.actorId !== null && !uuid(event.actorId))
    || Object.hasOwn(event, 'actorKind') && !machineCreate || event.action !== null && (typeof event.action !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(event.action))) throw failure('EVENT_INVALID', '业务事件身份或版本无效', 400)
  instant(event.occurredAt)
  if (value.timestamp !== event.occurredAt || data.source.revision !== event.sourceRevision || data.source.adapter !== 'mes.native' || data.source.authority !== `mes.native.${event.objectType}`) throw failure('EVENT_SOURCE_INVALID', '业务事件来源或时间不一致', 400)
  boundedText(event.traceId, 'traceId', 128)
  const subject = normalizeSubject(event.subject, event), object = normalizeSubject(data.object, event)
  if (JSON.stringify(canonical(subject)) !== JSON.stringify(canonical(object))) throw failure('EVENT_SOURCE_INVALID', '业务对象身份不一致', 400)
  const before = machineCreate ? null : transitionFields(event.before, event.objectType), after = transitionFields(event.after, event.objectType)
  if (machineCreate ? event.before !== null || event.sourceRevision !== '0' || after.status !== 'reported' || after.executorId !== null || Object.keys(after).length !== 2
    : Object.keys(before).sort().join() !== Object.keys(after).sort().join()) throw failure('EVENT_INVALID', '业务变化字段不闭合', 400)
  return { sourceId: source.id, resource: source.resource, sourceInstance: source.sourceInstance, adapter: data.source.adapter,
    kind: value.type, version: event.version, eventId: event.eventId, recordType: event.objectType, objectId: event.objectId,
    sourceRevision: event.sourceRevision, occurredAt: event.occurredAt, traceId: event.traceId, actorId: event.actorId, action: event.action,
    before, after, subject, ...(machineCreate ? { actorKind: 'machine' } : {}) }
}

export async function readKivoEventBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []; let bytes = 0
    const finish = (error, value) => {
      clearTimeout(timer); request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted)
      if (error) { request.resume(); rejectBody(error) } else resolveBody(value)
    }
    const onData = chunk => { const value = Buffer.from(chunk); bytes += value.length; if (bytes > KIVO_EVENT_BODY_LIMIT) finish(failure('EVENT_BODY_TOO_LARGE', '事件正文超出限制', 413)); else chunks.push(value) }
    const onEnd = () => finish(null, Buffer.concat(chunks))
    const onError = () => finish(failure('EVENT_INVALID', '事件正文未完成', 400))
    const onAborted = onError
    const timer = setTimeout(() => finish(failure('EVENT_BODY_TIMEOUT', '事件正文读取超时', 408)), 5000)
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted)
  })
}

export function canonicalRevision(value) { return typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) }
export function revisionString(value) { if (Number.isSafeInteger(value) && value >= 0) return String(value); if (canonicalRevision(value)) return value; throw failure('INVALID_SOURCE', 'Kivo 当前记录 revision 无效', 502) }
export function digest(value) { return createHash('sha256').update(value).digest('hex') }
export function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value }
function normalizeSubject(subject, event) {
  keys(subject, ['id', 'type', 'label', 'deviceId', 'deviceName', 'organizationId', 'organizationAncestorIds'])
  if (subject.id !== event.objectId || subject.type !== event.objectType || !uuid(subject.deviceId) || !uuid(subject.organizationId) || !Array.isArray(subject.organizationAncestorIds)
    || subject.organizationAncestorIds.some(id => !uuid(id)) || new Set(subject.organizationAncestorIds).size !== subject.organizationAncestorIds.length) throw failure('EVENT_INVALID', '业务 subject 身份无效', 400)
  return { id: subject.id, type: subject.type, deviceId: subject.deviceId, organizationId: subject.organizationId, organizationAncestorIds: [...subject.organizationAncestorIds] }
}
function transitionFields(value, type) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(key => !FIELDS[type].includes(key))) throw failure('EVENT_INVALID', '业务变化字段无效', 400)
  for (const [key, item] of Object.entries(value)) {
    if (['executorId', 'assigneeId'].includes(key)) { if (item !== null && !uuid(item)) throw failure('EVENT_INVALID', '业务人员身份无效', 400) }
    else if (['startedAt', 'completedAt'].includes(key)) { if (item !== null) instant(item) }
    else boundedText(item, key, 64)
  }
  return structuredClone(value)
}
function keys(value, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...allowed].sort().join()) throw failure('EVENT_INVALID', 'Kivo 结构包含缺失或未声明字段', 400) }
function boundedText(value, _field, max) { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw failure('EVENT_INVALID', 'Kivo 文本字段无效', 400); return value }
function instant(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw failure('EVENT_INVALID', 'Kivo 时间字段无效', 400) }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function secretRef(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..' }
function failure(code, message, status) { return Object.assign(new Error(message), { code, status }) }
