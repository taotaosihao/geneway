import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const PORTS = Object.freeze({ controlPlane: 3100, syntheticGateway: 3165, web: 3200 });
const FORBIDDEN_ENV_PREFIXES = ['AWS_', 'GENEWAY_GEARJOB_', 'GENEWAY_HIVE_', 'GENEWAY_MODEL_GATEWAY_', 'GENEWAY_CONNECTOR_GATEWAY_'];

function taskEnvironment(homeDirectory) {
  const resolvedHome = resolve(homeDirectory);
  if (!resolvedHome.startsWith('/tmp/') || resolvedHome === resolve(process.env.HOME ?? '/')) {
    throw new Error('Synthetic processes require a task-owned HOME below /tmp');
  }
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: resolvedHome,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
    NODE_ENV: 'test',
    COREPACK_ENABLE_NETWORK: '0',
    npm_config_offline: 'true',
    PNPM_CONFIG_OFFLINE: 'true',
  };
}

export function assertInstalledChromiumExecutable(candidate) {
  const executable = resolve(candidate);
  const currentUid = process.getuid?.();
  if (!candidate.startsWith('/') || currentUid === undefined || realpathSync(executable) !== executable) {
    throw new Error('Synthetic Chromium executable must be an absolute canonical path');
  }
  const stat = lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid || (stat.mode & 0o111) === 0) {
    throw new Error('Synthetic Chromium executable must be a current-user-owned regular executable');
  }
  return executable;
}

function resolveInstalledChromiumExecutable() {
  return assertInstalledChromiumExecutable(chromium.executablePath());
}

function assertDatabaseUrl(value) {
  if (value === undefined) throw new Error('DATABASE_URL is required; start through scripts/with-postgres.sh');
  const url = new URL(value);
  if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' || !/^\d+$/u.test(url.port)
    || url.pathname !== '/geneway_test' || url.search !== '' || url.hash !== '') {
    throw new Error('DATABASE_URL must reference the task-owned loopback geneway_test database');
  }
  return value;
}

export function syntheticProductionProcessPlan(input = {}) {
  const tokenFile = input.tokenFile ?? '/tmp/geneway-synthetic-production/token';
  const homeDirectory = input.homeDirectory ?? `${dirname(tokenFile)}/home`;
  const databaseUrl = assertDatabaseUrl(input.databaseUrl ?? process.env.DATABASE_URL);
  const common = taskEnvironment(homeDirectory);
  const plan = [
    {
      role: 'synthetic-connector-gateway',
      command: './node_modules/.bin/tsx', args: ['services/connector-gateway/src/synthetic-production-main.ts'],
      health: `http://127.0.0.1:${String(PORTS.syntheticGateway)}/health`,
      env: { ...common, PORT: String(PORTS.syntheticGateway), GENEWAY_SYNTHETIC_PRODUCTION_SERVICE_TOKEN_FILE: tokenFile },
    },
    {
      role: 'control-plane',
      command: './node_modules/.bin/tsx', args: ['apps/control-plane/src/main.ts'],
      health: `http://127.0.0.1:${String(PORTS.controlPlane)}/health`,
      env: {
        ...common, DATABASE_URL: databaseUrl, PORT: String(PORTS.controlPlane), GENEWAY_WEB_PORT: String(PORTS.web),
        GENEWAY_CURSOR_HMAC_SECRET: 'synthetic-cursor-hmac-secret-not-a-real-credential',
        GENEWAY_SYNTHETIC_PRODUCTION_GATEWAY_URL: `http://127.0.0.1:${String(PORTS.syntheticGateway)}`,
        GENEWAY_SYNTHETIC_PRODUCTION_SERVICE_TOKEN_FILE: tokenFile,
      },
    },
    {
      role: 'vite-web',
      command: './node_modules/.bin/vite', args: ['--config', 'vite.config.ts'], cwd: 'apps/web',
      health: `http://127.0.0.1:${String(PORTS.web)}/work-orders/mock`,
      env: { ...common, GENEWAY_WEB_HOST: '127.0.0.1', GENEWAY_WEB_PORT: String(PORTS.web), GENEWAY_CONTROL_PLANE_PORT: String(PORTS.controlPlane) },
    },
  ];
  for (const processPlan of plan) {
    const forbidden = Object.keys(processPlan.env).filter((name) => FORBIDDEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)));
    if (forbidden.length > 0) throw new Error(`Synthetic process inherited forbidden environment names: ${forbidden.join(',')}`);
  }
  return plan;
}

export function syntheticE2eRoute(arguments_) {
  const projects = arguments_.flatMap((argument, index) => {
    if (argument.startsWith('--project=')) return [argument.slice('--project='.length)];
    return argument === '--project' && arguments_[index + 1] !== undefined ? [arguments_[index + 1]] : [];
  });
  const includesSynthetic = projects.includes('synthetic-production-brief');
  if (includesSynthetic && projects.some((project) => project !== 'synthetic-production-brief')) {
    throw new Error('The synthetic-production-brief project cannot be combined with another E2E project');
  }
  return includesSynthetic ? 'synthetic' : 'legacy';
}

export function e2eRouteEnvironment(route, syntheticHome) {
  return route === 'legacy' ? { ...process.env } : taskEnvironment(syntheticHome);
}

