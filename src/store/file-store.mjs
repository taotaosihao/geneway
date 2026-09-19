import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const EMPTY_STATE = {
  version: 3,
  operator: { id: 'local-operator', displayName: '本机操作者' },
  employees: [],
  connections: [],
  skills: [],
  works: [],
  reservations: {},
}

export function createFileStore(filePath) {
  let pending = Promise.resolve()

  return {
    async read() {
      try {
        return normalizeState(JSON.parse(await readFile(filePath, 'utf8')))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        return structuredClone(EMPTY_STATE)
      }
    },

    update(mutator) {
      const operation = pending.then(async () => {
        const current = await this.read()
        const next = await mutator(current)
        await mkdir(dirname(filePath), { recursive: true })
        const fileName = filePath.split('/').pop()
        const tempPath = join(dirname(filePath), '.' + fileName + '.' + process.pid + '.tmp')
        await writeFile(tempPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
        await rename(tempPath, filePath)
        return next
      })
      pending = operation.catch(() => undefined)
      return operation
    },
  }
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('产品状态不是对象')
  return {
    ...value,
    version: Number(value.version) >= 3 ? value.version : 3,
    operator: value.operator && typeof value.operator === 'object' ? value.operator : structuredClone(EMPTY_STATE.operator),
    employees: Array.isArray(value.employees) ? value.employees : [],
    connections: Array.isArray(value.connections) ? value.connections : [],
    skills: Array.isArray(value.skills) ? value.skills : [],
    works: Array.isArray(value.works) ? value.works : [],
    reservations: value.reservations && typeof value.reservations === 'object' && !Array.isArray(value.reservations) ? value.reservations : {},
  }
}
