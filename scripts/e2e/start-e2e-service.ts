import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const role = process.argv[2];
if (role !== 'control-plane' && role !== 'vite') throw new Error('E2E service role must be control-plane or vite');
const runId = process.env.GENEWAY_RUN_ID;
if (runId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');

const boundaryCheck = spawnSync(process.execPath, ['scripts/assert-process-env.mjs', role], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
if (boundaryCheck.status !== 0) throw new Error(`${role} process environment did not pass its boundary check`);

const webPort = process.env.GENEWAY_WEB_PORT;
const command = role === 'control-plane'
  ? { cwd: process.cwd(), executable: process.execPath, args: ['--import', 'tsx', 'apps/control-plane/src/main.ts'] }
  : { cwd: path.join(process.cwd(), 'apps/web'), executable: process.execPath, args: ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', webPort ?? '', '--strictPort'] };
if (role === 'vite' && (webPort === undefined || !/^\d{1,5}$/u.test(webPort))) throw new Error('GENEWAY_WEB_PORT is invalid');

const child = spawn(command.executable, command.args, {
  cwd: command.cwd,
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
});
await new Promise<void>((resolve, reject) => {
  child.once('spawn', resolve);
  child.once('error', reject);
});
if (child.pid === undefined) throw new Error(`${role} process did not expose a PID`);

const stat = await readFile(`/proc/${String(child.pid)}/stat`, 'utf8');
const closingParenthesis = stat.lastIndexOf(')');
const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
const procStartTicks = fields[19];
if (closingParenthesis < 1 || procStartTicks === undefined || !/^\d+$/u.test(procStartTicks)) throw new Error(`${role} process identity is invalid`);
const receiptDirectory = `/tmp/geneway-runs/${runId}/process-boundaries`;
await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
await chmod(receiptDirectory, 0o700);
await writeFile(`${receiptDirectory}/${role}.json`, `${JSON.stringify({
  schemaVersion: 'geneway-process-boundary/1',
  role,
  checked: true,
  pid: child.pid,
  procStartTicks,
  forbiddenNamesPresent: [],
})}\n`, { mode: 0o600 });

let stopping = false;
function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

const exit = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
if (!stopping && (exit.code !== 0 || exit.signal !== null)) {
  throw new Error(`${role} exited unexpectedly: code=${String(exit.code)} signal=${String(exit.signal)}`);
}
