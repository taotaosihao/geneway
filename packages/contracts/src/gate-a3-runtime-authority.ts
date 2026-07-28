import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const dockerImageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' as const;
const baseImageId = 'sha256:6b3f4e4816d81250699d4245be454c84ce2144899e5dd7c90384c49898ebbf5f' as const;

const installedAppsSchema = z.tuple([
  z.literal('frappe'), z.literal('erpnext'), z.literal('hrms'), z.literal('print_designer'), z.literal('gearjob'),
]);

export const gateA3GearJobSafeConfigProjectionSchema = z.object({
  site: z.literal('dev.localhost'),
  developerMode: z.literal(true),
  frappeSentryDsnPresent: z.literal(false),
  enableFrappeLogger: z.literal(false),
  monitor: z.literal(false),
  rateLimit: z.literal(false),
  logApiRequests: z.literal(false),
  recorderIntercept: z.literal(false),
}).strict();

export const gateA3GearJobDynamicRuntimeAuthoritySchema = z.object({
  schemaVersion: z.literal('gearjob-gate-a3-dynamic-runtime-authority/1'),
  appsTxtSha256: sha256Schema,
  installedApps: installedAppsSchema,
  runtimeImageId: dockerImageIdSchema,
  runtimeTopologyDigest: sha256Schema,
  safeConfigProjection: gateA3GearJobSafeConfigProjectionSchema,
}).strict();

const sourceTreeProjectionSchema = z.object({
  name: z.enum(['gearjob', 'frappe', 'erpnext', 'hrms', 'print_designer']),
  root: z.string().startsWith('/workspace/'),
  fileCount: z.number().int().positive(),
  symlinkCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  treeSha256: sha256Schema,
}).strict();

const venvTreeProjectionSchema = z.object({
  name: z.literal('bench-venv'),
  root: z.literal('/workspace/development/frappe-bench/env'),
  fileCount: z.number().int().positive(),
  symlinkCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  treeSha256: sha256Schema,
}).strict();

const boundaryFileSchema = (path: string) => z.object({ path: z.literal(path), sha256: sha256Schema }).strict();

const gearJobProjectionSchema = z.object({
  boundaryFileManifest: z.tuple([
    boundaryFileSchema('deploy/Dockerfile.gate-a3-runtime'),
    boundaryFileSchema('deploy/docker-compose.yml'),
    boundaryFileSchema('deploy/docker-compose.gate-a3.yml'),
    boundaryFileSchema('deploy/gate-a3-runtime-verify.py'),
    boundaryFileSchema('gearjob/api/connector_auth.py'),
    boundaryFileSchema('gearjob/api/tests/test_connector_auth.py'),
    boundaryFileSchema('gearjob/api/tests/test_gate_a3_runtime_authority.py'),
    boundaryFileSchema('gearjob/api/tests/test_read_only_cache.py'),
    boundaryFileSchema('gearjob/api/tests/test_work_order.py'),
    boundaryFileSchema('gearjob/api/work_order.py'),
    boundaryFileSchema('gearjob/gate_a3_server.py'),
    boundaryFileSchema('gearjob/monkey_patches/read_only_cache.py'),
  ]),
  cleanScopes: z.tuple([
    z.literal('gearjob'),
    z.literal('deploy/docker-compose.yml'),
    z.literal('deploy/docker-compose.gate-a3.yml'),
    z.literal('deploy/Dockerfile.gate-a3-runtime'),
    z.literal('deploy/gate-a3-runtime-verify.py'),
  ]),
  cleanStatusSha256: z.literal(emptySha256),
  commit: gitCommitSchema,
  sourceTreeSha256: sha256Schema,
}).strict();

const nestedAppProjection = <T extends 'frappe' | 'erpnext' | 'hrms' | 'print_designer'>(app: T) => z.object({
  app: z.literal(app),
  cleanStatusSha256: z.literal(emptySha256),
  commit: gitCommitSchema,
  sourceTreeSha256: sha256Schema,
}).strict();

