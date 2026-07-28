import { describe, expect, it } from 'vitest';
import {
  createDisposablePostgresLifecycleObserver,
  validateDisposablePostgresInspection,
} from './gate-a3-stack-lifecycle.mjs';

describe('Gate A.3 disposable Postgres lifecycle identity', () => {
  it('retains one project across split lifecycle chunks and later noisy logs', () => {
    const observer = createDisposablePostgresLifecycleObserver();
    observer.record(' Container geneway-storage-123-456-post');
    observer.record('gres-1 Created\n Container geneway-storage-123-456-postgres-1 Started\n');
    observer.record('x'.repeat(160_000));

    expect(observer.freezeProject()).toBe('geneway-storage-123-456');
  });

  it('freezes the startup identity against later conflicting application output', () => {
    const observer = createDisposablePostgresLifecycleObserver();
    observer.record(' Container geneway-storage-111-222-postgres-1 Healthy\n');
    expect(observer.freezeProject()).toBe('geneway-storage-111-222');

    observer.record('Container geneway-storage-333-444-postgres-1 Started\n');
    expect(observer.freezeProject()).toBe('geneway-storage-111-222');
  });

  it('fails closed for missing or conflicting startup identities', () => {
    const missing = createDisposablePostgresLifecycleObserver();
    missing.record('unrelated startup output');
    expect(() => missing.freezeProject()).toThrow(/not identified/u);

    const conflicting = createDisposablePostgresLifecycleObserver();
    conflicting.record('Container geneway-storage-111-222-postgres-1 Created\n');
    conflicting.record('Container geneway-storage-333-444-postgres-1 Started\n');
    expect(() => conflicting.freezeProject()).toThrow(/ambiguous/u);
  });

  it('binds one running Docker container to the exact Compose labels', () => {
    const project = 'geneway-storage-123-456';
    const inspection = {
      Id: 'a'.repeat(64),
      Name: `/${project}-postgres-1`,
      State: { Running: true },
      Config: { Labels: {
        'com.docker.compose.project': project,
        'com.docker.compose.service': 'postgres',
        'com.docker.compose.container-number': '1',
        'com.docker.compose.oneoff': 'False',
      } },
    };

    expect(validateDisposablePostgresInspection(project, [inspection])).toEqual({
      project,
      containerName: `${project}-postgres-1`,
      containerId: 'a'.repeat(64),
    });
    expect(() => validateDisposablePostgresInspection(project, [
      { ...inspection, Config: { Labels: { ...inspection.Config.Labels, 'com.docker.compose.service': 'other' } } },
    ])).toThrow(/did not match/u);
    expect(() => validateDisposablePostgresInspection(project, [
      { ...inspection, State: { Running: false } },
    ])).toThrow(/did not match/u);
    expect(() => validateDisposablePostgresInspection(project, [inspection, inspection])).toThrow(/did not match/u);
  });
});
