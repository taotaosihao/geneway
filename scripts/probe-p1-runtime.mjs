import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { readRuntimeConfig, readSettings } from '../src/runtime-config.mjs'

const root = process.cwd()
const config = readRuntimeConfig(process.env, root)
const patchPath = join(root, 'config', 'p1-runtime.patch.yml')
const patchHash = createHash('sha256').update(await readFile(patchPath)).digest('hex')
const dshHome = await mkdtemp(join(tmpdir(), 'geneway-p1-probe-'))

try {
  const harness = new DeepSeekHarness({
    profile: 'sdk',
    patches: [patchPath],
    dshHome,
    processCwd: root,
    cwd: root,
    provider: config.model.provider,
    model: config.model.model,
    initializeTimeoutMs: 15_000,
    requestTimeoutMs: 120_000,
    env: childEnvironment(config),
  })
  try {
    await harness.start()
    const result = process.env.GENEWAY_P1_PROBE_MODEL === 'true'
      ? await harness.run('这是无业务数据的运行探针。请只回复 OK，不调用工具，不读取文件，不执行写入。')
      : undefined
    const requestHeader = result?.events.find(event => event.type === 'request/header')?.data?.header
    const toolNames = (requestHeader?.tools ?? []).map(tool => tool?.function?.name ?? tool?.name).filter(Boolean)
    const forbiddenMarkers = ['create_goal', 'exit_plan_mode', 'get_goal', 'todo_write', 'update_goal', 'Available skills', 'workspace-write', root]
    const serializedEvents = JSON.stringify(result?.events ?? [])
    const forbiddenMarkerCount = result ? forbiddenMarkers.filter(marker => serializedEvents.includes(marker)).length : 0
    if (result && (!requestHeader || toolNames.length !== 1 || toolNames[0] !== 'geneway_gearjob_read_work_order' || forbiddenMarkerCount !== 0)) {
      throw new Error('P1 model request surface is broader than the single GearJob read-only tool')
    }
    console.log(JSON.stringify({
      profile: 'sdk',
      patchSha256: patchHash,
      provider: config.model.provider,
      model: config.model.model,
      sourceConfigured: config.source.configured,
      modelProbe: result ? {
        ok: true,
        sessionId: result.sessionId,
        eventCount: result.events.length,
        responseBytes: Buffer.byteLength(result.finalResponse),
        eventShape: result.events.map(event => ({ type: event.type, dataKeys: Object.keys(event.data ?? {}).sort() })),
        requestSurface: requestHeader ? {
          keys: Object.keys(requestHeader).sort(),
          toolNames,
          forbiddenMarkerCount,
        } : undefined,
      } : { skipped: true, reason: 'set GENEWAY_P1_PROBE_MODEL=true to send the non-business probe' },
    }))
  } finally {
    await harness.close().catch(() => undefined)
  }
} finally {
  await rm(dshHome, { recursive: true, force: true })
}

function childEnvironment(config) {
  const settings = readSettings()
  const settingsEnv = settings?.env && typeof settings.env === 'object' ? settings.env : {}
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, DSH_TELEMETRY_MODE: 'DISABLED' }
  if (typeof settingsEnv.ANTHROPIC_AUTH_TOKEN === 'string' && settingsEnv.ANTHROPIC_AUTH_TOKEN.trim()) env.ZENMUX_API_KEY = settingsEnv.ANTHROPIC_AUTH_TOKEN
  return env
}
