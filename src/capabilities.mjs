import { calculateCycleTime } from './domain/cycle-time.mjs'
import { isDeepStrictEqual } from 'node:util'
import { assertTpmObservation, KIVO_TPM_RESULT_KIND, KIVO_TPM_TOOLS, normalizeTpmInput, normalizeTpmObservation, tpmSourcePath, tpmToolRequest } from './domain/tpm.mjs'

export const GEARJOB_TOOL = 'geneway_gearjob_read_work_order'
export const CYCLE_TIME_TOOL = 'geneway_calculate_cycle_time'
export const WORK_ORDER_DEVICE_CORRELATION_TOOL = 'geneway_correlate_work_order_device'
export const WORK_ORDER_DEVICE_CORRELATION_CAPABILITY = 'manufacturing-work-order-device-correlate'
export const KIVO_TPM_RECORD_READ_CAPABILITY = 'kivo-tpm-record-read'
export const KIVO_TPM_RECORD_LIST_CAPABILITY = 'kivo-tpm-record-list'

const capabilities = Object.freeze({
  'gearjob-work-order-read': Object.freeze({
    id: 'gearjob-work-order-read',
    retired: true,
    skillId: 'skill-gearjob-work-order-read',
    action: 'gearjob.work-order.read',
    toolName: GEARJOB_TOOL,
    pluginId: 'geneway-gearjob-work-order',
    pluginVersion: '2',
    resultKind: 'gearjob.work-order.observation',
    requiredInputs: Object.freeze(['workOrderId']),
    connectionKind: 'gearjob-rest',
    requiresConnection: true,
    normalizeInput: normalizeGearJobInput,
    normalizePartialInput: () => ({ ok: true, input: {}, missing: [] }),
    buildPrompt: gearJobPrompt,
    parseResult: parseGearJobResult,
  }),
  'cycle-time-calculate': Object.freeze({
    id: 'cycle-time-calculate',
    retired: false,
    skillId: 'skill-cycle-time-calculate',
    action: 'manufacturing.cycle-time.calculate',
    toolName: CYCLE_TIME_TOOL,
    pluginId: 'geneway-cycle-time',
    pluginVersion: '2',
    resultKind: 'manufacturing.takt',
    requiredInputs: Object.freeze(['availableSeconds', 'quantity']),
    requiresConnection: false,
    normalizeInput: normalizeCycleInput,
    normalizePartialInput: normalizeCyclePartialInput,
    buildPrompt: cyclePrompt,
    parseResult: parseCycleResult,
  }),
  [WORK_ORDER_DEVICE_CORRELATION_CAPABILITY]: Object.freeze({
    id: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY,
    retired: true,
    skillId: 'skill-manufacturing-work-order-device-correlate',
    action: 'manufacturing.work-order-device.correlate',
    toolName: WORK_ORDER_DEVICE_CORRELATION_TOOL,
    pluginId: 'geneway-work-order-device-correlation',
    pluginVersion: '1',
    resultKind: 'manufacturing.work-order-device-correlation',
    requiredInputs: Object.freeze(['workOrderId']),
    requiresConnection: true,
    connectionKind: null,
    normalizeInput: normalizeGearJobInput,
    normalizePartialInput: () => ({ ok: true, input: {}, missing: [] }),
    buildPrompt: correlationPrompt,
    parseResult: parseCorrelationResult,
  }),
  [KIVO_TPM_RECORD_READ_CAPABILITY]: Object.freeze({
    id: KIVO_TPM_RECORD_READ_CAPABILITY,
    retired: false,
    skillId: 'skill-kivo-tpm-record-read',
    action: 'kivo.tpm.record.read',
    toolName: KIVO_TPM_TOOLS.readRecord,
    pluginId: 'geneway-kivo-tpm',
    pluginVersion: '1',
    resultKind: KIVO_TPM_RESULT_KIND,
    requiredInputs: Object.freeze(['recordType', 'reference']),
    connectionKind: 'kivo-mcp',
    requiresConnection: true,
    normalizeInput: (value, options) => normalizeTpmInput('record', value, options),
    buildPrompt: tpmPrompt,
    parseResult: parseTpmResult,
  }),
  [KIVO_TPM_RECORD_LIST_CAPABILITY]: Object.freeze({
    id: KIVO_TPM_RECORD_LIST_CAPABILITY,
    retired: false,
    skillId: 'skill-kivo-tpm-record-list',
    action: 'kivo.tpm.record.list',
    toolName: KIVO_TPM_TOOLS.listRecords,
    pluginId: 'geneway-kivo-tpm',
    pluginVersion: '1',
    resultKind: KIVO_TPM_RESULT_KIND,
    requiredInputs: Object.freeze(['recordType', 'filters']),
    connectionKind: 'kivo-mcp',
    requiresConnection: true,
    normalizeInput: (value, options) => normalizeTpmInput('list', value, options),
    buildPrompt: tpmPrompt,
    parseResult: parseTpmResult,
  }),
})

