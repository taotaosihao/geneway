import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';

export const gate02bEnvironmentNames = Object.freeze([
  'GENEWAY_GATE02B_EGRESS_GUARD', 'GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY', 'GENEWAY_GATE02B_PROXY_RUN_ROOT',
  'GENEWAY_GATE02B_COMPOSE_DEFAULT_INTERNAL', 'GENEWAY_GATE02B_COMPOSE_STORAGE_INTERNAL',
]);

export function e2eProjectSelection(forwarded) {
  const selectedProjects = forwarded.flatMap((argument, index) => {
    if (argument.startsWith('--project=')) return [argument.slice('--project='.length)];
    if (argument === '--project') return [forwarded[index + 1]];
    return [];
  }).filter((value) => typeof value === 'string');
  const allProjects = !forwarded.some((argument) => argument === '--project' || argument.startsWith('--project='));
  const gateALive = selectedProjects.some((project) => project === 'gate-a-live' || project === 'gate-a-not-open');
  const gateA0Live = gateALive || selectedProjects.includes('gate-a0-live');
  return { selectedProjects, allProjects, gateALive, gateA0Live };
}

export function e2eRunIdentity(parentRunId, forwarded, gate02bGuarded) {
  const { selectedProjects } = e2eProjectSelection(forwarded);
  const identityHash = createHash('sha256').update(JSON.stringify({ parentRunId, forwarded, selectedProjects })).digest('hex').slice(0, 16);
  const identityLabel = (selectedProjects[0] ?? 'default').toLowerCase().replace(/[^a-z0-9_-]/gu, '-').slice(0, 32);
  const runId = gate02bGuarded
    ? `${parentRunId.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 56)}-${identityLabel}-${identityHash}`
    : parentRunId;
  return { runId, selectedProjects };
}

export function assertSecureRunDirectories(paths, expectedUid = process.getuid()) {
  if (!Number.isInteger(expectedUid)) throw new Error('Unable to resolve the current run directory owner');
  for (const path of paths) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
      || stat.uid !== expectedUid || realpathSync(path) !== path) {
      throw new Error(`Run evidence directory is unsafe: ${path}`);
    }
  }
}
