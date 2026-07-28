import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, verify as verifySignature } from 'node:crypto';
import {
  chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalize } from 'json-canonicalize';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const connectorGatewayDefaultPort = 3155;
const gearJobOrigin = 'http://127.0.0.1:8100';
const gateA3AuthorityDirectory = '/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp';
const gateA3ApprovedPreflightFile = `${gateA3AuthorityDirectory}/gearjob-preflight.approved.json`;
const gateA3ControllerAdmissionFile = `${gateA3AuthorityDirectory}/gearjob-preflight.controller-admission.json`;
const gateA3InternalValidationAdmissionFile = `${gateA3AuthorityDirectory}/gate-a3-internal-validation.admission.json`;
const gearJobRepository = '/home/gewu/work/gearjob';
const gearJobPrivateDirectory = `${gearJobRepository}/development/frappe-bench/sites/dev.localhost/private/geneway-gate-a3`;
const gearJobServiceCredentialFile = `${gearJobPrivateDirectory}/service-credential.json`;
const gearJobInvocationSecretFile = `${gearJobPrivateDirectory}/invocation.secret`;
const gearJobComposeFile = `${gearJobRepository}/deploy/docker-compose.yml`;
const gearJobGateA3ComposeFile = `${gearJobRepository}/deploy/docker-compose.gate-a3.yml`;
const gateA3DockerExecutable = '/usr/bin/docker';
const gateA3GitExecutable = '/usr/bin/git';
const gateA3ComposeProject = 'gearjob_dev';
const gateA3ComposeNetwork = `${gateA3ComposeProject}_gate-a3-internal`;
const gateA3RuntimeContainerName = `${gateA3ComposeProject}-frappe-1`;
const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const gateA3LocalAdmissionKeyId = 'geneway-gate-a3-local-admission-root/1';
const gateA3LocalAdmissionPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5K9Fxlmd7Mp/2KsLDlTbaDVg5SujoN4qTNyBaGh/ekM=
-----END PUBLIC KEY-----
`;
const gateA3RuntimeEntrypoint = Object.freeze([
  '/home/frappe/.pyenv/versions/3.14.2/bin/python3', '-I', '-S',
  '/usr/local/libexec/gate-a3-runtime-verify.py',
]);
export const GATE_A3_STARTUP_ORDER = Object.freeze([
  'model-gateway', 'control-plane', 'connector-gateway', 'gate-a3-readiness', 'worker', 'web',
]);
const HELP = `用法: pnpm dev-up

启动一次性的 geneway 本地验收栈，并把 Web 暴露到本机可用的 192.168/16 与 10/8 网络：
  Web                  <局域网 IPv4>:3200（全部入口共用，占用时自动顺延）
  Control Plane        127.0.0.1:3100（默认，占用时自动顺延）
  Model Gateway        127.0.0.1:3150（默认，占用时自动顺延）
  Connector Gateway    127.0.0.1:3155（占用时自动顺延）
  GearJob facade       127.0.0.1:8100（Control Plane 独占 loopback proxy）
  PostgreSQL / storage 随机 loopback 端口
  Worker               本机 Unix-domain socket

环境变量：
  GENEWAY_WEB_PORT               覆盖 Web 端口
  GENEWAY_CONTROL_PLANE_PORT     覆盖 Control Plane 端口
  GENEWAY_MODEL_GATEWAY_PORT     覆盖 Model Gateway 端口
  GENEWAY_GATE_A0_RELEASE_PORT   覆盖 loopback release helper 端口
  GENEWAY_GATE_A_RELEASE_PORT    覆盖 loopback Gate A release helper 端口
  GENEWAY_GATE_A3_RELEASE_PORT   覆盖 loopback Gate A.3 release helper 端口

同时提供已授权的 GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE 与尚未过期的
GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE 时，会通过 loopback release helper
为本次 disposable run 临时开放真实聊天与 auto 材料分析；仅提供其中一项会安全失败，
两项都未提供时两个真实 route 都保持 NOT_OPEN。

启动前会自动校验已批准的 Gate A.3 三层 authority 与 immutable GearJob runtime；签名
镜像缺失时仅从签名 commit 的干净源码自动构建，并复用本地数据库与 Redis volume。
无需手工准备 Gate A.3 环境变量。

