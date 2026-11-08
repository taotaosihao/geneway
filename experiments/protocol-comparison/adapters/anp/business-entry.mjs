import assert from 'node:assert/strict';
import { readFile,writeFile,appendFile } from 'node:fs/promises';
import path from 'node:path';
import * as sdk from '@awiki/anp-typescript-sdk';
import { peerCommand } from '../../peers/anp/run.mjs';
import { createBusinessTasks } from '../../common/business-tasks.mjs';
export async function startBusinessAnp({root,apiRoot,origin,session,home,peer,openExisting=false,allowCancel=false}){
  const handle='business-owner',grant=openExisting?JSON.parse(await readFile(path.join(root,'principal-grant.json'))):null,identity=openExisting?{did:grant.principal}:await peerCommand(peer,{operation:'identity',handle}),principal=identity.did;
  const tasks=await createBusinessTasks({root:path.join(root,'mapping'),apiRoot,origin,session,principal,allowCancel});
  const homeDid=home.identities.get('coordinator').didDocument.id;
  if(openExisting){assert.equal(grant.homeDid,homeDid,'Reopen cannot change Home identity');assert.deepEqual(grant.allowedOperations,['create','input','get','download-own-task',...(allowCancel?['cancel-own-task']:[])],'Reopen cannot expand the original principal grant');}
  const created=openExisting?grant.created:await peerCommand(peer,{operation:'rpc',handle,method:'group.create',operationId:'private-business-group',body:{group_profile:{display_name:'Private authorized business Task',discoverability:'private'},group_policy:{message_security_profile:'transport-protected',bootstrap_security_profile:'transport-protected',admission_mode:'admin-add',permissions:{send:'member',add:'admin',remove:'admin',update_profile:'admin',update_policy:'owner'},attachments_allowed:false,max_members:'2'},initial_members:[{member_did:homeDid,role:'member'}]}}),groupDid=created.group_did;
  if(!openExisting)await writeFile(path.join(root,'principal-grant.json'),JSON.stringify({principal,businessActorId:'owner',groupDid,homeDid,created,allowedOperations:['create','input','get','download-own-task',...(allowCancel?['cancel-own-task']:[])],authority:'Explicit isolated owner prebinding; Group membership does not grant human or file authority'},null,2));
  if(openExisting){const current=await home.rpc('coordinator',peer.origin,'group.get_info',{kind:'group',did:groupDid},{include_policy:true,include_member_list:true});assert(!current.error,JSON.stringify(current));assert.equal(current.result.group_did,groupDid);assert.equal(current.result.group_profile.discoverability,'private');assert.equal(current.result.group_policy.admission_mode,'admin-add');assert.equal(current.result.group_policy.max_members,'2');assert.deepEqual(current.result.member_list.map(row=>row.member_did).sort(),[principal,homeDid].sort());assert(current.result.member_list.every(row=>row.status==='active'));await appendFile(path.join(root,'reopen-validation.jsonl'),JSON.stringify({at:new Date().toISOString(),principal,homeDid,groupDid,result:current.result})+'\n');}
  const remove=home.subscribe(async record=>{
    const {meta,body}=record.rpc.params;if(record.rpc.method!=='group.incoming'||body.group_did!==groupDid||meta.target.did!==homeDid)return;
    assert.equal(meta.sender_did,principal);const value=body.payload;assert.equal(value?.schema,'geneway.protocol-task/1');
    let task;
    try{
      let row,receipt;
      if(value.operation==='create')row=await tasks.create(principal,value.clientRequestId,value.parameters);
      else if(value.operation==='input'){receipt=await tasks.input(principal,value.taskId,value.contextId,value.clientRequestId,value.parameters);row=tasks.find(value.taskId,principal);}
      else if(value.operation==='get')row=tasks.find(value.taskId,principal);
      else if(value.operation==='cancel'){assert(allowCancel,'Cancellation requires an explicit original principal grant');receipt=await tasks.cancel(principal,value.taskId,value.contextId);row=tasks.find(value.taskId,principal);}
      else throw Error('Unsupported business operation');
      task=await tasks.project(principal,row.protocolTaskId,{businessReceipt:receipt,artifactUrl:localId=>home.origin+'/business/tasks/'+encodeURIComponent(row.protocolTaskId)+'/artifacts/'+encodeURIComponent(localId)});
      const sent=await home.rpc('coordinator',peer.origin,'group.send',{kind:'group',did:groupDid},{payload:{schema:'geneway.protocol-task-response/1',requestId:value.requestId,operation:value.operation,task}},{operationId:'business-response-'+value.requestId,messageId:'business-response-'+value.requestId});assert(!sent.error,JSON.stringify(sent));
      await appendFile(path.join(root,'responses.jsonl'),JSON.stringify({at:new Date().toISOString(),principal,request:value,task,hostReceipt:sent.result})+'\n');
    }catch(error){await appendFile(path.join(root,'errors.jsonl'),JSON.stringify({at:new Date().toISOString(),message:error.message,stack:error.stack,request:value})+'\n');const sent=await home.rpc('coordinator',peer.origin,'group.send',{kind:'group',did:groupDid},{payload:{schema:'geneway.protocol-task-response/1',requestId:value.requestId,error:{code:error.code??'BUSINESS_UNAVAILABLE',message:error.message}}},{operationId:'business-error-'+value.requestId,messageId:'business-error-'+value.requestId});if(sent.error)throw error;}
  });
  const removeHttp=home.handleHttp(async(request,response)=>{
    const match=/^\/business\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(request.url);if(!match||request.method!=='GET')return false;
    const metadata=sdk.extractSignatureMetadata(request.headers);assert.equal(metadata.keyid.split('#')[0],principal);const document=await home.resolveDocument(principal);assert(document.authentication.includes(metadata.keyid));sdk.verifyHttpMessageSignature(document,'GET',home.origin+request.url,request.headers,'');
    const file=await tasks.download(principal,decodeURIComponent(match[1]),decodeURIComponent(match[2]));response.writeHead(200,{'content-type':file.mediaType,'content-length':file.bytes.length});response.end(file.bytes);
    await appendFile(path.join(root,'downloads.jsonl'),JSON.stringify({at:new Date().toISOString(),principal,taskId:match[1],artifactId:match[2],globalRef:file.artifact.globalRef,sha256:file.artifact.sha256,bytes:file.bytes.length,requestHeaders:request.headers})+'\n');return true;
  });
  return{peerConfigPath:peer.identity.configPath,handle,groupDid,homeDid,tasks,async close(){remove();removeHttp();}};
}
