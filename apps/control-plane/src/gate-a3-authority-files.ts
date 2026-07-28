import { constants } from 'node:fs';
import { createHash, verify as verifySignature } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isIPv4 } from 'node:net';
import { promisify } from 'node:util';
import { canonicalize } from 'json-canonicalize';
import { z } from 'zod';
import {
  gateA3AuthorityEnvelopeSchema,
  gateA3ControllerAdmissionArtifactSchema,
  gateA3GearJobLiveVerificationSchema,
  gateA3GearJobRuntimeVerificationSchema,
  gateA3GearJobRuntimeTopologySchema,
  gateA3InternalValidationAdmissionArtifactSchema,
  gateA3PreflightArtifactSchema,
  GATE_A3_LOCAL_ADMISSION_PUBLIC_KEY_PEM,
  type GateA3AuthorityEnvelope,
  type GateA3GearJobRuntimeTopology,
} from '@geneway/contracts';

const AUTHORITY_DIRECTORY = '/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp';
export const GATE_A3_AUTHORITY_FILES = Object.freeze({
  approvedPreflightFile: `${AUTHORITY_DIRECTORY}/gearjob-preflight.approved.json`,
  controllerAdmissionFile: `${AUTHORITY_DIRECTORY}/gearjob-preflight.controller-admission.json`,
  internalValidationAdmissionFile: `${AUTHORITY_DIRECTORY}/gate-a3-internal-validation.admission.json`,
});

const canonicalDigest = (value: unknown): string => createHash('sha256')
  .update(canonicalize(value), 'utf8').digest('hex');
const execFileAsync = promisify(execFile);
const dockerImageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const dockerObjectIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const dockerStringMapSchema = z.record(z.string(), z.string());
const dockerMountSchema = z.object({
  Type: z.string(), Source: z.string(), Destination: z.string(), RW: z.boolean(),
}).passthrough();
const dockerContainerInspectSchema = z.array(z.object({
  Id: dockerObjectIdSchema,
  Name: z.string(),
  Created: z.string().datetime(),
  Image: dockerImageIdSchema,
  RestartCount: z.number().int().nonnegative(),
  State: z.object({
    Running: z.boolean(), Status: z.string(), Paused: z.boolean(), Restarting: z.boolean(),
    OOMKilled: z.boolean(), Dead: z.boolean(), StartedAt: z.string().datetime(),
    Pid: z.number().int().positive(),
  }).passthrough(),
  Config: z.object({
    Image: dockerImageIdSchema,
    User: z.string(),
    Entrypoint: z.array(z.string()).nullable(),
    Cmd: z.array(z.string()).nullable(),
    WorkingDir: z.string(),
    Env: z.array(z.string()).nullable(),
    Labels: dockerStringMapSchema.nullable(),
  }).passthrough(),
  HostConfig: z.object({
    AutoRemove: z.boolean(),
    CapAdd: z.array(z.string()).nullable(),
    CapDrop: z.array(z.string()).nullable(),
    Devices: z.array(z.unknown()).nullable(),
    DeviceRequests: z.array(z.unknown()).nullable(),
    Dns: z.array(z.string()).nullable(),
    DnsOptions: z.array(z.string()).nullable(),
    DnsSearch: z.array(z.string()).nullable(),
    ExtraHosts: z.array(z.string()).nullable(),
    IpcMode: z.string(),
    NetworkMode: z.string(),
    PidMode: z.string(),
    Links: z.array(z.string()).nullable(),
    PortBindings: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() }).strict()).nullable()),
    Privileged: z.boolean(),
    PublishAllPorts: z.boolean(),
    ReadonlyRootfs: z.boolean(),
    RestartPolicy: z.object({ Name: z.string(), MaximumRetryCount: z.number().int() }).strict(),
    SecurityOpt: z.array(z.string()).nullable(),
    Tmpfs: z.record(z.string(), z.string()).nullable().optional(),
    UTSMode: z.string(),
  }).passthrough(),
  Mounts: z.array(dockerMountSchema),
  NetworkSettings: z.object({
    Networks: z.record(z.string(), z.object({
      NetworkID: dockerObjectIdSchema, IPAddress: z.string(), Aliases: z.array(z.string()).nullable(),
      DNSNames: z.array(z.string()).nullable(),
    }).passthrough()),
  }).passthrough(),
}).passthrough()).length(4);
const dockerImageInspectSchema = z.tuple([z.object({
  Id: dockerImageIdSchema,
  Config: z.object({ Env: z.array(z.string()).nullable(), Labels: dockerStringMapSchema.nullable() }).passthrough(),
}).passthrough()]);
const dockerNetworkInspectSchema = z.tuple([z.object({
  Name: z.string(), Id: dockerObjectIdSchema, Created: z.string().datetime({ offset: true }),
  Driver: z.string(), Internal: z.boolean(),
  Scope: z.string(), EnableIPv4: z.boolean(), EnableIPv6: z.boolean(),
  Attachable: z.boolean(), Ingress: z.boolean(), Options: dockerStringMapSchema,
  IPAM: z.object({
    Driver: z.string(), Options: dockerStringMapSchema.nullable(),
    Config: z.array(z.object({ Subnet: z.string(), Gateway: z.string() }).passthrough()),
  }).passthrough(),
  Containers: z.record(dockerObjectIdSchema, z.object({
    Name: z.string(), EndpointID: dockerObjectIdSchema, MacAddress: z.string(),
    IPv4Address: z.string(), IPv6Address: z.string(),
  }).passthrough()),
  Labels: dockerStringMapSchema,
}).passthrough()]);