const pythonDistributionInventorySchema = z.object({
  schemaVersion: z.literal('gearjob-python-distribution-inventory/1'),
  implementation: z.literal('cpython'),
  pythonVersion: z.literal('3.14.2'),
  packages: z.array(z.object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    version: z.string().min(1).max(256),
  }).strict()).length(157),
}).strict();

const pythonStartupFileSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  sha256: sha256Schema,
}).strict();

const mountProjection = <T extends string, R extends boolean, K extends 'bind' | 'tmpfs'>(
  destination: T,
  readOnly: R,
  type: K,
) => z.object({ destination: z.literal(destination), readOnly: z.literal(readOnly), type: z.literal(type) }).strict();

const bindSourceProjection = <T extends string, D extends string, R extends boolean,
  K extends 'directory' | 'character-device'>(source: T, destination: D, readOnly: R, sourceKind: K) => z.object({
    destination: z.literal(destination), readOnly: z.literal(readOnly), source: z.literal(source),
    sourceKind: z.literal(sourceKind),
  }).strict();

const runtimePeerProjection = <T extends 'frappe' | 'mariadb' | 'redis-cache' | 'redis-queue',
  I extends z.ZodType, B extends z.ZodType>(
  service: T,
  imageId: I,
  bindMounts: B,
) => z.object({
  bindMounts,
  composeIdentity: z.object({
    containerNumber: z.literal('1'), oneoff: z.literal('False'), project: z.literal('gearjob_dev'),
    service: z.literal(service),
  }).strict(),
  containerName: z.literal(`gearjob_dev-${service}-1`),
  dns: z.tuple([]),
  dnsOptions: z.tuple([]),
  dnsSearch: z.tuple([]),
  extraHosts: z.tuple([]),
  imageId,
  links: z.tuple([]),
  networkAliases: z.tuple([z.literal(`gearjob_dev-${service}-1`), z.literal(service)]),
  publishAllPorts: z.literal(false),
  publishedPorts: z.tuple([]),
}).strict();

export const gateA3GearJobRuntimeTopologySchema = z.object({
  schemaVersion: z.literal('gearjob-gate-a3-runtime-topology/1'),
  projectName: z.literal('gearjob_dev'),
  network: z.object({
    name: z.literal('gearjob_dev_gate-a3-internal'),
    driver: z.literal('bridge'),
    scope: z.literal('local'),
    internal: z.literal(true),
    attachable: z.literal(false),
    ingress: z.literal(false),
    enableIPv4: z.literal(true),
    enableIPv6: z.literal(false),
    ipam: z.object({
      driver: z.literal('default'),
      options: z.object({}).strict(),
      config: z.tuple([z.object({
        subnet: z.literal('192.168.32.0/20'), gateway: z.literal('192.168.32.1'),
      }).strict()]),
    }).strict(),
    options: z.object({}).strict(),
  }).strict(),
  peers: z.tuple([
    runtimePeerProjection('frappe', dockerImageIdSchema, z.tuple([
      bindSourceProjection('/dev/null', '/home/frappe/.git-credentials', true, 'character-device'),
      bindSourceProjection('/dev/null', '/home/frappe/.gitconfig', true, 'character-device'),
      bindSourceProjection('/home/gewu/work/gearjob/development/frappe-bench/logs',
        '/workspace/development/frappe-bench/logs', false, 'directory'),
      bindSourceProjection('/home/gewu/work/gearjob/development/frappe-bench/sites',
        '/workspace/development/frappe-bench/sites', true, 'directory'),
      bindSourceProjection('/home/gewu/work/gearjob/development/frappe-bench/sites/dev.localhost/logs',
        '/workspace/development/frappe-bench/sites/dev.localhost/logs', false, 'directory'),
    ])),
    runtimePeerProjection('mariadb', z.literal(
      'sha256:78a5047d3ba33975f183f183c2464cc7f1eab13ec8667e57cc9a5821d6da7577',
    ), z.tuple([])),
    runtimePeerProjection('redis-cache', z.literal(
      'sha256:d146f83b1e0f02fc27c26a50cee39338c736674c5959db84363e6ae3cd9e02d2',
    ), z.tuple([])),
    runtimePeerProjection('redis-queue', z.literal(
      'sha256:d146f83b1e0f02fc27c26a50cee39338c736674c5959db84363e6ae3cd9e02d2',
    ), z.tuple([])),
  ]),
}).strict();