export function listCapabilities() {
  return Object.values(capabilities)
}

export function getCapability(id) {
  return capabilities[id]
}

export function validateCapabilityInput(capabilityId, value, { allowMissing = false } = {}) {
  const capability = requiredCapability(capabilityId)
  if ([KIVO_TPM_RECORD_READ_CAPABILITY, KIVO_TPM_RECORD_LIST_CAPABILITY].includes(capabilityId)) return capability.normalizeInput(value, { allowMissing })
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('INVALID_INPUT', '能力输入必须是对象')
  const allowed = new Set(capability.requiredInputs)
  const extra = Object.keys(value).find(key => !allowed.has(key))
  if (extra) return invalid('UNDECLARED_INPUT', `能力输入包含未声明字段 ${extra}`)
  const missing = capability.requiredInputs.filter(key => !Object.hasOwn(value, key) || value[key] === undefined || value[key] === null || value[key] === '')
  if (missing.length) {
    if (!allowMissing) return invalid('MISSING_INPUT', `缺少能力输入：${missing.join('、')}`, missing)
    const partial = capability.normalizePartialInput(value)
    return partial.ok ? { ...partial, missing } : partial
  }

  return capability.normalizeInput(value)
}

export function buildCapabilityPrompt(capabilityId, input, previousFact, confirmations = []) {
  const capability = requiredCapability(capabilityId)
  const validated = validateCapabilityInput(capabilityId, input)
  if (!validated.ok) throw capabilityError(validated.error.code, validated.error.message)
  return capability.buildPrompt(capability, validated.input, previousFact, projectConfirmations(confirmations))
}

export function parseCapabilityToolResult(capabilityId, value, input) {
  const capability = requiredCapability(capabilityId)
  const validated = validateCapabilityInput(capabilityId, input)
  if (!validated.ok) throw capabilityError('TOOL_CHAIN_INVALID', '能力输入在结果解析时无效')
  if (!plainObject(value)) throw capabilityError('TOOL_CHAIN_INVALID', '工具结果不是对象')
  if (value.ok === false) {
    exactKeys(value, ['ok', 'error'], '工具错误结果')
    if (!plainObject(value.error)) throw capabilityError('TOOL_CHAIN_INVALID', '工具错误结果结构不符合合同')
    exactKeys(value.error, ['code', 'message'], '工具错误结果')
    const code = text(value.error.code)
    const message = text(value.error.message)
    if (!code || !message || !allowedErrorCodes(capabilityId).has(code)) throw capabilityError('TOOL_CHAIN_INVALID', '工具错误结果结构不符合合同')
    throw capabilityError(code, message)
  }
  if (value.ok !== true) throw capabilityError('TOOL_CHAIN_INVALID', '工具结果缺少成功标记')

  return capability.parseResult(capability, value, validated.input)
}

function normalizeGearJobInput(value) {
  const workOrderId = text(value.workOrderId)
  if (!workOrderId || workOrderId.length > 140 || /[\u0000-\u001f\u007f]/.test(workOrderId)) return invalid('INVALID_WORK_ORDER_ID', '工单号无效')
  return { ok: true, input: { workOrderId }, missing: [] }
}

function normalizeCycleInput(value) {
  const result = calculateCycleTime(value)
  return result.ok
    ? { ok: true, input: { availableSeconds: result.availableSeconds, quantity: result.quantity }, missing: [] }
    : invalid(result.error.code, result.error.message)
}

