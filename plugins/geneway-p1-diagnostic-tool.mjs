import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'geneway-p1-diagnostic-tool'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'geneway_p1_diagnostic',
    description: 'Return the diagnostic payload without external I/O.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        source: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return { status: 'ok', source: 'geneway-p1-diagnostic-tool' }
    },
  }))

  void (async () => {
    const result = await ctx.tools.execute({
      callId: 'geneway-p1-diagnostic-call',
      name: 'geneway_p1_diagnostic',
      arguments: {},
      signal: new AbortController().signal,
    })
    process.stderr.write(`GENEWAY_P1_DSH_TOOL_RESULT ${JSON.stringify(result.content)}\n`)
  })().catch(error => {
    process.stderr.write(`GENEWAY_P1_DSH_TOOL_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  })
}
