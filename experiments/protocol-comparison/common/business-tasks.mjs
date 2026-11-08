import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile,rename,appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)||value instanceof Uint8Array?value:JSON.stringify(value)).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code})};

// This file is an index, not a second Work/Task state store. Work creation,
// input, authorization and ready bytes stay at the existing production API.
export async function createBusinessTasks({root,apiRoot,origin,session,principal,businessActorId='owner',allowCancel=false}){
  await mkdir(root,{recursive:true,mode:0o700});const file=path.join(root,'protocol-mapping.json');let index;
  try{index=JSON.parse(await readFile(file));}catch(error){if(error.code!=='ENOENT')throw error;index={schema:'geneway.protocol-task-index/1',bindings:[]};}
  let serial=Promise.resolve();
  async function persist(){const temp=file+'.tmp';await writeFile(temp,JSON.stringify(index,null,2),{mode:0o600});await rename(temp,file);}
  const transaction=fn=>{const result=serial.catch(()=>{}).then(fn);serial=result;return result;};
  async function api(route,body,method='POST'){
    const response=await fetch(origin+route,{method,headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrfToken,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const bytes=Buffer.from(await response.arrayBuffer());if(!response.ok){let code;try{code=JSON.parse(bytes).error?.code;}catch{}return fail(code??'BUSINESS_API_DENIED');}
    if(route.endsWith('/content'))return{bytes,mediaType:response.headers.get('content-type')};return JSON.parse(bytes);
  }
  async function authorize(row,caller){if(caller!==principal||row.principal!==principal)return fail('FORBIDDEN');await api('/api/works/'+encodeURIComponent(row.workId),undefined,'GET');}
  function find(id,caller){const row=index.bindings.find(item=>item.protocolTaskId===id&&item.principal===caller);if(!row)return fail('NOT_FOUND');return row;}
  async function create(caller,clientRequestId,parameters){
    if(caller!==principal)return fail('FORBIDDEN');assert(typeof clientRequestId==='string'&&clientRequestId.length);const requestDigest=hash(parameters);
    return transaction(async()=>{
      let row=index.bindings.find(item=>item.principal===caller&&item.clientRequestId===clientRequestId);
      if(row){if(row.requestDigest!==requestDigest)return fail('IDEMPOTENCY_CONFLICT');if(row.workId){await authorize(row,caller);return structuredClone(row);}}
      else{const protocolTaskId=randomUUID();row={receiver:'geneway-experiment',principal:caller,businessActorId,protocolTaskId,contextId:'geneway-context-'+protocolTaskId,clientRequestId,createCommandKey:'protocol-create-'+hash(caller+'\0'+clientRequestId).slice(0,32),requestDigest,workId:null,rootDelegationId:null,rootAttemptId:null,createdAt:new Date().toISOString()};index.bindings.push(row);await persist();}
      const receipt=await api('/api/works',{...parameters,clientRequestId:row.createCommandKey});
      const state=JSON.parse(await readFile(path.join(apiRoot,'state.json'))),work=state.works.find(item=>item.id===receipt.id),attempt=state.multisite.attempts.find(item=>item.work_id===work?.id&&item.parent_delegation_id===null);
      assert(work&&attempt,'Production accepted Work must already have its root binding');assert.equal(work.ownerMemberId,businessActorId);
      Object.assign(row,{workId:work.id,rootDelegationId:attempt.delegation_id,rootAttemptId:attempt.attempt_id,businessReceipt:receipt});await persist();
      await appendFile(path.join(root,'business-events.jsonl'),JSON.stringify({at:new Date().toISOString(),operation:'create',principal:caller,protocolTaskId:row.protocolTaskId,workId:work.id,rootDelegationId:row.rootDelegationId,rootAttemptId:row.rootAttemptId,requestDigest,commandKey:row.createCommandKey})+'\n');return structuredClone(row);
    });
  }
  async function input(caller,taskId,contextId,clientRequestId,parameters){
    const row=find(taskId,caller);if(row.contextId!==contextId)return fail('INVALID_CONTEXT');await authorize(row,caller);
    const receipt=await api('/api/works/'+encodeURIComponent(row.workId)+'/multisite/inputs',{...parameters,clientRequestId:'protocol-input-'+hash(caller+'\0'+taskId+'\0'+clientRequestId).slice(0,32)});
    await appendFile(path.join(root,'business-events.jsonl'),JSON.stringify({at:new Date().toISOString(),operation:'input',principal:caller,protocolTaskId:taskId,workId:row.workId,clientRequestId,requestDigest:hash(parameters),receipt})+'\n');return receipt;
  }
  async function cancel(caller,taskId,contextId){
    if(!allowCancel)return fail('FORBIDDEN');const row=find(taskId,caller);if(contextId!==undefined&&contextId!==row.contextId)return fail('INVALID_CONTEXT');await authorize(row,caller);
    const commandKey='protocol-cancel-'+hash(caller+'\0'+taskId).slice(0,32),receipt=await api('/api/works/'+encodeURIComponent(row.workId)+'/multisite/cancel',{clientRequestId:commandKey});
    await appendFile(path.join(root,'business-events.jsonl'),JSON.stringify({at:new Date().toISOString(),operation:'cancel',principal:caller,protocolTaskId:taskId,workId:row.workId,commandKey,receipt})+'\n');return receipt;
  }
  async function project(caller,taskId,{artifactUrl,businessReceipt}={}){
    const row=find(taskId,caller);await authorize(row,caller);
    const state=JSON.parse(await readFile(path.join(apiRoot,'state.json'))),work=state.works.find(item=>item.id===row.workId),attempt=state.multisite.attempts.find(item=>item.attempt_id===row.rootAttemptId);
    assert(work&&attempt&&attempt.delegation_id===row.rootDelegationId);assert.equal(work.ownerMemberId,businessActorId);
    const question=work.pendingQuestion&&state.userQuestions.find(item=>item.id===work.pendingQuestion.id&&item.state==='open'&&item.instructionRevision===work.instructionRevision);
    const ready=state.artifacts.filter(item=>item.workId===work.id&&item.status==='ready'&&item.instructionRevision===work.instructionRevision);
    let status='working';if(['accepted','requested'].includes(work.status))status='submitted';if(question)status='input-required';if(work.status==='cancelled'&&attempt.status==='cancelled')status='canceled';if(work.status==='failed')status='failed';if(work.status==='completed'&&attempt.status==='completed'&&(!work.spreadsheetRequest||ready.length))status='completed';
    const artifacts=status==='completed'?ready.map(item=>{const artifactId='output-'+hash(taskId+'\0'+item.id).slice(0,24);return{artifactId,name:item.name,mediaType:item.mediaType,sha256:item.sha256,sizeBytes:item.sizeBytes,url:artifactUrl?.(artifactId)??null,globalRef:{id:item.id,version:item.version,sha256:item.sha256}};}):[];
    const task={schema:'geneway.task/1',id:taskId,contextId:row.contextId,state:status,artifacts,metadata:{geneway:{workId:work.id,rootDelegationId:row.rootDelegationId,rootAttemptId:row.rootAttemptId,currentRevision:work.instructionRevision,workStatus:work.status,rootAttemptStatus:attempt.status,executionUnknown:work.status==='interrupted'||attempt.status==='unknown',unavailableReason:attempt.unavailableReason??work.unavailableReason??null,unconfirmedModelRequestIds:state.modelRequests.filter(item=>item.work_id===work.id&&item.outcome==='unknown').map(item=>item.id),question:question?structuredClone(question):null,businessReceipt:businessReceipt??row.businessReceipt,projectionDigest:hash({work,attempt,question,ready})}},statusTimestamp:work.completedAt??question?.createdAt??attempt.startedAt??work.acceptedAt};
    await appendFile(path.join(root,'task-observations.jsonl'),JSON.stringify({at:new Date().toISOString(),principal:caller,task})+'\n');return task;
  }
  async function download(caller,taskId,localArtifactId){
    const task=await project(caller,taskId),artifact=task.artifacts.find(item=>item.artifactId===localArtifactId);if(!artifact)return fail('NOT_FOUND');
    const output=await api('/api/works/'+encodeURIComponent(task.metadata.geneway.workId)+'/artifacts/'+encodeURIComponent(artifact.globalRef.id)+'/content',undefined,'GET');assert.equal(hash(output.bytes),artifact.sha256);return{...output,artifact,task};
  }
  return{create,input,cancel,project,download,find,index,principal};
}
