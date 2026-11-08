import { routingCompatibility, validateRoutingBatches, assertRoutingBatchesImmutable } from './routing-batch.mjs'
import { assertManualExecution } from './manual-control.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { intentQuestionClosure } from '../packages/agent-contracts/conversation.mjs'
import { isDeepStrictEqual } from 'node:util'
import { binding, digest, error, exact, sameBinding, key } from '../packages/agent-contracts/index.mjs'
import { authorizeIntentClosureExecution, authorizeMultisiteExecution, authorizeBudgetControlCommand, authorizeBudgetControlReceipt, hasConsumedExecutionMessage, authorizeContextSubscription } from './multisite-authorization.mjs'
import { employeeModelRoute } from './model-route.mjs'
import { budgetPolicy } from './work-budget.mjs'

export const emptyInteractionState = () => Object.fromEntries(['routingBatches','webThreads','sourceEvents','workIntents','routingRequests','routingDecisions','contextSubscriptions','intentHandbacks','intentCommands','intentQuestions','intentReplies','routingPolicies','interactionCommands','workContinuations','interactionArtifactReads'].map(name=>[name,[]]))
const valid=(condition,label)=>{if(!condition)throw error('INVALID_STATE',`续办事实无效：${label}`)}
export function interactionMember(state,actor){const member=state.members.find(row=>row.id===actor?.id&&row.enabled);if(!member)throw error('UNAUTHORIZED');return member}
export function interactionWork(state,actor,id){const member=interactionMember(state,actor),work=state.works.find(row=>row.id===id&&row.workType==='multisite'&&row.origin!=='rule'&&row.ownerMemberId===member.id),employee=work&&state.employees.find(row=>row.id===work.employeeId&&row.enabled&&member.employeeIds.includes(row.id));if(!employee)throw error('NOT_FOUND');return{member,work}}
export function workDirectory(state,actor,{offset=0,query=''}={}){
 const member=interactionMember(state,actor);if(typeof query!=='string'||query.length>200)throw error('INVALID_REQUEST');query=query.trim().toLocaleLowerCase();if(!Number.isSafeInteger(offset)||offset<0||offset>10000)throw error('INVALID_REQUEST')
 const rows=state.works.filter(row=>{try{interactionWork(state,member,row.id);const input=state.multisite.inputs.find(input=>input.workId===row.id&&input.revision===row.instructionRevision),resources=state.multisite.attempts.find(attempt=>attempt.work_id===row.id&&attempt.parent_delegation_id===null)?.resource_refs??[];return !query||[row.goal,row.acceptedAt,row.spreadsheetRequest?.dueDate??'',input?.text??'',...resources].some(value=>String(value).toLocaleLowerCase().includes(query))}catch{return false}}).sort((a,b)=>b.acceptedAt.localeCompare(a.acceptedAt)||a.id.localeCompare(b.id))
 const summaries=rows.slice(offset,offset+8).map(work=>({workId:work.id,title:work.goal.slice(0,160),status:work.status,instructionRevision:work.instructionRevision,acceptedAt:work.acceptedAt,resources:(state.multisite.attempts.find(attempt=>attempt.work_id===work.id&&attempt.parent_delegation_id===null)?.resource_refs??[]).slice(0,8),dueDate:work.spreadsheetRequest?.dueDate??null,latestInput:state.multisite.inputs.find(input=>input.workId===work.id&&input.revision===work.instructionRevision)?.text.slice(0,600)??'',artifacts:(work.artifactRefs??[]).map(ref=>({artifactId:ref.artifactId,version:ref.version,sha256:ref.sha256}))}))
 return{candidates:summaries,offset,query,truncated:rows.length>offset+8,nextOffset:rows.length>offset+8?offset+8:null,candidateVersion:digest(summaries)}
}
export function currentThread(state,actor,id){const member=interactionMember(state,actor),thread=state.webThreads.find(row=>row.id===id&&row.ownerMemberId===member.id);if(!thread)throw error('NOT_FOUND');return thread}
export function authorizeRouting(state,request,now=Date.now()){
 const intent=state.workIntents.find(row=>row.id===request.intentId),event=state.sourceEvents.find(row=>row.id===request.sourceEventId),thread=currentThread(state,{id:request.actorId},request.threadId),member=interactionMember(state,{id:request.actorId}),policy=state.routingPolicies.find(row=>row.id===request.policyId&&row.enabled&&row.revision===request.policyRevision)
 if(!intent||intent.routeRevision!==request.routeRevision||intent.sourceEventId!==event?.id||!['routing_pending','routing'].includes(intent.state)||thread.id!==event.threadId||Date.parse(request.deadlineAt)<=now||!policy||policy.workspaceId!==request.workspaceId)throw error('FORBIDDEN','路由上下文已变化')
 const employee=state.employees.find(row=>row.id===policy.routerAgentId&&row.enabled&&row.revision===request.routerEmployeeRevision&&member.employeeIds.includes(row.id)),node=state.nodes.find(row=>row.id===policy.routerNodeId&&row.status==='active'&&row.workspaceId===request.workspaceId&&row.allowedAgentIds.includes(employee?.id)&&row.registrationRevision===request.nodeRegistrationRevision&&row.credentialVersion===request.nodeCredentialVersion)
 if(!employee||!node||request.routingVersion===2&&node.nodeInstanceId!==request.nodeInstanceId||employee.placement.nodeId!==node.id||!isDeepStrictEqual(employeeModelRoute(state,employee),request.modelSnapshot))throw error('FORBIDDEN','路由身份授权已失效')
 const directory=workDirectory(state,member,{offset:request.directoryOffset,query:request.directoryQuery??''});if(directory.candidateVersion!==request.candidateVersion||directory.truncated!==request.truncated||!isDeepStrictEqual(directory.candidates,request.candidates))throw error('REVISION_CONFLICT','可读工作目录已变化，请重新定位')
 return{intent,event,thread,member,policy,employee,node}
}
export function intentFenceFor(intent,subscription){return{intentId:intent.id,routeRevision:intent.routeRevision,handlerBinding:structuredClone(subscription.handlerBinding),subscriptionRevision:subscription.revision}}
export function authorizeIntent(state,execution,fence,options={}){return intentAccess(state,execution,fence,authorizeMultisiteExecution(state,execution),options.requireConsumed??true)}
function intentAccess(state,execution,fence,access,requireConsumed){
 exact(fence,['intentId','routeRevision','handlerBinding','subscriptionRevision']);const intent=state.workIntents.find(row=>row.id===fence.intentId),subscription=state.contextSubscriptions.find(row=>row.intentId===intent?.id&&row.mode==='handle'&&row.lifecycle==='active'&&row.revision===fence.subscriptionRevision&&sameBinding(row.handlerBinding,execution))
 if(!intent||intent.state!=='attached'||intent.routeRevision!==fence.routeRevision||intent.workId!==execution.work_id||!sameBinding(fence.handlerBinding,execution)||!subscription||intent.handlerSubscriptionId!==subscription.id||requireConsumed&&!subscription.ingestedAt)throw error('FORBIDDEN','当前意图已交回、换代或尚未消费')
 if(requireConsumed&&(access.current.observed_revision!==access.current.instruction_revision||!state.multisite.inputs.some(input=>input.workId===execution.work_id&&input.revision===access.current.instruction_revision&&input.deliveries.some(delivery=>delivery.attemptId===execution.attempt_id&&delivery.sessionId===execution.session_id&&delivery.ingestedAt))))throw error('REVISION_CONFLICT','判断意图前须实际消费当前工作要求')
 return{...access,intent,subscription,event:state.sourceEvents.find(row=>row.id===intent.sourceEventId)}
}
export function validateInteractionState(state){
 for(const name of Object.keys(emptyInteractionState()))valid(Array.isArray(state[name])&&state[name].length<=30000&&new Set(state[name].map(row=>row.id)).size===state[name].length,name)
 for(const row of state.webThreads)valid(state.members.some(member=>member.id===row.ownerMemberId)&&Number.isSafeInteger(row.revision)&&row.revision>=1,'Thread')
 for(const row of state.sourceEvents)valid(state.webThreads.some(thread=>thread.id===row.threadId&&thread.ownerMemberId===row.actorId)&&typeof row.text==='string'&&row.text.length>0&&row.text.length<=16000&&row.payloadDigest===digest(row.payload)&&row.version>=1,'SourceEvent')
 for(const row of state.workIntents)valid(state.sourceEvents.some(event=>event.id===row.sourceEventId)&&Number.isSafeInteger(row.routeRevision)&&row.routeRevision>=1&&['routing_pending','routing','routing_pending_choice','attached','accepted','proposal','clarify','ignored','closed'].includes(row.state),'Intent')
 for(const row of state.routingPolicies){budgetPolicy(row.budget);valid(typeof row.id==='string'&&Number.isSafeInteger(row.revision)&&row.revision>0&&typeof row.enabled==='boolean'&&Number.isSafeInteger(row.maxOutputTokens)&&row.maxOutputTokens>=1&&row.maxOutputTokens<=1024&&row.budget.workspaceId===row.workspaceId&&row.budget.coordinatorAgentId===row.routerAgentId,'RoutingPolicy')}
 for(const row of state.routingRequests)valid(state.workIntents.some(intent=>intent.id===row.intentId)&&row.scopeId===digest({actorId:row.actorId,workspaceId:row.workspaceId,threadId:row.threadId})&&row.candidateVersion===digest(row.candidates)&&row.candidates.length<=8&&['pending','completed','unknown','rejected'].includes(row.state),'RoutingRequest')
 for(const row of state.contextSubscriptions)valid(state.workIntents.some(intent=>intent.id===row.intentId)&&state.multisite.attempts.some(attempt=>sameBinding({...binding(attempt),session_id:attempt.session_id??`geneway-${attempt.launch_id}`},row.handlerBinding))&&['handle','context'].includes(row.mode)&&['active','paused','released','closed','revoked'].includes(row.lifecycle)&&(!row.ingestedAt||row.deliveredAt),'Subscription')
 for(const row of state.intentHandbacks)valid(state.workIntents.some(intent=>intent.id===row.intentId)&&state.contextSubscriptions.some(subscription=>subscription.id===row.subscriptionId)&&typeof row.reason==='string','Handback')
 for(const row of state.workContinuations)valid(state.works.some(work=>work.id===row.workId)&&state.works.some(work=>work.id===row.sourceWorkId)&&state.workIntents.some(intent=>intent.id===row.intentId)&&Buffer.byteLength(JSON.stringify(row.context))<=16384&&state.multisite.inputs.some(input=>input.workId===row.workId&&input.revision===1&&isDeepStrictEqual(input.continuationContext,row.context)),'Continuation')
 for(const row of state.routingRequests)if(row.routingVersion!==undefined){const event=state.sourceEvents.find(event=>event.id===row.sourceEventId);valid(row.routingVersion===2&&typeof row.queuedDuringEvaluation==='boolean'&&event&&event.version===row.eventVersion&&event.sourceInstance===row.sourceInstance&&typeof row.nodeInstanceId==='string'&&row.compatibilityKey===routingCompatibility(row),'路由批请求范围')}
 validateRoutingBatches(state)
 return state
}
export function assertInteractionImmutable(before,after){
 assertRoutingBatchesImmutable(before,after)
 for(const name of ['sourceEvents','routingDecisions','intentHandbacks','intentCommands','interactionCommands','workContinuations','interactionArtifactReads'])valid(isDeepStrictEqual(before[name],after[name].slice(0,before[name].length)),`${name}不可改写`)
 const changes={webThreads:['revision','updatedAt','routingPolicyId'],workIntents:['state','routeRevision','workId','handlerSubscriptionId','updatedAt','decisionId','acceptedInputId'],routingRequests:['state','decisionId','finishedAt','error'],contextSubscriptions:['lifecycle','deliveredAt','ingestedAt','releasedAt','closedAt','revokedAt','lifecycleReason'],intentQuestions:['state','answeredByEventId','closedAt','closedByEventId','controlConsumedAt','closedReason'],intentReplies:['state','sentAt']}
 for(const[name,fields]of Object.entries(changes))for(const row of before[name]){const next=after[name].find(item=>item.id===row.id),pinFields=['routingBudgetSnapshot','routingPolicyRevision','routingDeadlineAt'];let mutable=fields
  if(name==='workIntents'&&pinFields.every(field=>row[field]===undefined)&&pinFields.every(field=>next?.[field]!==undefined)){const first=after.routingRequests.find(request=>request.intentId===row.id&&request.routeRevision===next.routeRevision);valid(first&&!before.routingRequests.some(request=>request.intentId===row.id)&&isDeepStrictEqual(first.budgetSnapshot,next.routingBudgetSnapshot)&&first.policyRevision===next.routingPolicyRevision&&first.deadlineAt===next.routingDeadlineAt&&Date.parse(first.deadlineAt)===Date.parse(first.createdAt)+first.budgetSnapshot.executionTimeoutMs,'首次路由预算冻结必须关联首个请求');mutable=[...fields,...pinFields]}
  const fixed=value=>value&&Object.fromEntries(Object.entries(value).filter(([key])=>!mutable.includes(key)));valid(isDeepStrictEqual(fixed(row),fixed(next)),`${name}身份不可改写`);for(const field of ['ingestedAt','deliveredAt'])if(row[field])valid(row[field]===next[field],`${name}消费不可回退`)}
}