按 Ctrl+C 停止全部进程并删除本次临时数据库、对象存储和 geneway 临时凭据。
`;

const canonicalDigest = (value) => createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');

function verifyGateA3InternalAdmissionSignature(admission) {
  const signature = admission?.admission_signature?.signature;
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) return false;
  const signed = structuredClone(admission);
  delete signed.integrity.canonical_sha256;
  delete signed.admission_signature.signature;
  return verifySignature(null, Buffer.from(canonicalize(signed), 'utf8'),
    gateA3LocalAdmissionPublicKey, Buffer.from(signature, 'base64url'));
}

const gateA3AuthoritySchemaParseProgram = `
import { readFileSync } from 'node:fs';
import {
  gateA3ControllerAdmissionArtifactSchema,
  gateA3InternalValidationAdmissionArtifactSchema,
  gateA3PreflightArtifactSchema,
} from './packages/contracts/src/gate-a3-authority.ts';
const input = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  preflight: gateA3PreflightArtifactSchema.parse(input.preflight),
  admission: gateA3ControllerAdmissionArtifactSchema.parse(input.admission),
  validationAdmission: gateA3InternalValidationAdmissionArtifactSchema.parse(input.validationAdmission),
}));
`;

function parseGateA3AuthorityArtifacts(input) {
  try {
    const output = execFileSync(process.execPath, [tsxCli, '--eval', gateA3AuthoritySchemaParseProgram], {
      cwd: repositoryRoot,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      input: JSON.stringify(input),
      encoding: 'utf8',
      maxBuffer: 512 * 1_024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(output);
  } catch {
    throw new Error('Gate A.3 authority artifacts failed strict canonical schema validation');
  }
}

function readOwnedRegularFile(filePath, label, minimumBytes = 1, maximumBytes = 256 * 1_024) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o600 || stat.size < minimumBytes || stat.size > maximumBytes) {
    throw new Error(`${label} must be an owned regular 0600 file`);
  }
  const descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = fstatSync(descriptor);
    if (openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) throw new Error(`${label} changed while it was opened`);
    const contents = readFileSync(descriptor, 'utf8');
    const afterStat = fstatSync(descriptor);
    if (afterStat.size !== openedStat.size || afterStat.mtimeMs !== openedStat.mtimeMs
      || afterStat.ctimeMs !== openedStat.ctimeMs) {
      throw new Error(`${label} changed while it was read`);
    }
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function assertOwnedRegularFile(filePath, label, minimumBytes = 1, maximumBytes = 256 * 1_024) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o600 || stat.size < minimumBytes || stat.size > maximumBytes) {
    throw new Error(`${label} must be an owned regular 0600 file`);
  }
  const descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = fstatSync(descriptor);
    if (openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) throw new Error(`${label} changed while it was opened`);
  } finally {
    closeSync(descriptor);
  }
}

export function deriveApprovedGateA3Authority({ preflight: rawPreflight, admission: rawAdmission,
  validationAdmission: rawValidationAdmission }, now = new Date()) {
  const { preflight, admission, validationAdmission } = parseGateA3AuthorityArtifacts({
    preflight: rawPreflight, admission: rawAdmission, validationAdmission: rawValidationAdmission,
  });
  const digest = preflight.integrity?.canonical_sha256;
  if (!/^[a-f0-9]{64}$/u.test(digest ?? '')
    || preflight.release_admission?.required_tuple?.approvedPreflightDigest !== digest) {
    throw new Error('Gate A.3 approved preflight digest tuple is invalid');
  }
  const digestInput = structuredClone(preflight);
  delete digestInput.integrity.canonical_sha256;
  digestInput.release_admission.required_tuple.approvedPreflightDigest = 'TO_BE_FILLED';
  const computedDigest = canonicalDigest(digestInput);
  if (computedDigest !== digest) throw new Error('Gate A.3 approved preflight canonical digest does not match');
  const runtimeAuthority = preflight.runtime_authority;
  const runtimeAuthorityDigest = canonicalDigest(runtimeAuthority);
  const dynamicAuthorityDigest = canonicalDigest(runtimeAuthority.dynamicAuthority);
  const distributionInventoryDigest = canonicalDigest(runtimeAuthority.pythonDistributionInventory);
  const startupFilesDigest = canonicalDigest(runtimeAuthority.pythonStartupFiles);
  const runtimeImageId = runtimeAuthority.containerProjection.imageId;
  if (runtimeAuthorityDigest !== preflight.runtime_authority_digest
    || dynamicAuthorityDigest !== runtimeAuthority.dynamicAuthorityDigest
    || distributionInventoryDigest !== runtimeAuthority.pythonDistributionInventorySha256
    || startupFilesDigest !== runtimeAuthority.pythonStartupFilesSha256
    || preflight.verification.gearjob_commit !== runtimeAuthority.gearjob.commit) {
    throw new Error('Gate A.3 preflight runtime authority digest bindings are invalid');
  }
  const tuple = preflight.release_admission.required_tuple;
  if (tuple.runtimeAuthorityDigest !== runtimeAuthorityDigest
    || tuple.dynamicAuthorityDigest !== dynamicAuthorityDigest || tuple.runtimeImageId !== runtimeImageId) {
    throw new Error('Gate A.3 preflight runtime tuple is invalid');
  }
  const preflightControllerAdmissionDigest = canonicalDigest(admission);
  if (admission.required_tuple.gearjob_commit !== runtimeAuthority.gearjob.commit
    || admission.required_tuple.approved_preflight_digest !== digest
    || admission.required_tuple.connector_profile_version !== tuple.connectorProfileVersion
    || admission.required_tuple.field_mask_version !== tuple.fieldMaskVersion
    || admission.required_tuple.invocation_token_schema_version !== tuple.invocationTokenSchemaVersion
    || admission.required_tuple.response_schema_version !== tuple.responseSchemaVersion
    || admission.required_tuple.card_schema_version !== tuple.cardSchemaVersion
    || admission.required_tuple.runtime_authority_digest !== runtimeAuthorityDigest
    || admission.required_tuple.dynamic_authority_digest !== dynamicAuthorityDigest
    || admission.required_tuple.runtime_image_id !== runtimeImageId) {
    throw new Error('Gate A.3 controller admission tuple is invalid');
  }
  if (!verifyGateA3InternalAdmissionSignature(validationAdmission)) {
    throw new Error('Gate A.3 internal-validation admission signature is not trusted');
  }
  const validationAdmissionDigest = validationAdmission.integrity?.canonical_sha256;
  if (!/^[a-f0-9]{64}$/u.test(validationAdmissionDigest ?? '')) {
    throw new Error('Gate A.3 internal-validation admission digest is invalid');
  }
  const validationDigestInput = structuredClone(validationAdmission);
  delete validationDigestInput.integrity.canonical_sha256;
  const computedValidationAdmissionDigest = canonicalDigest(validationDigestInput);
  if (computedValidationAdmissionDigest !== validationAdmissionDigest) {
    throw new Error('Gate A.3 internal-validation admission canonical digest does not match');
  }
  if (validationAdmission.required_tuple.approved_preflight_digest !== digest
    || validationAdmission.required_tuple.preflight_controller_admission_digest
      !== preflightControllerAdmissionDigest
    || validationAdmission.required_tuple.gearjob_commit !== runtimeAuthority.gearjob.commit
    || validationAdmission.required_tuple.runtime_authority_digest !== runtimeAuthorityDigest
    || validationAdmission.required_tuple.dynamic_authority_digest !== dynamicAuthorityDigest
    || validationAdmission.required_tuple.runtime_image_id !== runtimeImageId) {
    throw new Error('Gate A.3 internal-validation admission tuple is invalid');
  }
  const effectiveAt = Math.max(Date.parse(preflight.approved_at), Date.parse(admission.decided_at),
    Date.parse(validationAdmission.decided_at));
  const expiresAt = Math.min(Date.parse(preflight.expires_at), Date.parse(validationAdmission.expires_at));
  if (!Number.isFinite(effectiveAt) || !Number.isFinite(expiresAt)
    || effectiveAt > now.getTime() || expiresAt <= now.getTime() || effectiveAt >= expiresAt) {
    throw new Error('Gate A.3 authority is not currently effective');
  }
  return {
    artifactId: preflight.artifact_id,
    approvedPreflightDigest: digest,
    internalValidationAdmissionDigest: validationAdmissionDigest,
    admissionRootKeyId: gateA3LocalAdmissionKeyId,
    admissionSignatureVerified: true,
    approvedPreflightFile: gateA3ApprovedPreflightFile,
    controllerAdmissionFile: gateA3ControllerAdmissionFile,
    internalValidationAdmissionFile: gateA3InternalValidationAdmissionFile,
    expiresAt: new Date(expiresAt).toISOString(),
    gearjobCommit: runtimeAuthority.gearjob.commit,
    nestedAppCommits: Object.fromEntries(runtimeAuthority.nestedApps.map((app) => [app.app, app.commit])),
    runtimeAuthority,
    runtimeAuthorityDigest,
    dynamicAuthorityDigest,
    runtimeImageId,
  };
}

export function readApprovedGateA3Authority(now = new Date()) {
  const authority = deriveApprovedGateA3Authority({
    preflight: JSON.parse(readOwnedRegularFile(gateA3ApprovedPreflightFile, 'Gate A.3 approved preflight')),
    admission: JSON.parse(readOwnedRegularFile(gateA3ControllerAdmissionFile, 'Gate A.3 controller admission')),
    validationAdmission: JSON.parse(readOwnedRegularFile(
      gateA3InternalValidationAdmissionFile, 'Gate A.3 internal-validation admission',
    )),
  }, now);
  // dev-up validates and forwards paths only; Connector Gateway alone reads
  // the service credential contents.
  assertOwnedRegularFile(gearJobServiceCredentialFile, 'GearJob service credential', 32, 4_096);
  const connectorInvocationSecret = readOwnedRegularFile(
    gearJobInvocationSecretFile, 'GearJob invocation secret', 32, 4_096,
  ).trim();
  if (connectorInvocationSecret.length < 32 || /\s/u.test(connectorInvocationSecret)) {
    throw new Error('GearJob invocation secret is malformed');
  }
  return {
    ...authority,
    gearJobServiceCredentialFile,
    connectorInvocationSecretFile: gearJobInvocationSecretFile,
    existingSecretDigests: [createHash('sha256').update(connectorInvocationSecret, 'utf8').digest('hex')],
  };
}

function writeDistinctSecrets(authorityDirectory, fileNames, existingDigests) {
  const digests = new Set(existingDigests);
  return Object.fromEntries(Object.entries(fileNames).map(([name, fileName]) => {
    let value;
    let valueDigest;
    do {
      value = randomBytes(32).toString('hex');
      valueDigest = createHash('sha256').update(value, 'utf8').digest('hex');
    } while (digests.has(valueDigest));
    digests.add(valueDigest);
    const filePath = `${authorityDirectory}/${fileName}`;
    writeFileSync(filePath, `${value}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(filePath, 0o600);
    return [name, filePath];
  }));
}

function gateA3ToolEnvironment(authority) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    GENEWAY_GATE_A3_RUNTIME_IMAGE_ID: authority.runtimeImageId,
    GENEWAY_GATE_A3_RUNTIME_AUTHORITY_SHA256: authority.runtimeAuthorityDigest,
    GENEWAY_GATE_A3_DYNAMIC_AUTHORITY_SHA256: authority.dynamicAuthorityDigest,
    GEARJOB_GATE_A3_GEARJOB_COMMIT: authority.gearjobCommit,
    GEARJOB_GATE_A3_FRAPPE_COMMIT: authority.nestedAppCommits.frappe,
    GEARJOB_GATE_A3_ERPNEXT_COMMIT: authority.nestedAppCommits.erpnext,
    GEARJOB_GATE_A3_HRMS_COMMIT: authority.nestedAppCommits.hrms,
    GEARJOB_GATE_A3_PRINT_DESIGNER_COMMIT: authority.nestedAppCommits.print_designer,
  };
}

const gateA3ComposeArguments = Object.freeze([
  'compose', '-p', gateA3ComposeProject,
  '-f', gearJobComposeFile, '-f', gearJobGateA3ComposeFile,
]);

