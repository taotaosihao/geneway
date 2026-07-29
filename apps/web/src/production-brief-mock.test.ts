import { describe, expect, it, vi } from 'vitest';
import {
  PRODUCTION_BRIEF_MOCK_SCENARIOS,
  PRODUCTION_BRIEF_STAGE_IDS,
  resolveProductionBriefMock,
  runProductionBriefMock,
  type ProductionBriefStageId,
  type ProductionBriefStageStatus,
} from './production-brief-mock.js';

describe('production planner end-to-end mock contract', () => {
  it('keeps a deterministic scenario set with unique business references', () => {
    expect(PRODUCTION_BRIEF_MOCK_SCENARIOS).toHaveLength(6);
    expect(new Set(PRODUCTION_BRIEF_MOCK_SCENARIOS.map((scenario) => scenario.id)).size).toBe(6);
    expect(new Set(PRODUCTION_BRIEF_MOCK_SCENARIOS.map((scenario) => scenario.workOrder.workOrderRef)).size).toBe(6);
    expect(PRODUCTION_BRIEF_MOCK_SCENARIOS.every((scenario) => scenario.businessQuestion.length > 0)).toBe(true);
  });

  it.each([
    ['normal-running', 'NO_ACTION'],
    ['progress-behind-stop', 'FOLLOW_UP'],
    ['active-critical-alarm', 'ESCALATE'],
    ['stale-hive-data', 'UNKNOWN'],
    ['unmapped-work-order', 'UNKNOWN'],
    ['multiple-equipment-mapping', 'UNKNOWN'],
  ] as const)('resolves %s to %s without model guessing', (scenarioId, expectedAction) => {
    const first = resolveProductionBriefMock(scenarioId);
    const second = resolveProductionBriefMock(scenarioId);
    expect(first).toEqual(second);
    expect(first.action).toBe(expectedAction);
    expect(first.provenance).toBe('SYNTHETIC_DEMO');
    expect(first.workOrder.source.system).toBe('GearJob');
    expect(first.mapping.source.capabilityId).toBe('production.work_order.equipment.resolve.v1');
  });

  it('keeps stale and ambiguous cases explicit instead of treating empty data as healthy', () => {
    const stale = resolveProductionBriefMock('stale-hive-data');
    expect(stale.runtimeStatus?.knownState).toBe('STALE');
    expect(stale.alarms?.coverage).toBe('PARTIAL');
    expect(stale.unknowns).toEqual(expect.arrayContaining([
      expect.stringContaining('不够新鲜'),
      expect.stringContaining('覆盖不完整'),
    ]));

    const multiple = resolveProductionBriefMock('multiple-equipment-mapping');
    expect(multiple.mapping.cardinality).toBe('multiple');
    expect(multiple.mapping.selectedEquipmentRef).toBeNull();
    expect(multiple.mapping.fallback).toBe('explicit-machine-selection');
    expect(multiple.runtimeStatus).toBeNull();
  });

  it('runs the full ordered capability chain and safely skips equipment calls when mapping is absent', async () => {
    vi.useFakeTimers();
    const normalEvents: Array<readonly [ProductionBriefStageId, ProductionBriefStageStatus]> = [];
    const normalRun = runProductionBriefMock('normal-running', (stageId, status) => normalEvents.push([stageId, status]), 10);
    await vi.runAllTimersAsync();
    await expect(normalRun).resolves.toMatchObject({ action: 'NO_ACTION' });
    expect(normalEvents.filter(([, status]) => status === 'completed').map(([stageId]) => stageId))
      .toEqual(PRODUCTION_BRIEF_STAGE_IDS);

    const unmappedEvents: Array<readonly [ProductionBriefStageId, ProductionBriefStageStatus]> = [];
    const unmappedRun = runProductionBriefMock('unmapped-work-order', (stageId, status) => unmappedEvents.push([stageId, status]), 10);
    await vi.runAllTimersAsync();
    await expect(unmappedRun).resolves.toMatchObject({ action: 'UNKNOWN' });
    expect(unmappedEvents).toContainEqual(['runtime_status', 'skipped']);
    expect(unmappedEvents).toContainEqual(['alarm_segments', 'skipped']);
    vi.useRealTimers();
  });
});
