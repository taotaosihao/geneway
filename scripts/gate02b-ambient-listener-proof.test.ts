import { describe, expect, it } from 'vitest';

interface ListenerRow { family: 'ipv4' | 'ipv6'; address: string; scope: string | null; port: number; endpoint: string;
  peer: string; owner: string; pid: number; fd: number; uid: number; socketInode: string; sk: string; cgroup: string }
interface ProcessProof { pid: number; startTicks: string; processInstanceKey: string }
interface ListenerProof { instanceKey: string; listener: ListenerRow; process: ProcessProof; fdTarget: string;
  interfaceWitness: { networkName: string; interfaceMac: string; bridge: { name: string; ifindex: number; mac: string };
    source: { kind: string; ref: string; sha256: string } } }
interface ListenerState { status: 'UNSEEN' | 'PROVEN' | 'PENDING' | 'RELEASED' | 'VIOLATION'; reason: string;
  instanceKey: string | null }
interface Hooks { readProcessStat: (pid: number) => string; readCmdline: (pid: number) => string | Buffer;
  readExecutableIdentity: (pid: number) => { path: string; dev: string | number; inode: string | number };
  readCgroup: (pid: number) => string; readNetns: (pid: number) => string;
  readFdLink: (pid: number, fd: number) => string; readSsSnapshot: () => string }
interface AmbientModule {
  ambientListenerInstanceKey: (proof: unknown) => string;
  buildAmbientRygelListenerProof: (input: { row: string; preGateProcessProof: ProcessProof;
    interfaceWitness: unknown }, hooks: Hooks) => ListenerProof;
  buildExactTeardownWitness: (proof: ListenerProof, observation: { stage: 'pending' | 'released';
    ssSnapshots: string[]; fdTarget: string | null; interfacePresent: boolean }) => unknown;
  buildPreGateRygelProcessProof: (pid: number, hooks: Hooks) => ProcessProof;
  initialAmbientListenerState: () => ListenerState;
  parseSsListenerRow: (line: string) => ListenerRow;
  reduceAmbientListenerState: (state: ListenerState, event: unknown) => ListenerState;
  tryParseSsListenerRow: (line: string) => { ok: true; value: ListenerRow } | { ok: false; reason: string };
}

// @ts-expect-error Native ESM helper is intentionally consumed through the contract above.
const ambient = await import('./gate02b-ambient-listener-proof.mjs') as unknown as AmbientModule;

const PID = 2448240;
const FD = 47;
const INODE = '923136226';
const CGROUP = '/user.slice/user-1000.slice/user@1000.service/app.slice/rygel.service';
const NETNS = 'net:[4026531840]';
const IPV4_ROW = `LISTEN 0 10 172.22.0.1:40202 0.0.0.0:* users:(("rygel",pid=${PID},fd=${FD})) uid:1000 ino:${INODE} sk:fd2d2 cgroup:${CGROUP} <->`;
const IPV6_ROW = `LISTEN 0 10 [FE80:0:0:0:4EF:AAFF:FEF2:8493]%veth376bd72:36498 [::]:* users:(("rygel",pid=${PID},fd=255)) uid:1000 ino:923136576 sk:FD2FE cgroup:${CGROUP} v6only:1 <->`;

function procStat(startTicks = '42000', state = 'S'): string {
  return `${PID} (rygel worker) ${[state, ...Array<string>(18).fill('0'), startTicks].join(' ')}`;
}

function hooks(row = IPV4_ROW, overrides: Partial<Hooks> = {}): Hooks {
  return {
    readProcessStat: () => procStat(),
    readCmdline: () => Buffer.from('/usr/bin/rygel\0'),
    readExecutableIdentity: () => ({ path: '/usr/bin/rygel', dev: '2049', inode: '98123' }),
    readCgroup: () => `0::${CGROUP}\n`,
    readNetns: () => NETNS,
    readFdLink: (_pid, fd) => `socket:[${fd === 255 ? '923136576' : INODE}]`,
    readSsSnapshot: () => `${row}\n`,
    ...overrides,
  };
}

