import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { gateA3PublicTaskSnapshotSchema } from '@geneway/contracts';
import { FastChatExperience } from './chat-app.js';
import { WorkOrderTaskView } from './work-order-routes.js';

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const timestamp = '2026-07-27T01:02:03.000Z';
const sourceTimestamp = '2026-07-27T01:02:03.000000Z';

const stepDefinitions = [
  ['validate_work_order_ref', 'deterministic'],
  ['fetch_authorized_status', 'deterministic'],
  ['compute_progress', 'deterministic'],
  ['explain_status', 'agent'],
  ['evidence_verify', 'verification'],
  ['publish_status_card', 'deterministic'],
] as const;

function snapshot(status: 'awaiting_approval' | 'approved' | 'completed') {
  const evidenceRefs = {
    status: 'evidence_status_1',
    planQty: 'evidence_plan_1',
    completedQty: 'evidence_completed_1',
    updatedAt: 'evidence_updated_1',
    sourceAsOf: 'evidence_updated_1',
  };
  return gateA3PublicTaskSnapshotSchema.parse({
    schemaVersion: 'gate-a3-public-task-snapshot/1',
    recordVariant: 'business-task.work-order.live/1',
    taskId: 'task_work_order_1',
    conversationId: 'conversation_work_order_1',
    capabilityId: 'production.work-order-status.v1',
    status,
    inputRef: { kind: 'work_order', workOrderRef: 'WO-Exact.01:QA' },
    workflowVersionId: 'workflow_work_order_1',
    workflowHash: shaA,
    workflow: {
      templateId: 'workflow-template.work-order-status/1',
      workflowVersionId: 'workflow_work_order_1',
      workflowHash: shaA,
      steps: stepDefinitions.map(([id, kind]) => ({ id, kind, status: status === 'completed' ? 'completed' : 'queued', attemptId: null, fence: null })),
    },
    approval: {
      id: 'approval_work_order_1',
      version: 1,
      status: status === 'awaiting_approval' ? 'pending' : 'approved',
      subjectDigest: shaB,
      expiresAt: '2026-07-27T02:02:03.000Z',
    },
    connectorQuerySpecHash: shaB,
    result: status === 'completed' ? {
      kind: 'work_order_status',
      card: {
        schemaVersion: 'WorkOrderStatusCard/1',
        workOrderRef: 'WO-Exact.01:QA',
        status: 'IN_PROGRESS',
        planQty: 100,
        completedQty: 25,
        unit: '件',
        progressPct: 25,
        updatedAt: sourceTimestamp,
        sourceAsOf: sourceTimestamp,
        evidenceRefs,
        readOnly: true,
      },
      explanation: {
        schemaVersion: 'work-order.explanation/1',
        summary: '工单 WO-Exact.01:QA 当前状态为“IN_PROGRESS”；基于已验证数量，确定性进度为 25%。',
        statements: [{ id: 'explanation_fact_1', kind: 'fact', text: '状态以来源时间为准。', sourceFields: ['status', 'planQty', 'completedQty'] }],
      },
    } : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

describe('Gate A.3 served work-order UI projection', () => {
  it('keeps the default no-material Fast Chat composer and exposes an independent work-order entry', () => {
    const html = renderToStaticMarkup(<FastChatExperience />);
    expect(html).toContain('data-testid="geneway-fast-chat"');
    expect(html).toContain('直接输入普通文本即可开始，无需上传材料');
    expect(html).toContain('data-testid="material-analysis-link"');
    expect(html).toContain('data-testid="work-order-entry-link"');
    expect(html).toContain('data-testid="work-order-top-entry"');
    expect(html).toContain('href="/work-orders/new"');
  });

  it('renders the frozen six-node Workflow and Approval without connector internals', () => {
    const html = renderToStaticMarkup(<WorkOrderTaskView task={snapshot('awaiting_approval')} busy={false}
      onApproveAndExecute={() => undefined} onCancel={() => undefined} />);
    expect(html.match(/<li>/gu)).toHaveLength(6);
    expect(html).toContain('workflow-template.work-order-status/1');
    expect(html).toContain(shaA);
    expect(html).toContain('ApprovalVersion');
    expect(html).toContain('批准并执行只读查询');
    for (const forbidden of ['endpoint', 'profile', 'credential', 'raw receipt', 'audit']) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('keeps an approved task executable after refresh recovery', () => {
    const html = renderToStaticMarkup(<WorkOrderTaskView task={snapshot('approved')} busy={false}
      onApproveAndExecute={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain('status-approved');
    expect(html).toContain('执行已审批只读查询');
  });

  it('renders a read-only WorkOrderStatusCard with per-field Evidence and a separate Xiaowei explanation', () => {
    const html = renderToStaticMarkup(<WorkOrderTaskView task={snapshot('completed')} busy={false}
      onApproveAndExecute={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain('data-testid="work-order-status-card"');
    expect(html).toContain('data-read-only="true"');
    expect(html).toContain('IN_PROGRESS');
    expect(html).toContain('25%');
    expect(html).toContain('字段 Evidence');
    expect(html).toContain('href="#evidence-evidence_status_1"');
    expect(html).toContain('data-testid="work-order-explanation"');
    expect(html).toContain('工单 WO-Exact.01:QA 当前状态为“IN_PROGRESS”；基于已验证数量，确定性进度为 25%。');
    for (const forbidden of ['endpoint', 'profile', 'credential', 'raw receipt', 'audit']) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
  });
});
