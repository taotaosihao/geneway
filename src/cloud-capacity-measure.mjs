// R16's selected row pool, not the entire Store or its on-disk serialization.
export const CLOUD_CAPACITY_LIMITS = Object.freeze({ historyBytes: 64 * 1024 * 1024, pendingBytes: 16 * 1024 * 1024, pendingCount: 1280, pendingPerNodeCount: 256 })
const TABLES = Object.freeze({
  'multisite.commands': 10000, 'multisite.outbox': 10000, 'multisite.inputs': 10000,
  'multisite.questions': 10000, 'multisite.receipts': 30000, 'multisite.messages': 30000,
  'a2aProtocol.tasks': 30000, 'a2aProtocol.groups': 10000, 'a2aProtocol.deliveries': 30000,
  modelRequests: 30000, modelImageVariants: 30000, nodes: 10000, nodeCommands: 10000,
  workMemberRemovals: null,
})
const bytes = row => Buffer.byteLength(JSON.stringify(row), 'utf8')
const timestamp = value => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
const pendingAccumulator = () => ({ count: 0, bytes: 0, oldest: null, oldestTime: Infinity, invalidTime: false })
function recordPending(total, row, size) {
  total.count++; total.bytes += size
  const at = timestamp(row.createdAt)
  if (!Number.isFinite(at)) total.invalidTime = true
  else if (at < total.oldestTime) { total.oldest = row.createdAt; total.oldestTime = at }
}
function pendingResult(total, now) {
  return { count: total.count, bytes: total.bytes,
    oldestCreatedAt: total.invalidTime ? 'unknown' : total.oldest,
    oldestAgeMs: !total.count ? null : total.invalidTime || !Number.isFinite(now) || now < total.oldestTime ? 'unknown' : now - total.oldestTime }
}

// The caller supplies an already validated state. This function neither admits
// changes nor computes which future closing commands are owed.
export function measureCloudCapacity(validatedState, now) {
  const tables = {}, total = pendingAccumulator(), nodes = new Map(), time = timestamp(now)
  let count = 0, historyBytes = 0
  for (const [name, hardCount] of Object.entries(TABLES)) {
    const rows = name.split('.').reduce((value, field) => value[field], validatedState)
    let size = 0
    for (const row of rows) {
      const rowBytes = bytes(row); size += rowBytes
      if (name !== 'multisite.outbox' || row.acceptedAt !== null) continue
      recordPending(total, row, rowBytes)
      const nodeId = row.command.node_id
      if (!nodes.has(nodeId)) nodes.set(nodeId, pendingAccumulator())
      recordPending(nodes.get(nodeId), row, rowBytes)
    }
    tables[name] = { count: rows.length, bytes: size, hardCount }
    count += rows.length; historyBytes += size
  }
  return { limits: CLOUD_CAPACITY_LIMITS, tables, history: { count, bytes: historyBytes },
    pending: { ...pendingResult(total, time), byNode: Object.fromEntries([...nodes].map(([id, value]) => [id, pendingResult(value, time)])) } }
}

const MAX = Number.MAX_SAFE_INTEGER
const MAX_USAGE = Object.freeze({ prompt_tokens: MAX, completion_tokens: MAX, total_tokens: MAX })
const MAX_ISO = new Date(8.64e15).toISOString()
function modelVariant(row) {
  if (row.purpose === 'routing') return row.routingVersion === 1 ? 'routing-v1' : row.routingVersion === 2 ? 'routing-v2' : null
  if (row.purpose === 'supervision_diagnosis') return 'supervision-diagnosis'
  if (row.purpose !== undefined && row.purpose !== 'intent_review') return null
  return row.accountingVersion === undefined ? 'business-legacy' : row.accountingVersion === 2 ? 'business-v2' : null
}

// Fixed fields remain untouched; only production settlement fields are varied.
// These replacements are byte envelopes, not valid amounts to persist or bill.
export function modelSettlementGrowth(row) {
  const variant = modelVariant(row), actualBytes = bytes(row)
  if (!variant) return { variant: 'unsupported', actualBytes, maxFinalBytes: null, positiveD: null }
  if (row.outcome !== 'unknown' || row.completedAt !== null) return { variant, actualBytes, maxFinalBytes: actualBytes, positiveD: 0 }
  const business = variant.startsWith('business-'), priced = variant !== 'business-legacy'
  const conclusion = (outcome, usage) => ({ ...row, outcome, usage, completedAt: MAX_ISO,
    ...(priced ? { usageCostMicros: usage === null ? null : MAX } : {}),
    ...(variant === 'business-v2' ? { overReservation: false } : {}),
    ...(!business ? { noForwardReason: null } : {}) })
  const candidates = [conclusion('completed', MAX_USAGE), conclusion('unknown', MAX_USAGE), conclusion('failed', business ? MAX_USAGE : null)]
  if (!business) candidates.push({ ...conclusion('failed', null), noForwardReason: variant === 'routing-v1' ? 'EXECUTION_DEADLINE' : 'A'.repeat(64) })
  const maxFinalBytes = Math.max(...candidates.map(bytes))
  return { variant, actualBytes, maxFinalBytes, positiveD: Math.max(0, maxFinalBytes - actualBytes) }
}
