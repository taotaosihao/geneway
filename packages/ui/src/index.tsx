import { Progress } from '@base-ui/react/progress';
import type { ReactNode } from 'react';

export function SimulationNotice(): ReactNode {
  return <div className="simulation-notice" data-testid="simulation-notice">
    <span>模拟演示</span><strong>runtimeMode=fake</strong><span>businessDecisionAllowed=false</span>
  </div>;
}

export function TaskProgress({ completed, total }: Readonly<{ completed: number; total: number }>): ReactNode {
  const value = total === 0 ? 0 : Math.round((completed / total) * 100);
  return <Progress.Root className="task-progress" value={value}>
    <Progress.Track className="task-progress-track"><Progress.Indicator className="task-progress-indicator" /></Progress.Track>
  </Progress.Root>;
}
