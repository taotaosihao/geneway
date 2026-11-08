import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
export async function processIdentity(pid) {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { pid, state: fields[0], ppid: Number(fields[1]), startTicks: fields[19] };
}
export async function startProgram({ entry, config, root, args = [] }) {
  await mkdir(root, { recursive: true });
  const configFile = path.join(root, 'config.json'); await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  const stdout = createWriteStream(path.join(root, 'stdout.log')), stderr = createWriteStream(path.join(root, 'stderr.log'));
  const spawnedAt = new Date().toISOString(), child = spawn(process.execPath, [entry, '--config', configFile, ...args], { stdio: ['ignore','pipe','pipe'] });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  const identity = await processIdentity(child.pid), exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, at: new Date().toISOString() })));
  const ready = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error(`Ready timeout: ${entry}`)); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(Error(`Before ready ${entry}: ${code}/${signal}`)); });
    child.stdout.on('data', chunk => { text += chunk; while (text.includes('\n')) { const index = text.indexOf('\n'), line = text.slice(0,index); text = text.slice(index+1); try { const value = JSON.parse(line); if (value.event === 'ready') { clearTimeout(timer); resolve(value); } } catch {} } });
  });
  await writeFile(path.join(root, 'process-start.json'), JSON.stringify({ entry, spawnedAt, readyAt: new Date().toISOString(), identity, ready }, null, 2));
  return { child, ready, identity, exit, async close(signal = 'SIGTERM') {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const terminal = await exit;
    stdout.end(); stderr.end();
    let finalIdentity = null; try { finalIdentity = await processIdentity(child.pid); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(path.join(root, 'process-exit.json'), JSON.stringify({ identity, terminal, finalIdentity, sameIdentityLive: finalIdentity?.startTicks === identity.startTicks && finalIdentity.state !== 'Z' }, null, 2));
    return terminal;
  } };
}
