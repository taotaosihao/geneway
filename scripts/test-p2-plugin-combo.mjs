import assert from 'node:assert/strict'
import { createServer as createNodeServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyCycle } from '../plugins/cycle-time.mjs'
import { apply as applyGearJob } from '../plugins/gearjob-work-order.mjs'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { CYCLE_TIME_TOOL, GEARJOB_TOOL, parseCapabilityToolResult } from '../src/capabilities.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
const { default: SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href)
const root = await mkdtemp(join(tmpdir(), 'geneway-p2-plugin-combo-'))
const statePath = join(root, 'state.json')
const secretRoot = join(root, 'secrets')
const authPath = join(root, 'private', 'auth.json')
const store = createFileStore(statePath)
const host = new Context()
let cycleFiber
let gearFiber
let service
let server

try {
  await mkdir(secretRoot, { mode: 0o700 })
  await store.update(seedState)
  await initializeAuthFile(authPath, { 'member-user': 'member password' }, { mode: 'create', allowedMemberIds: ['member-user'] })
  await host.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await host.plugin(ToolRuntime, { mode: 'native' })
  cycleFiber = host.plugin(Object.assign(applyCycle, { inject: ['tools'] }))
  gearFiber = host.plugin(Object.assign(applyGearJob, { inject: ['tools'] }))
  await Promise.all([cycleFiber, gearFiber])
  assert.deepEqual(host.tools.schemas().map(item => item.name).sort(), [CYCLE_TIME_TOOL, GEARJOB_TOOL])

  const runner = {
    configured: true,
    async run(options) {
      const grantPath = join(root, `grant-${options.executionId}.json`)
      await writeFile(grantPath, JSON.stringify({
        version: 2,
        executionId: options.executionId,
        memberId: options.sessionMetadata.ownerMemberId,
        employeeId: options.sessionMetadata.employeeId,
        skillId: options.sessionMetadata.skillId,
        capabilityId: options.capabilityId,
        workId: options.sessionMetadata.workId,
        modelRouteId: options.sessionMetadata.modelRouteId,
        operation: options.operation,
        expectedTool: CYCLE_TIME_TOOL,
        input: options.input,
        connection: null,
        confirmationFingerprint: options.sessionMetadata.confirmationFingerprint,
        confirmationRefs: options.sessionMetadata.confirmationRefs,
        policyFile: options.grant.policyFile,
        policyRoot: options.grant.policyRoot,
        secretRoot: options.grant.secretRoot,
      }), { mode: 0o600 })
      process.env.GENEWAY_DSH_GRANT_FILE = grantPath
      const toolResult = await host.tools.execute({
        callId: options.executionId,
        name: CYCLE_TIME_TOOL,
        arguments: options.input,
        signal: new AbortController().signal,
      })
      assert.equal(toolResult.isError, false)
      assert.equal(toolResult.value.ok, true)
      return {
        result: parseCapabilityToolResult(options.capabilityId, toolResult.value, options.input),
        explanation: '实际节拍插件已计算并保存结构化结果。',
        dshSessionRef: `session-${options.executionId}`,
        contextConfirmationRefs: options.sessionMetadata.confirmationRefs,
        continuity: 'new',
        eventCount: 2,
      }
    },
    async close() {},
  }
  service = createWorkService({ store, runner, policyPaths: { stateFile: statePath, dataRoot: root, secretRoot } })
  const auth = createAuthRuntime({ filePath: authPath })
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  server = createGenewayServer({ service, store, auth, index: '<!doctype html><title>plugin-combo</title>', trustedOrigin: origin })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))

  const login = await request(origin, '/api/session', { method: 'POST', origin, json: { loginName: 'member', password: 'member password' } })
  assert.equal(login.status, 200)
  const created = await request(origin, '/api/works', {
    method: 'POST', origin, cookie: login.cookie, csrf: login.body.csrfToken,
    json: { employeeId: 'employee-user', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600, quantity: 60 }, clientRequestId: 'plugin-combo' },
  })
  assert.equal(created.status, 200)
  const completed = await waitForWork(origin, created.body.id, login.cookie)
  assert.equal(completed.results[0].kind, 'manufacturing.takt')
  assert.equal(completed.results[0].payload.secondsPerUnit, 60)
  const savedResult = structuredClone(completed.results[0])

  await cycleFiber.dispose()
  cycleFiber = undefined
  assert.deepEqual(host.tools.schemas().map(item => item.name), [GEARJOB_TOOL])
  const disposed = await host.tools.execute({ callId: 'disposed-cycle', name: CYCLE_TIME_TOOL, arguments: { availableSeconds: 3600, quantity: 60 }, signal: new AbortController().signal })
  assert.equal(disposed.isError, true)
  assert.equal(disposed.error.info.code, 'UNKNOWN_TOOL')

  const page = await fetch(origin)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /plugin-combo/)
  const historical = await request(origin, `/api/works/${created.body.id}`, { cookie: login.cookie })
  assert.equal(historical.status, 200)
  assert.deepEqual(historical.body.results, [savedResult])
  assert.equal(historical.body.executions[0].resultId, savedResult.id)
  assert.equal(historical.body.results[0].toolName, CYCLE_TIME_TOOL)
  console.log('P2 actual plugin combination, Web/API continuity, and typed result history checks passed')
} finally {
  delete process.env.GENEWAY_DSH_GRANT_FILE
  if (server) await new Promise(resolve => server.close(resolve))
  await service?.close()
  await gearFiber?.dispose()
  await cycleFiber?.dispose()
  await host.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

async function request(origin, path, options = {}) {
  const headers = {}
  if (options.origin) headers.origin = options.origin
  if (options.cookie) headers.cookie = String(options.cookie).split(';', 1)[0]
  if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf
  let body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const response = await fetch(`${origin}${path}`, { method: options.method ?? 'GET', headers, body })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined, cookie: response.headers.get('set-cookie') }
}

async function waitForWork(origin, id, cookie) {
  let last
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(origin, `/api/works/${id}`, { cookie })
    last = response
    if (response.status === 200 && response.body.status === 'completed') return response.body
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for plugin-combo work: ${JSON.stringify(last)}`)
}

async function freePort() {
  const probe = createNodeServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

function seedState(state) {
  const now = '2026-09-19T00:00:00.000Z'
  return {
    ...state,
    members: [{ id: 'member-user', loginName: 'member', displayName: '成员', role: 'member', enabled: true, authRef: 'member-user', sessionVersion: 1, employeeIds: ['employee-user'], createdAt: now, updatedAt: now }],
    modelRoutes: [{ id: 'model-zenmux', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    skills: [{ id: 'skill-cycle-time-calculate', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }],
    employees: [{ id: 'employee-user', name: '成员员工', enabled: true, modelRouteId: 'model-zenmux', connectionIds: [], skillIds: ['skill-cycle-time-calculate'] }],
  }
}
