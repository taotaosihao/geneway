import assert from 'node:assert/strict'
import { buildCapabilityPrompt, buildFollowUpPrompt, getCapability, KIVO_TPM_RECORD_LIST_CAPABILITY, KIVO_TPM_RECORD_READ_CAPABILITY, listCapabilities, parseCapabilityToolResult, sanitizeFollowUpContext, validateCapabilityInput, WORK_ORDER_DEVICE_CORRELATION_CAPABILITY } from '../src/capabilities.mjs'
import { KIVO_TPM_RESULT_KIND, KIVO_TPM_TOOLS, normalizeTpmObservation, TPM_LIST_RECORD_TYPES, TPM_RECORD_TYPES, tpmSourcePath, tpmToolRequest } from '../src/domain/tpm.mjs'

const read = KIVO_TPM_RECORD_READ_CAPABILITY, list = KIVO_TPM_RECORD_LIST_CAPABILITY
const deviceId = '00000000-0000-4000-8000-000000000001'
const id = '00000000-0000-4000-8000-000000000002'
const queriedAt = '2026-10-15T12:00:00.000Z', updatedAt = '2026-10-15T11:00:00.000Z'
const connection = { sourceSystem: 'Kivo', sourceInstance: 'controlled-a', sourceEnvironment: 'controlled-test', dataMode: 'synthetic', evidenceMode: 'controlled-domain' }
const values = {
  repair: { id, orderNo: 'R-1', deviceId, status: 'reported', revision: 1, createdAt: updatedAt, updatedAt, reporterId: null, executorId: null, acceptedById: null, reopenedFrom: null, detail: { reason: 'synthetic' } },
  maintenance: { id, orderNo: 'M-1', deviceId, status: 'pending', revision: 1, createdAt: updatedAt, updatedAt, device: null, assigneeId: null, assigneeDisplayName: null, acceptedById: null, detail: {} },
  inspection: { id, inspectionNo: 'I-1', deviceId, status: 'pending', revision: 1, createdAt: updatedAt, scheduledAt: updatedAt, occurrenceId: null, blockingExceptionId: null },
  exception: { id, exceptionNo: 'E-1', deviceId, sourceType: 'inspection', sourceId: id, severity: 'general', status: 'open', immediateMeasure: null, responsibleId: null, createdAt: updatedAt },
  plan: { id, code: 'P-1', name: 'synthetic maintenance', purpose: 'maintenance', deviceId, organizationUnitId: id, organizationCode: 'synthetic', active: true, revision: 1, createdAt: updatedAt, updatedAt, versions: [], occurrences: [], occurrenceTotal: 0 },
  device: { id: deviceId, code: 'D-1', name: 'synthetic device', lifecycleStatus: 'active', connectionStatus: 'unknown', operationStatus: 'unknown', summaryStatus: 'unknown', summaryReason: null, organizationUnitId: id, organizationName: 'synthetic' },
}

