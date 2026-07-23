#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, closeSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

function fail(message) { throw new Error(`Gate 0.2B loopback proxy: ${message}`); }
function safeSegment(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) fail(`unsafe ${label}`);
  return value;
}
function safePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`unsafe ${label}`);
  return port;
}
function writeExclusive(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); } finally { closeSync(fd); }
}
function policyHash(policy) {
  const copy = { ...policy };
  delete copy.policyHash;
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}
function processIdentity(pid = process.pid) {
  const line = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  const fields = line.slice(line.lastIndexOf(')') + 1).trim().split(/\s+/u);
  return { pid, parentPid: Number(fields[1]), startTicks: fields[19], processGroupId: Number(fields[2]),
    sessionId: Number(fields[3]), hostname: hostname() };
}
function processStartTicks(pid = process.pid) { return processIdentity(pid).startTicks; }
export function validateProxyPolicy(policy, expectedRoot) {
  const servicePorts = { postgres: 5432, versitygw: 7070, 'storage-adapter': 7400, 'storage-reconciliation-adapter': 7401 };
  if (policy?.schemaVersion !== 'geneway-gate02b-loopback-proxy/1' || policy.listen?.host !== '127.0.0.1'
    || !Number.isInteger(policy.controller?.pid) || policy.controller.pid < 1
    || typeof policy.controller?.startTicks !== 'string' || policy.controller.startTicks === 'unknown'
    || !Number.isInteger(policy.controller?.parentPid) || policy.controller.parentPid < 1
    || !Number.isInteger(policy.controller?.processGroupId) || policy.controller.processGroupId < 1
    || !Number.isInteger(policy.controller?.sessionId) || policy.controller.sessionId < 1
    || typeof policy.controller?.hostname !== 'string'
    || !Number.isInteger(policy.listen?.port) || policy.target?.containerPort === undefined
    || !/^[a-f0-9]{64}$/u.test(policy.target?.containerId ?? '')
    || !/^geneway-(?:e2e|storage|br)-[A-Za-z0-9._-]+$/u.test(policy.target?.project ?? '')
    || !['postgres', 'versitygw', 'storage-adapter', 'storage-reconciliation-adapter'].includes(policy.target?.service)
    || policy.name !== `${policy.target?.project}-${policy.target?.service}`
    || !/^geneway-(?:e2e|storage|br)-[A-Za-z0-9._-]+_(?:default|storage)$/u.test(policy.target?.networkName ?? '')
    || ![`${policy.target?.project}_default`, `${policy.target?.project}_storage`].includes(policy.target?.networkName)
    || !/^[a-f0-9]{64}$/u.test(policy.target?.networkId ?? '')
    || !/^\d+\.\d+\.\d+\.\d+$/u.test(policy.target?.ip ?? '')
    || policy.target?.networkInternal !== true || servicePorts[policy.target?.service] !== policy.target?.port
    || policy.target.port !== policy.target.containerPort) fail('invalid policy');
  const normalized = resolve(policy.policyPath);
  if (normalized !== resolve(expectedRoot, 'loopback-proxies', `${policy.name}.policy.json`)) fail('policy path escaped run root');
  return policy;
}
const localDockerHost = 'unix:///var/run/docker.sock';
export function controlledDockerInvocation(args, configPath) {
  return { command: 'docker', args: ['--host', localDockerHost, ...args], options: { encoding: 'utf8', timeout: 2_000,
    killSignal: 'SIGKILL', env: { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8',
      HOME: configPath, DOCKER_CONFIG: configPath } } };
}
function dockerCommand(args, configPath) {
  const invocation = controlledDockerInvocation(args, configPath);
  const result = spawnSync(invocation.command, invocation.args, invocation.options);
  if (result.error !== undefined || result.status !== 0) fail(`docker ${args[0]} failed`);
  return result.stdout;
}
function dockerJson(args, configPath) {
  return JSON.parse(dockerCommand(args, configPath));
}
function freshBinding(policy) {
  const containers = dockerJson(['inspect', policy.target.containerId], policy.dockerConfigPath);
  const networks = dockerJson(['network', 'inspect', policy.target.networkId], policy.dockerConfigPath);
  const rebound = resolveProxyTarget(containers, { project: policy.target.project, service: policy.target.service,
    networkName: policy.target.networkName, targetPort: policy.target.port });
  if (containers[0]?.State?.Running !== true || networks[0]?.Id !== policy.target.networkId
    || networks[0]?.Name !== policy.target.networkName || networks[0]?.Internal !== true
    || networks[0]?.Labels?.['com.docker.compose.project'] !== policy.target.project
    || JSON.stringify({ ...rebound, networkInternal: true }) !== JSON.stringify(policy.target)) fail('fresh target binding drift');
  return { ...policy.target, running: true };
}
export function resolveProxyTarget(inspection, { project, service, networkName, targetPort }) {
  if (!Array.isArray(inspection) || inspection.length !== 1) fail('container inspection cardinality');
  const container = inspection[0];
  const labels = container?.Config?.Labels ?? {};
  const network = container?.NetworkSettings?.Networks?.[networkName];
  if (labels['com.docker.compose.project'] !== project || labels['com.docker.compose.service'] !== service
    || typeof container?.Id !== 'string' || network === undefined || typeof network.IPAddress !== 'string') fail('container binding mismatch');
  return { containerId: container.Id, project, service, networkName, networkId: network.NetworkID,
    ip: network.IPAddress, port: targetPort, containerPort: targetPort };
}

