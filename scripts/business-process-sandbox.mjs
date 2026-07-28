import { spawn } from 'node:child_process';
import { constants as fileConstants, accessSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUSINESS_PROCESS_ROLES = Object.freeze([
  'web',
  'control-plane',
  'worker',
  'runtime',
  'model-gateway',
  'connector-gateway',
]);

export const DEFAULT_BWRAP_PATH = '/usr/bin/bwrap';
export const CODEX_AUTHORITY_ROOT = '/home/gewu/.codex';
export const GEARJOB_ROOT = '/home/gewu/work/gearjob';
export const DOCKER_SOCKET_PATH = '/run/docker.sock';
export const DOCKER_CLI_PATH = '/usr/bin/docker';

const roleSet = new Set(BUSINESS_PROCESS_ROLES);
const dockerEnvironmentNames = new Set([
  'BUILDKIT_HOST',
  'COMPOSE_ENV_FILES',
  'COMPOSE_FILE',
  'COMPOSE_PATH_SEPARATOR',
  'COMPOSE_PROFILES',
  'COMPOSE_PROJECT_NAME',
  'CONTAINER_HOST',
]);
const forwardedSignals = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

function assertAbsoluteNormalizedPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
}

function assertRole(role) {
  if (!roleSet.has(role)) {
    throw new Error(`unsupported business process role: ${String(role)}`);
  }
}

function isPathInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

function privateFileParentDirectories(root, credentialFile) {
  const parent = dirname(credentialFile);
  const pathFromRoot = relative(root, parent);
  if (pathFromRoot === '') return [];
  const directories = [];
  let current = root;
  for (const component of pathFromRoot.split(sep)) {
    current = `${current}${sep}${component}`;
    directories.push(current);
  }
  return directories;
}

export function buildBusinessProcessEnvironment(environment = process.env) {
  const result = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || name.startsWith('DOCKER_') || dockerEnvironmentNames.has(name)) continue;
    result[name] = value;
  }
  return Object.freeze(result);
}

export function buildBusinessProcessSandboxPlan({
  role,
  command,
  arguments: commandArguments = [],
  bwrapPath = DEFAULT_BWRAP_PATH,
  workingDirectory = process.cwd(),
  credentialFile,
  providerCredentialFile,
}) {
  assertRole(role);
  assertAbsoluteNormalizedPath(bwrapPath, 'bwrap path');
  assertAbsoluteNormalizedPath(command, 'business process command');
  assertAbsoluteNormalizedPath(workingDirectory, 'business process working directory');
  if (!Array.isArray(commandArguments) || commandArguments.some((value) => typeof value !== 'string')) {
    throw new Error('business process arguments must be an array of strings');
  }

  if (credentialFile !== undefined) {
    if (role !== 'connector-gateway') {
      throw new Error('only connector-gateway may receive a credential file');
    }
    assertAbsoluteNormalizedPath(credentialFile, 'credential file');
    if (!isPathInside(GEARJOB_ROOT, credentialFile)) {
      throw new Error(`credential file must be contained by ${GEARJOB_ROOT}`);
    }
  }
  if (providerCredentialFile !== undefined) {
    if (role !== 'model-gateway') {
      throw new Error('only model-gateway may receive a provider credential file');
    }
    assertAbsoluteNormalizedPath(providerCredentialFile, 'provider credential file');
    if (!isPathInside(CODEX_AUTHORITY_ROOT, providerCredentialFile)) {
      throw new Error(`provider credential file must be contained by ${CODEX_AUTHORITY_ROOT}`);
    }
  }

  const sandboxArguments = [
    '--die-with-parent',
    '--unshare-all',
    '--share-net',
    '--disable-userns',
    '--ro-bind', '/', '/',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', CODEX_AUTHORITY_ROOT,
    '--tmpfs', GEARJOB_ROOT,
    '--ro-bind', '/dev/null', DOCKER_SOCKET_PATH,
    '--ro-bind', '/dev/null', DOCKER_CLI_PATH,
  ];

  if (credentialFile !== undefined) {
    for (const directory of privateFileParentDirectories(GEARJOB_ROOT, credentialFile)) {
      sandboxArguments.push('--dir', directory);
    }
    sandboxArguments.push('--ro-bind', credentialFile, credentialFile);
  }
  if (providerCredentialFile !== undefined) {
    for (const directory of privateFileParentDirectories(CODEX_AUTHORITY_ROOT, providerCredentialFile)) {
      sandboxArguments.push('--dir', directory);
    }
    sandboxArguments.push('--ro-bind', providerCredentialFile, providerCredentialFile);
  }

  sandboxArguments.push('--chdir', workingDirectory, '--', command, ...commandArguments);
  return Object.freeze({
    executable: bwrapPath,
    arguments: Object.freeze(sandboxArguments),
  });
}

