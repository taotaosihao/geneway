import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { resolveCredentialFile } from './execution-grant.mjs'

const pending = new Map()
const SAFE_CODES = new Set(['CHANNEL_SECRET_INVALID', 'CHANNEL_SECRET_UNAVAILABLE', 'CHANNEL_SECRET_WRITE_FAILED', 'CHANNEL_SECRET_DURABILITY_UNKNOWN', 'CHANNEL_SECRET_DIRECTORY_DURABILITY_UNKNOWN'])

// Use update for read/modify/write; bot ownership provides cross-process exclusion.
export function createChannelSecretStore(secretRoot, fsOps = {}) {
  if (typeof secretRoot !== 'string' || !isAbsolute(secretRoot) || resolve(secretRoot) === parse(secretRoot).root) throw secretError('CHANNEL_SECRET_INVALID')
  const root = resolve(secretRoot), io = { lstat, mkdir, open, rename, unlink, ...fsOps }

  function fileFor(ref) {
    if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)) throw secretError('CHANNEL_SECRET_INVALID')
    return join(root, ref)
  }

  function serialize(ref, operation) {
    const file = fileFor(ref)
    const result = (pending.get(file) ?? Promise.resolve()).then(operation).catch(error => {
      throw secretError(SAFE_CODES.has(error?.code) ? error.code : 'CHANNEL_SECRET_UNAVAILABLE')
    })
    const settled = result.then(() => undefined, () => undefined)
    pending.set(file, settled)
    void settled.then(() => { if (pending.get(file) === settled) pending.delete(file) })
    return result
  }

  async function rootDirectory(create) {
    let cursor = parse(root).root
    for (const part of root.slice(cursor.length).split(sep)) {
      cursor = join(cursor, part)
      if (cursor === root && create) await io.mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      let metadata
      try { metadata = await io.lstat(cursor) } catch (error) {
        if (cursor === root && !create && error.code === 'ENOENT') return false
        throw error
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw secretError('CHANNEL_SECRET_INVALID')
      if (cursor === root && (metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o700)) throw secretError('CHANNEL_SECRET_INVALID')
    }
    // EEXIST writers must also persist a concurrently created root before publishing secrets.
    if (create) {
      let parent
      try {
        parent = await io.open(dirname(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        await parent.sync()
      } catch { throw secretError('CHANNEL_SECRET_DIRECTORY_DURABILITY_UNKNOWN') }
      finally { await parent?.close().catch(() => undefined) }
    }
    return true
  }

  async function checkedFile(ref) {
    let metadata
    try { metadata = await io.lstat(fileFor(ref)) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) throw secretError('CHANNEL_SECRET_INVALID')
    await resolveCredentialFile(root, ref)
    return metadata
  }

  async function readValue(ref) {
    const before = await checkedFile(ref)
    if (!before) return undefined
    const handle = await io.open(fileFor(ref), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.dev !== before.dev || metadata.ino !== before.ino || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) throw secretError('CHANNEL_SECRET_INVALID')
      try { return JSON.parse(await handle.readFile('utf8')) } catch { throw secretError('CHANNEL_SECRET_INVALID') }
    } finally { await handle.close() }
  }

  async function publish(ref, value) {
    let encoded
    try { encoded = JSON.stringify(value) } catch { throw secretError('CHANNEL_SECRET_INVALID') }
    if (encoded === undefined) throw secretError('CHANNEL_SECRET_INVALID')
    const temp = join(root, `.${ref}.${process.pid}.${randomUUID()}.tmp`)
    let handle, directory, created = false, committed = false
    try {
      handle = await io.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      created = true
      await handle.chmod(0o600)
      await handle.writeFile(encoded + '\n')
      await handle.sync()
      await handle.close(); handle = undefined
      await rootDirectory(false)
      await checkedFile(ref)
      directory = await io.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      await io.rename(temp, fileFor(ref))
      committed = true
      await directory.sync()
    } catch (error) {
      throw secretError(committed ? 'CHANNEL_SECRET_DURABILITY_UNKNOWN' : error?.code === 'CHANNEL_SECRET_INVALID' ? error.code : 'CHANNEL_SECRET_WRITE_FAILED')
    } finally {
      await handle?.close().catch(() => undefined)
      await directory?.close().catch(() => undefined)
      if (created && !committed) await io.unlink(temp).catch(() => undefined)
    }
  }

  return {
    async read(ref) {
      return serialize(ref, async () => await rootDirectory(false) ? readValue(ref) : undefined)
    },
    async write(ref, value) {
      return serialize(ref, async () => {
        await rootDirectory(true)
        await checkedFile(ref)
        await publish(ref, value)
      })
    },
    async update(ref, mutator) {
      return serialize(ref, async () => {
        if (typeof mutator !== 'function') throw secretError('CHANNEL_SECRET_INVALID')
        await rootDirectory(true)
        await publish(ref, await mutator(await readValue(ref)))
      })
    },
  }
}

function secretError(code) { return Object.assign(new Error('渠道秘密存储当前不可用'), { code }) }