function runChecked(command, args, environment) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env: environment, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function routeE2e(arguments_) {
  const forwarded = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;
  const route = syntheticE2eRoute(forwarded);
  if (route === 'legacy') {
    const legacyEnvironment = e2eRouteEnvironment(route);
    const authenticityStatus = runChecked(process.execPath, ['scripts/check-e2e-authenticity.mjs'], legacyEnvironment);
    if (authenticityStatus !== 0) return authenticityStatus;
    return runChecked(process.execPath, ['scripts/run-e2e.mjs', ...forwarded], legacyEnvironment);
  }
  const browserExecutable = resolveInstalledChromiumExecutable();
  const authorityDirectory = mkdtempSync('/tmp/geneway-synthetic-e2e-');
  chmodSync(authorityDirectory, 0o700);
  const outerHome = `${authorityDirectory}/home`;
  mkdirSync(outerHome, { mode: 0o700 });
  const common = e2eRouteEnvironment(route, outerHome);
  try {
    const authenticityStatus = runChecked(process.execPath, ['scripts/check-e2e-authenticity.mjs'], common);
    if (authenticityStatus !== 0) return authenticityStatus;
    return runChecked('./node_modules/.bin/playwright', ['test', '--config=scripts/playwright.config.ts', ...forwarded], {
      ...common,
      GENEWAY_SYNTHETIC_PRODUCTION_BRIEF: '1',
      GENEWAY_RUN_ID: `synthetic-production-brief-${String(process.pid)}-${String(Date.now())}`,
      GENEWAY_SYNTHETIC_CHROMIUM_EXECUTABLE: browserExecutable ?? '',
    });
  } finally {
    rmSync(authorityDirectory, { recursive: true, force: true });
  }
}

const routeIndex = process.argv.indexOf('--route-e2e');
const printRouteIndex = process.argv.indexOf('--print-e2e-route');
const printBrowserExecutable = process.argv.includes('--print-browser-executable');
const printEnvironmentIndex = process.argv.indexOf('--print-e2e-environment');
if (routeIndex >= 0) {
  process.exitCode = routeE2e(process.argv.slice(routeIndex + 1));
} else if (printBrowserExecutable) {
  process.stdout.write(`${resolveInstalledChromiumExecutable()}\n`);
} else if (printEnvironmentIndex >= 0) {
  const route = process.argv[printEnvironmentIndex + 1];
  if (route !== 'legacy' && route !== 'synthetic') throw new Error('Expected legacy or synthetic environment route');
  const environment = e2eRouteEnvironment(route, '/tmp/task-owned/home');
  process.stdout.write(`${JSON.stringify({ home: environment.HOME, canary: environment.GENEWAY_LEGACY_ENV_CANARY })}\n`);
} else if (printRouteIndex >= 0) {
  const forwarded = process.argv.slice(printRouteIndex + 1).filter((argument, index) => !(argument === '--' && index === 0));
  process.stdout.write(`${syntheticE2eRoute(forwarded)}\n`);
} else if (process.argv.includes('--print-plan')) {
  const plan = syntheticProductionProcessPlan({ tokenFile: '/tmp/task-owned/token', homeDirectory: '/tmp/task-owned/home' });
  process.stdout.write(`${JSON.stringify(plan.map(({ role, command, args, cwd, health, env }) => ({
    role, command, args, cwd: cwd ?? '.', health, home: env.HOME, environmentNames: Object.keys(env).sort(),
  })))}\n`);
} else {
  const authorityDirectory = mkdtempSync('/tmp/geneway-synthetic-production-');
  chmodSync(authorityDirectory, 0o700);
  const homeDirectory = `${authorityDirectory}/home`;
  mkdirSync(homeDirectory, { mode: 0o700 });
  const tokenFile = `${authorityDirectory}/service-token`;
  writeFileSync(tokenFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  const children = [];
  let stopping = false;
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map((child) => new Promise((resolvePromise) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolvePromise(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
      child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    })));
    rmSync(authorityDirectory, { recursive: true, force: true });
    process.exitCode = exitCode;
  };
  const plan = syntheticProductionProcessPlan({ tokenFile, homeDirectory });
  for (const processPlan of plan) {
    const child = spawn(processPlan.command, processPlan.args, {
      cwd: processPlan.cwd ?? process.cwd(), env: processPlan.env, stdio: ['ignore', 'inherit', 'inherit'],
    });
    children.push(child);
    child.once('error', (error) => { process.stderr.write(`${processPlan.role} failed to start: ${error.message}\n`); void stop(1); });
    child.once('exit', (code, signal) => {
      if (!stopping) {
        process.stderr.write(`${processPlan.role} exited unexpectedly: code=${String(code)} signal=${String(signal)}\n`);
        void stop(code ?? 1);
      }
    });
  }
  const deadline = Date.now() + 60_000;
  for (const processPlan of plan) {
    let ready = false;
    while (!ready && Date.now() < deadline && !stopping) {
      try { ready = (await fetch(processPlan.health, { signal: AbortSignal.timeout(500) })).ok; }
      catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); }
    }
    if (!ready) {
      process.stderr.write(`${processPlan.role} did not become ready\n`);
      await stop(1);
      break;
    }
  }
  if (!stopping) process.stdout.write(`Synthetic production brief ready at http://127.0.0.1:${String(PORTS.web)}/work-orders/mock\n`);
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}