function normalizeCyclePartialInput(value) {
  const input = {}
  if (Object.hasOwn(value, 'availableSeconds') && value.availableSeconds !== undefined && value.availableSeconds !== null && value.availableSeconds !== '') {
    if (typeof value.availableSeconds !== 'number') return invalid('INVALID_AVAILABLE_SECONDS_TYPE', '可用时间必须是数字')
    if (!Number.isFinite(value.availableSeconds)) return invalid('NON_FINITE_AVAILABLE_SECONDS', '可用时间必须是有限数字')
    if (value.availableSeconds < 0) return invalid('NEGATIVE_AVAILABLE_SECONDS', '可用时间不能为负数')
    input.availableSeconds = value.availableSeconds
  }
  if (Object.hasOwn(value, 'quantity') && value.quantity !== undefined && value.quantity !== null && value.quantity !== '') {
    if (typeof value.quantity !== 'number') return invalid('INVALID_QUANTITY_TYPE', '产量必须是数字')
    if (!Number.isFinite(value.quantity)) return invalid('NON_FINITE_QUANTITY', '产量必须是有限数字')
    if (value.quantity <= 0) return invalid('NON_POSITIVE_QUANTITY', '产量必须大于零')
    input.quantity = value.quantity
  }
  return { ok: true, input, missing: [] }
}

function gearJobPrompt(capability, input, previousFact, confirmations) {
  return [
    '你是 Geneway 工单只读说明员工。',
    `必须且只能调用一次 ${capability.toolName}，参数必须精确为 ${JSON.stringify(input)}。`,
    '工具返回后不得再次调用工具；只能依据结构化结果简短说明状态、数量、单位、来源时间和来源性质。',
    '不得猜测缺失字段，不得执行写入。',
    previousFact ? `上一条获准结构化事实仅供对照：${JSON.stringify(projectFact(previousFact))}` : '',
    `当前有效确认：${JSON.stringify(confirmations)}`,
  ].filter(Boolean).join('\n')
}

function cyclePrompt(capability, input, _previousFact, confirmations) {
  return [
    '你是 Geneway 制造节拍换算员工。',
    `必须且只能调用一次 ${capability.toolName}，参数必须精确为 ${JSON.stringify(input)}。`,
    '工具返回后不得再次调用工具；只能依据结构化结果用简短中文说明秒/件。',
    '不得自行计算替代工具结果，不得猜测或执行写入。',
    `当前有效确认：${JSON.stringify(confirmations)}`,
  ].join('\n')
}

function correlationPrompt(capability, input, previousFact, confirmations) {
  return [
    '你是 Geneway 工单与设备只读关联说明员工。',
    `必须且只能调用一次 ${capability.toolName}，参数必须精确为 ${JSON.stringify(input)}。`,
    '工具返回后不得再次调用工具；只能依据结构化结果说明工单、唯一映射、设备采样时间、新鲜度、机器事实和未知项。',
    '不得把 Hive status 解释为质量或停机原因，不得猜测缺失字段，不得执行写入。',
    previousFact ? `上一条获准结构化事实仅供对照：${JSON.stringify(projectFact(previousFact))}` : '',
    `当前有效确认：${JSON.stringify(confirmations)}`,
  ].filter(Boolean).join('\n')
}

function tpmPrompt(capability, input, previousFact, confirmations) {
  return [
    '你是 Geneway Kivo TPM 只读说明员工。',
    `必须且只能调用一次 ${capability.toolName}，参数必须精确为 ${JSON.stringify(input)}。`,
    '工具返回后不得再次调用工具；只能依据同一结构化观察说明记录类型、原始与规范状态、关联设备、责任人、计划及执行时间、来源与查询时间。',
    'scope_empty 表示当前机器账号没有组织读取范围，不能解释为没有业务记录。列表仅说明返回页，不声称已读完其他页。',
    '时间、状态或计划基线未知时明确说未知，逾期判断只能采用程序结果；不得自行计算、猜测或执行写入。',
    previousFact ? `上一条获准结构化事实仅供对照：${JSON.stringify(projectFact(previousFact))}` : '',
    `当前有效确认：${JSON.stringify(confirmations)}`,
  ].filter(Boolean).join('\n')
}