const containerProjectionSchema = z.object({
  imageId: dockerImageIdSchema,
  argv: z.tuple([
    z.literal('/home/frappe/.pyenv/versions/3.14.2/bin/python3'),
    z.literal('-I'), z.literal('-S'), z.literal('/usr/local/libexec/gate-a3-runtime-verify.py'),
    z.literal('serve'), z.literal('--site'), z.literal('dev.localhost'), z.literal('--port'), z.literal('8100'),
  ]),
  entrypoint: z.tuple([
    z.literal('/home/frappe/.pyenv/versions/3.14.2/bin/python3'),
    z.literal('-I'), z.literal('-S'), z.literal('/usr/local/libexec/gate-a3-runtime-verify.py'),
  ]),
  command: z.tuple([
    z.literal('serve'), z.literal('--site'), z.literal('dev.localhost'), z.literal('--port'), z.literal('8100'),
  ]),
  workingDirectory: z.literal('/workspace/development/frappe-bench/sites'),
  user: z.literal('1000:1000'),
  readOnlyRootFilesystem: z.literal(true),
  pythonDontWriteBytecode: z.literal(true),
  pythonNoUserSite: z.literal(true),
  capDrop: z.tuple([z.literal('ALL')]),
  noNewPrivileges: z.literal(true),
  privileged: z.literal(false),
  networkPolicy: z.literal('single-internal-compose-network-with-signed-loopback-proxy/1'),
  publishedPorts: z.tuple([]),
  mounts: z.tuple([
    mountProjection('/home/frappe/.cache', false, 'tmpfs'),
    mountProjection('/home/frappe/.git-credentials', true, 'bind'),
    mountProjection('/home/frappe/.gitconfig', true, 'bind'),
    mountProjection('/workspace/development/frappe-bench/logs', false, 'bind'),
    mountProjection('/workspace/development/frappe-bench/sites/dev.localhost/logs', false, 'bind'),
    mountProjection('/workspace/development/frappe-bench/sites/dev.localhost/locks', false, 'tmpfs'),
    mountProjection('/workspace/development/frappe-bench/sites', true, 'bind'),
    mountProjection('/tmp', false, 'tmpfs'),
  ]),
  imageBuild: z.object({
    baseImageId: z.literal(baseImageId),
    dockerfileSha256: sha256Schema,
    entrypointVerifierSha256: sha256Schema,
    runtimeImageId: dockerImageIdSchema,
  }).strict(),
  imageLabels: z.object({
    'dev.geneway.gate-a3.base-image-id': z.literal(baseImageId),
    'dev.geneway.gate-a3.source-clean-status-sha256': z.literal(emptySha256),
    'dev.geneway.gate-a3.gearjob-commit': gitCommitSchema,
    'dev.geneway.gate-a3.frappe-commit': gitCommitSchema,
    'dev.geneway.gate-a3.erpnext-commit': gitCommitSchema,
    'dev.geneway.gate-a3.hrms-commit': gitCommitSchema,
    'dev.geneway.gate-a3.print-designer-commit': gitCommitSchema,
  }).strict(),
}).strict();

