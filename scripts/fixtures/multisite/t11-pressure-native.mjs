import assert from 'node:assert/strict'
import { createServer,request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { fork,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir,readFile,writeFile,appendFile,readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridgeService } from './bridge-service.mjs'
import { seedDelegation } from './delegation.mjs'
import { processIdentity,stopOwned } from './supervision-process-lifecycle.mjs'
import { HOST_INBOX_LIMITS,hostInboxPressure } from '../../../packages/agent-host/host.mjs'
import { binding,digest,key } from '../../../packages/agent-contracts/index.mjs'
import { messageId } from '../../../packages/agent-host/delivery.mjs'
import { commandModelObservation } from './t11-pressure-model.mjs'

export async function runNativePressure({directory,save,mode,resumeRoot}){
  const dataDirectory=resumeRoot??directory,root=join(dataDirectory,'remote'),captures=[],traffic=[],events=[],children=[],facts=[],errors=[],wire=[]
  const gates={offers:false,control:false,stopped:false,ackId:null},heldFrames=[],heldEvents=[],streams=new Set(),writes=[]
  let fixture,provider,proxy,remote,session,workB,workA,requestNumber=0
  const descendants=new Map();let existingPorts,baselineModelRequests=[],resumedPressure
  const mark=(kind,value={})=>events.push({kind,at:new Date().toISOString(),...value})
  const stage=async name=>{await save('events.json',events);console.log(JSON.stringify({stage:name,mode,directory,pid:process.pid}))}
  const local=async()=>JSON.parse(await readFile(join(root,'host-journal.json'),'utf8'))
  async function progress(){const state=await local();return JSON.stringify({ingested:state.inbox.filter(row=>row.status==='ingested').length,executions:state.executions.map(row=>({attemptId:row.attempt_id,status:row.status,observed:row.observed_revision}))})}
  async function until(predicate,label,stallMs=120000,observeProgress){
    let deadline=Date.now()+stallMs,lastProgress
    for(;;){const result=await predicate();if(result)return result
      if(observeProgress){const current=await observeProgress();if(current!==lastProgress){lastProgress=current;deadline=Date.now()+stallMs}}
      assert(Date.now()<deadline,label+' made no observed progress before its stall deadline')
      await new Promise(done=>setTimeout(done,1000))
    }
  }
  async function user(path,body){const response=await fetch(fixture.origin+path,{method:'POST',headers:{origin:fixture.origin,cookie:session.cookie,'x-csrf-token':session.csrfToken,'content-type':'application/json'},body:JSON.stringify(body)}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value}
  const releaseFrames=()=>{for(const item of heldFrames.splice(0))if(!item.response.destroyed)item.response.write(item.frame)}
  const releaseEvents=()=>{for(const item of heldEvents.splice(0))item.forward()}
  function forward(request,response,body){
    const path=request.url,isStream=request.method==='GET'&&path==='/internal/bridge/events'
    const upstream=httpRequest(new URL(path,fixture.origin),{method:request.method,headers:{...request.headers,host:new URL(fixture.origin).host}},incoming=>{
      if(isStream){
        response.writeHead(incoming.statusCode,incoming.headers);response.flushHeaders();streams.add(response);incoming.setEncoding('utf8');let pending=''
        incoming.on('data',text=>{pending+=text;for(;;){const end=pending.indexOf('\n\n');if(end<0)break;const frame=pending.slice(0,end+2);pending=pending.slice(end+2);const raw=frame.split('\n').find(line=>line.startsWith('data: '));let command;try{command=raw?JSON.parse(raw.slice(6)):null}catch{}
          wire.push({at:new Date().toISOString(),frame});writes.push(appendFile(join(directory,'sse-wire.jsonl'),JSON.stringify(wire.at(-1))+'\n'))
          const held=gates.offers||gates.control&&command?.operation==='cancel'&&command.work_id===workB?.id
          if(held){heldFrames.push({response,frame,command});mark('offer-held',{commandId:command?.command_id,operation:command?.operation})}else response.write(frame)
        }})
        incoming.once('end',()=>response.end());incoming.once('error',()=>response.destroy())
      }else{
        const chunks=[];incoming.on('data',bytes=>chunks.push(bytes));incoming.once('end',()=>{
          const bytes=Buffer.concat(chunks);let reply;try{reply=JSON.parse(bytes)}catch{}
          const row={at:new Date().toISOString(),path,method:request.method,status:incoming.statusCode,...(path==='/internal/bridge/acks'?{reply}:{}),...(path==='/internal/bridge/resync'?{pendingIds:reply?.pending?.map(row=>row.command_id??row.commandId)}:{})};traffic.push(row)
          response.writeHead(incoming.statusCode,incoming.headers);response.end(bytes)
        });incoming.once('error',()=>response.destroy())
      }
      response.once('close',()=>{streams.delete(response);incoming.destroy();upstream.destroy()})
    })
    upstream.once('error',cause=>{mark('upstream-error',{path,code:cause.code});response.destroy()});response.once('close',()=>upstream.destroy());upstream.end(body)
  }
  async function launch(){
    const child=fork(fileURLToPath(new URL('./t11-pressure-host.mjs',import.meta.url)),[],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:root,DSH_TELEMETRY_MODE:'DISABLED'},execArgv:[],stdio:['ignore','pipe','pipe','ipc']}),item={child,name:'remote-'+(children.length+1),messages:[]}
    item.exited=new Promise(done=>child.once('exit',(code,signal)=>{facts.push({kind:'exit',name:item.name,pid:child.pid,code,signal});done()}));item.closed=new Promise(done=>child.once('close',done));children.push(item)
    child.on('message',value=>{item.messages.push(value);if(value.kind==='host-error')errors.push({pid:child.pid,...value});if(value.kind==='temp-write-enospc')mark('temp-write-enospc',value)})
    for(const stream of ['stdout','stderr'])child[stream].on('data',bytes=>writes.push(appendFile(join(directory,item.name+'.'+stream+'.log'),bytes)))
    item.identity=await processIdentity(child.pid);assert(item.identity);facts.push({kind:'start',name:item.name,...item.identity,argv:(await readFile(`/proc/${child.pid}/cmdline`,'utf8')).split('\0').filter(Boolean)})
    child.send({kind:'start',profile:join(root,'profile.json')})
    item.ready=await until(()=>{assert(child.exitCode===null&&child.signalCode===null,'Host exited before ready');assert(!item.messages.some(row=>row.kind==='host-start-error'),'Host startup failed');return item.messages.find(row=>row.kind==='ready')},'native Host ready',45000)
    await save('processes.json',facts);return item
  }
  async function closeHost(item){
    if(!item)return
    async function visit(pid){let pids;try{pids=(await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number)}catch(cause){if(['ENOENT','ESRCH'].includes(cause.code))return;throw cause}for(const pid of pids){const identity=await processIdentity(pid);if(!identity)continue;descendants.set(pid+':'+identity.startTicks,identity);await visit(pid)}}
    await visit(item.child.pid);let grace
    try{await Promise.race([stopOwned(item,facts),new Promise((_,reject)=>{grace=setTimeout(()=>reject(Error('Owned Host TERM grace expired')),15000)})])}
    catch(cause){const current=await processIdentity(item.child.pid);assert(current&&current.startTicks===item.identity.startTicks,'Cleanup PID identity changed');facts.push({kind:'signal',name:item.name,...current,signal:'SIGKILL',at:new Date().toISOString(),reason:cause.message+'; active pump is not a confirmed stop receipt'});item.child.kill('SIGKILL');await item.exited}
    finally{clearTimeout(grace)}
    await item.closed;const identity=await processIdentity(item.child.pid);facts.push({kind:'final-os',name:item.name,original:item.identity,identity});assert(!identity||identity.startTicks!==item.identity.startTicks)
  }
  async function fault(item,commandId){const requestId=String(++requestNumber);item.child.send({kind:'fault',requestId,mode:'enospc',commandId});await until(()=>item.messages.some(row=>row.kind==='fault-configured'&&row.requestId===requestId),'fault configured')}
  const commandForInput=async(workId,clientRequestId)=>{const state=await fixture.store.read(),input=state.multisite.inputs.find(row=>row.workId===workId&&row.id===key('input',workId,'owner',clientRequestId));assert(input);return state.multisite.outbox.find(row=>row.command.work_id===workId&&row.command.input_id===input.id&&row.command.operation==='deliver')?.command}
  async function settleModels(command,phase){
    return until(async()=>{
      const state=await fixture.store.read(),expectedId=messageId(command.input_id,command.attempt_id,command.session_id??`geneway-${command.launch_id}`),rows=state.modelRequests.filter(row=>row.work_id===command.work_id&&row.inputMessageId===expectedId&&row.instructionRevision===command.instruction_revision)
      if(!rows.length||!rows.every(row=>row.outcome==='completed'))return false
      const observed=commandModelObservation({command,models:state.modelRequests,providerBodies:captures,sessions:await sessions()})
      if(!observed)return false
      await save(phase+'-model-observation.json',observed);return observed
    },'exact '+phase+' Input model/provider/SDK output settled',120000,progress)
  }
  async function sessions(){const found=[];async function visit(path){for(const entry of await readdir(path,{withFileTypes:true})){const next=join(path,entry.name);if(entry.isDirectory())await visit(next);else if(entry.name==='session.v4.jsonl.zstd')found.push(next)}}await visit(join(root,'multisite-executions'));const result=[];for(const path of found){const {stdout}=await promisify(execFile)('zstd',['-dc','--',path],{encoding:'buffer',maxBuffer:128*1024*1024});result.push({path,events:stdout.toString().trim().split('\n').map(JSON.parse)})}return result}
  const countInput=(frames,command)=>{const id=messageId(command.input_id,command.attempt_id,command.session_id??`geneway-${command.launch_id}`);return frames.flatMap(row=>row.events).filter(row=>row.type==='user/message'&&row.data.id===id).length}
  async function continueRecovery(target,identity,pressure){
  await until(async()=>{const state=await fixture.store.read(),journal=await local();return state.multisite.outbox.find(row=>row.id===target.command_id).acceptedAt&&journal.inbox.some(row=>row.command.command_id===target.command_id)},'original rejected target durably admitted with exact ACK after same-root reopen',120000,progress)
  await save('uncommitted-target-admitted.json',{target,dataRoot:dataDirectory,cloud:await fixture.store.read(),journal:await local(),boundary:'exact original rejected ID/digest admitted and ACKed; SDK consumption is a separate next check'})
  await until(async()=>{const state=await fixture.store.read(),journal=await local();return state.multisite.outbox.find(row=>row.id===target.command_id).acceptedAt&&journal.inbox.some(row=>row.command.command_id===target.command_id&&row.status==='ingested')},'original rejected target admitted and ingested after same-root reopen',120000,progress)
  await settleModels(target,'target');const recovered=await local();assert.equal(recovered.inbox.filter(row=>row.command.command_id===target.command_id).length,1);assert.deepEqual(recovered.inbox.find(row=>row.command.command_id===target.command_id).command,target);assert.equal((await fixture.store.read()).works.find(row=>row.id===workB.id).status,'cancelled')
  await save('pressure-target-recovered.json',{target,local:recovered,cloud:await fixture.store.read()})
  const aAttempt=(await fixture.store.read()).multisite.attempts.find(row=>row.work_id===workA.id),anchorId='committed-input-lost-ack',anchorInputId=key('input',workA.id,'owner',anchorId)
  gates.ackId=key('deliver',aAttempt.attempt_id,anchorInputId)
  await user(`/api/works/${workA.id}/multisite/inputs`,{clientRequestId:anchorId,text:'M2_ACK_ANCHOR 原命令只消费一次，传输ACK被测试proxy挡在云之前。'})
  const anchor=await commandForInput(workA.id,anchorId);assert.equal(anchor.command_id,gates.ackId)
  await until(async()=>{const state=await fixture.store.read();return events.some(row=>row.kind==='ACK-held-before-cloud'&&row.commandId===anchor.command_id)&&state.multisite.inputs.find(row=>row.id===anchor.input_id).deliveries.every(row=>row.ingestedAt)},'Host committed and actual input consumed while ACK not sent to cloud')
  await settleModels(anchor,'anchor');const beforeReplay=await fixture.store.read(),localBeforeReplay=await local(),framesBefore=await sessions();assert.equal(beforeReplay.multisite.outbox.find(row=>row.id===anchor.command_id).acceptedAt,null);assert.equal(countInput(framesBefore,anchor),1)
  await save('committed-ack-not-cloud.json',{anchor,local:localBeforeReplay,cloud:beforeReplay,boundary:'Host committed and consumed; proxy refuses ACK before cloud. Cloud acceptedAt remains null; not cloud committed/lost reply'})
  await closeHost(remote);gates.ackId=null;remote=await launch();assert.deepEqual(JSON.parse(await readFile(join(root,'node-identity.json'),'utf8')),identity)
  await until(async()=>{const state=await fixture.store.read();return state.multisite.outbox.find(row=>row.id===anchor.command_id).acceptedAt&&state.multisite.attempts.find(row=>row.work_id===workA.id).status==='unknown'},'exact ACK replay and explicit retained recovery unknown')
  const afterReplay=await fixture.store.read(),localAfterReplay=await local(),framesAfter=await sessions();assert.equal(localAfterReplay.inbox.filter(row=>row.command.command_id===anchor.command_id).length,1);assert.equal(countInput(framesAfter,anchor),1);assert.equal(countInput(framesAfter,target),1);assert.deepEqual(afterReplay.modelRequests,beforeReplay.modelRequests);assert.equal(captures.length,beforeReplay.modelRequests.length-baselineModelRequests.length);assert.equal(afterReplay.works.find(row=>row.id===workB.id).status,'cancelled')
  await save('exact-committed-replay.json',{anchor,target,local:localAfterReplay,cloud:afterReplay,sessions:framesAfter,previousNodeIdentity:{nodeId:identity.nodeId,nodeInstanceId:identity.nodeInstanceId},boundary:'same root/identity; exact original committed command ACKed without new acceptance/model/input, unconfirmed active A remains unknown; old stopped B never revived'})
  await save('sessions.json',framesAfter);await user(`/api/works/${workA.id}/multisite/cancel`,{clientRequestId:'pressure-final-A-cancel'});await until(async()=>(await fixture.store.read()).works.find(row=>row.id===workA.id).status==='cancelled','original unknown A stop calibrated')
  await save('result.json',{result:'passed',mode,directory,dataRoot:dataDirectory,continuationOnly:!!resumeRoot,reusedPressureAndCancelEvidence:resumeRoot??null,pressure,uncommittedTarget:target.command_id,committedLostAckTarget:anchor.command_id,sameNodeIdentity:true,actualLiveBCancelThroughOrdinaryPressure:true,beforeStopNonterminal:true,originalTargetConsumedOnceAfterReopen:true,committedReplayNoNewModelOrInput:true,originalBRemainsStopped:true,retainedUnknown:true,boundary:'single real API/remote Host with maxActiveLoops1 and native DSH; production 16MiB byte gate, synthetic provider blocked only for B; ACK held before cloud, two explicit same-root reopens, no production test config'})
  }
  try{
    await mkdir(root,{recursive:true})
    if(resumeRoot){
      existingPorts=JSON.parse(await readFile(join(resumeRoot,'ports.json'),'utf8'));resumedPressure=JSON.parse(await readFile(join(resumeRoot,'pressure-refused.json'),'utf8'))
      const previous=JSON.parse(await readFile(join(resumeRoot,'cancel-before-host.json'),'utf8')),cloud=JSON.parse(await readFile(join(resumeRoot,'api/state.json'),'utf8')),journal=await local(),profile=JSON.parse(await readFile(join(root,'profile.json'),'utf8'))
      workA=cloud.works.find(row=>row.id===resumedPressure.target.work_id);const cancel=previous.held.find(row=>row.operation==='cancel');workB=cloud.works.find(row=>row.id===cancel?.work_id)
      assert(workA&&workB);assert.equal(workB.status,'cancelled');assert.deepEqual(cloud.multisite.outbox.find(row=>row.id===resumedPressure.target.command_id).command,resumedPressure.target);assert.equal(cloud.multisite.outbox.find(row=>row.id===resumedPressure.target.command_id).acceptedAt,null);assert(!journal.inbox.some(row=>row.command.command_id===resumedPressure.target.command_id));assert.equal(profile.root,root);assert.equal(profile.origin,`http://127.0.0.1:${existingPorts.proxyPort}`)
      await readFile(join(resumeRoot,'api/auth.json'));await readFile(join(resumeRoot,'api/secrets/key'));baselineModelRequests=cloud.modelRequests
      const pressure=hostInboxPressure(journal.inbox),candidateBytes=Buffer.byteLength(JSON.stringify({command:resumedPressure.target,status:'accepted',acceptedAt:new Date().toISOString()}));assert(pressure.ordinary.remainingCount>=1&&pressure.ordinary.remainingBytes>=candidateBytes)
      await save('resume-start.json',{dataRoot:resumeRoot,originalTarget:resumedPressure.target,cloud,journal,pressure,candidateBytes,workA:workA.id,workB:workB.id,boundary:'original real data root and original IDs; no seed, state copy, pressure replay or cancellation replay; original B unknown ledger preserved'})
    }
    provider=createServer(async(request,response)=>{
      const chunks=[];for await(const bytes of request)chunks.push(bytes);const body=JSON.parse(Buffer.concat(chunks)),isB=JSON.stringify(body).includes('M2_PRESSURE_B')
      captures.push({at:new Date().toISOString(),isB,body});await save('provider-bodies.json',captures)
      response.writeHead(200,{'content-type':'text/event-stream'});response.flushHeaders()
      if(mode==='pressure'&&isB){mark('B-model-blocked',{request:captures.length});response.once('close',()=>mark('B-provider-response-closed'));return}
      response.end('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'本次有界输入已消费，不发布结果，不执行外部动作。'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
    });await new Promise(done=>provider.listen(existingPorts?.providerPort??0,'127.0.0.1',done))
    fixture=await startBridgeService({directory:join(dataDirectory,'api'),listenPort:existingPorts?.apiPort,upstreamBaseUrl:`http://127.0.0.1:${provider.address().port}/v1`,seedState:state=>{assert(!resumeRoot,'Continuation must never seed an existing state');seedDelegation(state);for(const employee of state.employees){employee.placement.nodeId='pressure-node';employee.placement.resourceRefs=[];if(['desktop-office','desktop-data'].includes(employee.id))employee.multisitePolicy.delegation.resourceRefs=[];if(employee.id==='desktop-data')employee.multisitePolicy.execution.resourceRefs=[]}return state}})
    if(!resumeRoot){await mkdir(join(dataDirectory,'api/secrets'),{recursive:true});await writeFile(join(dataDirectory,'api/secrets/key'),'synthetic-pressure-provider',{mode:0o600})}
    proxy=createServer(async(request,response)=>{
      const chunks=[];for await(const bytes of request)chunks.push(bytes);const body=Buffer.concat(chunks),parsed=body.length?JSON.parse(body):null,path=request.url
      const logged=path==='/internal/bridge/acks'||path==='/internal/bridge/events'&&request.method==='POST'
      traffic.push({at:new Date().toISOString(),path,method:request.method,stage:'incoming',...(logged?{request:parsed}:{})})
      if(path==='/internal/bridge/acks'&&parsed.commandId===gates.ackId){mark('ACK-held-before-cloud',{commandId:parsed.commandId,payloadDigest:parsed.payloadDigest});response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'T11_ACK_WITHHELD'}}));return}
      if(path==='/internal/bridge/events'&&request.method==='POST'&&parsed.event.kind==='stopped'&&parsed.event.work_id===workB?.id&&gates.stopped){heldEvents.push({forward:()=>forward(request,response,body),response,event:parsed.event});mark('B-stopped-receipt-held-before-cloud',{eventId:parsed.event.event_id});return}
      forward(request,response,body)
    });await new Promise(done=>proxy.listen(existingPorts?.proxyPort??0,'127.0.0.1',done))
    const login=await fetch(fixture.origin+'/api/session',{method:'POST',headers:{origin:fixture.origin,'content-type':'application/json'},body:JSON.stringify({loginName:'owner',password:'synthetic owner password'})});session={...await login.json(),cookie:login.headers.get('set-cookie').split(';')[0]}
    if(!resumeRoot){
    const pairing=await user('/api/admin/nodes/pairings',{clientRequestId:'pressure-pair',nodeId:'pressure-node',siteId:'site',platform:'linux',runtimeMode:'agent_node',allowedAgentIds:['desktop-office','desktop-data'],expiresAt:new Date(Date.now()+120000).toISOString()})
    await writeFile(join(root,'profile.json'),JSON.stringify({root,origin:`http://127.0.0.1:${proxy.address().port}`,pairing,maxActiveLoops:1,officeEnabled:false,transport:'internal'}),{mode:0o600})
    }
    await save('ports.json',{apiPort:Number(new URL(fixture.origin).port),proxyPort:proxy.address().port,providerPort:provider.address().port})
    const identityBefore=resumeRoot?JSON.parse(await readFile(join(root,'node-identity.json'),'utf8')):null
    remote=await launch();const identity=JSON.parse(await readFile(join(root,'node-identity.json'),'utf8'));if(identityBefore)assert.deepEqual(identity,identityBefore);await stage('native-ready')
    if(resumeRoot){await continueRecovery(resumedPressure.target,identity,resumedPressure.pressure)}
    else if(mode==='enospc'){
      gates.offers=true
      workB=await user('/api/works',{workType:'multisite',employeeId:'desktop-office',goal:'M2_ENOSPC_ORIGINAL_REAL_INPUT',clientRequestId:'enospc-work',attachmentRefs:[]})
      await user(`/api/works/${workB.id}/multisite/inputs`,{clientRequestId:'enospc-second',text:'同页后续合法输入不得越过未确认存储。'})
      const before=await fixture.store.read(),original=before.multisite.outbox.find(row=>row.command.work_id===workB.id&&row.command.operation==='launch').command,next=await commandForInput(workB.id,'enospc-second')
      await fault(remote,original.command_id);gates.offers=false;releaseFrames()
      await until(()=>remote.messages.some(row=>row.kind==='temp-write-enospc'),'real Journal temp write ENOSPC')
      await until(()=>traffic.some(row=>row.path==='/internal/bridge/resync'&&row.pendingIds?.includes(original.command_id)),'failed storage resync observed')
      const failed=await local(),cloud=await fixture.store.read();assert.equal(failed.inbox.length,0);assert.equal(failed.executions.length,0);assert.equal(failed.jobs.length,0);assert.equal(failed.outbox.length,0);assert.equal(captures.length,0)
      assert(!traffic.some(row=>row.stage==='incoming'&&row.path==='/internal/bridge/acks'&&[original.command_id,next.command_id].includes(row.request.commandId)));assert.equal(cloud.multisite.outbox.find(row=>row.id===original.command_id).acceptedAt,null)
      await save('enospc-uncommitted.json',{original,next,local:failed,cloud,events,traffic,boundary:'actual Journal temp write constructor injection; real disk contents unchanged, no physical full disk'})
      await closeHost(remote);remote=await launch();assert.deepEqual(JSON.parse(await readFile(join(root,'node-identity.json'),'utf8')),identity)
      await until(async()=>{const state=await fixture.store.read();return state.multisite.inputs.filter(row=>row.workId===workB.id).every(row=>row.deliveries.every(item=>item.ingestedAt))},'same original inputs ingested after reopen')
      await settleModels(next,'enospc-latest');const recovered=await local();assert.equal(recovered.inbox.filter(row=>row.command.command_id===original.command_id).length,1);assert.deepEqual(recovered.inbox.find(row=>row.command.command_id===original.command_id).command,original)
      const frames=await sessions();assert.equal(countInput(frames,original),1);assert.equal(countInput(frames,next),1);await save('sessions.json',frames)
      await user(`/api/works/${workB.id}/multisite/cancel`,{clientRequestId:'enospc-final-cancel'});await until(async()=>(await fixture.store.read()).works.find(row=>row.id===workB.id).status==='cancelled','recovered native real cancellation')
      await save('result.json',{result:'passed',mode,directory,originalCommand:original.command_id,payloadDigest:original.payload_digest,binding:binding(original),sameNodeIdentity:true,uncommittedTargetAndNextZeroAckExecute:true,originalInputConsumedOnceAfterSameRootReopen:true,boundary:'single real API/remote Host/native DSH with test-only ENOSPC at temp write; no physical full disk, no latch reset'})
    }else{
      workB=await user('/api/works',{workType:'multisite',employeeId:'desktop-office',goal:'M2_PRESSURE_B 保持实际模型请求以占用唯一slot',clientRequestId:'pressure-B',attachmentRefs:[]})
      await until(()=>events.some(row=>row.kind==='B-model-blocked'),'actual live B model request')
      workA=await user('/api/works',{workType:'multisite',employeeId:'desktop-data',goal:'M2_PRESSURE_A'+ '资'.repeat(16000-'M2_PRESSURE_A'.length),clientRequestId:'pressure-A',attachmentRefs:[]})
      let target,capacityFailure,beforeRejected
      for(let index=0;!target;index++){
        assert(index<HOST_INBOX_LIMITS.ordinaryCount,'Expected the production byte boundary before ordinary count')
        const clientRequestId='pressure-input-'+index;beforeRejected=await local()
        await user(`/api/works/${workA.id}/multisite/inputs`,{clientRequestId,text:'压'.repeat(16000)})
        const command=await commandForInput(workA.id,clientRequestId);assert(Buffer.byteLength(JSON.stringify(command))<HOST_INBOX_LIMITS.commandBytes)
        await until(async()=>{capacityFailure=remote.messages.find(row=>row.kind==='host-error'&&row.commandId===command.command_id&&row.code==='CAPACITY_EXCEEDED');return capacityFailure||(await local()).inbox.some(row=>row.command.command_id===command.command_id)},'real pending command accepted or bounded refusal')
        if(capacityFailure){target=command;break}
        if(index%25===0)await stage('fill-'+index)
      }
      assert.equal(capacityFailure.capacity.reason,'pending_bytes');const full=await local(),cloudFull=await fixture.store.read(),pressure=hostInboxPressure(full.inbox)
      assert(pressure.ordinary.count<HOST_INBOX_LIMITS.ordinaryCount);assert(pressure.ordinary.bytes+Buffer.byteLength(JSON.stringify({command:target,status:'accepted',acceptedAt:new Date().toISOString()}))>HOST_INBOX_LIMITS.ordinaryBytes)
      assert(!full.inbox.some(row=>row.command.command_id===target.command_id));assert.deepEqual(full.executions,beforeRejected.executions);assert.deepEqual(full.jobs,beforeRejected.jobs);assert(!traffic.some(row=>row.stage==='incoming'&&row.path==='/internal/bridge/acks'&&row.request.commandId===target.command_id));assert.equal(cloudFull.multisite.outbox.find(row=>row.id===target.command_id).acceptedAt,null);assert.equal(captures.length,1)
      await save('pressure-refused.json',{target,capacityFailure,pressure,local:full,cloud:cloudFull,boundary:'production 16MiB pending serialized rows, previously active B model side effect retained; target Input has no local acceptance/ACK/execute'})
      gates.control=true;gates.stopped=true;await user(`/api/works/${workB.id}/multisite/cancel`,{clientRequestId:'pressure-live-B-cancel'})
      await until(()=>heldFrames.some(row=>row.command?.operation==='cancel'&&row.command.work_id===workB.id),'real B cancel held before Host')
      const notStopped=await local(),beforeStopCloud=await fixture.store.read();assert.equal(beforeStopCloud.works.find(row=>row.id===workB.id).status,'stopping');assert(notStopped.executions.some(row=>row.work_id===workB.id&&row.runtimeStarted&&row.slotHeld&&row.status==='running'))
      await save('cancel-before-host.json',{local:notStopped,cloud:beforeStopCloud,held:heldFrames.filter(row=>row.command?.work_id===workB.id).map(row=>row.command)})
      gates.control=false;releaseFrames();await until(()=>heldEvents.length>0,'actual stopped receipt produced')
      const stoppedLocal=await local();assert(stoppedLocal.executions.some(row=>row.work_id===workB.id&&row.status==='stopped'&&row.slotHeld===false));assert.equal((await fixture.store.read()).works.find(row=>row.id===workB.id).status,'stopping')
      await save('cancel-actual-stop-unconfirmed.json',{local:stoppedLocal,cloud:await fixture.store.read(),heldStoppedEvents:heldEvents.map(row=>row.event)})
      gates.stopped=false;releaseEvents();await until(async()=>(await fixture.store.read()).works.find(row=>row.id===workB.id).status==='cancelled','B confirmed stopped')
      const candidateBytes=Buffer.byteLength(JSON.stringify({command:target,status:'accepted',acceptedAt:new Date().toISOString()}))
      await until(async()=>{const value=hostInboxPressure((await local()).inbox);return value.ordinary.remainingCount>=1&&value.ordinary.remainingBytes>=candidateBytes},'original target has actual count and byte headroom',120000,progress)
      await closeHost(remote);remote=await launch();assert.deepEqual(JSON.parse(await readFile(join(root,'node-identity.json'),'utf8')),identity)
      await continueRecovery(target,identity,pressure)
    }
    await save('terminal-cloud.json',await fixture.store.read());await save('terminal-host.json',await local());await stage('passed')
  }catch(cause){await save('native-failure.json',{name:cause.name,message:cause.message,code:cause.code,stack:cause.stack,errors});if(fixture)await save('failed-cloud.json',await fixture.store.read()).catch(()=>{});await save('failed-host.json',await local()).catch(()=>{});throw cause}
  finally{
    gates.offers=false;gates.control=false;gates.stopped=false;gates.ackId=null;releaseFrames();releaseEvents()
    const cleanupErrors=[];for(const item of [...children].reverse())try{await closeHost(item)}catch(cause){cleanupErrors.push({name:item.name,message:cause.message})}
    for(const response of streams)response.destroy();for(const held of heldEvents)held.response.destroy()
    await fixture?.close();for(const server of [proxy,provider])if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}
    await Promise.all(writes);await save('provider-bodies.json',captures);await save('traffic.json',traffic);await save('events.json',events);await save('errors.json',errors);await save('processes.json',facts)
    const ports=await readFile(join(directory,'ports.json'),'utf8').then(JSON.parse).catch(()=>({})),closedPorts=[]
    for(const [name,port]of Object.entries(ports)){const closed=await new Promise(done=>{const socket=connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();done(false)});socket.once('error',()=>done(true))});closedPorts.push({name,port,closed});if(!closed)cleanupErrors.push({name,message:'Port remains listening'})}
    const descendantFinal=[];for(const original of descendants.values()){const identity=await processIdentity(original.pid),sameOriginalLive=!!identity&&identity.startTicks===original.startTicks&&identity.state!=='Z';descendantFinal.push({original,identity,sameOriginalLive});if(sameOriginalLive)cleanupErrors.push({name:'native-descendant',pid:original.pid,message:'Original descendant still live'})}
    await save('native-processes.json',descendantFinal)
    await save('close.json',{cleanupErrors,closedPorts,topLevelPid:process.pid});assert.equal(cleanupErrors.length,0,'Native cleanup failed')
  }
}
