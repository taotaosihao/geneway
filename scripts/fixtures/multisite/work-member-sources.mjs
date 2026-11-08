import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const paths = [
  'src/work-member-removal.mjs', 'src/store/file-store.mjs', 'src/server.mjs', 'src/work-service.mjs',
  'src/multisite-authorization.mjs', 'src/context-read-access.mjs', 'src/model-gateway.mjs', 'src/node-bridge.mjs',
  'src/evidence-service.mjs', 'src/evidence-access.mjs', 'src/spreadsheet-artifacts.mjs', 'src/spreadsheet-service.mjs',
  'packages/agent-orchestration/service.mjs', 'packages/agent-orchestration/dependencies.mjs',
  'packages/agent-orchestration/assignments.mjs', 'packages/agent-orchestration/state.mjs',
  'packages/agent-orchestration/execution-dispatch.mjs', 'packages/agent-host/host.mjs',
  'packages/agent-host/dsh-runtime.mjs', 'packages/agent-host/spreadsheet-jobs.mjs',
  'scripts/fixtures/multisite/bridge-service.mjs', 'scripts/fixtures/multisite/work-member-sources.mjs', 'web/index.html',
]
export async function captureWorkMemberSources(root, phase, extraPaths = []) {
  const files = []
  for (const path of [...new Set([...paths, ...extraPaths])]) {
    const bytes = await readFile(path), target = join(root, 'source-' + phase, path)
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
    files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const result = { observedAt: new Date().toISOString(), boundary: 'Actual local source bytes read at this phase; no earlier-load or dependency-installation claim', files }
  await writeFile(join(root, 'source-' + phase + '.json'), JSON.stringify(result, null, 2))
  if (phase === 'end') assert.deepEqual(files, JSON.parse(await readFile(join(root, 'source-start.json'))).files, 'Source changed during this run')
  return result
}