const GATE_A3_RUNTIME_ENTRYPOINT = Object.freeze([
  '/home/frappe/.pyenv/versions/3.14.2/bin/python3', '-I', '-S',
  '/usr/local/libexec/gate-a3-runtime-verify.py',
]);
const GATE_A3_RUNTIME_COMMAND = Object.freeze([
  'serve', '--site', 'dev.localhost', '--port', '8100',
]);
const GATE_A3_RUNTIME_MOUNTS = Object.freeze([
  { Type: 'bind', Source: '/dev/null', Destination: '/home/frappe/.git-credentials', RW: false },
  { Type: 'bind', Source: '/dev/null', Destination: '/home/frappe/.gitconfig', RW: false },
  { Type: 'bind', Source: '/home/gewu/work/gearjob/development/frappe-bench/logs',
    Destination: '/workspace/development/frappe-bench/logs', RW: true },
  { Type: 'bind', Source: '/home/gewu/work/gearjob/development/frappe-bench/sites',
    Destination: '/workspace/development/frappe-bench/sites', RW: false },
  { Type: 'bind', Source: '/home/gewu/work/gearjob/development/frappe-bench/sites/dev.localhost/logs',
    Destination: '/workspace/development/frappe-bench/sites/dev.localhost/logs', RW: true },
]);
const GATE_A3_RUNTIME_TMPFS = Object.freeze({
  '/home/frappe/.cache': 'rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000',
  '/tmp': 'rw,noexec,nosuid,nodev,mode=1777',
  '/workspace/development/frappe-bench/sites/dev.localhost/locks':
    'rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000',
});
const GATE_A3_RUNTIME_DEV_LABELS = Object.freeze([
  'dev.geneway.gate-a3.base-image-id',
  'dev.geneway.gate-a3.source-clean-status-sha256',
  'dev.geneway.gate-a3.gearjob-commit',
  'dev.geneway.gate-a3.frappe-commit',
  'dev.geneway.gate-a3.erpnext-commit',
  'dev.geneway.gate-a3.hrms-commit',
  'dev.geneway.gate-a3.print-designer-commit',
]);

function expectedRuntimeTopology(envelope: GateA3AuthorityEnvelope): GateA3GearJobRuntimeTopology {
  const peer = (
    service: 'frappe' | 'mariadb' | 'redis-cache' | 'redis-queue',
    imageId: string,
    bindMounts: readonly Record<string, unknown>[] = [],
  ) => ({
    bindMounts,
    composeIdentity: { containerNumber: '1', oneoff: 'False', project: 'gearjob_dev', service },
    containerName: `gearjob_dev-${service}-1`,
    dns: [], dnsOptions: [], dnsSearch: [], extraHosts: [], imageId, links: [],
    networkAliases: [`gearjob_dev-${service}-1`, service],
    publishAllPorts: false, publishedPorts: [],
  });
  return gateA3GearJobRuntimeTopologySchema.parse({
    schemaVersion: 'gearjob-gate-a3-runtime-topology/1',
    projectName: 'gearjob_dev',
    network: {
      name: 'gearjob_dev_gate-a3-internal', driver: 'bridge', scope: 'local', internal: true,
      attachable: false, ingress: false, enableIPv4: true, enableIPv6: false,
      ipam: {
        driver: 'default', options: {},
        config: [{ subnet: '192.168.32.0/20', gateway: '192.168.32.1' }],
      },
      options: {},
    },
    peers: [
      peer('frappe', envelope.runtimeImageId, [
        { source: '/dev/null', destination: '/home/frappe/.git-credentials', readOnly: true,
          sourceKind: 'character-device' },
        { source: '/dev/null', destination: '/home/frappe/.gitconfig', readOnly: true,
          sourceKind: 'character-device' },
        { source: '/home/gewu/work/gearjob/development/frappe-bench/logs',
          destination: '/workspace/development/frappe-bench/logs', readOnly: false, sourceKind: 'directory' },
        { source: '/home/gewu/work/gearjob/development/frappe-bench/sites',
          destination: '/workspace/development/frappe-bench/sites', readOnly: true, sourceKind: 'directory' },
        { source: '/home/gewu/work/gearjob/development/frappe-bench/sites/dev.localhost/logs',
          destination: '/workspace/development/frappe-bench/sites/dev.localhost/logs', readOnly: false,
          sourceKind: 'directory' },
      ]),
      peer('mariadb', 'sha256:78a5047d3ba33975f183f183c2464cc7f1eab13ec8667e57cc9a5821d6da7577'),
      peer('redis-cache', 'sha256:d146f83b1e0f02fc27c26a50cee39338c736674c5959db84363e6ae3cd9e02d2'),
      peer('redis-queue', 'sha256:d146f83b1e0f02fc27c26a50cee39338c736674c5959db84363e6ae3cd9e02d2'),
    ],
  });
}

