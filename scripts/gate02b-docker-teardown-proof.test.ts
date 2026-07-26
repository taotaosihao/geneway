import { describe, expect, it } from 'vitest';

interface Receipt { checked: boolean; passed: boolean; reason: string; targetNetwork?: { id: string; name: string };
  disconnectedNetworks?: Array<{ id: string; name: string }> }
interface ProofModule { dockerTeardownProofReceipt: (input: unknown) => Receipt }

// @ts-expect-error Native ESM helper is intentionally consumed through the contract above.
const proof = await import('./gate02b-docker-teardown-proof.mjs') as unknown as ProofModule;

const containerId = 'a'.repeat(64);
const otherContainerId = 'b'.repeat(64);
const storageNetworkId = 'c'.repeat(64);
const defaultNetworkId = 'd'.repeat(64);
const project = 'geneway-storage-v8-31';
const container = { id: containerId, name: `${project}-storage-adapter-1`, project, service: 'storage-adapter' };
const manifest = {
  schemaVersion: 'geneway-gate02b-storage-invocation/1', project,
  networks: { default: `${project}_default`, storage: `${project}_storage` },
  services: [
    { name: 'postgres', network: 'default', stem: `${project}-postgres` },
    { name: 'storage-adapter', network: 'storage', stem: `${project}-storage-adapter` },
  ],
  runtimeServices: [
    { name: 'storage-adapter', network: 'storage' },
    { name: 'storage-reconciler', network: 'default' },
    { name: 'storage-provisioner', network: 'storage' },
  ],
};
const networks = [
  { id: storageNetworkId, name: `${project}_storage`, project, inspectObserved: true, internal: true,
    driver: 'bridge', identityConflict: false },
  { id: defaultNetworkId, name: `${project}_default`, project, inspectObserved: true, internal: true,
    driver: 'bridge', identityConflict: false },
];

function event(sequence: number, type: 'container' | 'network', action: string, overrides: Record<string, unknown> = {}) {
  const network = type === 'network';
  return {
    sequence, timeNano: String(1784790123456789000n + BigInt(sequence)), type, action,
    actorId: network ? storageNetworkId : containerId,
    containerId: network && ['create', 'destroy'].includes(action) ? null : containerId,
    containerName: network && ['create', 'destroy'].includes(action) ? null : container.name,
    networkId: network ? storageNetworkId : null,
    networkName: network ? `${project}_storage` : null,
    name: network ? `${project}_storage` : container.name,
    project,
    ...overrides,
  };
}

function validEvents() {
  return [
    event(1, 'container', 'create'),
    event(2, 'network', 'connect'),
    event(3, 'container', 'start'),
    event(4, 'network', 'disconnect'),
    event(5, 'container', 'die'),
    event(6, 'container', 'destroy'),
    event(7, 'network', 'destroy', { containerId: null, containerName: null }),
  ];
}

function proxyReceipt(overrides: Record<string, unknown> = {}) {
  const target = { containerId, project, service: container.service, networkId: storageNetworkId,
    networkName: `${project}_storage` };
  return { intrinsicValid: true, target, finalBinding: { ...target, running: true },
    rawGuard: { passed: true, unexpected: [], unknownLines: [] }, ...overrides };
}

function run(overrides: Record<string, unknown> = {}) {
  return proof.dockerTeardownProofReceipt({ container, lifecycleEvents: validEvents(), inspectedNetworks: networks,
    invocationManifest: manifest, ...overrides });
}

