import { createContextTools } from './context-tools.mjs'
import { createIntentTools } from './intent-tools.mjs'
import { continuationBlock } from './input-context.mjs'
import { createDelegationTools, createCoordinatorSpreadsheetTools } from './delegation-tools.mjs'
import { createSpreadsheetTools } from './spreadsheet-tools.mjs'
import { createEvidenceTools } from './evidence-tools.mjs'
import { assertSiteRule, createSiteRuleTools, SITE_RULE_SYSTEM_PROMPT } from './site-rule-tool.mjs'
import { randomUUID, createHash } from 'node:crypto'
import { bootDshHost } from '../../src/dsh-host.mjs'
import { createDshRuntime } from './dsh-runtime.mjs'
import { buildAgentOperationsGuide } from './operations-guide.mjs'
import { binding, error, sameBinding, attachmentRefs } from '../agent-contracts/index.mjs'
import { modelAgentOptions } from '../../src/model-route.mjs'

let contextReadEnabled = false, siteRule, siteRuleIdle
let budgetResumeCommandId, intentReviewCommandId, turnIntentFence, executionGrant, execution, runtime, snapshot, imageMappings = [], activeCollaboration = false, stoppedOnly = false, spreadsheetEnabled = false, spreadsheetTemplateId, tokenValue = process.env.GENEWAY_EXECUTION_TOKEN
const launchValues = Object.freeze(Object.fromEntries(Object.entries(process.env).filter(([field]) => field !== 'GENEWAY_EXECUTION_TOKEN')))
delete process.env.GENEWAY_EXECUTION_TOKEN
const pending = new Map(), originalImages = new Map()
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function rpc(operation, payload) {
  const id = randomUUID()
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); process.send({ id, kind: 'call', operation, payload, binding: binding(execution) }) })
}
function rememberOriginal(normalizedId, ref) {
  if (!originalImages.has(normalizedId)) originalImages.set(normalizedId, new Map())
  originalImages.get(normalizedId).set(ref.attachmentId, ref)
}
async function init(value) {
  contextReadEnabled = value.contextReadEnabled === true; executionGrant = value.executionGrant; snapshot = value.modelSnapshot; activeCollaboration = value.activeCollaboration === true; spreadsheetEnabled = !!value.spreadsheetRequest; spreadsheetTemplateId = value.spreadsheetRequest?.templateId; imageMappings = value.imageMappings ?? []; stoppedOnly = value.stopOnly === true
  siteRule = value.siteRule === undefined ? undefined : assertSiteRule(value.siteRule)
  const siteTools = siteRule && createSiteRuleTools({ siteRule, grant: executionGrant,
    evidence: (operation, parameters) => rpc('evidenceTool', { operation, parameters }),
    submit: parameters => rpc('orchestrationTool', { operation: 'submit_site_diagnosis', parameters }),
    onSubmitTurn: idle => { siteRuleIdle = idle.then(() => true, () => false) },
  })
  for (const mapping of imageMappings) rememberOriginal(mapping.normalizedRef.attachmentId, mapping.originalRef)
  const environment = { get: name => { const value = name === 'GENEWAY_EXECUTION_TOKEN' ? tokenValue : launchValues[name]; return value === undefined ? undefined : { value, source: 'process' } }, getFrom: (name, sources) => sources.includes('process') ? environment.get(name) : undefined }
  runtime = createDshRuntime({ workspaceRoot: value.workspaceRoot, reportEnabled: !siteRule, systemPrompt: siteRule ? SITE_RULE_SYSTEM_PROMPT : undefined,
    operationsGuide: stoppedOnly ? undefined : buildAgentOperationsGuide(siteRule ? 'site-rule' : execution.parent_delegation_id === null ? 'coordinator' : 'delegated'),
    authorize: async (_, options = {}) => {
      if (stoppedOnly || siteRule && intentReviewCommandId) throw error('CANCELLED')
      const intentCommandId = options.intentReviewCommandId ?? (options.phase === 'request_metadata' ? intentReviewCommandId : undefined)
      const metadataCommandId = options.budgetResumeCommandId ?? (options.phase === 'request_metadata' ? budgetResumeCommandId : undefined)
      const result = intentCommandId ? await rpc('intentReviewStart',{commandId:intentCommandId}) : metadataCommandId ? await rpc('budgetResumeStart', { commandId: metadataCommandId }) : await rpc('authorize', { reserveRequest: options.reserveRequest === true, inputMessageId: options.inputMessageId })
      if (typeof result.contextReadEnabled === 'boolean') contextReadEnabled = result.contextReadEnabled
      snapshot = result.modelSnapshot
      if (result.token) tokenValue = result.token
    },
    optionsFor: async () => modelAgentOptions(snapshot),
    confirmPark: (_execution, options) => rpc('confirmPark', options ?? {}),
    toolsFor: () => stoppedOnly ? [] : siteTools ?? [...(contextReadEnabled ? createContextTools(parameters => rpc('contextTool', { parameters })) : []), ...createIntentTools((operation,parameters)=>rpc('orchestrationTool',{operation,parameters}),()=>runtime.park(execution)),...(activeCollaboration ? createDelegationTools((operation, parameters) => rpc('orchestrationTool', { operation, parameters }), () => runtime.park(execution)) : []), ...(spreadsheetTemplateId === 'incident-collaboration-v1' && executionGrant?.execution.capabilityIds.includes('collaboration.coordinate.v1') ? createCoordinatorSpreadsheetTools((operation, parameters) => rpc('orchestrationTool', { operation, parameters }), () => runtime.park(execution)) : []), ...createEvidenceTools((operation, parameters) => rpc('evidenceTool', { operation, parameters }), executionGrant), ...(spreadsheetEnabled && (!executionGrant || executionGrant.execution.capabilityIds.includes('office.xlsx.render.v1')) ? createSpreadsheetTools((operation, parameters) => rpc(operation === 'adopt_sources' ? 'orchestrationTool' : 'spreadsheetTool', { operation, parameters }), { collaboration: spreadsheetTemplateId === 'incident-collaboration-v1' }) : [])],
    boot: async () => {
      const native = await bootDshHost({ environment, profile: 'sdk', patchFiles: [value.profilePatch], args: [] })
      native.ctx.on('llm/stream', async function* (options, next) {
        if (stoppedOnly || options.sessionId !== execution.session_id || options.provider !== snapshot.provider || options.model !== snapshot.model || options.maxTokens !== snapshot.parameters.maxOutputTokens) throw error('FORBIDDEN')
        if (siteTools && (options.tools?.length !== siteTools.length || !siteTools.every(tool => options.tools.some(actual => actual.name === tool.name)))) throw error('FORBIDDEN', '现场规则工具范围不匹配')
        const inputMessageId = options.messages.findLast(message => message.role === 'user' && ['geneway-multisite', 'geneway-agent-message', 'geneway-intent-review'].includes(message.source?.kind))?.id
        const issued = await rpc('authorize', { reserveRequest: true, inputMessageId })
        if (typeof issued.contextReadEnabled === 'boolean') contextReadEnabled = issued.contextReadEnabled
        tokenValue = issued.token; turnIntentFence = issued.intentFence; budgetResumeCommandId = undefined
        for await (const chunk of next()) yield chunk
      })
      const readImageRequest = native.ctx.attachments.readImageRequest.bind(native.ctx.attachments)
      native.ctx.attachments.imageHostPath = () => undefined
      native.ctx.attachments.readImageRequest = async (ref, target, signal) => {
        const result = await readImageRequest(ref, target, signal), originals = originalImages.get(ref.attachmentId)
        if (!originals?.size) throw error('FORBIDDEN', '图片缺少当前工作来源')
        for (const originalRef of originals.values()) await rpc('registerVariant', { originalRef, normalizedRef: ref, variantId: result.variantId, sha256: sha256(result.data), mediaType: result.mediaType, sizeBytes: result.data.byteLength, width: result.width, height: result.height })
        return result
      }
      return native
    },
    contentFor: async (ctx, _, input) => {
      const content = [{ type: 'text', text: input.text }]
      if (siteRule) return [...content, { type: 'text', text: `本次现场规则范围：${JSON.stringify({ ...siteRule, instructionRevision: input.instructionRevision })}` }]
      const refs = attachmentRefs(input.attachmentRefs)
      if (refs.length) content.push({ type: 'text', text: `受控资料引用：${JSON.stringify(refs)}` })
      if (input.continuationContext) content.push(continuationBlock(input.continuationContext))
      if (input.executionContext) content.push({ type: 'text', text: `当前执行职责与授权（不能自行扩大）：${JSON.stringify(input.executionContext)}` })
      if (input.intentFence) content.push({type:'text',text:`当前附加意图判断用途（不是正式业务Input）：${JSON.stringify({intentFence:input.intentFence,sourceEvent:input.sourceEvent})}。只准读取该意图上下文、accept、handback、独立提问或回复；不得委派、采集或生成。`})
      if (input.intentAnswer) content.push({type:'text',text:`用户对本意图独立问题的回答（不更改D4问题槽或Work要求版本）：${JSON.stringify(input.intentAnswer)}`})
      if (input.messages) content.push({ type: 'text', text: `Agent来源消息（不是用户修订）：${JSON.stringify(input.messages)}` })
      if (input.spreadsheetRequest) content.push({ type: 'text', text: `用户整改表要求：${JSON.stringify(input.spreadsheetRequest)}。期限未明确时先向用户追问，不得自行补日期。` })
      if (refs.length) { const issued = await rpc('attachmentToken', {}); tokenValue = issued.token }
      for (const ref of refs) {
        const url = new URL(`/internal/model/attachments/${ref.attachmentId}/content`, process.env.GENEWAY_MODEL_GATEWAY)
        url.searchParams.set('version', String(ref.version)); url.searchParams.set('sha256', ref.sha256)
        const response = await fetch(url, { headers: { authorization: `Bearer ${tokenValue}` }, redirect: 'error' })
        if (!response.ok) throw error('FORBIDDEN', '附件读取未获准')
        const bytes = Buffer.from(await response.arrayBuffer())
        if (sha256(bytes) !== ref.sha256) throw error('INVALID_STATE', '附件原字节摘要不符')
        const mediaType = response.headers.get('content-type')
        if (['image/png', 'image/jpeg'].includes(mediaType)) {
          const normalizedRef = await ctx.attachments.saveImage({ data: bytes, mediaType })
          rememberOriginal(normalizedRef.attachmentId, ref)
          content.push({ type: 'image', attachment: normalizedRef })
        } else if (mediaType === 'application/json') content.push({ type: 'text', text: `异常历史资料：${new TextDecoder('utf-8', { fatal: true }).decode(bytes)}` })
        else throw error('INVALID_REQUEST', '附件类型尚不支持')
      }
      return content
    },
  })
  runtime.setReporter((launchId, report) => rpc('report', report))
  return true
}
process.on('message', async message => {
  if (message?.kind === 'reply') {
    if (!execution || !sameBinding(execution, message.binding)) return
    const waiting = pending.get(message.id); if (!waiting) return; pending.delete(message.id)
    if (message.failure) waiting.reject(error(message.failure.code, message.failure.message)); else waiting.resolve(message.value)
    return
  }
  if (message?.kind !== 'call' || !['init', 'start', 'deliver', 'inspectInputs', 'inspectState', 'park', 'stop', 'close', 'awaitSiteRuleIdle'].includes(message.operation)) return
  if (!execution && message.operation === 'init') execution = binding(message.binding)
  if (!execution || !sameBinding(execution, message.binding)) return
  let value, failure
  try {
    if (message.operation === 'init') { if (runtime) throw error('INVALID_STATE'); value = await init(message.payload) }
    else if (!runtime) throw error('INVALID_STATE')
    else if (message.operation === 'start') { budgetResumeCommandId = message.payload?.budgetResumeCommandId; intentReviewCommandId = message.payload?.intentReviewCommandId; value = await runtime.start(execution, message.payload) }
    else if (message.operation === 'deliver') { budgetResumeCommandId = message.payload.budgetResumeCommandId; intentReviewCommandId = message.payload.intentReviewCommandId; spreadsheetEnabled = !!message.payload.spreadsheetEnabled; value = await runtime.deliver(execution, message.payload) }
    else if (message.operation === 'park') { runtime.park(execution); value = true }
    else if (message.operation === 'inspectState') value = await runtime.inspectState(execution)
    else if (message.operation === 'inspectInputs') value = await runtime.inspectInputs(execution, message.payload)
    else if (message.operation === 'awaitSiteRuleIdle') { if (!siteRule) throw error('FORBIDDEN'); value = siteRuleIdle ? await siteRuleIdle : false }
    else if (message.operation === 'stop') value = await runtime.stop(execution)
    else value = await runtime.close()
  } catch (cause) { failure = { code: cause.code ?? 'RUNTIME_UNAVAILABLE', message: cause.message } }
  if (process.connected) process.send({ id: message.id, kind: 'reply', binding: binding(execution), value, failure })
})
process.on('disconnect', () => { process.exit(1) })