function frozenInterface(family: 'ipv4' | 'ipv6'): unknown {
  const networkId = 'f'.repeat(64);
  const bridge = Object.freeze({ name: 'br-f093b06b9760', ifindex: 32, mac: '02:42:ac:16:00:01' });
  const source = Object.freeze({ kind: 'invocation-manifest',
    ref: '/tmp/geneway-runs/v8-16/invocation-manifests/storage.json', sha256: 'a'.repeat(64) });
  return Object.freeze({ schemaVersion: 'geneway-gate02b-internal-docker-test-interface/1',
    repositoryOwned: true, internal: true, testOnly: true, driver: 'bridge', composeProject: 'geneway-gate02b-test',
    networkId, networkName: 'geneway-gate02b-test_storage',
    interfaceName: family === 'ipv4' ? bridge.name : 'veth376bd72', interfaceMac: '02:42:ac:16:00:02',
    ifindex: 33, bridge, source, netns: NETNS,
    addresses: Object.freeze(family === 'ipv4' ? ['172.22.0.1'] : ['fe80::4ef:aaff:fef2:8493']) });
}

function buildProof(row = IPV4_ROW, family: 'ipv4' | 'ipv6' = 'ipv4', hookOverrides: Partial<Hooks> = {}): ListenerProof {
  const injected = hooks(row, hookOverrides);
  const preGateProcessProof = ambient.buildPreGateRygelProcessProof(PID, injected);
  return ambient.buildAmbientRygelListenerProof({ row, preGateProcessProof,
    interfaceWitness: frozenInterface(family) }, injected);
}

function expectProofError(action: () => unknown, code: string): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { code?: unknown }).code).toBe(code);
}