export function buildGateA3RuntimePlan(authority, imagePresent) {
  const environment = gateA3ToolEnvironment(authority);
  return {
    executable: gateA3DockerExecutable,
    environment,
    buildArguments: imagePresent ? null : [
      ...gateA3ComposeArguments, '--profile', 'gate-a3-build', 'build', 'gate-a3-runtime-build',
    ],
    upArguments: [
      ...gateA3ComposeArguments, 'up', '-d', '--no-build',
      'mariadb', 'redis-cache', 'redis-queue', 'frappe',
    ],
    retainedOnCleanup: true,
  };
}

function execGateA3Docker(authority, arguments_, { inherit = false } = {}) {
  return execFileSync(gateA3DockerExecutable, arguments_, {
    cwd: gearJobRepository,
    env: gateA3ToolEnvironment(authority),
    encoding: 'utf8',
    maxBuffer: 256 * 1_024,
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
  }) ?? '';
}

function execGateA3Git(repository, arguments_) {
  return execFileSync(gateA3GitExecutable, [
    '-C', repository, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...arguments_,
  ], {
    env: {
      PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    },
    encoding: 'utf8',
    maxBuffer: 256 * 1_024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertGateA3BuildSources(authority) {
  const gearJobHead = execGateA3Git(gearJobRepository, ['rev-parse', 'HEAD']);
  const rootStatus = execGateA3Git(gearJobRepository, [
    'status', '--porcelain=v1', '--untracked-files=all', '--',
    ...authority.runtimeAuthority.gearjob.cleanScopes,
  ]);
  if (gearJobHead !== authority.gearjobCommit || rootStatus !== ''
    || authority.runtimeAuthority.gearjob.cleanStatusSha256 !== emptySha256) {
    throw new Error('Gate A.3 runtime image is missing and the signed GearJob build scopes are not clean');
  }
  for (const [app, commit] of Object.entries(authority.nestedAppCommits)) {
    const repository = `${gearJobRepository}/development/frappe-bench/apps/${app}`;
    const head = execGateA3Git(repository, ['rev-parse', 'HEAD']);
    const status = execGateA3Git(repository, ['status', '--porcelain=v1', '--untracked-files=all']);
    const signed = authority.runtimeAuthority.nestedApps.find((entry) => entry.app === app);
    if (head !== commit || status !== '' || signed?.cleanStatusSha256 !== emptySha256) {
      throw new Error(`Gate A.3 runtime image is missing and the signed ${app} build source is not clean`);
    }
  }
}

function assertGateA3ComposeBytes(authority) {
  const boundary = new Map(authority.runtimeAuthority.gearjob.boundaryFileManifest
    .map((entry) => [entry.path, entry.sha256]));
  for (const [relativePath, absolutePath] of [
    ['deploy/docker-compose.yml', gearJobComposeFile],
    ['deploy/docker-compose.gate-a3.yml', gearJobGateA3ComposeFile],
  ]) {
    const stat = lstatSync(absolutePath);
    const digest = stat.isFile() && !stat.isSymbolicLink()
      ? createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
      : null;
    if (digest === null || digest !== boundary.get(relativePath)) {
      throw new Error(`Gate A.3 signed Compose boundary drifted: ${relativePath}`);
    }
  }
}

function exactContainerId(value, label) {
  const ids = value.trim().split('\n').filter((entry) => entry !== '');
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0] ?? '')) {
    throw new Error(`${label} did not resolve to one exact container generation`);
  }
  return ids[0];
}

function assertNoPublishedPorts(inspected, label) {
  const bindings = inspected.HostConfig?.PortBindings ?? {};
  if (Object.values(bindings).some((value) => Array.isArray(value) && value.length > 0)) {
    throw new Error(`${label} unexpectedly publishes a host port`);
  }
}

function inspectGateA3Topology(authority) {
  const serviceNames = ['mariadb', 'redis-cache', 'redis-queue', 'frappe'];
  const serviceIds = Object.fromEntries(serviceNames.map((service) => [service, exactContainerId(
    execGateA3Docker(authority, [...gateA3ComposeArguments, 'ps', '-q', service]),
    `Gate A.3 ${service}`,
  )]));
  const inspected = JSON.parse(execGateA3Docker(authority, [
    'inspect', ...serviceNames.map((service) => serviceIds[service]),
  ]));
  if (!Array.isArray(inspected) || inspected.length !== serviceNames.length) {
    throw new Error('Gate A.3 Compose topology inspect is incomplete');
  }
  const byService = new Map(inspected.map((container) => [container.Config?.Labels?.['com.docker.compose.service'], container]));
  for (const service of serviceNames) {
    const container = byService.get(service);
    const labels = container?.Config?.Labels ?? {};
    const networks = Object.keys(container?.NetworkSettings?.Networks ?? {});
    if (container?.Id !== serviceIds[service] || container?.State?.Running !== true
      || labels['com.docker.compose.project'] !== gateA3ComposeProject
      || labels['com.docker.compose.service'] !== service
      || networks.length !== 1 || networks[0] !== gateA3ComposeNetwork
      || container.HostConfig?.NetworkMode !== gateA3ComposeNetwork) {
      throw new Error(`Gate A.3 ${service} is not running on the exact internal topology`);
    }
    assertNoPublishedPorts(container, `Gate A.3 ${service}`);
  }
  const runtime = byService.get('frappe');
  const runtimeLabels = runtime?.Config?.Labels ?? {};
  const signedLabels = authority.runtimeAuthority.containerProjection.imageLabels;
  const runtimeLabelKeys = Object.keys(runtimeLabels).filter((key) => key.startsWith('dev.geneway.gate-a3.')).sort();
  if (runtime === undefined || runtime.Image !== authority.runtimeImageId || runtime.Config?.Image !== authority.runtimeImageId
    || runtime.HostConfig?.ReadonlyRootfs !== true || runtime.HostConfig?.Privileged !== false
    || canonicalize(runtime.HostConfig?.CapDrop) !== canonicalize(['ALL'])
    || !Array.isArray(runtime.HostConfig?.SecurityOpt)
    || !runtime.HostConfig.SecurityOpt.includes('no-new-privileges:true')
    || canonicalize(runtimeLabelKeys) !== canonicalize(Object.keys(signedLabels).sort())
    || Object.entries(signedLabels).some(([key, value]) => runtimeLabels[key] !== value)) {
    throw new Error('Gate A.3 Frappe runtime container does not match the signed immutable topology');
  }
  return serviceIds.frappe;
}

export function assertGateA3FullRuntimeReceipt(authority, full) {
  if (canonicalize(Object.keys(full).sort())
      !== canonicalize([
        'runtimeAuthorityDigest', 'runtimeImageId', 'runtimeTopologyDigest', 'schemaVersion', 'verified',
      ].sort())
    || full.schemaVersion !== 'gearjob-gate-a3-runtime-verification/1'
    || full.runtimeAuthorityDigest !== authority.runtimeAuthorityDigest
    || full.runtimeImageId !== authority.runtimeImageId
    || full.runtimeTopologyDigest !== authority.runtimeAuthority.runtimeTopologyDigest
    || full.verified !== true) {
    throw new Error('Gate A.3 full runtime verification is not bound to the signed authority');
  }
}

export function assertGateA3LiveRuntimeReceipt(authority, live) {
  if (canonicalize(Object.keys(live).sort())
      !== canonicalize([
        'dynamicAuthorityDigest', 'runtimeImageId', 'runtimeTopologyDigest', 'schemaVersion', 'verified',
      ].sort())
    || live.schemaVersion !== 'gearjob-gate-a3-live-verification/1'
    || live.dynamicAuthorityDigest !== authority.dynamicAuthorityDigest
    || live.runtimeImageId !== authority.runtimeImageId
    || live.runtimeTopologyDigest !== authority.runtimeAuthority.runtimeTopologyDigest
    || live.verified !== true) {
    throw new Error('Gate A.3 live runtime verification is not bound to the signed authority');
  }
}

function verifyGateA3RuntimeInsideContainer(authority, containerId) {
  const full = JSON.parse(execGateA3Docker(authority, [
    'exec', containerId, ...gateA3RuntimeEntrypoint, 'verify',
  ]));
  assertGateA3FullRuntimeReceipt(authority, full);
  const live = JSON.parse(execGateA3Docker(authority, [
    'exec', containerId, ...gateA3RuntimeEntrypoint, 'verify-live',
  ]));
  assertGateA3LiveRuntimeReceipt(authority, live);
}