function parseTpmResult(capability, value, input) {
  exactKeys(value, ['ok', 'observation'], 'Kivo TPM 工具结果')
  try {
    const observation = assertTpmObservation(value.observation)
    const mode = capability.id === KIVO_TPM_RECORD_READ_CAPABILITY ? 'record' : 'list'
    if (observation.mode !== mode || observation.recordType !== input.recordType) throw new Error('type mismatch')
    const request = tpmToolRequest(mode, input)
    if (!sameTpmPath(observation.sources[0].path, tpmSourcePath(request))) throw new Error('source mismatch')
    const sourceKeys = ['system', 'path', 'queriedAt', 'traceId']
    const empty = observation.status === 'scope_empty'
    const result = {
      status: observation.status, source: pick(observation.sources[0], sourceKeys),
      value: empty ? null : mode === 'record' ? observation.records[0].facts : { ...observation.pagination, items: observation.records.map(record => record.facts) },
    }
    const deviceResult = observation.sources[1] ? {
      status: observation.status, source: pick(observation.sources[1], sourceKeys), value: empty ? null : observation.linkedDevice.facts,
    } : undefined
    const expected = normalizeTpmObservation({ mode, input, result, deviceResult, connection: observation.source })
    if (!isDeepStrictEqual(observation, expected)) throw new Error('observation mismatch')
    if (deviceResult && (deviceResult.source.traceId !== result.source.traceId
      || (!empty && !sameTpmPath(deviceResult.source.path, tpmSourcePath(tpmToolRequest('record', { recordType: 'device', reference: observation.records[0].deviceId })))))) throw new Error('device source mismatch')
    const payload = structuredClone(observation)
    return { kind: capability.resultKind, payload, source: structuredClone(payload.source), toolName: capability.toolName, pluginId: capability.pluginId, pluginVersion: capability.pluginVersion }
  } catch {
    throw capabilityError('TOOL_CHAIN_INVALID', 'Kivo TPM 工具结果与固定输入或结构化观察不匹配')
  }
}

function sameTpmPath(actual, expected) {
  const source = new URL(actual, 'http://kivo.invalid'), target = new URL(expected, 'http://kivo.invalid')
  source.searchParams.sort(); target.searchParams.sort()
  return source.href === target.href
}

