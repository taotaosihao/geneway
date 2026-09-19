import { defineTool } from '@deepseek-ai/dsh-tools'

export const KNOWLEDGE_TOOLS = Object.freeze({
  search: 'geneway_knowledge_search',
  submitReferences: 'geneway_knowledge_submit_references',
})

export function createKnowledgePlugin(invoke) {
  return Object.assign(ctx => {
    ctx.tools.register(tool(KNOWLEDGE_TOOLS.search, 'Search only the knowledge currently authorized for this execution.', {
      query: { type: 'string', required: true },
    }, invoke))
    ctx.tools.register(tool(KNOWLEDGE_TOOLS.submitReferences, 'Submit only exact references returned by this execution knowledge search.', {
      references: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false,
        properties: {
          knowledgeId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          segmentId: { type: 'string', required: true },
        },
      } },
    }, invoke))
  }, { inject: ['tools'] })
}

function tool(name, description, parameters, invoke) {
  return defineTool({
    name, description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, invocation = {}) {
      try {
        const allowed = name === KNOWLEDGE_TOOLS.search ? ['query'] : ['references']
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) throw Object.assign(new Error('知识工具参数无效'), { code: 'KNOWLEDGE_REFERENCE_INVALID' })
        return await invoke({ name, args, invocation })
      }
      catch (error) { return { ok: false, error: { code: error?.code ?? 'KNOWLEDGE_REFERENCE_INVALID', message: error?.message ?? '知识引用无效' } } }
    },
  })
}