export function authorizeIntentDelivery(state,command,{requireConsumed=false}={}){
 if(!command)throw error('FORBIDDEN')
 return intentDeliveryProof(state,command,authorizeMultisiteExecution(state,{...binding(command),session_id:command.session_id??`geneway-${command.launch_id}`}),requireConsumed)
}
function intentDeliveryProof(state,command,access,requireConsumed){
 const original=state.multisite.outbox.find(row=>row.id===command.command_id)?.command
 if(!original||!isDeepStrictEqual(original,command)||command.operation!=='intent_review'||command.instruction_revision!==state.works.find(work=>work.id===command.work_id)?.instructionRevision)throw error('FORBIDDEN')
 const current=intentAccess(state,{...binding(command),session_id:command.session_id??`geneway-${command.launch_id}`},command.parameters.intentFence,access,requireConsumed),event=current.event
 if(command.parameters.sourceEvent?.id!==event.id||command.parameters.sourceEvent.text!==event.text||command.parameters.sourceEvent.version!==event.version||command.parameters.sourceEvent.threadId!==event.threadId||command.input_id!==key('intent-delivery',current.subscription.id))throw error('FORBIDDEN')
 if(command.parameters.intentAnswer){const answer=command.parameters.intentAnswer,question=state.intentQuestions.find(row=>row.id===answer.questionId&&row.intentId===current.intent.id&&row.state==='answered'),event=state.sourceEvents.find(row=>row.id===answer.eventId&&row.id===question?.answeredByEventId);if(!event||event.threadId!==current.intent.threadId||event.text!==answer.text||command.parameters.waitRelease?.kind!=='intent_question'||command.parameters.waitRelease.id!==question.id)throw error('FORBIDDEN')}
 return current
}
export function authorizeBudgetIntentResume(state,resume,{request=false,inputMessageId}={}){
 const hold=state.budgetHolds.find(row=>row.resumeCommandId===resume?.command_id),descriptor=hold?.intentReview,original=descriptor&&state.multisite.outbox.find(row=>row.id===descriptor.commandId)?.command
 if(!descriptor||!original||!sameBinding(hold,resume)||!isDeepStrictEqual(original.parameters.intentFence,descriptor.intentFence)||descriptor.inputMessageId!==messageId(original.input_id,hold.attempt_id,hold.session_id))throw error('FORBIDDEN')
 const control=hold.state==='resumed'?authorizeBudgetControlReceipt(state,resume):authorizeBudgetControlCommand(state,resume),access=hold.state==='resumed'?authorizeMultisiteExecution(state,binding(resume)):control,current=intentDeliveryProof(state,original,access,true)
 if(request&&(inputMessageId!==messageId(resume.input_id,resume.attempt_id,resume.session_id)||!hasConsumedExecutionMessage(state,binding(resume),inputMessageId)))throw error('REVISION_CONFLICT','预算续行必须实际消费原恢复消息')
 return{...current,intentFence:descriptor.intentFence,intentReviewCommandId:descriptor.commandId}
}

