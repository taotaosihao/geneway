import assert from 'node:assert/strict'
import { open as fsOpen,readFile } from 'node:fs/promises'
import { dirname,join } from 'node:path'
import { createAgentHost,HOST_INBOX_LIMITS,hostInboxPressure,isPendingHostInboxRow,assertHostInboxAdmission,isOrdinaryInboxCapacityError } from '../../../packages/agent-host/host.mjs'
import { createHostJournal } from '../../../packages/agent-host/journal.mjs'
import { binding,SCHEMA,seal,key } from '../../../packages/agent-contracts/index.mjs'
import { commandModelObservation } from './t11-pressure-model.mjs'

const at='2026-11-07T00:00:00.000Z'
const execution={work_id:'component-work',delegation_id:'component-delegation',parent_delegation_id:null,attempt_id:'component-attempt',execution_epoch:1,agent_id:'desktop-office',node_id:'component-node',launch_id:'component-launch',session_id:'component-session'}
const command=(id,operation='deliver',parameters={text:'组件合法封包，不产生运行副作用'})=>seal({schema:SCHEMA,command_id:key(id),workspace_id:'local',...execution,operation,input_id:['cancel','settle'].includes(operation)?null:key('input',id),instruction_revision:1,observed_revision:0,resource_refs:[],parameters,employee_revision:1})
const row=(id,status='accepted',operation='deliver')=>({command:command(id,operation,['cancel','settle'].includes(operation)?{}:undefined),status,acceptedAt:at})
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8')
function sizedRow(id,size){const value=row(id);value.command.parameters.text='';value.command.parameters.text='x'.repeat(size-bytes(value));assert.equal(bytes(value),size);return value}
function rejected(state,candidate,queue,reason){const before=JSON.stringify(state);assert.throws(()=>assertHostInboxAdmission(state,candidate),cause=>cause.code==='CAPACITY_EXCEEDED'&&cause.capacity?.domain==='host-inbox'&&cause.capacity.queue===queue&&cause.capacity.reason===reason);assert.equal(JSON.stringify(state),before)}

