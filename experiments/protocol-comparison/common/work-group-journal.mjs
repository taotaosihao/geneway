import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// This journal owns protocol control intents only; Geneway Work and the external
// GroupHost retain their separate authorities and commit boundaries.
export async function openWorkGroupJournal({ file, initial, openExisting = false }) {
  let pending = Promise.resolve()
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw new Error('Invalid Work group control journal')
    return value
  }
  async function read() { return validate(JSON.parse(await readFile(file, 'utf8'))) }
  async function persist(value) {
    validate(value)
    const temporary = file + '.' + randomUUID() + '.tmp'
    let handle, committed = false
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = undefined
      await rename(temporary, file); committed = true
      const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
    } finally {
      await handle?.close().catch(() => {})
      if (!committed) await unlink(temporary).catch(() => {})
    }
  }
  try { await read() } catch (cause) {
    if (cause.code !== 'ENOENT' || openExisting) throw cause
    await persist(structuredClone(initial))
  }
  return {
    read,
    update(mutator) {
      const next = pending.then(async () => {
        const current = await read(), result = await mutator(current)
        const value = result === undefined ? current : result
        await persist(value); return structuredClone(value)
      })
      pending = next.catch(() => {})
      return next
    },
  }
}