type GateA3BindSourceIdentity = Readonly<{
  source: string;
  destination: string;
  realPath: string;
  device: number;
  inode: number;
  mode: number;
  specialDevice: number;
}>;

export async function inspectGateA3BoundSourceIdentity(input: Readonly<{
  source: string;
  destination: string;
  sourceKind: 'directory' | 'character-device';
  containerPid: number;
  expected?: GateA3BindSourceIdentity | undefined;
}>): Promise<GateA3BindSourceIdentity> {
  if (!isAbsolute(input.source) || !isAbsolute(input.destination) || !Number.isInteger(input.containerPid)
    || input.containerPid <= 0) throw new Error('Gate A.3 bind-source identity input is invalid');
  const before = await lstat(input.source);
  const resolved = await realpath(input.source);
  const after = await lstat(input.source);
  if (before.isSymbolicLink() || resolved !== input.source
    || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
    || before.rdev !== after.rdev
    || (input.sourceKind === 'directory' ? !after.isDirectory() : !after.isCharacterDevice())) {
    throw new Error('Gate A.3 bind source changed or does not have the admitted identity');
  }
  const mounted = await lstat(`/proc/${String(input.containerPid)}/root${input.destination}`);
  if (mounted.dev !== after.dev || mounted.ino !== after.ino || mounted.mode !== after.mode
    || mounted.rdev !== after.rdev) {
    throw new Error('Gate A.3 bind mount is not attached to the admitted host inode');
  }
  const identity = {
    source: input.source, destination: input.destination, realPath: resolved,
    device: after.dev, inode: after.ino, mode: after.mode, specialDevice: after.rdev,
  };
  if (input.expected !== undefined) assertCanonicalEqual(identity, input.expected,
    `Gate A.3 bind source ${input.destination}`);
  return identity;
}

type GateA3RuntimeInstance = Readonly<{
  bindSourceIdentities: readonly GateA3BindSourceIdentity[];
  containerIds: Readonly<Record<'frappe' | 'mariadb' | 'redis-cache' | 'redis-queue', string>>;
  containerGenerations: Readonly<Record<string, Readonly<{
    composeConfigHash: string; created: string; restartCount: number; startedAt: string;
  }>>>;
  internalAddress: string;
  networkCreated: string;
  networkId: string;
}>;

async function execDocker(args: string[], timeout: number, label: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('/usr/bin/docker', args, {
      encoding: 'utf8', maxBuffer: 64 * 1_024, timeout, killSignal: 'SIGKILL',
      env: { DOCKER_HOST: 'unix:///var/run/docker.sock', PATH: '/usr/bin:/bin' },
    });
    if (stderr !== '') throw new Error('stderr');
    return stdout;
  } catch {
    throw new Error(`${label} failed closed`);
  }
}

function parseEnvironment(values: string[] | null, label: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const entry of values ?? []) {
    const delimiter = entry.indexOf('=');
    if (delimiter <= 0) throw new Error(`${label} contains a malformed environment entry`);
    const key = entry.slice(0, delimiter);
    if (parsed.has(key)) throw new Error(`${label} contains a duplicate environment key`);
    parsed.set(key, entry.slice(delimiter + 1));
  }
  return parsed;
}

function assertCanonicalEqual(actual: unknown, expected: unknown, label: string): void {
  if (canonicalize(actual) !== canonicalize(expected)) throw new Error(`${label} drifted`);
}

function assertRuntimeLabels(
  labels: Readonly<Record<string, string>>,
  envelope: GateA3AuthorityEnvelope,
  label: string,
): void {
  const actualKeys = Object.keys(labels).filter((key) => key.startsWith('dev.geneway.gate-a3.')).sort();
  assertCanonicalEqual(actualKeys, [...GATE_A3_RUNTIME_DEV_LABELS].sort(), `${label} Gate A.3 label keys`);
  if (labels['dev.geneway.gate-a3.base-image-id']
      !== 'sha256:6b3f4e4816d81250699d4245be454c84ce2144899e5dd7c90384c49898ebbf5f'
    || labels['dev.geneway.gate-a3.source-clean-status-sha256']
      !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    || labels['dev.geneway.gate-a3.gearjob-commit'] !== envelope.gearjobCommit
    || GATE_A3_RUNTIME_DEV_LABELS.slice(3).some((key) => !/^[a-f0-9]{40}$/u.test(labels[key] ?? ''))) {
    throw new Error(`${label} provenance labels drifted`);
  }
}

