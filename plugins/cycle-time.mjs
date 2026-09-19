import { defineTool } from '@deepseek-ai/dsh-tools'
import { calculateCycleTime } from '../src/domain/cycle-time.mjs'

export const name = 'geneway-cycle-time'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'geneway_calculate_cycle_time',
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
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${value.secondsPerUnit} 秒/件（${value.availableSeconds} 秒 ÷ ${value.quantity} 件）`
          : `${value.error.code}: ${value.error.message}`,
      }],
    },
    async execute(args) {
      return calculateCycleTime(args)
    },
  }))
}
