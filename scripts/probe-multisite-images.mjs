import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { createFileStore } from '../src/store/file-store.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createLocalAgentHost } from '../packages/agent-host/local.mjs'
import { seedMultisite } from './fixtures/multisite/runtime.mjs'

const evidenceRoot = '/home/gewu/.codex/task-checkpoints/geneway-evidence'
await mkdir(evidenceRoot, { recursive: true })
const temp = await mkdtemp(join(evidenceRoot, 'images-native-')), captures = [], errors = []
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
let provider, server, service
try {
  const statePath = join(temp, 'state.json'), store = createFileStore(statePath); await store.update(seedMultisite)
  await mkdir(join(temp, 'secrets')); await writeFile(join(temp, 'secrets/model.key'), 'synthetic-native-provider-only', { mode: 0o600 })
  const config = readRuntimeConfig({ GENEWAY_STATE: statePath, GENEWAY_SECRET_ROOT: join(temp, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'model.key' }, process.cwd())
  const attachments = createArtifactService({ store, root: join(temp, 'attachments') })
  provider = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer synthetic-native-provider-only')
      assert.deepEqual((body.tools ?? []).map(tool => tool.function?.name), ['geneway_multisite_report'])
      const lastUser = body.messages.findLastIndex(message => message.role === 'user'), lastContent = JSON.stringify(body.messages[lastUser]?.content)
      const hasTool = body.messages.slice(lastUser + 1).some(message => message.role === 'tool')
      const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image_url').map(block => { const match = /^data:([^;]+);base64,(.*)$/.exec(block.image_url.url); const bytes = Buffer.from(match[2], 'base64'); return { sha256: sha256(bytes), mediaType: match[1], sizeBytes: bytes.length } }) : [])
      captures.push({ model: body.model, tools: body.tools.map(tool => tool.function.name), inputText: lastContent.replace(/data:image[^" ]+/g, '[image]'), images })
      const report = lastContent.includes('ANSWER:') ? { state: 'ready', summary: '已收到日期，等待后续文件生成与核验' } : { state: 'waiting', summary: '资料已收到，缺少日期', question: '异常发生日期是什么？' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'capture-' + captures.length, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (!hasTool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: `report-${captures.length}`, type: 'function', function: { name: 'geneway_multisite_report', arguments: JSON.stringify(report) } }] }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '已保存报告候选。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { errors.push(cause.message); response.writeHead(500); response.end('capture error') }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  let clockOffset = 0
  const gateway = createModelGateway({ store, attachments, config, clock: () => Date.now() + clockOffset, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` })
  let origin
  const host = createLocalAgentHost({ store, root: process.cwd(), config, gateway, gatewayOrigin: () => origin })
  service = createWorkService({ store, multisiteOptions: { attachments, hosts: [host], onError: cause => { errors.push(cause.code ?? cause.message); console.error('native image dispatcher', cause.code ?? cause.message) } } })
  const authPath = join(temp, 'auth.json'); await initializeAuthFile(authPath, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  server = createGenewayServer({ service, store, attachments, modelGateway: gateway, auth: createAuthRuntime({ filePath: authPath }), trustedOrigin: 'http://localhost', index: await readFile('web/index.html', 'utf8') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`
  async function api(path, { method = 'GET', body, bytes, session } = {}) {
    const response = await fetch(origin + path, { method, headers: { origin: 'http://localhost', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), ...(bytes ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}) }, body: bytes ?? (body ? JSON.stringify(body) : undefined) })
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = await api('/api/session', { method: 'POST', body: { loginName: 'owner', password: 'synthetic owner password' } }), session = { ...login.value, cookie: login.cookie }
  const files = await Promise.all(['#cb4335', '#2e86c1'].map(async (background, index) => {
    const bytes = await sharp({ create: { width: 83 + index, height: 47, channels: 3, background } }).png().toBuffer()
    const item = (await api('/api/attachments/init', { method: 'POST', session, body: { clientRequestId: 'native-image-' + index, name: `现场${index}.png`, mediaType: 'image/png', sizeBytes: bytes.length, sha256: sha256(bytes) } })).value
    await api(`/api/attachments/${item.id}/content`, { method: 'PUT', session, bytes })
    return { ...item, originalSha256: sha256(bytes) }
  }))
  const works = await Promise.all(files.map(async (item, index) => (await api('/api/works', { method: 'POST', session, body: { workType: 'multisite', employeeId: index ? 'worker' : 'coordinator', goal: `IMAGE_WORK_${index}:请核对已上传图片，缺日期先追问。`, clientRequestId: `native-work-${index}`, attachmentRefs: [item.ref] } })).value))
  service.multisite.start()
  await until(async () => (await store.read()).works.every(work => work.status === 'waiting_input'))
  const first = await store.read()
  assert.equal(first.modelRequests.length, captures.length); assert(first.modelRequests.length >= 2)
  assert.equal(new Set(first.multisite.attempts.map(row => row.session_id)).size, 2)
  const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
  const processEvidence = []
  for (const pid of children) {
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8'); if (!command.includes('runtime-worker.mjs')) continue
    const env = Object.fromEntries((await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').filter(Boolean).map(field => { const index = field.indexOf('='); return [field.slice(0, index), field.slice(index + 1)] }))
    assert.equal(env.ZENMUX_API_KEY, undefined); assert(!Object.values(env).includes('synthetic-native-provider-only')); assert(env.GENEWAY_EXECUTION_TOKEN)
    processEvidence.push({ pid: Number(pid), home: env.HOME, dshHome: env.DSH_HOME, tokenDigest: sha256(env.GENEWAY_EXECUTION_TOKEN), providerKeyPresent: false })
  }
  assert.equal(processEvidence.length, 2); assert.equal(new Set(processEvidence.map(row => row.dshHome)).size, 2); assert.equal(new Set(processEvidence.map(row => row.tokenDigest)).size, 2)
  for (let index = 0; index < works.length; index++) {
    const variants = first.modelImageVariants.filter(row => row.work_id === works[index].id)
    assert(variants.length > 0); assert(variants.every(row => row.originalRef.sha256 === files[index].originalSha256))
    const matching = captures.filter(row => row.inputText.includes(`IMAGE_WORK_${index}`))
    assert(matching.length > 0); assert(matching.every(row => row.images.length === 1 && variants.some(variant => variant.sha256 === row.images[0].sha256)))
    assert(matching.every(row => !row.inputText.includes(`IMAGE_WORK_${1 - index}`)))
  }
  await until(async () => (await store.read()).modelRequests.every(row => row.outcome === 'completed'))
  clockOffset += 6 * 60_000
  const repeatedBytes = await sharp({ create: { width: 83, height: 47, channels: 3, background: '#cb4335' } }).png().toBuffer()
  const supplement = (await api('/api/attachments/init', { method: 'POST', session, body: { clientRequestId: 'expired-token-supplement', name: '补图.png', mediaType: 'image/png', sizeBytes: repeatedBytes.length, sha256: sha256(repeatedBytes) } })).value
  await api(`/api/attachments/${supplement.id}/content`, { method: 'PUT', session, bytes: repeatedBytes })
  await Promise.all(works.map((work, index) => api(`/api/works/${work.id}/multisite/inputs`, { method: 'POST', session, body: { text: `ANSWER:2026-11-0${index + 5}`, clientRequestId: `native-answer-${index}`, ...(index === 0 ? { attachmentRefs: [supplement.ref] } : {}) } })))
  await until(async () => (await store.read()).multisite.attempts.every(attempt => attempt.report?.state === 'ready'))
  await until(async () => (await store.read()).modelRequests.every(row => row.outcome === 'completed'))
  const afterSupplement = await store.read()
  assert(afterSupplement.modelImageVariants.some(row => row.originalRef.attachmentId === supplement.id))
  assert(afterSupplement.modelImageVariants.some(row => row.originalRef.attachmentId === files[0].id), 'same normalized image retains both original refs')
  process.kill(processEvidence[0].pid, 'SIGKILL')
  await until(async () => (await store.read()).works.some(work => work.status === 'interrupted'))
  const beforeCancelRequests = captures.length
  await Promise.all(works.map((work, index) => api(`/api/works/${work.id}/multisite/cancel`, { method: 'POST', session, body: { clientRequestId: `native-stop-${index}` } })))
  await until(async () => (await store.read()).works.every(work => work.status === 'cancelled'))
  const final = await store.read()
  assert.equal(captures.length, beforeCancelRequests, 'stop-only calibration never invokes provider')
  assert(final.multisite.receipts.filter(row => row.event.kind === 'stopped').every(row => row.event.stop_evidence === 'idle_after_cancel'))
  assert(final.modelRequests.some(row => row.instructionRevision === 1)); assert(final.modelRequests.some(row => row.instructionRevision === 2))
  assert.equal(final.works.reduce((sum, work) => sum + work.modelRequestBudget.reserved, 0), captures.length)
  assert(final.works.every(work => work.modelRequestBudget.reserved <= 12)); assert(final.multisite.attempts.every(attempt => attempt.observed_revision === 2))
  assert(final.modelRequests.every(row => row.outcome === 'completed' && row.usage === null)); assert.deepEqual(errors.filter(code => code !== 'RUNTIME_PROCESS_DIED'), [])
  await writeFile(join(temp, 'process-evidence.json'), JSON.stringify(processEvidence, null, 2))
  console.log(JSON.stringify({ result: 'passed', evidence: temp, boundary: 'two real HTTP Works, per-Attempt DSH child processes, production gateway, local synthetic provider; no real image understanding', workCount: 2, sessions: 2, providerRequests: captures.length, sharedBudgetMatchesForward: true, originalAndVariantHashesVerified: true, instructionRevisions: [...new Set(final.modelRequests.map(row => row.instructionRevision))], expiredTokenImageSupplement: true, sameNormalizedMultipleOriginals: true, killedWorkerStopOnlyCalibration: true, stopped: true }, null, 2))
} finally {
  await service?.close().catch(cause => console.error('native image close', cause.code ?? cause.message))
  for (const instance of [server, provider]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)) }
  await writeFile(join(temp, 'capture-summary.json'), JSON.stringify({ captures, errors }, null, 2))
  console.log('Image native evidence:', temp)
}
async function until(predicate) { const deadline = Date.now() + 60_000; while (!await predicate()) { assert(Date.now() < deadline, 'native image journey timed out'); await new Promise(resolve => setTimeout(resolve, 100)) } }