export async function runPressureComponents({directory,save}){
  const cases=[],mark=name=>cases.push({name,result:'passed'})
  assert.deepEqual(HOST_INBOX_LIMITS,{ordinaryCount:256,ordinaryBytes:16777216,controlCount:64,controlBytes:1048576,historyCount:10000,ordinaryHistoryCount:9936,commandBytes:4194304})
  for(const status of ['accepted','delivered'])assert(isPendingHostInboxRow(row(status,status)))
  for(const status of ['ingested','control_consumed','stopped','settled'])assert.equal(isPendingHostInboxRow(row(status,status)),false)
  for(const flag of ['supersededAt','controlConsumedAt','manualIdleAt','manualReleasedAt','budgetIdleAt'])assert.equal(isPendingHostInboxRow({...row(flag),[flag]:at}),false)
  const mixed=[row('ordinary'),row('unknown','delivered'),row('manual','accepted','manual_release'),row('cancel','accepted','cancel'),row('settle','delivered','settle'),row('history','ingested')]
  const pressure=hostInboxPressure(mixed)
  assert.equal(pressure.history.count,6);assert.equal(pressure.history.bytes,mixed.reduce((sum,item)=>sum+bytes(item),0));assert.equal(pressure.ordinary.count,3);assert.equal(pressure.control.count,2)
  assert.equal(hostInboxPressure([row('unknown','delivered')]).ordinary.count,1)
  const unicode=row('unicode');unicode.command.parameters.text='现场压力';assert.equal(hostInboxPressure([unicode]).ordinary.bytes,bytes(unicode));assert(bytes(unicode)>JSON.stringify(unicode).length)
  mark('pending actual statuses and consumed flags; unknown execution does not waive occupancy; UTF8 serialized row bytes')

  const counted=Array.from({length:256},(_,index)=>row('count-'+index)),ordinary=row('count-next'),cancel=row('cancel-next','accepted','cancel')
  rejected({inbox:counted,executions:[{...execution,status:'unknown'}]},ordinary,'ordinary','pending_count')
  assert.doesNotThrow(()=>assertHostInboxAdmission({inbox:counted,executions:[]},cancel))
  rejected({inbox:Array.from({length:64},(_,index)=>row('cancel-'+index,'accepted','cancel')),executions:[]},cancel,'control','pending_count')
  assert.throws(()=>assertHostInboxAdmission({inbox:counted,executions:[]},row('settle-missing','accepted','settle')),{code:'FORBIDDEN'})
  assert.doesNotThrow(()=>assertHostInboxAdmission({inbox:counted,executions:[execution]},row('settle-existing','accepted','settle')))
  assert.throws(()=>assertHostInboxAdmission({inbox:[],executions:[{...execution,session_id:'another-session'}]},cancel),{code:'FORBIDDEN'})
  const unstarted=row('unstarted-cancel','accepted','cancel');unstarted.command.session_id=null;assert.doesNotThrow(()=>assertHostInboxAdmission({inbox:[],executions:[]},unstarted))
  mark('ordinary count and bounded reserved control; exact settle binding and never-started cancel')

  const archive='/home/gewu/.codex/task-checkpoints/geneway-evidence/a2a-collaboration-native-GYVANs/completed-state.json',archived=JSON.parse(await readFile(archive,'utf8')),settle=archived.multisite.outbox.find(item=>item.command.operation==='settle'&&item.command.parameters.artifactRefs?.length)?.command
  assert(settle,'Original normal-chain Artifact settle must exist')
  const originalExecution=archived.multisite.attempts.find(item=>item.attempt_id===settle.attempt_id),originalSettle={command:settle,status:'accepted',acceptedAt:at}
  assert.doesNotThrow(()=>assertHostInboxAdmission({inbox:counted,executions:[originalExecution]},originalSettle))
  assert.throws(()=>assertHostInboxAdmission({inbox:[],executions:[{...originalExecution,session_id:'wrong-session'}]},originalSettle),{code:'FORBIDDEN'})
  const extra=structuredClone(originalSettle);extra.command.parameters.artifactRefs[0].url='https://not-authority.invalid/file';assert.throws(()=>assertHostInboxAdmission({inbox:[],executions:[originalExecution]},extra),{code:'INVALID_REQUEST'})
  await save('original-artifact-settle.json',{archive,originalSettle,originalExecution:binding(originalExecution),boundary:'archived real formal normal-chain producer envelope, pure admission check only; no replacement receipt or persisted history'})
  mark('original real Artifact settle input/ref/fullbinding admitted; wrong binding and ref extras rejected')

  const fullBytes=Array.from({length:16},(_,index)=>sizedRow('bytes-'+index,1024*1024))
  assert.equal(hostInboxPressure(fullBytes).ordinary.bytes,HOST_INBOX_LIMITS.ordinaryBytes)
  rejected({inbox:fullBytes,executions:[]},ordinary,'ordinary','pending_bytes')
  assert.doesNotThrow(()=>assertHostInboxAdmission({inbox:fullBytes,executions:[]},cancel))
  const exact=fullBytes.slice(0,-1),remaining=HOST_INBOX_LIMITS.ordinaryBytes-hostInboxPressure(exact).ordinary.bytes
  assert.doesNotThrow(()=>assertHostInboxAdmission({inbox:exact,executions:[]},sizedRow('exact-byte-candidate',remaining)))
  rejected({inbox:exact,executions:[]},sizedRow('one-byte-over',remaining+1),'ordinary','pending_bytes')
  const huge=sizedRow('command-too-large',HOST_INBOX_LIMITS.commandBytes+4096);rejected({inbox:[],executions:[]},huge,'ordinary','command_bytes')
  const controlBytes=Array.from({length:16},(_,index)=>{const value=row('control-bytes-'+index,'accepted','cancel');value.command.resource_refs=Array(8).fill('');const length=65536-bytes(value);value.command.resource_refs=value.command.resource_refs.map((_,part)=>'x'.repeat(Math.floor(length/8)+(part<length%8?1:0)));assert.equal(bytes(value),65536);return value})
  assert.equal(hostInboxPressure(controlBytes).control.bytes,HOST_INBOX_LIMITS.controlBytes);rejected({inbox:controlBytes,executions:[]},cancel,'control','pending_bytes')
  mark('production 16MiB serialized pending boundary including candidate; exact byte and command size limits')

  // These arrays are only pure capacity-function inputs, never persisted history.
  const history=Array.from({length:10000},(_,index)=>row('history-'+index,'ingested'))
  rejected({inbox:history.slice(0,9936),executions:[]},ordinary,'ordinary','history_count')
  assert.doesNotThrow(()=>assertHostInboxAdmission({inbox:history.slice(0,9999),executions:[]},cancel))
  rejected({inbox:history,executions:[]},cancel,'control','history_count')
  assert(isOrdinaryInboxCapacityError({code:'CAPACITY_EXCEEDED',capacity:{domain:'host-inbox',queue:'ordinary'}}))
  for(const value of [{code:'CAPACITY_EXCEEDED'},{code:'ENOSPC'},{code:'CAPACITY_EXCEEDED',capacity:{domain:'other',queue:'ordinary'}},{code:'CAPACITY_EXCEEDED',capacity:{domain:'host-inbox',queue:'control'}}])assert.equal(isOrdinaryInboxCapacityError(value),false)
  mark('history 9936/10000 pure inputs only; precise remote capacity error classification')

  const modelArchive='/home/gewu/.codex/task-checkpoints/geneway-evidence/t11-host-pressure-qm6P7U',replayed=JSON.parse(await readFile(join(modelArchive,'exact-committed-replay.json'),'utf8')),providerBodies=JSON.parse(await readFile(join(modelArchive,'provider-bodies.json'),'utf8'))
  const observation=commandModelObservation({command:replayed.target,models:replayed.cloud.modelRequests,providerBodies,sessions:replayed.sessions})
  assert(observation);assert.equal(observation.expected.instructionRevision,173);assert.equal(observation.requests.length,1);assert.equal(observation.assistantOutputs[0].seq,1704)
  assert.equal(commandModelObservation({command:replayed.anchor,models:replayed.cloud.modelRequests,providerBodies,sessions:replayed.sessions}),null,'real Input174 has no model despite completed predecessor173')
  assert.equal(commandModelObservation({command:replayed.target,models:replayed.cloud.modelRequests.map(row=>({...row,outcome:'unknown'})),providerBodies,sessions:replayed.sessions}),null)
  assert.equal(commandModelObservation({command:replayed.target,models:replayed.cloud.modelRequests,providerBodies:[],sessions:replayed.sessions}),null)
  assert.equal(commandModelObservation({command:replayed.target,models:replayed.cloud.modelRequests,providerBodies,sessions:replayed.sessions.map(row=>({...row,events:row.events.filter(event=>event.type!=='assistant/message')}))}),null)
  await save('model-observer-component.json',{archive:modelArchive,actual173:observation,actual174:'no matching model/output; not passed',boundary:'actual archived producer positive173 and actual negative174; isolated negative views of missing ledger/provider/SDK evidence, no new model or state edits'})
  mark('real173 expected input/revision/provider digest/SDK output; real174 completed predecessor cannot satisfy a new Input')

  let starts=0
  const runtime={start(){starts++;throw Error('Component must not start a runtime')},async close(){}},journal=createHostJournal(join(directory,'replay/host-journal.json')),host=createAgentHost({nodeId:execution.node_id,journal,runtime}),auth={workspaceId:'local',nodeId:execution.node_id}
  for(let index=0;index<256;index++)await host.accept(auth,command('actual-accept-'+index))
  const original=command('actual-accept-0'),before=await journal.read(),ack=await host.accept(auth,original)
  assert.equal(ack.command_id,original.command_id);assert.deepEqual(binding(ack),execution);assert.deepEqual(await journal.read(),before)
  const {payload_digest:oldDigest,...body}=original
  await assert.rejects(host.accept(auth,seal({...body,parameters:{text:'same id changed payload'}})),{code:'IDEMPOTENCY_CONFLICT'})
  await assert.rejects(host.accept(auth,command('new-after-full')),cause=>isOrdinaryInboxCapacityError(cause)&&cause.capacity.reason==='pending_count')
  assert.deepEqual(await journal.read(),before);assert.equal(starts,0);await host.close()
  mark('256 individually accepted sealed component frames; exact ID/digest replay precedes capacity and creates no runtime')

  for(const mode of ['enospc-temp-write','uncertain-dirsync']){
    const path=join(directory,mode,'host-journal.json'),ioEvents=[];let armed=false
    const operations={async open(target,flags,permission){
      const handle=await fsOpen(target,flags,permission)
      return new Proxy(handle,{get(value,field){
        if(field==='writeFile')return async data=>{ioEvents.push({kind:'writeFile',target,bytes:Buffer.byteLength(data)});if(armed&&mode==='enospc-temp-write'&&flags==='w')throw Object.assign(Error('fixture temp write ENOSPC'),{code:'ENOSPC'});return value.writeFile(data)}
        if(field==='sync')return async()=>{ioEvents.push({kind:'sync',target});if(armed&&mode==='uncertain-dirsync'&&target===dirname(path))throw Object.assign(Error('fixture directory sync EIO'),{code:'EIO'});return value.sync()}
        const property=Reflect.get(value,field);return typeof property==='function'?property.bind(value):property
      }})
    }}
    const journal=createHostJournal(path,operations);await journal.update(()=>{})
    const host=createAgentHost({nodeId:execution.node_id,journal,runtime}),target=command(mode)
    armed=true;await assert.rejects(host.accept(auth,target),{code:mode==='enospc-temp-write'?'ENOSPC':'EIO'})
    const disk=JSON.parse(await readFile(path,'utf8'));assert.equal(disk.inbox.length,mode==='enospc-temp-write'?0:1);assert.equal(disk.executions.length,0);assert.equal(disk.jobs.length,0);assert.equal(disk.outbox.length,0)
    if(mode==='uncertain-dirsync'){
      await assert.rejects(journal.read(),{code:'STORE_UNAVAILABLE'});armed=false;await assert.rejects(journal.read(),{code:'STORE_UNAVAILABLE'})
      let runtimeCloses=0,originalError
      const closing=createAgentHost({nodeId:execution.node_id,journal,runtime:{async close(){runtimeCloses++}},jobs:{async close(){try{await journal.read()}catch(cause){originalError=cause;throw cause}}}})
      await assert.rejects(closing.close(),cause=>cause===originalError&&cause.code==='STORE_UNAVAILABLE');assert.equal(runtimeCloses,1);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),disk)
      mark('unavailable Journal during jobs.close preserves its error, invokes runtime.close once and adds no receipt; no physical Job exit claim')
    }else{assert.equal((await journal.read()).inbox.length,0);armed=false}
    await host.close();const recoveredJournal=createHostJournal(path,operations),recovered=createAgentHost({nodeId:execution.node_id,journal:recoveredJournal,runtime})
    const recoveredAck=await recovered.accept(auth,target);assert.equal(recoveredAck.command_id,target.command_id);assert.equal((await recoveredJournal.read()).inbox.length,1);await recovered.accept(auth,target);assert.equal((await recoveredJournal.read()).inbox.length,1);assert.equal(starts,0);await recovered.close()
    await save(mode+'.json',{diskAtFailure:disk,originalCommand:target,recovered:await recoveredJournal.read(),ioEvents,boundary:'real production Journal operations seam; component Host accept only, no API/remote/SDK, no physical disk filling or latch reset'})
    mark(mode+' original disk facts; same-root reopen and exact replay without duplicate acceptance')
  }
  await save('component-result.json',{result:'passed',cases,limits:HOST_INBOX_LIMITS,boundary:'pure capacity inputs for 10000 history and production Journal/Host accept components; no HTTP listener, native Session, model/provider or business effect'})
  return cases
}