export const gateA3GearJobRuntimeAuthoritySchema = z.object({
  schemaVersion: z.literal('gearjob-gate-a3-runtime-authority/1'),
  appsTxtSha256: sha256Schema,
  installedApps: installedAppsSchema,
  safeConfigProjection: gateA3GearJobSafeConfigProjectionSchema,
  dynamicAuthority: gateA3GearJobDynamicRuntimeAuthoritySchema,
  dynamicAuthorityDigest: sha256Schema,
  gearjob: gearJobProjectionSchema,
  nestedApps: z.tuple([
    nestedAppProjection('frappe'), nestedAppProjection('erpnext'),
    nestedAppProjection('hrms'), nestedAppProjection('print_designer'),
  ]),
  sourceTrees: z.tuple([
    sourceTreeProjectionSchema.extend({
      name: z.literal('gearjob'), root: z.literal('/workspace/gearjob/gearjob'),
    }).strict(),
    sourceTreeProjectionSchema.extend({
      name: z.literal('frappe'), root: z.literal('/workspace/development/frappe-bench/apps/frappe/frappe'),
    }).strict(),
    sourceTreeProjectionSchema.extend({
      name: z.literal('erpnext'), root: z.literal('/workspace/development/frappe-bench/apps/erpnext/erpnext'),
    }).strict(),
    sourceTreeProjectionSchema.extend({
      name: z.literal('hrms'), root: z.literal('/workspace/development/frappe-bench/apps/hrms/hrms'),
    }).strict(),
    sourceTreeProjectionSchema.extend({
      name: z.literal('print_designer'),
      root: z.literal('/workspace/development/frappe-bench/apps/print_designer/print_designer'),
    }).strict(),
  ]),
  venvTree: venvTreeProjectionSchema,
  pythonDistributionInventory: pythonDistributionInventorySchema,
  pythonDistributionInventorySha256: sha256Schema,
  pythonStartupFiles: z.tuple([
    pythonStartupFileSchema.extend({ name: z.literal('_virtualenv.pth') }).strict(),
    pythonStartupFileSchema.extend({ name: z.literal('erpnext.pth') }).strict(),
    pythonStartupFileSchema.extend({ name: z.literal('frappe.pth') }).strict(),
    pythonStartupFileSchema.extend({ name: z.literal('gearjob.pth') }).strict(),
    pythonStartupFileSchema.extend({ name: z.literal('hrms.pth') }).strict(),
    pythonStartupFileSchema.extend({ name: z.literal('print_designer.pth') }).strict(),
  ]),
  pythonStartupFilesSha256: sha256Schema,
  runtimeTopology: gateA3GearJobRuntimeTopologySchema,
  runtimeTopologyDigest: sha256Schema,
  containerProjection: containerProjectionSchema,
}).strict().superRefine((authority, context) => {
  const issue = (path: PropertyKey[], message: string) => context.addIssue({ code: 'custom', path, message });
  const packages = authority.pythonDistributionInventory.packages;
  const sortedPackages = [...packages].sort((left, right) => left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version));
  if (JSON.stringify(packages) !== JSON.stringify(sortedPackages)
    || new Set(packages.map((entry) => entry.name)).size !== packages.length) {
    issue(['pythonDistributionInventory', 'packages'], 'Python distributions must be sorted and unique');
  }
  if (JSON.stringify(authority.installedApps) !== JSON.stringify(authority.dynamicAuthority.installedApps)) {
    issue(['dynamicAuthority', 'installedApps'], 'dynamic installed apps must match the full authority');
  }
  if (JSON.stringify(authority.safeConfigProjection) !== JSON.stringify(authority.dynamicAuthority.safeConfigProjection)) {
    issue(['dynamicAuthority', 'safeConfigProjection'], 'dynamic safe config must match the full authority');
  }
  if (authority.appsTxtSha256 !== authority.dynamicAuthority.appsTxtSha256) {
    issue(['dynamicAuthority', 'appsTxtSha256'], 'dynamic apps.txt digest must match the full authority');
  }
  if (authority.containerProjection.imageId !== authority.containerProjection.imageBuild.runtimeImageId
    || authority.containerProjection.imageId !== authority.dynamicAuthority.runtimeImageId) {
    issue(['containerProjection', 'imageId'], 'runtime image IDs must be cross-bound');
  }
  if (authority.runtimeTopology.peers[0].imageId !== authority.containerProjection.imageId) {
    issue(['runtimeTopology', 'peers', 0, 'imageId'], 'Frappe topology image ID must match the runtime image');
  }
  if (authority.runtimeTopologyDigest !== authority.dynamicAuthority.runtimeTopologyDigest) {
    issue(['runtimeTopologyDigest'], 'runtime topology digests must be cross-bound');
  }
  const labels = authority.containerProjection.imageLabels;
  if (labels['dev.geneway.gate-a3.gearjob-commit'] !== authority.gearjob.commit) {
    issue(['containerProjection', 'imageLabels'], 'GearJob commit label must match the authority');
  }
  const nestedLabelCommits = {
    frappe: labels['dev.geneway.gate-a3.frappe-commit'],
    erpnext: labels['dev.geneway.gate-a3.erpnext-commit'],
    hrms: labels['dev.geneway.gate-a3.hrms-commit'],
    print_designer: labels['dev.geneway.gate-a3.print-designer-commit'],
  };
  for (const app of authority.nestedApps) {
    if (nestedLabelCommits[app.app] !== app.commit) {
      issue(['containerProjection', 'imageLabels'], `${app.app} commit label must match the authority`);
    }
  }
  const trees = new Map(authority.sourceTrees.map((tree) => [tree.name, tree.treeSha256]));
  if (trees.get('gearjob') !== authority.gearjob.sourceTreeSha256) {
    issue(['gearjob', 'sourceTreeSha256'], 'GearJob source tree digest must match the source-tree projection');
  }
  for (const app of authority.nestedApps) {
    if (trees.get(app.app) !== app.sourceTreeSha256) {
      issue(['nestedApps'], `${app.app} source tree digest must match the source-tree projection`);
    }
  }
  const boundary = new Map(authority.gearjob.boundaryFileManifest.map((file) => [file.path, file.sha256]));
  if (boundary.get('deploy/Dockerfile.gate-a3-runtime') !== authority.containerProjection.imageBuild.dockerfileSha256) {
    issue(['containerProjection', 'imageBuild', 'dockerfileSha256'], 'Dockerfile digest must match the boundary manifest');
  }
  if (boundary.get('deploy/gate-a3-runtime-verify.py')
    !== authority.containerProjection.imageBuild.entrypointVerifierSha256) {
    issue(['containerProjection', 'imageBuild', 'entrypointVerifierSha256'],
      'entrypoint verifier digest must match the boundary manifest');
  }
});

export const gateA3GearJobRuntimeVerificationSchema = z.object({
  schemaVersion: z.literal('gearjob-gate-a3-runtime-verification/1'),
  runtimeAuthorityDigest: sha256Schema,
  runtimeImageId: dockerImageIdSchema,
  runtimeTopologyDigest: sha256Schema,
  verified: z.literal(true),
}).strict();

export const gateA3GearJobLiveVerificationSchema = z.object({
  schemaVersion: z.literal('gearjob-gate-a3-live-verification/1'),
  dynamicAuthorityDigest: sha256Schema,
  runtimeImageId: dockerImageIdSchema,
  runtimeTopologyDigest: sha256Schema,
  verified: z.literal(true),
}).strict();

export type GateA3GearJobRuntimeAuthority = z.infer<typeof gateA3GearJobRuntimeAuthoritySchema>;
export type GateA3GearJobDynamicRuntimeAuthority = z.infer<typeof gateA3GearJobDynamicRuntimeAuthoritySchema>;
export type GateA3GearJobRuntimeTopology = z.infer<typeof gateA3GearJobRuntimeTopologySchema>;
