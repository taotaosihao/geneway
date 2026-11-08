import { seedDelegation } from './delegation.mjs'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { mkdir, readFile, writeFile, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { createFileStore } from '../../../src/store/file-store.mjs'
import { createArtifactService } from '../../../src/artifact-service.mjs'
import { createModelGateway } from '../../../src/model-gateway.mjs'
import { createWorkService } from '../../../src/work-service.mjs'
import { createKnowledgeService } from '../../../src/knowledge-service.mjs'
import { createGenewayServer } from '../../../src/server.mjs'
import { createAuthRuntime, initializeAuthFile } from '../../../src/auth.mjs'
import { readRuntimeConfig } from '../../../src/runtime-config.mjs'
import { createProcessRuntime } from '../../../packages/agent-host/process-runtime.mjs'
import { createAgentHost } from '../../../packages/agent-host/host.mjs'
import { createHostJournal } from '../../../packages/agent-host/journal.mjs'
import { seedMultisite } from './runtime.mjs'

export async function startProcessService({ directory, upstreamBaseUrl, holdHostIngestion = false, seedState, seedProfile = 'legacy', manualDrain = false, maxActiveLoops = 8, notify = () => {} }) {
  directory = resolve(directory); await mkdir(directory, { recursive: true, mode: 0o700 })
  const statePath = join(directory, 'state.json'), store = createFileStore(statePath)
  if (!(await store.read()).members.length) await store.update(state => {
    (seedState ?? (seedProfile === 'delegation' ? seedDelegation : seedMultisite))(state)
    state.skills = [{ id: 'cycle', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }]
    for (const employee of state.employees) employee.skillIds = ['cycle']
    return state
  })
  await mkdir(join(directory, 'secrets'), { recursive: true, mode: 0o700 })
  try { await writeFile(join(directory, 'secrets/model.key'), 'synthetic-fixture-provider-key', { flag: 'wx', mode: 0o600 }) } catch (cause) { if (cause.code !== 'EEXIST') throw cause }
  let provider
  const captures = [], errors = []
  if (!upstreamBaseUrl) {
    provider = createServer(async (request, response) => {
      try {
        let raw = ''; for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw), index = body.messages.findLastIndex(message => message.role === 'user'), current = body.messages[index], text = typeof current.content === 'string' ? current.content : current.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), hasTool = body.messages.slice(index + 1).some(message => message.role === 'tool')
        const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image_url').map(block => { const match = /^data:([^;]+);base64,(.*)$/.exec(block.image_url.url); return { mediaType: match[1], sha256: createHash('sha256').update(Buffer.from(match[2], 'base64')).digest('hex') } }) : [])
        captures.push({ model: body.model, tools: body.tools.map(tool => tool.function.name), images, supplemental: /2026-|ANSWER:/.test(text) })
        await writeFile(join(directory, 'provider-captures.json'), JSON.stringify(captures, null, 2))
        const report = /2026-|ANSWER:/.test(text) ? { state: 'ready', summary: '已收到补充日期与图片，已整理本次异常资料。' } : { state: 'waiting', summary: '现场资料已收到，需要核对发生日期。', question: '异常发生日期是什么？' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `fixture-${captures.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
        if (!hasTool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: `report-${captures.length}`, type: 'function', function: { name: 'geneway_multisite_report', arguments: JSON.stringify(report) } }] }); send({}, 'tool_calls') }
        else { send({ role: 'assistant', content: '已记录本次处理意见。' }); send({}, 'stop') }
        response.end('data: [DONE]\n\n')
      } catch (cause) { errors.push(cause.message); response.writeHead(500); response.end('fixture provider failed') }
    })
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); upstreamBaseUrl = `http://127.0.0.1:${provider.address().port}/v1`
  }
  const attachments = createArtifactService({ store, root: join(directory, 'attachments') })
  const config = readRuntimeConfig({ GENEWAY_STATE: statePath, GENEWAY_SECRET_ROOT: join(directory, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'model.key' }, process.cwd())
  const gateway = createModelGateway({ store, attachments, config, upstreamBaseUrl })
  const portServer = createPortServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const heldHandles = new Set()
  const journalOperations = holdHostIngestion ? { async open(path, flags, mode) {
    const handle = await open(path, flags, mode)
    return new Proxy(handle, { get(target, field) {
      if (field === 'writeFile') return async bytes => {
        if (String(path).endsWith('.tmp') && JSON.parse(String(bytes)).inbox.some(row => row.status === 'ingested')) { heldHandles.add(target); notify({ kind: 'host-ingestion-held' }); await new Promise(() => {}) }
        return target.writeFile(bytes)
      }
      const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value
    } })
  } } : {}
  const runtime = createProcessRuntime({ root: process.cwd(), config, gateway, gatewayOrigin: () => origin })
  const host = createAgentHost({ nodeId: 'local', maxActiveLoops, runtime, journal: createHostJournal(join(directory, 'multisite-host-local.json'), journalOperations) })
  const service = createWorkService({ store, multisiteOptions: { attachments, hosts: [host], onError: cause => { errors.push(cause.code ?? 'UNKNOWN'); notify({ kind: 'runtime-error', code: cause.code ?? 'UNKNOWN' }) } } })
  const authPath = join(directory, 'auth.json')
  try { await readFile(authPath) } catch (cause) { if (cause.code !== 'ENOENT') throw cause; await initializeAuthFile(authPath, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] }) }
  const server = createGenewayServer({ service, store, attachments, modelGateway: gateway, knowledge: createKnowledgeService({ store }), auth: createAuthRuntime({ filePath: authPath }), trustedOrigin: origin, index: await readFile(join(process.cwd(), 'web/index.html'), 'utf8') })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  for (const [name, color] of [['incident-red.png', '#cb4335'], ['incident-blue.png', '#2e86c1']]) await sharp({ create: { width: 80, height: 50, channels: 3, background: color } }).png().toFile(join(directory, name))
  if (!manualDrain) service.multisite.start()
  const summary = { kind: 'ready', origin, directory, statePath, imagePaths: [join(directory, 'incident-red.png'), join(directory, 'incident-blue.png')], loginName: 'owner', boundary: 'synthetic local provider, real production Host/gateway/DSH child processes' }
  notify(summary)
  return { ...summary, store, service, async close() { await service.close(); for (const instance of [server, provider]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)) } } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let instance
  const start = async options => { instance = await startProcessService({ ...options, notify: value => { if (process.connected) process.send(value); else console.log(JSON.stringify(value)) } }) }
  if (process.argv[2] === '--serve') await start({ directory: process.argv[3] })
  else process.once('message', options => { start(options).catch(cause => { console.error(cause.code ?? cause.message); process.exit(1) }) })
  process.on('SIGTERM', () => { instance?.close().finally(() => process.exit(0)) })
}
