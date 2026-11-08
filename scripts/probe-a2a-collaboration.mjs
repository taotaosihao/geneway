import assert from 'node:assert/strict'
import { createServer as portServer,connect } from 'node:net'
import { fork,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp,mkdir,readFile,writeFile,appendFile,readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash,randomBytes } from 'node:crypto'
import sharp from 'sharp'
import ExcelJS from 'exceljs'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { digest,key,binding } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { SPREADSHEET_CANDIDATE_SCHEMA } from '../packages/agent-contracts/spreadsheet-collaboration.mjs'
import { startCollaborationProvider } from './fixtures/multisite/a2a-collaboration-provider.mjs'
import { createCollaborationTransport } from './fixtures/multisite/a2a-collaboration-transport.mjs'
import { processIdentity,waitFor,stopOwned } from './fixtures/multisite/supervision-process-lifecycle.mjs'

const directory=await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/a2a-collaboration-native-'),apiRoot=join(directory,'api')
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.versions.node,'26.5.0')
const captures=[],errors=[],hostErrors=[],browserErrors=[],children=[],parents=[],facts=[],stages=[],writes=[]
const descendants=new Map();let monitoring,monitorTimer
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),execute=promisify(execFile)
const nodes={coordinator:'cloud','desktop-office':'pc-b','desktop-data':'pc-a',gateway:'gateway',analysis:'analysis'},readerIds=Object.keys(nodes),sources={history:Array.from({length:20},(_,i)=>({date:'2026-11-01',description:i===0||i===2?'护罩松动':i===1?'漏油':`独立历史条目${i}`,owner:i===1?'李工':'张工'})),site:{sourceTime:null,health:{connection:'unknown',lastSuccessAt:null,queueDepth:null},events:Array.from({length:20},(_,i)=>({sourceEventId:`fixture-event-${i}`,sourceTimestamp:null,code:'FIXTURE',severity:'unknown',message:`模拟现场事件${i}`}))}}
const receiver={receiverId:'collaboration-owner-receiver',workspaceId:'local',memberId:'owner',principalId:'collaboration-managed-owner'}
let provider,store,transport,origin,session,browser,page,heldWorker,activeWorkId,peer,requestNumber=0,releaseGet
const firstGetBarrier=new Promise(resolve=>{releaseGet=resolve})
const save=(name,value)=>writeFile(join(directory,name),JSON.stringify(value,null,2))
const sourcePaths=['scripts/probe-a2a-collaboration.mjs','scripts/verify-spreadsheet-collaboration-result.mjs','scripts/fixtures/multisite/delegation.mjs','scripts/fixtures/multisite/runtime.mjs','scripts/fixtures/multisite/tls-proxy.mjs','scripts/fixtures/multisite/supervision-process-lifecycle.mjs','config/multisite-runtime.patch.yml','web/index.html','package.json','pnpm-lock.yaml','node_modules/@a2a-js/sdk/package.json']
async function listFiles(directory){const files=[];for(const entry of await readdir(directory,{withFileTypes:true})){const name=join(directory,entry.name);if(entry.isDirectory())files.push(...await listFiles(name));else if(entry.name.endsWith('.mjs'))files.push(name)}return files}
async function captureSources(phase){
 const paths=[...new Set([...sourcePaths,...await listFiles('src'),...await listFiles('packages/agent-host'),...await listFiles('packages/agent-contracts'),...await listFiles('packages/agent-orchestration'),...(await readdir('scripts/fixtures/multisite')).filter(name=>name.startsWith('a2a-collaboration-')).map(name=>'scripts/fixtures/multisite/'+name)])].sort()
 await mkdir(join(directory,'source-'+phase));const sources=[]
 for(const name of paths){const bytes=await readFile(name);await writeFile(join(directory,'source-'+phase,name.replaceAll('/','__')),bytes);sources.push({path:name,sha256:hash(bytes),bytes:bytes.length})}
 await save('source-'+phase+'.json',{at:new Date().toISOString(),pid:process.pid,execPath:process.execPath,node:process.version,platform:process.platform,arch:process.arch,argv:process.argv,sources})
 return sources
}
async function stage(name){stages.push({name,at:new Date().toISOString()});await save('stages.json',stages);console.log(JSON.stringify({stage:name,directory,pid:process.pid}))}
async function until(predicate,label,timeout=120000){return waitFor(predicate,label,timeout)}
async function api(path,body,method='POST'){
 const response=await transport.fetchImpl(origin+path,{method,headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrfToken,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),value=await response.json()
 assert(response.ok,JSON.stringify(value));return value
}
async function spawnOwned(entry,args,env,name,execArgv=[]){
 const child=fork(entry,args,{cwd:process.cwd(),env,execArgv,stdio:['ignore','pipe','pipe','ipc']}),item={child,name,messages:[]}
 item.exited=new Promise(done=>child.once('exit',(code,signal)=>{facts.push({kind:'exit',name,pid:child.pid,code,signal,at:new Date().toISOString()});done({code,signal})}))
 item.closed=new Promise(done=>child.once('close',done));child.on('message',message=>item.messages.push(message));child.on('error',cause=>{hostErrors.push({name,code:cause.code??'PROCESS_ERROR'})})
 for(const stream of ['stdout','stderr'])child[stream].on('data',bytes=>writes.push(appendFile(join(directory,name+'.'+stream+'.log'),bytes)))
 children.push(item);item.identity=await processIdentity(child.pid);assert(item.identity)
 const cmdline=(await readFile(`/proc/${child.pid}/cmdline`,'utf8')).split('\0').filter(Boolean)
 facts.push({kind:'start',name,...item.identity,argv:cmdline,at:new Date().toISOString()});await save('processes.json',facts)
 return item
}
async function waitMessage(item,kind){return until(()=>{assert(item.child.exitCode===null&&item.child.signalCode===null,item.name+' exited before '+kind);return item.messages.find(row=>row.kind===kind)},item.name+' '+kind,45000)}
function peerRequest(operation,parameters){
 const requestId=String(++requestNumber)
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>finish(Error('Peer '+operation+' timed out')),240000)
  const finish=(cause,value)=>{clearTimeout(timer);peer.child.off('message',onMessage);peer.child.off('exit',onExit);cause?reject(cause):resolve(value)}
  const onExit=()=>finish(Error('Peer exited during '+operation)),onMessage=message=>{if(message?.kind!=='operation-result'||message.requestId!==requestId)return;finish(message.error?Object.assign(Error(message.error.message),message.error):null,message.value)}
  peer.child.on('message',onMessage);peer.child.once('exit',onExit)
  peer.child.send({kind:'operation',requestId,operation,parameters},cause=>{if(cause)finish(cause)})
 })
}
async function signalWorker(worker,signal){const current=await processIdentity(worker.pid);assert(current&&current.startTicks===worker.startTicks,'XLSX worker identity changed');process.kill(worker.pid,signal);facts.push({kind:'signal',name:'xlsx-worker',...current,signal,at:new Date().toISOString()})}
async function collectSessions({persist=true}={}){
 const sessionEvents={}
 async function find(directory){const found=[];for(const entry of await readdir(directory,{withFileTypes:true})){const name=join(directory,entry.name);if(entry.isDirectory())found.push(...await find(name));else if(entry.name==='session.v4.jsonl.zstd')found.push(name)}return found}
 for(const parent of parents){const files=await find(join(parent.root,'multisite-executions'));assert.equal(files.length,1);const {stdout}=await execute('zstd',['-dc','--',files[0]],{encoding:'buffer',maxBuffer:16*1024*1024});sessionEvents[parent.agent]=stdout.toString('utf8').trim().split('\n').map(JSON.parse)}
 if(persist)await save('sessions.json',sessionEvents)
 return sessionEvents
}
async function awaitTerminalTurns(){
 return until(async()=>{
  const state=await store.read();if(!state.multisite.attempts.every(row=>row.settledAt))return false
  let sessions;try{sessions=await collectSessions({persist:false})}catch(cause){if(cause.code==='ENOENT'||cause.code===1)return false;throw cause}
  const turns=[]
  for(const parent of parents){
   const attempt=state.multisite.attempts.find(row=>row.work_id===activeWorkId&&row.agent_id===parent.agent),execution=binding(attempt),root=parent.agent==='coordinator',operation=root?'review_spreadsheet_candidate':'complete_delegation',tool='geneway_'+operation
   const work=state.works.find(row=>row.id===activeWorkId),artifact=root&&state.artifacts.find(row=>row.workId===work.id&&row.status==='ready'&&row.instructionRevision===work.instructionRevision)
   const domainResult=root?state.spreadsheetReviews.find(row=>row.id===artifact?.verification?.reviewId):state.multisite.results.find(row=>row.id===attempt.resultId&&!row.historical)
   assert(domainResult,'Missing final domain result for '+parent.agent)
   assert.deepEqual(root?binding(domainResult):domainResult.senderBinding,execution)
   const receipt=state.multisite.commands.find(row=>row.issuerKind==='agent'&&row.issuerId===attempt.attempt_id&&row.reply.workId===activeWorkId&&row.reply.status==='completed'&&(root?row.reply.reviewId===domainResult.id:row.reply.resultId===domainResult.id))
   assert(receipt,'Missing final domain command receipt for '+parent.agent);assert.deepEqual(receipt.senderBinding,execution)
   assert.equal(receipt.acceptedAt,root?domainResult.reviewedAt:domainResult.acceptedAt)
   const frames=sessions[parent.agent],call=frames.findLast(row=>{
    if(row.type!=='tool/call'||row.data.name!==tool)return false
    const parameters=typeof row.data.arguments==='string'?JSON.parse(row.data.arguments):row.data.arguments
    return parameters?.clientRequestId===receipt.commandId&&parameters.instructionRevision===domainResult.instructionRevision&&digest({operation,parameters})===receipt.digest
   })
   if(!call)return false
   const result=frames.find(row=>row.type==='tool/result'&&row.data.message?.toolCallId===call.data.callId&&row.seq>call.seq),end=result&&frames.find(row=>row.type==='turn/end'&&row.seq>result.seq)
   if(!result||!end)return false
   turns.push({agent:parent.agent,binding:execution,tool,domainCommandReceipt:receipt,domainResult,toolCall:call,toolResult:result,turnEnd:end,sdkWarning:result.data.message?.isError||end.data.reason?.kind!=='completed'})
  }
  await save('terminal-session-turns.json',turns);await save('sessions.json',sessions)
  assert(!state.modelRequests.some(row=>row.outcome==='failed'),'A model request failed before final freeze')
  if(!state.modelRequests.every(row=>row.outcome==='completed')||state.modelRequests.length!==captures.length)return false
  return turns
 },'final domain command receipts and matching native tool results followed by official turn ends and final model ledger',120000)
}
async function portClosed(port){return new Promise(resolve=>{const socket=connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(false)});socket.once('error',()=>resolve(true))})}
async function observeDescendants(){
 return monitoring??=(async()=>{
  async function visit(pid){
   let pids;try{pids=(await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number)}catch(cause){if(cause.code==='ENOENT'||cause.code==='ESRCH')return;throw cause}
   for(const childPid of pids){const identity=await processIdentity(childPid);if(!identity)continue;const id=childPid+':'+identity.startTicks;if(!descendants.has(id)){let argv;try{argv=(await readFile(`/proc/${childPid}/cmdline`,'utf8')).split('\0').filter(Boolean)}catch(cause){if(cause.code==='ENOENT'||cause.code==='ESRCH')continue;throw cause}descendants.set(id,{...identity,argv,observedAt:new Date().toISOString()})}await visit(childPid)}
  }
  for(const item of children)if(item.child.exitCode===null&&item.child.signalCode===null)await visit(item.child.pid)
 })().finally(()=>{monitoring=undefined})
}
async function stopChild(item){
 let timer
 try{await Promise.race([stopOwned(item,facts),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned child TERM timeout')),15000)})])}
 catch(cause){const current=await processIdentity(item.child.pid);if(current&&current.startTicks===item.identity.startTicks){facts.push({kind:'cleanup-escalation',name:item.name,...current,signal:'SIGKILL',reason:cause.message});item.child.kill('SIGKILL');await item.exited}else throw cause}
 finally{clearTimeout(timer)}
 await item.closed
 const final=await processIdentity(item.child.pid);facts.push({kind:'final-os',name:item.name,original:item.identity,identity:final,at:new Date().toISOString()});assert(!final||final.startTicks!==item.identity.startTicks,'Owned child remains in OS')
}

const sourcesAtStart=await captureSources('start')
console.log(JSON.stringify({stage:'source-start',directory,pid:process.pid,boundary:'formal src/server.mjs CLI with test-only synthetic model transport; five native A2A Hosts; local fixtures only'}))
try{
 await stage('prepare');await mkdir(apiRoot);store=createFileStore(join(apiRoot,'state.json'))
 await store.update(state=>{seedDelegation(state);state.skills=[{id:'cycle',name:'节拍计算',capabilityId:'cycle-time-calculate',enabled:true}];for(const employee of state.employees){employee.skillIds=['cycle'];employee.placement.nodeId=nodes[employee.id];employee.placement.resourceRefs=employee.id==='desktop-data'?['fixture:history']:employee.id==='gateway'?['fixture:site']:[]}return state})
 await initializeAuthFile(join(apiRoot,'auth.json'),{owner:'synthetic owner password',peer:'synthetic peer password'},{mode:'create',allowedMemberIds:['owner','peer']})
 await mkdir(join(apiRoot,'secrets'));await writeFile(join(apiRoot,'secrets/key'),'synthetic-collaboration-provider',{mode:0o600});await writeFile(join(apiRoot,'connection-catalog.json'),JSON.stringify({version:1,targets:[]}),{mode:0o600})
 const credentialFile=join(apiRoot,'owner-receiver-credential'),a2aConfig=join(apiRoot,'a2a-config.json')
 await writeFile(credentialFile,randomBytes(32).toString('base64url'),{mode:0o600})
 await writeFile(a2aConfig,JSON.stringify({version:1,nodeCommands:true,workGroups:true,receiver:{...receiver,credentialFile}}),{mode:0o600})
 provider=await startCollaborationProvider({directory,store,sources,captures,errors,until,firstGetBarrier,getWorkId:()=>activeWorkId})
 const reservation=portServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done));const apiPort=reservation.address().port;await new Promise(done=>reservation.close(done))
 transport=await createCollaborationTransport(directory,`http://127.0.0.1:${apiPort}`);origin=transport.origin
 const preload=fileURLToPath(new URL('./fixtures/multisite/a2a-collaboration-preload.mjs',import.meta.url)),serverEntry=fileURLToPath(new URL('../src/server.mjs',import.meta.url))
 const apiChild=await spawnOwned(serverEntry,[],{PATH:process.env.PATH,HOME:apiRoot,NODE_EXTRA_CA_CERTS:transport.ca,GENEWAY_STATE:join(apiRoot,'state.json'),GENEWAY_AUTH_FILE:join(apiRoot,'auth.json'),GENEWAY_SECRET_ROOT:join(apiRoot,'secrets'),GENEWAY_MODEL_CREDENTIAL_REF:'key',GENEWAY_CONNECTION_CATALOG:join(apiRoot,'connection-catalog.json'),GENEWAY_DSH_HOME:join(apiRoot,'unused-dsh'),GENEWAY_MULTISITE_HOST_MODE:'remote',GENEWAY_PORT:String(apiPort),GENEWAY_TRUSTED_ORIGIN:origin,GENEWAY_A2A_CONFIG:a2aConfig,GENEWAY_A2A_PROBE_UPSTREAM:`http://127.0.0.1:${provider.address().port}/v1`,GENEWAY_A2A_PROBE_MAP_LOG:join(directory,'model-url-map.jsonl')},'api',['--import',preload])
 assert((await readFile(`/proc/${apiChild.child.pid}/cmdline`,'utf8')).includes('src/server.mjs'))
 await until(async()=>{assert(apiChild.child.exitCode===null&&apiChild.child.signalCode===null,'API exited');try{return(await transport.fetchImpl(origin)).ok}catch{return false}},'formal CLI HTTPS ready',45000)
 const login=await transport.fetchImpl(origin+'/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({loginName:'owner',password:'synthetic owner password'})})
 assert.equal(login.status,200);session={...await login.json(),cookie:login.headers.get('set-cookie').split(';')[0]}
 for(const agent of readerIds){
  const nodeId=nodes[agent],root=join(directory,nodeId),sourceRoot=join(root,'source');await mkdir(sourceRoot,{recursive:true})
  const history=agent==='desktop-data',resourceId=history?'fixture:history':agent==='gateway'?'fixture:site':null,capability=history?'evidence.history.read.v1':'evidence.site.inspect.v1'
  if(resourceId)await writeFile(join(sourceRoot,'source.json'),JSON.stringify(history?{format:'geneway.incident-history',version:1,entries:sources.history}:{...sources.site,privateMarker:'PRIVATE_MARKER_NOT_EXPORTED'}))
  await writeFile(join(sourceRoot,'private.txt'),'PRIVATE_SIBLING_NOT_MAPPED')
  const pairing=await api('/api/admin/nodes/pairings',{clientRequestId:'pair-'+nodeId,nodeId,siteId:'site',platform:'linux',runtimeMode:'agent_node',allowedAgentIds:[agent],expiresAt:new Date(Date.now()+120000).toISOString()}),profile=join(root,'profile.json')
  await writeFile(profile,JSON.stringify({root,origin,maxActiveLoops:1,officeEnabled:agent==='desktop-office',transport:'a2a',pairing,evidenceProfile:{profileVersion:1,resources:resourceId?[{resourceId,capabilityIds:[capability],adapterKind:history?'history_json':'site_snapshot_json',root:sourceRoot,datasets:{history:'source.json'},fixedFiles:{snapshot:'source.json'},allowedSections:['collector_health','recent_events'],maxBytes:65536,maxEntries:200,maxWindowSeconds:3600,exportToAgentIds:readerIds,clockTrust:'fixture'}]:[]}}),{mode:0o600})
  const item=await spawnOwned(fileURLToPath(new URL('../packages/agent-host/remote.mjs',import.meta.url)),[profile],{PATH:process.env.PATH,HOME:root,NODE_EXTRA_CA_CERTS:transport.ca,DSH_TELEMETRY_MODE:'DISABLED'},'host-'+agent)
  item.child.on('message',message=>{if(message.kind==='host-error')hostErrors.push({agent,...message})})
  const ready=await waitMessage(item,'ready');parents.push({agent,pid:item.child.pid,...ready})
  if(resourceId)await api('/api/admin/resources/'+encodeURIComponent(resourceId),{clientRequestId:'resource-'+nodeId,expectedRevision:null,workspaceId:'local',siteId:'site',kind:history?'history_directory':'site_diagnostics',ownerNodeId:nodeId,capabilityIds:[capability],evidenceReaderAgentIds:readerIds,enabled:true},'PUT')
 }
 const model=(await store.read()).modelRoutes[0]
 await api('/api/admin/budget-policies/collaboration-simulated-price',{clientRequestId:'policy',expectedRevision:null,workspaceId:'local',coordinatorAgentId:'coordinator',enabled:true,accountingMode:'conservative_estimate',currency:'CNY',limits:{maxModelRequests:64,maxReservedTokens:100000000,maxReservedCostMicros:100000000},executionTimeoutMs:600000,estimator:{version:1,inputBytesNumerator:1,inputBytesDenominator:1,fixedInputTokens:8},modelPrices:[{provider:model.provider,model:model.model,inputMicrosPerMillionTokens:3,outputMicrosPerMillionTokens:7}]},'PUT')
 await save('oracle.json',sources);await save('parents.json',{apiPid:apiChild.child.pid,parents,origin});await save('ports.json',{apiPort,tlsPort:Number(new URL(origin).port),tapPort:transport.tapPort,providerPort:provider.address().port})
 const imagePath=join(directory,'现场模拟照片.png');await writeFile(imagePath,await sharp({create:{width:96,height:60,channels:3,background:'#2277aa'}}).png().toBuffer())
 const {chromium}=await import(process.env.GENEWAY_PLAYWRIGHT_MODULE??'/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
 browser=await chromium.launch({headless:true,env:{...process.env,HOME:transport.browserHome}});const phone=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});page=await phone.newPage()
 page.on('pageerror',cause=>browserErrors.push(cause.message));page.on('response',response=>writes.push(appendFile(join(directory,'browser-network.jsonl'),JSON.stringify({at:new Date().toISOString(),method:response.request().method(),path:new URL(response.url()).pathname,status:response.status()})+'\n')))
 await page.goto(origin);await page.locator('#login-name').fill('owner');await page.locator('#login-password').fill('synthetic owner password');await page.locator('#login-form button').click();await page.locator('#work-mode').waitFor();await page.locator('#work-mode').selectOption('multisite');await page.locator('#multisite-files').setInputFiles([imagePath])
 const attachmentRef=await page.evaluate(async()=>{
  const sessionResponse=await fetch('/api/session');if(!sessionResponse.ok)throw Error('Phone session unavailable');const {csrfToken}=await sessionResponse.json()
  const file=document.querySelector('#multisite-files').files[0],bytes=await file.arrayBuffer(),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('')
  const init=await fetch('/api/attachments/init',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrfToken},body:JSON.stringify({clientRequestId:crypto.randomUUID(),name:file.name,mediaType:file.type,sizeBytes:file.size,sha256})}),metadata=await init.json();if(!init.ok)throw Error('Phone upload init failed')
  const response=await fetch('/api/attachments/'+encodeURIComponent(metadata.id)+'/content',{method:'PUT',headers:{'content-type':'application/octet-stream','x-csrf-token':csrfToken},body:bytes});if(!response.ok)throw Error('Phone upload body failed')
  return metadata.ref
 })
 assert.equal(attachmentRef.sha256,hash(await readFile(imagePath)));assert.equal((await store.read()).works.length,0)
 await save('phone-upload.json',{attachmentRef,bytes:await readFile(imagePath).then(bytes=>bytes.length),workCountBeforeCreate:0});await page.screenshot({path:join(directory,'00-phone-upload.png'),fullPage:true});await stage('phone-actual-upload-no-work')
 const peerConfig=join(apiRoot,'peer-private.json');await writeFile(peerConfig,JSON.stringify({directory,origin,credentialFile}),{mode:0o600})
 peer=await spawnOwned(fileURLToPath(new URL('./fixtures/multisite/a2a-collaboration-peer.mjs',import.meta.url)),[peerConfig],{PATH:process.env.PATH,HOME:join(directory,'peer-home'),NODE_EXTRA_CA_CERTS:transport.ca},'official-sdk-peer');await waitMessage(peer,'ready')
 const createData={schema:'geneway.a2a.task/1',receiverId:receiver.receiverId,operation:'create',clientRequestId:'collaboration-one-task',rootEmployeeId:'coordinator',parameters:{employeeId:'coordinator',goal:'协调B读取历史与现场，独立分析并生成多来源整改表',budgetPolicyId:'collaboration-simulated-price',attachmentRefs:[attachmentRef],spreadsheetRequest:{templateId:'incident-collaboration-v1',dueDate:null}}}
 const created=await peerRequest('send',{data:createData,returnImmediately:true});assert(created.id&&created.contextId);await save('task-created.json',created)
 monitorTimer=setInterval(()=>{void observeDescendants().catch(cause=>hostErrors.push({code:cause.code??'PROCESS_OBSERVATION_FAILED'}))},50)
 const admitted=await store.read(),mapping=admitted.a2aProtocol.tasks.find(row=>row.id===created.id);assert(mapping);activeWorkId=mapping.workId;assert.equal(admitted.works.length,1)
 let blockingSettled=false
 const blocking=peerRequest('send',{data:createData}).then(value=>{blockingSettled=true;return value});blocking.catch(()=>{})
 await until(async()=>{try{return(await readFile(join(directory,'peer-wire-starts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.requestBody?.method==='SendMessage'&&row.requestBody.params.message.parts[0].data.clientRequestId===createData.clientRequestId).length===2}catch(cause){if(cause.code==='ENOENT')return false;throw cause}},'default blocking request actually started')
 const working=await peerRequest('get',{id:created.id});assert([1,2].includes(working.status.state));assert.equal(blockingSettled,false);await save('blocking-working.json',{at:new Date().toISOString(),task:working,blockingSettled})
 await until(async()=>(await store.read()).works.find(row=>row.id===activeWorkId)?.pendingQuestion?.id,'unique stable question')
 const questionState=await store.read(),question=questionState.works.find(row=>row.id===activeWorkId).pendingQuestion;await save('question-state.json',questionState)
 const inputRequired=await blocking;assert.equal(inputRequired.id,created.id);assert.equal(inputRequired.contextId,created.contextId);assert.equal(inputRequired.status.state,6);assert.equal(inputRequired.metadata.geneway.question.id,question.id)
 await save('blocking-input-required.json',inputRequired);assert.equal((await store.read()).works.length,1);assert.equal((await store.read()).a2aProtocol.tasks.length,1)
 await page.reload();await page.locator('[data-open-work="'+activeWorkId+'"]:visible').first().click();await page.locator('#multisite-user-question').waitFor();await page.screenshot({path:join(directory,'01-phone-question.png'),fullPage:true});await stage('default-blocking-replay-one-task-input-required')
 const inputData={schema:'geneway.a2a.task/1',receiverId:receiver.receiverId,operation:'input',clientRequestId:'answer-input-2',parameters:{text:'期限11月20日，原照片、来源范围与分析要求均不变',expectedInstructionRevision:1,replyToQuestion:{id:question.id,instructionRevision:question.instructionRevision},revisionScope:'due_date_only',attachmentRefs:[],spreadsheetRequest:{templateId:'incident-collaboration-v1',dueDate:'2026-11-20'}}}
 const input2=await peerRequest('send',{data:inputData,taskId:created.id,contextId:created.contextId,returnImmediately:true});assert.equal(input2.id,created.id);await save('task-input-2.json',input2)
 await until(async()=>(await store.read()).works.find(row=>row.id===activeWorkId).instructionRevision===2,'same Task Input2')
 await until(async()=>{const local=JSON.parse(await readFile(join(directory,'pc-b/host-journal.json'))),job=local.jobs.find(row=>row.work_id===activeWorkId&&row.instructionRevision===2&&row.state==='running'&&row.worker);if(!job)return false;await signalWorker(job.worker,'SIGSTOP');heldWorker=job;return true},'real revision2 XLSX worker')
 await save('busy-before.json',{cloud:await store.read(),local:JSON.parse(await readFile(join(directory,'pc-b/host-journal.json'))),heldWorker,workerIdentity:await processIdentity(heldWorker.worker.pid)})
 const input3Data={...inputData,clientRequestId:'busy-input-3',parameters:{text:'仅将整改期限改为11月25日，照片、来源范围与分析要求不变',expectedInstructionRevision:2,revisionScope:'due_date_only',attachmentRefs:[],spreadsheetRequest:{templateId:'incident-collaboration-v1',dueDate:'2026-11-25'}}}
 const input3=await peerRequest('send',{data:input3Data,taskId:created.id,contextId:created.contextId,returnImmediately:true});assert.equal(input3.id,created.id);await save('task-input-3.json',input3)
 await until(async()=>(await store.read()).works.find(row=>row.id===activeWorkId).instructionRevision===3,'same Task busy Input3')
 await signalWorker(heldWorker.worker,'SIGCONT');heldWorker=undefined;releaseGet();await stage('same-task-busy-typed-input-3')
 await until(async()=>(await store.read()).works.find(row=>row.id===activeWorkId).status==='completed','unique revision3 ready',180000)
 await until(async()=>(await store.read()).multisite.attempts.find(row=>row.work_id===activeWorkId&&row.agent_id==='coordinator').settledAt,'coordinator root actually settled')
 const terminalTurns=await awaitTerminalTurns()
 const final=await store.read(),artifact=final.artifacts.find(row=>row.workId===activeWorkId&&row.status==='ready');assert(artifact);await save('completed-state.json',final)
 const task=await peerRequest('get',{id:created.id}),listed=await peerRequest('list',{contextId:created.contextId,status:0,includeArtifacts:true,pageSize:10});await save('task-completed.json',task);await save('task-list.json',listed)
 assert.equal(task.status.state,3);assert.equal(task.metadata.geneway.currentRevision,3);assert.equal(task.artifacts.length,1);assert.equal(listed.totalSize,1);assert.equal(listed.tasks[0].id,task.id);assert.equal(listed.nextPageToken,'');assert.deepEqual(listed.tasks[0].artifacts,task.artifacts)
 const taskArtifact=task.artifacts[0];assert.notEqual(taskArtifact.artifactId,artifact.id);assert.equal(taskArtifact.metadata.globalRef.id,artifact.id);assert.equal(taskArtifact.metadata.globalRef.sha256,artifact.sha256)
 const downloaded=await peerRequest('download',{taskId:task.id,artifactId:taskArtifact.artifactId});assert.equal(downloaded.sha256,artifact.sha256);await save('task-artifact-download.json',downloaded)
 const streamingDenied=await peerRequest('streaming-negative',{id:task.id});await save('streaming-unsupported.json',streamingDenied)
 await page.reload();await page.locator('#download-spreadsheet').waitFor();await page.screenshot({path:join(directory,'02-phone-completed.png'),fullPage:true})
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download-spreadsheet').click()]),downloadPath=join(directory,'下载多来源整改表.xlsx');await download.saveAs(downloadPath)
 const bytes=await readFile(downloadPath);assert.equal(hash(bytes),artifact.sha256);assert.equal(hash(await readFile(join(directory,'task-download.xlsx'))),artifact.sha256)
 const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);assert.equal(book.worksheets.length,4)
 for(let i=0;i<20;i++){assert.equal(book.worksheets[0].getCell(i+2,3).value,sources.history[i].description);assert.equal(book.worksheets[0].getCell(i+2,4).value,sources.history[i].owner);assert.equal(book.worksheets[0].getCell(i+2,5).value,'2026-11-25');assert.equal(book.worksheets[0].getCell(i+2,6).value,i===0||i===2?2:1)}
 assert.equal(final.works.length,1);assert.equal(final.a2aProtocol.tasks.length,1);assert.equal(final.multisite.attempts.length,5);assert.equal(new Set(final.multisite.attempts.map(row=>row.session_id)).size,5);assert.equal(final.multisite.results.filter(row=>row.schema===SPREADSHEET_CANDIDATE_SCHEMA).length,1);assert.equal(final.spreadsheetReviews.length,1);assert.equal(final.userQuestions[0].state,'answered');assert(final.sourceAdoptions.length>=2);assert.equal(final.multisite.messages.filter(row=>row.kind==='observation').length,3);assert.equal(final.multisite.questions[0].state,'answered');assert(final.multisite.messages.filter(row=>['question','answer'].includes(row.kind)).every(row=>row.ingestedAt))
 assert.deepEqual(captures.map(row=>digest(row.body)).sort(),final.modelRequests.map(row=>row.bodyDigest).sort());assert.deepEqual(errors,[]);assert.deepEqual(browserErrors,[])
 const modelMap=(await readFile(join(directory,'model-url-map.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
 assert(modelMap.every(row=>row.pid===apiChild.child.pid&&row.logicalURL==='https://zenmux.ai/api/v1/chat/completions'&&row.actualMockURL===`http://127.0.0.1:${provider.address().port}/v1/chat/completions`&&row.method==='POST'))
 assert.deepEqual(modelMap.map(row=>row.bodyDigest).sort(),final.modelRequests.map(row=>row.bodyDigest).sort());await save('model-map-ledger.json',{logicalProvider:'controlled synthetic model transport only',providerRequests:captures.length,mappings:modelMap.length,ledgerRequests:final.modelRequests.length,matchingBodyDigests:final.modelRequests.map(row=>row.bodyDigest)})
 await transport.flush()
 const commands=transport.wire.filter(row=>row.path==='/a2a'&&row.requestBody?.params?.message?.parts?.[0]?.data?.schema==='geneway.a2a.node-command/1')
 for(const agent of readerIds)assert(commands.some(row=>row.requestBody.params.message.parts[0].data.binding.agent_id===agent&&row.responseBody?.result?.message?.parts?.[0]?.data?.status===200),'No successful actual A2A command from '+agent)
 assert(!transport.http.some(row=>row.path==='/internal/agent/commands'),'A2A Hosts must not fall back to internal agent commands')
 const group=final.a2aProtocol.groups.find(row=>row.workId===activeWorkId);assert(group);assert.equal(new Set(group.members.map(row=>row.contextId)).size,5);assert(group.members.every(row=>row.contextId!==task.contextId))
 const acked=final.a2aProtocol.deliveries.filter(row=>row.workId===activeWorkId&&row.metadataAck);assert(acked.length>0)
 const groupFrames=transport.wire.filter(row=>row.path==='/a2a'&&row.requestBody?.params?.message?.parts?.[0]?.data?.schema==='geneway.a2a.work-group/1')
 assert(groupFrames.some(row=>row.responseBody?.result?.message?.parts?.[0]?.data?.deliveries?.length>0),'No actual nonempty group receive')
 assert(groupFrames.some(row=>row.requestBody.params.message.parts[0].data.operation==='ack'&&row.responseBody?.result?.message?.parts?.[0]?.data?.accepted===true),'No actual group metadata ACK')
 for(const frame of groupFrames){const value=frame.requestBody.params.message.parts[0].data;assert(Object.keys(value).every(name=>['schema','operation','operationId','binding','locator','deliveryId','payloadDigest'].includes(name)));const reply=frame.responseBody?.result?.message?.parts?.[0]?.data;if(reply?.deliveries)for(const notice of reply.deliveries)assert.deepEqual(Object.keys(notice).sort(),['deliveryId','locator','payloadDigest'])}
 await save('a2a-command-summary.json',{commands:commands.map(row=>({at:row.at,status:row.status,binding:row.requestBody.params.message.parts[0].data.binding,operation:row.requestBody.params.message.parts[0].data.operation,replyStatus:row.responseBody?.result?.message?.parts?.[0]?.data?.status})),applicationGroup:{id:group.id,members:group.members,metadataAckCount:acked.length},boundary:'Geneway application group; opaque metadata ACK is not DSH consumption'})
 const sessions=await collectSessions()
 const qReceipts=[]
 for(const message of final.multisite.messages.filter(row=>['question','answer'].includes(row.kind))){
  const receiver=final.multisite.attempts.find(row=>row.attempt_id===message.targetAttemptId),id=messageId(key('message-delivery',message.id),receiver.attempt_id,receiver.session_id)
  assert.equal(message.sessionId,receiver.session_id)
  const received=[];for(const [agent,events] of Object.entries(sessions))for(const event of events.filter(row=>row.type==='user/message'&&row.data.id===id))received.push({agent,seq:event.seq,source:event.data.source})
  assert.equal(received.length,1,'Directed Q/answer must enter exactly one responsible Session');assert.equal(received[0].agent,receiver.agent_id)
  qReceipts.push({messageId:message.id,kind:message.kind,targetAttemptId:receiver.attempt_id,sessionId:receiver.session_id,deliveryId:id,received})
 }
 await save('directed-question-session-receipts.json',qReceipts);await save('capture.json',{captures,errors})
 const oracle=await execute(process.execPath,['scripts/verify-spreadsheet-collaboration-result.mjs',directory],{maxBuffer:4*1024*1024});await writeFile(join(directory,'independent-oracle.stdout.log'),oracle.stdout)
 await stage('standard-task-owner-download-and-original-four-sheet-oracle-passed')
 await save('result.json',{result:'passed',directory,workId:activeWorkId,taskId:task.id,contextId:task.contextId,artifactId:artifact.id,taskArtifactId:taskArtifact.artifactId,sha256:artifact.sha256,providerRequests:captures.length,normalJourney:'passed',defaultBlockingReplay:'input-required on the same unique Task',retainedSdkWarnings:terminalTurns.filter(row=>row.sdkWarning).map(row=>({agent:row.agent,commandId:row.domainCommandReceipt.commandId,toolCallId:row.toolCall.data.callId,toolResultIsError:row.toolResult.data.message?.isError,turnEndReason:row.turnEnd.data.reason})),shortBusyCancel:'notrun',shortMemberRemoval:'notrun',hostErrors,boundary:'formal src/server.mjs CLI + same-origin real TLS + independent official SDK peer + five native A2A Hosts/Sessions + original Job/workbook oracle; controlled synthetic model provider/source/photo, no real model billing/site/Office desktop or release certification'})
}catch(cause){await save('failure.json',{name:cause.name,message:cause.message,code:cause.code,stack:cause.stack,errors,hostErrors,browserErrors});if(store)await save('failed-state.json',await store.read()).catch(()=>{});await collectSessions().catch(()=>{});if(page&&!page.isClosed()){await page.screenshot({path:join(directory,'failure-phone.png'),fullPage:true}).catch(()=>{});await writeFile(join(directory,'failure-phone.txt'),await page.locator('body').innerText().catch(()=>''))}console.error(directory);process.exitCode=1
}finally{
 releaseGet();if(heldWorker)await signalWorker(heldWorker.worker,'SIGCONT').catch(()=>{});await browser?.close()
 clearInterval(monitorTimer);await monitoring;await observeDescendants()
 if(store)await save('state-before-cleanup.json',await store.read()).catch(()=>{})
 const ports=await readFile(join(directory,'ports.json'),'utf8').then(JSON.parse).catch(()=>({}))
 const cleanupErrors=[]
 for(const item of [...children].reverse()){
  try{await stopChild(item)}catch(cause){cleanupErrors.push({name:item.name,message:cause.message})}
 }
 if(provider){provider.closeAllConnections();await new Promise(done=>provider.close(done))}
 await transport?.close().catch(cause=>cleanupErrors.push({name:'transport',message:cause.message}));await Promise.all(writes)
 await save('capture.json',{captures,errors});await save('processes.json',facts)
 const descendantFinal=[];for(const row of descendants.values()){const finalIdentity=await processIdentity(row.pid),sameOriginalLive=!!finalIdentity&&finalIdentity.startTicks===row.startTicks&&finalIdentity.state!=='Z';descendantFinal.push({original:row,finalIdentity,sameOriginalLive});if(sameOriginalLive)cleanupErrors.push({name:'native-descendant',message:'Original descendant is still live: '+row.pid})}
 await save('native-processes.json',descendantFinal)
 if(store)await save('state-after-cleanup.json',await store.read()).catch(()=>{})
 const closedPorts=[];for(const [name,port] of Object.entries(ports)){const closed=await portClosed(port);closedPorts.push({name,port,closed});if(!closed)cleanupErrors.push({name,message:'Port still accepting connections'})}
 const sourcesAtEnd=await captureSources('end');const sourceChanged=!requireSameSources(sourcesAtStart,sourcesAtEnd)
 await save('close.json',{at:new Date().toISOString(),closedPorts,cleanupErrors,sourceChanged,hostErrors})
 if(cleanupErrors.length||sourceChanged){process.exitCode=1;const result=await readFile(join(directory,'result.json'),'utf8').then(JSON.parse).catch(()=>null);if(result)await save('result.json',{...result,result:'failed',completionGap:'See close.json: process cleanup or source changed during run'})}
 console.log(JSON.stringify({stage:'closed',directory,sourceChanged,cleanupErrors,pid:process.pid}))
}
function requireSameSources(start,end){return JSON.stringify(start)===JSON.stringify(end)}