async function inspectRuntimeInstance(
  envelope: GateA3AuthorityEnvelope,
  imageEnvironment: Map<string, string>,
  expected?: GateA3RuntimeInstance,
): Promise<GateA3RuntimeInstance> {
  const topology = expectedRuntimeTopology(envelope);
  const selectedOutput = await execDocker([
    'ps', '--no-trunc', '--filter', `label=com.docker.compose.project=${topology.projectName}`,
    '--filter', 'status=running', '--format', '{{.ID}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.container-number"}}',
  ], 500, 'Gate A.3 runtime topology selection');
  const selected = new Map<string, string>();
  for (const line of selectedOutput.trim().split('\n').filter(Boolean)) {
    const [containerId, service, number, ...extra] = line.split('\t');
    if (extra.length !== 0 || number !== '1' || service === undefined || containerId === undefined
      || !dockerObjectIdSchema.safeParse(containerId).success || selected.has(service)) {
      throw new Error('Gate A.3 runtime topology selection is not unique and exact');
    }
    selected.set(service, containerId);
  }
  const expectedServices = topology.peers.map((peer) => peer.composeIdentity.service);
  assertCanonicalEqual([...selected.keys()].sort(), [...expectedServices].sort(),
    'Gate A.3 runtime peer services');
  const selectedIds = topology.peers.map((peer) => selected.get(peer.composeIdentity.service) ?? '');
  const inspectedContainers = dockerContainerInspectSchema.parse(JSON.parse(await execDocker(
    ['inspect', '--type', 'container', ...selectedIds], 650, 'Gate A.3 runtime peer inspect',
  )));
  const byService = new Map(inspectedContainers.map((container) => [
    container.Config.Labels?.['com.docker.compose.service'] ?? '', container,
  ]));
  const containerIds = {} as Record<typeof expectedServices[number], string>;
  const containerGenerations: Record<string, {
    composeConfigHash: string; created: string; restartCount: number; startedAt: string;
  }> = {};
  let networkId = '';
  let internalAddress = '';
  let frappePid = 0;
  for (const peer of topology.peers) {
    const service = peer.composeIdentity.service;
    const inspected = byService.get(service);
    const containerId = selected.get(service);
    if (inspected === undefined || containerId === undefined) {
      throw new Error(`Gate A.3 runtime peer ${service} is missing`);
    }
    const labels = inspected.Config.Labels ?? {};
    const composeConfigHash = labels['com.docker.compose.config-hash'] ?? '';
    const networks = Object.entries(inspected.NetworkSettings.Networks);
    const attachment = networks[0]?.[1];
    const peerNetworkId = attachment?.NetworkID ?? '';
    const peerAddress = attachment?.IPAddress ?? '';
    if (inspected.Id !== containerId || inspected.Name !== `/${peer.containerName}`
      || inspected.Image !== peer.imageId || inspected.Config.Image !== peer.imageId
      || !inspected.State.Running || inspected.State.Status !== 'running' || inspected.State.Paused
      || inspected.State.Restarting || inspected.State.OOMKilled || inspected.State.Dead
      || labels['com.docker.compose.project'] !== peer.composeIdentity.project
      || labels['com.docker.compose.service'] !== service
      || labels['com.docker.compose.container-number'] !== peer.composeIdentity.containerNumber
      || labels['com.docker.compose.oneoff'] !== peer.composeIdentity.oneoff
      || !/^[a-f0-9]{64}$/u.test(composeConfigHash)
      || inspected.HostConfig.AutoRemove || inspected.HostConfig.Privileged
      || inspected.HostConfig.NetworkMode !== topology.network.name
      || networks.length !== 1 || networks[0]?.[0] !== topology.network.name
      || !dockerObjectIdSchema.safeParse(peerNetworkId).success || !isIPv4(peerAddress)) {
      throw new Error(`Gate A.3 runtime peer ${service} authority drifted`);
    }
    assertCanonicalEqual(attachment?.Aliases ?? [], peer.networkAliases,
      `Gate A.3 runtime peer ${service} network aliases`);
    assertCanonicalEqual(inspected.HostConfig.PortBindings, {},
      `Gate A.3 runtime peer ${service} published ports`);
    assertCanonicalEqual(inspected.HostConfig.PublishAllPorts, peer.publishAllPorts,
      `Gate A.3 runtime peer ${service} publish-all-ports`);
    assertCanonicalEqual(inspected.HostConfig.Dns ?? [], peer.dns, `Gate A.3 runtime peer ${service} DNS`);
    assertCanonicalEqual(inspected.HostConfig.DnsOptions ?? [], peer.dnsOptions,
      `Gate A.3 runtime peer ${service} DNS options`);
    assertCanonicalEqual(inspected.HostConfig.DnsSearch ?? [], peer.dnsSearch,
      `Gate A.3 runtime peer ${service} DNS search`);
    assertCanonicalEqual(inspected.HostConfig.ExtraHosts ?? [], peer.extraHosts,
      `Gate A.3 runtime peer ${service} extra hosts`);
    assertCanonicalEqual(inspected.HostConfig.Links ?? [], peer.links, `Gate A.3 runtime peer ${service} links`);
    if (networkId !== '' && networkId !== peerNetworkId) {
      throw new Error('Gate A.3 runtime peers do not share one exact network');
    }
    networkId = peerNetworkId;
    containerIds[service] = containerId;
    containerGenerations[service] = {
      composeConfigHash, created: inspected.Created, restartCount: inspected.RestartCount,
      startedAt: inspected.State.StartedAt,
    };
    if (service === 'frappe') {
      frappePid = inspected.State.Pid;
      internalAddress = peerAddress;
      if (inspected.Config.User !== '1000:1000'
        || inspected.Config.WorkingDir !== '/workspace/development/frappe-bench/sites'
        || !inspected.HostConfig.ReadonlyRootfs || inspected.HostConfig.CapAdd !== null
        || (inspected.HostConfig.Devices ?? []).length !== 0
        || (inspected.HostConfig.DeviceRequests ?? []).length !== 0
        || inspected.HostConfig.IpcMode !== 'private'
        || inspected.HostConfig.PidMode !== '' || inspected.HostConfig.UTSMode !== '') {
        throw new Error('Gate A.3 Frappe runtime container authority drifted');
      }
      assertCanonicalEqual(inspected.Config.Entrypoint, GATE_A3_RUNTIME_ENTRYPOINT,
        'Gate A.3 runtime entrypoint');
      assertCanonicalEqual(inspected.Config.Cmd, GATE_A3_RUNTIME_COMMAND, 'Gate A.3 runtime command');
      assertCanonicalEqual(inspected.HostConfig.CapDrop, ['ALL'], 'Gate A.3 runtime capability drop');
      assertCanonicalEqual(inspected.HostConfig.SecurityOpt, ['no-new-privileges:true'],
        'Gate A.3 runtime security options');
      assertCanonicalEqual(inspected.HostConfig.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 },
        'Gate A.3 runtime restart policy');
      assertCanonicalEqual(inspected.HostConfig.Tmpfs, GATE_A3_RUNTIME_TMPFS, 'Gate A.3 runtime tmpfs');
      assertCanonicalEqual(inspected.Mounts.map(({ Type, Source, Destination, RW }) => ({
        Type, Source, Destination, RW,
      })).sort((left, right) => left.Destination.localeCompare(right.Destination)), GATE_A3_RUNTIME_MOUNTS,
      'Gate A.3 runtime mounts');
      assertRuntimeLabels(labels, envelope, 'Gate A.3 runtime container');
      const expectedEnvironment = new Map(imageEnvironment);
      for (const [key, value] of Object.entries({
        SHELL: '/bin/bash',
        GENEWAY_GATE_A3_RUNTIME_AUTHORITY_SHA256: envelope.runtimeAuthorityDigest,
        GENEWAY_GATE_A3_DYNAMIC_AUTHORITY_SHA256: envelope.dynamicAuthorityDigest,
        GENEWAY_GATE_A3_RUNTIME_IMAGE_ID: envelope.runtimeImageId,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
      })) expectedEnvironment.set(key, value);
      assertCanonicalEqual(Object.fromEntries(parseEnvironment(inspected.Config.Env, 'Gate A.3 runtime container')),
        Object.fromEntries(expectedEnvironment), 'Gate A.3 runtime environment');
    }
  }
  const network = dockerNetworkInspectSchema.parse(JSON.parse(await execDocker(
    ['network', 'inspect', networkId], 400, 'Gate A.3 runtime network inspect',
  )))[0];
  const actualNetworkProjection = {
    name: network.Name, driver: network.Driver, scope: network.Scope, internal: network.Internal,
    attachable: network.Attachable, ingress: network.Ingress, enableIPv4: network.EnableIPv4,
    enableIPv6: network.EnableIPv6,
    ipam: {
      driver: network.IPAM.Driver, options: network.IPAM.Options ?? {},
      config: network.IPAM.Config.map((config) => ({ subnet: config.Subnet, gateway: config.Gateway })),
    },
    options: network.Options,
  };
  if (network.Id !== networkId) throw new Error('Gate A.3 runtime network ID drifted');
  assertCanonicalEqual(actualNetworkProjection, topology.network, 'Gate A.3 runtime network topology');
  const expectedNetworkLabelKeys = [
    'com.docker.compose.config-hash', 'com.docker.compose.network',
    'com.docker.compose.project', 'com.docker.compose.version',
  ];
  assertCanonicalEqual(Object.keys(network.Labels).sort(), expectedNetworkLabelKeys.sort(),
    'Gate A.3 runtime network label keys');
  if (!/^[a-f0-9]{64}$/u.test(network.Labels['com.docker.compose.config-hash'] ?? '')
    || network.Labels['com.docker.compose.network'] !== 'gate-a3-internal'
    || network.Labels['com.docker.compose.project'] !== topology.projectName
    || !/^\d+\.\d+\.\d+$/u.test(network.Labels['com.docker.compose.version'] ?? '')) {
    throw new Error('Gate A.3 runtime network Compose identity drifted');
  }
  assertCanonicalEqual(Object.keys(network.Containers).sort(), Object.values(containerIds).sort(),
    'Gate A.3 runtime network peer IDs');
  for (const peer of topology.peers) {
    const service = peer.composeIdentity.service;
    const containerId = containerIds[service];
    const inspected = byService.get(service);
    const networkPeer = network.Containers[containerId];
    const ipAddress = inspected?.NetworkSettings.Networks[topology.network.name]?.IPAddress ?? '';
    if (networkPeer === undefined || networkPeer.Name !== peer.containerName
      || !dockerObjectIdSchema.safeParse(networkPeer.EndpointID).success
      || !/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(networkPeer.MacAddress)
      || networkPeer.IPv4Address !== `${ipAddress}/20` || networkPeer.IPv6Address !== '') {
      throw new Error(`Gate A.3 runtime network peer ${service} drifted`);
    }
  }
  const expectedBindIdentities = new Map((expected?.bindSourceIdentities ?? [])
    .map((identity) => [identity.destination, identity]));
  const bindSourceIdentities = await Promise.all(topology.peers[0].bindMounts.map((mount) =>
    inspectGateA3BoundSourceIdentity({
      source: mount.source, destination: mount.destination, sourceKind: mount.sourceKind,
      containerPid: frappePid, expected: expectedBindIdentities.get(mount.destination),
    })));
  const instance = {
    bindSourceIdentities, containerIds, containerGenerations, internalAddress,
    networkCreated: network.Created, networkId,
  };
  if (expected !== undefined) assertCanonicalEqual(instance, expected, 'Gate A.3 runtime topology generation');
  return instance;
}

