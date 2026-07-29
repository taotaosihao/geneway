import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resolveProductionBriefMock } from './production-brief-mock.js';
import { ProductionBriefMockPage, ProductionBriefResultView } from './production-brief-mock-routes.js';

describe('production planner end-to-end mock UI', () => {
  it('renders one coherent user journey with six selectable business scenarios', () => {
    const html = renderToStaticMarkup(<ProductionBriefMockPage />);
    expect(html).toContain('data-testid="production-mock-boundary"');
    expect(html).toContain('全合成业务演示');
    expect(html).toContain('未连接 GearJob / Hive，不含客户数据');
    expect(html).toContain('这个工单今天需要采取什么行动？');
    expect(html).toContain('NO_ACTION · FOLLOW_UP · ESCALATE · UNKNOWN');
    expect(html.match(/data-testid="mock-scenario-/gu)).toHaveLength(6);
    expect(html).toContain('data-testid="run-production-mock"');
    expect(html).toContain('data-testid="production-mock-stages"');
  });

  it.each([
    ['normal-running', 'NO_ACTION', '暂不跟进'],
    ['progress-behind-stop', 'FOLLOW_UP', '今日跟进'],
    ['active-critical-alarm', 'ESCALATE', '立即升级'],
    ['stale-hive-data', 'UNKNOWN', '明确未知项'],
    ['unmapped-work-order', 'UNKNOWN', '安全降级：只展示工单事实'],
    ['multiple-equipment-mapping', 'UNKNOWN', '要求人工明确设备'],
  ] as const)('renders %s as an explainable %s result', (scenarioId, expectedAction, expectedCopy) => {
    const html = renderToStaticMarkup(<ProductionBriefResultView result={resolveProductionBriefMock(scenarioId)} />);
    expect(html).toContain(`data-action="${expectedAction}"`);
    expect(html).toContain(expectedCopy);
    expect(html).toContain('data-testid="mock-work-order-facts"');
    expect(html).toContain('data-testid="mock-equipment-mapping"');
    expect(html).toContain('data-testid="mock-runtime-status"');
    expect(html).toContain('data-testid="mock-alarm-segments"');
    expect(html).toContain('SYNTHETIC_DEMO');
  });
});
