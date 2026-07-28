import { ConversationExperience } from './app.js';
import { ExceptionDetailPage, ExceptionListPage } from './exception-routes.js';
import {
  TaskDetailPage,
  TaskListPage,
  TaskWorkflowPage,
  WorkflowDetailPage,
  WorkflowListPage,
} from './product-routes.js';
import { WorkOrderPage } from './work-order-routes.js';

function decodePathSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && !decoded.includes('/') ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function NotFoundPage() {
  return <main className="not-open" data-testid="route-not-found">
    <span>ROUTE_NOT_FOUND</span>
    <h1>这里没有可打开的页面</h1>
    <p>返回小纬，或从任务与 Workflow 列表继续。</p>
    <div className="not-found-actions"><a className="primary" href="/conversations/new?capability=solution.analysis.v1">与小纬对话</a><a className="secondary" href="/tasks">查看任务</a></div>
  </main>;
}

export function App() {
  const segments = window.location.pathname.split('/').filter(Boolean);

  if (segments.length === 2 && segments[0] === 'conversations') {
    if (segments[1] === 'new') return <ConversationExperience />;
    const conversationId = decodePathSegment(segments[1] ?? '');
    return conversationId === undefined ? <NotFoundPage /> : <ConversationExperience conversationId={conversationId} />;
  }

  if (segments.length === 1 && segments[0] === 'tasks') return <TaskListPage />;
  if (segments.length === 2 && segments[0] === 'tasks') {
    const taskId = decodePathSegment(segments[1] ?? '');
    return taskId === undefined ? <NotFoundPage /> : <TaskDetailPage taskId={taskId} />;
  }
  if (segments.length === 3 && segments[0] === 'tasks' && segments[2] === 'workflow') {
    const taskId = decodePathSegment(segments[1] ?? '');
    return taskId === undefined ? <NotFoundPage /> : <TaskWorkflowPage taskId={taskId} />;
  }

  if (segments.length === 1 && segments[0] === 'exceptions') return <ExceptionListPage />;
  if (segments.length === 2 && segments[0] === 'exceptions') {
    const exceptionId = decodePathSegment(segments[1] ?? '');
    return exceptionId === undefined ? <NotFoundPage /> : <ExceptionDetailPage exceptionId={exceptionId} />;
  }

  if (segments.length === 1 && segments[0] === 'workflows') return <WorkflowListPage />;
  if (segments.length === 2 && segments[0] === 'workflows') {
    const workflowId = decodePathSegment(segments[1] ?? '');
    return workflowId === undefined ? <NotFoundPage /> : <WorkflowDetailPage workflowId={workflowId} />;
  }

  if (segments.length === 2 && segments[0] === 'work-orders') {
    if (segments[1] === 'new') return <WorkOrderPage />;
    const taskId = decodePathSegment(segments[1] ?? '');
    return taskId === undefined ? <NotFoundPage /> : <WorkOrderPage taskId={taskId} />;
  }

  return <NotFoundPage />;
}
