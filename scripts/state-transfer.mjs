import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const command = process.argv[2]
const args = parseArgs(process.argv.slice(3))

if (command === 'backup') await backup(args.output)
else if (command === 'restore') await restore(args.input, args.dataRoot)
else {
  console.error('用法：node scripts/state-transfer.mjs backup --output <空目录> | restore --input <备份目录> --data-root <空目录>')
  process.exitCode = 2
}

async function backup(outputArg) {
  if (!outputArg) throw new Error('backup 需要 --output')
  const output = resolve(outputArg)
  await assertEmptyTarget(output)
  await mkdir(output, { recursive: true, mode: 0o700 })
  const statePath = resolve(process.env.GENEWAY_STATE ?? join(root, 'var', 'state.json'))
  const dshHome = resolve(process.env.GENEWAY_DSH_HOME ?? join(root, 'var', 'dsh'))
  const files = []
  if (await exists(statePath)) files.push({ source: statePath, path: 'state.json' })
  const sessionsRoot = join(dshHome, 'sessions')
  for (const source of await filesUnder(sessionsRoot)) {
    if (!/\.jsonl(?:\.(?:gz|zstd))?$/i.test(source)) continue
    files.push({ source, path: join('dsh', 'sessions', relative(sessionsRoot, source)) })
  }
  const entries = []
  for (const file of files) {
    const destination = join(output, file.path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(file.source, destination)
    const bytes = (await stat(destination)).size
    entries.push({ path: file.path.split(sep).join('/'), bytes, sha256: await sha256(destination) })
  }
  const manifest = { version: 1, createdAt: new Date().toISOString(), entries }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ command: 'backup', output, entries: entries.length, bytes: entries.reduce((total, item) => total + item.bytes, 0) }))
}

async function restore(inputArg, dataRootArg) {
  if (!inputArg || !dataRootArg) throw new Error('restore 需要 --input 和 --data-root')
  const input = resolve(inputArg)
  const dataRoot = resolve(dataRootArg)
  await assertEmptyTarget(dataRoot)
  const manifest = JSON.parse(await readFile(join(input, 'manifest.json'), 'utf8'))
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error('备份 manifest 无效')
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  for (const entry of manifest.entries) {
    const path = safeRelative(entry.path)
    const source = join(input, path)
    const destination = join(dataRoot, path)
    const sourceStat = await stat(source)
    if (!sourceStat.isFile() || sourceStat.size !== entry.bytes || await sha256(source) !== entry.sha256) throw new Error(`备份校验失败：${entry.path}`)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(source, destination)
    await writeFile(destination, await readFile(destination), { mode: 0o600 })
  }
  console.log(JSON.stringify({ command: 'restore', input, dataRoot, entries: manifest.entries.length }))
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--') continue
    if (!key.startsWith('--') || typeof argv[index + 1] !== 'string') continue
    result[key.slice(2).replaceAll('-', '')] = argv[++index]
  }
  return { output: result.output, input: result.input, dataRoot: result.dataroot }
}

async function assertEmptyTarget(path) {
  try {
    const entries = await readdir(path)
    if (entries.length) throw new Error(`目标目录必须为空：${path}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function filesUnder(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) files.push(...await filesUnder(child))
      else if (entry.isFile()) files.push(child)
    }
    return files
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function exists(path) {
  try { await stat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('备份路径无效')
  const path = normalize(value)
  if (path.startsWith('/') || path === '..' || path.startsWith(`..${sep}`)) throw new Error('备份路径越界')
  return path
}