describe('Gate 0.2B exact Docker teardown proof', () => {
  it('accepts disconnect < die < destroy with an exact inspected target network', () => {
    expect(run()).toMatchObject({ passed: true, reason: 'ORDERED_DOCKER_TEARDOWN_PROVEN',
      targetNetwork: { id: storageNetworkId, name: `${project}_storage` },
      disconnectedNetworks: [{ id: storageNetworkId, name: `${project}_storage` }] });
  });

  it('accepts Docker network events whose exact container and network IDs are present without optional name/project attributes', () => {
    const lifecycleEvents = validEvents().map((item) => item.type === 'network'
      ? { ...item, containerName: null, project: null } : item);
    expect(run({ lifecycleEvents })).toMatchObject({ passed: true, reason: 'ORDERED_DOCKER_TEARDOWN_PROVEN' });
  });

  it('accepts a non-proxy runtime service only when its manifest target has the complete teardown chain', () => {
    const reconciler = { ...container, name: `${project}-storage-reconciler-1`, service: 'storage-reconciler' };
    const lifecycleEvents = [
      event(1, 'network', 'disconnect', { actorId: defaultNetworkId, networkId: defaultNetworkId,
        networkName: `${project}_default`, containerName: null, project: null }),
      event(2, 'container', 'die', { containerName: reconciler.name }),
      event(3, 'container', 'destroy', { containerName: reconciler.name }),
    ];
    expect(proof.dockerTeardownProofReceipt({ container: reconciler, lifecycleEvents,
      inspectedNetworks: networks, invocationManifest: manifest, proxyBacked: false }))
      .toMatchObject({ passed: true, targetNetwork: { id: defaultNetworkId, name: `${project}_default` } });
  });

  it('accepts an exact backup project manifest only for its postgres or versitygw default network', () => {
    const backupProject = 'geneway-br-source-abc123';
    const backupContainer = { ...container, name: `${backupProject}-postgres-1`, project: backupProject, service: 'postgres' };
    const backupNetworkId = 'e'.repeat(64);
    const backupManifest = {
      schemaVersion: 'geneway-gate02b-backup-invocation/1',
      projects: [backupProject, 'geneway-br-target-abc123'],
      networks: [`${backupProject}_default`, 'geneway-br-target-abc123_default'],
    };
    const lifecycleEvents = [
      event(1, 'network', 'disconnect', { actorId: backupNetworkId, networkId: backupNetworkId,
        networkName: `${backupProject}_default`, containerName: backupContainer.name, project: backupProject }),
      event(2, 'container', 'die', { containerName: backupContainer.name, project: backupProject }),
      event(3, 'container', 'destroy', { containerName: backupContainer.name, project: backupProject }),
    ];
    expect(proof.dockerTeardownProofReceipt({ container: backupContainer, lifecycleEvents,
      inspectedNetworks: [{ id: backupNetworkId, name: `${backupProject}_default`, project: backupProject,
        inspectObserved: true, internal: true, driver: 'bridge', identityConflict: false }],
      invocationManifest: backupManifest, proxyBacked: false }))
      .toMatchObject({ passed: true, targetNetwork: { id: backupNetworkId, name: `${backupProject}_default` } });
  });

  it('accepts proxy-backed teardown only with intrinsically valid, correlated final and raw receipts', () => {
    expect(run({ proxyBacked: true, proxyReceipt: proxyReceipt() })).toMatchObject({ passed: true, proxyBacked: true });
  });

  it.each([
    ['short container ID', { container: { ...container, id: 'abc' } }, 'CONTAINER_IDENTITY_INVALID'],
    ['number timeNano', { lifecycleEvents: validEvents().map((item, index) => index === 0 ? { ...item, timeNano: 42 } : item) },
      'LIFECYCLE_EVENT_SHAPE_INVALID'],
    ['leading-zero timeNano', { lifecycleEvents: validEvents().map((item, index) => index === 0 ? { ...item, timeNano: '01' } : item) },
      'LIFECYCLE_EVENT_SHAPE_INVALID'],
    ['duplicate sequence', { lifecycleEvents: validEvents().map((item, index) => index === 1 ? { ...item, sequence: 1 } : item) },
      'LIFECYCLE_EVENT_ORDER_INVALID'],
    ['non-monotonic time', { lifecycleEvents: validEvents().map((item, index) => index === 1
      ? { ...item, timeNano: '1784790123456789001' } : item) },
      'CONTAINER_EVENT_TIME_ORDER_INVALID'],
  ])('rejects invalid exact identity/order evidence: %s', (_label, overrides, reason) => {
    expect(run(overrides)).toMatchObject({ passed: false, reason });
  });

  it('rejects a same-name event that points at another container identity', () => {
    const events = validEvents();
    events[4] = event(5, 'container', 'die', { actorId: otherContainerId, containerId: otherContainerId });
    expect(run({ lifecycleEvents: events })).toMatchObject({ passed: false, reason: 'CONTAINER_EVENT_IDENTITY_CONFLICT' });
  });

  it('does not let an unrelated manually-created backup event invalidate an exact compose teardown chain', () => {
    const unrelated = event(1, 'container', 'create', {
      actorId: otherContainerId, containerId: otherContainerId,
      containerName: 'geneway-br-unrelated-backup', name: 'geneway-br-unrelated-backup', project: null,
    });
    const lifecycleEvents = [unrelated, ...validEvents().map((item) => ({ ...item, sequence: item.sequence + 1 }))];
    expect(run({ lifecycleEvents })).toMatchObject({ passed: true, reason: 'ORDERED_DOCKER_TEARDOWN_PROVEN' });
  });

  it('rejects storage-reconciler die+destroy evidence without disconnect', () => {
    const reconciler = { ...container, name: `${project}-storage-reconciler-1`, service: 'storage-reconciler' };
    expect(proof.dockerTeardownProofReceipt({ container: reconciler,
      lifecycleEvents: [event(1, 'container', 'die', { containerName: reconciler.name }),
        event(2, 'container', 'destroy', { containerName: reconciler.name })],
      inspectedNetworks: networks, invocationManifest: manifest })).toMatchObject({ passed: false,
      reason: 'DISCONNECT_EVENT_MISSING' });
  });

  it('rejects storage-provisioner destroy-only evidence', () => {
    const provisioner = { ...container, name: `${project}-storage-provisioner-1`, service: 'storage-provisioner' };
    expect(proof.dockerTeardownProofReceipt({ container: provisioner,
      lifecycleEvents: [event(1, 'container', 'destroy', { containerName: provisioner.name })],
      inspectedNetworks: networks, invocationManifest: manifest })).toMatchObject({ passed: false,
      reason: 'DISCONNECT_EVENT_MISSING' });
  });

  it.each([
    ['disconnect after die', [event(1, 'container', 'die'), event(2, 'network', 'disconnect'), event(3, 'container', 'destroy')],
      'DISCONNECT_NOT_BEFORE_DIE'],
    ['destroy before die', [event(1, 'network', 'disconnect'), event(2, 'container', 'destroy'), event(3, 'container', 'die')],
      'DIE_NOT_BEFORE_DESTROY'],
    ['reconnect during teardown', [event(1, 'network', 'disconnect'), event(2, 'network', 'connect'),
      event(3, 'container', 'die'), event(4, 'container', 'destroy')], 'RECONNECT_DURING_TEARDOWN'],
    ['start after destroy', [event(1, 'network', 'disconnect'), event(2, 'container', 'die'),
      event(3, 'container', 'destroy'), event(4, 'container', 'start')], 'POST_DESTROY_ACTIVITY'],
  ])('rejects an unsafe lifecycle: %s', (_label, lifecycleEvents, reason) => {
    expect(run({ lifecycleEvents })).toMatchObject({ passed: false, reason });
  });

  it('requires every disconnect network to be manifest-allowed and exactly inspected', () => {
    const foreignNetworkId = 'e'.repeat(64);
    const events = [event(1, 'network', 'disconnect'), event(2, 'network', 'disconnect', {
      actorId: foreignNetworkId, networkId: foreignNetworkId, networkName: 'foreign_network' }),
    event(3, 'container', 'die'), event(4, 'container', 'destroy')];
    expect(run({ lifecycleEvents: events })).toMatchObject({ passed: false, reason: 'DISCONNECT_NETWORK_NOT_IN_MANIFEST' });

    expect(run({ inspectedNetworks: [{ ...networks[0], internal: false }] })).toMatchObject({ passed: false,
      reason: 'DISCONNECT_NETWORK_NOT_EXACT_INTERNAL_BRIDGE' });
    expect(run({ inspectedNetworks: [{ ...networks[0], identityConflict: true }] })).toMatchObject({ passed: false,
      reason: 'DISCONNECT_NETWORK_NOT_EXACT_INTERNAL_BRIDGE' });
    expect(run({ inspectedNetworks: [networks[0], { ...networks[0] }] })).toMatchObject({ passed: false,
      reason: 'DISCONNECT_NETWORK_INSPECT_MISSING_OR_CONFLICTING' });
  });

  it('does not let a manifest substitute for the service target-network disconnect', () => {
    const events = [event(1, 'network', 'disconnect', { actorId: defaultNetworkId, networkId: defaultNetworkId,
      networkName: `${project}_default` }), event(2, 'container', 'die'), event(3, 'container', 'destroy')];
    expect(run({ lifecycleEvents: events })).toMatchObject({ passed: false, reason: 'TARGET_NETWORK_DISCONNECT_MISSING' });
  });

  it.each([
    ['missing receipt', undefined],
    ['not intrinsically valid', proxyReceipt({ intrinsicValid: false })],
    ['wrong final container', proxyReceipt({ finalBinding: { ...proxyReceipt().finalBinding, containerId: otherContainerId } })],
    ['wrong final network', proxyReceipt({ finalBinding: { ...proxyReceipt().finalBinding, networkId: defaultNetworkId } })],
    ['raw deny', proxyReceipt({ rawGuard: { passed: true, unexpected: ['198.51.100.1:443'], unknownLines: [] } })],
    ['raw unknown', proxyReceipt({ rawGuard: { passed: true, unexpected: [], unknownLines: ['?'] } })],
  ])('fails proxy-backed mode closed: %s', (_label, proxy) => {
    expect(run({ proxyBacked: true, proxyReceipt: proxy })).toMatchObject({ passed: false, reason: 'PROXY_RECEIPT_INVALID' });
  });

  it('rejects proxy evidence when proxy-backed mode was not declared', () => {
    expect(run({ proxyReceipt: proxyReceipt() })).toMatchObject({ passed: false, reason: 'PROXY_RECEIPT_UNEXPECTED' });
  });
});