for (const [capabilityId, toolName, requiredInputs] of [[read, KIVO_TPM_TOOLS.readRecord, ['recordType', 'reference']], [list, KIVO_TPM_TOOLS.listRecords, ['recordType', 'filters']]]) {
  const capability = getCapability(capabilityId)
  assert.equal(capability.toolName, toolName)
  assert.equal(capability.skillId, `skill-${capabilityId}`)
  assert.equal(capability.pluginId, 'geneway-kivo-tpm')
  assert.equal(capability.pluginVersion, '1')
  assert.equal(capability.resultKind, KIVO_TPM_RESULT_KIND)
  assert.equal(capability.connectionKind, 'kivo-mcp')
  assert.equal(capability.requiresConnection, true)
  assert.deepEqual(capability.requiredInputs, requiredInputs)
  assert.equal(listCapabilities().filter(item => item.id === capabilityId).length, 1)
}
assert.deepEqual(validateCapabilityInput(read, { recordType: 'repair' }, { allowMissing: true }), { ok: true, input: { recordType: 'repair' }, missing: ['reference'] })
assert.deepEqual(validateCapabilityInput(read, { reference: ' R-1 ' }, { allowMissing: true }), { ok: true, input: { reference: 'R-1' }, missing: ['recordType'] })
assert.deepEqual(validateCapabilityInput(read, {}).missing, ['recordType', 'reference'])
assert.deepEqual(validateCapabilityInput(list, { recordType: 'repair' }).input, { recordType: 'repair', filters: {} })
assert.deepEqual(validateCapabilityInput(list, { recordType: 'repair', filters: { keyword: ' R-1 ', pageSize: 100 } }).input, { recordType: 'repair', filters: { keyword: 'R-1', pageSize: 100 } })
for (const input of [
  { recordType: 'repair', reference: '../R-1' }, { recordType: 'plan', reference: 'P-1' }, { recordType: 'unknown', reference: 'R-1' },
  { recordType: 'repair', reference: 'R-1', toolName: 'tpm.repair.create' }, { recordType: 'repair', reference: 'R-1', url: 'http://untrusted' },
  { recordType: 'repair', reference: 'R-1', clientId: 'other' }, { recordType: 'repair', reference: 1 },
]) assert.equal(validateCapabilityInput(read, input, { allowMissing: true }).ok, false)
for (const input of [
  { recordType: 'device', filters: {} }, { recordType: 'repair', filters: { pageSize: 101 } }, { recordType: 'repair', filters: { status: 'future_status' } },
  { recordType: 'plan', filters: { deviceId } }, { recordType: 'repair', filters: { organizationUnitId: id } }, { filters: { keyword: 'x' } },
]) assert.equal(validateCapabilityInput(list, input, { allowMissing: true }).ok, false)

for (const recordType of TPM_RECORD_TYPES) {
  const input = recordInput(recordType), observation = snapshot('record', input)
  const result = parseCapabilityToolResult(read, { ok: true, observation }, input)
  assert.equal(result.kind, KIVO_TPM_RESULT_KIND)
  assert.deepEqual(result.payload, observation)
  assert.deepEqual(result.source, observation.source)
  assert.notEqual(result.payload, observation)
  assert.equal(result.toolName, KIVO_TPM_TOOLS.readRecord)
  const prompt = buildCapabilityPrompt(read, input)
  assert.ok(prompt.includes(KIVO_TPM_TOOLS.readRecord))
  assert.ok(prompt.includes(JSON.stringify(input)))
  assert.ok(prompt.includes('不得自行计算、猜测或执行写入'))
}
for (const recordType of TPM_LIST_RECORD_TYPES) {
  const input = { recordType, filters: { page: 2, pageSize: 10 } }, observation = snapshot('list', input)
  assert.equal(parseCapabilityToolResult(list, { ok: true, observation }, input).toolName, KIVO_TPM_TOOLS.listRecords)
  assert.equal(parseCapabilityToolResult(list, { ok: true, observation: snapshot('list', input, { noRecords: true }) }, input).payload.status, 'ok')
  assert.equal(parseCapabilityToolResult(list, { ok: true, observation: snapshot('list', input, { empty: true }) }, input).payload.status, 'scope_empty')
}

