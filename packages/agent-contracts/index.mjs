import { createHash } from 'node:crypto'

export const SCHEMA = 'geneway.multisite/1'
export const MULTISITE_WORK_STATUSES = Object.freeze(['accepted', 'running', 'waiting_input', 'waiting_budget', 'stopping', 'cancelled', 'interrupted', 'failed', 'completed'])
export const BINDING_FIELDS = ['work_id', 'delegation_id', 'parent_delegation_id', 'attempt_id', 'execution_epoch', 'agent_id', 'node_id', 'launch_id', 'session_id']
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
// Ported from upstream core/ids.ts; the namespace separates product facts from transport hints.
export const key = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
export function error(code, message = code) { return Object.assign(new Error(message), { code }) }
export function text(value, label = '字段') {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_000) throw error('INVALID_REQUEST', `${label}无效`)
  return value.trim()
}
export function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !fields.includes(field))) throw error('INVALID_REQUEST', '含未声明字段')
  return value
}
export function placement(value) {
  exact(value, ['nodeId', 'mode', 'resourceRefs'])
  text(value.nodeId, '节点')
  if (value.mode !== 'agent_host' || !Array.isArray(value.resourceRefs) || value.resourceRefs.some(ref => typeof ref !== 'string' || !ref.trim()) || new Set(value.resourceRefs).size !== value.resourceRefs.length) throw error('INVALID_REQUEST', 'Agent placement 无效')
  return structuredClone(value)
}
export function binding(value) { return Object.fromEntries(BINDING_FIELDS.map(field => [field, value[field]])) }
export function sameBinding(left, right, { firstSession = false } = {}) {
  return BINDING_FIELDS.every(field => field === 'session_id' && firstSession && left[field] === null ? typeof right[field] === 'string' && !!right[field] : left[field] === right[field])
}
export function seal(value) { return { ...value, payload_digest: digest(value) } }
export function assertSealed(value) {
  const { payload_digest, ...body } = value
  if (payload_digest !== digest(body)) throw error('IDEMPOTENCY_CONFLICT', '内容摘要冲突')
  if (value.schema !== SCHEMA) throw error('INVALID_REQUEST', '协议版本无效')
}

export function attachmentRefs(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw error('INVALID_REQUEST', '附件引用无效')
  for (const ref of value) {
    exact(ref, ['attachmentId', 'version', 'sha256'])
    if (typeof ref.attachmentId !== 'string' || !/^attachment-[a-f0-9-]{36}$/.test(ref.attachmentId) || !Number.isSafeInteger(ref.version) || ref.version < 1 || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw error('INVALID_REQUEST', '附件引用无效')
  }
  if (new Set(value.map(ref => ref.attachmentId)).size !== value.length) throw error('INVALID_REQUEST', '附件引用重复')
  return structuredClone(value)
}