export type GateA3GearJobRuntimeVerifier = Readonly<{
  containerId: string;
  internalAddress: string;
  assertLive: () => Promise<void>;
}>;

export async function createGateA3GearJobRuntimeVerifier(
  envelope: GateA3AuthorityEnvelope,
): Promise<GateA3GearJobRuntimeVerifier> {
  gateA3AuthorityEnvelopeSchema.parse(envelope);
  const image = dockerImageInspectSchema.parse(JSON.parse(await execDocker(
    ['image', 'inspect', envelope.runtimeImageId], 500, 'Gate A.3 runtime image inspect',
  )))[0];
  if (image.Id !== envelope.runtimeImageId) throw new Error('Gate A.3 runtime image identity drifted');
  assertRuntimeLabels(image.Config.Labels ?? {}, envelope, 'Gate A.3 runtime image');
  const imageEnvironment = parseEnvironment(image.Config.Env, 'Gate A.3 runtime image');
  const instance = await inspectRuntimeInstance(envelope, imageEnvironment);
  const containerId = instance.containerIds.frappe;
  const runtimeTopologyDigest = canonicalDigest(expectedRuntimeTopology(envelope));
  const full = gateA3GearJobRuntimeVerificationSchema.parse(JSON.parse(await execDocker([
    'exec', containerId, ...GATE_A3_RUNTIME_ENTRYPOINT, 'verify',
  ], 1_800, 'Gate A.3 full runtime verification')));
  if (full.runtimeAuthorityDigest !== envelope.runtimeAuthorityDigest
    || full.runtimeImageId !== envelope.runtimeImageId
    || full.runtimeTopologyDigest !== runtimeTopologyDigest) {
    throw new Error('Gate A.3 full runtime verification is not bound to the authority envelope');
  }
  return {
    containerId,
    internalAddress: instance.internalAddress,
    assertLive: async () => {
      await inspectRuntimeInstance(envelope, imageEnvironment, instance);
      const live = gateA3GearJobLiveVerificationSchema.parse(JSON.parse(await execDocker([
        'exec', containerId, ...GATE_A3_RUNTIME_ENTRYPOINT, 'verify-live',
      ], 650, 'Gate A.3 live runtime verification')));
      if (live.dynamicAuthorityDigest !== envelope.dynamicAuthorityDigest
        || live.runtimeImageId !== envelope.runtimeImageId
        || live.runtimeTopologyDigest !== runtimeTopologyDigest) {
        throw new Error('Gate A.3 live runtime verification is not bound to the authority envelope');
      }
    },
  };
}

