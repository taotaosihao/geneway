import { defineTool } from '@deepseek-ai/dsh-tools'
import { CYCLE_TIME_TOOL } from '../src/capabilities.mjs'
import { calculateCycleTime } from '../src/domain/cycle-time.mjs'
import { authorizeExecutionGrant, consumeExecutionGrant } from '../src/execution-grant.mjs'

export const name = 'geneway-cycle-time'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: CYCLE_TIME_TOOL,
    description: 'Deterministically calculate manufacturing cycle time in seconds per unit. Both inputs are required numbers.',
    parameters: {
      availableSeconds: { type: 'json', description: 'Required finite number of available seconds; must not be negative.' },
      quantity: { type: 'json', description: 'Required finite number of units; must be greater than zero.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              availableSeconds: { type: 'number', required: true },
              quantity: { type: 'number', required: true },
              secondsPerUnit: { type: 'number', required: true },
              unit: { type: 'string', const: 'seconds/unit', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              error: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  code: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, invocation = {}) {
      try {
        const grant = await consumeExecutionGrant({ toolName: CYCLE_TIME_TOOL, input: args })
        if (invocation.signal?.aborted) return failure('CANCELLED', '本次执行已停止')
        await authorizeExecutionGrant(grant)
        return calculateCycleTime(args)
      } catch (error) {
        return failure(['FORBIDDEN', 'CANCELLED'].includes(error?.code) ? error.code : 'FORBIDDEN', error?.message ?? '本次执行没有节拍换算授权')
      }
    },
  }))
}

function failure(code, message) {
  return { ok: false, error: { code, message } }
}
