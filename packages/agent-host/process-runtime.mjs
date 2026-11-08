import { modelStepAfterIssue } from './context-tools.mjs'
import { fork } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { binding, error, key, sameBinding } from '../agent-contracts/index.mjs'

export function createProcessRuntime({ root, config, gateway, gatewayOrigin }) {
  if (!gateway || typeof gatewayOrigin !== 'function') throw new Error('Agent Host 必须配置生产模型代理')
  const workers = new Map()
  let reporter, spreadsheetHandler, orchestrationHandler, evidenceHandler
  function trackWorker(worker) {
    const { child } = worker
    worker.termination = new Promise(resolve => { const ended = () => { worker.exited = true; child.stderr?.destroy(); resolve() }; child.once('exit', ended); child.once('close', ended) })
    child.on('exit', () => { worker.dead = true; worker.exited = true; for (const pending of worker.pending.values()) pending.reject(error('RUNTIME_PROCESS_DIED', '执行子进程已退出，禁止静默新建会话')); worker.pending.clear() })
    child.on('error', () => { worker.dead = true; child.kill('SIGKILL'); for (const pending of worker.pending.values()) pending.reject(error('RUNTIME_PROCESS_DIED')); worker.pending.clear() })
  }
  async function start(execution, { budgetResumeCommandId, intentReviewCommandId } = {}) {
    if (workers.has(execution.launch_id)) { workers.get(execution.launch_id).budgetResumeCommandId = budgetResumeCommandId; workers.get(execution.launch_id).intentReviewCommandId = intentReviewCommandId; return call(workers.get(execution.launch_id), 'start', execution, { budgetResumeCommandId, intentReviewCommandId }) }
    const issued = intentReviewCommandId ? await gateway.issueIntentReview(execution, intentReviewCommandId) : budgetResumeCommandId ? await gateway.issueBudgetResume(execution, budgetResumeCommandId) : await gateway.issue(execution), home = join(config.dataRoot, 'multisite-executions', key(execution.attempt_id, execution.execution_epoch))
    await mkdir(join(home, 'dsh'), { recursive: true, mode: 0o700 })
    const values = Object.fromEntries(['PATH', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_EXTRA_CA_CERTS'].filter(field => typeof process.env[field] === 'string').map(field => [field, process.env[field]]))
    const child = fork(fileURLToPath(new URL('./runtime-worker.mjs', import.meta.url)), [], { cwd: home, env: { ...values, HOME: home, DSH_HOME: join(home, 'dsh'), DSH_TELEMETRY_MODE: 'DISABLED', GENEWAY_EXECUTION_TOKEN: issued.token, GENEWAY_MODEL_GATEWAY: gatewayOrigin() }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' })
    const worker = { child, binding: binding(execution), pending: new Map(), dead: false, exited: false, budgetResumeCommandId, intentReviewCommandId, activeIntentFence: undefined, siteRule: issued.siteRule !== undefined }
    workers.set(execution.launch_id, worker)
    child.stderr.resume()
    trackWorker(worker)
    child.on('message', async message => {
      if (!message || !sameBinding(worker.binding, message.binding)) return
      if (message.kind === 'reply') {
        const pending = worker.pending.get(message.id)
        if (!pending) return
        worker.pending.delete(message.id)
        if (message.failure) pending.reject(error(message.failure.code, message.failure.message))
        else pending.resolve(message.value)
        return
      }
      if (message.kind !== 'call' || !['authorize', 'attachmentToken', 'registerVariant', 'report', 'spreadsheetTool', 'evidenceTool', 'orchestrationTool', 'confirmPark', 'budgetResumeStart', 'intentReviewStart', 'contextTool'].includes(message.operation)) return
      let value, failure
      try {
        if (worker.siteRule && (!['authorize', 'confirmPark', 'evidenceTool', 'orchestrationTool', 'budgetResumeStart'].includes(message.operation) || message.operation === 'evidenceTool' && !['inspect_site', 'read_shared_evidence'].includes(message.payload?.operation) || message.operation === 'orchestrationTool' && message.payload?.operation !== 'submit_site_diagnosis')) throw error('FORBIDDEN')
        if (['report','spreadsheetTool','evidenceTool','contextTool'].includes(message.operation) || message.operation === 'orchestrationTool' && !['synchronizeIntent','synchronizeBudgetResume','confirmPark'].includes(message.payload.operation)) { if (!orchestrationHandler) throw error('FORBIDDEN'); await orchestrationHandler(execution, 'assertManualFence', { manualFence: worker.activeManualFence }) }
        if (message.operation === 'intentReviewStart') { if (!worker.intentReviewCommandId || worker.intentReviewCommandId !== message.payload.commandId) throw error('FORBIDDEN'); value = await gateway.issueIntentReview(execution, message.payload.commandId) }
        else if (worker.activeIntentFence && ['report','spreadsheetTool','evidenceTool','attachmentToken','registerVariant'].includes(message.operation)) throw error('FORBIDDEN','当前模型轮次仅有意图判断用途')
        else if (message.operation === 'budgetResumeStart') { if (!worker.budgetResumeCommandId || worker.budgetResumeCommandId !== message.payload.commandId) throw error('FORBIDDEN'); value = await gateway.issueBudgetResume(execution, message.payload.commandId) }
        else if (message.operation === 'authorize') {
          if (worker.intentReviewCommandId) {
            if (message.payload.reserveRequest) await orchestrationHandler(execution,'synchronizeIntent',{commandId:worker.intentReviewCommandId})
            const issued=await gateway.issueIntentReview(execution,worker.intentReviewCommandId,{request:!!message.payload.reserveRequest,inputMessageId:message.payload.inputMessageId})
            if(message.payload.reserveRequest)worker.activeIntentFence=issued.intentFence
            value=issued
          } else if(worker.budgetResumeCommandId){
            if(message.payload.reserveRequest){if(!orchestrationHandler)throw error('FORBIDDEN');await orchestrationHandler(execution,'synchronizeBudgetResume',{commandId:worker.budgetResumeCommandId})}
            value=await gateway.issueBudgetResume(execution,worker.budgetResumeCommandId,{request:!!message.payload.reserveRequest,inputMessageId:message.payload.inputMessageId})
            if(message.payload.reserveRequest){worker.activeIntentFence=value.intentFence;if(!value.intentFence)worker.budgetResumeCommandId=undefined}
          } else {
          if (message.payload.reserveRequest) { value = await gateway.issue(execution, { request: true, inputMessageId: message.payload.inputMessageId }); worker.activeIntentFence = value.intentFence }
          else { const access = await gateway.authorize(execution); value = { modelSnapshot: access.current.modelSnapshot } }
          }
          if (message.payload.reserveRequest) { worker.activeManualFence = value.manualFence; worker.activeModelStep = modelStepAfterIssue(worker.activeModelStep, value, true) }
        } else if (message.operation === 'contextTool') { if (!worker.activeModelStep || !gateway.context?.read) throw error('CONTEXT_UNAVAILABLE'); value = await gateway.context.read(execution, message.payload.parameters, worker.activeModelStep) }
        else if (message.operation === 'attachmentToken') value = await gateway.issue(execution, { refresh: true })
        else if (message.operation === 'registerVariant') value = await gateway.registerVariant(execution, message.payload)
        else if (message.operation === 'orchestrationTool' || message.operation === 'confirmPark') { if (!orchestrationHandler) throw error('FORBIDDEN'); const operation=message.operation === 'confirmPark' ? 'confirmPark' : message.payload.operation, isIntent=['intent_context','accept_intent','handback_intent','ask_intent','reply_intent','split_intent'].includes(operation);if(isIntent&&!['intent_context','reply_intent','split_intent'].includes(operation)&&!worker.activeIntentFence||!isIntent&&operation!=='confirmPark'&&worker.activeIntentFence)throw error('FORBIDDEN');value=await orchestrationHandler(execution,operation,message.operation === 'confirmPark' ? message.payload : isIntent&&worker.activeIntentFence?{...message.payload.parameters,intentFence:worker.activeIntentFence}:message.payload.parameters, { manualFence: worker.activeManualFence }) }
        else if (message.operation === 'spreadsheetTool') { if (!spreadsheetHandler) throw error('FORBIDDEN'); value = await spreadsheetHandler(execution, message.payload.operation, message.payload.parameters) }
        else if (message.operation === 'evidenceTool') { if (!evidenceHandler) throw error('FORBIDDEN'); value = await evidenceHandler(execution, message.payload.operation, message.payload.parameters) }
        else value = await reporter(execution.launch_id, message.payload)
      } catch (cause) { failure = { code: cause.code ?? 'RUNTIME_UNAVAILABLE', message: cause.message } }
      if (child.connected) child.send({ id: message.id, kind: 'reply', binding: worker.binding, value, failure })
    })
    await call(worker, 'init', execution, { workspaceRoot: home, profilePatch: join(dirname(fileURLToPath(import.meta.url)), '../../config/multisite-runtime.patch.yml'), modelSnapshot: issued.modelSnapshot, imageMappings: issued.imageMappings, spreadsheetRequest: issued.spreadsheetRequest, activeCollaboration: issued.activeCollaboration, contextReadEnabled: issued.contextReadEnabled === true, executionGrant: issued.executionGrant, siteRule: issued.siteRule })
    return call(worker, 'start', execution, { budgetResumeCommandId, intentReviewCommandId })
  }
  function call(worker, operation, execution, payload) {
    if (!worker || worker.dead || !worker.child.connected) return Promise.reject(error('RUNTIME_PROCESS_DIED', '执行子进程不可用'))
    if (!sameBinding(worker.binding, execution)) return Promise.reject(error('FORBIDDEN'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      worker.pending.set(id, { resolve, reject })
      worker.child.send({ id, kind: 'call', operation, binding: binding(execution), payload }, cause => { if (cause) { worker.pending.delete(id); reject(error('RUNTIME_PROCESS_DIED')) } })
    })
  }
  const api = {
    supportsAttachments: true,
    setOrchestrationHandler(value) { orchestrationHandler = value },
    setEvidenceHandler(value) { evidenceHandler = value },
    setReporter(value) { reporter = value }, setSpreadsheetHandler(value) { spreadsheetHandler = value }, start,
    checkExecution(execution) { if (workers.get(execution.launch_id)?.dead) throw error('RUNTIME_PROCESS_DIED', '执行子进程已退出，推理结果待核对') },
    async deliver(execution,input) { await start(execution,input);const worker=workers.get(execution.launch_id);worker.budgetResumeCommandId=input.budgetResumeCommandId;worker.intentReviewCommandId=input.intentReviewCommandId;const issued=input.intentReviewCommandId?await gateway.issueIntentReview(execution,input.intentReviewCommandId):input.budgetResumeCommandId?await gateway.issueBudgetResume(execution,input.budgetResumeCommandId):null;const access=issued?{work:{spreadsheetRequest:issued.spreadsheetRequest}}:await gateway.authorize(execution);return call(worker,'deliver',execution,{...input,spreadsheetEnabled:!!access.work.spreadsheetRequest}) },
    park(execution) { return call(workers.get(execution.launch_id), 'park', execution) },
    inspectState(execution) { return call(workers.get(execution.launch_id), 'inspectState', execution) },
    inspectInputs(execution, ids) { return call(workers.get(execution.launch_id), 'inspectInputs', execution, ids) },
    async stop(execution) {
      let worker = workers.get(execution.launch_id)
      if (worker?.dead && !worker.exited) await worker.termination
      if (!worker || worker.exited) {
        if (!execution.runtimeStarted) return { evidence: 'never_started' }
        // A stop-only worker has no model credentials or token and cannot start inference.
        const home = join(config.dataRoot, 'multisite-executions', key(execution.attempt_id, execution.execution_epoch))
        const child = fork(fileURLToPath(new URL('./runtime-worker.mjs', import.meta.url)), [], { cwd: home, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: join(home, 'dsh'), DSH_TELEMETRY_MODE: 'DISABLED', GENEWAY_MODEL_GATEWAY: gatewayOrigin() }, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' })
        worker = { child, binding: binding(execution), pending: new Map(), dead: false, exited: false }; workers.set(execution.launch_id, worker)
        child.on('message', message => { if (message?.kind !== 'reply' || !sameBinding(worker.binding, message.binding)) return; const pending = worker.pending.get(message.id); worker.pending.delete(message.id); if (message.failure) pending?.reject(error(message.failure.code, message.failure.message)); else pending?.resolve(message.value) })
        trackWorker(worker)
        await call(worker, 'init', execution, { stopOnly: true, workspaceRoot: home, profilePatch: join(dirname(fileURLToPath(import.meta.url)), '../../config/multisite-runtime.patch.yml') })
      }
      return call(worker, 'stop', execution)
    },
    async settle(execution) {
      const ruleWorker = workers.get(execution.launch_id)
      if (ruleWorker?.siteRule && !ruleWorker.dead) {
        let timer
        // Let the successful submit result reach the SDK tail before the ordinary stop.
        try { await Promise.race([call(ruleWorker, 'awaitSiteRuleIdle', execution).catch(() => {}), new Promise(done => { timer = setTimeout(done, 1500) })]) }
        finally { clearTimeout(timer) }
      }
      const result = await api.stop(execution), worker = workers.get(execution.launch_id)
      if (worker && !worker.dead) { await call(worker, 'close', execution); worker.child.disconnect(); worker.child.kill('SIGTERM'); await worker.termination }
      return result
    },
    async close() {
      const failures = []
      for (const worker of workers.values()) if (!worker.dead) {
        try { await call(worker, 'close', worker.binding) } catch (cause) { failures.push(cause) }
        finally { worker.child.disconnect(); worker.child.kill('SIGTERM') }
      }
      if (failures.length) throw failures[0]
    },
  }
  return api
}
