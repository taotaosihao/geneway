#!/usr/bin/env node

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createWriteStream, openSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const composeFile = join(scriptDirectory, 'backup-restore', 'docker-compose.yml');
const roleDockerfile = join(scriptDirectory, 'backup-restore', 'Dockerfile.role');
const fixturePath = join(scriptDirectory, 'fixtures', 'gate0.2a', 'solution-analysis-demo-v2.txt');
const supportedCases = new Set(['success', 'missing-object', 'manifest-mismatch']);
const selectedCase = process.argv[2] ?? 'success';
if (!supportedCases.has(selectedCase)) {
  process.stderr.write(`usage: node scripts/run-backup-restore.mjs [${[...supportedCases].join('|')}]\n`);
  process.exit(2);
}

const requestedRunId = process.env.GENEWAY_RUN_ID ?? `backup-restore-${Date.now()}-${randomUUID().slice(0, 8)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestedRunId)) {
  throw new Error('GENEWAY_RUN_ID must be a safe path segment');
}

const runRoot = join('/tmp/geneway-runs', requestedRunId);
const rehearsalRoot = join(runRoot, 'backup-restore');
const backupRoot = join(rehearsalRoot, 'backup');
const verificationRoot = join(rehearsalRoot, 'verification');
const timelinePath = join(rehearsalRoot, 'timeline.ndjson');
const projectSuffix = sha256(Buffer.from(requestedRunId)).slice(0, 12);
const credentialsRunRoot = join('/tmp/gw-br-secrets', projectSuffix);
const runtimeRunRoot = join('/tmp/gw-br-runtime', projectSuffix);
const roleImage = `geneway-backup-role:${sha256(Buffer.from('node-22.21.1-postgres-17-v2')).slice(0, 16)}`;
const gate02bGuardRequired = process.env.GENEWAY_GATE02B_EGRESS_GUARD === 'required';
const gate02bCoordinator = process.env.GENEWAY_BACKUP_RESTORE_ROLE === undefined;
const gate02bGuardLibrary = process.env.GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY;
const gate02bProxyRunRoot = process.env.GENEWAY_GATE02B_PROXY_RUN_ROOT ?? runRoot;
if (gate02bGuardRequired && gate02bCoordinator
  && (gate02bProxyRunRoot !== `/tmp/geneway-runs/${requestedRunId}-proxies`
  || typeof gate02bGuardLibrary !== 'string' || !isAbsolute(gate02bGuardLibrary))) {
  throw new Error('Gate 0.2B backup proxy boundary requires the exact run root and guard library');
}
const gate02bAllowedRoleUnix = `tsx-pipe:/tmp/tsx-${String(process.getuid?.() ?? 1000)}`;
const bucket = 'geneway-artifacts';
const children = new Map();
const activeServiceHandles = new Set();
const storageClients = new Set();
const roleContainers = new Set();
const roleEgressPolicies = new Map();
const provenBackupNetworkBoundaries = new Set();
let sourceStack;
let targetStack;
let sourceStarted = false;
let targetStarted = false;
let sourceDestructionReceipt;
let targetDestructionReceipt;
let integrityResult;
let backupSetId;
let stage = 'initialize';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sanitize(value) {
  return String(value);
}

function safeError(error) {
  return error instanceof Error ? sanitize(error.message) : sanitize(error);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function record(type, details = {}) {
  await appendFile(timelinePath, `${JSON.stringify({ at: new Date().toISOString(), type, details })}\n`, { mode: 0o600 });
}

function isolatedEnvironment(values = {}) {
  const guardValues = [process.env.LD_PRELOAD, process.env.GENEWAY_GATE02B_EGRESS_RECEIPT,
    process.env.GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS];
  if (gate02bGuardRequired && process.env.GENEWAY_BACKUP_RESTORE_ROLE !== undefined
    && guardValues.some((value) => value === undefined)) {
    throw new Error('Gate 0.2B role child egress guard environment is incomplete');
  }
  const inheritedGuard = guardValues.every((value) => value !== undefined) ? {
    LD_PRELOAD: process.env.LD_PRELOAD,
    GENEWAY_GATE02B_EGRESS_RECEIPT: process.env.GENEWAY_GATE02B_EGRESS_RECEIPT,
    GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS: process.env.GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS,
    ...(process.env.GENEWAY_GATE02B_EGRESS_ALLOWED_UNIX === undefined ? {}
      : { GENEWAY_GATE02B_EGRESS_ALLOWED_UNIX: process.env.GENEWAY_GATE02B_EGRESS_ALLOWED_UNIX }),
  } : {};
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
    NODE_ENV: 'test',
    ...inheritedGuard,
    ...values,
  };
}

async function pickPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port'));
        return;
      }
      server.close((error) => error === undefined ? resolvePort(address.port) : reject(error));
    });
  });
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new Error(`${command} failed (${result.code}): ${sanitize(result.stderr || result.stdout)}`));
        return;
      }
      resolveCommand(result);
    });
  });
}

async function runCommandToFile(command, args, destination, options = {}) {
  await mkdir(dirname(destination), { recursive: true });
  const output = openSync(destination, 'w', 0o600);
  try {
    await new Promise((resolveCommand, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        env: options.env ?? process.env,
        stdio: ['ignore', output, 'pipe'],
      });
      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => code === 0
        ? resolveCommand()
        : reject(new Error(`${command} failed (${code ?? 1}): ${sanitize(Buffer.concat(stderr).toString('utf8').trim())}`)));
    });
  } finally {
    closeSync(output);
  }
}

async function runCommandFromFile(command, args, source, options = {}) {
  const input = openSync(source, 'r');
  try {
    await new Promise((resolveCommand, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        env: options.env ?? process.env,
        stdio: [input, 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => code === 0
        ? resolveCommand()
        : reject(new Error(`${command} failed (${code ?? 1}): ${sanitize(Buffer.concat(stderr).toString('utf8').trim() || Buffer.concat(stdout).toString('utf8').trim())}`)));
    });
  } finally {
    closeSync(input);
  }
}

async function ensureRoleImage() {
  const present = await runCommand('docker', ['image', 'inspect', roleImage], { allowFailure: true });
  if (present.code === 0) return;
  if (gate02bGuardRequired) throw new Error(`Gate 0.2B required offline role image is missing: ${roleImage}`);
  await runCommand('docker', ['build', '--tag', roleImage, '--file', roleDockerfile,
    join(scriptDirectory, 'backup-restore')]);
}

function roleContainerMount(source, options = {}) {
  return { source, target: options.target ?? source, readonly: options.readonly ?? true };
}

async function createRoleContainer({ name, role, action, networkMode, mounts, environment, command, egressPorts = [] }) {
  const egressRoot = join(rehearsalRoot, 'egress-boundaries');
  const rawReceipt = join(egressRoot, `${name}.raw`);
  const policyPath = join(egressRoot, `${name}.policy.json`);
  const summaryPath = join(egressRoot, `${name}.json`);
  if (gate02bGuardRequired) {
    if (gate02bGuardLibrary === undefined || (networkMode === 'host' && egressPorts.length === 0)) {
      throw new Error(`Gate 0.2B egress policy is incomplete for ${role}/${action}`);
    }
    await mkdir(egressRoot, { recursive: true, mode: 0o700 });
  }
  const args = ['create', '--name', name, '--hostname', name,
    '--label', `geneway.backup.run=${requestedRunId}`,
    '--label', `geneway.backup.role=${role}`,
    '--label', `geneway.backup.action=${action}`,
    '--network', networkMode,
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '256',
    '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--env', 'NODE_ENV=test'];
  if (gate02bGuardRequired) args.push('--env', 'GENEWAY_GATE02B_EGRESS_GUARD=required');
  if (gate02bGuardRequired && networkMode === 'host') {
    args.push('--label', `geneway.gate02b.egress_receipt=${summaryPath}`,
      '--env', `LD_PRELOAD=${gate02bGuardLibrary}`,
      '--env', `GENEWAY_GATE02B_EGRESS_RECEIPT=${rawReceipt}`,
      '--env', `GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS=${egressPorts.join(',')}`,
      '--env', `GENEWAY_GATE02B_EGRESS_ALLOWED_UNIX=${gate02bAllowedRoleUnix}`);
  }
  if ((role === 'provision' && !gate02bGuardRequired) || role === 'provision-docker') {
    args.push('--group-add', String((await stat('/var/run/docker.sock')).gid));
  }
  for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`);
  for (const mount of mounts) {
    args.push('--mount', `type=bind,src=${mount.source},dst=${mount.target}${mount.readonly ? ',readonly' : ''}`);
  }
  if (gate02bGuardRequired && networkMode === 'host') {
    args.push('--mount', `type=bind,src=${gate02bGuardLibrary},dst=${gate02bGuardLibrary},readonly`);
    args.push('--mount', `type=bind,src=${egressRoot},dst=${egressRoot}`);
  }
  args.push(roleImage, ...command);
  await runCommand('docker', args);
  roleContainers.add(name);
  const inspection = JSON.parse((await runCommand('docker', ['inspect', name])).stdout)[0];
  if (gate02bGuardRequired) await writeJson(policyPath, {
    schemaVersion: 'geneway-backup-egress-boundary/1', runId: requestedRunId, containerId: inspection.Id,
    pidStartTicks: null, role, action, networkMode, allowedPorts: egressPorts,
    allowedUnix: networkMode === 'host' ? [gate02bAllowedRoleUnix] : [], rawReceipt, hostname: name,
    policyComplete: networkMode !== 'host' || egressPorts.length > 0,
  });
  if (gate02bGuardRequired && networkMode === 'host') roleEgressPolicies.set(name, {
    rawReceipt, policyPath, summaryPath, containerId: inspection.Id, hostname: name,
    allowedUnix: [gate02bAllowedRoleUnix], role, action, networkMode, allowedPorts: egressPorts,
  });
  const actualMounts = inspection.Mounts.map((mount) => ({
    source: mount.Source,
    destination: mount.Destination,
    readWrite: mount.RW,
  }));
  const allowedSources = new Set([...mounts.map((mount) => mount.source),
    ...(gate02bGuardRequired && networkMode === 'host' ? [gate02bGuardLibrary, egressRoot] : [])]);
  const dockerAuthoritySources = ['/usr/bin/docker', '/usr/libexec/docker/cli-plugins/docker-compose', '/var/run/docker.sock'];
  const dockerAuthorityAllowed = (!gate02bGuardRequired && role === 'provision')
    || (gate02bGuardRequired && role === 'provision-docker');
  const observedDockerAuthority = actualMounts.filter((mount) => dockerAuthoritySources.includes(mount.source));
  const dockerAuthorityPassed = dockerAuthorityAllowed
    ? dockerAuthoritySources.every((source) => observedDockerAuthority.some((mount) => mount.source === source))
      && observedDockerAuthority.every((mount) => mount.source === '/var/run/docker.sock' ? mount.readWrite : !mount.readWrite)
    : observedDockerAuthority.length === 0;
  const forbiddenMounts = actualMounts.filter((mount) => !allowedSources.has(mount.source)
    || (dockerAuthoritySources.includes(mount.source) && !dockerAuthorityAllowed));
  const observedNetworkMode = inspection.HostConfig.NetworkMode;
  const boundary = {
    schemaVersion: 'geneway-backup-container-boundary/1',
    role,
    action,
    containerName: name,
    networkMode: observedNetworkMode,
    mounts: actualMounts,
    dockerAuthority: { allowed: dockerAuthorityAllowed, expectedSources: dockerAuthorityAllowed ? dockerAuthoritySources : [],
      observed: observedDockerAuthority, passed: dockerAuthorityPassed },
    forbiddenNamesPresent: forbiddenMounts.map((mount) => mount.source),
    checked: observedNetworkMode === networkMode && forbiddenMounts.length === 0 && dockerAuthorityPassed,
  };
  await writeJson(join(rehearsalRoot, 'process-boundaries', `container-${name}.json`), boundary);
  if (!boundary.checked) throw new Error(`${role}/${action} container boundary inspection failed`);
  return boundary;
}

