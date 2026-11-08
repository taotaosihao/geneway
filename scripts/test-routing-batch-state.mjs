import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {budgetPolicy,knownUsageCost} from '../src/work-budget.mjs'
import {routingCompatibility,routingBatchAccounting,splitRoutingAmount,routingMemberCharge,assertRoutingBatchesImmutable,validateRoutingBatches,assertRoutingBatchBudget} from '../src/routing-batch.mjs'
const source='/home/gewu/.codex/task-checkpoints/geneway-evidence/t24a-original29-i5VCrw/donors/BpDS2q-terminal-cloud.json',old=JSON.parse(await readFile(source)),diagnosis=old.supervisionDiagnoses[0]
const common={actorId:'owner',workspaceId:'local',threadId:'component-thread',scopeId:'component-scope',sourceInstance:'web',policyId:'p',policyRevision:1,routerEmployeeRevision:1,nodeRegistrationRevision:1,nodeCredentialVersion:1,nodeInstanceId:'instance',modelSnapshot:diagnosis.modelSnapshot,budgetSnapshot:diagnosis.budgetPolicySnapshot,maxOutputTokens:512,directoryOffset:0,directoryQuery:'',candidateVersion:'directory',truncated:false,candidates:[]}
const requests=['汉字','longer text 😀'].map((text,index)=>({...common,id:'r'+index,sourceEventId:'e'+index,eventVersion:1,intentId:'i'+index,routeRevision:1,text,excludedHandlerAttempts:[]}))
assert.equal(routingCompatibility(requests[0]),routingCompatibility(requests[1]))
for(const field of ['actorId','workspaceId','threadId','sourceInstance','nodeCredentialVersion','candidateVersion','policyRevision'])assert.notEqual(routingCompatibility(requests[0]),routingCompatibility({...requests[0],[field]:'different'}))
for(const amount of [0,1,2,7,Number.MAX_SAFE_INTEGER]){const shares=splitRoutingAmount(amount,[1,2,3]);assert.equal(shares.reduce((s,x)=>s+BigInt(x),0n),BigInt(amount))}
assert.deepEqual(splitRoutingAmount(2,[1,1,1]),[1,1,0]);assert.throws(()=>splitRoutingAmount(1,[0,1]))
const accounting=routingBatchAccounting(requests)
for(const field of ['inputTokens','outputTokens','totalTokens','costMicros'])assert.equal(accounting.members.reduce((sum,row)=>sum+row.estimate[field],0),accounting.estimate[field])
const row={purpose:'routing',routingVersion:2,members:accounting.members,estimate:accounting.estimate,usage:null,usageCostMicros:null}
const charges=requests.map(request=>routingMemberCharge(row,request.intentId));assert.equal(charges.reduce((s,x)=>s+x.tokens,0n),BigInt(accounting.estimate.totalTokens));assert.equal(charges.reduce((s,x)=>s+x.costMicros,0n),BigInt(accounting.estimate.costMicros));assert.equal(routingMemberCharge(row,'foreign'),null)
// 独立预算反例：成员原预留1093/1091，不能在null结算时重分整额为1092/1092。
const uneven={id:'prior-settled-ledger',purpose:'routing',routingVersion:2,outcome:'completed',members:[{intentId:'budget-a',weight:1,estimate:{inputTokens:1000,outputTokens:93,totalTokens:1093,costMicros:2}},{intentId:'budget-b',weight:1,estimate:{inputTokens:999,outputTokens:92,totalTokens:1091,costMicros:0}}],estimate:{inputTokens:1999,outputTokens:185,totalTokens:2184,costMicros:2},usage:null,usageCostMicros:null}
for(const usage of [null,{prompt_tokens:10,completion_tokens:1,total_tokens:11}]) {
 const settled={...uneven,usage}
 assert.equal(routingMemberCharge(settled,'budget-a').tokens,1093n);assert.equal(routingMemberCharge(settled,'budget-b').tokens,1091n)
 assert.equal(routingMemberCharge(settled,'budget-a').costMicros,2n);assert.equal(routingMemberCharge(settled,'budget-b').costMicros,0n)
}
const high={...uneven,usage:{prompt_tokens:2200,completion_tokens:1,total_tokens:2201},usageCostMicros:5}
const highCharges=['budget-a','budget-b'].map(id=>routingMemberCharge(high,id))
assert.equal(highCharges[0].tokens+highCharges[1].tokens,2201n);assert.equal(highCharges[0].costMicros+highCharges[1].costMicros,5n)
assert.ok(highCharges[0].tokens>=1093n&&highCharges[1].tokens>=1091n);assert.ok(highCharges[0].costMicros>=2n)
const next={...requests[0],intentId:'budget-a',budgetSnapshot:{...requests[0].budgetSnapshot,limits:{maxModelRequests:3,maxReservedTokens:3118,maxReservedCostMicros:1000}}}
const nextAccounting={estimate:{inputTokens:2000,totalTokens:2026},members:[{estimate:{inputTokens:2000,outputTokens:26,totalTokens:2026,costMicros:0}}]}
assert.throws(()=>assertRoutingBatchBudget({modelRequests:[uneven]},[next],nextAccounting),error=>error.code==='ROUTING_BUDGET_EXCEEDED')
assert.doesNotThrow(()=>assertRoutingBatchBudget({modelRequests:[uneven]},[{...next,budgetSnapshot:{...next.budgetSnapshot,limits:{...next.budgetSnapshot.limits,maxReservedTokens:3119}}}],nextAccounting))
// 已知 usage 的费用溢出与真正缺 usage 分开：其余限额留足，只有溢出资格门会拒绝。
const overflowPrice={provider:common.modelSnapshot.provider,model:common.modelSnapshot.model,inputMicrosPerMillionTokens:Number.MAX_SAFE_INTEGER,outputMicrosPerMillionTokens:1}
const {id:policyId,revision:policyRevision,...basePolicy}=common.budgetSnapshot
const overflowPolicy={id:policyId,revision:policyRevision,...budgetPolicy({...basePolicy,limits:{maxModelRequests:3,maxReservedTokens:Number.MAX_SAFE_INTEGER,maxReservedCostMicros:Number.MAX_SAFE_INTEGER},modelPrices:[overflowPrice]})}
const pricedRequests=requests.map(request=>({...request,budgetSnapshot:overflowPolicy}))
const pricedPrior=routingBatchAccounting(pricedRequests),pricedNext=routingBatchAccounting([pricedRequests[0]])
const overflowUsage={prompt_tokens:1_000_001,completion_tokens:1,total_tokens:1_000_002}
const overflowCost=knownUsageCost(overflowUsage,pricedPrior.modelPriceSnapshot);assert.equal(overflowCost,null)
const pricedRow={id:'prior-overflow-ledger',purpose:'routing',routingVersion:2,outcome:'completed',members:pricedPrior.members,estimate:pricedPrior.estimate,usageCostMicros:overflowCost}
assert.doesNotThrow(()=>assertRoutingBatchBudget({modelRequests:[{...pricedRow,usage:null}]},[pricedRequests[0]],pricedNext))
assert.throws(()=>assertRoutingBatchBudget({modelRequests:[{...pricedRow,usage:overflowUsage}]},[pricedRequests[0]],pricedNext),error=>error.code==='ROUTING_BUDGET_EXCEEDED')
validateRoutingBatches({routingBatches:[]})
const before={routingBatches:[{id:'b',members:accounting.members,state:'prepared',finishedAt:null}]},changed=structuredClone(before);changed.routingBatches[0].members.reverse();assert.throws(()=>assertRoutingBatchesImmutable(before,changed))
const completed=structuredClone(before);completed.routingBatches[0].state='completed';const rewritten=structuredClone(completed);rewritten.routingBatches[0].state='unknown';assert.throws(()=>assertRoutingBatchesImmutable(completed,rewritten))
console.log(JSON.stringify({source,checks:'compatibility isolation; UTF8 weights; BigInt conservation/remainders; whole estimate and unknown reservation charged once; immutable order/terminal',boundary:'pure request math fixtures only; no admitted batch, authority or provider-forward claim'}))
