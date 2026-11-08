import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,readFile,writeFile,appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { createBusinessTasks } from './business-tasks.mjs';
import { startBusinessA2a } from '../adapters/a2a/business-server.mjs';
import { startBusinessAnp } from '../adapters/anp/business-entry.mjs';
import { currentRelay } from './protocol-fork.mjs';
import { startBusinessProcess } from './business-process.mjs';
import { recoverWaitingBusiness } from './business-recovery.mjs';
import { cancelBusyBusiness,collectCancelSessions } from './business-cancel.mjs';
import { processIdentity } from './processes.mjs';
const execute=promisify(execFile),drivers=[];
export async function installBusinessDriver({candidate,root,apiRoot,origin,session,page,answerPage,businessDirectory}){
  await mkdir(root,{recursive:true,mode:0o700});let entry,peerConfig,manager;
  if(process.env.GENEWAY_PROTOCOL_RECOVERY_CASE==='task-service'||process.env.GENEWAY_PROTOCOL_CANCEL==='1'){manager=await startBusinessProcess({candidate,root,apiRoot,origin,session,allowCancel:process.env.GENEWAY_PROTOCOL_CANCEL==='1'});entry=manager;peerConfig=manager.peerConfig;}
  else if(candidate==='a2a'){
    const principal='independent-a2a-owner',tasks=await createBusinessTasks({root:path.join(root,'mapping'),apiRoot,origin,session,principal});
    entry=await startBusinessA2a({root:path.join(root,'a2a'),tasks,principal});peerConfig={origin:entry.origin,tokenFile:entry.tokenFile,caFile:entry.caFile};
  }else{
    const relay=await currentRelay(),context=relay.getAnpContext();entry=await startBusinessAnp({root:path.join(root,'anp'),apiRoot,origin,session,...context});peerConfig={peerConfigPath:entry.peerConfigPath,handle:entry.handle,groupDid:entry.groupDid,homeDid:entry.homeDid};
  }
  const peerOutputs=[];async function oracleInput(){const base=process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT;await writeFile(path.join(base,'business-oracle-input.json'),JSON.stringify({candidate,businessRoot:path.relative(base,businessDirectory),mappingRoot:path.relative(base,path.join(root,candidate==='a2a'?'mapping':'anp/mapping')),entryRoot:path.relative(base,root),peerOutputs,downloadFile:path.relative(base,path.join(root,'peer-download.xlsx')),relayRoot:'relay'},null,2));}
  const peerEntry=fileURLToPath(new URL('../peers/'+candidate+'/business-client.mjs',import.meta.url));let task,sequence=0,createCount=0,inputCount=0;
  async function call(operation,parameters,label,{timeoutMs,expectFailure=false}={}){
    const clientRequestId=parameters?.clientRequestId??randomUUID(),outputFile=path.join(root,'peer-'+label+'.json'),configFile=path.join(root,'peer-'+label+'-config.json'),config={...peerConfig,...(timeoutMs?{timeoutMs}:{}),operation,clientRequestId,parameters,taskId:task?.id,contextId:task?.contextId,outputFile,...(operation==='download'?{downloadFile:path.join(root,'peer-download.xlsx')}:{})};
    await writeFile(configFile,JSON.stringify(config,null,2),{mode:0o600});
    const running=execute(process.execPath,[peerEntry,'--config',configFile],{maxBuffer:8*1024*1024,timeout:expectFailure?15000:90000});let identity;try{identity=await processIdentity(running.child.pid);}catch(error){identity={pid:running.child.pid,unavailableReason:error.code};}
    try{const result=await running;await writeFile(path.join(root,'peer-'+label+'-stdout.log'),result.stdout);await writeFile(path.join(root,'peer-'+label+'-stderr.log'),result.stderr);}catch(error){await writeFile(path.join(root,'peer-'+label+'-stderr.log'),String(error.stderr??error.stack));if(expectFailure){let output=null;try{output=JSON.parse(await readFile(outputFile));}catch{}return{error:{message:error.message,code:error.code,stderr:error.stderr},output,exitCode:running.child.exitCode};}throw error;}if(expectFailure)throw Error('Offline query unexpectedly succeeded');
    const result=JSON.parse(await readFile(outputFile));assert(result.task?.id,'Actual independent peer must return a business Task');if(task)assert.equal(result.task.id,task.id);task=result.task;peerOutputs.push({operation,label,configFile:path.relative(process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT,configFile),outputFile:path.relative(process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT,outputFile)});await oracleInput();
    await appendFile(path.join(root,'driver-events.jsonl'),JSON.stringify({id:++sequence,at:new Date().toISOString(),operation,label,principal:peerConfig.homeDid??'independent-a2a-owner',taskId:task.id,contextId:task.contextId,workId:task.metadata.geneway.workId,peerProcess:identity,exitCode:running.child.exitCode,configFile,outputFile})+'\n');return result;
  }
  async function routeHandler(route){
    const request=route.request();if(request.method()!=='POST')return route.continue();
    const url=new URL(request.url()),parameters=request.postDataJSON();
    try{
      const creating=url.pathname==='/api/works';assert(creating?!task:!!task,'The peer must first create, never claim a browser-created Work');
      const result=await call(creating?'create':'input',parameters,creating?'create':'input-'+ ++inputCount);if(creating)createCount++;
      const receipt=result.task.metadata.geneway.businessReceipt;assert(receipt,'Only the original production API reply may complete the browser request');
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(receipt)});
    }catch(error){await appendFile(path.join(root,'driver-errors.jsonl'),JSON.stringify({at:new Date().toISOString(),message:error.message,stack:error.stack,path:url.pathname})+'\n');await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'PROTOCOL_BUSINESS_UNAVAILABLE',message:error.message}})});}
  }
  for(const current of[page,answerPage]){await current.route('**/api/works',routeHandler);await current.route('**/api/works/*/multisite/inputs',routeHandler);if(process.env.GENEWAY_PROTOCOL_CANCEL==='1')await current.route('**/api/works/*/multisite/cancel',()=>{throw Error('Cancellation must originate at the independent protocol peer');});}
  await oracleInput();
  const driver={
    async cancelBusy({heldWorker,parents,releaseGet}){return cancelBusyBusiness({root,apiRoot,businessDirectory,task,parents,heldWorker,call,releaseGet});},
    async observe(phase){
      assert(task);if(phase==='stopped'){const config=JSON.parse(await readFile(path.join(businessDirectory,'parents.json')));await collectCancelSessions(businessDirectory,config.parents);const base=process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT;await writeFile(path.join(base,'cancel-oracle-input.json'),JSON.stringify({candidate,businessRoot:path.relative(base,businessDirectory),entryRoot:path.relative(base,root),businessNavigation:'business-oracle-input.json',cancelBefore:'business-entry/cancel/before.json',cancelBarrier:'business-entry/cancel/barrier.json',cancelStopping:'business-entry/cancel/stopping.json',cancelFinal:'business-entry/cancel/final.json',cancelResult:'business-entry/cancel-result.json',recoveryResult:'business-entry/recovery-process-result.json'},null,2));return;}if(phase==='question-open'){
        const result=await call('get',undefined,'question');const questionState=JSON.parse(await readFile(path.join(businessDirectory,'question-state.json'))),question=questionState.works.find(work=>work.id===task.metadata.geneway.workId).pendingQuestion;
        assert.equal(candidate==='a2a'?result.task.status.state:result.task.state,candidate==='a2a'?6:'input-required');assert.equal(result.task.metadata.geneway.question.id,question.id);if(manager)await recoverWaitingBusiness({manager,root,apiRoot,businessDirectory,task,query:(label,options)=>call('get',undefined,label,options)});return;
      }
      const result=await call('get',undefined,'completed');assert.equal(candidate==='a2a'?result.task.status.state:result.task.state,candidate==='a2a'?3:'completed');
      const downloaded=await call('download',undefined,'download'),peerBytes=await readFile(path.join(root,'peer-download.xlsx')),browserBytes=await readFile(path.join(businessDirectory,'下载多来源整改表.xlsx'));assert.deepEqual(peerBytes,browserBytes);
      const state=JSON.parse(await readFile(path.join(businessDirectory,'completed-state.json'))),work=state.works.find(row=>row.id===task.metadata.geneway.workId),artifact=state.artifacts.find(row=>row.workId===work.id&&row.status==='ready');assert.equal(createHash('sha256').update(peerBytes).digest('hex'),artifact.sha256);assert.equal(createCount,1);assert.equal(inputCount,2);assert.equal(state.works.length,1);
      await writeFile(path.join(root,'driver-result.json'),JSON.stringify({result:'passed',candidate,taskId:task.id,contextId:task.contextId,workId:work.id,createCount,inputCount,questionObserved:true,taskCompletedOnlyAfterOriginalReady:true,independentPeerDownloadedBytes:peerBytes.length,sha256:artifact.sha256,download:downloaded.download,originalWorkCount:state.works.length,boundary:'Actual independent authorized protocol peer first creates Work, same Task input and active query; original production authority/native D4/file oracle retained. Not full T03a conformance/recovery or T03b.'},null,2));
    },async close(){await entry.close();},
  };drivers.push(driver);return driver;
}
export async function closeBusinessDrivers(){for(const driver of drivers.reverse())await driver.close();}
