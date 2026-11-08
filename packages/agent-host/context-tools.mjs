import { defineTool } from '@deepseek-ai/dsh-tools'
import { error, exact } from '../agent-contracts/index.mjs'

// Only real request reservation may replace the parent's trusted model-step identity.
export function modelStepAfterIssue(previous, issued, reserveRequest) {
  if (!reserveRequest) return previous
  const step = issued?.modelStep
  if (!step || typeof step.requestId !== 'string' || !step.requestId || typeof step.inputMessageId !== 'string' || !step.inputMessageId || !step.manualFence || !['workGeneration', 'agentGeneration'].every(field => Number.isSafeInteger(step.manualFence[field]) && step.manualFence[field] >= 0)) return undefined
  return structuredClone(step)
}
export function createContextTools(read) {
  return [defineTool({
    name: 'geneway_read_context',
    description: 'Read one bounded page of authorized continuation history. Omit objectRef for the initial root; follow only returned nextRefs and cursors. A partial page is not the complete source. Reading does not grant execution or change current requirements.',
    parameters: {
      clientRequestId: { type: 'string', required: true },
      objectRef: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true }, id: { type: 'string', required: true }, version: { type: 'integer' } } },
      view: { type: 'string', enum: ['summary', 'content', 'manifest'], required: true },
      cursor: { type: 'string' }, maxItems: { type: 'integer' }, maxTokens: { type: 'integer' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_parameters, page) => [{ type: 'text', text: JSON.stringify(page) }] },
    async execute(parameters) {
      exact(parameters, ['clientRequestId', 'objectRef', 'view', 'cursor', 'maxItems', 'maxTokens'])
      if (parameters.objectRef) exact(parameters.objectRef, ['kind', 'id', 'version'])
      const page = await read(parameters)
      if (!page || typeof page !== 'object' || Array.isArray(page) || Buffer.byteLength(JSON.stringify(page)) > 16384) throw error('INVALID_RESPONSE', '历史上下文页面无效或超限')
      return page
    },
  })]
}