async function removeRoleContainer(name) {
  const policy = roleEgressPolicies.get(name);
  let egressFailure;
  if (policy !== undefined) {
    const inspectionResult = await runCommand('docker', ['inspect', name], { allowFailure: true });
    const inspection = inspectionResult.code === 0 ? JSON.parse(inspectionResult.stdout)[0] : null;
    let rawBytes = Buffer.alloc(0);
    try { rawBytes = await readFile(policy.rawReceipt); } catch {}
    const lines = rawBytes.toString('utf8').trim().split('\n').filter(Boolean);
    const starts = lines.filter((line) => line.startsWith('START '));
    const unexpected = lines.filter((line) => line.startsWith('DENY '));
    const attempted = lines.filter((line) => line.startsWith('ALLOW ') || line.startsWith('DENY '));
    const unknownLines = lines.filter((line) => !/^(?:START|ALLOW|DENY) /u.test(line));
    const startIdentities = starts.map((line) => ({
      pid: Number(line.match(/pid=(\d+)/u)?.[1] ?? 0),
      pidStartTicks: line.match(/startTicks=([^\s]+)/u)?.[1] ?? null,
      hostname: line.match(/hostname=([^\s]+)/u)?.[1] ?? null,
    }));
    const minimumStarts = policy.role === 'provision' ? (policy.action === 'source' ? 3 : 2)
      : ['online-storage', 'control-plane'].includes(policy.role) ? 2 : 1;
    const uniqueIdentities = [...new Map(startIdentities.map((identity) => [`${String(identity.pid)}:${String(identity.pidStartTicks)}`, identity])).values()];
    const identitiesValid = uniqueIdentities.length >= minimumStarts
      && new Set(uniqueIdentities.map((identity) => identity.pid)).size === uniqueIdentities.length
      && startIdentities.every((identity) => identity.pid > 0 && identity.pidStartTicks !== null
        && identity.pidStartTicks !== 'unknown' && identity.hostname === policy.hostname);
    const receipt = {
      schemaVersion: 'geneway-backup-egress-boundary/1', runId: requestedRunId, containerId: policy.containerId,
      startIdentities: uniqueIdentities,
      reloadCount: startIdentities.length - uniqueIdentities.length,
      role: policy.role, action: policy.action, networkMode: policy.networkMode, policyComplete: identitiesValid,
      hostname: policy.hostname, allowedUnix: policy.allowedUnix,
      allowedIpAddresses: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
      allowed: policy.allowedPorts.flatMap((port) => [
        `127.0.0.1:${String(port)}`, `[::1]:${String(port)}`, `[::ffff:127.0.0.1]:${String(port)}`,
      ]), attempted, unexpected,
      unknownLines,
      rawReceipt: policy.rawReceipt,
      rawReceiptSha256: sha256(rawBytes),
      rawLineCount: lines.length,
      exitStatus: inspection?.State?.ExitCode ?? null,
      passed: identitiesValid && unexpected.length === 0 && unknownLines.length === 0
        && Number.isInteger(inspection?.State?.ExitCode),
    };
    await writeJson(policy.summaryPath, receipt);
    roleEgressPolicies.delete(name);
    if (!receipt.passed) egressFailure = new Error(`${policy.role}/${policy.action} Gate 0.2B egress boundary failed`);
  }
  await runCommand('docker', ['rm', '--force', name], { allowFailure: true });
  const absent = await runCommand('docker', ['inspect', name], { allowFailure: true });
  if (absent.code === 0) throw new Error(`Role container ${name} survived removal`);
  roleContainers.delete(name);
  if (egressFailure !== undefined) throw egressFailure;
}

async function proveBackupCannotReachOnlineControlPlane(stack) {
  if (provenBackupNetworkBoundaries.has(stack.label)) return;
  let controlPlaneOnline = false;
  try {
    controlPlaneOnline = (await fetch(`${stack.controlPlaneUrl}/health`)).ok;
  } catch {}
  if (!controlPlaneOnline) return;

  const attemptedUrl = `${stack.controlPlaneUrl}/health`;
  const containerName = `geneway-br-${projectSuffix}-backup-online-deny-${stack.label}`.slice(0, 63);
  await createRoleContainer({
    name: containerName,
    role: 'backup-network',
    action: 'deny-online-control-plane',
    networkMode: stack.dataNetwork,
    mounts: [],
    environment: {},
    command: ['node', '-e',
      'fetch(process.argv[1]).then(() => process.exit(9), () => process.exit(0))', attemptedUrl],
  });
  let probe;
  try {
    probe = await runCommand('docker', ['start', '--attach', containerName], { allowFailure: true });
  } finally {
    await removeRoleContainer(containerName);
  }
  const receipt = {
    schemaVersion: 'geneway-backup-online-route-boundary/1',
    role: 'backup-network',
    stack: stack.label,
    controlPlaneObservedOnlineByCoordinator: true,
    attemptedUrl,
    networkMode: stack.dataNetwork,
    directRouteSucceeded: probe.code === 9,
    checked: probe.code === 0,
    forbiddenNamesPresent: probe.code === 0 ? [] : ['online-control-plane-route'],
  };
  await writeJson(join(rehearsalRoot, 'process-boundaries',
    `${stack.label}-backup-online-network.json`), receipt);
  if (!receipt.checked) {
    throw new Error(`Backup network unexpectedly reached the online ${stack.label} Control Plane`);
  }
  provenBackupNetworkBoundaries.add(stack.label);
}

async function startChild(label, command, args, env, ready, options = {}) {
  const logPath = join(rehearsalRoot, 'processes', `${label}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'w', mode: 0o600 });
  let output = '';
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env,
    stdio: [options.controlPipe === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const signalTree = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  const consume = (chunk) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-64_000);
    log.write(chunk);
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  children.set(child, { controlPipe: options.controlPipe === true });
  const close = new Promise((resolveClose) => child.once('close', (code, signal) => {
    children.delete(child);
    log.end();
    resolveClose({ code, signal });
  }));
  const handle = {
    label,
    child,
    output: () => output,
    async stop() {
      if (options.controlPipe === true) {
        if (child.exitCode === null && child.signalCode === null) child.stdin.end('shutdown\n');
        await Promise.race([close, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
        if (child.exitCode === null && child.signalCode === null) {
          throw new Error(`${label} ignored its private shutdown pipe`);
        }
        await record('process.stopped', { label, pid: child.pid });
        return;
      }
      signalTree('SIGTERM');
      await Promise.race([close, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) {
        signalTree('SIGKILL');
        await close;
      }
      await record('process.stopped', { label, pid: child.pid });
    },
  };
  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${label} exited before readiness: ${sanitize(output)}`);
      }
      return await ready(handle);
    }, 20_000, `${label} readiness`);
  } catch (error) {
    await handle.stop();
    throw error;
  }
  await record('process.started', { label, pid: child.pid });
  return handle;
}

function abandonUnresponsiveControlPipeChild(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function isolatedRoleMounts(stack, roleFile, options = {}) {
  const mounts = [
    roleContainerMount(repositoryRoot, { target: '/workspace' }),
    roleContainerMount(runRoot, { readonly: false }),
  ];
  if (roleFile !== null) mounts.push(roleContainerMount(roleFile));
  if (options.runtime) mounts.push(roleContainerMount(stack.runtimeRoot, { readonly: false }));
  if (options.token) mounts.push(roleContainerMount(stack.tokenFile));
  if (options.compose) {
    mounts.push(roleContainerMount(stack.composeEnvFile));
    mounts.push(roleContainerMount('/usr/bin/docker'));
    mounts.push(roleContainerMount('/usr/libexec/docker/cli-plugins/docker-compose'));
    mounts.push(roleContainerMount('/var/run/docker.sock', { readonly: false }));
  }
  return mounts;
}

function gate02bHostRolePorts(role, stack) {
  if (!gate02bGuardRequired) return [];
  if (role === 'online') return [stack.controlPlanePort];
  if (role === 'oracle' || role === 'online-storage') return [stack.s3Port];
  if (role === 'control-plane') return [stack.postgresPort, stack.storageAdapterPort];
  if (role === 'provision') return [stack.postgresPort, stack.s3Port];
  return [];
}

async function startContainerRoleService({ label, role, stack, roleEnvironmentPath, command, args,
  networkMode, runtime = false, token = false, environment = {}, ready }) {
  const containerName = `geneway-br-${projectSuffix}-${label}`.slice(0, 63);
  await createRoleContainer({
    name: containerName,
    role,
    action: 'service',
    networkMode,
    mounts: isolatedRoleMounts(stack, roleEnvironmentPath, { runtime, token }),
    environment,
    egressPorts: gate02bHostRolePorts(role, stack),
    command: ['node', '/workspace/scripts/backup-restore/role-launcher.mjs', role,
      join(rehearsalRoot, 'process-boundaries', `${label}.json`), roleEnvironmentPath,
      command, ...args],
  });
  let childHandle;
  try {
    childHandle = await startChild(label, 'docker', ['start', '--attach', containerName], isolatedEnvironment(), ready);
  } catch (error) {
    await removeRoleContainer(containerName);
    throw error;
  }
  let stopped = false;
  const handle = {
    label,
    containerName,
    output: childHandle.output,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await runCommand('docker', ['stop', '--time', '5', containerName], { allowFailure: true });
        await childHandle.stop();
      } finally {
        await removeRoleContainer(containerName);
        activeServiceHandles.delete(handle);
      }
    },
  };
  activeServiceHandles.add(handle);
  return handle;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
      if (String(error).includes('exited before readiness')) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${label} timed out${lastError === undefined ? '' : `: ${safeError(lastError)}`}`);
}

async function createStack(label) {
  const postgresPort = await pickPort();
  const s3Port = await pickPort();
  const storageAdapterPort = await pickPort();
  const controlPlanePort = await pickPort();
  const composePostgresPort = gate02bGuardRequired ? await pickPort() : postgresPort;
  const composeS3Port = gate02bGuardRequired ? await pickPort() : s3Port;
  const project = `geneway-br-${label}-${projectSuffix}`;
  const dataNetwork = `${project}_default`;
  const runtimeRoot = join(runtimeRunRoot, label);
  const socketPath = join(runtimeRoot, 'worker.sock');
  const credentialsRoot = join(credentialsRunRoot, label);
  const tokenFile = join(credentialsRoot, 'worker.token');
  const bootstrapInput = join(credentialsRoot, 'bootstrap-public-input.json');
  const bootstrapOutput = join(credentialsRoot, 'stack-public.json');
  await mkdir(credentialsRoot, { recursive: true, mode: 0o700 });
  await chmod(credentialsRoot, 0o700);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await writeJson(bootstrapInput, {
    label,
    project,
    dataNetwork,
    postgresContainer: `${project}-postgres-1`,
    projectSuffix,
    runId: requestedRunId,
    postgresPort,
    s3Port,
    composePostgresPort,
    composeS3Port,
    storageAdapterPort,
    controlPlanePort,
    socketPath,
    tokenFile,
    runtimeRoot,
    credentialsRoot,
  });
  await runCommand(process.execPath, [join(scriptDirectory, 'backup-restore', 'bootstrap-stack.mjs'), bootstrapInput, bootstrapOutput], {
    env: isolatedEnvironment(),
  });
  await rm(bootstrapInput, { force: true });
  return JSON.parse(await readFile(bootstrapOutput, 'utf8'));
}

async function compose(stack, args, options = {}) {
  const composeArgs = ['compose'];
  if (stack.composeEnvFile !== undefined) composeArgs.push('--env-file', stack.composeEnvFile);
  composeArgs.push('-f', composeFile, '--project-name', stack.project, ...args);
  return await runCommand('docker', composeArgs, {
    ...options,
    env: gate02bGuardRequired ? { ...process.env,
      GENEWAY_BACKUP_POSTGRES_PORT: String(stack.composePostgresPort),
      GENEWAY_BACKUP_S3_PORT: String(stack.composeS3Port),
    } : process.env,
  });
}

async function startStackProxy(stack, service, network, listenPort, targetPort) {
  return await startChild(`loopback-proxy-${stack.label}-${service}`, process.execPath, [
    join(scriptDirectory, 'gate02b-loopback-proxy.mjs'), '--control', gate02bProxyRunRoot, service, stack.project,
    service, `${stack.project}_${network}`, String(listenPort), String(targetPort), gate02bGuardLibrary,
  ], isolatedEnvironment(), async (handle) => handle.output().includes('"ready":true'), { controlPipe: true });
}

async function startStack(stack) {
  const pullPolicy = gate02bGuardRequired ? ['--pull', 'never'] : [];
  await compose(stack, ['up', '-d', '--wait', ...pullPolicy, 'postgres', 'versitygw']);
  if (gate02bGuardRequired) {
    stack.proxyHandles = [];
    try {
      stack.proxyHandles.push(await startStackProxy(stack, 'postgres', 'default', stack.postgresPort, 5432));
      stack.proxyHandles.push(await startStackProxy(stack, 'versitygw', 'default', stack.s3Port, 7070));
    } catch (cause) {
      for (const handle of stack.proxyHandles) await handle.stop();
      stack.proxyHandles = [];
      throw cause;
    }
  }
  await record('stack.started', { label: stack.label, project: stack.project });
}

async function stopStackProxies(stack) {
  for (const handle of stack.proxyHandles ?? []) await handle.stop();
  stack.proxyHandles = [];
}

async function destroyStack(stack, receiptName) {
  await stopStackProxies(stack);
  await compose(stack, ['down', '--volumes', '--remove-orphans']);
  const queries = await Promise.all([
    runCommand('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${stack.project}`]),
    runCommand('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${stack.project}`]),
    runCommand('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${stack.project}`]),
  ]);
  const receipt = {
    at: new Date().toISOString(),
    project: stack.project,
    remainingContainerIds: queries[0].stdout === '' ? [] : queries[0].stdout.split('\n'),
    remainingVolumeNames: queries[1].stdout === '' ? [] : queries[1].stdout.split('\n'),
    remainingNetworkIds: queries[2].stdout === '' ? [] : queries[2].stdout.split('\n'),
  };
  receipt.destroyed = receipt.remainingContainerIds.length === 0
    && receipt.remainingVolumeNames.length === 0
    && receipt.remainingNetworkIds.length === 0;
  await writeJson(join(rehearsalRoot, receiptName), receipt);
  if (!receipt.destroyed) throw new Error(`Disposable ${stack.label} resources survived docker compose down --volumes`);
  await record('stack.destroyed', { label: stack.label, project: stack.project });
  await rm(stack.credentialsRoot, { recursive: true, force: true });
  return receipt;
}

