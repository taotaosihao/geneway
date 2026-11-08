import { randomBytes, randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { error } from '../agent-contracts/index.mjs'

export async function readHostIdentity(root, operations = {}) {
  const io = { open, ...operations }
  let handle
  try {
    handle = await io.open(join(root, 'node-identity.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 64 * 1024 || process.getuid && stat.uid !== process.getuid()) throw error('HOST_IDENTITY_INVALID')
    const value = JSON.parse(await handle.readFile('utf8'))
    if (value.version !== 1 || typeof value.nodeInstanceId !== 'string' || typeof value.pairRequestId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.credential)) throw error('HOST_IDENTITY_INVALID')
    await handle.sync()
    const directory = await io.open(root, 'r')
    try { await directory.sync() } finally { await directory.close() }
    return value
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
  finally { await handle?.close() }
  const value = { version: 1, nodeInstanceId: randomUUID(), pairRequestId: randomUUID(), credential: randomBytes(32).toString('base64url'), nodeId: null, registrationRevision: null, credentialVersion: null }
  await writeHostIdentity(root, value, operations)
  return value
}
export async function writeHostIdentity(root, value, operations = {}) {
  const io = { open, rename, unlink, ...operations }
  const path = join(root, 'node-identity.json'), temp = join(root, `.node-identity.${randomUUID()}.tmp`)
  let handle, created = false, committed = false
  try {
    handle = await io.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = undefined
    await io.rename(temp, path); committed = true
    handle = await io.open(root, 'r'); await handle.sync()
  } finally { await handle?.close(); if (created && !committed) await io.unlink(temp).catch(() => {}) }
}
