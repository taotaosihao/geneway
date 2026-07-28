import { describe, expect, it } from 'vitest';
import {
  assertNoSensitiveWorkOrderProjection,
  gateA3TaskSqlLiteral,
  servedTaskTerminalFailure,
} from './gate-a3-served-task-state.mjs';

describe('Gate A.3 served task terminal observation', () => {
  it('returns the stable public failure code immediately', () => {
    expect(servedTaskTerminalFailure({
      status: 'failed',
      result: { kind: 'failed', code: 'MODEL_PROTOCOL_VIOLATION', message: 'redacted public message' },
    })).toEqual({ status: 'failed', code: 'MODEL_PROTOCOL_VIOLATION' });
  });

  it('distinguishes cancellation and ignores non-terminal or malformed snapshots', () => {
    expect(servedTaskTerminalFailure({ status: 'canceled', result: null })).toEqual({
      status: 'canceled', code: 'TASK_CANCELED',
    });
    expect(servedTaskTerminalFailure({ status: 'running', result: null })).toBeNull();
    expect(servedTaskTerminalFailure({ status: 'failed', result: { kind: 'failed' } })).toBeNull();
    expect(servedTaskTerminalFailure(null)).toBeNull();
  });

  it('quotes only the already validated opaque task ID for the read-only DB oracle', () => {
    expect(gateA3TaskSqlLiteral('task_123e4567-e89b-12d3-a456-426614174000'))
      .toBe("'task_123e4567-e89b-12d3-a456-426614174000'");
    expect(() => gateA3TaskSqlLiteral("task_' OR true --")).toThrow(/task ID is invalid/u);
    expect(() => gateA3TaskSqlLiteral('other_123')).toThrow(/task ID is invalid/u);
  });

  it('checks generic internal labels on the visible business surface, not inert CSS or module markup', () => {
    expect(() => assertNoSensitiveWorkOrderProjection({
      visibleText: '工单 WO-1 当前状态为 IN_PROGRESS。',
      serializedDom: '<style>.profile-card{display:grid}.endpoint-note{display:none}</style>',
    })).not.toThrow();
    expect(() => assertNoSensitiveWorkOrderProjection({
      visibleText: 'Connector Gateway profile',
      serializedDom: '<main>Connector Gateway profile</main>',
    })).toThrow(/Connector Gateway.*profile|profile.*Connector Gateway/u);
  });

  it('rejects concrete credential and GearJob route material anywhere in the serialized DOM', () => {
    for (const serializedDom of [
      '<div data-route="/api/method/gearjob.api.get_work_order_status"></div>',
      '<meta content="Bearer abcdefghijklmnop">',
      '<input value="api_secret=super-secret-value">',
      '<code>authorization: token-value-123</code>',
    ]) {
      expect(() => assertNoSensitiveWorkOrderProjection({ visibleText: '只读工单状态', serializedDom }))
        .toThrow(/forbidden internal material/u);
    }
  });

  it('fails closed when either browser surface is missing', () => {
    expect(() => assertNoSensitiveWorkOrderProjection({ visibleText: 'ok', serializedDom: undefined }))
      .toThrow(/surfaces are invalid/u);
  });
});
