import assert from 'node:assert/strict'
import { createServer as portServer } from 'node:net'
import { mkdtemp,writeFile,readFile,mkdir } from 'node:fs/promises'
import { randomBytes,randomUUID,createHash } from 'node:crypto'
import { Task } from '@a2a-js/sdk'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createNodeService } from '../src/node-service.mjs'
import { createAuthRuntime,initializeAuthFile } from '../src/auth.mjs'
import { createA2aService } from '../src/a2a-service.mjs'
import { A2A_TASK_SCHEMA,A2A_NODE_SCHEMA } from '../src/a2a-state.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'

const root=await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/t03b-http-contract-')
const sourcePaths=['scripts/test-a2a-runtime.mjs','src/a2a-service.mjs','src/a2a-config.mjs','src/a2a-state.mjs','src/server.mjs','src/work-service.mjs','src/store/file-store.mjs','packages/agent-orchestration/service.mjs','src/auth.mjs','src/node-service.mjs','package.json','pnpm-lock.yaml']
async function captureSources(phase){await mkdir(root+'/source-'+phase,{recursive:true});const rows=[];for(const path of sourcePaths){const bytes=await readFile(path);const copy=root+'/source-'+phase+'/'+path.replaceAll('/','__');await writeFile(copy,bytes);rows.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length})}await writeFile(root+'/source-'+phase+'.json',JSON.stringify({at:new Date().toISOString(),pid:process.pid,execPath:process.execPath,procStat:await readFile(`/proc/${process.pid}/stat`,'utf8'),sources:rows,scope:'workGroups:false; parallel group modules excluded'},null,2))}
await captureSources('start')
const store=createFileStore(root+'/state.json');await store.update(state=>seedDelegation(state))
const service=createWorkService({store}),nodes=createNodeService({store})
await initializeAuthFile(root+'/auth.json',{owner:'synthetic owner password',peer:'synthetic peer password'},{mode:'create',allowedMemberIds:['owner','peer']})
const reservation=portServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done));const port=reservation.address().port;await new Promise(done=>reservation.close(done))
const origin=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('base64url')
const receiver={receiverId:'contract-receiver',workspaceId:'local',memberId:'owner',principalId:'contract-owner',token}
const config={version:1,nodeCommands:true,workGroups:false,receiver}
const server=createGenewayServer({a2aConfig:config,store,service,nodeService:nodes,auth:createAuthRuntime({filePath:root+'/auth.json'}),trustedOrigin:origin,interactionRuntimeEnabled:false})
const raw=[],checks=[]
let rpcId=0
async function rpc(method,params,options={}) {
  const request={jsonrpc:'2.0',id:++rpcId,method,params},headers={'content-type':'application/json','a2a-version':options.version??'1.0',authorization:'Bearer '+(options.token??token),...options.headers}
  const response=await fetch(origin+'/a2a',{method:'POST',headers,body:JSON.stringify(request)}),body=await response.json()
  raw.push({request,headers:{...headers,authorization:'[redacted]'},status:response.status,responseHeaders:Object.fromEntries(response.headers),body})
  return body
}
const send=(parameters,key)=>rpc('SendMessage',{message:{messageId:randomUUID(),role:'ROLE_USER',parts:[{data:{schema:A2A_TASK_SCHEMA,receiverId:receiver.receiverId,operation:'create',clientRequestId:key,parameters},mediaType:'application/json'}]},configuration:{returnImmediately:true}})
try {
  await new Promise(done=>server.listen(port,'127.0.0.1',done));console.log(JSON.stringify({stage:'live',root,port,pid:process.pid}))
  const card=await (await fetch(origin+'/.well-known/agent-card.json')).json();assert.equal(card.capabilities.streaming,false)
  const parameters={employeeId:'coordinator',goal:'真实HTTP合同第一Task'},first=(await send(parameters,'first')).result.task
  assert.ok(first.id&&first.contextId)
  const second=(await send({employeeId:'desktop-data',goal:'真实HTTP合同第二Task'},'second')).result.task;assert.ok(second.id);assert.notEqual(second.id,first.id)
  assert.equal((await send(parameters,'first')).result.task.id,first.id)
  assert.ok((await send({...parameters,goal:'异文'},'first')).error)
  const get=await rpc('GetTask',{id:first.id});assert.equal(get.result.id,first.id)
  const badVersion=await rpc('GetTask',{id:first.id},{version:'9.9'});assert.equal(badVersion.error.code,-32009);assert.equal(badVersion.id,rpcId)
  assert.equal((await rpc('GetTask',{id:randomUUID()})).error.code,-32001)
  const page1=(await rpc('ListTasks',{pageSize:1})).result;assert.equal(page1.tasks.length,1);assert.equal(page1.totalSize,2);assert.ok(page1.nextPageToken)
  const page2=(await rpc('ListTasks',{pageSize:1,pageToken:page1.nextPageToken})).result;assert.equal(page2.tasks.length,1);assert.equal(page2.nextPageToken,'');assert.notEqual(page1.tasks[0].id,page2.tasks[0].id)
  assert.ok(page1.tasks[0].status.timestamp>=page2.tasks[0].status.timestamp)
  assert.deepEqual(Task.fromJSON(page1.tasks[0]).artifacts,[])
  assert.equal((await rpc('ListTasks',{contextId:first.contextId})).result.totalSize,1)
  assert.equal((await rpc('ListTasks',{statusTimestampAfter:'2999-01-01T00:00:00Z'})).result.totalSize,0)
  assert.ok((await rpc('ListTasks',{pageToken:page1.nextPageToken,contextId:first.contextId})).error)
  assert.ok((await rpc('ListTasks',{pageToken:'bad-cursor'})).error)
  for(const method of ['SendStreamingMessage','SubscribeToTask'])assert.ok((await rpc(method,method==='SubscribeToTask'?{id:first.id}:{message:{messageId:randomUUID(),role:'ROLE_USER',parts:[{text:'不支持流'}]}})).error)
  const wrongPurpose=await rpc('SendMessage',{message:{messageId:randomUUID(),role:'ROLE_USER',parts:[{data:{schema:A2A_NODE_SCHEMA},mediaType:'application/json'}]},configuration:{returnImmediately:true}});assert.ok(wrongPurpose.error)
  const standalone=createA2aService({config,store,service,nodes,origin}),context={user:{userName:'owner'}}
  const current=Task.fromJSON((await rpc('GetTask',{id:first.id})).result);await standalone.validateSave(current,context)
  await assert.rejects(standalone.validateSave({...current,status:{...current.status,state:3}},context))
  const foreignConfig={...config,receiver:{...receiver,principalId:'another-authorized-principal'}}
  // 跨受管域的纯服务投影使用真实同owner配置，不把未知token401冒授权证明。
  const foreignService=createA2aService({config:foreignConfig,store,service,nodes,origin})
  await assert.rejects(foreignService.handler.getTask({id:first.id},context));await assert.rejects(foreignService.handler.listTasks({pageToken:page1.nextPageToken,pageSize:1},context))
  checks.push('two admitted Tasks/replay/conflict/Get/errors/List pagination-filter-cursor/owner wrong-purpose/SDKsave/current scoped projection')
  assert.equal((await store.read()).modelRequests.length,0)
  await writeFile(root+'/raw.json',JSON.stringify(raw,null,2));await writeFile(root+'/result.json',JSON.stringify({root,checks,firstTask:first.id,secondTask:second.id,boundary:'loopback HTTP contract plus scoped service checks only; no TLS/native/Office/provider, no valid Node-purpose positive or default-blocking Q proof yet'},null,2))
  console.log(JSON.stringify({root,result:'passed',checks}))
} catch(error){await writeFile(root+'/failure.json',JSON.stringify({name:error.name,message:error.message,stack:error.stack},null,2));throw error} finally {server.closeAllConnections();await new Promise(done=>server.close(done));await service.close();await captureSources('end');await writeFile(root+'/raw.json',JSON.stringify(raw,null,2))}