function s3Client(stack, role = 'backup') {
  const credentials = role === 'admin'
    ? { accessKeyId: stack.adminAccessKeyId, secretAccessKey: stack.adminSecretAccessKey }
    : role === 'oracle'
      ? { accessKeyId: stack.oracleAccessKeyId, secretAccessKey: stack.oracleSecretAccessKey }
      : { accessKeyId: stack.backupAccessKeyId, secretAccessKey: stack.backupSecretAccessKey };
  const client = new S3Client({
    endpoint: stack.s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 5,
    credentials,
  });
  storageClients.add(client);
  return client;
}

async function provisionStorageIdentities(stack) {
  const identities = [
    [stack.appAccessKeyId, stack.appSecretAccessKey, '1001'],
    [stack.reconcilerAccessKeyId, stack.reconcilerSecretAccessKey, '1002'],
    [stack.oracleAccessKeyId, stack.oracleSecretAccessKey, '1003'],
    [stack.backupAccessKeyId, stack.backupSecretAccessKey, '1004'],
  ];
  for (const [access, secret, id] of identities) {
    await compose(stack, ['exec', '-T', 'versitygw', 'versitygw', 'admin',
      '--access', stack.adminAccessKeyId, '--secret', stack.adminSecretAccessKey,
      '--endpoint-url', 'http://127.0.0.1:7071', 'create-user',
      '--access', access, '--secret', secret, '--role', 'user',
      '--user-id', id, '--group-id', id, '--project-id', id]);
  }
  const denied = await compose(stack, ['exec', '-T', 'versitygw', 'versitygw', 'admin',
    '--access', stack.appAccessKeyId, '--secret', stack.appSecretAccessKey,
    '--endpoint-url', 'http://127.0.0.1:7071', 'list-users'], { allowFailure: true });
  if (denied.code === 0) throw new Error('Online storage identity unexpectedly accessed the VersityGW admin API');
  await record('storage.identities-provisioned', { project: stack.project, service: 'versitygw', actions: ['create-user', 'list-users-denied'] });
}

async function provisionStorageData(stack) {
  await runCommand(join(repositoryRoot, 'node_modules', '.bin', 'tsx'), ['scripts/provision-storage.ts'], {
    env: isolatedEnvironment({
      GENEWAY_S3_ENDPOINT: stack.s3Endpoint,
      GENEWAY_S3_BUCKET: bucket,
      GENEWAY_S3_REGION: 'us-east-1',
      GENEWAY_S3_ADMIN_ACCESS_KEY_ID: stack.adminAccessKeyId,
      GENEWAY_S3_ADMIN_SECRET_ACCESS_KEY: stack.adminSecretAccessKey,
      GENEWAY_S3_APP_ACCESS_KEY_ID: stack.appAccessKeyId,
      GENEWAY_S3_RECONCILER_ACCESS_KEY_ID: stack.reconcilerAccessKeyId,
      GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID: stack.oracleAccessKeyId,
      GENEWAY_S3_BACKUP_ACCESS_KEY_ID: stack.backupAccessKeyId,
    }),
  });
  await record('storage.provisioned', { label: stack.label, roles: ['online', 'reconciler', 'oracle', 'backup'] });
}

async function provisionStorage(stack) {
  await provisionStorageIdentities(stack);
  await provisionStorageData(stack);
}

async function migrateSource(stack) {
  await runCommand(join(repositoryRoot, 'node_modules', '.bin', 'tsx'), ['scripts/migrate.ts'], {
    env: isolatedEnvironment({ DATABASE_URL: stack.databaseUrl }),
  });
  await record('source.migrated', { migrations: ['0001', '0002', '0003', '0004'] });
}

async function withPool(stack, callback) {
  const pool = new Pool({ connectionString: stack.databaseUrl, max: 2 });
  try {
    return await callback(pool);
  } finally {
    await pool.end();
  }
}

async function startApplication(stack) {
  await rm(stack.socketPath, { force: true });
  const storage = await startContainerRoleService({ label: `${stack.label}-storage-adapter`, role: 'online-storage',
    stack, roleEnvironmentPath: stack.roleFiles['online-storage-env'], command: '/workspace/node_modules/.bin/tsx',
    args: ['scripts/storage-adapter.ts'], networkMode: 'host', ready: async () => {
      try { return (await fetch(`${stack.storageAdapterUrl}/health`)).ok; } catch { return false; }
    } });
  let controlPlane;
  try {
    controlPlane = await startContainerRoleService({ label: `${stack.label}-control-plane`, role: 'control-plane',
      stack, roleEnvironmentPath: stack.roleFiles['control-plane-env'], command: '/workspace/node_modules/.bin/tsx',
      args: ['apps/control-plane/src/main.ts'], networkMode: 'host', runtime: true, token: true, ready: async () => {
        try { return (await fetch(`${stack.controlPlaneUrl}/health`)).ok; } catch { return false; }
      } });
  } catch (error) {
    await storage.stop();
    throw error;
  }
  return {
    storage,
    controlPlane,
    async stop() {
      await controlPlane.stop();
      await storage.stop();
      await rm(stack.socketPath, { force: true });
      await rm(stack.tokenFile, { force: true });
    },
  };
}

async function startWorker(stack, suffix) {
  const worker = await startContainerRoleService({ label: `${stack.label}-worker-${suffix}`, role: 'worker',
    stack, roleEnvironmentPath: stack.roleFiles['worker-env'], command: '/workspace/node_modules/.bin/tsx',
    args: ['apps/worker/src/main.ts'], networkMode: 'none', runtime: true, token: true,
    environment: { GENEWAY_WORKER_INSTANCE_ID: `backup-worker-${stack.label}-${suffix}` },
    ready: async (handle) => handle.output().includes('GENEWAY_WORKER_READY') });
  const probe = await runCommand('docker', ['exec', worker.containerName, 'node', '-e',
    "fetch(process.argv[1]).then(()=>process.exit(9),()=>process.exit(0))", `${stack.s3Endpoint}/health`],
  { allowFailure: true });
  const inspection = JSON.parse((await runCommand('docker', ['inspect', worker.containerName])).stdout)[0];
  await writeJson(join(rehearsalRoot, 'process-boundaries', `${stack.label}-worker-${suffix}-network.json`), {
    schemaVersion: 'geneway-backup-worker-network-boundary/1',
    role: 'worker-network',
    containerName: worker.containerName,
    networkMode: inspection.HostConfig.NetworkMode,
    attemptedUrl: `${stack.s3Endpoint}/health`,
    directRouteSucceeded: probe.code === 9,
    checked: inspection.HostConfig.NetworkMode === 'none' && probe.code === 0,
    forbiddenNamesPresent: inspection.HostConfig.NetworkMode === 'none' && probe.code === 0 ? [] : ['s3-network-route'],
  });
  if (inspection.HostConfig.NetworkMode !== 'none' || probe.code !== 0) {
    await worker.stop();
    throw new Error('Worker container unexpectedly reached the S3 endpoint');
  }
  return worker;
}

async function api(stack, method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body = options.body;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const response = await fetch(new URL(path, stack.controlPlaneUrl), { method, headers, body });
  const bytes = Buffer.from(await response.arrayBuffer());
  let payload = null;
  if ((response.headers.get('content-type') ?? '').includes('application/json') && bytes.length > 0) {
    payload = JSON.parse(bytes.toString('utf8'));
  }
  return { status: response.status, headers: response.headers, bytes, payload };
}

function expectResponse(response, status, code) {
  if (response.status !== status) {
    throw new Error(`Expected HTTP ${status}, received ${response.status}: ${JSON.stringify(response.payload)}`);
  }
  if (code !== undefined && response.payload?.error?.code !== code) {
    throw new Error(`Expected ${code}, received ${JSON.stringify(response.payload)}`);
  }
  return response.payload;
}

async function createConversation(stack, key) {
  return expectResponse(await api(stack, 'POST', '/api/conversations', {
    headers: { 'idempotency-key': key },
  }), 201).id;
}

async function uploadFixture(stack, conversationId, key, bytes) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'text/plain' }), 'solution-analysis-demo-v2.txt');
  return expectResponse(await api(stack, 'POST', `/api/conversations/${conversationId}/uploads`, {
    headers: { 'idempotency-key': key },
    body: form,
  }), 201);
}

