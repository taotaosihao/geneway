import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { digest, error, exact, key, text } from '../packages/agent-contracts/index.mjs'

export const emptyA2aState = () => ({ a2aProtocol: { tasks: [], groups: [], deliveries: [] } })
export const A2A_TASK_SCHEMA = 'geneway.a2a.task/1'
export const A2A_NODE_SCHEMA = 'geneway.a2a.node-command/1'
export const A2A_GROUP_SCHEMA = 'geneway.a2a.work-group/1'
const taskFields = ['id','contextId','receiverId','workspaceId','memberId','principalId','requestId','requestDigest','commandKey','workId','delegationId','attemptId','rootEmployeeId','createdAt']
const check = (condition, label) => { if (!condition) throw error('INVALID_STATE', 'A2A 关联元数据无效：' + label) }

export function assertNoFutureA2a(value) {
  if ((value.version ?? 3) < 28 && value.a2aProtocol !== undefined && !isDeepStrictEqual(value.a2aProtocol, emptyA2aState().a2aProtocol)) throw new Error('旧版本状态不得包含 A2A 协议事实')
}
export function validateA2aState(state) {
  const domain=state.a2aProtocol
  check(domain&&typeof domain==='object'&&!Array.isArray(domain),'事务域')
  exact(domain,['tasks','groups','deliveries'])
  for(const name of ['tasks','groups','deliveries'])check(Array.isArray(domain[name])&&domain[name].length<=30000,name)
  check(new Set(domain.tasks.map(row=>row.id)).size===domain.tasks.length,'Task ID 重复')
  check(new Set(domain.tasks.map(row=>key(row.receiverId,row.principalId,row.requestId))).size===domain.tasks.length,'受理标识重复')
  for(const row of domain.tasks){
    exact(row,taskFields)
    for(const name of taskFields)text(row[name],name)
    const work=state.works.find(item=>item.id===row.workId),attempt=state.multisite.attempts.find(item=>item.attempt_id===row.attemptId)
    check(work?.workType==='multisite'&&work.workspaceId===row.workspaceId&&work.ownerMemberId===row.memberId,'Work 归属')
    check(attempt?.work_id===work.id&&attempt.delegation_id===row.delegationId&&attempt.parent_delegation_id===null&&attempt.agent_id===row.rootEmployeeId,'明确 root binding')
    check(state.multisite.commands.some(item=>item.issuerId===row.memberId&&item.commandId===row.commandKey&&item.reply.workId===row.workId),'原受理命令')
    check(Number.isFinite(Date.parse(row.createdAt))&&/^[a-f0-9]{64}$/.test(row.requestDigest),'时间/摘要')
  }
  return state
}
export function assertA2aImmutable(before,after) {
  for(const previous of before.a2aProtocol.tasks){
    const current=after.a2aProtocol.tasks.find(row=>row.id===previous.id)
    check(isDeepStrictEqual(previous,current),'Task 原关联不可改写或删除')
  }
}
export function requireA2aOwner(state,scope) {
  exact(scope,['receiverId','workspaceId','memberId','principalId'])
  for(const name of ['receiverId','workspaceId','memberId','principalId'])text(scope[name],name)
  const member=state.members.find(row=>row.id===scope.memberId&&row.enabled)
  if(!member)throw error('UNAUTHORIZED','协议主体未获准')
  return member
}
export function a2aTaskRow(state,scope,id,{cleanup=false}={}) {
  const member=requireA2aOwner(state,scope),row=state.a2aProtocol.tasks.find(row=>row.id===id&&row.receiverId===scope.receiverId&&row.workspaceId===scope.workspaceId&&row.principalId===scope.principalId&&row.memberId===member.id)
  const work=row&&state.works.find(work=>work.id===row.workId&&work.workType==='multisite'&&work.workspaceId===scope.workspaceId&&work.ownerMemberId===member.id)
  if(!work||!cleanup&&!member.employeeIds.includes(work.employeeId))throw error('NOT_FOUND','工作不存在')
  return {row,work,member}
}

