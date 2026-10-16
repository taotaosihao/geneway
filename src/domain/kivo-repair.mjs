import { createHash } from 'node:crypto'

export const KIVO_REPAIR_ACTION = 'kivo.tpm.repair.create'

export function repairPayload(value) {
  exact(value, ['orderNo', 'deviceId', 'reason', 'description'])
  if (!/^GW-[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(value.orderNo) || !uuid(value.deviceId)) invalid()
  repairText(value.reason); repairText(value.description)
  return structuredClone(value)
}

export function repairText(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value !== value.trim() || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid()
  return value
}

export function assertRepairTarget(value) {
  exact(value, ['system', 'resource', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'connectionId', 'connectionRevision', 'clientId', 'recordType', 'recordId', 'recordReference', 'deviceId', 'deviceCode'])
  const resource = new URL(value.resource)
  if (value.system !== 'kivo' || !['http:', 'https:'].includes(resource.protocol) || resource.username || resource.password || resource.search || resource.hash
    || resource.pathname !== '/api/v1/mes/mcp' || !['repair', 'maintenance', 'inspection'].includes(value.recordType)
    || ![value.clientId, value.recordId, value.deviceId].every(uuid) || !Number.isSafeInteger(value.connectionRevision) || value.connectionRevision < 1) invalid()
  for (const key of ['sourceInstance', 'sourceEnvironment', 'dataMode', 'connectionId', 'recordReference', 'deviceCode']) text(value[key])
  return value
}

export function repairTargetFromCorrelation(payload) {
  const { binding, source, tpm, device } = payload
  return assertRepairTarget({ system: 'kivo', resource: binding.resource, sourceInstance: binding.sourceInstance,
    sourceEnvironment: source.sourceEnvironment, dataMode: source.dataMode, connectionId: binding.connectionId,
    connectionRevision: binding.connectionRevision, clientId: binding.clientId, recordType: tpm.recordType,
    recordId: tpm.id, recordReference: tpm.reference, deviceId: device.id, deviceCode: device.code })
}

// Business intent spans works and accounts, while the preview pins its original account.
export function repairIntentKey(ownerMemberId, target) {
  assertRepairTarget(target)
  return `repair-intent-${createHash('sha256').update(JSON.stringify([ownerMemberId, target.resource, target.sourceInstance, KIVO_REPAIR_ACTION, target.recordType, target.recordId, target.deviceId])).digest('hex')}`
}

export function repairReadback(value, action) {
  const target = assertRepairTarget(action.preview.target), payload = repairPayload(action.preview.payload)
  const record = value?.value
  if (value?.status !== 'ok' || !record || record.orderNo !== payload.orderNo || record.deviceId !== payload.deviceId || !uuid(record.id)
    || record.detail?.reason !== payload.reason || record.detail?.description !== payload.description
    || record.creation?.actorKind !== 'machine' || record.creation.machineAccountId !== target.clientId || record.creation.traceId !== action.id
    || !Number.isSafeInteger(record.creation.revision) || record.creation.revision < 0 || !Number.isSafeInteger(record.revision) || record.revision < record.creation.revision
    || value.source?.traceId !== action.id || typeof value.source?.queriedAt !== 'string' || !Number.isFinite(Date.parse(value.source.queriedAt))) throw Object.assign(new Error('维修单回读与原批准或机器创建事实不一致'), { code: 'READBACK_MISMATCH' })
  const creation = { actorKind: 'machine', machineAccountId: record.creation.machineAccountId, traceId: record.creation.traceId, revision: String(record.creation.revision) }
  return { upstreamRecordId: record.id, orderNo: record.orderNo, deviceId: record.deviceId, status: text(record.status), creation, currentRevision: String(record.revision), replayed: record.replayed === true, queriedAt: value.source.queriedAt }
}

export function assertRepairReceipt(receipt, action) {
  exact(receipt, ['previewDigest', 'upstreamRecordId', 'recordedAt', 'orderNo', 'deviceId', 'status', 'creation', 'currentRevision', 'replayed', 'queriedAt'])
  const target = assertRepairTarget(action.preview.target), payload = repairPayload(action.preview.payload)
  exact(receipt.creation, ['actorKind', 'machineAccountId', 'traceId', 'revision'])
  if (receipt.previewDigest !== action.preview.digest || !uuid(receipt.upstreamRecordId) || receipt.orderNo !== payload.orderNo || receipt.deviceId !== payload.deviceId
    || receipt.creation.actorKind !== 'machine' || receipt.creation.machineAccountId !== target.clientId || receipt.creation.traceId !== action.id
    || !canonicalRevision(receipt.creation.revision) || !canonicalRevision(receipt.currentRevision) || BigInt(receipt.currentRevision) < BigInt(receipt.creation.revision)
    || typeof receipt.replayed !== 'boolean' || ![receipt.recordedAt, receipt.queriedAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))) invalid()
  text(receipt.status)
  return receipt
}

export function isRepairCreationEcho(event, action, receipt = action?.receipt) {
  if (action?.intent?.kind !== KIVO_REPAIR_ACTION || !action.attempt || action.attempt.noEffectAt || !receipt) return false
  try {
    assertRepairReceipt(receipt, action)
    const target = action.preview.target
    return event.recordType === 'repair' && event.action === 'create' && event.before === null
      && event.resource === target.resource && event.sourceInstance === target.sourceInstance && event.traceId === action.id
      && event.actorKind === 'machine' && event.actorId === `machine-account:${target.clientId}`
      && event.objectId === receipt.upstreamRecordId && event.subject?.deviceId === target.deviceId
      && event.sourceRevision === receipt.creation.revision && event.after?.status === 'reported' && event.after.executorId === null && Object.keys(event.after).length === 2
  } catch { return false }
}

function canonicalRevision(value) { return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function text(value) { if (typeof value !== 'string' || !value.trim()) invalid(); return value }
function exact(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid() }
function invalid() { throw Object.assign(new Error('维修创建字段不符合固定契约'), { code: 'INVALID_INPUT' }) }
