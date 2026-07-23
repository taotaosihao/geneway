import { describe, expect, it } from 'vitest';
import { taskEventProjectionSchema, type TaskEventProjection } from '@geneway/contracts';
import { ApiError, mergeTaskEventBatch } from './api.js';
import { routeStateForError } from './product-routes.js';

function event(cursor: number, id = `event_${String(cursor)}`): TaskEventProjection {
  return taskEventProjectionSchema.parse({
    cursor,
    id,
    businessTaskId: 'task_exception',
    sequence: cursor,
    aggregateVersion: cursor,
    occurredAt: '2026-07-23T08:00:00.000Z',
    simulation: true,
    runtimeMode: 'fake',
    businessDecisionAllowed: false,
    eventType: cursor === 4 ? 'workflow.run_reclaimed' : 'workflow.step_completed',
    payload: cursor === 4 ? {} : { stepId: `step_${String(cursor)}` },
  });
}

describe('Gate 0.2B.3 public recovery helpers', () => {
  it('replays strictly after eventCursor and deduplicates an out-of-order batch', () => {
    const merged = mergeTaskEventBatch('task_exception', 2, [event(5), event(3), event(4), event(3)]);
    expect(merged.events.map((item) => item.cursor)).toEqual([3, 4, 5]);
    expect(merged.cursor).toBe(5);
    expect(() => mergeTaskEventBatch('task_exception', 2, [event(3), event(3, 'collision')]))
      .toThrow('TASK_EVENT_CURSOR_COLLISION');
    expect(() => mergeTaskEventBatch('other_task', 2, [event(3)]))
      .toThrow('TASK_EVENT_TASK_MISMATCH');
  });

  it('maps real HTTP and network failures to stable route states', () => {
    expect(routeStateForError(new ApiError('DENIED', 'denied', 403))).toBe('forbidden');
    expect(routeStateForError(new ApiError('MISSING', 'missing', 404))).toBe('not-found');
    expect(routeStateForError(new ApiError('BUSINESS_EXCEPTION_STALE', 'stale', 409))).toBe('stale');
    expect(routeStateForError(new ApiError('ANALYSIS_BINDING_CONFLICT', 'conflict', 409))).toBe('binding-conflict');
    expect(routeStateForError(new ApiError('APPROVAL_SUBJECT_CHANGED', 'stale approval', 409))).toBe('approval-stale');
    expect(routeStateForError(new ApiError('NETWORK_OFFLINE', 'offline', 0))).toBe('offline');
    expect(routeStateForError(new ApiError('INTERNAL', 'failed', 500))).toBe('server-error');
  });
});
