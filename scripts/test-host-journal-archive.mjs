import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runArchiveComponents } from './fixtures/multisite/host-archive-components.mjs'
import { runArchiveLive } from './fixtures/multisite/host-archive-live.mjs'

const mode = process.argv.includes('--component') ? 'component' : process.argv.includes('--live') ? 'live' : null
if (!mode) throw new Error('显式指定 --component 或已获窗口授权的 --live')
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/host-journal-archive-')
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2))
const paths = ['packages/agent-host/journal.mjs', 'packages/agent-host/journal-archive.mjs', 'packages/agent-host/host.mjs', 'packages/agent-host/diagnostics.mjs', 'packages/agent-host/remote.mjs', 'packages/agent-host/remote-client.mjs', 'packages/agent-host/delivery.mjs', 'packages/agent-contracts/index.mjs', 'packages/agent-contracts/command-bytes.mjs', 'src/node-bridge.mjs', 'src/server.mjs', 'src/work-service.mjs', 'src/store/file-store.mjs', 'src/runtime-config.mjs', 'packages/agent-orchestration/service.mjs', 'packages/agent-orchestration/commands.mjs', 'scripts/fixtures/multisite/bridge-service.mjs', 'scripts/fixtures/multisite/runtime.mjs', 'scripts/fixtures/multisite/delegation.mjs', 'scripts/fixtures/multisite/supervision-process-lifecycle.mjs', 'scripts/test-host-journal-archive.mjs', 'package.json', 'pnpm-lock.yaml', ...(await readdir('scripts/fixtures/multisite')).filter(name => name.startsWith('host-archive-')).map(name => 'scripts/fixtures/multisite/' + name)].sort()
async function source(phase) {
  await mkdir(join(directory, 'source-' + phase))
  const entries = []
  for (const path of paths) {
    const bytes = await readFile(path)
    await writeFile(join(directory, 'source-' + phase, path.replaceAll('/', '__')), bytes)
    entries.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await save('source-' + phase + '.json', { at: new Date().toISOString(), pid: process.pid, argv: process.argv, entries })
  return entries
}
const start = await source('start')
console.log(JSON.stringify({ stage: 'source-start', directory, pid: process.pid, argv: process.argv, mode, scope: mode === 'component' ? 'isolated real-sample qualification and synthetic sealed filesystem units; no business producer' : 'real Node HTTP / HostSim / production archive thresholds' }))
try {
  if (mode === 'component') {
    const cases = await runArchiveComponents({ directory, save })
    await save('result.json', { result: 'passed', cases })
    console.log(JSON.stringify({ stage: 'passed', cases: cases.length, directory }))
  } else await runArchiveLive({ directory, save })
} catch (cause) {
  await save('failure.json', { message: cause.message, code: cause.code, stack: cause.stack })
  console.error(cause)
  process.exitCode = 1
} finally {
  const end = await source('end'), sourceChanged = JSON.stringify(start) !== JSON.stringify(end)
  await save('source-comparison.json', { sourceChanged })
  if (sourceChanged) process.exitCode = 1
  console.log(JSON.stringify({ stage: 'closed', directory, sourceChanged, exitCode: process.exitCode ?? 0 }))
}
