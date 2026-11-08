import { error, exact, text } from './index.mjs'
export const CONTEXT_READ_TOOL = 'geneway_read_context'
export const CONTEXT_OBJECT_KINDS = Object.freeze(['continuation', 'work', 'artifact', 'job', 'result', 'evidence'])
export const CONTEXT_READ_LIMITS = Object.freeze({ pageBytes: 16384, pageItems: 16, objectPages: 32, objectBytes: 131072, maxHops: 6, maxReads: 64, maxBytes: 262144, maxTokens: 262144 })
export function contextObjectRef(value) {
  exact(value, ['kind', 'id', 'version']); text(value.id)
  if (!CONTEXT_OBJECT_KINDS.includes(value.kind) || value.version !== undefined && (!Number.isSafeInteger(value.version) || value.version < 1)) throw error('INVALID_REQUEST')
  return structuredClone(value)
}
export function contextReadParameters(value) {
  exact(value, ['clientRequestId', 'objectRef', 'view', 'cursor', 'maxItems', 'maxTokens']); text(value.clientRequestId)
  if (value.clientRequestId.length > 128 || !['summary', 'content', 'manifest'].includes(value.view) || value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 2048)) throw error('INVALID_REQUEST')
  if (value.objectRef !== undefined) contextObjectRef(value.objectRef)
  if (value.maxItems !== undefined && (!Number.isSafeInteger(value.maxItems) || value.maxItems < 1 || value.maxItems > CONTEXT_READ_LIMITS.pageItems) || value.maxTokens !== undefined && (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 256 || value.maxTokens > CONTEXT_READ_LIMITS.pageBytes)) throw error('INVALID_REQUEST')
  return value
}
