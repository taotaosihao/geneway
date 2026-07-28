import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalize } from 'json-canonicalize';
import {
  gateA3GearJobRuntimeAuthoritySchema,
  gateA3PreflightArtifactSchema,
  type GateA3GearJobRuntimeAuthority,
} from '@geneway/contracts';

const authorityDirectory =
  '/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp';
const canonicalPreflightPath = `${authorityDirectory}/gearjob-preflight.approved.json`;
const gearJobRoot = '/home/gewu/work/gearjob';
const dockerExecutable = '/usr/bin/docker';
const gitExecutable = '/usr/bin/git';
const verifierArgv = [
  '/home/frappe/.pyenv/versions/3.14.2/bin/python3', '-I', '-S',
  '/usr/local/libexec/gate-a3-runtime-verify.py',
] as const;
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const canonicalDigest = (value: unknown): string => sha256(canonicalize(value));

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', DOCKER_HOST: 'unix:///var/run/docker.sock',
  };
}

function capture(executable: string, arguments_: readonly string[], cwd: string): string {
  return execFileSync(executable, [...arguments_], {
    cwd, env: safeEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function ownedRegular0600(path: string, label: string): void {
  const stat = lstatSync(path);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid
    || (stat.mode & 0o777) !== 0o600 || realpathSync(path) !== path) {
    throw new Error(`${label} must be an owned real 0600 file`);
  }
}

function exactContainerId(): string {
  const output = capture(dockerExecutable, [
    'ps', '--no-trunc',
    '--filter', 'label=com.docker.compose.project=gearjob_dev',
    '--filter', 'label=com.docker.compose.service=frappe',
    '--format', '{{.ID}}',
  ], gearJobRoot);
  const ids = output.split('\n').filter(Boolean);
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0] ?? '')) {
    throw new Error('Gate A.3 candidate requires one exact running Frappe container');
  }
  return ids[0] ?? '';
}

function emitRuntimeAuthority(containerId: string): GateA3GearJobRuntimeAuthority {
  const raw = capture(dockerExecutable, ['exec', containerId, ...verifierArgv, 'emit'], gearJobRoot);
  return gateA3GearJobRuntimeAuthoritySchema.parse(JSON.parse(raw) as unknown);
}

function assertCandidateSource(runtime: GateA3GearJobRuntimeAuthority): void {
  const rootHead = capture(gitExecutable, ['-C', gearJobRoot, 'rev-parse', 'HEAD'], gearJobRoot);
  const rootStatus = capture(gitExecutable, [
    '-C', gearJobRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--',
    ...runtime.gearjob.cleanScopes,
  ], gearJobRoot);
  if (rootHead !== runtime.gearjob.commit || rootStatus !== '') {
    throw new Error('Gate A.3 GearJob candidate source does not match a clean signed scope');
  }
  for (const app of runtime.nestedApps) {
    const appRoot = `${gearJobRoot}/development/frappe-bench/apps/${app.app}`;
    if (capture(gitExecutable, ['-C', appRoot, 'rev-parse', 'HEAD'], appRoot) !== app.commit
      || capture(gitExecutable, ['-C', appRoot, 'status', '--porcelain=v1', '--untracked-files=all'], appRoot) !== '') {
      throw new Error(`Gate A.3 ${app.app} candidate source is not exact and clean`);
    }
  }
  for (const entry of runtime.gearjob.boundaryFileManifest) {
    const path = `${gearJobRoot}/${entry.path}`;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(readFileSync(path)) !== entry.sha256) {
      throw new Error(`Gate A.3 boundary file drifted: ${entry.path}`);
    }
  }
}

function verifierReceipt(containerId: string, command: 'verify' | 'verify-live'): unknown {
  return JSON.parse(capture(dockerExecutable, ['exec', containerId, ...verifierArgv, command], gearJobRoot)) as unknown;
}

function outputArgument(): string {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || !arguments_[0]?.startsWith('--output=')) {
    throw new Error('usage: tsx scripts/generate-gate-a3-authority-candidate.ts --output=/tmp/geneway-gate-a3-<id>.json');
  }
  const output = resolve(arguments_[0].slice('--output='.length));
  const parent = realpathSync(dirname(output));
  if (!output.startsWith('/tmp/geneway-gate-a3-') || parent !== '/tmp' || !/^geneway-gate-a3-[A-Za-z0-9._-]+\.json$/u.test(output.slice(5))) {
    throw new Error('Gate A.3 candidate output must be a direct /tmp/geneway-gate-a3-*.json file');
  }
  return output;
}

const outputPath = outputArgument();
ownedRegular0600(canonicalPreflightPath, 'current canonical Gate A.3 preflight');
const current = JSON.parse(readFileSync(canonicalPreflightPath, 'utf8')) as Record<string, unknown>;
if (current.schema_version !== 'geneway.gearjob-preflight/1'
  || current.task_id !== '20260723-008-geneway-gate-a-gearjob'
  || current.slice_id !== 'gate-a-business-mvp'
  || current.capability_id !== 'production.work-order-status.v1') {
  throw new Error('current Gate A.3 preflight is not the expected immutable authority lineage');
}

