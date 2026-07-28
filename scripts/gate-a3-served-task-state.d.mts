export type ServedTaskTerminalFailure = Readonly<{
  status: 'failed' | 'canceled';
  code: string;
}>;

export function servedTaskTerminalFailure(snapshot: unknown): ServedTaskTerminalFailure | null;

export function gateA3TaskSqlLiteral(taskId: unknown): string;

export function assertNoSensitiveWorkOrderProjection(surfaces: Readonly<{
  visibleText: unknown;
  serializedDom: unknown;
}>): void;