export function ensureGateA3Runtime(authority) {
  assertGateA3ComposeBytes(authority);
  // Prove the daemon is reachable before interpreting a failed image inspect
  // as an absent signed image.
  execGateA3Docker(authority, ['version', '--format', '{{.Server.Version}}']);
  let imagePresent = false;
  try {
    imagePresent = execGateA3Docker(authority, [
      'image', 'inspect', '--format', '{{.Id}}', authority.runtimeImageId,
    ]).trim() === authority.runtimeImageId;
  } catch {
    imagePresent = false;
  }
  const plan = buildGateA3RuntimePlan(authority, imagePresent);
  if (!imagePresent) {
    assertGateA3BuildSources(authority);
    process.stdout.write('构建签名 Gate A.3 GearJob runtime image…\n');
    execGateA3Docker(authority, plan.buildArguments, { inherit: true });
    const builtImageId = execGateA3Docker(authority, [
      'image', 'inspect', '--format', '{{.Id}}', 'geneway/gearjob-gate-a3-runtime:candidate',
    ]).trim();
    if (builtImageId !== authority.runtimeImageId) {
      throw new Error('Gate A.3 rebuilt image ID does not equal the signed runtime image ID');
    }
  }
  process.stdout.write('启动或复用 internal-only Gate A.3 GearJob runtime…\n');
  execGateA3Docker(authority, plan.upArguments, { inherit: true });
  const runtimeContainerId = inspectGateA3Topology(authority);
  verifyGateA3RuntimeInsideContainer(authority, runtimeContainerId);
  return { imageBuilt: !imagePresent, runtimeContainerId };
}

function parsePort(environment, name, fallback) {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return value;
}

function isDefaultLanIpv4(value) {
  if (!net.isIPv4(value)) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || (first === 192 && second === 168);
}

const EXCLUDED_INTERFACE = /^(?:br-|cni|docker|flannel|kube|podman|veth|virbr|vmnet)/u;

export function parseLanHosts(addressOutput) {
  const hosts = [];
  for (const line of addressOutput.split('\n')) {
    const match = line.match(/^\d+:\s+([^@\s]+)(?:@\S+)?\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})\//u);
    if (match === null) continue;
    const [, interfaceName, address] = match;
    if (interfaceName === undefined || address === undefined || EXCLUDED_INTERFACE.test(interfaceName) || !isDefaultLanIpv4(address)) continue;
    if (!hosts.includes(address)) hosts.push(address);
  }
  hosts.sort((left, right) => {
    const leftPriority = left.startsWith('192.168.') ? 0 : 1;
    const rightPriority = right.startsWith('192.168.') ? 0 : 1;
    return leftPriority - rightPriority || left.localeCompare(right, 'en');
  });
  if (hosts.length === 0) {
    throw new Error('No usable 192.168/16 or 10/8 address found on an active non-virtual interface');
  }
  return hosts;
}