async function serve(policyPath) {
  const policyStat = lstatSync(policyPath);
  if (!policyStat.isFile() || policyStat.isSymbolicLink() || (policyStat.mode & 0o777) !== 0o600) fail('unsafe policy file');
  const policy = validateProxyPolicy(JSON.parse(readFileSync(policyPath, 'utf8')), dirname(dirname(policyPath)));
  let sequence = 0;
  let connectQueue = Promise.resolve();
  const guardedConnect = () => {
    const launch = connectQueue.then(async () => {
      const binding = freshBinding(policy);
      sequence += 1;
      const attempt = { seq: sequence, schemaVersion: policy.schemaVersion, policyHash: policy.policyHash,
        serve: { pid: process.pid, startTicks: processStartTicks(), hostname: hostname() }, binding };
      writeFileSync(policy.attemptsPath, `${JSON.stringify(attempt)}\n`, { flag: 'a', mode: 0o600 });
      process.env.GENEWAY_GATE02B_EGRESS_ATTEMPT_ID = String(sequence);
      try {
        return await new Promise((resolveConnect, rejectConnect) => {
          const socket = connect({ host: policy.target.ip, port: policy.target.port });
          socket.once('connect', () => resolveConnect(socket)); socket.once('error', rejectConnect);
        });
      } finally { delete process.env.GENEWAY_GATE02B_EGRESS_ATTEMPT_ID; }
    });
    connectQueue = launch.then(() => undefined, () => undefined);
    return launch;
  };
  let targetReady = false;
  for (let attempt = 0; attempt < 100 && !targetReady; attempt += 1) {
    targetReady = await new Promise((resolveProbe) => {
      guardedConnect().then((probe) => { probe.end(); resolveProbe(true); }, () => resolveProbe(false));
    });
    if (!targetReady) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!targetReady) fail('target did not become ready');
  const sockets = new Set();
  const server = createServer((client) => {
    sockets.add(client);
    guardedConnect().then((upstream) => {
      sockets.add(upstream); client.pipe(upstream); upstream.pipe(client);
      const close = () => { sockets.delete(client); sockets.delete(upstream); client.destroy(); upstream.destroy(); };
      client.on('error', close); upstream.on('error', close);
    }, () => { sockets.delete(client); client.destroy(); });
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(policy.listen.port, '127.0.0.1', resolveReady);
  });
  const ready = { schemaVersion: policy.schemaVersion, policyPath, policyHash: policy.policyHash,
    pid: process.pid, startTicks: processStartTicks(), hostname: hostname() };
  writeExclusive(policy.readyPath, ready);
  process.stdout.write(`${JSON.stringify({ ready: true, ...ready })}\n`);
  const stop = () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

async function control(args) {
  const [runRootInput, nameInput, projectInput, serviceInput, networkNameInput, listenInput, targetInput, guardLibrary] = args;
  const runRoot = resolve(runRootInput ?? '');
  if (!runRoot.startsWith('/tmp/geneway-runs/')) fail('unsafe run root');
  const name = safeSegment(nameInput ?? '', 'name');
  const project = safeSegment(projectInput ?? '', 'project');
  const service = safeSegment(serviceInput ?? '', 'service');
  if (name !== service) fail('artifact name must equal the frozen service');
  const networkName = safeSegment(networkNameInput ?? '', 'network');
  const listenPort = safePort(listenInput, 'listen port');
  const targetPort = safePort(targetInput, 'target port');
  let requestStop;
  const stopRequested = new Promise((resolveStop) => { requestStop = resolveStop; });
  let controlBuffer = '';
  let controlFailure = null;
  let shutdownRequests = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (text) => {
    controlBuffer += text;
    const lines = controlBuffer.split('\n'); controlBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line !== 'shutdown' || shutdownRequests !== 0) controlFailure = 'invalid-or-duplicate-shutdown';
      else { shutdownRequests += 1; requestStop(); }
    }
  });
  process.stdin.on('end', () => {
    if (controlBuffer !== '') controlFailure = 'partial-shutdown-command';
    if (shutdownRequests === 0) { controlFailure ??= 'control-pipe-closed-before-shutdown'; requestStop(); }
  });
  process.stdin.resume();
  const requestOutOfBandStop = () => { controlFailure ??= 'out-of-band-signal'; requestStop(); };
  process.once('SIGTERM', requestOutOfBandStop); process.once('SIGINT', requestOutOfBandStop);
  const root = resolve(runRoot, 'loopback-proxies');
  const dockerConfigPath = resolve(runRoot, 'docker-client');
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dockerConfigPath, { recursive: true, mode: 0o700 });
  const configStat = lstatSync(dockerConfigPath);
  if (!configStat.isDirectory() || configStat.isSymbolicLink() || (configStat.mode & 0o777) !== 0o700
    || readdirSync(dockerConfigPath).length !== 0) fail('unsafe Docker client config directory');
  const artifactName = `${project}-${name}`;
  const policyPath = resolve(root, `${artifactName}.policy.json`);
  const rawPath = resolve(root, `${artifactName}.raw`);
  const readyPath = resolve(root, `${artifactName}.ready.json`);
  const attemptsPath = resolve(root, `${artifactName}.attempts.jsonl`);
  const summaryPath = resolve(root, `${artifactName}.json`);
  const matchedIds = dockerCommand(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`], dockerConfigPath).trim().split('\n').filter(Boolean);
  if (matchedIds.length !== 1) fail('container lookup cardinality');
  const target = resolveProxyTarget(dockerJson(['inspect', matchedIds[0]], dockerConfigPath), { project, service, networkName, targetPort });
  const network = dockerJson(['network', 'inspect', target.networkId], dockerConfigPath);
  if (network.length !== 1 || network[0]?.Id !== target.networkId || network[0]?.Internal !== true
    || network[0]?.Name !== networkName
    || network[0]?.Labels?.['com.docker.compose.project'] !== project) fail('target network is not the frozen internal network');
  target.networkInternal = true;
  const policy = { schemaVersion: 'geneway-gate02b-loopback-proxy/1', name: artifactName, policyPath, rawPath, readyPath, attemptsPath,
    dockerHost: localDockerHost, dockerConfigPath,
    controller: processIdentity(),
    listen: { host: '127.0.0.1', port: listenPort }, target };
  policy.policyHash = policyHash(policy);
  writeExclusive(policyPath, policy);
  const rawFd = openSync(rawPath, 'wx', 0o600);
  closeSync(rawFd);
  const attemptsFd = openSync(attemptsPath, 'wx', 0o600);
  closeSync(attemptsFd);
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--serve', policyPath], {
    env: { PATH: process.env.PATH, HOME: dockerConfigPath, DOCKER_CONFIG: dockerConfigPath, LANG: process.env.LANG ?? 'C.UTF-8',
      LD_PRELOAD: guardLibrary, GENEWAY_GATE02B_EGRESS_RECEIPT: rawPath,
      GENEWAY_GATE02B_EGRESS_ALLOWED_TARGET_IPV4: target.ip,
      GENEWAY_GATE02B_EGRESS_ALLOWED_TARGET_PORT: String(target.port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let ready = false;
  let stdoutReady = null;
  let stdoutFailure = null;
  let stdoutBuffer = '';
  const spawnIdentity = { pid: child.pid, startTicks: processStartTicks(child.pid), hostname: hostname() };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    stdoutBuffer += text;
    const lines = stdoutBuffer.split('\n'); stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const exact = parsed.ready === true && parsed.schemaVersion === policy.schemaVersion
          && parsed.pid === child.pid && parsed.startTicks === spawnIdentity.startTicks
          && parsed.hostname === spawnIdentity.hostname && parsed.policyPath === policyPath
          && parsed.policyHash === policy.policyHash;
        if (!exact || stdoutReady !== null) stdoutFailure = 'invalid-or-duplicate-ready';
        else { stdoutReady = parsed; ready = true; process.stdout.write(`${line}\n`); }
      } catch { stdoutFailure = 'non-json-ready-output'; }
    }
  });
  const closed = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolveExit({ status, signal })); });
  const first = await Promise.race([closed.then((exit) => ({ exit })), stopRequested.then(() => ({ stop: true }))]);
  let finalBinding = null;
  let exit = first.exit;
  if (first.stop) {
    try { finalBinding = freshBinding(policy); } catch (cause) { finalBinding = { error: cause instanceof Error ? cause.message : String(cause) }; }
    child.kill('SIGTERM');
    exit = await Promise.race([closed, new Promise((resolveWait) => setTimeout(() => resolveWait(null), 1_500))]);
    if (exit === null) { child.kill('SIGKILL'); exit = await closed; }
  }
  const raw = readFileSync(rawPath);
  const attempts = readFileSync(attemptsPath);
  const lines = raw.toString('utf8').trim().split('\n').filter(Boolean);
  const startIdentities = lines.filter((line) => line.startsWith('START ')).map((line) => ({
    pid: Number(line.match(/pid=(\d+)/u)?.[1] ?? 0),
    startTicks: line.match(/startTicks=([^\s]+)/u)?.[1] ?? null,
    hostname: line.match(/hostname=([^\s]+)/u)?.[1] ?? null,
  }));
  const readyIdentity = JSON.parse(readFileSync(readyPath, 'utf8'));
  const summary = { schemaVersion: policy.schemaVersion, name: artifactName, policyPath, rawPath, readyPath, attemptsPath,
    policyHash: policy.policyHash, controller: policy.controller, spawnIdentity, stdoutReady, readyIdentity, startIdentities, target,
    control: { shutdownRequests, failure: controlFailure },
    finalBinding, listen: policy.listen,
    rawSha256: createHash('sha256').update(raw).digest('hex'), rawLineCount: lines.length,
    attemptsSha256: createHash('sha256').update(attempts).digest('hex'),
    attemptLineCount: attempts.toString('utf8').trim().split('\n').filter(Boolean).length,
    denyLines: lines.filter((line) => line.startsWith('DENY ')), unknownLines: lines.filter((line) => !/^(?:START|ALLOW|DENY) /u.test(line)), exit,
    passed: ready && stdoutFailure === null && stdoutBuffer === '' && shutdownRequests === 1 && controlFailure === null
      && controlBuffer === '' && finalBinding?.running === true
      && exit.status === 0 && exit.signal === null && startIdentities.length === 1
      && JSON.stringify(stdoutReady) === JSON.stringify({ ready: true, ...readyIdentity })
      && spawnIdentity.pid === readyIdentity.pid && spawnIdentity.startTicks === readyIdentity.startTicks
      && readyIdentity.pid === startIdentities[0].pid && readyIdentity.startTicks === startIdentities[0].startTicks
      && readyIdentity.hostname === startIdentities[0].hostname && readyIdentity.policyHash === policy.policyHash
      && startIdentities[0].pid > 0 && !['unknown', null].includes(startIdentities[0].startTicks)
      && typeof startIdentities[0].hostname === 'string'
      && !lines.some((line) => line.startsWith('DENY ')) && lines.every((line) => /^(?:START|ALLOW|DENY) /u.test(line)) };
  writeExclusive(summaryPath, summary);
  if (!summary.passed) process.exitCode = 1;
}

if (process.argv[2] === '--serve') await serve(process.argv[3]);
else if (process.argv[2] === '--control') await control(process.argv.slice(3));
else if (import.meta.url === `file://${process.argv[1]}`) fail('expected --control or --serve');