export function pendingIntentReview(state,execution){
 return state.contextSubscriptions.find(subscription=>subscription.mode==='handle'&&subscription.lifecycle==='active'&&subscription.ingestedAt&&sameBinding(subscription.handlerBinding,execution)&&state.workIntents.some(intent=>intent.id===subscription.intentId&&intent.state==='attached'&&intent.handlerSubscriptionId===subscription.id)&&state.multisite.outbox.some(row=>row.command.operation==='intent_review'&&row.command.instruction_revision===state.works.find(work=>work.id===execution.work_id)?.instructionRevision&&row.command.parameters.intentFence?.intentId===subscription.intentId&&row.command.parameters.intentFence.subscriptionRevision===subscription.revision))
}
export const INTENT_TOOL_NAMES=Object.freeze(['geneway_intent_context','geneway_accept_intent','geneway_handback_intent','geneway_ask_intent','geneway_reply_intent','geneway_split_intent'])

export function acceptIntentDeliveryEvent(state,event,at){
 const command=state.multisite.outbox.find(row=>row.id===event.source_command_id)?.command,fence=command?.parameters.intentFence
 if(command?.operation!=='intent_review'||!sameBinding({...binding(command),session_id:command.session_id??`geneway-${command.launch_id}`},event)||command.input_id!==event.input_id||command.instruction_revision!==event.instruction_revision||!isDeepStrictEqual(fence,event.intent_fence))throw error('FORBIDDEN')
 const subscription=state.contextSubscriptions.find(row=>row.intentId===fence.intentId&&row.revision===fence.subscriptionRevision&&sameBinding(row.handlerBinding,event)),intent=state.workIntents.find(row=>row.id===fence.intentId)
 if(!subscription||!intent)throw error('FORBIDDEN')
 authorizeMultisiteExecution(state,event)
 if(event.kind==='intent_delivered')subscription.deliveredAt??=at
 else if(event.kind==='intent_ingested'){if(!subscription.deliveredAt)throw error('REVISION_CONFLICT');subscription.ingestedAt??=at}else throw error('INVALID_REQUEST')
 return{historical:command.instruction_revision!==state.works.find(row=>row.id===command.work_id)?.instructionRevision||intent.routeRevision!==fence.routeRevision||intent.handlerSubscriptionId!==subscription.id||subscription.lifecycle!=='active'}
}

