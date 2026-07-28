const postgresLifecyclePattern = /Container (geneway-storage-[a-z0-9-]+)-postgres-1 (?:Created|Started|Healthy)/gu;

export function createDisposablePostgresLifecycleObserver() {
  const projects = new Set();
  let tail = '';
  let frozenProject;

  return Object.freeze({
    record(text) {
      if (frozenProject !== undefined) return;
      const sample = `${tail}${text}`;
      for (const match of sample.matchAll(postgresLifecyclePattern)) {
        const project = match[1];
        if (project !== undefined) projects.add(project);
      }
      tail = sample.slice(-512);
    },
    freezeProject() {
      if (frozenProject !== undefined) return frozenProject;
      if (projects.size === 0) {
        throw new Error('disposable Postgres container was not identified from stack lifecycle');
      }
      if (projects.size !== 1) {
        throw new Error('disposable Postgres container identity was ambiguous across stack lifecycle');
      }
      const project = projects.values().next().value;
      if (typeof project !== 'string') {
        throw new Error('disposable Postgres project identity is invalid');
      }
      frozenProject = project;
      return frozenProject;
    },
  });
}

export function validateDisposablePostgresInspection(project, inspections) {
  const containerName = `${project}-postgres-1`;
  const inspection = Array.isArray(inspections) && inspections.length === 1 ? inspections[0] : undefined;
  const labels = inspection?.Config?.Labels;
  if (inspection === undefined || typeof inspection.Id !== 'string' || !/^[a-f0-9]{64}$/u.test(inspection.Id)
    || inspection.Name !== `/${containerName}` || inspection.State?.Running !== true
    || labels?.['com.docker.compose.project'] !== project
    || labels?.['com.docker.compose.service'] !== 'postgres'
    || labels?.['com.docker.compose.container-number'] !== '1'
    || labels?.['com.docker.compose.oneoff'] !== 'False') {
    throw new Error('disposable Postgres Docker identity did not match the observed stack lifecycle');
  }
  return Object.freeze({ project, containerName, containerId: inspection.Id });
}