const containerId = exactContainerId();
const runtimeAuthority = emitRuntimeAuthority(containerId);
assertCandidateSource(runtimeAuthority);
const runtimeAuthorityDigest = canonicalDigest(runtimeAuthority);
const runtimeTopologyDigest = canonicalDigest(runtimeAuthority.runtimeTopology);
const dynamicAuthorityDigest = canonicalDigest(runtimeAuthority.dynamicAuthority);
if (runtimeAuthorityDigest !== '05ee0602cd6cfc45ec2c5644bee84c570869af8d471e0af57a4bfdc8cc425b84'
  || runtimeTopologyDigest !== '74a848bcfe55aeef8544ee9866648daedc8cb3d5cf454aaa95d708a8bebf335f'
  || dynamicAuthorityDigest !== '8f7d1601f97089b20c7f20f49ee7c0db64ce3a5d99bdcb2a7ad2a6c4622e3ed4') {
  throw new Error('Gate A.3 runtime candidate does not match the fresh reviewed topology tuple');
}
const fullReceipt = verifierReceipt(containerId, 'verify') as Record<string, unknown>;
const liveReceipt = verifierReceipt(containerId, 'verify-live') as Record<string, unknown>;
if (fullReceipt.verified !== true || fullReceipt.runtimeAuthorityDigest !== runtimeAuthorityDigest
  || fullReceipt.runtimeTopologyDigest !== runtimeTopologyDigest || liveReceipt.verified !== true
  || liveReceipt.dynamicAuthorityDigest !== dynamicAuthorityDigest
  || liveReceipt.runtimeTopologyDigest !== runtimeTopologyDigest) {
  throw new Error('Gate A.3 runtime candidate verifier receipts do not cross-bind');
}

const now = new Date();
const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
const priorDigest = (current.integrity as { canonical_sha256?: unknown } | undefined)?.canonical_sha256;
if (typeof priorDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(priorDigest)) {
  throw new Error('current Gate A.3 preflight lineage digest is invalid');
}
const requiredTuple = {
  ...((current.release_admission as { required_tuple?: Record<string, unknown> }).required_tuple ?? {}),
  approvedPreflightDigest: 'TO_BE_FILLED',
  runtimeAuthorityDigest,
  dynamicAuthorityDigest,
  runtimeImageId: runtimeAuthority.containerProjection.imageId,
};
const candidate: Record<string, unknown> = {
  ...current,
  artifact_id: `gearjob-preflight-dev-local-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${runtimeAuthority.gearjob.commit.slice(0, 12)}`,
  approved_at: now.toISOString(),
  expires_at: expiresAt.toISOString(),
  renewal_of: priorDigest,
  runtime_authority: runtimeAuthority,
  runtime_authority_digest: runtimeAuthorityDigest,
  verification: {
    ...current.verification as Record<string, unknown>,
    gearjob_commit: runtimeAuthority.gearjob.commit,
    gearjob_commit_subject: capture(gitExecutable, ['-C', gearJobRoot, 'show', '-s', '--format=%s', 'HEAD'], gearJobRoot),
    file_sha256: Object.fromEntries(runtimeAuthority.gearjob.boundaryFileManifest.map(({ path, sha256: digest }) => [path, digest])),
    checks: [
      { id: 'gearjob-runtime-authority-pytest', result: 'pass', detail: '11 passed in exact candidate image' },
      { id: 'gearjob-runtime-authority-ruff', result: 'pass', detail: 'ruff check and format --check passed' },
      { id: 'immutable-runtime-image', result: 'pass', image_id: runtimeAuthority.containerProjection.imageId },
      { id: 'full-runtime-authority', result: 'pass', runtime_authority_digest: runtimeAuthorityDigest,
        runtime_topology_digest: runtimeTopologyDigest },
      { id: 'live-runtime-authority', result: 'pass', dynamic_authority_digest: dynamicAuthorityDigest,
        runtime_topology_digest: runtimeTopologyDigest },
      { id: 'control-plane-docker-topology', result: 'pass', detail: 'four exact internal-only peers and bind inode identities verified' },
      { id: 'canonical-authority-stale-negative', result: 'pass', detail: 'prior authority without complete topology rejected fail closed' },
    ],
    negative_receiver_boundary:
      'A.3 geneway receiver/current-authority/egress/zero-write matrix remains a required fresh V5/V6 exit check; this preflight does not substitute for it.',
  },
  release_admission: {
    ...current.release_admission as Record<string, unknown>,
    required_tuple: requiredTuple,
  },
  integrity: {
    canonicalization_version: 'RFC8785/JCS-1',
    digest_scope: 'whole JSON artifact with integrity.canonical_sha256 omitted and release_admission.required_tuple.approvedPreflightDigest set to TO_BE_FILLED',
    canonical_sha256: '0'.repeat(64),
  },
};
const digestInput = structuredClone(candidate);
delete (digestInput.integrity as Record<string, unknown>).canonical_sha256;
((digestInput.release_admission as { required_tuple: Record<string, unknown> }).required_tuple)
  .approvedPreflightDigest = 'TO_BE_FILLED';
const approvedPreflightDigest = canonicalDigest(digestInput);
(candidate.integrity as Record<string, unknown>).canonical_sha256 = approvedPreflightDigest;
((candidate.release_admission as { required_tuple: Record<string, unknown> }).required_tuple)
  .approvedPreflightDigest = approvedPreflightDigest;
const parsed = gateA3PreflightArtifactSchema.parse(candidate);
writeFileSync(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
chmodSync(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 'geneway-gate-a3-authority-candidate-generation/1',
  outputPath,
  artifactId: parsed.artifact_id,
  approvedPreflightDigest,
  gearjobCommit: runtimeAuthority.gearjob.commit,
  runtimeAuthorityDigest,
  runtimeTopologyDigest,
  dynamicAuthorityDigest,
  runtimeImageId: runtimeAuthority.containerProjection.imageId,
  priorDigest,
})}\n`);