function detectLanHosts() {
  let addresses;
  try {
    addresses = execFileSync('ip', ['-o', '-4', 'address', 'show', 'up', 'scope', 'global'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error('Unable to inspect active IPv4 addresses', { cause: error });
  }
  return parseLanHosts(addresses);
}

export function readConfiguration(environment, lanHosts = detectLanHosts()) {
  const webPort = parsePort(environment, 'GENEWAY_WEB_PORT', 3200);
  const controlPlanePort = parsePort(environment, 'GENEWAY_CONTROL_PLANE_PORT', 3100);
  const modelGatewayPort = parsePort(environment, 'GENEWAY_MODEL_GATEWAY_PORT', 3150);
  const releaseHelperPort = parsePort(environment, 'GENEWAY_GATE_A0_RELEASE_PORT', 3160);
  const gateAReleaseHelperPort = parsePort(environment, 'GENEWAY_GATE_A_RELEASE_PORT', 3170);
  const gateA3ReleaseHelperPort = parsePort(environment, 'GENEWAY_GATE_A3_RELEASE_PORT', 3175);
  if (new Set([webPort, controlPlanePort, modelGatewayPort]).size !== 3) {
    throw new Error('Web, Control Plane, and Model Gateway ports must be different');
  }
  if (environment.GENEWAY_GATE_A0_RELEASE_PORT !== undefined
    && new Set([webPort, controlPlanePort, modelGatewayPort, releaseHelperPort]).size !== 4) {
    throw new Error('Web, Control Plane, Model Gateway, and release helper ports must be different');
  }
  if (environment.GENEWAY_GATE_A_RELEASE_PORT !== undefined
    && new Set([webPort, controlPlanePort, modelGatewayPort, releaseHelperPort, gateAReleaseHelperPort]).size !== 5) {
    throw new Error('Web, Control Plane, Model Gateway, and both release helper ports must be different');
  }
  if (environment.GENEWAY_GATE_A3_RELEASE_PORT !== undefined
    && new Set([webPort, controlPlanePort, modelGatewayPort, releaseHelperPort,
      gateAReleaseHelperPort, gateA3ReleaseHelperPort]).size !== 6) {
    throw new Error('Web, Control Plane, Model Gateway, and all release helper ports must be different');
  }
  const localOrigins = [`http://localhost:${String(webPort)}`, `http://127.0.0.1:${String(webPort)}`];
  const publicOrigins = lanHosts.map((host) => `http://${host}:${String(webPort)}`);
  return {
    lanHosts,
    webBindHosts: lanHosts,
    webPort,
    controlPlaneBindHost: '127.0.0.1',
    controlPlanePort,
    modelGatewayBindHost: '127.0.0.1',
    modelGatewayPort,
    releaseHelperBindHost: '127.0.0.1',
    releaseHelperPort,
    gateAReleaseHelperBindHost: '127.0.0.1',
    gateAReleaseHelperPort,
    gateA3ReleaseHelperBindHost: '127.0.0.1',
    gateA3ReleaseHelperPort,
    allowedWebOrigins: [...localOrigins, ...publicOrigins],
    publicUrls: publicOrigins.map((origin) => `${origin}/conversations/new`),
  };
}

function buildGateAParserImage(environment = process.env) {
  const output = execFileSync(process.execPath, ['scripts/build-gate-a-document-parser-image.mjs'], {
    cwd: repositoryRoot,
    env: minimalEnvironment(environment),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = output.trim().split('\n').at(-1);
  const metadata = line === undefined ? null : JSON.parse(line);
  if (metadata?.schemaVersion !== 'gate-a-document-parser-image-build-candidate/2'
    || !/^geneway-document-parser:[a-f0-9]{16}$/u.test(metadata.image ?? '')
    || !/^[a-f0-9]{64}$/u.test(metadata.imageSourceDigest ?? '')
    || !/^[a-f0-9]{64}$/u.test(metadata.packageDigest ?? '')
    || !/^[a-f0-9]{64}$/u.test(metadata.pdfjsInventoryDigest ?? '')
    || metadata.image !== `geneway-document-parser:${metadata.imageSourceDigest.slice(0, 16)}`) {
    throw new Error('Gate A parser image build returned invalid source-bound metadata');
  }
  return metadata;
}

function prepareGateAParserApproval(parserBuild, runId, environment = process.env) {
  const output = execFileSync('./node_modules/.bin/tsx', ['scripts/prepare-gate-a-document-parser-approval.ts'], {
    cwd: repositoryRoot,
    env: {
      ...minimalEnvironment(environment),
      GENEWAY_RUN_ID: runId,
      GENEWAY_GATE_A_PARSER_APPROVED_BY: 'user_local',
      GENEWAY_GATE_A_PARSER_BUILD_JSON: JSON.stringify(parserBuild),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = output.trim().split('\n').at(-1);
  const approval = line === undefined ? null : JSON.parse(line);
  const digests = approval?.formatManifestDigests;
  if (approval?.schemaVersion !== 'gate-a-parser-startup-approval/2'
    || approval.runId !== runId || approval.approvedBy !== 'user_local'
    || approval.image !== parserBuild.image
    || !/^sha256:[a-f0-9]{64}$/u.test(approval.imageId ?? '')
    || ![approval.imageSourceDigest, approval.executableDigest, approval.packageDigest,
      approval.runtimeClosureDigest, approval.dependencyInventoryDigest,
      digests?.txt, digests?.pdf, digests?.docx].every((value) => /^[a-f0-9]{64}$/u.test(value ?? ''))) {
    throw new Error('Gate A parser approval preparation returned invalid immutable authority');
  }
  return approval;
}

export function minimalEnvironment(environment = process.env) {
  return {
    PATH: environment.PATH ?? '/usr/bin:/bin',
    HOME: environment.HOME ?? '/tmp',
    TMPDIR: environment.TMPDIR ?? '/tmp',
    LANG: environment.LANG ?? 'C.UTF-8',
  };
}

export function controlPlaneEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => ![
    'GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE',
    'GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE',
    'GENEWAY_GATE_A3_VALIDATION_RUN_ID',
    'GENEWAY_GATE_A3_APPROVED_PREFLIGHT_FILE',
    'GENEWAY_GATE_A3_CONTROLLER_ADMISSION_FILE',
    'GENEWAY_GATE_A3_INTERNAL_VALIDATION_ADMISSION_FILE',
    'GENEWAY_CONNECTOR_GATEWAY_URL',
    'GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE',
    'GENEWAY_CONNECTOR_INVOCATION_SECRET_FILE',
    'GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE',
    'GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE',
    'GENEWAY_MODEL_GATEWAY_WORK_ORDER_RECEIPT_SECRET_FILE',
    'GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE',
  ].includes(name)));
}

function readLiveProviderPaths(environment) {
  const authFilePath = environment.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE;
  const conformanceFilePath = environment.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE;
  if ((authFilePath === undefined) !== (conformanceFilePath === undefined)) {
    throw new Error('GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE and GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE must be configured together');
  }
  return authFilePath === undefined ? undefined : { authFilePath, conformanceFilePath };
}

export function modelGatewayProviderEnvironment(environment = process.env) {
  const liveProvider = readLiveProviderPaths(environment);
  return {
    ...minimalEnvironment(environment),
    ...(liveProvider === undefined ? {} : {
      GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE: liveProvider.authFilePath,
      GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE: liveProvider.conformanceFilePath,
    }),
  };
}

const CONTROL_PLANE_WITH_RELEASE_COMMAND = `set -euo pipefail
control_plane_pid=''
release_helper_pid=''
gate_a_release_helper_pid=''
gate_a3_release_helper_pid=''
run_optional_gate_a3_release() {
  if ./node_modules/.bin/tsx scripts/e2e/start-gate-a3-release.ts; then
    return
  fi
  printf '%s\n' 'Gate A.3 release helper failed; route remains NOT_OPEN while the base stack continues.' >&2
  while kill -0 "$control_plane_pid" 2>/dev/null; do sleep 1; done
}
stop_stack() {
  trap - EXIT INT TERM
  [[ -z "$gate_a3_release_helper_pid" ]] || kill "$gate_a3_release_helper_pid" 2>/dev/null || true
  [[ -z "$gate_a_release_helper_pid" ]] || kill "$gate_a_release_helper_pid" 2>/dev/null || true
  [[ -z "$release_helper_pid" ]] || kill "$release_helper_pid" 2>/dev/null || true
  [[ -z "$control_plane_pid" ]] || kill "$control_plane_pid" 2>/dev/null || true
  [[ -z "$gate_a_release_helper_pid" ]] || wait "$gate_a_release_helper_pid" 2>/dev/null || true
  [[ -z "$gate_a3_release_helper_pid" ]] || wait "$gate_a3_release_helper_pid" 2>/dev/null || true
  [[ -z "$release_helper_pid" ]] || wait "$release_helper_pid" 2>/dev/null || true
  [[ -z "$control_plane_pid" ]] || wait "$control_plane_pid" 2>/dev/null || true
}
trap stop_stack EXIT INT TERM
env -u GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE -u GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE \
  -u GENEWAY_GATE_A0_RELEASE_PORT -u GENEWAY_GATE_A_RELEASE_PORT -u GENEWAY_GATE_A_PARSER_BUILD_JSON \
  ./node_modules/.bin/tsx apps/control-plane/src/main.ts &
control_plane_pid=$!
./node_modules/.bin/tsx scripts/e2e/start-gate-a0-release.ts &
release_helper_pid=$!
./node_modules/.bin/tsx scripts/e2e/start-gate-a-release.ts &
gate_a_release_helper_pid=$!
if [[ -n "\${GENEWAY_GATE_A3_APPROVED_PREFLIGHT_FILE:-}" ]]; then
  run_optional_gate_a3_release &
  gate_a3_release_helper_pid=$!
fi
wait -n "$control_plane_pid" "$release_helper_pid" "$gate_a_release_helper_pid" \${gate_a3_release_helper_pid:+"$gate_a3_release_helper_pid"}`;

const CONTROL_PLANE_WITH_A0_RELEASE_COMMAND = `set -euo pipefail
control_plane_pid=''
release_helper_pid=''
gate_a3_release_helper_pid=''
run_optional_gate_a3_release() {
  if ./node_modules/.bin/tsx scripts/e2e/start-gate-a3-release.ts; then
    return
  fi
  printf '%s\n' 'Gate A.3 release helper failed; route remains NOT_OPEN while the base stack continues.' >&2
  while kill -0 "$control_plane_pid" 2>/dev/null; do sleep 1; done
}
stop_stack() {
  trap - EXIT INT TERM
  [[ -z "$gate_a3_release_helper_pid" ]] || kill "$gate_a3_release_helper_pid" 2>/dev/null || true
  [[ -z "$release_helper_pid" ]] || kill "$release_helper_pid" 2>/dev/null || true
  [[ -z "$control_plane_pid" ]] || kill "$control_plane_pid" 2>/dev/null || true
  [[ -z "$release_helper_pid" ]] || wait "$release_helper_pid" 2>/dev/null || true
  [[ -z "$gate_a3_release_helper_pid" ]] || wait "$gate_a3_release_helper_pid" 2>/dev/null || true
  [[ -z "$control_plane_pid" ]] || wait "$control_plane_pid" 2>/dev/null || true
}
trap stop_stack EXIT INT TERM
env -u GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE -u GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE -u GENEWAY_GATE_A0_RELEASE_PORT \
  ./node_modules/.bin/tsx apps/control-plane/src/main.ts &
control_plane_pid=$!
./node_modules/.bin/tsx scripts/e2e/start-gate-a0-release.ts &
release_helper_pid=$!
if [[ -n "\${GENEWAY_GATE_A3_APPROVED_PREFLIGHT_FILE:-}" ]]; then
  run_optional_gate_a3_release &
  gate_a3_release_helper_pid=$!
fi
wait -n "$control_plane_pid" "$release_helper_pid" \${gate_a3_release_helper_pid:+"$gate_a3_release_helper_pid"}`;

export function buildControlPlaneStackPlan({
  configuration,
  runId,
  socketPath,
  tokenFile,
  gatewayServiceTokenFile,
  gatewayInvocationSecretFile,
  liveProvider,
  parserBuild,
  parserApproval,
  approvedC1Sha256,
  gateA3,
}) {
  const environmentArguments = [
    `GENEWAY_WEB_ALLOWED_ORIGINS=${configuration.allowedWebOrigins.join(',')}`,
    `GENEWAY_WORKER_SOCKET_PATH=${socketPath}`,
    `GENEWAY_WORKER_TOKEN_FILE=${tokenFile}`,
    `GENEWAY_MODEL_GATEWAY_URL=http://${configuration.modelGatewayBindHost}:${String(configuration.modelGatewayPort)}`,
    `GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE=${gatewayServiceTokenFile}`,
    `GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE=${gatewayInvocationSecretFile}`,
    `GENEWAY_RUN_ID=${runId}`,
    `GENEWAY_GATE_A0_LIVE_VALIDATION_RUN_ID=${runId}`,
    // Live provider calls routinely exceed one second. Keep the disposable
    // execution lease long enough for the bounded model call while preserving
    // the repository's expired-lease reclaim/fence behavior.
    'GENEWAY_WORKER_LEASE_MS=60000',
  ];
  if (gateA3 !== undefined) environmentArguments.push(
    `GENEWAY_GATE_A3_VALIDATION_RUN_ID=${runId}`,
    `GENEWAY_CONTROL_PLANE_URL=http://${configuration.controlPlaneBindHost}:${String(configuration.controlPlanePort)}`,
    `GENEWAY_GATE_A3_RELEASE_PORT=${String(configuration.gateA3ReleaseHelperPort)}`,
    `GENEWAY_GATE_A3_APPROVED_PREFLIGHT_FILE=${gateA3.approvedPreflightFile}`,
    `GENEWAY_GATE_A3_CONTROLLER_ADMISSION_FILE=${gateA3.controllerAdmissionFile}`,
    `GENEWAY_GATE_A3_INTERNAL_VALIDATION_ADMISSION_FILE=${gateA3.internalValidationAdmissionFile}`,
    `GENEWAY_CONNECTOR_GATEWAY_URL=${gateA3.connectorGatewayUrl}`,
    `GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE=${gateA3.connectorGatewayServiceTokenFile}`,
    `GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE=${gateA3.connectorGatewayInvocationSecretFile}`,
    `GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE=${gateA3.connectorGatewayReceiptSecretFile}`,
    `GENEWAY_MODEL_GATEWAY_WORK_ORDER_RECEIPT_SECRET_FILE=${gateA3.modelGatewayWorkOrderReceiptSecretFile}`,
  );
  if (gateA3 !== undefined && liveProvider === undefined) {
    throw new Error('Gate A.3 requires the configured live model provider authority');
  }
  if (liveProvider === undefined) {
    return {
      arguments: ['scripts/with-storage.sh', 'env', ...environmentArguments,
        './node_modules/.bin/tsx', 'apps/control-plane/src/main.ts'],
      releaseHealthUrl: null,
      gateAReleaseHealthUrl: null,
    };
  }
  if ((parserBuild === undefined) !== (parserApproval === undefined)) {
    throw new Error('Gate A parser build and approval metadata must be configured together');
  }
  const gateAEnabled = parserBuild !== undefined && parserApproval !== undefined;
  if (approvedC1Sha256 !== undefined && (!gateAEnabled
    || Buffer.byteLength(approvedC1Sha256, 'utf8') > 4_096
    || approvedC1Sha256.split(',').some((hash) => !/^[a-f0-9]{64}$/u.test(hash)))) {
    throw new Error('Gate A dev C1 allowlist requires parser authority and comma-separated lowercase SHA-256 values');
  }
  environmentArguments.push(
    `GENEWAY_GATE_A0_RELEASE_PORT=${String(configuration.releaseHelperPort)}`,
    `GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE=${liveProvider.authFilePath}`,
    `GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE=${liveProvider.conformanceFilePath}`,
  );
  if (gateAEnabled) environmentArguments.push(
    `GENEWAY_GATE_A_RELEASE_PORT=${String(configuration.gateAReleaseHelperPort)}`,
    `GENEWAY_GATE_A_LIVE_VALIDATION_RUN_ID=${runId}`,
    `GENEWAY_GATE_A_PARSER_IMAGE=${parserBuild.image}`,
    `GENEWAY_GATE_A_PARSER_BUILD_JSON=${JSON.stringify(parserBuild)}`,
    `GENEWAY_GATE_A_PARSER_APPROVAL_JSON=${JSON.stringify(parserApproval)}`,
    ...(approvedC1Sha256 === undefined ? [] : [`GENEWAY_GATE_A_APPROVED_C1_SHA256=${approvedC1Sha256}`]),
  );
  return {
    arguments: ['scripts/with-storage.sh', 'env', ...environmentArguments, 'bash', '-c',
      gateAEnabled ? CONTROL_PLANE_WITH_RELEASE_COMMAND : CONTROL_PLANE_WITH_A0_RELEASE_COMMAND],
    releaseHealthUrl: `http://${configuration.releaseHelperBindHost}:${String(configuration.releaseHelperPort)}/health`,
    gateAReleaseHealthUrl: gateAEnabled
      ? `http://${configuration.gateAReleaseHelperBindHost}:${String(configuration.gateAReleaseHelperPort)}/health`
      : null,
  };
}

async function portIsAvailable(host, port) {
  const server = net.createServer();
  const available = await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(port, host, resolve);
  });
  if (available === false) return false;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return true;
}

async function portIsAvailableOnAll(hosts, port) {
  for (const host of hosts) {
    if (!await portIsAvailable(host, port)) return false;
  }
  return true;
}

async function resolvePort(hosts, preferredPort, explicit, label) {
  if (await portIsAvailableOnAll(hosts, preferredPort)) return preferredPort;
  if (explicit) throw new Error(`${label} port ${hosts.join(', ')}:${String(preferredPort)} is unavailable`);
  for (let port = preferredPort + 1; port <= Math.min(preferredPort + 99, 65_535); port += 1) {
    if (await portIsAvailableOnAll(hosts, port)) return port;
  }
  throw new Error(`No available ${label} port found from ${String(preferredPort)} to ${String(preferredPort + 99)}`);
}

async function resolveUnreservedPort(hosts, preferredPort, reservedPorts, explicit, label) {
  if (!reservedPorts.has(preferredPort) && await portIsAvailableOnAll(hosts, preferredPort)) return preferredPort;
  if (explicit) throw new Error(`${label} port ${hosts.join(', ')}:${String(preferredPort)} is unavailable`);
  for (let port = preferredPort + 1; port <= Math.min(preferredPort + 99, 65_535); port += 1) {
    if (!reservedPorts.has(port) && await portIsAvailableOnAll(hosts, port)) return port;
  }
  throw new Error(`No available ${label} port found from ${String(preferredPort)} to ${String(preferredPort + 99)}`);
}

function processGroupExists(child) {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined || !processGroupExists(child)) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stopProcess(child, timeoutMs) {
  if (child === undefined || child.pid === undefined || !processGroupExists(child)) return;
  signalProcessGroup(child, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processGroupExists(child)) signalProcessGroup(child, 'SIGKILL');
}

async function waitFor(check, description, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${description} failed because its process exited`);
    try {
      if (await check()) return;
    } catch {
      // The service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function startProcess(command, args, environment, cwd = repositoryRoot) {
  return spawn(command, args, {
    cwd,
    env: environment,
    stdio: 'inherit',
    detached: true,
  });
}

async function main() {
  const arguments_ = process.argv.slice(2).filter((argument, index) => !(argument === '--' && index === 0));
  if (arguments_.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  if (arguments_.some((argument) => argument !== '--print-config')) throw new Error(`Unknown argument: ${arguments_.join(' ')}`);

  let configuration = readConfiguration(process.env);
  const liveProvider = readLiveProviderPaths(process.env);
  if (arguments_.includes('--print-config')) {
    process.stdout.write(`${JSON.stringify(configuration)}\n`);
    return;
  }

  const [controlPlanePort, modelGatewayPort, webPort] = await Promise.all([
    resolvePort(['127.0.0.1'], configuration.controlPlanePort, process.env.GENEWAY_CONTROL_PLANE_PORT !== undefined, 'Control Plane'),
    resolvePort(['127.0.0.1'], configuration.modelGatewayPort, process.env.GENEWAY_MODEL_GATEWAY_PORT !== undefined, 'Model Gateway'),
    resolvePort(configuration.webBindHosts, configuration.webPort, process.env.GENEWAY_WEB_PORT !== undefined, 'Web'),
  ]);
  const connectorGatewayPort = await resolveUnreservedPort(
    ['127.0.0.1'],
    connectorGatewayDefaultPort,
    new Set([controlPlanePort, modelGatewayPort, webPort]),
    false,
    'Connector Gateway',
  );
  const releaseHelperPort = liveProvider === undefined
    ? configuration.releaseHelperPort
    : await resolveUnreservedPort(
      [configuration.releaseHelperBindHost],
      configuration.releaseHelperPort,
      new Set([controlPlanePort, modelGatewayPort, connectorGatewayPort, webPort]),
      process.env.GENEWAY_GATE_A0_RELEASE_PORT !== undefined,
      'Gate A0 release helper',
    );
  const gateAReleaseHelperPort = liveProvider === undefined
    ? configuration.gateAReleaseHelperPort
    : await resolveUnreservedPort(
      [configuration.gateAReleaseHelperBindHost],
      configuration.gateAReleaseHelperPort,
      new Set([controlPlanePort, modelGatewayPort, connectorGatewayPort, webPort, releaseHelperPort]),
      process.env.GENEWAY_GATE_A_RELEASE_PORT !== undefined,
      'Gate A release helper',
    );
  const gateA3ReleaseHelperPort = liveProvider === undefined
    ? configuration.gateA3ReleaseHelperPort
    : await resolveUnreservedPort(
      [configuration.gateA3ReleaseHelperBindHost],
      configuration.gateA3ReleaseHelperPort,
      new Set([controlPlanePort, modelGatewayPort, connectorGatewayPort, webPort,
        releaseHelperPort, gateAReleaseHelperPort]),
      process.env.GENEWAY_GATE_A3_RELEASE_PORT !== undefined,
      'Gate A.3 release helper',
    );
  configuration = {
    ...readConfiguration({
      ...process.env,
      GENEWAY_CONTROL_PLANE_PORT: String(controlPlanePort),
      GENEWAY_MODEL_GATEWAY_PORT: String(modelGatewayPort),
      GENEWAY_WEB_PORT: String(webPort),
    }),
    releaseHelperPort,
    gateAReleaseHelperPort,
    gateA3ReleaseHelperPort,
  };

  const runId = `dev-${String(Date.now())}-${String(process.pid)}`;
  let gateA3Authority;
  let gateA3Runtime;
  let gateA3UnavailableReason;
  if (liveProvider === undefined) {
    gateA3UnavailableReason = 'live model provider authority is unavailable';
  } else {
    try {
      gateA3Authority = readApprovedGateA3Authority();
      gateA3Runtime = ensureGateA3Runtime(gateA3Authority);
    } catch (error) {
      gateA3UnavailableReason = error instanceof Error ? error.message : 'Gate A.3 authority or runtime is unavailable';
      process.stderr.write(`Gate A.3 未开放；Fast Chat 与材料分析继续启动：${gateA3UnavailableReason}\n`);
    }
  }
  const parserBuild = liveProvider === undefined ? undefined : buildGateAParserImage(process.env);
  const parserApproval = parserBuild === undefined ? undefined
    : prepareGateAParserApproval(parserBuild, runId, process.env);
  const authorityDirectory = mkdtempSync('/tmp/geneway-dev-');
  const authorityFiles = writeDistinctSecrets(authorityDirectory, {
    tokenFile: 'worker.token',
    gatewayServiceTokenFile: 'model-gateway-service.token',
    gatewayInvocationSecretFile: 'model-gateway-invocation.token',
    ...(gateA3Authority === undefined ? {} : {
      modelGatewayWorkOrderReceiptSecretFile: 'model-gateway-work-order-receipt.secret',
      connectorGatewayServiceTokenFile: 'connector-gateway-service.token',
      connectorGatewayReceiptSecretFile: 'connector-gateway-receipt.secret',
    }),
  }, gateA3Authority?.existingSecretDigests ?? []);
  const {
    tokenFile,
    gatewayServiceTokenFile,
    gatewayInvocationSecretFile,
    modelGatewayWorkOrderReceiptSecretFile,
    connectorGatewayServiceTokenFile,
    connectorGatewayReceiptSecretFile,
  } = authorityFiles;
  const socketPath = `${authorityDirectory}/worker.sock`;
  const workerInstanceId = `dev-worker-${String(process.pid)}-${String(Date.now())}`;
  const receiptPath = `/tmp/geneway-runs/${runId}/process-boundaries/worker.json`;

  let modelGateway;
  let connectorGateway;
  let controlPlane;
  let worker;
  let webs = [];
  let stopping = false;
  let shutdownRequested = false;
  let fatalError;
  let releaseFatal;
  const fatal = new Promise((resolve) => { releaseFatal = resolve; });
  let releaseShutdown;
  const shutdown = new Promise((resolve) => { releaseShutdown = resolve; });
  const requestShutdown = () => {
    shutdownRequested = true;
    releaseShutdown();
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  const waitForLifecycle = async (readiness) => {
    const outcome = await Promise.race([
      readiness.then(() => 'ready'),
      fatal.then(() => 'fatal'),
      shutdown.then(() => 'shutdown'),
    ]);
    if (outcome === 'fatal') throw fatalError;
    return outcome;
  };
  const watch = (label, child) => {
    child.once('exit', (code, signal) => {
      if (stopping) return;
      fatalError = new Error(`${label} exited unexpectedly: code=${String(code)} signal=${String(signal)}`);
      releaseFatal();
    });
  };
  let gateA3ConnectorReady = false;
  const watchOptionalConnector = (child) => {
    child.once('exit', (code, signal) => {
      if (stopping) return;
      gateA3ConnectorReady = false;
      gateA3UnavailableReason = `Connector Gateway exited: code=${String(code)} signal=${String(signal)}`;
      process.stderr.write(`Gate A.3 已转为 NOT_OPEN；Fast Chat 与材料分析继续：${gateA3UnavailableReason}\n`);
    });
  };

  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\n正在停止 geneway 开发环境…\n');
    for (const web of [...webs].reverse()) await stopProcess(web, 5_000);
    await stopProcess(worker, 5_000);
    await stopProcess(controlPlane, 20_000);
    await stopProcess(connectorGateway, 5_000);
    await stopProcess(modelGateway, 5_000);
    if (!authorityDirectory.startsWith('/tmp/geneway-dev-')) throw new Error('Refusing to clean an unexpected authority directory');
    rmSync(authorityDirectory, { recursive: true, force: true });
    const runDirectory = `/tmp/geneway-runs/${runId}`;
    if (runDirectory.startsWith('/tmp/geneway-runs/dev-')) rmSync(runDirectory, { recursive: true, force: true });
  };

  try {
    process.stdout.write('启动 loopback Model Gateway…\n');
    modelGateway = startProcess('./node_modules/.bin/tsx', ['services/model-gateway/src/main.ts'], {
      ...modelGatewayProviderEnvironment(process.env),
      NODE_ENV: 'development',
      GENEWAY_MODEL_GATEWAY_PORT: String(configuration.modelGatewayPort),
      GENEWAY_CONTROL_PLANE_URL: `http://127.0.0.1:${String(configuration.controlPlanePort)}`,
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: gatewayServiceTokenFile,
      GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE: gatewayInvocationSecretFile,
      ...(modelGatewayWorkOrderReceiptSecretFile === undefined ? {} : {
        GENEWAY_MODEL_GATEWAY_WORK_ORDER_RECEIPT_SECRET_FILE: modelGatewayWorkOrderReceiptSecretFile,
      }),
    });
    watch('Model Gateway', modelGateway);
    if (await waitForLifecycle(waitFor(
      async () => (await fetch(`http://127.0.0.1:${String(configuration.modelGatewayPort)}/health`)).ok,
      'Model Gateway', 30_000, modelGateway,
    )) === 'shutdown') return;

    const buildStackPlan = (authority) => buildControlPlaneStackPlan({
      configuration,
      runId,
      socketPath,
      tokenFile,
      gatewayServiceTokenFile,
      gatewayInvocationSecretFile,
      liveProvider,
      parserBuild,
      parserApproval,
      approvedC1Sha256: process.env.GENEWAY_GATE_A_APPROVED_C1_SHA256,
      gateA3: authority === undefined ? undefined : {
        approvedPreflightFile: authority.approvedPreflightFile,
        controllerAdmissionFile: authority.controllerAdmissionFile,
        internalValidationAdmissionFile: authority.internalValidationAdmissionFile,
        connectorGatewayUrl: `http://127.0.0.1:${String(connectorGatewayPort)}`,
        connectorGatewayServiceTokenFile,
        connectorGatewayInvocationSecretFile: authority.connectorInvocationSecretFile,
        connectorGatewayReceiptSecretFile,
        modelGatewayWorkOrderReceiptSecretFile,
      },
    });
    let controlPlaneStack = buildStackPlan(gateA3Authority);
    for (;;) {
      process.stdout.write(`启动 Control Plane 与临时基础设施（run ${runId}）…\n`);
      controlPlane = startProcess('bash', controlPlaneStack.arguments, {
        ...controlPlaneEnvironment(),
        GENEWAY_STORAGE_TARGET_ROLE: 'control-plane',
        GENEWAY_START_STORAGE_RECONCILER: '1',
        GENEWAY_RUN_ID: runId,
        PORT: String(configuration.controlPlanePort),
        GENEWAY_WEB_PORT: String(configuration.webPort),
      });
      try {
        if (await waitForLifecycle(waitFor(
          async () => (await fetch(`http://127.0.0.1:${String(configuration.controlPlanePort)}/health`)).ok
            && existsSync(socketPath) && lstatSync(socketPath).isSocket(),
          'Control Plane and Worker UDS',
          60_000,
          controlPlane,
        )) === 'shutdown') return;
        watch('Control Plane', controlPlane);
        break;
      } catch (error) {
        if (gateA3Authority === undefined || fatalError !== undefined) throw error;
        await stopProcess(controlPlane, 20_000);
        controlPlane = undefined;
        gateA3UnavailableReason = error instanceof Error
          ? `Control Plane rejected Gate A.3 startup authority: ${error.message}`
          : 'Control Plane rejected Gate A.3 startup authority';
        gateA3Authority = undefined;
        gateA3Runtime = undefined;
        process.stderr.write(`Gate A.3 未开放；正在不带 A.3 authority 重启基础栈：${gateA3UnavailableReason}\n`);
        controlPlaneStack = buildStackPlan(undefined);
      }
    }

    // The Control Plane owns 127.0.0.1:8100 and establishes its signed proxy
    // before the Connector Gateway can issue any facade request.
    if (gateA3Authority !== undefined) {
      process.stdout.write('启动 loopback Connector Gateway…\n');
      connectorGateway = startProcess('./node_modules/.bin/tsx', ['services/connector-gateway/src/main.ts'], {
        ...minimalEnvironment(process.env),
        NODE_ENV: 'development',
        GENEWAY_CONNECTOR_GATEWAY_PORT: String(connectorGatewayPort),
        GENEWAY_CONTROL_PLANE_URL: `http://127.0.0.1:${String(configuration.controlPlanePort)}`,
        GENEWAY_GEARJOB_FACADE_URL: gearJobOrigin,
        GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE: connectorGatewayServiceTokenFile,
        GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE: gateA3Authority.connectorInvocationSecretFile,
        GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE: connectorGatewayReceiptSecretFile,
        GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE: gateA3Authority.gearJobServiceCredentialFile,
      });
      try {
        if (await waitForLifecycle(waitFor(
          async () => (await fetch(`http://127.0.0.1:${String(connectorGatewayPort)}/health`)).ok,
          'Connector Gateway', 30_000, connectorGateway,
        )) === 'shutdown') return;
        gateA3ConnectorReady = true;
        watchOptionalConnector(connectorGateway);
      } catch (error) {
        if (fatalError !== undefined) throw error;
        await stopProcess(connectorGateway, 5_000);
        connectorGateway = undefined;
        gateA3UnavailableReason = error instanceof Error ? error.message : 'Connector Gateway is unavailable';
        process.stderr.write(`Gate A.3 保持 NOT_OPEN；Fast Chat 与材料分析继续：${gateA3UnavailableReason}\n`);
      }
    }

    if (controlPlaneStack.releaseHealthUrl !== null) {
      process.stdout.write('等待本次 disposable chat release 进入 internal…\n');
      if (await waitForLifecycle(waitFor(async () => {
        const response = await fetch(controlPlaneStack.releaseHealthUrl);
        if (!response.ok) return false;
        const body = await response.json();
        return body.ready === true && body.state === 'internal';
      }, 'Gate A0 release helper', 60_000, controlPlane)) === 'shutdown') return;
    }
    if (controlPlaneStack.gateAReleaseHealthUrl !== null) {
      process.stdout.write('等待本次 disposable Gate A release 进入 internal…\n');
      if (await waitForLifecycle(waitFor(async () => {
        const response = await fetch(controlPlaneStack.gateAReleaseHealthUrl);
        if (!response.ok) return false;
        const body = await response.json();
        return body.ready === true && body.state === 'internal' && body.runId === runId;
      }, 'Gate A release helper', 60_000, controlPlane)) === 'shutdown') return;
    }

    if (gateA3Authority !== undefined && gateA3ConnectorReady) {
      process.stdout.write('等待 Gate A.3 authority 与双 Gateway readiness…\n');
      try {
        if (await waitForLifecycle(waitFor(async () => {
          const response = await fetch(
            `http://127.0.0.1:${String(configuration.controlPlanePort)}/api/capabilities/production.work-order-status.v1`,
          );
          if (!response.ok) return false;
          const body = await response.json();
          return body.status === 'internal' && body.executionRoute === 'live';
        }, 'Gate A.3 authority and Gateway readiness', 30_000, controlPlane)) === 'shutdown') return;
      } catch (error) {
        if (fatalError !== undefined) throw error;
        gateA3ConnectorReady = false;
        gateA3UnavailableReason = error instanceof Error ? error.message : 'Gate A.3 readiness is unavailable';
        process.stderr.write(`Gate A.3 保持 NOT_OPEN；Fast Chat 与材料分析继续：${gateA3UnavailableReason}\n`);
      }
    }

    process.stdout.write('启动独立 Worker…\n');
    worker = startProcess('./node_modules/.bin/tsx', ['apps/worker/src/main.ts'], {
      ...minimalEnvironment(process.env),
      NODE_ENV: 'test',
      GENEWAY_RUN_ID: runId,
      GENEWAY_WORKER_SOCKET_PATH: socketPath,
      GENEWAY_WORKER_TOKEN_FILE: tokenFile,
      GENEWAY_WORKER_INSTANCE_ID: workerInstanceId,
      GENEWAY_WORKER_CONSUMER: 'gate0.2a-worker',
      GENEWAY_WORKER_DEPLOYMENT: 'gate0.2a-local',
      GENEWAY_MODEL_GATEWAY_URL: `http://${configuration.modelGatewayBindHost}:${String(configuration.modelGatewayPort)}`,
      GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: gatewayServiceTokenFile,
      ...(!gateA3ConnectorReady ? {} : {
        GENEWAY_GATE_A3_WORK_ORDER_ENABLED: '1',
        GENEWAY_CONNECTOR_GATEWAY_URL: `http://127.0.0.1:${String(connectorGatewayPort)}`,
        GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE: connectorGatewayServiceTokenFile,
      }),
      ...(liveProvider === undefined ? {} : { GENEWAY_GATE_A_LIVE_ENABLED: '1' }),
    });
    watch('Worker', worker);
    if (await waitForLifecycle(waitFor(() => {
      if (!existsSync(receiptPath)) return false;
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      return receipt.ready === true && receipt.workerInstanceId === workerInstanceId;
    }, 'Worker readiness', 20_000, worker)) === 'shutdown') return;

    process.stdout.write(`启动 ${String(configuration.webBindHosts.length)} 个局域网 Web 入口…\n`);
    webs = configuration.webBindHosts.map((host) => startProcess('./node_modules/.bin/vite', [], {
      ...minimalEnvironment(process.env),
      NODE_ENV: 'development',
      GENEWAY_RUN_ID: runId,
      GENEWAY_WEB_HOST: host,
      GENEWAY_WEB_PORT: String(configuration.webPort),
      GENEWAY_CONTROL_PLANE_PORT: String(configuration.controlPlanePort),
    }, `${repositoryRoot}/apps/web`));
    webs.forEach((web, index) => watch(`Web ${configuration.webBindHosts[index]}`, web));
    const webReadiness = Promise.all(configuration.webBindHosts.map((host, index) => waitFor(
      async () => (await fetch(`http://${host}:${String(configuration.webPort)}/health`)).ok,
      `Web ${host}`,
      30_000,
      webs[index],
    )));
    if (await waitForLifecycle(webReadiness) === 'shutdown') return;

    const displayedUrls = configuration.publicUrls.map((url) => `  ${url}`).join('\n');
    const gateA3Summary = gateA3Authority === undefined || !gateA3ConnectorReady
      ? `Gate A.3: NOT_OPEN (${gateA3UnavailableReason ?? 'authority unavailable'})`
      : `Gate A.3 authority: ${gateA3Authority.artifactId}\nPreflight digest: ${gateA3Authority.approvedPreflightDigest}\nRuntime image: ${gateA3Authority.runtimeImageId}\nRuntime container: ${gateA3Runtime?.runtimeContainerId ?? gateA3RuntimeContainerName}\nConnector Gateway: 127.0.0.1:${String(connectorGatewayPort)}\nGearJob facade proxy: ${gearJobOrigin}`;
    process.stdout.write(`\n✓ geneway 开发环境已启动\n\n${gateA3Summary}\n\n局域网入口（本机同样使用）：\n${displayedUrls}\n\nWeb 只监听 ${configuration.lanHosts.join('、')}；按 Ctrl+C 停止并清理 geneway 临时数据。GearJob runtime 与 volume 会保留并复用。\n`);
    const outcome = await Promise.race([fatal.then(() => 'fatal'), shutdown.then(() => 'shutdown')]);
    if (outcome === 'fatal') throw fatalError;
  } finally {
    await cleanup();
    process.removeListener('SIGINT', requestShutdown);
    process.removeListener('SIGTERM', requestShutdown);
    if (shutdownRequested) process.exitCode = 0;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
