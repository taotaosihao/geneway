import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {processIdentity} from './processes.mjs';
const execute=promisify(execFile);
const stateOf=task=>task.state??({2:'working',3:'completed',5:'canceled',6:'input-required'})[task.status?.state];
async function observe(pid){try{return{at:new Date().toISOString(),identity:await processIdentity(pid)}}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;return{at:new Date().toISOString(),pid,unavailableReason:error.code}}}
async function until(test,label,timeout=60000){const end=Date.now()+timeout;for(;;){const value=await test();if(value)return value;assert(Date.now()<end,label+' timed out');await new Promise(done=>setTimeout(done,30));}}
export async function cancelBusyBusiness({root,apiRoot,businessDirectory,task,parents,heldWorker,call,releaseGet}){
  const directory=path.join(root,'cancel');await mkdir(directory,{recursive:true});const save=(name,value)=>writeFile(path.join(directory,name),JSON.stringify(value,null,2));
  const readState=async()=>JSON.parse(await readFile(path.join(apiRoot,'state.json'))),readLocal=async()=>JSON.parse(await readFile(path.join(businessDirectory,'pc-b/host-journal.json')));
  const parent=parents.find(row=>row.agent==='desktop-office');assert(parent);const parentIdentity=await processIdentity(parent.pid),workerIdentity=await processIdentity(heldWorker.worker.pid);assert(['T','t'].includes(workerIdentity.state));
  const beforeTask=(await call('get',undefined,'cancel-before')).task,before=await readState(),beforeLocal=await readLocal();assert.equal(beforeTask.id,task.id);assert.equal(heldWorker.state,'running');
  await save('before.json',{state:before,local:beforeLocal,task:beforeTask,heldWorker,parentIdentity,workerIdentity});
  let parentHeld=false;
  try{
    process.kill(parent.pid,'SIGSTOP');parentHeld=true;const stoppedParent=await until(async()=>{const actual=await processIdentity(parent.pid);assert.equal(actual.startTicks,parentIdentity.startTicks);return ['T','t'].includes(actual.state)&&actual},'actual B parent SIGSTOP');
    await save('barrier.json',{at:new Date().toISOString(),parent:stoppedParent,worker:await observe(heldWorker.worker.pid)});
    const canceled=await call('cancel',undefined,'cancel-request'),queried=await call('get',undefined,'cancel-stopping-query'),stopping=await readState(),stoppingLocal=await readLocal();
    for(const current of[canceled.task,queried.task]){assert.equal(stateOf(current),'working','Cancel acceptance is not terminal stop');assert.equal(current.metadata.geneway.workStatus,'stopping');assert.equal(current.artifacts.length,0);}
    assert.equal(stopping.works.find(row=>row.id===task.metadata.geneway.workId).status,'stopping');
    const execution=stoppingLocal.executions.find(row=>row.attempt_id===heldWorker.attempt_id);assert(execution);assert.notEqual(execution.status,'stopped');assert(!stoppingLocal.outbox.some(row=>row.event.kind==='stopped'&&row.event.attempt_id===heldWorker.attempt_id));
    const actualParent=await processIdentity(parent.pid),actualWorker=await processIdentity(workerIdentity.pid);assert.equal(actualParent.startTicks,parentIdentity.startTicks);assert.equal(actualWorker.startTicks,workerIdentity.startTicks);assert(['T','t'].includes(actualParent.state));assert(['T','t'].includes(actualWorker.state));
    await save('stopping.json',{at:new Date().toISOString(),state:stopping,local:stoppingLocal,cancel:canceled,query:queried,parent:actualParent,worker:actualWorker});
    process.kill(parent.pid,'SIGCONT');parentHeld=false;await save('release-parent.json',{at:new Date().toISOString(),signal:'SIGCONT',identity:actualParent});releaseGet();
    const final=await until(async()=>{const state=await readState();return state.works.find(row=>row.id===task.metadata.geneway.workId).status==='cancelled'&&state},'original Work stopped');
    const local=await until(async()=>{const journal=await readLocal();return journal.outbox.some(row=>row.event.kind==='stopped'&&row.event.attempt_id===heldWorker.attempt_id&&row.acknowledged)&&journal},'actual B stopped exact ACK');
    const job=local.jobs.find(row=>row.id===heldWorker.id);assert.equal(job.state,'stopped');assert.equal(job.stopEvidence.workerExit,'exit_confirmed');assert.equal(job.stopEvidence.output,'no_published_output');
    const workerAfter=await observe(workerIdentity.pid);assert(workerAfter.unavailableReason||workerAfter.identity.state==='Z'||workerAfter.identity.startTicks!==workerIdentity.startTicks,'Original worker still live');
    const finalTask=(await call('get',undefined,'cancel-final-query')).task;assert.equal(stateOf(finalTask),'canceled');assert.equal(finalTask.id,task.id);assert.equal(finalTask.artifacts.length,0);assert(!final.artifacts.some(row=>row.workId===task.metadata.geneway.workId&&row.status==='ready'));
    const journals=[];for(const item of parents)journals.push({agent:item.agent,root:item.root,journal:JSON.parse(await readFile(path.join(item.root,'host-journal.json')))});
    await save('final.json',{at:new Date().toISOString(),state:final,local,journals,task:finalTask,workerAfter});
    const result={candidate:process.env.GENEWAY_PROTOCOL_COMPARISON_CANDIDATE,taskId:task.id,workId:task.metadata.geneway.workId,workerIdentity,parentIdentity,workerAfter,stoppingTaskState:stateOf(queried.task),finalTaskState:stateOf(finalTask),boundary:'Actual protocol peer cancellation; B Host transport barrier released for production stop, no fixture worker kill, no effect rollback claim'};
    await writeFile(path.join(root,'cancel-result.json'),JSON.stringify(result,null,2));return result;
  }finally{if(parentHeld){const current=await observe(parent.pid);if(current.identity?.startTicks===parentIdentity.startTicks){process.kill(parent.pid,'SIGCONT');await save('failure-cleanup-parent-cont.json',{at:new Date().toISOString(),identity:current.identity,signal:'SIGCONT'});}}}
}
export async function collectCancelSessions(businessDirectory,parents){
  const find=async directory=>{const found=[];for(const item of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())found.push(...await find(file));else if(item.name==='session.v4.jsonl.zstd')found.push(file);}return found;};
  const sessions={};for(const parent of parents){const files=await find(path.join(parent.root,'multisite-executions'));assert.equal(files.length,1);const result=await execute('zstd',['-dc','--',files[0]],{encoding:'buffer',maxBuffer:16*1024*1024});sessions[parent.agent]=result.stdout.toString('utf8').trim().split('\n').map(JSON.parse);}
  await writeFile(path.join(businessDirectory,'cancel-sessions.json'),JSON.stringify(sessions,null,2));
}