describe('Gate 0.2B ambient Rygel listener proof', () => {
  it('LI-01 parses one-owner IPv4 ss row with a canonical endpoint and complete socket identity', () => {
    expect(ambient.parseSsListenerRow(IPV4_ROW)).toMatchObject({ family: 'ipv4', address: '172.22.0.1',
      scope: null, port: 40202, endpoint: '172.22.0.1:40202', peer: '0.0.0.0:*', owner: 'rygel',
      pid: PID, fd: FD, uid: 1000, socketInode: INODE, sk: 'fd2d2', cgroup: CGROUP });
  });

  it('LI-02 parses and canonicalizes one-owner scoped IPv6 ss rows', () => {
    expect(ambient.parseSsListenerRow(IPV6_ROW)).toMatchObject({ family: 'ipv6',
      address: 'fe80::4ef:aaff:fef2:8493', scope: 'veth376bd72', port: 36498,
      endpoint: '[fe80::4ef:aaff:fef2:8493]%veth376bd72:36498', socketInode: '923136576', sk: 'fd2fe' });
  });

  it('LI-03 rejects missing or ambiguous owner, inode, sk, and cgroup evidence', () => {
    const invalid = [
      IPV4_ROW.replace('users:(("rygel",pid=2448240,fd=47)) ', ''),
      IPV4_ROW.replace(')) uid:', '),("other",pid=9,fd=3)) uid:'),
      IPV4_ROW.replace(` ino:${INODE}`, ''),
      IPV4_ROW.replace(' sk:fd2d2', ''),
      IPV4_ROW.replace(` cgroup:${CGROUP}`, ''),
      IPV4_ROW.replace('0.0.0.0:*', '127.0.0.1:*'),
    ];
    for (const row of invalid) expect(ambient.tryParseSsListenerRow(row)).toMatchObject({ ok: false });
  });

  it('LI-04 builds an immutable pre-Gate process proof across startTicks, exe identity, cgroup, and netns reads', () => {
    const proof = ambient.buildPreGateRygelProcessProof(PID, hooks());
    expect(proof).toMatchObject({ pid: PID, startTicks: '42000' });
    expect(proof.processInstanceKey).toContain('"2049","98123"');
    expect(Object.isFrozen(proof)).toBe(true);
  });

  it('LI-05 fails closed on PID reuse, executable substitution, or extra cmdline arguments', () => {
    let statRead = 0;
    expectProofError(() => ambient.buildPreGateRygelProcessProof(PID, hooks(IPV4_ROW, {
      readProcessStat: () => procStat(statRead++ === 0 ? '42000' : '42001'),
    })), 'PROCESS_PID_REUSED');
    expectProofError(() => ambient.buildPreGateRygelProcessProof(PID, hooks(IPV4_ROW, {
      readExecutableIdentity: () => ({ path: '/tmp/rygel', dev: '2049', inode: '98123' }),
    })), 'PROCESS_EXE_INVALID');
    expectProofError(() => ambient.buildPreGateRygelProcessProof(PID, hooks(IPV4_ROW, {
      readCmdline: () => '/usr/bin/rygel --serve',
    })), 'PROCESS_CMDLINE_INVALID');
  });

  it('LI-06 binds pre-Gate process, fd socket inode, cgroup, netns, interface, and two ss instances', () => {
    const proof = buildProof();
    expect(proof.fdTarget).toBe(`socket:[${INODE}]`);
    expect(proof.instanceKey).toContain(INODE);
    expect(proof.interfaceWitness).toMatchObject({ networkName: 'geneway-gate02b-test_storage',
      interfaceMac: '02:42:ac:16:00:02', bridge: { name: 'br-f093b06b9760', ifindex: 32 },
      source: { kind: 'invocation-manifest', sha256: 'a'.repeat(64) } });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.listener)).toBe(true);
  });

  it('LI-07 rejects fd mismatch, second-ss disappearance, cgroup mismatch, and non-internal interface claims', () => {
    const baseHooks = hooks();
    const preGateProcessProof = ambient.buildPreGateRygelProcessProof(PID, baseHooks);
    const input = { row: IPV4_ROW, preGateProcessProof, interfaceWitness: frozenInterface('ipv4') };
    expectProofError(() => ambient.buildAmbientRygelListenerProof(input, hooks(IPV4_ROW, {
      readFdLink: () => 'socket:[999]',
    })), 'SOCKET_FD_INODE_MISMATCH');
    let snapshotRead = 0;
    expectProofError(() => ambient.buildAmbientRygelListenerProof(input, hooks(IPV4_ROW, {
      readSsSnapshot: () => snapshotRead++ === 0 ? IPV4_ROW : '',
    })), 'SS_INSTANCE_MISSING');
    expectProofError(() => ambient.buildAmbientRygelListenerProof(input, hooks(IPV4_ROW, {
      readCgroup: () => '0::/different\n',
    })), 'PRE_GATE_PROCESS_MISMATCH');
    expectProofError(() => ambient.buildAmbientRygelListenerProof({ ...input,
      interfaceWitness: Object.freeze({ ...(frozenInterface('ipv4') as object), internal: false }) }, hooks()),
    'INTERFACE_WITNESS_INVALID');
    expectProofError(() => ambient.buildAmbientRygelListenerProof({ ...input,
      interfaceWitness: Object.freeze({ ...(frozenInterface('ipv4') as object), source: undefined }) }, hooks()),
    'INTERFACE_WITNESS_INVALID');
  });

  it('LI-08 derives an immutable instance key that changes for socket/process identity reuse', () => {
    const proof = buildProof();
    expect(ambient.ambientListenerInstanceKey(proof)).toBe(proof.instanceKey);
    expect(ambient.ambientListenerInstanceKey({ ...proof, listener: { ...proof.listener, socketInode: '923136227' } }))
      .not.toBe(proof.instanceKey);
    expect(ambient.ambientListenerInstanceKey({ ...proof, process: { ...proof.process, startTicks: '42001' } }))
      .not.toBe(proof.instanceKey);
    expect(ambient.ambientListenerInstanceKey({ ...proof, interfaceWitness: { ...proof.interfaceWitness,
      interfaceMac: '02:42:ac:16:00:03' } })).not.toBe(proof.instanceKey);
  });

  it('TD-01 moves UNSEEN to PROVEN only for an exact proof', () => {
    const proof = buildProof();
    expect(ambient.reduceAmbientListenerState(ambient.initialAmbientListenerState(), { type: 'proof', proof }))
      .toMatchObject({ status: 'PROVEN', reason: 'EXACT_PROOF_ACCEPTED', instanceKey: proof.instanceKey });
  });

  it('TD-02 makes the first missing/invalid evidence a terminal reason-coded violation', () => {
    const violated = ambient.reduceAmbientListenerState(ambient.initialAmbientListenerState(),
      { type: 'missing', reason: 'NO_INSTANCE' });
    expect(violated).toMatchObject({ status: 'VIOLATION', reason: 'FIRST_OBSERVATION_NOT_EXACT_PROOF' });
    expect(ambient.reduceAmbientListenerState(violated, { type: 'proof', proof: buildProof() })).toBe(violated);
  });

  it('TD-03 maintains only the same proven instance and terminally rejects identity reuse or contradiction', () => {
    const proof = buildProof();
    const proven = ambient.reduceAmbientListenerState(ambient.initialAmbientListenerState(), { type: 'proof', proof });
    expect(ambient.reduceAmbientListenerState(proven, { type: 'proof', proof }))
      .toMatchObject({ status: 'PROVEN', reason: 'SAME_INSTANCE_REPROVEN' });
    const other = buildProof(IPV6_ROW, 'ipv6');
    expect(ambient.reduceAmbientListenerState(proven, { type: 'proof', proof: other }))
      .toMatchObject({ status: 'VIOLATION', reason: 'PID_OR_SOCKET_IDENTITY_REUSED' });
    expect(ambient.reduceAmbientListenerState(proven, { type: 'contradiction', reason: 'policy-cooccurrence' }))
      .toMatchObject({ status: 'VIOLATION', reason: 'EVIDENCE_CONTRADICTION' });
  });

  it('TD-04 permits PENDING/RELEASED only with exact teardown and rejects GONE reappearance', () => {
    const proof = buildProof();
    const proven = ambient.reduceAmbientListenerState(ambient.initialAmbientListenerState(), { type: 'proof', proof });
    const pendingWitness = ambient.buildExactTeardownWitness(proof,
      { stage: 'pending', ssSnapshots: ['', ''], fdTarget: null, interfacePresent: true });
    const pending = ambient.reduceAmbientListenerState(proven, { type: 'teardown', witness: pendingWitness });
    expect(pending).toMatchObject({ status: 'PENDING', reason: 'EXACT_TEARDOWN_PENDING' });
    const releasedWitness = ambient.buildExactTeardownWitness(proof,
      { stage: 'released', ssSnapshots: ['', ''], fdTarget: null, interfacePresent: false });
    const released = ambient.reduceAmbientListenerState(pending, { type: 'teardown', witness: releasedWitness });
    expect(released).toMatchObject({ status: 'RELEASED', reason: 'EXACT_TEARDOWN_RELEASED' });
    expect(ambient.reduceAmbientListenerState(released, { type: 'proof', proof }))
      .toMatchObject({ status: 'VIOLATION', reason: 'LISTENER_REAPPEARED_AFTER_GONE' });
    expect(ambient.reduceAmbientListenerState(proven, { type: 'missing', reason: 'GONE' }))
      .toMatchObject({ status: 'VIOLATION', reason: 'LISTENER_GONE_WITHOUT_TEARDOWN' });
  });

  it('V8-16 covers exact IPv4, scoped IPv6, and no-instance aggregate observations without policy cooccurrence', () => {
    for (const [row, family] of [[IPV4_ROW, 'ipv4'], [IPV6_ROW, 'ipv6']] as const) {
      const proof = buildProof(row, family);
      expect(ambient.reduceAmbientListenerState(ambient.initialAmbientListenerState(), { type: 'proof', proof }).status)
        .toBe('PROVEN');
    }
    const injected = hooks();
    const preGateProcessProof = ambient.buildPreGateRygelProcessProof(PID, injected);
    expectProofError(() => ambient.buildAmbientRygelListenerProof({ row: IPV4_ROW, preGateProcessProof,
      interfaceWitness: frozenInterface('ipv4') }, hooks(IPV4_ROW, { readSsSnapshot: () => '' })),
    'SS_INSTANCE_MISSING');
    expect(ambient.reduceAmbientListenerState(ambient.initialAmbientListenerState(),
      { type: 'missing', reason: 'NO_INSTANCE' })).toMatchObject({ status: 'VIOLATION' });
  });
});