export function authorizeIntentQuestionClosure(state,command){
 const value=intentQuestionClosure(command),original=state.multisite.outbox.find(row=>row.id===command.command_id)?.command,question=state.intentQuestions.find(row=>row.id===value.questionId),intent=state.workIntents.find(row=>row.id===value.intentId),subscription=state.contextSubscriptions.find(row=>row.id===question?.subscriptionId),source=state.sourceEvents.find(row=>row.id===value.sourceEventId),next=state.sourceEvents.find(row=>row.id===value.supersededByEventId)
 if(!original||!isDeepStrictEqual(original,command)||!question||question.state!=='superseded'||question.closedByEventId!==next?.id||question.intentId!==intent?.id||intent.state!=='closed'||intent.sourceEventId!==source?.id||question.routeRevision!==value.routeRevision||question.subscriptionRevision!==value.subscriptionRevision||!subscription||subscription.lifecycle!=='released'||!sameBinding(subscription.handlerBinding,command)||!sameBinding(question.handlerBinding,command)||!source||!next||source.threadId!==next.threadId||source.sourceInstance!==next.sourceInstance||source.sourceEventId!==next.sourceEventId||next.version!==source.version+1)throw error('FORBIDDEN')
 return{...authorizeIntentClosureExecution(state,command),question}
}

