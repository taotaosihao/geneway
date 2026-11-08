import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { arms } from './fixture.mjs'
import { hash, installAblation } from './ablation.mjs'
import { runArm } from './run.mjs'

const [arm, contextFile, directory] = process.argv.slice(2)
assert(arms.includes(arm) && isAbsolute(contextFile ?? '') && isAbsolute(directory ?? ''),
  '用法：node experiments/t25-routing-comparison/produce.mjs A|B|C /absolute/final-context.json /absolute/new-evidence-root')
const context = JSON.parse(await readFile(contextFile, 'utf8'))
assert.equal(context.node, process.version)
assert(typeof context.candidate === 'string' && context.candidate)
const sources = Object.entries(context.sources ?? {})
for (const path of [
  'src/interaction-service.mjs', 'src/server.mjs', 'src/routing-gateway.mjs', 'src/routing-batch.mjs', 'src/model-gateway.mjs', 'src/store/file-store.mjs',
  'scripts/fixtures/multisite/bridge-service.mjs', 'packages/agent-host/host.mjs', 'packages/agent-host/evidence-captures.mjs',
  ...['ablation.mjs', 'fixture.mjs', 'history.json', 'live.mjs', 'produce.mjs', 'provider.mjs', 'run.mjs', 'summarize.mjs'].map(name => 'experiments/t25-routing-comparison/' + name),
]) assert(context.sources?.[path], '冻结清单缺少 ' + path)
async function verify() {
  for (const [path, digest] of sources) {
    assert(!isAbsolute(path) && !path.split('/').includes('..'))
    assert.equal(hash(await readFile(path)), digest, '冻结候选文件不一致：' + path)
  }
}
await verify()
await mkdir(directory, { mode: 0o700 })
const wire = join(directory, 'raw.jsonl')
const record = value => appendFileSync(wire, JSON.stringify({ at: new Date().toISOString(), arm, ...value }) + '\n', { mode: 0o600 })
const hook = installAblation(arm, context.sources['src/interaction-service.mjs'])
record({ type: 'start', pid: process.pid, context, proof: hook.proof })
try {
  const { openArm } = await import('./live.mjs')
  hook.assertLoaded()
  await runArm(arm, { record, openArm: () => openArm({ directory, record }) })
} catch (error) {
  record({ type: 'fatal', message: error.message, stack: error.stack })
  throw error
} finally {
  hook.close()
  await verify()
  record({ type: 'source-end', matching: true })
}
