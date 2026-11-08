import { defineTool } from '@deepseek-ai/dsh-tools'
import { error, exact, text } from '../agent-contracts/index.mjs'
import { SITE_RULE_TOOLS, SITE_RESOURCE, SITE_CAPABILITY } from '../agent-contracts/site-rule.mjs'
import { createEvidenceTools } from './evidence-tools.mjs'

export const SITE_RULE_SYSTEM_PROMPT = '你只处理本次受管现场异常规则。按输入的固定资源、时间窗和当前要求版本调用 geneway_inspect_site，sections 必须含 recent_events。用返回的 EvidenceRef 调用 geneway_read_shared_evidence，找到包含本次事件的完整证据页。只把真实读取返回的 readId 和当前要求版本交给 geneway_submit_site_diagnosis。草稿结论由服务端校验生成，不自行编写未验结论，不得对外发送、改变设备或访问其他工作。'

export function assertSiteRule(value) {
  exact(value, ['eventId', 'eventAt', 'window', 'resourceId']); exact(value.window, ['from', 'to'])
  text(value.eventId, '规则事件')
  const [from, at, to] = [value.window.from, value.eventAt, value.window.to].map(input => typeof input === 'string' ? Date.parse(input) : NaN)
  if (value.resourceId !== SITE_RESOURCE || ![from, at, to].every(Number.isFinite) || from > at || at > to) throw error('FORBIDDEN', '现场规则证据范围无效')
  return value
}

export function createSiteRuleTools({ siteRule, grant, evidence, submit, onSubmitTurn }) {
  if (!grant?.execution?.capabilityIds?.includes(SITE_CAPABILITY)) throw error('FORBIDDEN', '执行未获准读取现场证据')
  const reads = createEvidenceTools((operation, parameters) => {
    if (operation === 'inspect_site' && (parameters.resourceId !== siteRule.resourceId || parameters.window?.from !== siteRule.window.from || parameters.window?.to !== siteRule.window.to || !parameters.sections.includes('recent_events'))) throw error('FORBIDDEN', '只允许按固定时间窗核对本次现场事件')
    return evidence(operation, parameters)
  }, grant).filter(tool => SITE_RULE_TOOLS.includes(tool.name))
  const submitTool = defineTool({
    name: 'geneway_submit_site_diagnosis',
    description: 'Submit only the actual readId of the authorized evidence page containing this rule event. The server verifies and creates the internal draft for this Work.',
    parameters: { clientRequestId: { type: 'string', required: true }, instructionRevision: { type: 'integer', required: true }, readId: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'object', additionalProperties: false, required: true, properties: { workId: { type: 'string', required: true }, draftId: { type: 'string', required: true }, status: { type: 'string', enum: ['completed'], required: true } } } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.result) }] },
    async execute(parameters, invocation) {
      exact(parameters, ['clientRequestId', 'instructionRevision', 'readId'])
      // The cloud may deliver settle before the same tool's response returns.
      onSubmitTurn(invocation.agent.whenIdle())
      const reply = await submit(parameters)
      if (reply?.status !== 'completed' || typeof reply.workId !== 'string' || typeof reply.draftId !== 'string') throw error('SITE_RULE_SUBMIT_UNCONFIRMED', '现场诊断草稿尚未确认')
      invocation.concludeTurn()
      return { result: { workId: reply.workId, draftId: reply.draftId, status: reply.status } }
    },
  })
  // The SDK property-map shorthand leaves the root object open.
  submitTool.parameters.additionalProperties = false
  return [...reads, submitTool]
}
