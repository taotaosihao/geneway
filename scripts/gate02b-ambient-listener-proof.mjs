import { isIPv4, isIPv6 } from 'node:net';

const PROOF_SCHEMA = 'geneway-gate02b-ambient-listener-proof/1';
const PROCESS_SCHEMA = 'geneway-gate02b-pre-gate-rygel-process/1';
const INTERFACE_SCHEMA = 'geneway-gate02b-internal-docker-test-interface/1';
const TEARDOWN_SCHEMA = 'geneway-gate02b-ambient-listener-teardown/1';
const STATE_SCHEMA = 'geneway-gate02b-ambient-listener-state/1';
const RYGEL_EXECUTABLE = '/usr/bin/rygel';

export class AmbientListenerProofError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'AmbientListenerProofError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AmbientListenerProofError(code, message);
}

function immutable(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function oneMatch(text, pattern, code) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) fail(code);
  return matches[0];
}

function positiveDecimal(value, code, allowZero = false) {
  const rendered = typeof value === 'bigint' ? value.toString() : String(value);
  const pattern = allowZero ? /^(?:0|[1-9][0-9]*)$/u : /^[1-9][0-9]*$/u;
  if (!pattern.test(rendered)) fail(code);
  return rendered;
}

function canonicalIpv4(address) {
  if (!isIPv4(address)) fail('SS_ENDPOINT_INVALID');
  return address.split('.').map((part) => String(Number(part))).join('.');
}

function canonicalIpv6(address) {
  if (!isIPv6(address)) fail('SS_ENDPOINT_INVALID');
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return fail('SS_ENDPOINT_INVALID');
  }
}

function parseEndpoint(raw) {
  const ipv4 = raw.match(/^([^:[\]]+):([1-9][0-9]{0,4})$/u);
  if (ipv4 !== null) {
    const address = canonicalIpv4(ipv4[1]);
    const port = Number(ipv4[2]);
    if (port > 65_535) fail('SS_ENDPOINT_INVALID');
    return { family: 'ipv4', address, scope: null, port, endpoint: `${address}:${String(port)}` };
  }
  const ipv6 = raw.match(/^\[([^\]]+)\]%([A-Za-z0-9_.-]+):([1-9][0-9]{0,4})$/u);
  if (ipv6 !== null) {
    const address = canonicalIpv6(ipv6[1]);
    const port = Number(ipv6[3]);
    if (port > 65_535) fail('SS_ENDPOINT_INVALID');
    const scope = ipv6[2];
    return { family: 'ipv6', address, scope, port,
      endpoint: `[${address}]%${scope}:${String(port)}` };
  }
  fail('SS_ENDPOINT_INVALID');
}