// Only the internal typed service calls this within the original Work update.
// The transport cannot supply a draft callback or another Task state authority.
export function applyA2aTransition(state,scope,request,applyTransition) {
  const member=requireA2aOwner(state,scope)
  exact(request,['operation','clientRequestId','parameters','taskId','contextId','rootEmployeeId'])
  const operation=request.operation,requestId=text(request.clientRequestId,'请求 ID'),parameters=structuredClone(request.parameters??{})
  if(!['create','input','cancel'].includes(operation))throw error('INVALID_REQUEST')
  if(Object.hasOwn(parameters,'clientRequestId')||Object.hasOwn(parameters,'workId'))throw error('INVALID_REQUEST','业务标识由受管关联确定')
  let row,transition
  if(operation==='create'){
    const requestDigest=digest({parameters,rootEmployeeId:request.rootEmployeeId??null})
    row=state.a2aProtocol.tasks.find(item=>item.receiverId===scope.receiverId&&item.principalId===scope.principalId&&item.requestId===requestId)
    if(row&&row.requestDigest!==requestDigest)throw error('IDEMPOTENCY_CONFLICT')
    if(row)a2aTaskRow(state,scope,row.id)
    const commandKey='a2a-create-'+key(scope.receiverId,scope.principalId,requestId)
    transition=applyTransition(state,{id:member.id},'create',{...parameters,clientRequestId:commandKey})
    if(!row){
      const work=state.works.find(item=>item.id===transition.reply.workId),roots=state.multisite.attempts.filter(item=>item.work_id===work?.id&&item.parent_delegation_id===null),selected=request.rootEmployeeId?roots.filter(item=>item.agent_id===request.rootEmployeeId):roots
      if(!work||work.workspaceId!==scope.workspaceId||selected.length!==1)throw error('INVALID_REQUEST','必须明确唯一的协议 root Agent')
      const root=selected[0]
      row={id:randomUUID(),contextId:randomUUID(),...scope,requestId,requestDigest,commandKey,workId:work.id,delegationId:root.delegation_id,attemptId:root.attempt_id,rootEmployeeId:root.agent_id,createdAt:work.acceptedAt}
      state.a2aProtocol.tasks.push(row)
    }
  }else{
    row=a2aTaskRow(state,scope,text(request.taskId,'Task ID'),{cleanup:operation==='cancel'}).row
    if(request.contextId!==row.contextId)throw error('INVALID_REQUEST','Task context 不匹配')
    const commandKey='a2a-'+operation+'-'+key(scope.receiverId,scope.principalId,row.id,requestId)
    const accepted=state.multisite.commands.some(item=>item.issuerId===member.id&&item.commandId===commandKey&&item.reply?.workId===row.workId)
    // An accepted request still uses the original digest/attachment replay gate.
    // Terminal state only prevents a new input, never acknowledgement recovery.
    if(operation==='input'&&!accepted&&[3,4,5].includes(projectA2aTask(state,scope,row.id).status.state))throw error('INVALID_STATE','原协议 Task 已终态，请另建 Task')
    if(operation==='cancel'&&!accepted&&[3,4].includes(projectA2aTask(state,scope,row.id,{cleanup:true}).status.state))throw error('TASK_NOT_CANCELABLE','原协议 Task 已终态')
    transition=applyTransition(state,{id:member.id},operation,{...parameters,workId:row.workId,clientRequestId:commandKey})
  }
  return {...transition,taskId:row.id,contextId:row.contextId}
}

export function projectA2aTask(state,scope,id,{artifactUrl,cleanup=false}={}) {
  const {row,work,member}=a2aTaskRow(state,scope,id,{cleanup}),attempt=state.multisite.attempts.find(item=>item.attempt_id===row.attemptId)
  if(!attempt||attempt.delegation_id!==row.delegationId)throw error('NOT_FOUND')
  const metadataOnly=cleanup&&!member.employeeIds.includes(work.employeeId)
  const activeQuestion=work.pendingQuestion&&(state.userQuestions.find(item=>item.id===work.pendingQuestion.id&&item.state==='open'&&item.instructionRevision===work.instructionRevision)??(!work.pendingQuestion.id?work.pendingQuestion:null))
  const question=metadataOnly?null:activeQuestion
  const readyRows=state.artifacts.filter(item=>item.workId===work.id&&item.status==='ready'&&item.instructionRevision===work.instructionRevision)
  const ready=metadataOnly?[]:readyRows
  const executionUnknown=work.status==='interrupted'||attempt.status==='unknown'
  let status=2
  if(work.status==='accepted')status=1
  if(activeQuestion)status=6
  if(work.status==='cancelled'&&attempt.status==='cancelled')status=5
  if(work.status==='failed'&&!executionUnknown)status=4
  if(work.status==='completed'&&attempt.status==='completed'&&(!work.spreadsheetRequest||readyRows.length))status=3
  const instants=[row.createdAt,work.completedAt,...state.multisite.inputs.filter(item=>item.workId===work.id).map(item=>item.at),...state.multisite.commands.filter(item=>item.reply?.workId===work.id).map(item=>item.acceptedAt),...state.multisite.receipts.filter(item=>item.event?.work_id===work.id).flatMap(item=>[item.receivedAt,item.event.at]),...state.modelRequests.filter(item=>item.work_id===work.id).flatMap(item=>[item.completedAt,item.reservedAt])].filter(value=>Number.isFinite(Date.parse(value)))
  const timestamp=new Date(Math.max(...instants.map(value=>Date.parse(value)))).toISOString()
  const artifacts=status===3?ready.map(item=>{const artifactId='output-'+key(row.id,item.id);return{artifactId,name:item.name,description:'原工作当前已发布成果',parts:[{content:{$case:'url',value:artifactUrl?.(artifactId)??''},mediaType:item.mediaType,filename:item.name}],metadata:{globalRef:{id:item.id,version:item.version,sha256:item.sha256},sha256:item.sha256,sizeBytes:item.sizeBytes},extensions:[]}}):[]
  return {id:row.id,contextId:row.contextId,status:{state:status,timestamp},artifacts,history:[],metadata:{geneway:{workId:work.id,rootDelegationId:row.delegationId,rootAttemptId:row.attemptId,currentRevision:work.instructionRevision,workStatus:work.status,rootAttemptStatus:attempt.status,executionUnknown,unavailableReason:attempt.unavailableReason??work.unavailableReason??null,unconfirmedModelRequestIds:state.modelRequests.filter(item=>item.work_id===work.id&&item.outcome==='unknown').map(item=>item.id),question:question?structuredClone(question):null,projectionRevision:digest({work,attempt,question,ready})}}}
}