export function reconcileContextSubscriptions(state,at){
 for(const subscription of state.contextSubscriptions.filter(row=>['active','paused'].includes(row.lifecycle))){
  const attempt=state.multisite.attempts.find(row=>row.attempt_id===subscription.handlerBinding.attempt_id),delegation=attempt&&state.multisite.delegations.find(row=>row.id===attempt.delegation_id),work=attempt&&state.works.find(row=>row.id===attempt.work_id)
  let lifecycle,reason
  if(!attempt||delegation?.currentAttemptId!==attempt.attempt_id){lifecycle='closed';reason='ATTEMPT_REPLACED'}
  else{
   try{authorizeContextSubscription(state,subscription.handlerBinding)}catch(cause){if(!['FORBIDDEN','UNAUTHORIZED','NOT_FOUND','REVISION_CONFLICT','MODEL_NOT_CONFIGURED'].includes(cause.code))throw cause;lifecycle='revoked';reason='AUTHORITY_REVOKED'}
   if(!lifecycle&&(['completed','cancelled','stopping'].includes(attempt.status)||['completed','cancelled','stopping','failed'].includes(work.status))){lifecycle='closed';reason='EXECUTION_ENDED'}
  }
  if(!lifecycle){try{assertManualExecution(state,subscription.handlerBinding);subscription.lifecycle='active'}catch(cause){if(!['MANUALLY_PAUSED','MANUAL_RELEASE_PENDING'].includes(cause.code))throw cause;subscription.lifecycle='paused'};continue}
  subscription.lifecycle=lifecycle;subscription[lifecycle==='revoked'?'revokedAt':'closedAt']=at;subscription.lifecycleReason=reason
  const intent=state.workIntents.find(row=>row.id===subscription.intentId)
  if(subscription.mode==='handle'&&intent?.handlerSubscriptionId===subscription.id){
   if(intent.state==='attached'){intent.state='closed';intent.updatedAt=at}
   for(const question of state.intentQuestions.filter(row=>row.subscriptionId===subscription.id&&row.state==='open')){question.state='cancelled';question.closedAt=at;question.closedReason=reason}
  }
 }
 return state
}
