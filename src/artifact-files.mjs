import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { error } from '../packages/agent-contracts/index.mjs'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = (code, message, status) => Object.assign(error(code, message), { status })

// Shared immutable object publication boundary for user attachments and controlled candidates.
export function createArtifactFiles({ root, fsOps = {}, maxBytes = 10 * 1024 * 1024, uploadTimeoutMs = 30_000, validate }) {
  const io = { ...fs, ...fsOps }, directory = resolve(root)
  const filePath = id => { if (!/^(?:attachment-[a-f0-9-]{36}|(?:artifact|evidence)-[a-f0-9]{32})$/.test(id)) throw error('NOT_FOUND', '附件不存在'); return join(directory, id) }
  async function safeRoot() {
    let cursor = sep
    for (const part of directory.split(sep).filter(Boolean)) {
      cursor = join(cursor, part)
      let stat, syncParent = false
      try { stat = await io.lstat(cursor) }
      catch (cause) {
        if (cause.code !== 'ENOENT') throw cause
        try { await io.mkdir(cursor, { mode: 0o700 }) } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError }
        stat = await io.lstat(cursor)
        syncParent = true
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw error('STORE_UNAVAILABLE', '附件路径不安全')
      if (syncParent) await syncDirectory(dirname(cursor))
    }
  }
  async function syncDirectory(path = directory) { const handle = await io.open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
  async function openFile(id) {
    await safeRoot()
    const path = filePath(id), stat = await io.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw error('STORE_UNAVAILABLE', '附件对象不安全')
    const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > maxBytes) throw error('STORE_UNAVAILABLE', '附件对象已变化')
      return handle
    } catch (cause) { await handle.close(); throw cause }
  }
  async function verifyFile(row, { sync = false } = {}) {
    const handle = await openFile(row.id)
    try {
      const bytes = await handle.readFile()
      if (bytes.length !== row.sizeBytes || sha256(bytes) !== row.sha256) throw error('INVALID_STATE', '附件字节完整性校验失败')
      await validate(bytes, row.mediaType)
      if (sync) { await handle.sync(); await syncDirectory() }
      return bytes
    } finally { await handle.close() }
  }
  return {
    read: verifyFile,
    async write(row, source) {
      const id = row.id
        await safeRoot()
        const path = filePath(id), temporary = join(directory, `.${id}.${randomUUID()}.tmp`)
        let handle
        try {
          handle = await io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          const chunks = [], hash = createHash('sha256')
          let size = 0
          const iterator = source[Symbol.asyncIterator](), deadline = Date.now() + uploadTimeoutMs
          while (true) {
            let timer
            const next = await Promise.race([iterator.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('UPLOAD_TIMEOUT', '附件上传超时', 408)), Math.max(0, deadline - Date.now())); timer.unref?.() })]).finally(() => clearTimeout(timer))
            if (next.done) break
            const chunk = Buffer.from(next.value); size += chunk.length
            if (size > row.sizeBytes || size > maxBytes) throw fail('ATTACHMENT_TOO_LARGE', '附件字节超出声明', 413)
            hash.update(chunk); chunks.push(chunk); await handle.writeFile(chunk)
          }
          if (size !== row.sizeBytes || hash.digest('hex') !== row.sha256) throw error('INVALID_REQUEST', '附件大小或摘要不匹配')
          await validate(Buffer.concat(chunks), row.mediaType)
          await handle.sync(); await handle.close(); handle = undefined
          // link() publishes without replacing an existing object, including across service instances.
          try { await io.link(temporary, path) } catch (cause) { if (cause.code !== 'EEXIST') throw cause }
          await verifyFile(row, { sync: true })
        } finally {
          await handle?.close().catch(() => {})
          await io.unlink(temporary).catch(cause => { if (cause.code !== 'ENOENT') throw cause })
        }
    },
  }
}
