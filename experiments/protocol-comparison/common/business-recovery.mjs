import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {processIdentity} from './processes.mjs';

export async function recoverWaitingBusiness({manager,root,apiRoot,businessDirectory,task,query}){
  const directory=path.join(root,'recovery');await mkdir(directory,{recursive:true,mode:0o700});
  const save=(name,value)=>writeFile(path.join(directory,name),JSON.stringify(value,null,2),{mode:0o600});
  const readState=async()=>JSON.parse(await readFile(path.join(apiRoot,'state.json'),'utf8'));
  const workId=task.metadata.geneway.workId,question=task.metadata.geneway.question;
  assert(task.state==='input-required'||task.status?.state===6,'Recovery requires actual input-required Task');assert(question?.id,'Recovery requires the actual open question');
  // A question tool can precede its final SSE completion. Observe settlement before
  // comparing business facts; do not confuse that late accounting with replay.
  const deadline=Date.now()+30000;let before;
  for(;;){before=await readState();const ledger=before.modelRequests.filter(row=>row.work_id===workId);if(ledger.length&&ledger.every(row=>row.outcome==='completed'))break;assert(Date.now()<deadline,'Question model requests did not settle before recovery');await new Promise(done=>setTimeout(done,50));}
  const parentFile=path.join(businessDirectory,'parents.json'),parentConfig=JSON.parse(await readFile(parentFile,'utf8'));
  assert.equal(parentConfig.parents.length,5,'Expected the original five Host parents');
  const identities=[];for(const item of [{pid:parentConfig.apiPid,name:'api'},...parentConfig.parents.map(row=>({pid:row.pid,name:row.agent??row.nodeId}))]){const identity=await processIdentity(item.pid);assert(identity.state!=='Z');identities.push({...identity,name:item.name});}
  const oldIdentity=structuredClone(manager.identity),oldPeerConfig=structuredClone(manager.peerConfig),oldOrigin=manager.origin;
  const peerIdentity=manager.peer?await processIdentity(manager.peer.child.pid):null;
  const identityFiles=manager.peer?[path.join(root,'recovery-home/service-identity.json'),path.join(root,'recovery-home/coordinator-identity.json'),path.join(root,'anp/principal-grant.json'),manager.peer.identity.configPath]:[path.join(root,'a2a/peer-token'),path.join(root,'a2a/principal-grant.json'),path.join(root,'a2a/tls/server.key.pem'),path.join(root,'a2a/tls/server.cert.pem')];
  async function identityHashes(){const values=[];for(const file of identityFiles){const bytes=await readFile(file);values.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});}return values;}
  const beforeIdentityFiles=await identityHashes();await save('identity-files-before.json',beforeIdentityFiles);
  let mappingFile,mapping;for(const file of [path.join(root,'mapping/protocol-mapping.json'),path.join(root,'anp/mapping/protocol-mapping.json')]){try{mapping=JSON.parse(await readFile(file,'utf8'));mappingFile=file;break;}catch(error){if(error.code!=='ENOENT')throw error;}}
  assert(mapping,'Actual business mapping must exist');
  await save('before-cloud.json',before);await save('before-mapping.json',mapping);await save('before-processes.json',{businessChild:oldIdentity,independentGroupHost:peerIdentity,parents:identities,peerConfig:oldPeerConfig,origin:oldOrigin,parentFile,mappingFile,task});
  const terminal=await manager.kill();assert.equal(terminal.signal,'SIGKILL');
  const offline=await query('recovery-offline-query',{timeoutMs:1200,expectFailure:true});assert(offline.error,'Offline query must fail, not return a Task');assert(!offline.task&&!offline.output?.task,'Offline query returned a fabricated successful Task');
  const during=await readState();await save('offline-query.json',offline);await save('offline-cloud.json',during);
  async function verifyParents(){const observed=[];let groupHost=null;for(const expected of identities){const actual=await processIdentity(expected.pid);assert.equal(actual.startTicks,expected.startTicks,'Original API/Host identity changed');assert(!['Z','T','t'].includes(actual.state),'Original API/Host stopped');observed.push({...actual,name:expected.name});}if(peerIdentity){const actual=await processIdentity(peerIdentity.pid);assert.equal(actual.startTicks,peerIdentity.startTicks);assert(!['Z','T','t'].includes(actual.state),'Independent GroupHost stopped');groupHost=actual;}return{observedAt:new Date().toISOString(),parents:observed,independentGroupHost:groupHost};}
  await save('offline-processes.json',await verifyParents());
  const restarted=await manager.startExisting();assert.notEqual(restarted.identity.pid,oldIdentity.pid);assert.equal(restarted.origin,oldOrigin);assert.deepEqual(restarted.peerConfig,oldPeerConfig);
  const output=await query('recovery-after-restart-query',{}),current=output.task;assert(current,'Actual restarted peer query must return a Task');assert.equal(current.id,task.id);assert.equal(current.contextId,task.contextId);assert(current.state==='input-required'||current.status?.state===6,'Restarted Task must remain input-required');
  for(const field of ['workId','rootDelegationId','rootAttemptId','currentRevision'])assert.equal(current.metadata.geneway[field],task.metadata.geneway[field]);assert.deepEqual(current.metadata.geneway.question,question);
  const after=await readState();await save('after-processes.json',await verifyParents());const afterIdentityFiles=await identityHashes();await save('identity-files-after.json',afterIdentityFiles);assert.deepEqual(afterIdentityFiles,beforeIdentityFiles,'Recovery changed original identity/key/credential bytes');
  function business(state){return{works:state.works.filter(row=>row.id===workId),inputs:state.multisite.inputs.filter(row=>row.workId===workId),delegations:state.multisite.delegations.filter(row=>row.work_id===workId),attempts:state.multisite.attempts.filter(row=>row.work_id===workId)};}
  assert.deepEqual(business(during),business(before),'Adapter outage changed original business facts');assert.deepEqual(business(after),business(before),'Adapter restart changed original business facts');
  const ledger=state=>state.modelRequests.filter(row=>row.work_id===workId);assert.equal(ledger(during).length,ledger(before).length);assert.equal(ledger(after).length,ledger(before).length);
  const afterMapping=JSON.parse(await readFile(mappingFile,'utf8'));assert.deepEqual(afterMapping,mapping,'Recovery must reuse existing Task binding');
  await save('after-cloud.json',after);await save('after-mapping.json',afterMapping);await save('after-query.json',output);
  const result={result:'passed',directory,taskId:task.id,contextId:task.contextId,questionId:question.id,workId,oldIdentity,newIdentity:restarted.identity,terminal,origin:oldOrigin,peerConfigUnchanged:true,identityFileHashesUnchanged:true,originalApiAndFiveHostIdentities:identities,independentGroupHost:peerIdentity,offlineQueryFailed:true,sameQuestionRootRevisionAndMapping:true,modelRequestsBefore:ledger(before).length,modelRequestsAfter:ledger(after).length,boundary:'Actual business child SIGKILL and fresh PID restoration; original API, official DSH Hosts and independent GroupHost remain live; no OS reboot or business replay'};
  await save('recovery-process-result.json',result);await writeFile(path.join(root,'recovery-process-result.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
}
