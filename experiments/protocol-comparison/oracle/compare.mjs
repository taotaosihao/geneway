import { createHash } from 'node:crypto'

export const CASES = Object.freeze(['X01', 'X02', 'X03', 'X04', 'X05', 'X06', 'X07', 'X08', 'X09', 'X10'])
export const HARD_GATES = Object.freeze(['platform', 'identity', 'outbound_only', 'recoverable_query', 'no_duplicate_effect', 'authorization', 'fixed_dependencies'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const verdict = (status, reasons, refs = []) => ({ status, reasons, refs })

// 只核公共事实完整性与独立性，不把runner的passed/score旗标当实验结果。
// X01–X10具体wire/oracle事实predicate待与真实runner schema逐条对齐。
export function compareFacts({ manifest, fixtureBytes, events = [], wire = [], processes = [], measurements } = {}) {
  const issues = [], ids = new Set()
  if (!manifest || !['baseline', 'a2a', 'anp'].includes(manifest.candidate)) issues.push('缺有效candidate')
  if (!Buffer.isBuffer(fixtureBytes)) issues.push('缺原fixture bytes，不能只信fixtureDigest声明')
  else if (manifest?.fixtureDigest !== sha256(fixtureBytes)) issues.push('fixtureDigest与原bytes不符')
  if (!manifest?.env?.nodeVersion || !manifest.env.platform || !manifest.env.arch) issues.push('缺实际runtime/platform/arch')
  for (const event of events) {
    if (!event.id || ids.has(event.id) || !CASES.includes(event.caseId) || !event.type || !Number.isFinite(Date.parse(event.at))) issues.push('缺事件身份/时间/类型或重复eventId')
    ids.add(event.id)
  }
  const processIds = new Map(processes.map(row => [row.id, row]))
  if (processIds.size !== processes.length) issues.push('process身份ID重复')
  for (const row of processes) if (!row.id || !row.role || !Number.isSafeInteger(row.pid) || !row.startTicks) issues.push('缺进程role/PID/startTicks')
  const adapters = processes.filter(row => row.role === 'adapter'), peers = processes.filter(row => row.role === 'peer')
  const sharedPeer = peers.some(peer => adapters.some(adapter => peer.pid === adapter.pid && String(peer.startTicks) === String(adapter.startTicks)))
  if (sharedPeer) issues.push('独立peer与adapter为同一OS进程')
  for (const row of wire) if (!row.id || !processIds.has(row.fromProcess) || !processIds.has(row.toProcess) || !Number.isSafeInteger(row.requestBytes) || !Number.isSafeInteger(row.responseBytes)) issues.push('wire缺真实两端process归属/bytes')
  const cases = Object.fromEntries(CASES.map(id => [id, verdict('not-run', ['尚无已对齐的实际协议事实predicate；不采用runner passed旗标'], events.filter(row => row.caseId === id).map(row => row.id))]))
  if (sharedPeer) cases.X09 = verdict('failed', ['独立peer与adapter同PID/startTicks'], peers.map(row => row.id))
  const gates = Object.fromEntries(HARD_GATES.map(id => [id, verdict('not-run', ['缺该硬门的独立实际证据predicate'])]))
  return { schema: 'geneway.protocol-comparison-oracle/1', candidate: manifest?.candidate ?? null,
    fixtureDigest: Buffer.isBuffer(fixtureBytes) ? sha256(fixtureBytes) : null,
    inputIntegrity: verdict(issues.length ? 'failed' : 'passed', issues), cases, gates,
    measurementsPresent: !!measurements, eligibleForScoring: false, winner: null,
    boundary: 'neutral schema/integrity only until actual per-case evidence schema is agreed; no peer/SDK/conformance/experiment pass or selection claim' }
}

export function compareCohort(manifests) {
  const expected = manifests[0], fields = ['fixtureDigest', 'identityRevisionDigest', 'faultDigest']
  const differences = []
  for (const manifest of manifests) {
    for (const field of fields) if (!expected?.[field] || manifest[field] !== expected[field]) differences.push({ candidate: manifest.candidate, field })
    for (const field of ['nodeVersion', 'platform', 'arch']) if (!expected?.env?.[field] || manifest.env?.[field] !== expected.env[field]) differences.push({ candidate: manifest.candidate, field: 'env.' + field })
  }
  if (new Set(manifests.map(row => row.candidate)).size !== 3 || !['baseline', 'a2a', 'anp'].every(id => manifests.some(row => row.candidate === id))) differences.push({ field: 'missing_or_duplicate_candidate' })
  return verdict(differences.length ? 'failed' : 'passed', differences)
}