function parseGearJobResult(capability, value, input) {
  const allowed = ['ok', 'workOrderId', 'status', 'plannedQuantity', 'completedQuantity', 'unit', 'sourceTime', 'sourceRecordId', 'sourceRevision', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']
  exactKeys(value, allowed, 'GearJob 工具结果', true)
  const required = ['workOrderId', 'status', 'sourceRecordId', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']
  for (const key of required) requiredText(value[key], `工具结果缺少 ${key}`)
  if (value.workOrderId !== input.workOrderId) throw capabilityError('TOOL_CHAIN_INVALID', '工具结果工单号不匹配')
  for (const key of ['sourceTime', 'sourceRevision', 'unit']) if (value[key] !== undefined) requiredText(value[key], `工具结果 ${key} 无效`)
  for (const key of ['plannedQuantity', 'completedQuantity']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw capabilityError('TOOL_CHAIN_INVALID', `工具结果 ${key} 无效`)
  const payload = { ...value }
  delete payload.ok
  return {
    kind: capability.resultKind,
    payload,
    source: pick(payload, ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'sourceRecordId', 'sourceRevision', 'sourceTime']),
    toolName: capability.toolName,
    pluginId: capability.pluginId,
    pluginVersion: capability.pluginVersion,
  }
}

function parseCycleResult(capability, value, input) {
  exactKeys(value, ['ok', 'availableSeconds', 'quantity', 'secondsPerUnit', 'unit'], '节拍工具结果')
  const expected = calculateCycleTime(input)
  if (!expected.ok || value.availableSeconds !== expected.availableSeconds || value.quantity !== expected.quantity || value.secondsPerUnit !== expected.secondsPerUnit || value.unit !== expected.unit || !Number.isFinite(value.secondsPerUnit)) {
    throw capabilityError('TOOL_CHAIN_INVALID', '节拍工具结果与确定性输入不匹配')
  }
  const payload = { ...value }
  delete payload.ok
  return {
    kind: capability.resultKind,
    payload,
    toolName: capability.toolName,
    pluginId: capability.pluginId,
    pluginVersion: capability.pluginVersion,
  }
}

function parseCorrelationResult(capability, value, input) {
  exactKeys(value, ['ok', 'workOrderId', 'queriedAt', 'connections', 'gearJob', 'hive', 'mapping', 'tenant', 'device', 'sample', 'status', 'recordId', 'eventId', 'freshness', 'machineFacts', 'unknowns'], '工单设备关联工具结果')
  if (value.workOrderId !== input.workOrderId) throw capabilityError('TOOL_CHAIN_INVALID', '工具结果工单号不匹配')
  requiredText(value.queriedAt, '工具结果缺少 queriedAt')
  for (const key of ['connections', 'gearJob', 'hive', 'mapping', 'tenant', 'device', 'sample', 'freshness', 'machineFacts']) {
    if (!plainObject(value[key])) throw capabilityError('TOOL_CHAIN_INVALID', `工具结果 ${key} 无效`)
  }
  if (!Array.isArray(value.unknowns) || value.unknowns.some(item => !text(item))) throw capabilityError('TOOL_CHAIN_INVALID', '工具结果 unknowns 无效')
  requiredText(value.recordId, '工具结果缺少 recordId')
  requiredText(value.eventId, '工具结果缺少 eventId')
  if (!['string', 'number', 'boolean'].includes(typeof value.status)) throw capabilityError('TOOL_CHAIN_INVALID', '工具结果 status 无效')
  const payload = structuredClone(value)
  delete payload.ok
  return {
    kind: capability.resultKind,
    payload,
    source: structuredClone({ gearJob: value.gearJob, hive: value.hive }),
    toolName: capability.toolName,
    pluginId: capability.pluginId,
    pluginVersion: capability.pluginVersion,
  }
}

export function buildFollowUpPrompt(value) {
  const context = sanitizeFollowUpContext(value)
  return [
    '你是 Geneway 结构化事实说明员工。这个追问严禁调用任何工具。',
    '只能依据服务端白名单注入的当前结构化事实、当前有效确认信息和本次问题回答。',
    '不得使用旧 explanation、旧追问、摘要、隐藏历史或外部知识补全业务事实；事实不足时明确说未知。',
    `结构化事实：${JSON.stringify(context.facts)}`,
    `当前有效确认：${JSON.stringify(context.confirmations)}`,
    `本次问题：${context.question}`,
    '用简短中文说明依据。',
  ].join('\n')
}

export function sanitizeFollowUpContext(value) {
  if (!plainObject(value)) throw capabilityError('INVALID_REQUEST', '追问上下文必须是对象')
  exactKeys(value, ['question', 'facts', 'confirmations'], '追问上下文', true)
  const question = text(value.question)
  if (!question || question.length > 4000) throw capabilityError('INVALID_REQUEST', '追问内容为空或过长')
  if (!Array.isArray(value.facts) || value.facts.length === 0 || value.facts.length > 20) throw capabilityError('INVALID_REQUEST', '追问必须包含 1 到 20 条结构化事实')
  if (!Array.isArray(value.confirmations) || value.confirmations.length > 50) throw capabilityError('INVALID_REQUEST', '当前确认信息结构无效')
  const facts = value.facts.map(projectFact)
  const confirmations = projectConfirmations(value.confirmations)
  return { question, facts, confirmations }
}

function projectConfirmations(value) {
  if (!Array.isArray(value) || value.length > 50) throw capabilityError('INVALID_REQUEST', '当前确认信息结构无效')
  return value.map(item => {
    if (!plainObject(item)) throw capabilityError('INVALID_REQUEST', '当前确认信息结构无效')
    exactKeys(item, ['id', 'revision', 'label', 'value'], '当前确认信息')
    const id = requiredText(item.id, '当前确认信息缺少 id')
    const label = requiredText(item.label, '当前确认信息缺少 label')
    const confirmationValue = requiredText(item.value, '当前确认信息缺少 value')
    if (!Number.isInteger(item.revision) || item.revision < 1) throw capabilityError('INVALID_REQUEST', '当前确认信息 revision 无效')
    return { id, revision: item.revision, label, value: confirmationValue }
  })
}

function projectFact(value) {
  if (!plainObject(value)) throw capabilityError('INVALID_REQUEST', '结构化事实无效')
  exactKeys(value, ['kind', 'payload', 'source'], '结构化事实', true)
  if (value.kind === 'gearjob.work-order.observation') {
    if (!plainObject(value.payload)) throw capabilityError('INVALID_REQUEST', 'GearJob 结构化事实无效')
    const payload = pick(value.payload, ['workOrderId', 'status', 'plannedQuantity', 'completedQuantity', 'unit', 'sourceTime', 'sourceRecordId', 'sourceRevision', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'])
    parseCapabilityToolResult('gearjob-work-order-read', { ok: true, ...payload }, { workOrderId: payload.workOrderId })
    return { kind: value.kind, payload, ...(value.source ? { source: pick(value.source, ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'sourceRecordId', 'sourceRevision', 'sourceTime']) } : {}) }
  }
  if (value.kind === 'manufacturing.takt') {
    if (!plainObject(value.payload)) throw capabilityError('INVALID_REQUEST', '节拍结构化事实无效')
    const payload = pick(value.payload, ['availableSeconds', 'quantity', 'secondsPerUnit', 'unit'])
    parseCapabilityToolResult('cycle-time-calculate', { ok: true, ...payload }, { availableSeconds: payload.availableSeconds, quantity: payload.quantity })
    return { kind: value.kind, payload }
  }
  if (value.kind === 'manufacturing.work-order-device-correlation') {
    if (!plainObject(value.payload)) throw capabilityError('INVALID_REQUEST', '工单设备关联结构化事实无效')
    const parsed = parseCapabilityToolResult(WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, { ok: true, ...value.payload }, { workOrderId: value.payload.workOrderId })
    return { kind: value.kind, payload: parsed.payload, ...(value.source ? { source: parsed.source } : {}) }
  }
  if (value.kind === KIVO_TPM_RESULT_KIND) {
    let payload
    try { payload = structuredClone(assertTpmObservation(value.payload)) } catch { throw capabilityError('INVALID_REQUEST', 'Kivo TPM 结构化事实无效') }
    if (value.source !== undefined && !isDeepStrictEqual(value.source, payload.source)) throw capabilityError('INVALID_REQUEST', 'Kivo TPM 事实来源不匹配')
    return { kind: value.kind, payload, source: structuredClone(payload.source) }
  }
  throw capabilityError('INVALID_REQUEST', '结构化事实 kind 未获准')
}

function requiredCapability(id) {
  const capability = capabilities[id]
  if (!capability) throw capabilityError('CAPABILITY_NOT_FOUND', '能力不存在')
  return capability
}

function allowedErrorCodes(capabilityId) {
  return ['gearjob-work-order-read', WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, KIVO_TPM_RECORD_READ_CAPABILITY, KIVO_TPM_RECORD_LIST_CAPABILITY].includes(capabilityId)
    ? new Set(['INVALID_REQUEST', 'SOURCE_NOT_CONFIGURED', 'FORBIDDEN', 'NOT_FOUND', 'CANCELLED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR', 'INVALID_SOURCE'])
    : new Set(['INVALID_INPUT', 'MISSING_AVAILABLE_SECONDS', 'MISSING_QUANTITY', 'INVALID_AVAILABLE_SECONDS_TYPE', 'INVALID_QUANTITY_TYPE', 'NON_FINITE_AVAILABLE_SECONDS', 'NON_FINITE_QUANTITY', 'NEGATIVE_AVAILABLE_SECONDS', 'NON_POSITIVE_QUANTITY', 'NON_FINITE_RESULT', 'FORBIDDEN', 'CANCELLED'])
}

function invalid(code, message, missing = []) {
  return { ok: false, missing, error: { code, message } }
}

function exactKeys(value, allowed, label, allowMissing = false) {
  const expected = new Set(allowed)
  const unexpected = Object.keys(value).find(key => !expected.has(key))
  if (unexpected) throw capabilityError('TOOL_CHAIN_INVALID', `${label}包含未声明字段 ${unexpected}`)
  if (!allowMissing) {
    const missing = allowed.find(key => !Object.hasOwn(value, key))
    if (missing) throw capabilityError('TOOL_CHAIN_INVALID', `${label}缺少 ${missing}`)
  }
}

function requiredText(value, message) {
  const result = text(value)
  if (!result) throw capabilityError('TOOL_CHAIN_INVALID', message)
  return result
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
}

function capabilityError(code, message) {
  return Object.assign(new Error(message), { code })
}