async function createTask(stack, conversationId, documentSnapshotId, key, expertTarget = { mode: 'team', teamId: 'team.solution.core' }) {
  return expectResponse(await api(stack, 'POST', '/api/business-tasks', {
    headers: { 'idempotency-key': key },
    json: {
      conversationId,
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'document_snapshot', documentSnapshotId },
      expertTarget,
    },
  }), 201);
}

async function approveTask(stack, approvalId, key, expected = 200) {
  return await api(stack, 'POST', `/api/approvals/${approvalId}/decisions`, {
    headers: { 'idempotency-key': key },
    json: { decision: 'approved' },
  }).then((response) => expectedResponse(response, expected));
}

function expectedResponse(response, expected) {
  if (response.status !== expected) throw new Error(`Expected HTTP ${expected}, received ${response.status}: ${JSON.stringify(response.payload)}`);
  return response;
}

async function executeTask(stack, taskId, key, expected = 200) {
  const snapshot = await taskSnapshot(stack, taskId);
  return await api(stack, 'POST', `/api/business-tasks/${taskId}/execute`, {
    headers: { 'idempotency-key': key },
    json: {
      expectedApprovalVersion: snapshot.approval.version,
      expectedApprovalSubjectDigest: snapshot.approval.subjectDigest,
    },
  }).then((response) => expectedResponse(response, expected));
}

async function taskSnapshot(stack, taskId) {
  return expectResponse(await api(stack, 'GET', `/api/business-tasks/${taskId}`), 200);
}

async function waitForTaskStatus(stack, taskId, statuses, timeoutMs = 30_000) {
  let snapshot;
  await waitFor(async () => {
    snapshot = await taskSnapshot(stack, taskId);
    return statuses.includes(snapshot.status);
  }, timeoutMs, `task ${taskId} status ${statuses.join('|')}`);
  return snapshot;
}

