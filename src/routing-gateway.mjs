import { ROUTING_BATCH_LIMITS, routingBatchAccounting, assertRoutingBatchBudget, validateRoutingBatchLedger, routingRequestModels, routingMemberCharge } from './routing-batch.mjs'
import {randomBytes,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {digest,error,exact} from '../packages/agent-contracts/index.mjs'
import {authorizeRouting} from './interaction-state.mjs'
import {estimateModelRequest,knownUsageCost,normalizeModelUsage,chargedModelTokens} from './work-budget.mjs'
import {readModelCredential} from './runtime-config.mjs'
const allowed=['attach','create_proposal','clarify','ignore']
export function validateRoutingLedger(state,row){
 if(row.routingVersion===2)return validateRoutingBatchLedger(state,row)
 exact(row,['id','purpose','routingVersion','routingRequestId','scopeId','workspaceId','actorId','threadId','intentId','routeRevision','candidateVersion','modelSnapshot','budgetPolicySnapshot','estimate','modelPriceSnapshot','forwardedBodyBytes','bodyDigest','reservedAt','outcome','usage','completedAt','usageCostMicros','noForwardReason'])
 const request=state.routingRequests.find(request=>request.id===row.routingRequestId)
 if(row.usage!==null&&(!row.usage||typeof row.usage!=='object'||Array.isArray(row.usage)||!Object.keys(row.usage).length||Object.keys(row.usage).some(field=>!['prompt_tokens','completion_tokens','total_tokens'].includes(field))||Object.values(row.usage).some(value=>!Number.isSafeInteger(value)||value<0)))throw error('INVALID_STATE','路由usage格式无效')
 if(row.noForwardReason!==undefined&&row.noForwardReason!==null&&(!['EXECUTION_DEADLINE','UNAUTHORIZED','PROCESS_SHUTDOWN'].includes(row.noForwardReason)||row.outcome!=='failed'||row.usage!==null||!row.completedAt))throw error('INVALID_STATE','确定未转发事实无效')
 if(!request||row.purpose!=='routing'||row.routingVersion!==1||['scopeId','workspaceId','actorId','threadId','intentId','routeRevision','candidateVersion'].some(field=>row[field]!==request[field])||!isDeepStrictEqual(row.modelSnapshot,request.modelSnapshot)||!isDeepStrictEqual(row.budgetPolicySnapshot,request.budgetSnapshot)||!['unknown','completed','failed'].includes(row.outcome)||!/^[a-f0-9]{64}$/.test(row.bodyDigest)||!Number.isFinite(Date.parse(row.reservedAt))||row.completedAt!==null&&!Number.isFinite(Date.parse(row.completedAt)))throw error('INVALID_STATE','路由账本绑定无效')
 // The body is deliberately not persisted. Recompute from its committed byte count.
 const estimator=request.budgetSnapshot.estimator,n=BigInt(row.forwardedBodyBytes)*BigInt(estimator.inputBytesNumerator),d=BigInt(estimator.inputBytesDenominator),input=Number((n+d-1n)/d+BigInt(estimator.fixedInputTokens)),price=request.budgetSnapshot.modelPrices.find(price=>price.provider===row.modelSnapshot.provider&&price.model===row.modelSnapshot.model),ceil=(n)=>(n+999999n)/1000000n
 if(!price||!isDeepStrictEqual(price,row.modelPriceSnapshot)||!Number.isSafeInteger(row.forwardedBodyBytes)||row.forwardedBodyBytes<1||row.estimate.inputTokens!==input||row.estimate.outputTokens!==request.maxOutputTokens||row.estimate.totalTokens!==input+row.estimate.outputTokens||row.estimate.costMicros!==Number(ceil(BigInt(input)*BigInt(price.inputMicrosPerMillionTokens))+ceil(BigInt(row.estimate.outputTokens)*BigInt(price.outputMicrosPerMillionTokens)))||row.usageCostMicros!==knownUsageCost(row.usage,price))throw error('INVALID_STATE','路由预算估算不闭合')
 return row
}
export function createRoutingGateway({store,config,base,fetchImpl,clock}){
 const tokens=new Map(),active=new Map(),activeScopes=new Set(),forwardingScopes=new Set();let closed=false
 async function issue(id){if(closed)throw error('PROCESS_SHUTDOWN');const state=await store.read(),request=state.routingRequests.find(row=>row.id===id);if(!request)throw error('FORBIDDEN');authorizeRouting(state,request,clock());const token=randomBytes(32).toString('base64url');tokens.set(token,{id,scopeId:request.scopeId,routeRevision:request.routeRevision,candidateVersion:request.candidateVersion,expiresAt:Math.min(Date.parse(request.deadlineAt),clock()+60000)});return{token,expiresAt:tokens.get(token).expiresAt}}
 async function runLegacy(record){
  if(closed)throw error('PROCESS_SHUTDOWN')
  let state=await store.read(),request=state.routingRequests.find(row=>row.id===record.id);if(!request||record.scopeId!==request.scopeId||record.routeRevision!==request.routeRevision||record.candidateVersion!==request.candidateVersion||clock()>=record.expiresAt)throw error('UNAUTHORIZED');authorizeRouting(state,request,clock())
  const body={model:request.modelSnapshot.model,stream:true,max_tokens:request.maxOutputTokens,messages:[{role:'system',content:'你是受限的工作续办路由器。只判断本次请求与给定当前可读候选。返回一个JSON对象：action=attach|create_proposal|clarify|ignore，targetWorkId为给定候选ID或null，reason为简短原因，question为需澄清的问题或null。不得编造ID；目录truncated时不能把仅返回的一条称为唯一，应clarify。不得调用工具、读取其他资料或执行业务。终态工作应create_proposal。'},{role:'user',content:JSON.stringify({text:request.text,candidates:request.candidates,truncated:request.truncated,excludedHandlerAttempts:request.excludedHandlerAttempts})}],tools:[]}
  const credential=await readModelCredential(config),accounting=estimateModelRequest({policySnapshot:request.budgetSnapshot},request.modelSnapshot,body),ledgerId=randomUUID()
  await store.update(draft=>{
   if(closed)throw error('PROCESS_SHUTDOWN');const current=draft.routingRequests.find(row=>row.id===request.id);authorizeRouting(draft,current,clock())
   if(routingRequestModels(draft,request.id).length>0)throw error('RUNTIME_REQUEST_UNKNOWN','原路由已转发或结果未知，不能自动重发')
   const rows=draft.modelRequests.filter(row=>routingMemberCharge(row,request.intentId)),budget=request.budgetSnapshot
   if(rows.length>=Math.min(3,budget.limits.maxModelRequests)||rows.some(row=>row.outcome==='unknown'||row.usageCostMicros===null&&Number.isSafeInteger(row.usage?.prompt_tokens)&&Number.isSafeInteger(row.usage?.completion_tokens))||rows.reduce((sum,row)=>sum+routingMemberCharge(row,request.intentId).tokens,0n)+BigInt(accounting.estimate.totalTokens)>BigInt(budget.limits.maxReservedTokens)||rows.reduce((sum,row)=>sum+routingMemberCharge(row,request.intentId).costMicros,0n)+BigInt(accounting.estimate.costMicros)>BigInt(budget.limits.maxReservedCostMicros))throw error('ROUTING_BUDGET_EXCEEDED','路由预算不足或结果待核对，请明确选择或补充定位条件')
   draft.modelRequests.push({id:ledgerId,purpose:'routing',routingVersion:1,routingRequestId:request.id,...Object.fromEntries(['scopeId','workspaceId','actorId','threadId','intentId','routeRevision','candidateVersion'].map(field=>[field,request[field]])),modelSnapshot:structuredClone(request.modelSnapshot),budgetPolicySnapshot:structuredClone(budget),...accounting,bodyDigest:digest(body),reservedAt:new Date(clock()).toISOString(),outcome:'unknown',usage:null,completedAt:null,usageCostMicros:null,noForwardReason:null});return draft
  })
  try{authorizeRouting(await store.read(),request,clock())}catch(cause){await store.update(state=>{const row=state.modelRequests.find(row=>row.id===ledgerId);if(row?.outcome==='unknown'){row.outcome='failed';row.noForwardReason='UNAUTHORIZED';row.completedAt=new Date(clock()).toISOString()}return state});throw cause}
  const expired=closed?'PROCESS_SHUTDOWN':clock()>=Date.parse(request.deadlineAt)?'EXECUTION_DEADLINE':clock()>=record.expiresAt?'UNAUTHORIZED':null
  if(expired){await store.update(draft=>{const row=draft.modelRequests.find(row=>row.id===ledgerId);row.outcome='failed';row.noForwardReason=expired;row.completedAt=new Date(clock()).toISOString();return draft});throw error(expired,'路由执行期限已到，本次已确定未转发')}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(error('EXECUTION_DEADLINE')),Math.max(0,Date.parse(request.deadlineAt)-clock()));timer.unref();active.set(ledgerId,controller)
  let usage=null,finished=false,done=false,content=''
  try{
   controller.signal.throwIfAborted();forwardingScopes.add(request.scopeId)
   const response=await fetchImpl(new URL(base.href.replace(/\/$/,'')+'/chat/completions'),{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:controller.signal})
   if(!response.ok){await response.body?.cancel();await store.update(draft=>{const row=draft.modelRequests.find(row=>row.id===ledgerId);row.outcome='failed';row.completedAt=new Date(clock()).toISOString();return draft});throw error('UPSTREAM_ERROR')}
   if(!response.headers.get('content-type')?.startsWith('text/event-stream'))throw error('UPSTREAM_ERROR')
   const decoder=new TextDecoder('utf-8',{fatal:true});let pending=''
   for await(const chunk of response.body){pending+=decoder.decode(chunk,{stream:true});if(Buffer.byteLength(pending)>262144)throw error('INVALID_RESPONSE');for(;;){const newline=pending.indexOf('\n');if(newline<0)break;const line=pending.slice(0,newline).trimEnd();pending=pending.slice(newline+1);if(!line.startsWith('data: '))continue;const data=line.slice(6);if(data==='[DONE]'){done=true;continue}const value=JSON.parse(data);if(value.usage)usage=normalizeModelUsage(value.usage);for(const choice of value.choices??[]){if(choice.delta?.tool_calls)throw error('FORBIDDEN');content+=choice.delta?.content??'';if(content.length>16000)throw error('INVALID_RESPONSE');if(choice.finish_reason==='stop')finished=true}}}
   if(!finished||!done)throw error('RUNTIME_REQUEST_UNKNOWN')
   await store.update(draft=>{const row=draft.modelRequests.find(row=>row.id===ledgerId);row.outcome='completed';row.usage=usage;row.usageCostMicros=knownUsageCost(usage,row.modelPriceSnapshot);row.completedAt=new Date(clock()).toISOString();return draft})
   const decision=JSON.parse(content);exact(decision,['action','targetWorkId','reason','question']);if(!allowed.includes(decision.action)||typeof decision.reason!=='string'||!decision.reason.trim()||decision.reason.length>1000||decision.question!==null&&(typeof decision.question!=='string'||decision.question.length>1000)||decision.targetWorkId!==null&&!request.candidates.some(row=>row.workId===decision.targetWorkId)||['attach','create_proposal'].includes(decision.action)&&!decision.targetWorkId||request.truncated&&decision.action==='attach')throw error('INVALID_RESPONSE','路由结果不属于当前有限候选')
   authorizeRouting(await store.read(),request,clock())
   return{decision,modelRequestId:ledgerId}
  }finally{clearTimeout(timer);active.delete(ledgerId);await store.update(draft=>{const row=draft.modelRequests.find(row=>row.id===ledgerId);if(row&&!row.completedAt){row.usage=usage;row.usageCostMicros=knownUsageCost(usage,row.modelPriceSnapshot);row.completedAt=new Date(clock()).toISOString()}return draft})}
 }
 function claimScope(scopeId){if(closed)throw error('PROCESS_SHUTDOWN');if(activeScopes.has(scopeId)||activeScopes.size>=ROUTING_BATCH_LIMITS.globalActive)throw error('ROUTING_BUSY');activeScopes.add(scopeId)}
 async function run(record){const state=await store.read(),request=state.routingRequests.find(row=>row.id===record.id);if(!request)throw error('FORBIDDEN');authorizeRouting(state,request,clock());claimScope(request.scopeId);try{return await runLegacy(record)}finally{activeScopes.delete(request.scopeId);forwardingScopes.delete(request.scopeId)}}
 async function decideBatch(batchId){
  const initial=await store.read(),batch=initial.routingBatches.find(row=>row.id===batchId)
  if(!batch)throw error('FORBIDDEN')
  const requests=batch.members.map(member=>initial.routingRequests.find(row=>row.id===member.requestId))
  for(const request of requests)authorizeRouting(initial,request,clock())
  claimScope(batch.scopeId)
  const controller=new AbortController(),activeId=Symbol(batchId);active.set(activeId,controller)
  const deadline=Math.min(...requests.map(row=>Date.parse(row.deadlineAt))),timer=setTimeout(()=>controller.abort(error('EXECUTION_DEADLINE')),Math.max(0,deadline-clock()));timer.unref()
  let reserved=false,sent=false,usage=null
  const assertOpen=()=>{if(closed)throw error('PROCESS_SHUTDOWN');if(clock()>=deadline)throw error('EXECUTION_DEADLINE');controller.signal.throwIfAborted()}
  async function ledgerUpdate(values){await store.update(state=>{const row=state.modelRequests.find(row=>row.id===batch.modelRequestId);if(row?.outcome==='unknown')Object.assign(row,values);return state})}
  try{
   assertOpen()
   const accounting=routingBatchAccounting(requests),credential=await readModelCredential(config)
   await store.update(state=>{
    assertOpen();const currentBatch=state.routingBatches.find(row=>row.id===batch.id)
    if(!isDeepStrictEqual(currentBatch,batch)||currentBatch.state!=='prepared')throw error('REVISION_CONFLICT')
    const current=requests.map(request=>state.routingRequests.find(row=>row.id===request.id))
    for(const request of current)authorizeRouting(state,request,clock())
    const existing=state.modelRequests.find(row=>row.id===batch.modelRequestId)
    if(existing)throw error(existing.outcome==='unknown'?'RUNTIME_REQUEST_UNKNOWN':'ROUTING_REPLY_UNAVAILABLE')
    for(const request of current)if(routingRequestModels(state,request.id).some(row=>row.outcome==='unknown'))throw error('RUNTIME_REQUEST_UNKNOWN')
    assertRoutingBatchBudget(state,current,accounting)
    if(state.modelRequests.length>=30000)throw error('CAPACITY_EXCEEDED')
    const first=current[0]
    state.modelRequests.push({id:batch.modelRequestId,purpose:'routing',routingVersion:2,batchId:batch.id,...Object.fromEntries(['scopeId','workspaceId','actorId','threadId','compatibilityKey'].map(name=>[name,first[name]])),members:structuredClone(accounting.members),modelSnapshot:structuredClone(first.modelSnapshot),budgetPolicySnapshot:structuredClone(first.budgetSnapshot),estimate:accounting.estimate,modelPriceSnapshot:accounting.modelPriceSnapshot,forwardedBodyBytes:accounting.forwardedBodyBytes,bodyDigest:digest(accounting.body),reservedAt:new Date(clock()).toISOString(),outcome:'unknown',usage:null,usageCostMicros:null,completedAt:null,noForwardReason:null})
    return state
   });reserved=true
   // Credential and reservation I/O have finished. All members share this last
   // current-authority read; no await remains between the fence and the fetch.
   const fresh=await store.read(),current=requests.map(request=>fresh.routingRequests.find(row=>row.id===request.id))
   for(const request of current)authorizeRouting(fresh,request,clock())
   assertRoutingBatchBudget(fresh,current,accounting,batch.modelRequestId);assertOpen();sent=true;forwardingScopes.add(batch.scopeId)
   const response=await fetchImpl(new URL(base.href.replace(/\/$/,'')+'/chat/completions'),{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify(accounting.body),redirect:'error',signal:controller.signal})
   if(!response.ok){await response.body?.cancel();await ledgerUpdate({outcome:'failed',completedAt:new Date(clock()).toISOString()});throw error('UPSTREAM_ERROR')}
   if(!response.headers.get('content-type')?.startsWith('text/event-stream'))throw error('RUNTIME_REQUEST_UNKNOWN')
   const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',content='',done=false,finished=false,totalBytes=0
   for await(const chunk of response.body){totalBytes+=chunk.length;if(totalBytes>262144)throw error('INVALID_RESPONSE');pending+=decoder.decode(chunk,{stream:true});for(;;){const newline=pending.indexOf('\n');if(newline<0)break;const line=pending.slice(0,newline).trimEnd();pending=pending.slice(newline+1);if(!line.startsWith('data: '))continue;const data=line.slice(6);if(data==='[DONE]'){done=true;continue}const value=JSON.parse(data);if(value.error)throw error('RUNTIME_REQUEST_UNKNOWN');if(value.usage)usage=normalizeModelUsage(value.usage);for(const choice of value.choices??[]){if(choice.delta?.tool_calls)throw error('FORBIDDEN');content+=choice.delta?.content??'';if(content.length>16000)throw error('INVALID_RESPONSE');if(choice.finish_reason==='stop')finished=true}}}
   if(!finished||!done)throw error('RUNTIME_REQUEST_UNKNOWN')
   await ledgerUpdate({outcome:'completed',usage,usageCostMicros:knownUsageCost(usage,accounting.modelPriceSnapshot),completedAt:new Date(clock()).toISOString()})
   let result;try{result=JSON.parse(content)}catch{}
   const outputs=[],invalid=new Set(),seen=new Set()
   let values=Array.isArray(result?.decisions)?result.decisions:requests.length===1&&result?.action?[{...result,sourceEventId:requests[0].sourceEventId,eventVersion:requests[0].eventVersion}]:[]
   for(const value of values){
    const request=requests.find(row=>row.sourceEventId===value?.sourceEventId&&row.eventVersion===value?.eventVersion)
    if(!request)continue
    if(seen.has(request.id)){invalid.add(request.id);continue}seen.add(request.id)
    try{exact(value,['sourceEventId','eventVersion','action','targetWorkId','reason','question']);if(!allowed.includes(value.action)||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>1000||value.question!==null&&(typeof value.question!=='string'||value.question.length>1000)||value.targetWorkId!==null&&!request.candidates.some(row=>row.workId===value.targetWorkId)||['attach','create_proposal'].includes(value.action)&&!value.targetWorkId||request.truncated&&value.action==='attach')throw error('INVALID_RESPONSE');const{sourceEventId,eventVersion,...decision}=value;outputs.push({requestId:request.id,decision})}catch{invalid.add(request.id)}
   }
   return{modelRequestId:batch.modelRequestId,outputs:outputs.filter(row=>!invalid.has(row.requestId))}
  }catch(cause){if(reserved&&!sent)await ledgerUpdate({outcome:'failed',usage:null,usageCostMicros:null,completedAt:new Date(clock()).toISOString(),noForwardReason:/^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code??'')?cause.code:'ROUTING_NOT_FORWARDED'});throw cause}
  finally{clearTimeout(timer);active.delete(activeId);activeScopes.delete(batch.scopeId);forwardingScopes.delete(batch.scopeId);if(reserved)await store.update(state=>{const row=state.modelRequests.find(row=>row.id===batch.modelRequestId),current=state.routingBatches.find(row=>row.id===batch.id);if(row?.outcome==='unknown'&&!row.completedAt){row.usage=usage;row.usageCostMicros=knownUsageCost(usage,row.modelPriceSnapshot);row.completedAt=new Date(clock()).toISOString()}if(current?.state==='prepared'){current.state=row?.outcome??'failed';current.finishedAt=new Date(clock()).toISOString()}return state})}
 }
 return{issue,decideBatch,isInFlight:scopeId=>forwardingScopes.has(scopeId),close(){closed=true;tokens.clear();for(const controller of active.values())controller.abort(error('PROCESS_SHUTDOWN'))},async decide(id){const issued=await issue(id);return run(tokens.get(issued.token))},async handle(request,response,url){if(url.pathname!=='/internal/model/routing/v1/chat/completions')return false;try{if(request.method!=='POST'||url.search)throw error('FORBIDDEN');const record=tokens.get(/^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization??'')?.[1]);if(!record)throw error('UNAUTHORIZED');let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>2)throw error('INVALID_REQUEST')}const result=await run(record);response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(result))}catch(cause){response.writeHead(cause.code==='UNAUTHORIZED'?401:cause.code==='FORBIDDEN'?403:409,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:cause.code??'ROUTING_UNAVAILABLE'}}))}return true}}
}