const input = recordInput('repair'), observation = snapshot('record', input)
for (const [capabilityId, wrongInput] of [
  [read, { ...input, reference: 'R-2' }], [read, { recordType: 'maintenance', reference: 'R-1' }],
  [list, { recordType: 'repair', filters: {} }],
]) assert.throws(() => parseCapabilityToolResult(capabilityId, { ok: true, observation }, wrongInput), { code: 'TOOL_CHAIN_INVALID' })
for (const mutate of [
  value => { value.records[0].statusLabel = 'fabricated' },
  value => { value.records[0].schedule.overdue = true },
  value => { value.source.sourceRecordId = 'repair:R-2' },
  value => { value.source.sourceTime = queriedAt },
  value => { value.sources[0].path = '/api/v1/mes/tpm/repairs/R-2' },
  value => { value.sources[1].path = `/api/v1/mes/equipment/ledger/devices/${id}` },
  value => { value.sources[1].traceId = 'other-execution' },
  value => { value.linkedDevice = null },
  value => { value.explanation = 'hidden-model-answer' },
]) {
  const changed = structuredClone(observation)
  mutate(changed)
  assert.throws(() => parseCapabilityToolResult(read, { ok: true, observation: changed }, input), { code: 'TOOL_CHAIN_INVALID' })
}
assert.throws(() => parseCapabilityToolResult(read, { ok: true, observation, extra: 'hidden' }, input), { code: 'TOOL_CHAIN_INVALID' })
assert.throws(() => parseCapabilityToolResult(read, { ok: true }, input), { code: 'TOOL_CHAIN_INVALID' })
const pagedInput = { recordType: 'repair', filters: { page: 2, pageSize: 10, deviceId, status: 'reported' } }
const paged = snapshot('list', pagedInput)
for (const filters of [{ page: 1, pageSize: 10 }, { page: 2, pageSize: 20 }, { page: 2, pageSize: 10, deviceId: id }, { page: 2, pageSize: 10, status: 'repairing' }]) {
  assert.throws(() => parseCapabilityToolResult(list, { ok: true, observation: paged }, { recordType: 'repair', filters }), { code: 'TOOL_CHAIN_INVALID' })
}
const equivalentOrder = structuredClone(paged)
equivalentOrder.sources[0].path = '/api/v1/mes/tpm/repairs?status=reported&deviceId=' + deviceId + '&pageSize=10&page=2'
assert.equal(parseCapabilityToolResult(list, { ok: true, observation: equivalentOrder }, pagedInput).kind, KIVO_TPM_RESULT_KIND)
assert.equal(parseCapabilityToolResult(read, { ok: true, observation: snapshot('record', input, { empty: true }) }, input).payload.status, 'scope_empty')
assert.equal(parseCapabilityToolResult(read, { ok: true, observation: snapshot('record', input, { deviceEmpty: true }) }, input).payload.status, 'scope_empty')

for (const code of ['INVALID_REQUEST', 'SOURCE_NOT_CONFIGURED', 'FORBIDDEN', 'NOT_FOUND', 'CANCELLED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR', 'INVALID_SOURCE']) {
  assert.throws(() => parseCapabilityToolResult(read, { ok: false, error: { code, message: '受控错误' } }, input), { code })
  assert.throws(() => parseCapabilityToolResult(list, { ok: false, error: { code, message: '受控错误' } }, { recordType: 'repair', filters: {} }), { code })
}
assert.throws(() => parseCapabilityToolResult(read, { ok: false, error: { code: 'UNRECOGNIZED', message: 'raw' } }, input), { code: 'TOOL_CHAIN_INVALID' })

const fact = { kind: KIVO_TPM_RESULT_KIND, payload: observation, source: observation.source }
const followUp = sanitizeFollowUpContext({ question: '目前依据是什么？', facts: [fact], confirmations: [] })
assert.deepEqual(followUp.facts[0], fact)
assert.notEqual(followUp.facts[0].payload, observation)
assert.ok(buildFollowUpPrompt(followUp).includes('这个追问严禁调用任何工具'))
assert.ok(buildCapabilityPrompt(read, input, fact).includes('上一条获准结构化事实仅供对照'))
assert.throws(() => sanitizeFollowUpContext({ question: '依据？', facts: [{ ...fact, source: { ...fact.source, sourceInstance: 'other' } }], confirmations: [] }), { code: 'INVALID_REQUEST' })
assert.throws(() => sanitizeFollowUpContext({ question: '依据？', facts: [{ ...fact, payload: { ...observation, explanation: 'hidden-model-answer' } }], confirmations: [] }), { code: 'INVALID_REQUEST' })

