import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
const { default: SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href)

const toolName = 'p2_lifecycle_probe'
const host = new Context()
const hostIdentity = host
let ticks = 0

const lifecycleProbe = Object.assign((ctx) => {
  const timer = setInterval(() => ticks += 1, 5)
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Verify same-host Cordis plugin lifecycle cleanup.',
    parameters: {
      value: { type: 'integer', required: true },
    },
    output: {
      schema: { type: 'integer' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute({ value }) {
      return value + 1
    },
  }))
  return () => clearInterval(timer)
}, { inject: ['tools'] })

const pause = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))
const names = () => host.tools.schemas().map(schema => schema.name)
const call = (callId) => host.tools.execute({
  callId,
  name: toolName,
  arguments: { value: 41 },
  signal: new AbortController().signal,
})

let firstFiber
let secondFiber
try {
  await host.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
  })
  await host.plugin(ToolRuntime, { mode: 'native' })

  firstFiber = host.plugin(lifecycleProbe)
  await firstFiber
  assert.deepEqual(names(), [toolName])
  const firstResult = await call('p2-lifecycle-first')
  assert.equal(firstResult.isError, false)
  assert.equal(firstResult.value, 42)

  await pause(25)
  assert(ticks > 0)
  await firstFiber.dispose()
  firstFiber = undefined
  const ticksAtDispose = ticks
  await pause(20)
  assert.equal(ticks, ticksAtDispose)
  assert.equal(host.tools.get(toolName), undefined)
  assert.deepEqual(names(), [])
  const unavailableResult = await call('p2-lifecycle-disposed')
  assert.equal(unavailableResult.isError, true)
  assert.equal(unavailableResult.error.info.code, 'UNKNOWN_TOOL')

  secondFiber = host.plugin(lifecycleProbe)
  await secondFiber
  assert.equal(host, hostIdentity)
  assert.deepEqual(names(), [toolName])
  const secondResult = await call('p2-lifecycle-remount')
  assert.equal(secondResult.isError, false)
  assert.equal(secondResult.value, 42)

  await secondFiber.dispose()
  secondFiber = undefined
  assert.deepEqual(names(), [])

  console.log(JSON.stringify({
    ok: true,
    sameHost: host === hostIdentity,
    mount: { tools: [toolName], result: firstResult.value },
    dispose: { tools: [], errorCode: unavailableResult.error.info.code, ticksAtDispose },
    remount: { tools: [toolName], result: secondResult.value },
  }, null, 2))
} finally {
  await secondFiber?.dispose()
  await firstFiber?.dispose()
  await host.fiber.dispose()
}
