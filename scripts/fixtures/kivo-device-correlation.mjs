import { normalizeTpmDeviceCorrelation } from '../../src/domain/tpm-device-correlation.mjs'

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