export function verifyGateA3InternalAdmissionSignature(value: unknown): boolean {
  try {
    const internal = gateA3InternalValidationAdmissionArtifactSchema.parse(value);
    const signed = structuredClone(internal);
    Reflect.deleteProperty(signed.integrity, 'canonical_sha256');
    const signature = signed.admission_signature.signature;
    Reflect.deleteProperty(signed.admission_signature, 'signature');
    return verifySignature(null, Buffer.from(canonicalize(signed), 'utf8'),
      GATE_A3_LOCAL_ADMISSION_PUBLIC_KEY_PEM, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

function deriveEnvelope(input: Readonly<{
  preflight: unknown;
  controllerAdmission: unknown;
  internalValidationAdmission: unknown;
  now: Date;
}>): GateA3AuthorityEnvelope {
  const preflight = gateA3PreflightArtifactSchema.parse(input.preflight);
  const controller = gateA3ControllerAdmissionArtifactSchema.parse(input.controllerAdmission);
  const internal = gateA3InternalValidationAdmissionArtifactSchema.parse(input.internalValidationAdmission);
  if (!verifyGateA3InternalAdmissionSignature(internal)) {
    throw new Error('Gate A.3 internal-validation admission signature is not trusted');
  }
  const preflightDigestInput = structuredClone(preflight);
  Reflect.deleteProperty(preflightDigestInput.integrity, 'canonical_sha256');
  preflightDigestInput.release_admission.required_tuple.approvedPreflightDigest = 'TO_BE_FILLED';
  const approvedPreflightDigest = canonicalDigest(preflightDigestInput);
  const controllerDigest = canonicalDigest(controller);
  const internalDigestInput = structuredClone(internal);
  Reflect.deleteProperty(internalDigestInput.integrity, 'canonical_sha256');
  const internalDigest = canonicalDigest(internalDigestInput);
  if (approvedPreflightDigest !== preflight.integrity.canonical_sha256
    || approvedPreflightDigest !== preflight.release_admission.required_tuple.approvedPreflightDigest) {
    throw new Error('Gate A.3 approved preflight canonical authority does not match');
  }
  if (internalDigest !== internal.integrity.canonical_sha256) {
    throw new Error('Gate A.3 internal-validation admission canonical authority does not match');
  }
  const tuple = preflight.release_admission.required_tuple;
  const runtimeAuthorityDigest = canonicalDigest(preflight.runtime_authority);
  const dynamicAuthorityDigest = canonicalDigest(preflight.runtime_authority.dynamicAuthority);
  const runtimeTopologyDigest = canonicalDigest(preflight.runtime_authority.runtimeTopology);
  const runtimeImageId = preflight.runtime_authority.containerProjection.imageId;
  if (runtimeAuthorityDigest !== preflight.runtime_authority_digest
    || dynamicAuthorityDigest !== preflight.runtime_authority.dynamicAuthorityDigest
    || runtimeTopologyDigest !== preflight.runtime_authority.runtimeTopologyDigest
    || runtimeTopologyDigest !== preflight.runtime_authority.dynamicAuthority.runtimeTopologyDigest
    || canonicalDigest(preflight.runtime_authority.pythonDistributionInventory)
      !== preflight.runtime_authority.pythonDistributionInventorySha256
    || canonicalDigest(preflight.runtime_authority.pythonStartupFiles)
      !== preflight.runtime_authority.pythonStartupFilesSha256
    || preflight.verification.gearjob_commit !== preflight.runtime_authority.gearjob.commit
    || tuple.runtimeAuthorityDigest !== runtimeAuthorityDigest
    || tuple.dynamicAuthorityDigest !== dynamicAuthorityDigest
    || tuple.runtimeImageId !== runtimeImageId) {
    throw new Error('Gate A.3 preflight runtime authority is not canonically cross-bound');
  }
  if (controller.required_tuple.gearjob_commit !== preflight.verification.gearjob_commit
    || controller.required_tuple.approved_preflight_digest !== approvedPreflightDigest
    || controller.required_tuple.connector_profile_version !== tuple.connectorProfileVersion
    || controller.required_tuple.field_mask_version !== tuple.fieldMaskVersion
    || controller.required_tuple.invocation_token_schema_version !== tuple.invocationTokenSchemaVersion
    || controller.required_tuple.response_schema_version !== tuple.responseSchemaVersion
    || controller.required_tuple.card_schema_version !== tuple.cardSchemaVersion
    || controller.required_tuple.runtime_authority_digest !== runtimeAuthorityDigest
    || controller.required_tuple.dynamic_authority_digest !== dynamicAuthorityDigest
    || controller.required_tuple.runtime_image_id !== runtimeImageId
    || internal.required_tuple.approved_preflight_digest !== approvedPreflightDigest
    || internal.required_tuple.preflight_controller_admission_digest !== controllerDigest
    || internal.required_tuple.gearjob_commit !== preflight.verification.gearjob_commit
    || internal.required_tuple.runtime_authority_digest !== runtimeAuthorityDigest
    || internal.required_tuple.dynamic_authority_digest !== dynamicAuthorityDigest
    || internal.required_tuple.runtime_image_id !== runtimeImageId) {
    throw new Error('Gate A.3 authority tuple is not cross-bound');
  }
  const effectiveAtMs = Math.max(Date.parse(preflight.approved_at), Date.parse(controller.decided_at), Date.parse(internal.decided_at));
  const expiresAtMs = Math.min(Date.parse(preflight.expires_at), Date.parse(internal.expires_at));
  if (!Number.isFinite(effectiveAtMs) || !Number.isFinite(expiresAtMs)
    || effectiveAtMs > input.now.getTime() || expiresAtMs <= input.now.getTime() || effectiveAtMs >= expiresAtMs) {
    throw new Error('Gate A.3 authority envelope is not currently effective');
  }
  const body = {
    schemaVersion: 'gate-a3-authority-envelope/1' as const,
    capabilityId: 'production.work-order-status.v1' as const,
    environmentClass: 'isolated-local-development' as const,
    productionAuthority: false as const,
    artifactId: preflight.artifact_id,
    approvedPreflightDigest,
    preflightControllerAdmissionDigest: controllerDigest,
    internalValidationAdmissionDigest: internalDigest,
    renewalOfInternalAdmissionDigest: internal.renewal_of ?? null,
    gearjobCommit: preflight.verification.gearjob_commit,
    runtimeAuthorityDigest,
    dynamicAuthorityDigest,
    runtimeImageId,
    connectorProfileVersion: tuple.connectorProfileVersion,
    endpointMethodAllowlistDigest: preflight.target_site_and_endpoint.endpoint_method_allowlist_digest,
    fieldMaskVersion: tuple.fieldMaskVersion,
    fieldMaskDigest: preflight.strict_request_response_and_field_mask.field_mask.digest,
    invocationTokenSchemaVersion: tuple.invocationTokenSchemaVersion,
    responseSchemaVersion: tuple.responseSchemaVersion,
    cardSchemaVersion: tuple.cardSchemaVersion,
    effectiveAt: new Date(effectiveAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  return gateA3AuthorityEnvelopeSchema.parse({ ...body, authorityDigest: canonicalDigest(body) });
}

async function readOwnedAuthorityJson(filePath: string, label: string): Promise<unknown> {
  if (!isAbsolute(filePath)) throw new Error(`${label} path must be absolute`);
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.()
    || (before.mode & 0o777) !== 0o600 || before.size < 2 || before.size > 256 * 1_024) {
    throw new Error(`${label} must be an owned regular 0600 file`);
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed while opening`);
    const contents = await handle.readFile('utf8');
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed while reading`);
    }
    return JSON.parse(contents) as unknown;
  } finally {
    await handle.close();
  }
}

export async function readGateA3AuthorityEnvelopeFromFiles(input: Readonly<{
  approvedPreflightFile: string;
  controllerAdmissionFile: string;
  internalValidationAdmissionFile: string;
  now?: Date;
}>): Promise<GateA3AuthorityEnvelope> {
  if (input.approvedPreflightFile !== GATE_A3_AUTHORITY_FILES.approvedPreflightFile
    || input.controllerAdmissionFile !== GATE_A3_AUTHORITY_FILES.controllerAdmissionFile
    || input.internalValidationAdmissionFile !== GATE_A3_AUTHORITY_FILES.internalValidationAdmissionFile) {
    throw new Error('Gate A.3 authority must use the canonical current artifact paths');
  }
  const [preflight, controllerAdmission, internalValidationAdmission] = await Promise.all([
    readOwnedAuthorityJson(input.approvedPreflightFile, 'Gate A.3 approved preflight'),
    readOwnedAuthorityJson(input.controllerAdmissionFile, 'Gate A.3 controller admission'),
    readOwnedAuthorityJson(input.internalValidationAdmissionFile, 'Gate A.3 internal-validation admission'),
  ]);
  return deriveEnvelope({
    preflight,
    controllerAdmission,
    internalValidationAdmission,
    now: input.now ?? new Date(),
  });
}
