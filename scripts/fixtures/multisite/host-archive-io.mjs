import * as fs from 'node:fs/promises'

// Test-only syscall observer. Bytes come from actual completed operations.
export function observeArchiveIO({ fault = () => {}, transformStat = (_, stat) => stat } = {}) {
  const events = []
  let phase = 'initial'
  const record = (operation, path, details = {}) => events.push({ phase, operation, path: String(path), ...details })
  const operations = {
    async readFile(path, ...args) {
      await fault('readFile', String(path))
      const value = await fs.readFile(path, ...args)
      record('readFile', path, { bytes: Buffer.byteLength(value) })
      return value
    },
    async lstat(path, ...args) {
      await fault('lstat', String(path))
      const stat = await fs.lstat(path, ...args)
      record('lstat', path)
      return transformStat(String(path), stat)
    },
    async rename(from, to) {
      await fault('rename', String(from), String(to))
      await fs.rename(from, to)
      record('rename', from, { to: String(to) })
    },
    async open(path, flags, mode) {
      await fault('open', String(path), flags)
      const handle = await fs.open(path, flags, mode)
      record('open', path, { flags })
      return new Proxy(handle, { get(target, property) {
        if (property === 'readFile') return async (...args) => {
          await fault('handle.readFile', String(path))
          const value = await target.readFile(...args)
          record('handle.readFile', path, { bytes: Buffer.byteLength(value) })
          return value
        }
        if (property === 'read') return async (...args) => {
          await fault('pread', String(path))
          const result = await target.read(...args)
          record('pread', path, { bytes: result.bytesRead, position: args[3] })
          return result
        }
        if (property === 'writeFile') return async (value, ...args) => {
          await fault('writeFile', String(path))
          await target.writeFile(value, ...args)
          record('writeFile', path, { bytes: Buffer.byteLength(value) })
        }
        if (property === 'sync') return async () => {
          await fault('sync', String(path))
          await target.sync()
          record('sync', path)
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    },
  }
  return {
    operations, events,
    phase(value) { phase = value },
    summary() {
      const result = {}
      for (const event of events) {
        const group = result[event.phase] ??= {}
        const bucket = group[event.path.includes('/journal-archive/') || event.path.endsWith('/journal-archive') ? 'cold' : 'hot'] ??= {}
        const count = bucket[event.operation] ??= { calls: 0, bytes: 0 }
        count.calls++; count.bytes += event.bytes ?? 0
      }
      return result
    },
  }
}