/** Parse exactly one `ss -H -O -ltnpe` LISTEN row. */
export function parseSsListenerRow(line) {
  if (typeof line !== 'string' || line.includes('\n') || line.includes('\r')) fail('SS_ROW_INVALID');
  const columns = line.trim().match(/^LISTEN\s+([0-9]+)\s+([0-9]+)\s+(\S+)\s+(\S+)\s+(.+)$/u);
  if (columns === null) fail('SS_ROW_INVALID');
  const endpoint = parseEndpoint(columns[3]);
  const expectedPeer = endpoint.family === 'ipv4' ? '0.0.0.0:*' : '[::]:*';
  if (columns[4] !== expectedPeer) fail('SS_PEER_INVALID');
  const details = columns[5];
  const owner = oneMatch(details, /users:\(\("([^"\r\n]+)",pid=([1-9][0-9]*),fd=([0-9]+)\)\)/gu,
    'SS_OWNER_AMBIGUOUS');
  if ([...details.matchAll(/(?:users:\(|pid=|fd=)/gu)].length !== 3) fail('SS_OWNER_AMBIGUOUS');
  const uid = oneMatch(details, /(?:^|\s)uid:([0-9]+)(?=\s|$)/gu, 'SS_UID_MISSING');
  const inode = oneMatch(details, /(?:^|\s)ino:([1-9][0-9]*)(?=\s|$)/gu, 'SS_INODE_MISSING');
  const sk = oneMatch(details, /(?:^|\s)sk:([0-9a-f]+)(?=\s|$)/giu, 'SS_SK_MISSING');
  const cgroup = oneMatch(details, /(?:^|\s)cgroup:(\/\S*)(?=\s|$)/gu, 'SS_CGROUP_MISSING');
  const pid = Number(owner[2]);
  const fd = Number(owner[3]);
  const socketInode = positiveDecimal(inode[1], 'SS_INODE_MISSING');
  return immutable({ schemaVersion: PROOF_SCHEMA, ...endpoint, peer: expectedPeer, owner: owner[1], pid, fd,
    uid: Number(uid[1]), socketInode, sk: sk[1].toLowerCase(), cgroup: cgroup[1] });
}

export function tryParseSsListenerRow(line) {
  try {
    return immutable({ ok: true, value: parseSsListenerRow(line) });
  } catch (error) {
    const reason = error instanceof AmbientListenerProofError ? error.code : 'SS_ROW_INVALID';
    return immutable({ ok: false, reason });
  }
}

function parseProcessStat(stat) {
  if (typeof stat !== 'string') fail('PROCESS_STAT_INVALID');
  const close = stat.lastIndexOf(')');
  if (!/^\d+ \(/u.test(stat) || close < 3) fail('PROCESS_STAT_INVALID');
  const parsedPid = Number(stat.slice(0, stat.indexOf(' ')));
  const fields = stat.slice(close + 1).trim().split(/\s+/u);
  const state = fields[0];
  const startTicks = fields[19];
  if (!/^[A-Z]$/u.test(state ?? '') || !/^[1-9][0-9]*$/u.test(startTicks ?? '')) fail('PROCESS_STAT_INVALID');
  if (state === 'Z' || state === 'X') fail('PROCESS_NOT_LIVE');
  return { pid: parsedPid, state, startTicks };
}

function exactRygelCmdline(raw) {
  if (!Buffer.isBuffer(raw) && typeof raw !== 'string') fail('PROCESS_CMDLINE_INVALID');
  const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (value !== RYGEL_EXECUTABLE && value !== `${RYGEL_EXECUTABLE}\0`) fail('PROCESS_CMDLINE_INVALID');
  return RYGEL_EXECUTABLE;
}

function executableIdentity(raw) {
  if (raw === null || typeof raw !== 'object' || raw.path !== RYGEL_EXECUTABLE) fail('PROCESS_EXE_INVALID');
  return { path: RYGEL_EXECUTABLE, dev: positiveDecimal(raw.dev, 'PROCESS_EXE_IDENTITY_INVALID'),
    inode: positiveDecimal(raw.inode, 'PROCESS_EXE_IDENTITY_INVALID') };
}

function processCgroup(raw) {
  if (typeof raw !== 'string') fail('PROCESS_CGROUP_INVALID');
  const trimmed = raw.trim();
  if (/^\/\S*$/u.test(trimmed)) return trimmed;
  const unified = trimmed.split('\n').filter(Boolean).map((line) => line.match(/^0::(\/\S*)$/u)).filter(Boolean);
  if (unified.length !== 1) fail('PROCESS_CGROUP_INVALID');
  return unified[0][1];
}

function networkNamespace(raw) {
  if (typeof raw !== 'string' || !/^net:\[[1-9][0-9]*\]$/u.test(raw)) fail('PROCESS_NETNS_INVALID');
  return raw;
}

function readStableRygelProcess(pid, hooks) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('PROCESS_PID_INVALID');
  const required = ['readProcessStat', 'readCmdline', 'readExecutableIdentity', 'readCgroup', 'readNetns'];
  if (required.some((name) => typeof hooks?.[name] !== 'function')) fail('PROCESS_HOOK_MISSING');
  try {
    const before = parseProcessStat(hooks.readProcessStat(pid));
    const cmdline = exactRygelCmdline(hooks.readCmdline(pid));
    const executable = executableIdentity(hooks.readExecutableIdentity(pid));
    const cgroup = processCgroup(hooks.readCgroup(pid));
    const netns = networkNamespace(hooks.readNetns(pid));
    const after = parseProcessStat(hooks.readProcessStat(pid));
    if (before.pid !== pid || after.pid !== pid) fail('PROCESS_PID_REUSED');
    if (before.startTicks !== after.startTicks) fail('PROCESS_PID_REUSED');
    return { pid, startTicks: before.startTicks, cmdline, executable, cgroup, netns };
  } catch (error) {
    if (error instanceof AmbientListenerProofError) throw error;
    return fail('PROCESS_READ_FAILED');
  }
}

function processInstanceKey(process) {
  return `rygel-process-v1:${JSON.stringify([process.pid, process.startTicks, process.executable.dev,
    process.executable.inode, process.netns, process.cgroup])}`;
}

export function buildPreGateRygelProcessProof(pid, hooks) {
  const process = readStableRygelProcess(pid, hooks);
  return immutable({ schemaVersion: PROCESS_SCHEMA, observedBeforeGate: true, ...process,
    processInstanceKey: processInstanceKey(process) });
}

function validPreGateProof(proof) {
  if (proof === null || typeof proof !== 'object' || !Object.isFrozen(proof)
    || proof.schemaVersion !== PROCESS_SCHEMA || proof.observedBeforeGate !== true
    || proof.cmdline !== RYGEL_EXECUTABLE || proof.executable?.path !== RYGEL_EXECUTABLE) return false;
  try {
    return proof.processInstanceKey === processInstanceKey(proof);
  } catch {
    return false;
  }
}

function exactProcessMatch(expected, actual) {
  return expected.pid === actual.pid && expected.startTicks === actual.startTicks
    && expected.cmdline === actual.cmdline && expected.executable.dev === actual.executable.dev
    && expected.executable.inode === actual.executable.inode && expected.cgroup === actual.cgroup
    && expected.netns === actual.netns && expected.processInstanceKey === processInstanceKey(actual);
}

function validateInterfaceWitness(witness, row, process) {
  if (witness === null || typeof witness !== 'object' || !Object.isFrozen(witness)
    || witness.schemaVersion !== INTERFACE_SCHEMA || witness.repositoryOwned !== true
    || witness.internal !== true || witness.driver !== 'bridge' || witness.testOnly !== true
    || !/^[a-f0-9]{64}$/u.test(witness.networkId ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(witness.networkName ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(witness.composeProject ?? '')
    || !Number.isSafeInteger(witness.ifindex) || witness.ifindex < 1
    || !/^[A-Za-z0-9_.-]+$/u.test(witness.interfaceName ?? '')
    || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/u.test(witness.interfaceMac ?? '')
    || witness.bridge === null || typeof witness.bridge !== 'object' || !Object.isFrozen(witness.bridge)
    || !/^[A-Za-z0-9_.-]+$/u.test(witness.bridge.name ?? '')
    || !Number.isSafeInteger(witness.bridge.ifindex) || witness.bridge.ifindex < 1
    || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/u.test(witness.bridge.mac ?? '')
    || witness.source === null || typeof witness.source !== 'object' || !Object.isFrozen(witness.source)
    || !['invocation-manifest', 'proxy-policy'].includes(witness.source.kind)
    || typeof witness.source.ref !== 'string' || witness.source.ref.length < 1 || witness.source.ref.length > 4096
    || /[\0\r\n]/u.test(witness.source.ref) || !/^[a-f0-9]{64}$/u.test(witness.source.sha256 ?? '')
    || witness.netns !== process.netns || !Array.isArray(witness.addresses)) fail('INTERFACE_WITNESS_INVALID');
  const addresses = witness.addresses.map((address) => row.family === 'ipv4'
    ? canonicalIpv4(address) : canonicalIpv6(address));
  if (!addresses.includes(row.address)) fail('INTERFACE_ENDPOINT_MISMATCH');
  if (row.family === 'ipv6' && witness.interfaceName !== row.scope) fail('INTERFACE_SCOPE_MISMATCH');
  return { schemaVersion: INTERFACE_SCHEMA, repositoryOwned: true, internal: true, testOnly: true,
    driver: 'bridge', composeProject: witness.composeProject, networkId: witness.networkId,
    networkName: witness.networkName, interfaceName: witness.interfaceName, ifindex: witness.ifindex,
    interfaceMac: witness.interfaceMac, bridge: { name: witness.bridge.name, ifindex: witness.bridge.ifindex,
      mac: witness.bridge.mac }, source: { kind: witness.source.kind, ref: witness.source.ref,
      sha256: witness.source.sha256 }, netns: witness.netns,
    addresses: [...new Set(addresses)].sort() };
}

function exactRowMatches(left, right) {
  return left.endpoint === right.endpoint && left.pid === right.pid && left.fd === right.fd
    && left.socketInode === right.socketInode && left.sk === right.sk && left.cgroup === right.cgroup
    && left.owner === right.owner && left.uid === right.uid;
}

function rowsFromSnapshot(snapshot) {
  if (typeof snapshot !== 'string') fail('SS_SNAPSHOT_INVALID');
  return snapshot.split(/\r?\n/u).filter((line) => line.trim().length > 0)
    .map((line) => tryParseSsListenerRow(line)).filter((result) => result.ok).map((result) => result.value);
}

function exactSnapshotInstance(snapshot, candidate) {
  const matches = rowsFromSnapshot(snapshot).filter((row) => exactRowMatches(row, candidate));
  if (matches.length !== 1) fail(matches.length === 0 ? 'SS_INSTANCE_MISSING' : 'SS_INSTANCE_AMBIGUOUS');
  return matches[0];
}

export function ambientListenerInstanceKey(proof) {
  const row = proof?.listener ?? proof;
  const process = proof?.process ?? proof;
  if (row === null || process === null || typeof row !== 'object' || typeof process !== 'object') {
    fail('PROOF_INVALID');
  }
  const link = proof?.interfaceWitness;
  return `rygel-listener-v1:${JSON.stringify([row.endpoint, row.pid, process.startTicks, process.executable?.dev,
    process.executable?.inode, process.netns, row.fd, row.socketInode, row.sk, row.cgroup, link?.networkId,
    link?.networkName, link?.interfaceName, link?.ifindex, link?.interfaceMac, link?.bridge?.name,
    link?.bridge?.ifindex, link?.bridge?.mac, link?.source?.kind, link?.source?.ref, link?.source?.sha256])}`;
}

export function buildAmbientRygelListenerProof(input, hooks) {
  const candidate = parseSsListenerRow(input?.row);
  if (candidate.owner !== 'rygel') fail('SS_OWNER_NOT_RYGEL');
  if (!validPreGateProof(input?.preGateProcessProof)) fail('PRE_GATE_PROOF_INVALID');
  if (candidate.pid !== input.preGateProcessProof.pid) fail('PRE_GATE_PROCESS_MISMATCH');
  if (typeof hooks?.readFdLink !== 'function' || typeof hooks?.readSsSnapshot !== 'function') fail('SOCKET_HOOK_MISSING');
  const process = readStableRygelProcess(candidate.pid, hooks);
  process.processInstanceKey = processInstanceKey(process);
  if (!exactProcessMatch(input.preGateProcessProof, process)) fail('PRE_GATE_PROCESS_MISMATCH');
  if (candidate.cgroup !== process.cgroup) fail('SOCKET_CGROUP_MISMATCH');
  let fdTarget;
  try { fdTarget = hooks.readFdLink(candidate.pid, candidate.fd); } catch { return fail('SOCKET_FD_READ_FAILED'); }
  if (fdTarget !== `socket:[${candidate.socketInode}]`) fail('SOCKET_FD_INODE_MISMATCH');
  let first;
  let second;
  try {
    first = exactSnapshotInstance(hooks.readSsSnapshot(), candidate);
    second = exactSnapshotInstance(hooks.readSsSnapshot(), candidate);
  } catch (error) {
    if (error instanceof AmbientListenerProofError) throw error;
    return fail('SS_SNAPSHOT_INVALID');
  }
  if (!exactRowMatches(first, second)) fail('SS_INSTANCE_CHANGED');
  try {
    if (hooks.readFdLink(candidate.pid, candidate.fd) !== fdTarget) fail('SOCKET_FD_INODE_MISMATCH');
    const finalIdentity = parseProcessStat(hooks.readProcessStat(candidate.pid));
    if (finalIdentity.pid !== candidate.pid || finalIdentity.startTicks !== process.startTicks) fail('PROCESS_PID_REUSED');
  } catch (error) {
    if (error instanceof AmbientListenerProofError) throw error;
    return fail('PROCESS_OR_SOCKET_RECHECK_FAILED');
  }
  const interfaceWitness = validateInterfaceWitness(input.interfaceWitness, candidate, process);
  const proof = { schemaVersion: PROOF_SCHEMA, exact: true, preGateObserved: true, listener: candidate,
    process: { ...process }, interfaceWitness, fdTarget, ssInstanceCount: 2 };
  proof.instanceKey = ambientListenerInstanceKey(proof);
  return immutable(proof);
}

function validListenerProof(proof) {
  if (proof === null || typeof proof !== 'object' || !Object.isFrozen(proof) || proof.schemaVersion !== PROOF_SCHEMA
    || proof.exact !== true || proof.preGateObserved !== true || proof.ssInstanceCount !== 2
    || proof.fdTarget !== `socket:[${proof.listener?.socketInode ?? ''}]` || !Object.isFrozen(proof.listener)
    || !Object.isFrozen(proof.process) || !Object.isFrozen(proof.interfaceWitness)
    || proof.process.cmdline !== RYGEL_EXECUTABLE || proof.process.executable?.path !== RYGEL_EXECUTABLE
    || proof.process.processInstanceKey !== processInstanceKey(proof.process)
    || proof.listener.pid !== proof.process.pid || proof.listener.cgroup !== proof.process.cgroup
    || proof.interfaceWitness.netns !== proof.process.netns) return false;
  try {
    return proof.instanceKey === ambientListenerInstanceKey(proof);
  } catch {
    return false;
  }
}

export function buildExactTeardownWitness(proof, observation) {
  if (!validListenerProof(proof)) fail('PROOF_INVALID');
  if (!['pending', 'released'].includes(observation?.stage)) fail('TEARDOWN_STAGE_INVALID');
  if (!Array.isArray(observation.ssSnapshots) || observation.ssSnapshots.length !== 2) fail('TEARDOWN_SS_INVALID');
  for (const snapshot of observation.ssSnapshots) {
    const rows = rowsFromSnapshot(snapshot);
    if (rows.some((row) => exactRowMatches(row, proof.listener))) fail('TEARDOWN_LISTENER_PRESENT');
    if (rows.some((row) => row.endpoint === proof.listener.endpoint
      || (row.pid === proof.listener.pid && row.fd === proof.listener.fd)
      || row.socketInode === proof.listener.socketInode)) fail('TEARDOWN_IDENTITY_CONTRADICTION');
  }
  if (observation.fdTarget === proof.fdTarget) fail('TEARDOWN_FD_STILL_BOUND');
  if (observation.stage === 'pending' && observation.interfacePresent !== true) fail('TEARDOWN_PENDING_INVALID');
  if (observation.stage === 'released' && observation.interfacePresent !== false) fail('TEARDOWN_RELEASE_INVALID');
  return immutable({ schemaVersion: TEARDOWN_SCHEMA, exact: true, stage: observation.stage,
    instanceKey: proof.instanceKey, endpoint: proof.listener.endpoint, pid: proof.listener.pid, fd: proof.listener.fd,
    socketInode: proof.listener.socketInode, ssAbsenceCount: 2, fdTarget: observation.fdTarget ?? null,
    interfacePresent: observation.interfacePresent });
}

function validTeardownWitness(witness, proof, allowedStages) {
  return witness !== null && typeof witness === 'object' && Object.isFrozen(witness)
    && witness.schemaVersion === TEARDOWN_SCHEMA && witness.exact === true
    && witness.instanceKey === proof?.instanceKey && witness.endpoint === proof?.listener?.endpoint
    && witness.pid === proof?.listener?.pid && witness.fd === proof?.listener?.fd
    && witness.socketInode === proof?.listener?.socketInode && witness.fdTarget !== proof?.fdTarget
    && allowedStages.includes(witness.stage)
    && witness.ssAbsenceCount === 2 && (witness.stage !== 'pending' || witness.interfacePresent === true)
    && (witness.stage !== 'released' || witness.interfacePresent === false);
}

export function initialAmbientListenerState() {
  return immutable({ schemaVersion: STATE_SCHEMA, status: 'UNSEEN', reason: 'AWAITING_EXACT_PROOF', instanceKey: null });
}

function violation(state, reason) {
  return immutable({ schemaVersion: STATE_SCHEMA, status: 'VIOLATION', reason, instanceKey: state.instanceKey ?? null });
}

export function reduceAmbientListenerState(state, event) {
  if (state?.schemaVersion !== STATE_SCHEMA || typeof state.status !== 'string' || event === null
    || typeof event !== 'object') return violation(state ?? {}, 'STATE_OR_EVENT_INVALID');
  if (state.status === 'VIOLATION') return state;
  if (event.type === 'contradiction') return violation(state, 'EVIDENCE_CONTRADICTION');
  if (state.status === 'UNSEEN') {
    if (event.type !== 'proof' || !validListenerProof(event.proof)) return violation(state, 'FIRST_OBSERVATION_NOT_EXACT_PROOF');
    return immutable({ schemaVersion: STATE_SCHEMA, status: 'PROVEN', reason: 'EXACT_PROOF_ACCEPTED',
      instanceKey: event.proof.instanceKey, proof: event.proof });
  }
  if (event.type === 'proof') {
    if (!validListenerProof(event.proof)) return violation(state, 'PROOF_INVALID');
    if (state.status === 'PENDING' || state.status === 'RELEASED') {
      return violation(state, 'LISTENER_REAPPEARED_AFTER_GONE');
    }
    if (event.proof.instanceKey !== state.instanceKey) {
      const samePid = event.proof.listener.pid === state.proof?.listener?.pid;
      return violation(state, samePid ? 'PID_OR_SOCKET_IDENTITY_REUSED' : 'LISTENER_IDENTITY_CHANGED');
    }
    return immutable({ ...state, reason: 'SAME_INSTANCE_REPROVEN', proof: event.proof });
  }
  if (event.type === 'teardown') {
    if (state.status === 'PROVEN') {
      if (!validTeardownWitness(event.witness, state.proof, ['pending', 'released'])) {
        return violation(state, 'TEARDOWN_WITNESS_INVALID');
      }
      return immutable({ schemaVersion: STATE_SCHEMA, status: event.witness.stage === 'pending' ? 'PENDING' : 'RELEASED',
        reason: event.witness.stage === 'pending' ? 'EXACT_TEARDOWN_PENDING' : 'EXACT_TEARDOWN_RELEASED',
        instanceKey: state.instanceKey, proof: state.proof, teardown: event.witness });
    }
    if (state.status === 'PENDING') {
      if (!validTeardownWitness(event.witness, state.proof, ['pending', 'released'])) {
        return violation(state, 'TEARDOWN_WITNESS_INVALID');
      }
      return immutable({ ...state, status: event.witness.stage === 'released' ? 'RELEASED' : 'PENDING',
        reason: event.witness.stage === 'released' ? 'EXACT_TEARDOWN_RELEASED' : 'EXACT_TEARDOWN_PENDING',
        teardown: event.witness });
    }
    if (!validTeardownWitness(event.witness, state.proof, ['released'])) {
      return violation(state, 'TEARDOWN_WITNESS_INVALID');
    }
    return state;
  }
  if (event.type === 'missing') {
    return violation(state, state.status === 'PROVEN' ? 'LISTENER_GONE_WITHOUT_TEARDOWN' : 'MISSING_AFTER_GONE');
  }
  return violation(state, 'EVIDENCE_CONTRADICTION');
}

export const ambientListenerProofSchemas = immutable({ proof: PROOF_SCHEMA, process: PROCESS_SCHEMA,
  interface: INTERFACE_SCHEMA, teardown: TEARDOWN_SCHEMA, state: STATE_SCHEMA });
