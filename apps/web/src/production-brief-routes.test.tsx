import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProductionBriefPage } from './production-brief-routes.js';

describe('ProductionBriefPage', () => {
  it('renders a real-run button and no browser fixture or timer orchestration', () => {
    const html = renderToStaticMarkup(<ProductionBriefPage />);
    expect(html).toContain('运行 SCN-NORMAL');
    expect(html).toContain('页面仅持有场景引用');
    const source = readFileSync(new URL('./production-brief-routes.tsx', import.meta.url), 'utf8');
    expect(source).toContain('api.runProductionWorkOrderEquipmentBrief()');
    expect(source).not.toMatch(/production-brief-mock|setTimeout|expectedDecision|runProductionBriefMock/u);
  });
});