const gear = { ok: true, workOrderId: 'WO-1', status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: '件', sourceRecordId: 'Work Order:WO-1', sourceTime: updatedAt, sourceSystem: 'GearJob', sourceInstance: 'historical-fixture', sourceEnvironment: 'controlled-test', dataMode: 'synthetic', evidenceMode: 'controlled-frappe-compatible' }
const gearResult = parseCapabilityToolResult('gearjob-work-order-read', gear, { workOrderId: 'WO-1' })
assert.equal(gearResult.kind, 'gearjob.work-order.observation')
assert.equal(gearResult.payload.completedQuantity, 4)
assert.equal(gearResult.toolName, 'geneway_gearjob_read_work_order')
assert.equal(gearResult.pluginVersion, '2')
assert.deepEqual(validateCapabilityInput('gearjob-work-order-read', {}, { allowMissing: true }).missing, ['workOrderId'])
assert.equal(validateCapabilityInput('gearjob-work-order-read', { workOrderId: 'WO-1', recordType: 'repair' }).error.code, 'UNDECLARED_INPUT')
assert.equal(validateCapabilityInput('cycle-time-calculate', { availableSeconds: 3600, quantity: 60 }).ok, true)
assert.equal(validateCapabilityInput('cycle-time-calculate', { availableSeconds: '3600', quantity: 60 }).error.code, 'INVALID_AVAILABLE_SECONDS_TYPE')
const cycle = parseCapabilityToolResult('cycle-time-calculate', { ok: true, availableSeconds: 3600, quantity: 60, secondsPerUnit: 60, unit: 'seconds/unit' }, { availableSeconds: 3600, quantity: 60 })
assert.equal(cycle.kind, 'manufacturing.takt')
assert.equal(cycle.payload.secondsPerUnit, 60)
const correlation = { ok: true, workOrderId: 'WO-1', queriedAt, connections: {}, gearJob: { sourceInstance: 'historical-fixture' }, hive: { sourceInstance: 'historical-hive-fixture' }, mapping: {}, tenant: {}, device: {}, sample: {}, status: 'running', recordId: 'record-fixture', eventId: 'event-fixture', freshness: {}, machineFacts: {}, unknowns: [] }
const correlationResult = parseCapabilityToolResult(WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, correlation, { workOrderId: 'WO-1' })
assert.equal(correlationResult.kind, 'manufacturing.work-order-device-correlation')
assert.equal(correlationResult.payload.gearJob.sourceInstance, 'historical-fixture')
const legacy = sanitizeFollowUpContext({ question: '历史依据？', facts: [gearResult, cycle, correlationResult].map(({ kind, payload, source }) => ({ kind, payload, ...(source ? { source } : {}) })), confirmations: [] })
assert.deepEqual(legacy.facts.map(item => item.kind), ['gearjob.work-order.observation', 'manufacturing.takt', 'manufacturing.work-order-device-correlation'])
console.log('Kivo TPM capabilities, request/result binding, follow-up and legacy typed result checks passed')

function recordInput(recordType) {
  return { recordType, reference: recordType === 'device' ? deviceId : recordType === 'plan' ? id : values[recordType].orderNo ?? values[recordType].inspectionNo ?? values[recordType].exceptionNo }
}
function snapshot(mode, input, { empty = false, deviceEmpty = false, noRecords = false } = {}) {
  const request = tpmToolRequest(mode, input)
  const source = { system: 'kivo', path: tpmSourcePath(request), queriedAt, traceId: 'capability-test' }
  const result = { status: empty ? 'scope_empty' : 'ok', source, value: empty ? null : mode === 'record' ? values[input.recordType] : { items: noRecords ? [] : [values[input.recordType]], total: noRecords ? 0 : 1, page: input.filters.page ?? 1, pageSize: input.filters.pageSize ?? 20 } }
  const deviceResult = !empty && mode === 'record' && ['repair', 'maintenance', 'inspection'].includes(input.recordType) ? {
    status: deviceEmpty ? 'scope_empty' : 'ok', source: { ...source, path: tpmSourcePath(tpmToolRequest('record', { recordType: 'device', reference: deviceId })) }, value: deviceEmpty ? null : values.device,
  } : undefined
  return normalizeTpmObservation({ mode, input, result, deviceResult, connection })
}
