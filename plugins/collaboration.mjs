import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'geneway-collaboration'
export const inject = ['tools']
export const COLLABORATION_TOOLS = Object.freeze({
  summarize: 'geneway_collaboration_submit_summary',
})

export function apply(ctx) {
  for (const tool of createCollaborationTools()) ctx.tools.register(tool)
}

export function createCollaborationTools({ invoke = unavailable } = {}) {
  return [tool(COLLABORATION_TOOLS.summarize, 'Submit a final factual summary using only the persisted child result references supplied by the host.', {
      resultRefs: { type: 'array', items: { type: 'string' }, description: 'Persisted child result IDs.' },
    }, invoke)]
}

function tool(name, description, parameters, invoke) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, invocation = {}) {
      try { return await invoke({ name, args, invocation }) }
      catch (error) { return { ok: false, error: { code: error?.code ?? 'FORBIDDEN', message: error?.message ?? '协作操作未获准' } } }
    },
  })
}

async function unavailable() { throw Object.assign(new Error('协作运行时未配置'), { code: 'FORBIDDEN' }) }
