import { open, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { error } from '../agent-contracts/index.mjs'

export async function acquireHostOwner(root) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const file = await open(join(root, '.agent-host.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  let child
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || process.getuid && metadata.uid !== process.getuid()) throw error('HOST_OWNER_INVALID')
    child = spawn('/bin/sh', ['-c', '/usr/bin/flock --nonblock --conflict-exit-code 73 3 || exit $?; printf ready; IFS= read -r _ || test "$?" -eq 1'], { stdio: ['pipe', 'pipe', 'ignore', file.fd] })
    await new Promise((resolve, reject) => { child.stdout.once('data', value => value.toString() === 'ready' ? resolve() : reject(error('HOST_OWNER_INVALID'))); child.once('error', reject); child.once('exit', () => reject(error('HOST_ALREADY_RUNNING', '此数据根已有运行的 Host'))) })
  } catch (cause) { child?.stdin.destroy(); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await file.close(); throw cause }
  // The parent retains this same open file description until its Host is quiescent.
  // A dead lock helper must not let another writer enter while HTTP/runtime cleanup is pending.
  let releasing = false, released = false
  const lost = new Promise(resolve => child.once('exit', (code, signal) => { if (!releasing) resolve({ code, signal }) }))
  return { lost, helperPid: child.pid, async release() {
    if (released) return
    releasing = true
    if (child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.stdin.end(); await ended }
    await file.close(); released = true
  } }
}
