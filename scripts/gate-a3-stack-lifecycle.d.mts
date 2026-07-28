export type DisposablePostgresLifecycleObserver = Readonly<{
  record: (text: string) => void;
  freezeProject: () => string;
}>;

export function createDisposablePostgresLifecycleObserver(): DisposablePostgresLifecycleObserver;

export type DisposablePostgresIdentity = Readonly<{
  project: string;
  containerName: string;
  containerId: string;
}>;

export function validateDisposablePostgresInspection(
  project: string,
  inspections: unknown,
): DisposablePostgresIdentity;