async function workerCommand(stack, command) {
  const body = JSON.stringify(command);
  return await new Promise((resolveCommand, reject) => {
    const request = httpRequest({
      socketPath: stack.socketPath,
      path: '/internal/worker/v1/commands',
      method: 'POST',
      headers: {
        authorization: `Bearer ${stack.workerToken}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        const bytes = Buffer.concat(chunks);
        try {
          resolveCommand({ status: response.statusCode ?? 0, payload: bytes.length === 0 ? null : JSON.parse(bytes.toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function queryDatabaseInventory(queryable) {
  const result = await queryable.query(`SELECT
        m.tenant_id,m.id manifest_id,m.storage_bucket,m.storage_key,m.size_bytes::text manifest_size_bytes,
        m.content_sha256 manifest_content_sha256,m.media_type,
        a.id artifact_id,a.kind artifact_kind,a.size_bytes::text artifact_size_bytes,
        a.content_sha256 artifact_content_sha256,
        s.availability,s.integrity,s.retention_status,s.reconcile_status,s.etag_observed,
        i.status ingest_status,r.status report_status,
        CASE WHEN s.availability='active' AND s.integrity='verified' AND s.retention_status='active'
          AND s.retention_expires_at > now() AND s.reconcile_status='in_sync'
          AND ((a.kind='source_document' AND i.status='ready') OR (a.kind='simulation_report' AND r.status='published'))
          THEN true ELSE false END object_authorized
      FROM artifact_manifests m
      JOIN artifacts a ON a.tenant_id=m.tenant_id AND a.id=m.artifact_id
      LEFT JOIN artifact_states s ON s.tenant_id=m.tenant_id AND s.artifact_id=m.artifact_id
      LEFT JOIN artifact_ingest_intents i ON i.tenant_id=m.tenant_id AND i.manifest_id=m.id
      LEFT JOIN report_publish_intents r ON r.tenant_id=m.tenant_id AND r.manifest_id=m.id
      ORDER BY m.storage_bucket,m.storage_key`);
  return result.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      manifestId: String(row.manifest_id),
      storageBucket: String(row.storage_bucket),
      storageKey: String(row.storage_key),
      manifestSizeBytes: Number(row.manifest_size_bytes),
      manifestContentSha256: String(row.manifest_content_sha256),
      mediaType: String(row.media_type),
      artifactId: String(row.artifact_id),
      artifactKind: String(row.artifact_kind),
      artifactSizeBytes: Number(row.artifact_size_bytes),
      artifactContentSha256: String(row.artifact_content_sha256),
      availability: row.availability === null ? null : String(row.availability),
      integrity: row.integrity === null ? null : String(row.integrity),
      retentionStatus: row.retention_status === null ? null : String(row.retention_status),
      reconcileStatus: row.reconcile_status === null ? null : String(row.reconcile_status),
      eTagObserved: row.etag_observed === null ? null : String(row.etag_observed),
      ingestStatus: row.ingest_status === null ? null : String(row.ingest_status),
      reportStatus: row.report_status === null ? null : String(row.report_status),
    objectAuthorized: Boolean(row.object_authorized),
  }));
}

async function readDatabaseInventory(stack) {
  return await withPool(stack, (pool) => queryDatabaseInventory(pool));
}

async function readStorageHazards(queryable) {
  const result = await queryable.query(`SELECT storage_bucket,storage_key,status,reason_code
    FROM storage_orphan_tombstones WHERE status='delete_pending' ORDER BY storage_bucket,storage_key`);
  return result.rows.map((row) => ({
    storageBucket: String(row.storage_bucket),
    storageKey: String(row.storage_key),
    status: String(row.status),
    reasonCode: String(row.reason_code),
  }));
}

async function bodyBytes(body) {
  if (body === undefined) throw new Error('S3 returned an empty object body');
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function captureObjectInventory(client, objectDirectory) {
  const listed = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const item of page.Contents ?? []) {
      if (item.Key === undefined) throw new Error('VersityGW listed an object without a key');
      listed.push({ key: item.Key, listedSize: Number(item.Size ?? -1), listedETag: item.ETag ?? null });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);
  listed.sort((left, right) => left.key.localeCompare(right.key));
  const inventory = [];
  for (const [index, item] of listed.entries()) {
    const [head, object] = await Promise.all([
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: item.key })),
      client.send(new GetObjectCommand({ Bucket: bucket, Key: item.key })),
    ]);
    const bytes = await bodyBytes(object.Body);
    const contentSha256 = sha256(bytes);
    let backupRelativePath = null;
    if (objectDirectory !== null) {
      const path = join(objectDirectory, `${String(index).padStart(4, '0')}-${contentSha256.slice(0, 16)}.bin`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { mode: 0o600 });
      backupRelativePath = relative(rehearsalRoot, path);
    }
    inventory.push({
      key: item.key,
      sizeBytes: bytes.length,
      listedSizeBytes: item.listedSize,
      headSizeBytes: Number(head.ContentLength ?? -1),
      contentSha256,
      metadataContentSha256: head.Metadata?.['content-sha256'] ?? null,
      mediaType: head.ContentType ?? null,
      eTag: head.ETag ?? object.ETag ?? item.listedETag,
      backupRelativePath,
    });
  }
  return inventory;
}

function compareInventories(databaseInventory, objectInventory, storageHazards = []) {
  const findings = [];
  const objectByKey = new Map();
  const databaseByKey = new Map();
  for (const object of objectInventory) {
    if (objectByKey.has(object.key)) findings.push({ code: 'DUPLICATE_S3_KEY', key: object.key });
    objectByKey.set(object.key, object);
  }
  for (const record of databaseInventory) {
    if (databaseByKey.has(record.storageKey)) findings.push({ code: 'DUPLICATE_DB_STORAGE_KEY', key: record.storageKey });
    databaseByKey.set(record.storageKey, record);
    if (record.storageBucket !== bucket) findings.push({ code: 'UNEXPECTED_BUCKET', key: record.storageKey });
    if (record.manifestSizeBytes !== record.artifactSizeBytes) findings.push({ code: 'DB_SIZE_MISMATCH', key: record.storageKey });
    if (record.manifestContentSha256 !== record.artifactContentSha256) findings.push({ code: 'DB_HASH_MISMATCH', key: record.storageKey });
    if (!record.objectAuthorized) findings.push({ code: 'DB_OBJECT_NOT_ACTIVE', key: record.storageKey });
    const object = objectByKey.get(record.storageKey);
    if (record.objectAuthorized && object === undefined) {
      findings.push({ code: 'PG_OBJECT_MISSING_IN_S3', key: record.storageKey });
      continue;
    }
    if (object === undefined) continue;
    if (object.sizeBytes !== object.listedSizeBytes || object.sizeBytes !== object.headSizeBytes) {
      findings.push({ code: 'S3_SIZE_OBSERVATION_MISMATCH', key: record.storageKey });
    }
    if (object.sizeBytes !== record.manifestSizeBytes) findings.push({ code: 'OBJECT_SIZE_MISMATCH', key: record.storageKey });
    if (object.contentSha256 !== record.manifestContentSha256) findings.push({ code: 'OBJECT_HASH_MISMATCH', key: record.storageKey });
    if (object.metadataContentSha256 !== object.contentSha256) findings.push({ code: 'OBJECT_METADATA_HASH_MISMATCH', key: record.storageKey });
  }
  for (const object of objectInventory) {
    const record = databaseByKey.get(object.key);
    if (record === undefined) findings.push({ code: 'S3_OBJECT_MISSING_IN_PG', key: object.key });
    else if (!record.objectAuthorized) findings.push({ code: 'S3_OBJECT_HAS_NO_ACTIVE_AUTHORITY', key: object.key });
  }
  for (const hazard of storageHazards) {
    findings.push({ code: 'UNRESOLVED_ORPHAN_DELETE', key: hazard.storageKey, status: hazard.status });
    if (objectByKey.has(hazard.storageKey)) findings.push({ code: 'TOMBSTONED_OBJECT_STILL_LIVE', key: hazard.storageKey });
  }
  return { clean: findings.length === 0, findings };
}

async function enterSourceBarrier(stack) {
  backupSetId = `backup-set-${randomUUID()}`;
  const drain = await withPool(stack, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('geneway'),hashtext('storage-write-gate'))");
      const pending = await client.query(`SELECT
        (SELECT count(*)::text FROM artifact_ingest_intents
          WHERE status IN ('intent_created','put_inflight','object_verified','reconcile_required','delete_pending')) ingest_pending,
        (SELECT count(*)::text FROM report_publish_intents
          WHERE status IN ('prepared','object_verified','reconcile_required','delete_pending')) report_pending,
        (SELECT count(*)::text FROM storage_orphan_tombstones
          WHERE status='delete_pending') orphan_delete_pending`);
      const row = pending.rows[0];
      if (row === undefined || Number(row.ingest_pending) !== 0 || Number(row.report_pending) !== 0
        || Number(row.orphan_delete_pending) !== 0) {
        throw new Error('Backup barrier could not drain non-terminal object intents');
      }
      await client.query(`INSERT INTO backup_sets (id,status,source_cluster_id)
        VALUES ($1,'preparing',$2)`, [backupSetId, stack.project]);
      await client.query(`INSERT INTO platform_write_barriers
        (id,backup_set_id,active,reads_blocked,writes_blocked) VALUES (true,$1,true,false,true)`, [backupSetId]);
      await client.query('COMMIT');
      return { ingestPending: 0, reportPending: 0, orphanDeletePending: 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });
  await writeJson(join(backupRoot, 'source-backup-barrier.json'), {
    at: new Date().toISOString(), authority: 'postgres.platform_write_barriers', backupSetId,
    status: 'preparing', writesBlocked: true, readsBlocked: false, drain,
  });
  await record('source.barrier.entered', { backupSetId, ...drain });
}

async function recordPostgresCheckpoint(stack) {
  return await withPool(stack, async (pool) => {
    await pool.query('CHECKPOINT');
    const checkpoint = await pool.query(`SELECT pg_current_wal_lsn()::text wal_lsn,
      pg_current_wal_insert_lsn()::text insert_lsn,pg_current_wal_flush_lsn()::text flush_lsn`);
    const watermark = await pool.query(`SELECT coalesce(max(cursor),0)::text cursor,
      count(*)::text event_count FROM business_task_events`);
    const result = {
      recordedAt: new Date().toISOString(),
      walLsn: checkpoint.rows[0].wal_lsn,
      insertLsn: checkpoint.rows[0].insert_lsn,
      flushLsn: checkpoint.rows[0].flush_lsn,
      businessTaskEventWatermark: Number(watermark.rows[0].cursor),
      businessTaskEventCount: Number(watermark.rows[0].event_count),
    };
    await writeJson(join(backupRoot, 'postgres-checkpoint.json'), result);
    return result;
  });
}

async function exportDatabase(stack, destination, snapshot) {
  await runCommandToFile('pg_dump', [
    '--dbname', stack.databaseUrl,
    '--format=custom', '--no-owner', '--no-acl', '--snapshot', snapshot,
  ], destination);
}

async function restoreDatabase(stack, source) {
  await runCommandFromFile('pg_restore', [
    '--dbname', stack.databaseUrl,
    '--exit-on-error', '--no-owner', '--no-acl',
  ], source);
}

async function sealAndBuildBackup(stack, client) {
  const checkpoint = await recordPostgresCheckpoint(stack);
  const objectInventory = await captureObjectInventory(client, join(backupRoot, 'objects'));
  const objectInventorySha256 = sha256(Buffer.from(stableStringify(objectInventory.map((item) => ({
    key: item.key, sizeBytes: item.sizeBytes, contentSha256: item.contentSha256,
    metadataContentSha256: item.metadataContentSha256, mediaType: item.mediaType,
  })))));
  const beforeWatermark = await withPool(stack, async (pool) => {
    const watermark = await pool.query('SELECT coalesce(max(cursor),0)::text cursor FROM business_task_events');
    const watermarkValue = Number(watermark.rows[0].cursor);
    const clientConnection = await pool.connect();
    try {
      await clientConnection.query('BEGIN');
      await clientConnection.query("SELECT pg_advisory_xact_lock(hashtext('geneway'),hashtext('storage-write-gate'))");
      const changed = await clientConnection.query(`UPDATE backup_sets SET status='sealed',checkpoint_lsn=$2,
        event_watermark=$3,object_inventory_sha256=$4,updated_at=now()
        WHERE id=$1 AND status='preparing'`, [backupSetId, checkpoint.walLsn,
        watermarkValue, objectInventorySha256]);
      if (changed.rowCount !== 1) throw new Error('Backup set preparing -> sealed CAS failed');
      await clientConnection.query('COMMIT');
      return watermarkValue;
    } catch (error) {
      await clientConnection.query('ROLLBACK');
      throw error;
    } finally { clientConnection.release(); }
  });
  const dumpPath = join(backupRoot, 'postgres.dump');
  let databaseInventory;
  let storageHazards;
  let exportedSnapshot;
  await withPool(stack, async (pool) => {
    const clientConnection = await pool.connect();
    try {
      await clientConnection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      exportedSnapshot = (await clientConnection.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot;
      const snapshotWatermark = Number((await clientConnection.query(
        'SELECT coalesce(max(cursor),0)::text cursor FROM business_task_events',
      )).rows[0].cursor);
      if (snapshotWatermark !== beforeWatermark) throw new Error('Business event watermark changed before the exported backup snapshot');
      databaseInventory = await queryDatabaseInventory(clientConnection);
      storageHazards = await readStorageHazards(clientConnection);
      await exportDatabase(stack, dumpPath, exportedSnapshot);
      await clientConnection.query('COMMIT');
    } catch (error) {
      await clientConnection.query('ROLLBACK');
      throw error;
    } finally { clientConnection.release(); }
  });
  const afterWatermark = await withPool(stack, async (pool) => Number((await pool.query(
    'SELECT coalesce(max(cursor),0)::text cursor FROM business_task_events',
  )).rows[0].cursor));
  if (afterWatermark !== beforeWatermark) throw new Error('Business event watermark changed during the exported backup snapshot');
  checkpoint.businessTaskEventWatermark = beforeWatermark;
  await writeJson(join(backupRoot, 'postgres-checkpoint.json'), { ...checkpoint, exportedSnapshot });
  const sourceIntegrity = compareInventories(databaseInventory, objectInventory, storageHazards);
  await writeJson(join(backupRoot, 'source-integrity.json'), { ...sourceIntegrity, exportedSnapshot, storageHazards });
  if (!sourceIntegrity.clean || databaseInventory.length !== 2 || objectInventory.length !== 2) {
    throw new Error('Source PostgreSQL/S3 inventory is not the expected source/report pair');
  }
  const dumpBytes = await readFile(dumpPath);
  const core = {
    formatVersion: 'geneway-backup-rehearsal/2',
    backupSetId,
    createdAt: new Date().toISOString(),
    sourceProject: stack.project,
    checkpoint,
    exportedSnapshot,
    objectInventorySha256,
    databaseDump: { relativePath: relative(rehearsalRoot, dumpPath), sizeBytes: dumpBytes.length, contentSha256: sha256(dumpBytes) },
    databaseInventory,
    objectInventory,
  };
  const manifest = { ...core, manifestSha256: sha256(Buffer.from(stableStringify(core))) };
  await writeJson(join(backupRoot, 'backup-manifest.json'), manifest);
  await record('backup.exported', { backupSetId, walLsn: checkpoint.walLsn,
    eventWatermark: checkpoint.businessTaskEventWatermark, objectCount: objectInventory.length });
  return manifest;
}

async function validateBackupManifest(manifest) {
  const { manifestSha256, ...core } = manifest;
  if (sha256(Buffer.from(stableStringify(core))) !== manifestSha256) throw new Error('Backup manifest digest mismatch');
  const dumpBytes = await readFile(join(rehearsalRoot, manifest.databaseDump.relativePath));
  if (dumpBytes.length !== manifest.databaseDump.sizeBytes || sha256(dumpBytes) !== manifest.databaseDump.contentSha256) {
    throw new Error('PostgreSQL dump does not match backup manifest');
  }
  for (const object of manifest.objectInventory) {
    if (object.backupRelativePath === null) throw new Error(`Backup object ${object.key} has no byte archive`);
    const bytes = await readFile(join(rehearsalRoot, object.backupRelativePath));
    if (bytes.length !== object.sizeBytes || sha256(bytes) !== object.contentSha256) {
      throw new Error(`Archived object ${object.key} does not match backup manifest`);
    }
  }
  await writeJson(join(verificationRoot, 'backup-manifest-validation.json'), {
    at: new Date().toISOString(), valid: true, manifestSha256, objectCount: manifest.objectInventory.length,
  });
}

async function proveTargetEmpty(stack, client) {
  const publicTableCount = await withPool(stack, async (pool) => {
    const result = await pool.query(`SELECT count(*)::text count FROM information_schema.tables WHERE table_schema='public'`);
    return Number(result.rows[0].count);
  });
  const buckets = await client.send(new ListBucketsCommand({}));
  const bucketNames = (buckets.Buckets ?? []).map((item) => item.Name).filter((name) => name !== undefined);
  const receipt = { at: new Date().toISOString(), publicTableCount, bucketNames,
    empty: publicTableCount === 0 && bucketNames.length === 0 };
  await writeJson(join(verificationRoot, 'target-empty-before-restore.json'), receipt);
  if (!receipt.empty) throw new Error('Restore target is not empty');
}

async function restoreObjects(client, manifest) {
  for (const object of manifest.objectInventory) {
    const bytes = await readFile(join(rehearsalRoot, object.backupRelativePath));
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: object.key,
      Body: bytes,
      ContentType: object.mediaType ?? 'application/octet-stream',
      Metadata: { 'content-sha256': object.contentSha256 },
    }));
  }
}

async function transitionRestoreState(stack, expected, next, options = {}) {
  await withPool(stack, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('geneway'),hashtext('storage-write-gate'))");
      const changed = await client.query(`UPDATE backup_sets SET status=$3,target_cluster_id=coalesce(target_cluster_id,$4),
        failure_code=$5,updated_at=now() WHERE id=$1 AND status=$2`,
      [backupSetId, expected, next, stack.project, options.failureCode ?? null]);
      if (changed.rowCount !== 1) throw new Error(`Backup set ${expected} -> ${next} CAS failed`);
      if (next === 'restoring') {
        const gate = await client.query(`UPDATE platform_write_barriers SET reads_blocked=true
          WHERE id=true AND backup_set_id=$1 AND active AND writes_blocked`, [backupSetId]);
        if (gate.rowCount !== 1) throw new Error('Restore read gate activation failed');
      } else if (next === 'open') {
        const gate = await client.query(`DELETE FROM platform_write_barriers
          WHERE id=true AND backup_set_id=$1 AND active AND writes_blocked AND reads_blocked`, [backupSetId]);
        if (gate.rowCount !== 1) throw new Error('Restore gate open CAS failed');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });
  await record('backup-set.transitioned', { backupSetId, expected, next });
}

async function injectNegativeCase(stack, client, sourceManifest) {
  if (selectedCase === 'success') return;
  if (selectedCase === 'missing-object') {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceManifest.storageKey }));
    await writeJson(join(verificationRoot, 'negative-injection.json'), {
      at: new Date().toISOString(), case: selectedCase, mutation: 'object deleted after restore', key: sourceManifest.storageKey,
    });
    return;
  }
  await withPool(stack, async (pool) => {
    const clientConnection = await pool.connect();
    try {
      await clientConnection.query('BEGIN');
      await clientConnection.query('ALTER TABLE artifact_manifests DISABLE TRIGGER artifact_manifests_immutable');
      const changed = await clientConnection.query(`UPDATE artifact_manifests SET content_sha256=$3
        WHERE tenant_id=$1 AND id=$2`, [sourceManifest.tenantId, sourceManifest.manifestId, '0'.repeat(64)]);
      await clientConnection.query('ALTER TABLE artifact_manifests ENABLE TRIGGER artifact_manifests_immutable');
      if (changed.rowCount !== 1) throw new Error('Manifest fault injection did not alter one source manifest');
      await clientConnection.query('COMMIT');
    } catch (error) {
      await clientConnection.query('ROLLBACK');
      throw error;
    } finally { clientConnection.release(); }
  });
  await writeJson(join(verificationRoot, 'negative-injection.json'), {
    at: new Date().toISOString(), case: selectedCase,
    mutation: 'restored immutable manifest hash altered by privileged fault injector', manifestId: sourceManifest.manifestId,
  });
}

async function verifyTarget(stack, client) {
  const { databaseInventory, storageHazards } = await withPool(stack, async (pool) => ({
    databaseInventory: await queryDatabaseInventory(pool),
    storageHazards: await readStorageHazards(pool),
  }));
  const objectInventory = await captureObjectInventory(client, null);
  const comparison = compareInventories(databaseInventory, objectInventory, storageHazards);
  const verification = {
    at: new Date().toISOString(), scan: 'full-pg-to-s3-and-s3-to-pg',
    eTagPolicy: 'observed-only; original bytes, SHA-256, size, key, and authority state are authoritative',
    databaseInventory, objectInventory, storageHazards, ...comparison,
  };
  await writeJson(join(verificationRoot, 'target-integrity.json'), verification);
  return verification;
}

async function assertFullChain(stack, taskId) {
  const result = await withPool(stack, async (pool) => pool.query(`SELECT
    (SELECT count(*)::text FROM claims WHERE tenant_id=t.tenant_id AND business_task_id=t.id AND status='published') published_claims,
    (SELECT count(*)::text FROM claims WHERE tenant_id=t.tenant_id AND business_task_id=t.id AND status='rejected') rejected_claims,
    (SELECT count(*)::text FROM evidence_items WHERE tenant_id=t.tenant_id AND business_task_id=t.id) evidence_count,
    (SELECT count(*)::text FROM evidence_links WHERE tenant_id=t.tenant_id AND business_task_id=t.id AND relation='supports') evidence_links,
    (SELECT array_agg(relation ORDER BY relation) FROM lineage_records WHERE tenant_id=t.tenant_id AND business_task_id=t.id) lineage_relations,
    (SELECT count(*)::text FROM artifacts WHERE tenant_id=t.tenant_id AND (id=(t.input_snapshot->>'artifactId') OR business_task_id=t.id)) artifact_count,
    (SELECT count(*)::text FROM outbox_deliveries WHERE tenant_id=t.tenant_id AND business_task_id=t.id AND status='completed') completed_deliveries,
    (SELECT count(*)::text FROM inbox_events WHERE tenant_id=t.tenant_id AND business_task_id=t.id AND status='completed') completed_inboxes,
    (SELECT count(*)::text FROM execution_attempts WHERE tenant_id=t.tenant_id AND business_task_id=t.id AND status='completed') completed_attempts,
    (SELECT count(*)::text FROM attempt_output_candidates WHERE tenant_id=t.tenant_id AND business_task_id=t.id) candidates
    FROM business_tasks t WHERE t.tenant_id='tenant_local' AND t.id=$1 AND t.status='completed'`, [taskId]));
  const row = result.rows[0];
  const requiredRelations = ['frozen_as', 'read_by', 'verified_as', 'supports', 'produced', 'rendered_into', 'rendered_with'];
  if (row === undefined || Number(row.published_claims) !== 1 || Number(row.rejected_claims) !== 1
    || Number(row.evidence_count) !== 1 || Number(row.evidence_links) !== 1 || Number(row.artifact_count) !== 2
    || Number(row.completed_deliveries) !== 1 || Number(row.completed_inboxes) !== 1
    || Number(row.completed_attempts) !== 1 || Number(row.candidates) !== 1
    || requiredRelations.some((relation) => !row.lineage_relations.includes(relation))) {
    throw new Error(`Claim/Evidence/Lineage chain is incomplete: ${JSON.stringify(row)}`);
  }
  return row;
}

function stackForRole(stack, role) {
  if (role === 'online') return { label: stack.label, controlPlaneUrl: stack.controlPlaneUrl };
  if (['backup', 'oracle', 'worker-command', 'provision', 'provision-docker'].includes(role)) return {};
  throw new Error(`Unknown backup/restore role ${role}`);
}

async function invokeRole(role, action, stack, data = {}) {
  if (role === 'backup') await proveBackupCannotReachOnlineControlPlane(stack);
  const invocationId = `${role}-${action}-${randomUUID()}`;
  const inputPath = join(rehearsalRoot, 'role-inputs', `${invocationId}.json`);
  const outputPath = join(rehearsalRoot, 'role-outputs', `${invocationId}.json`);
  const credentialFile = role === 'online' ? null
    : role === 'provision-docker' ? stack.roleFiles.provision : stack.roleFiles[role];
  if (role !== 'online' && credentialFile === undefined) {
    throw new Error(`No credential file is configured for ${role}`);
  }
  await writeJson(inputPath, {
    role,
    action,
    stack: stackForRole(stack, role),
    credentialFile,
    data,
    outputPath,
  });
  const containerName = `geneway-br-${projectSuffix}-${role}-${action}-${randomUUID().slice(0, 8)}`.slice(0, 63);
  const mounts = isolatedRoleMounts(stack, credentialFile, {
    runtime: role === 'worker-command',
    compose: (role === 'provision' && !gate02bGuardRequired) || role === 'provision-docker',
  });
  await createRoleContainer({
    name: containerName,
    role,
    action,
    networkMode: ['worker-command', 'provision-docker'].includes(role) ? 'none' : role === 'backup' ? stack.dataNetwork : 'host',
    mounts,
    environment: {
      GENEWAY_RUN_ID: requestedRunId,
      GENEWAY_BACKUP_RESTORE_ROLE: role,
      GENEWAY_BACKUP_RESTORE_ROLE_INPUT: inputPath,
    },
    egressPorts: gate02bHostRolePorts(role, stack),
    command: ['node', '/workspace/scripts/run-backup-restore.mjs', selectedCase],
  });
  try {
    await runCommand('docker', ['start', '--attach', containerName]);
  } finally {
    await removeRoleContainer(containerName);
  }
  const result = JSON.parse(await readFile(outputPath, 'utf8'));
  await rm(inputPath, { force: true });
  if (result.ok !== true) throw new Error(`${role}/${action} failed: ${result.error ?? 'unknown role error'}`);
  return result.value;
}

function assertRoleBoundary(role, stack) {
  const names = Object.keys(stack).sort();
  const forbidden = names.filter((name) => {
    if (role === 'online') return /database|s3|access|secret|token|socket|env/iu.test(name);
    if (role === 'backup') return /admin|app|reconciler|oracle|worker|controlPlane|tokenFile|env/iu.test(name);
    if (role === 'oracle') return /database|admin|app|backup|reconciler|worker|controlPlane|token|env/iu.test(name);
    if (role === 'worker-command') return /database|s3|admin|app|backup|reconciler|oracle|controlPlane|env/iu.test(name);
    return false;
  });
  if (forbidden.length > 0) throw new Error(`${role} role input contains forbidden credential fields: ${forbidden.join(',')}`);
  return { names, forbidden };
}

async function runOnlineRole(action, stack, data) {
  if (action === 'source-main') {
    const fixtureBytes = await readFile(fixturePath);
    const conversationId = await createConversation(stack, `backup-conversation-${randomUUID()}`);
    const uploaded = await uploadFixture(stack, conversationId, `backup-upload-${randomUUID()}`, fixtureBytes);
    const mainTask = await createTask(stack, conversationId, uploaded.documentSnapshot.id, `backup-main-task-${randomUUID()}`);
    await approveTask(stack, mainTask.approvalId, `backup-main-approve-${randomUUID()}`);
    await executeTask(stack, mainTask.taskId, `backup-main-execute-${randomUUID()}`);
    const completed = await waitForTaskStatus(stack, mainTask.taskId, ['completed']);
    const sourceArtifact = completed.artifacts.find((artifact) => artifact.kind === 'source_document');
    const reportArtifact = completed.artifacts.find((artifact) => artifact.kind === 'simulation_report');
    if (sourceArtifact === undefined || reportArtifact === undefined) throw new Error('Completed task lacks the source/report pair');
    const sourceBefore = await api(stack, 'GET', sourceArtifact.downloadUrl);
    const reportBefore = await api(stack, 'GET', reportArtifact.downloadUrl);
    expectResponse(sourceBefore, 200);
    expectResponse(reportBefore, 200);
    if (sha256(sourceBefore.bytes) !== sha256(fixtureBytes) || sha256(reportBefore.bytes) !== reportArtifact.contentSha256) {
      throw new Error('Served source/report bytes do not match their declared identities before backup');
    }
    const sourceBytesPath = join(rehearsalRoot, 'role-data', 'source-before.bin');
    const reportBytesPath = join(rehearsalRoot, 'role-data', 'report-before.bin');
    await mkdir(dirname(sourceBytesPath), { recursive: true });
    await writeFile(sourceBytesPath, sourceBefore.bytes, { mode: 0o600 });
    await writeFile(reportBytesPath, reportBefore.bytes, { mode: 0o600 });
    return { conversationId, uploaded, mainTask, sourceArtifact, reportArtifact,
      sourceHash: sha256(fixtureBytes), sourceBytesPath, reportBytesPath };
  }
  if (action === 'prepare-blocked') {
    const blockedTask = await createTask(stack, data.state.conversationId, data.state.uploaded.documentSnapshot.id,
      `backup-blocked-task-${randomUUID()}`, { mode: 'expert', expertId: 'expert.solution.architect' });
    await approveTask(stack, blockedTask.approvalId, `backup-blocked-approve-${randomUUID()}`);
    return blockedTask;
  }
  if (action === 'source-barrier-probe') {
    const fixtureBytes = await readFile(fixturePath);
    const form = new FormData();
    form.set('file', new Blob([fixtureBytes], { type: 'text/plain' }), 'solution-analysis-demo-v2.txt');
    const blockedUpload = await api(stack, 'POST', `/api/conversations/${data.state.conversationId}/uploads`, {
      headers: { 'idempotency-key': `backup-blocked-upload-${randomUUID()}` }, body: form,
    });
    expectResponse(blockedUpload, 503, 'BACKUP_BARRIER_ACTIVE');
    const sourceDuring = await api(stack, 'GET', data.state.sourceArtifact.downloadUrl);
    const reportDuring = await api(stack, 'GET', data.state.reportArtifact.downloadUrl);
    expectResponse(sourceDuring, 200);
    expectResponse(reportDuring, 200);
    if (!sourceDuring.bytes.equals(await readFile(data.state.sourceBytesPath))
      || !reportDuring.bytes.equals(await readFile(data.state.reportBytesPath))) {
      throw new Error('Backup barrier changed served source/report bytes');
    }
    await executeTask(stack, data.blockedTask.taskId, `backup-blocked-execute-${randomUUID()}`);
    return { upload: { status: blockedUpload.status, code: blockedUpload.payload.error.code }, downloadsAllowed: true };
  }
  if (action === 'create-probes') {
    const { state } = data;
    const pending = await createTask(stack, state.conversationId, state.uploaded.documentSnapshot.id,
      `backup-pending-probe-${randomUUID()}`);
    const approved = await createTask(stack, state.conversationId, state.uploaded.documentSnapshot.id,
      `backup-approved-probe-${randomUUID()}`);
    await approveTask(stack, approved.approvalId, `backup-approved-probe-approval-${randomUUID()}`);
    const approvedSnapshot = await taskSnapshot(stack, approved.taskId);
    const queued = await createTask(stack, state.conversationId, state.uploaded.documentSnapshot.id,
      `backup-queued-probe-${randomUUID()}`);
    await approveTask(stack, queued.approvalId, `backup-queued-probe-approval-${randomUUID()}`);
    await executeTask(stack, queued.taskId, `backup-queued-probe-execute-${randomUUID()}`);
    return { pending, approved: { ...approved, executionAuthority: approvedSnapshot.approval }, queued };
  }
  if (action === 'target-gate') {
    const download = await api(stack, 'GET', data.state.sourceArtifact.downloadUrl);
    expectResponse(download, 503, 'RESTORE_READ_GATE_ACTIVE');
    const approval = await api(stack, 'POST', `/api/approvals/${data.probes.pending.approvalId}/decisions`, {
      headers: { 'idempotency-key': `${data.restoreState}-approval-${randomUUID()}` }, json: { decision: 'approved' },
    });
    expectResponse(approval, 503, 'RESTORE_PLATFORM_GATE_ACTIVE');
    const execute = await api(stack, 'POST', `/api/business-tasks/${data.probes.approved.taskId}/execute`, {
      headers: { 'idempotency-key': `${data.restoreState}-execute-${randomUUID()}` },
      json: {
        expectedApprovalVersion: data.probes.approved.executionAuthority.version,
        expectedApprovalSubjectDigest: data.probes.approved.executionAuthority.subjectDigest,
      },
    });
    expectResponse(execute, 503, 'RESTORE_PLATFORM_GATE_ACTIVE');
    return { download: { status: download.status, code: download.payload.error.code },
      approval: { status: approval.status, code: approval.payload.error.code },
      execute: { status: execute.status, code: execute.payload.error.code } };
  }
  if (action === 'open') {
    const restoredSource = await api(stack, 'GET', data.state.sourceArtifact.downloadUrl);
    const restoredReport = await api(stack, 'GET', data.state.reportArtifact.downloadUrl);
    expectResponse(restoredSource, 200);
    expectResponse(restoredReport, 200);
    if (!restoredSource.bytes.equals(await readFile(data.state.sourceBytesPath))
      || !restoredReport.bytes.equals(await readFile(data.state.reportBytesPath))) {
      throw new Error('Served source/report bytes changed after restore gate opened');
    }
    const restoredTask = await taskSnapshot(stack, data.state.mainTask.taskId);
    if (restoredTask.status !== 'completed' || restoredTask.claims.length !== 2 || restoredTask.evidence.length !== 1) {
      throw new Error('Restored task projection lost Claim/Evidence state');
    }
    return { sourceSha256: sha256(restoredSource.bytes), reportSha256: sha256(restoredReport.bytes),
      claims: restoredTask.claims.length, evidence: restoredTask.evidence.length, lineage: restoredTask.lineage.length };
  }
  throw new Error(`Unknown online role action ${action}`);
}

async function runBackupRole(action, stack, data) {
  if (action === 'enter-barrier') { await enterSourceBarrier(stack); return { backupSetId }; }
  if (action === 'assert-chain') return await assertFullChain(stack, data.taskId);
  if (action === 'wait-blocked') {
    await waitFor(async () => withPool(stack, async (pool) => {
      const result = await pool.query(`SELECT
        (SELECT count(*)::text FROM business_task_steps WHERE business_task_id=$1 AND status='completed') completed_steps,
        (SELECT count(*)::text FROM report_publish_intents WHERE business_task_id=$1) report_intents,
        (SELECT count(*)::text FROM artifacts WHERE business_task_id=$1 AND kind='simulation_report') report_artifacts,
        (SELECT count(*)::text FROM outbox_deliveries WHERE business_task_id=$1 AND status='leased') leased`, [data.taskId]);
      const row = result.rows[0];
      return Number(row.completed_steps) === 7 && Number(row.report_intents) === 0
        && Number(row.report_artifacts) === 0 && Number(row.leased) === 1;
    }), 30_000, 'Worker report publication blocked by backup barrier');
    return await withPool(stack, async (pool) => (await pool.query(`SELECT d.id delivery_id,d.event_id,a.id attempt_id,
      a.fencing_token::text fencing_token,d.worker_instance_id FROM outbox_deliveries d
      JOIN execution_attempts a ON a.tenant_id=d.tenant_id AND a.id=d.execution_attempt_id
      WHERE d.tenant_id='tenant_local' AND d.business_task_id=$1 AND d.status='leased' AND a.status='running'`, [data.taskId])).rows[0]);
  }
  if (action === 'wait-failed') {
    await waitFor(async () => withPool(stack, async (pool) => {
      const result = await pool.query("SELECT status FROM business_tasks WHERE tenant_id='tenant_local' AND id=$1", [data.taskId]);
      return result.rows[0]?.status === 'failed';
    }), 10_000, `task ${data.taskId} failed settlement`);
    return { failed: true };
  }
  if (action === 'build') {
    backupSetId = data.backupSetId;
    const client = s3Client(stack);
    try { return await sealAndBuildBackup(stack, client); } finally { client.destroy(); }
  }
  if (action === 'validate') { await validateBackupManifest(data.manifest); return { valid: true }; }
  if (action === 'restore') {
    backupSetId = data.backupSetId;
    const client = s3Client(stack);
    try {
      await restoreDatabase(stack, join(rehearsalRoot, data.manifest.databaseDump.relativePath));
      await restoreObjects(client, data.manifest);
      return { restored: true };
    } finally { client.destroy(); }
  }
  if (action === 'transition') {
    backupSetId = data.backupSetId;
    await transitionRestoreState(stack, data.expected, data.next, data.options);
    return { status: data.next };
  }
  if (action === 'verify') {
    const client = s3Client(stack);
    try { return await verifyTarget(stack, client); } finally { client.destroy(); }
  }
  if (action === 'inject-manifest') {
    await injectNegativeCase(stack, null, data.sourceManifest);
    return { injected: true };
  }
  throw new Error(`Unknown backup role action ${action}`);
}

async function runWorkerCommandRole(action, stack, data) {
  if (action === 'settle') {
    const context = data.context;
    const response = await workerCommand(stack, {
      command: 'fail_delivery', protocolVersion: 'gate0.2a-worker-command/1', workerInstanceId: context.worker_instance_id,
      deliveryId: context.delivery_id, eventId: context.event_id, attemptId: context.attempt_id,
      fencingToken: Number(context.fencing_token), code: 'BACKUP_BARRIER_ACTIVE',
      message: 'Report publication was blocked by the authoritative backup barrier',
      idempotencyKey: `backup-barrier-fail-${randomUUID()}`,
    });
    expectResponse(response, 200);
    return { accepted: true };
  }
  if (action === 'target-claim') {
    const claim = await workerCommand(stack, {
      command: 'claim_delivery', protocolVersion: 'gate0.2a-worker-command/1',
      workerInstanceId: `restore-probe-${data.restoreState}`,
      consumer: 'gate0.2a-worker', deploymentId: 'gate0.2a-local',
    });
    expectResponse(claim, 503, 'RESTORE_PLATFORM_GATE_ACTIVE');
    const publish = await workerCommand(stack, {
      command: 'submit_candidate', protocolVersion: 'gate0.2a-worker-command/1',
      workerInstanceId: `restore-publish-probe-${data.restoreState}`,
      deliveryId: 'restore-gate-delivery', eventId: 'restore-gate-event', attemptId: 'restore-gate-attempt',
      fencingToken: 1,
      idempotencyKey: `restore-publish-probe-${data.restoreState}`,
      candidate: {
        evidence: [{ kind: 'legacy_fixture', candidateKey: 'gate-evidence',
          fixtureRef: 'fixture:solution-analysis:v1', fixtureVersion: 1, sourceId: 'restore-gate' }],
        claims: [{ candidateKey: 'gate-claim', text: 'restore gate publish probe',
          evidenceCandidateKey: 'gate-evidence' }],
        result: { kind: 'completed', summary: 'restore gate publish probe', stepSummaries: [],
          simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false },
      },
    });
    expectResponse(publish, 503, 'RESTORE_PLATFORM_GATE_ACTIVE');
    return {
      claim: { status: claim.status, code: claim.payload.error.code },
      publish: { status: publish.status, code: publish.payload.error.code },
    };
  }
  throw new Error(`Unknown Worker-command role action ${action}`);
}

async function runProvisionRole(action, stack) {
  if (action === 'source') {
    await migrateSource(stack);
    await (gate02bGuardRequired ? provisionStorageData(stack) : provisionStorage(stack));
    return { migrated: true, provisioned: true };
  }
  if (action === 'target') {
    const client = s3Client({ ...stack, adminAccessKeyId: stack.adminAccessKeyId,
      adminSecretAccessKey: stack.adminSecretAccessKey }, 'admin');
    try { await proveTargetEmpty(stack, client); } finally { client.destroy(); }
    await (gate02bGuardRequired ? provisionStorageData(stack) : provisionStorage(stack));
    return { empty: true, provisioned: true };
  }
  throw new Error(`Unknown provision role action ${action}`);
}

async function runProvisionDockerRole(action, stack) {
  if (!gate02bGuardRequired || !['source', 'target'].includes(action)) {
    throw new Error(`Unknown provision-docker role action ${action}`);
  }
  await provisionStorageIdentities(stack);
  return { identitiesProvisioned: true };
}

async function runOracleRole(action, stack, data) {
  if (action !== 'delete-object') throw new Error(`Unknown oracle role action ${action}`);
  const client = s3Client(stack, 'oracle');
  try { await injectNegativeCase(stack, client, data.sourceManifest); } finally { client.destroy(); }
  return { injected: true };
}

async function runRoleInvocation() {
  const inputPath = process.env.GENEWAY_BACKUP_RESTORE_ROLE_INPUT;
  if (inputPath === undefined) throw new Error('GENEWAY_BACKUP_RESTORE_ROLE_INPUT is required');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const credentials = input.credentialFile === null
    ? {}
    : JSON.parse(await readFile(input.credentialFile, 'utf8'));
  const roleStack = { ...credentials, ...input.stack };
  const boundary = assertRoleBoundary(input.role, roleStack);
  await writeJson(join(rehearsalRoot, 'process-boundaries', `${input.role}-${input.action}-${process.pid}.json`), {
    schemaVersion: 'geneway-backup-role-boundary/1', role: input.role, action: input.action,
    pid: process.pid, checked: true, credentialFields: boundary.names,
    forbiddenNamesPresent: boundary.forbidden, environmentNames: Object.keys(process.env).sort(),
    startedAt: new Date().toISOString(),
  });
  let value;
  try {
    if (input.role === 'online') value = await runOnlineRole(input.action, roleStack, input.data);
    else if (input.role === 'backup') value = await runBackupRole(input.action, roleStack, input.data);
    else if (input.role === 'worker-command') value = await runWorkerCommandRole(input.action, roleStack, input.data);
    else if (input.role === 'provision') value = await runProvisionRole(input.action, roleStack, input.data);
    else if (input.role === 'provision-docker') value = await runProvisionDockerRole(input.action, roleStack, input.data);
    else if (input.role === 'oracle') value = await runOracleRole(input.action, roleStack, input.data);
    else throw new Error(`Unknown role ${input.role}`);
    await writeJson(input.outputPath, { ok: true, value });
  } catch (error) {
    await writeJson(input.outputPath, { ok: false, error: safeError(error) });
    throw error;
  }
}

async function runRehearsal() {
  await rm(runRoot, { recursive: true, force: true });
  await rm(credentialsRunRoot, { recursive: true, force: true });
  await rm(runtimeRunRoot, { recursive: true, force: true });
  await mkdir(backupRoot, { recursive: true });
  await mkdir(verificationRoot, { recursive: true });
  await ensureRoleImage();
  const coordinatorEnvironmentNames = Object.keys(process.env).sort();
  const forbiddenCoordinatorEnvironmentNames = coordinatorEnvironmentNames.filter((name) =>
    name === 'DATABASE_URL' || name.startsWith('AWS_') || name.startsWith('POSTGRES_')
      || name.startsWith('GENEWAY_S3_') || name.startsWith('GENEWAY_STORAGE_')
      || name.startsWith('GENEWAY_WORKER_') || name.startsWith('GENEWAY_E2E_S3_'));
  await writeJson(join(rehearsalRoot, 'process-boundaries', 'coordinator.json'), {
    schemaVersion: 'geneway-backup-role-boundary/1',
    role: 'coordinator',
    pid: process.pid,
    environmentNames: coordinatorEnvironmentNames,
    forbiddenNamesPresent: forbiddenCoordinatorEnvironmentNames,
    checked: true,
    startedAt: new Date().toISOString(),
  });
  if (forbiddenCoordinatorEnvironmentNames.length > 0) {
    throw new Error(`Coordinator inherited forbidden credential names: ${forbiddenCoordinatorEnvironmentNames.join(',')}`);
  }
  await record('rehearsal.started', { runId: requestedRunId, case: selectedCase,
    authority: 'postgres.backup_sets+platform_write_barriers' });
  sourceStack = await createStack('source');
  targetStack = await createStack('target');
  const publicStackFields = [...new Set([
    ...Object.keys(sourceStack),
    ...Object.keys(targetStack),
  ])].sort();
  const forbiddenStackFields = publicStackFields.filter((name) =>
    /databaseUrl|password|accessKey|secretAccessKey|storageAdapterToken|workerToken/iu.test(name));
  await writeJson(join(rehearsalRoot, 'process-boundaries', 'coordinator-stacks.json'), {
    schemaVersion: 'geneway-backup-role-boundary/1',
    role: 'coordinator',
    publicStackFields,
    forbiddenNamesPresent: forbiddenStackFields,
    credentialReferences: ['composeEnvFile', 'roleFiles'],
    checked: true,
  });
  if (forbiddenStackFields.length > 0) {
    throw new Error(`Coordinator stack metadata contains secret fields: ${forbiddenStackFields.join(',')}`);
  }

  stage = 'source-start';
  await startStack(sourceStack);
  sourceStarted = true;
  if (gate02bGuardRequired) await invokeRole('provision-docker', 'source', sourceStack);
  await invokeRole('provision', 'source', sourceStack);
  let sourceApplication = await startApplication(sourceStack);
  let sourceWorker = await startWorker(sourceStack, 'main');
  const state = await invokeRole('online', 'source-main', sourceStack);
  await invokeRole('backup', 'assert-chain', sourceStack, { taskId: state.mainTask.taskId });
  await sourceWorker.stop();
  const blockedTask = await invokeRole('online', 'prepare-blocked', sourceStack, { state });

  stage = 'backup-barrier';
  const barrier = await invokeRole('backup', 'enter-barrier', sourceStack);
  backupSetId = barrier.backupSetId;
  await invokeRole('online', 'source-barrier-probe', sourceStack, { state, blockedTask });
  sourceWorker = await startWorker(sourceStack, 'barrier');
  const blockedContext = await invokeRole('backup', 'wait-blocked', sourceStack, { taskId: blockedTask.taskId });
  await sourceWorker.stop();
  await invokeRole('worker-command', 'settle', sourceStack, { context: blockedContext });
  await invokeRole('backup', 'wait-failed', sourceStack, { taskId: blockedTask.taskId });
  const probes = await invokeRole('online', 'create-probes', sourceStack, { state });
  await sourceApplication.stop();
  const manifest = await invokeRole('backup', 'build', sourceStack, { backupSetId });

  stage = 'source-destroy';
  sourceDestructionReceipt = await destroyStack(sourceStack, 'source-destruction.json');
  sourceStarted = false;

  stage = 'target-start';
  await startStack(targetStack);
  targetStarted = true;
  if (gate02bGuardRequired) await invokeRole('provision-docker', 'target', targetStack);
  await invokeRole('provision', 'target', targetStack);
  await invokeRole('backup', 'validate', targetStack, { manifest });
  await invokeRole('backup', 'restore', targetStack, { backupSetId, manifest });
  await invokeRole('backup', 'transition', targetStack,
    { backupSetId, expected: 'sealed', next: 'restoring', options: {} });
  const targetApplication = await startApplication(targetStack);
  for (const restoreState of ['restoring', 'verifying']) {
    if (restoreState === 'verifying') {
      await invokeRole('backup', 'transition', targetStack,
        { backupSetId, expected: 'restoring', next: 'verifying', options: {} });
    }
    const onlineGate = await invokeRole('online', 'target-gate', targetStack, { state, probes, restoreState });
    const workerGate = await invokeRole('worker-command', 'target-claim', targetStack, { restoreState });
    await writeJson(join(verificationRoot, `target-${restoreState}-gate.json`), {
      at: new Date().toISOString(), authority: 'postgres.platform_write_barriers',
      state: restoreState, receipts: { ...onlineGate, workerClaim: workerGate },
    });
  }

  const sourceManifest = manifest.databaseInventory.find((item) => item.artifactId === state.sourceArtifact.id);
  if (sourceManifest === undefined) throw new Error('Source manifest is missing from backup inventory');
  if (selectedCase === 'missing-object') {
    await invokeRole('oracle', 'delete-object', targetStack, { sourceManifest });
  } else if (selectedCase === 'manifest-mismatch') {
    await invokeRole('backup', 'inject-manifest', targetStack, { sourceManifest });
  }

  stage = 'target-verify';
  integrityResult = await invokeRole('backup', 'verify', targetStack);
  if (!integrityResult.clean) {
    await invokeRole('backup', 'transition', targetStack, { backupSetId, expected: 'verifying', next: 'failed',
      options: { failureCode: `INTEGRITY_${selectedCase}` } });
    const failedOnlineGate = await invokeRole('online', 'target-gate', targetStack,
      { state, probes, restoreState: 'failed' });
    const failedWorkerGate = await invokeRole('worker-command', 'target-claim', targetStack,
      { restoreState: 'failed' });
    await writeJson(join(verificationRoot, 'target-failed-gate.json'), {
      at: new Date().toISOString(),
      authority: 'postgres.platform_write_barriers',
      backupSetId,
      status: 'failed',
      ...failedOnlineGate,
      worker: failedWorkerGate,
    });
    if (selectedCase === 'success') throw new Error('Restored PostgreSQL/S3 inventory failed bidirectional integrity verification');
    const error = new Error(`NEGATIVE_CASE_DETECTED:${selectedCase}`);
    error.code = 'NEGATIVE_CASE_DETECTED';
    throw error;
  }
  if (selectedCase !== 'success') throw new Error(`Negative case ${selectedCase} was not detected`);
  await invokeRole('backup', 'assert-chain', targetStack, { taskId: state.mainTask.taskId });
  await invokeRole('backup', 'transition', targetStack,
    { backupSetId, expected: 'verifying', next: 'open', options: {} });
  const open = await invokeRole('online', 'open', targetStack, { state });
  await writeJson(join(verificationRoot, 'open-served-chain.json'), {
    at: new Date().toISOString(), backupSetId, taskId: state.mainTask.taskId,
    sourceArtifactId: state.sourceArtifact.id, reportArtifactId: state.reportArtifact.id,
    ...open,
  });
  await targetApplication.stop();
  await record('rehearsal.completed', { backupSetId, restoredSourceSha256: state.sourceHash,
    restoredReportSha256: state.reportArtifact.contentSha256 });
}

if (process.env.GENEWAY_BACKUP_RESTORE_ROLE !== undefined) {
  try {
    await runRoleInvocation();
  } catch (error) {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  } finally {
    for (const client of storageClients) client.destroy();
  }
} else await (async () => {
  let outcome = 'passed';
  let exitCode = 0;
  let errorMessage = null;
  try {
    await runRehearsal();
  } catch (error) {
    outcome = error?.code === 'NEGATIVE_CASE_DETECTED' ? 'expected-integrity-failure' : 'failed';
    exitCode = 1;
    errorMessage = safeError(error);
    try { await record('rehearsal.failed', { stage, outcome, error: errorMessage }); } catch {}
  } finally {
    const cleanupProblems = [];
    for (const handle of [...activeServiceHandles]) {
      try { await handle.stop(); } catch (error) { cleanupProblems.push(`service:${handle.label}:${safeError(error)}`); }
    }
    for (const stack of [sourceStack, targetStack]) {
      if (stack === undefined) continue;
      try { await stopStackProxies(stack); } catch (error) { cleanupProblems.push(`proxy:${stack.label}:${safeError(error)}`); }
    }
    for (const name of [...roleContainers]) {
      try { await removeRoleContainer(name); } catch (error) { cleanupProblems.push(`container:${name}:${safeError(error)}`); }
    }
    for (const [child, lifecycle] of [...children]) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      if (lifecycle.controlPipe) {
        abandonUnresponsiveControlPipeChild(child);
        children.delete(child);
        cleanupProblems.push(`control-pipe-process-remains:${child.pid}`);
        continue;
      }
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') cleanupProblems.push(`process:${child.pid}:${safeError(error)}`);
      }
    }
    const processDeadline = Date.now() + 5_000;
    while (children.size > 0 && Date.now() < processDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (children.size > 0) cleanupProblems.push(`process-groups-remain:${[...children.keys()].map((child) => child.pid).join(',')}`);
    for (const client of storageClients) client.destroy();
    if (sourceStack !== undefined && sourceDestructionReceipt === undefined) {
      try {
        sourceDestructionReceipt = await destroyStack(sourceStack, 'source-final-destruction.json');
        sourceStarted = false;
      } catch (error) { cleanupProblems.push(`source-stack:${safeError(error)}`); }
    }
    if (targetStack !== undefined && targetDestructionReceipt === undefined) {
      try {
        targetDestructionReceipt = await destroyStack(targetStack, 'target-destruction.json');
        targetStarted = false;
      } catch (error) { cleanupProblems.push(`target-stack:${safeError(error)}`); }
    }
    for (const stack of [sourceStack, targetStack]) {
      if (stack !== undefined) {
        await rm(stack.socketPath, { force: true });
        await rm(stack.tokenFile, { force: true });
      }
    }
    await rm(credentialsRunRoot, { recursive: true, force: true });
    await rm(runtimeRunRoot, { recursive: true, force: true });
    const residualRoleContainers = (await runCommand('docker', ['ps', '-aq', '--filter',
      `label=geneway.backup.run=${requestedRunId}`])).stdout.split('\n').filter(Boolean);
    if (residualRoleContainers.length > 0) cleanupProblems.push(`role-containers-remain:${residualRoleContainers.join(',')}`);
    const cleanupReceipt = {
      schemaVersion: 'geneway-backup-process-cleanup/1',
      checkedAt: new Date().toISOString(),
      sourceDestroyed: sourceDestructionReceipt?.destroyed === true,
      targetDestroyed: targetDestructionReceipt?.destroyed === true,
      activeServiceHandles: activeServiceHandles.size,
      activeChildProcesses: children.size,
      residualRoleContainers,
      credentialsRemoved: true,
      runtimeSocketsRemoved: true,
      problems: cleanupProblems,
      clean: cleanupProblems.length === 0 && activeServiceHandles.size === 0
        && children.size === 0 && residualRoleContainers.length === 0
        && sourceDestructionReceipt?.destroyed === true && targetDestructionReceipt?.destroyed === true,
    };
    try { await writeJson(join(rehearsalRoot, 'process-cleanup.json'), cleanupReceipt); }
    catch (error) { cleanupProblems.push(`cleanup-receipt:${safeError(error)}`); }
    if (!cleanupReceipt.clean || cleanupProblems.length > 0) {
      outcome = 'failed';
      exitCode = 1;
      errorMessage = `CLEANUP_FAILED:${cleanupProblems.join('|') || 'cleanup receipt did not close'}`;
    }
  }
  const summary = {
    schemaVersion: 'geneway-backup-restore-summary/1',
    runId: requestedRunId,
    artifactRoot: rehearsalRoot,
    projectSuffix,
    sourceProject: `geneway-br-source-${projectSuffix}`,
    targetProject: `geneway-br-target-${projectSuffix}`,
    case: selectedCase,
    outcome,
    exitCode,
    finishedAt: new Date().toISOString(),
    lastStage: stage,
    backupSetId: backupSetId ?? null,
    authority: 'postgres.backup_sets+platform_write_barriers',
    sourceDestroyedBeforeTargetRestore: sourceDestructionReceipt?.destroyed === true,
    targetDestroyedAfterVerification: targetDestructionReceipt?.destroyed === true,
    targetIntegrityClean: integrityResult?.clean ?? null,
    integrityFindings: integrityResult?.findings ?? [],
    error: errorMessage,
  };
  try { await writeJson(join(rehearsalRoot, 'summary.json'), summary); }
  catch (error) { process.stderr.write(`could not write backup/restore summary: ${safeError(error)}\n`); }
  if (exitCode === 0) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else process.stderr.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = exitCode;
})();
