import { readFile,writeFile,mkdir,open,rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRemoteClient } from '../../../packages/agent-host/remote-client.mjs'
import { createAgentHost } from '../../../packages/agent-host/host.mjs'
import { createHostJournal } from '../../../packages/agent-host/journal.mjs'
import { readHostIdentity,writeHostIdentity } from '../../../packages/agent-host/identity.mjs'
import { createSpreadsheetJobs } from '../../../packages/agent-host/spreadsheet-jobs.mjs'
import { createEvidenceCaptures } from '../../../packages/agent-host/evidence-captures.mjs'
import { binding } from '../../../packages/agent-contracts/index.mjs'
import { createSimulatedRuntime } from './runtime.mjs'

const config=JSON.parse(await readFile(process.argv[2],'utf8')),root=config.root
await mkdir(root,{recursive:true,mode:0o700})
const identity=await readHostIdentity(root),hostRunId=randomUUID(),client=createRemoteClient({origin:config.origin,identity,hostRunId,transport:'a2a'})
if(!identity.nodeId){const reply=await client.post('/internal/nodes/pair',{pairingId:config.pairing.pairingId,pairingCode:config.pairing.pairingCode,clientRequestId:identity.pairRequestId,nodeInstanceId:identity.nodeInstanceId,credential:identity.credential});Object.assign(identity,{nodeId:reply.node.id,registrationRevision:reply.node.registrationRevision,credentialVersion:reply.node.credentialVersion});await writeHostIdentity(root,identity)}
const journal=createHostJournal(join(root,'host-journal.json')),runtime=createSimulatedRuntime({path:join(root,'sessions.json')});runtime.supportsAttachments=true
const jobs=config.office?createSpreadsheetJobs({journal,root:join(root,'jobs'),nodeId:identity.nodeId,evidenceService:client.spreadsheet,forkImpl:(...args)=>{const child=fork(...args);if(config.holdWorker){child.kill('SIGSTOP');process.send?.({kind:'worker-started',pid:child.pid})}return child},onError:cause=>process.send?.({kind:'host-error',code:cause.code})}):undefined
const evidence=createEvidenceCaptures({journal,root:join(root,'sealed'),profile:config.evidenceProfile??{profileVersion:1,resources:[]},client}),host=createAgentHost({nodeId:identity.nodeId,journal,runtime,jobs,evidence})
host.setOrchestrationHandler({call:(...args)=>client.command(...args),event:event=>client.event(event)});client.setBeforeRequest((execution,inputMessageId)=>host.synchronizeInputs(execution,{inputMessageId}))
let pumping,closing=false,timer
function pump(){if(closing)return Promise.resolve();return pumping??=(async()=>{for(const delivery of(await client.resync()).pending){const command=await client.resolveCommand(delivery);await host.accept({workspaceId:'local',nodeId:identity.nodeId},command);await client.ack(command)}await host.process();await host.flushEvents(event=>client.event(event))})().catch(cause=>{process.send?.({kind:'host-error',code:cause.code??'HOST_UNAVAILABLE'})}).finally(()=>{pumping=undefined})}
async function close(){if(closing)return;closing=true;clearInterval(timer);client.group.close();await pumping;await host.close()}
await pump();timer=setInterval(()=>{void pump()},50);timer.unref();process.send?.({kind:'ready',pid:process.pid,nodeId:identity.nodeId,nodeInstanceId:identity.nodeInstanceId,hostRunId})
process.on('message',async message=>{
 if(!message.id)return
 try{
  const snapshot=await journal.read(),execution=snapshot.executions.filter(row=>row.work_id===message.workId).at(-1)
  let value
  if(message.operation==='snapshot')value=snapshot
  else if(message.operation==='pump'){await pump();value={processed:true}}
  else{
   if(!execution)throw Error('No actual execution for requested Work')
   if(message.operation==='command')value=await runtime.orchestration(execution,message.action,message.parameters)
   else if(message.operation==='spreadsheet')value=await runtime.spreadsheet(execution,'start_spreadsheet',message.parameters)
   else if(message.operation==='evidence')value=await runtime.evidence(execution,message.action,message.parameters)
   else if(message.operation==='groupReceive'){
    value=await client.group.receive(execution)
    const metadata={binding:binding(execution),...value,offeredAt:new Date().toISOString()},temporary=join(root,'offered-metadata.tmp'),file=await open(temporary,'w',0o600)
    try{await file.writeFile(JSON.stringify(metadata));await file.sync()}finally{await file.close()};await rename(temporary,join(root,'offered-metadata.json'));const directory=await open(root,'r');try{await directory.sync()}finally{await directory.close()}
   }else if(message.operation==='groupAck')value=await client.group.ack(execution,message.parameters)
   else if(message.operation==='groupBody')value=await client.group.body(execution,message.parameters.locator)
   else if(message.operation==='rawPage'){const suffix=message.parameters.cursor?'?cursor='+encodeURIComponent(message.parameters.cursor):'',response=await fetch(config.origin+'/internal/evidence/'+message.parameters.ref.id+'/content'+suffix,{headers:{authorization:'Bearer '+identity.credential,'x-geneway-node-instance':identity.nodeInstanceId,'x-geneway-host-run':hostRunId,'x-geneway-evidence-token':message.parameters.token}});value={status:response.status,body:await response.json()}}
   else if(message.operation==='readToken')value=await client.post('/internal/evidence/read-token',{binding:binding(execution),instructionRevision:execution.observed_revision,ref:message.parameters.ref})
   else throw Error('Unknown fixture RPC')
  }
  process.send?.({id:message.id,value})
 }catch(cause){process.send?.({id:message.id,failure:{code:cause.code??'FIXTURE_FAILED',status:cause.status,message:cause.message}})}
})
for(const signal of['SIGTERM','SIGINT'])process.on(signal,()=>{void close().then(()=>process.exit(0),()=>process.exit(1))})
