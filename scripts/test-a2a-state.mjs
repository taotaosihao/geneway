import assert from 'node:assert/strict'
import { mkdtemp,readFile,writeFile } from 'node:fs/promises'
import { createFileStore,STATE_VERSION } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { a2aTaskRow,projectA2aTask,validateA2aState,assertA2aImmutable,applyA2aTransition } from '../src/a2a-state.mjs'
assert.equal(STATE_VERSION,31)
const root=await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/a2a-state-'),path=root+'/state.json'
const source='/home/gewu/.codex/task-checkpoints/geneway-evidence/t03b-original27-gLScNH/donors/work-member-http-JDD8os__api__state.json'
await writeFile(path,await readFile(source))
const store=createFileStore(path),service=createWorkService({store})
await service.ensureReady()
const scope={receiverId:'test-receiver',workspaceId:'local',memberId:'owner',principalId:'owner-protocol'}
const request={operation:'create',clientRequestId:'typed-create',parameters:{employeeId:'desktop-office',goal:'独立纯服务A2A关联验证'}}
const ambiguityBefore=await store.read()
await assert.rejects(service.applyA2aTask(scope,{...request,clientRequestId:'ambiguous-root',parameters:{...request.parameters,targets:['desktop-office','desktop-data']}}),error=>error.code==='INVALID_REQUEST'&&error.message.includes('root'))
assert.deepEqual(await store.read(),ambiguityBefore)
const first=await service.applyA2aTask(scope,request),before=await store.read()
const replay=await service.applyA2aTask(scope,request)
assert.equal(replay.taskId,first.taskId);assert.equal(replay.contextId,first.contextId)
assert.equal((await store.read()).works.length,before.works.length)
await assert.rejects(service.applyA2aTask(scope,{...request,parameters:{...request.parameters,goal:'异文'}}))
assert.deepEqual(await store.read(),before)
validateA2aState(before)
for(const field of ['receiverId','workspaceId','memberId','principalId']) assert.throws(()=>a2aTaskRow(before,{...scope,[field]:'foreign'},first.taskId))
const row=a2aTaskRow(before,scope,first.taskId).row
assert.ok(before.works.some(work=>work.id===row.workId));assert.ok(before.multisite.commands.some(command=>command.commandId===row.commandKey&&command.reply.workId===row.workId))
const projection=projectA2aTask(before,scope,first.taskId)
assert.deepEqual(projectA2aTask(before,scope,first.taskId),projection,'read must not change status timestamp')
const input={operation:'input',clientRequestId:'input2',taskId:first.taskId,contextId:first.contextId,parameters:{text:'实际原owner合法追加',expectedInstructionRevision:1}}
await assert.rejects(service.applyA2aTask({...scope,principalId:'foreign'},input))
await assert.rejects(service.applyA2aTask(scope,{...input,contextId:'wrong'}))
const acceptedInput=await service.applyA2aTask(scope,input)
const persisted=await createFileStore(path).read();assert.equal(persisted.a2aProtocol.tasks.length,1);assert.deepEqual(persisted.a2aProtocol.tasks[0],row)
// 仅投影字段映射的内存前提，不制造真实unknown模型或故障事实。
const interrupted=structuredClone(persisted)
const interruptedWork=interrupted.works.find(work=>work.id===row.workId)
interruptedWork.status='interrupted';interruptedWork.unavailableReason='MODEL_REQUEST_UNCONFIRMED'
const unknownProjection=projectA2aTask(interrupted,scope,row.id)
assert.equal(unknownProjection.status.state,2);assert.equal(unknownProjection.metadata.geneway.executionUnknown,true)
assert.equal(unknownProjection.metadata.geneway.unavailableReason,'MODEL_REQUEST_UNCONFIRMED')
assert.deepEqual(unknownProjection.metadata.geneway.unconfirmedModelRequestIds,[])
assert.deepEqual(projectA2aTask(interrupted,scope,row.id),unknownProjection)
const unknownAttempt=structuredClone(persisted)
const unknownRoot=unknownAttempt.multisite.attempts.find(attempt=>attempt.attempt_id===row.attemptId)
unknownRoot.status='unknown';unknownRoot.unavailableReason='MODEL_REQUEST_UNCONFIRMED'
assert.equal(projectA2aTask(unknownAttempt,scope,row.id).metadata.geneway.executionUnknown,true)
assert.ok(![3,4,5].includes(projectA2aTask(unknownAttempt,scope,row.id).status.state))
const failed=structuredClone(persisted);failed.works.find(work=>work.id===row.workId).status='failed'
assert.equal(projectA2aTask(failed,scope,row.id).status.state,4)
assert.equal(projectA2aTask(failed,scope,row.id).status.timestamp,projectA2aTask(persisted,scope,row.id).status.timestamp)
// 仅独立内存终态前提：不生成stopped/ACK事实，不称Host真实停止。
const terminal=structuredClone(persisted)
terminal.works.find(work=>work.id===row.workId).status='cancelled'
terminal.multisite.attempts.find(attempt=>attempt.attempt_id===row.attemptId).status='cancelled'
assert.equal(projectA2aTask(terminal,scope,row.id).status.state,5)
const terminalBefore=structuredClone(terminal)
const acceptedReplay=applyA2aTransition(terminal,scope,input,service.multisite.applyTransition)
assert.deepEqual(acceptedReplay.reply,acceptedInput.receipt);assert.equal(acceptedReplay.taskId,first.taskId)
assert.deepEqual(terminal,terminalBefore,'accepted replay must not add Work/Input/command effects after terminal')
assert.throws(()=>applyA2aTransition(terminal,scope,{...input,parameters:{...input.parameters,text:'同键异文'}},service.multisite.applyTransition),error=>error.code==='IDEMPOTENCY_CONFLICT')
assert.throws(()=>applyA2aTransition(terminal,scope,{...input,clientRequestId:'new-terminal-input'},service.multisite.applyTransition),error=>error.code==='INVALID_STATE')
assert.deepEqual(terminal,terminalBefore)
for(const mutate of [s=>s.a2aProtocol.tasks.pop(),s=>{s.a2aProtocol.tasks[0].principalId='rewrite'}]){const after=structuredClone(persisted);mutate(after);assert.throws(()=>assertA2aImmutable(persisted,after))}
const ownerBefore=(await store.read()).members.find(member=>member.id===scope.memberId)
await service.updateMember({id:scope.memberId},scope.memberId,{enabled:true,expectedEmployeeIds:ownerBefore.employeeIds,employeeIds:ownerBefore.employeeIds.filter(id=>id!==row.rootEmployeeId)})
const lost=await store.read();assert.equal(lost.members.find(member=>member.id===scope.memberId).enabled,true)
assert.throws(()=>a2aTaskRow(lost,scope,row.id),error=>error.code==='NOT_FOUND')
assert.throws(()=>projectA2aTask(lost,scope,row.id),error=>error.code==='NOT_FOUND')
await assert.rejects(service.applyA2aTask(scope,{...input,clientRequestId:'input-after-read-loss'}),error=>error.code==='NOT_FOUND')
const cancel={operation:'cancel',clientRequestId:'cleanup-after-read-loss',taskId:row.id,contextId:row.contextId,parameters:{}}
await assert.rejects(service.applyA2aTask(scope,{...cancel,contextId:'wrong'}))
for(const field of ['receiverId','workspaceId','memberId','principalId']) await assert.rejects(service.applyA2aTask({...scope,[field]:'foreign'},cancel))
const cleanup=await service.applyA2aTask(scope,cancel);assert.equal(cleanup.taskId,row.id)
const stopping=await store.read();assert.equal(stopping.works.find(work=>work.id===row.workId).status,'stopping')
const metadata=projectA2aTask(stopping,scope,row.id,{cleanup:true})
assert.notEqual(metadata.status.state,5);assert.deepEqual(metadata.artifacts,[]);assert.deepEqual(metadata.history,[]);assert.equal(metadata.metadata.geneway.question,null)
assert.equal(Object.hasOwn(metadata,'goal'),false);assert.equal(Object.hasOwn(metadata,'body'),false)
console.log(JSON.stringify({root,source,taskId:first.taskId,checks:'typed service create/replay/conflict; four scope dimensions; input context/owner; original metadata persist/reopen; immutable; stable projection; accepted input replay after component-terminal clone; interrupted/unknown projection nonterminal vs explicit failed',boundary:'in-process production FileStore/WorkService only; no HTTP,Host,groups or native execution'}))
