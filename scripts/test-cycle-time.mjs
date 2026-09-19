import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply, inject } from '../plugins/cycle-time.mjs'
import { calculateCycleTime } from '../src/domain/cycle-time.mjs'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
const { default: SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href)
const host = new Context()
const plugin = Object.assign(apply, { inject })
const toolName = 'geneway_calculate_cycle_time'
let fiber

const reasonCases = [
  [{ quantity: 60 }, 'MISSING_AVAILABLE_SECONDS'],
  [{ availableSeconds: 3600 }, 'MISSING_QUANTITY'],
  [{ availableSeconds: '3600', quantity: 60 }, 'INVALID_AVAILABLE_SECONDS_TYPE'],
  [{ availableSeconds: 3600, quantity: '60' }, 'INVALID_QUANTITY_TYPE'],
  [{ availableSeconds: Number.NaN, quantity: 60 }, 'NON_FINITE_AVAILABLE_SECONDS'],
  [{ availableSeconds: 3600, quantity: Number.POSITIVE_INFINITY }, 'NON_FINITE_QUANTITY'],
  [{ availableSeconds: -1, quantity: 60 }, 'NEGATIVE_AVAILABLE_SECONDS'],
  [{ availableSeconds: 3600, quantity: 0 }, 'NON_POSITIVE_QUANTITY'],
  [{ availableSeconds: 3600, quantity: -1 }, 'NON_POSITIVE_QUANTITY'],
]

try {
  assert.deepEqual(calculateCycleTime({ availableSeconds: 3600, quantity: 60 }), {
    ok: true,
    availableSeconds: 3600,
    quantity: 60,
    secondsPerUnit: 60,
    unit: 'seconds/unit',
  })
  assert.equal(calculateCycleTime({ availableSeconds: 0, quantity: 60 }).secondsPerUnit, 0)
  for (const [input, code] of reasonCases) assert.equal(calculateCycleTime(input).error.code, code)

  await host.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await host.plugin(ToolRuntime, { mode: 'native' })
  fiber = host.plugin(plugin)
  await fiber
  assert.deepEqual(host.tools.schemas().map(schema => schema.name), [toolName])

  const execute = (arguments_, callId) => host.tools.execute({
    callId,
    name: toolName,
    arguments: arguments_,
    signal: new AbortController().signal,
  })
  const valid = await execute({ availableSeconds: 3600, quantity: 60 }, 'cycle-valid')
  assert.equal(valid.isError, false)
  assert.equal(valid.value.secondsPerUnit, 60)
  assert.equal(valid.value.unit, 'seconds/unit')
  const runtimeReasonCases = reasonCases.filter(([input]) => Object.values(input).every(value => typeof value !== 'number' || Number.isFinite(value)))
  for (const [index, [input, code]] of runtimeReasonCases.entries()) {
    const invalid = await execute(input, `cycle-invalid-${index}`)
    assert.equal(invalid.isError, false)
    assert.equal(invalid.value.ok, false)
    assert.equal(invalid.value.error.code, code)
  }
  for (const [index, input] of [{ availableSeconds: Number.NaN, quantity: 60 }, { availableSeconds: 3600, quantity: Number.POSITIVE_INFINITY }].entries()) {
    const nonJsonNumber = await execute(input, `cycle-non-json-number-${index}`)
    assert.equal(nonJsonNumber.isError, true)
    assert.equal(nonJsonNumber.error.message, 'tool execution arguments must be losslessly JSON-serializable')
  }
  const rendered = host.tools.get(toolName).output.render({}, valid.value)
  assert.deepEqual(rendered, [{ type: 'text', text: '60 秒/件（3600 秒 ÷ 60 件）' }])

  await fiber.dispose()
  fiber = undefined
  assert.equal(host.tools.get(toolName), undefined)
  console.log(JSON.stringify({ ok: true, toolName, valid: valid.value, invalidReasonCodes: reasonCases.map(([, code]) => code) }, null, 2))
} finally {
  await fiber?.dispose()
  await host.fiber.dispose()
}
