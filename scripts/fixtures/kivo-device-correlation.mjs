import { normalizeTpmDeviceCorrelation } from '../../src/domain/tpm-device-correlation.mjs'
import { getCapability, KIVO_TPM_DEVICE_CORRELATION_CAPABILITY, parseCapabilityToolResult } from '../../src/capabilities.mjs'
import { finishExecutionRuntime } from '../../src/execution-runtime.mjs'

export const now = '2026-10-16T10:00:00.000Z'
export const deviceId = '00000000-0000-4000-8000-000000000002'
export const recordId = '00000000-0000-4000-8000-000000000001'
export const connection = { id: 'kivo', name: '合成实例', kind: 'kivo-mcp', targetIdentity: 'synthetic-a', baseUrl: 'http://127.0.0.1:41001/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41001', clientId: '00000000-0000-4000-8000-000000000003', credentialRef: 'synthetic.pem', allowedObjectIds: [], enabled: true, status: 'ready', revision: 1, skillIds: ['skill-kivo-tpm-device-correlate'], sourceSystem: 'Kivo', sourceInstance: 'synthetic-a', sourceEnvironment: 'pure-test', dataMode: 'synthetic', evidenceMode: 'controlled-function' }
export function correlationFixture({ at = now, sampleAt = now, recordType = 'repair', reference = 'R-1', record = {}, device = {}, monitor = {}, binding = connection } = {}) {
  const source = path => ({ system: 'kivo', path, queriedAt: at, traceId: 'synthetic-read' })
  const value = { deviceId, deviceCode: 'D-1', snapshotAt: at, receivedAtMeaning: 'projection', sourceReceivedAt: null, sourceQuality: null,
    current: { status: 'success', trusted: true, recordTs: sampleAt, snapshot: { snapshotAt: at, observedAt: sampleAt, receivedAt: at,
      availability: { status: 'success', reasonCode: 'CURRENT_RECORD' }, connection: { status: 'online', missingReason: null }, runtime: { status: 'processing', missingReason: null },
      deviceAlarm: { activeCount: 0, summaries: [], missingReason: null } } }, ...monitor }
  return normalizeTpmDeviceCorrelation({ input: { recordType, reference }, connection: binding,
    result: { status: 'ok', source: source(`/api/v1/mes/tpm/${recordType === 'repair' ? 'repairs' : recordType === 'inspection' ? 'inspections' : 'maintenance'}/${reference}`), value: { id: recordId, orderNo: reference, inspectionNo: reference, deviceId, revision: 1, status: 'reported', createdAt: now, updatedAt: now, ...record } },
    deviceResult: { status: 'ok', source: source(`/api/v1/mes/equipment/ledger/devices/${deviceId}`), value: { id: deviceId, code: 'D-1', name: '合成设备', lifecycleStatus: 'active', ...device } },
    monitorResult: { status: 'ok', source: source('/api/v1/mes/equipment/monitor/D-1/current'), value },
  })
}

// A persisted injected result tree; this fixture never starts a model or performs business I/O.
export async function createCompletedCorrelationTree({ store, workService, actor, conversationId, leaderEmployeeId, childEmployeeId, at = now, binding = connection }) {
  const cap = getCapability(KIVO_TPM_DEVICE_CORRELATION_CAPABILITY), input = { recordType: 'repair', reference: 'R-1' }
  const created = await workService.createCollaboration(actor, { employeeId: leaderEmployeeId, skillId: cap.skillId, connectionId: binding.id, conversationId,
    goal: '合成协作关联', clientRequestId: `receipt-tree:${conversationId}`, items: [{ id: 'correlation', employeeId: childEmployeeId, skillId: cap.skillId, connectionId: binding.id, input }] })
  if (!created.ok) throw new Error(`receipt tree: ${created.error.code}`)
  const rootId = created.value.id, childId = created.value.plan.items[0].childWorkId
  await store.update(state => {
    const root = state.works.find(work => work.id === rootId), child = state.works.find(work => work.id === childId)
    const handoffId = `${rootId}-handoff`, resultId = `${childId}-result`, summaryId = `${rootId}-summary`
    const parsed = parseCapabilityToolResult(cap.id, { ok: true, observation: correlationFixture({ at, sampleAt: at, binding, ...input }) }, input)
    const result = { ...parsed, id: resultId, capabilityId: cap.id, skillId: cap.skillId, schemaVersion: 1, input, explanation: '合成关联事实', createdAt: at,
      toolName: cap.toolName, pluginId: cap.pluginId, pluginVersion: cap.pluginVersion, dshSessionRef: `${childId}-synthetic-session`, contextConfirmationRefs: [], employeeId: child.employeeId, handoffRefs: [handoffId], generation: 1, knowledgeDependencyRefs: [] }
    const summary = { id: summaryId, kind: 'assistant.collaboration-summary', capabilityId: cap.id, skillId: cap.skillId, schemaVersion: 1, input: {}, payload: { resultRefs: [resultId] }, explanation: '合成协作汇总', createdAt: at,
      dshSessionRef: `${rootId}-synthetic-session`, contextConfirmationRefs: [], employeeId: root.employeeId, handoffRefs: [handoffId], generation: 1, knowledgeDependencyRefs: [] }
    const complete = (execution, value) => ({ ...execution, status: 'completed', completedAt: at, closePending: false, resultId: value.id, dshSessionRef: value.dshSessionRef, runtime: finishExecutionRuntime(execution.runtime, { completedAt: at }) })
    return { ...state, works: state.works.map(work => work.id === rootId ? { ...root, status: 'completed', results: [summary], executions: root.executions.map(execution => complete(execution, summary)),
      collaboration: { ...root.collaboration, status: 'completed', summaryResultRefs: [resultId] }, plan: { ...root.plan, items: root.plan.items.map(item => ({ ...item, status: 'completed' })) },
      handoffs: [{ id: handoffId, childWorkId: childId, fromEmployeeId: child.employeeId, toEmployeeId: root.employeeId, resultRefs: [resultId], knowledgeRefs: [], revision: 1, generation: 1, status: 'current', createdAt: at }],
    } : work.id === childId ? { ...child, status: 'completed', results: [result], executions: child.executions.map(execution => complete(execution, result)) } : work) }
  })
  return { root: (await store.read()).works.find(work => work.id === rootId), child: (await store.read()).works.find(work => work.id === childId) }
}