function assertExecutableFile(path, label) {
  assertAbsoluteNormalizedPath(path, label);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  accessSync(path, fileConstants.X_OK);
}

export function assertSecureCredentialFile(path) {
  assertAbsoluteNormalizedPath(path, 'credential file');
  if (!isPathInside(GEARJOB_ROOT, path)) {
    throw new Error(`credential file must be contained by ${GEARJOB_ROOT}`);
  }
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o600) {
    throw new Error('credential file must be a 0600 regular non-symlink file');
  }
}

export function assertSecureProviderCredentialFile(path) {
  assertAbsoluteNormalizedPath(path, 'provider credential file');
  if (!isPathInside(CODEX_AUTHORITY_ROOT, path)) {
    throw new Error(`provider credential file must be contained by ${CODEX_AUTHORITY_ROOT}`);
  }
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o600) {
    throw new Error('provider credential file must be a 0600 regular non-symlink file');
  }
}

export function parseBusinessProcessSandboxCli(arguments_) {
  let role;
  let bwrapPath = DEFAULT_BWRAP_PATH;
  let workingDirectory = process.cwd();
  let credentialFile;
  let providerCredentialFile;
  let index = 0;
  const seenOptions = new Set();

  while (index < arguments_.length && arguments_[index] !== '--') {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!['--role', '--bwrap', '--cwd', '--credential-file', '--provider-credential-file'].includes(option)
      || value === undefined) {
      throw new Error(`invalid sandbox option: ${String(option)}`);
    }
    if (seenOptions.has(option)) throw new Error(`duplicate sandbox option: ${option}`);
    seenOptions.add(option);
    if (option === '--role') role = value;
    if (option === '--bwrap') bwrapPath = value;
    if (option === '--cwd') workingDirectory = value;
    if (option === '--credential-file') credentialFile = value;
    if (option === '--provider-credential-file') providerCredentialFile = value;
    index += 2;
  }

  if (arguments_[index] !== '--') {
    throw new Error('sandbox command must be separated by --');
  }
  const command = arguments_[index + 1];
  if (command === undefined) throw new Error('sandbox command is required');

  return Object.freeze({
    role,
    bwrapPath,
    workingDirectory,
    credentialFile,
    providerCredentialFile,
    command,
    arguments: Object.freeze(arguments_.slice(index + 2)),
  });
}

export function runBusinessProcessSandbox(arguments_ = process.argv.slice(2), environment = process.env) {
  const parsed = parseBusinessProcessSandboxCli(arguments_);
  const plan = buildBusinessProcessSandboxPlan(parsed);
  assertExecutableFile(parsed.bwrapPath, 'bwrap path');
  assertExecutableFile(parsed.command, 'business process command');
  if (parsed.credentialFile !== undefined) assertSecureCredentialFile(parsed.credentialFile);
  if (parsed.providerCredentialFile !== undefined) {
    assertSecureProviderCredentialFile(parsed.providerCredentialFile);
  }

  const child = spawn(plan.executable, plan.arguments, {
    env: buildBusinessProcessEnvironment(environment),
    stdio: 'inherit',
    shell: false,
  });

  for (const signal of forwardedSignals) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.once('error', (error) => {
    process.stderr.write(`business process sandbox failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal !== null) {
      for (const forwardedSignal of forwardedSignals) process.removeAllListeners(forwardedSignal);
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
  return child;
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runBusinessProcessSandbox();
  } catch (error) {
    process.stderr.write(`business process sandbox rejected launch: ${
      error instanceof Error ? error.message : String(error)
    }\n`);
    process.exitCode = 1;
  }
}
