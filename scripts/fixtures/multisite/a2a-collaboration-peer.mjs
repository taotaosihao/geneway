import assert from 'node:assert/strict'
import { readFile,writeFile,appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID,createHash } from 'node:crypto'
import { ClientFactory,JsonRpcTransportFactory,DefaultAgentCardResolver } from '@a2a-js/sdk/client'

const config=JSON.parse(await readFile(process.argv[2],'utf8')),token=(await readFile(config.credentialFile,'utf8')).trim()
const origin=new URL(config.origin).origin
const request=async(input,options={})=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url)
  assert.equal(url.origin,origin);assert(!url.search&&!url.hash&&!url.username&&!url.password)
  assert(url.pathname==='/a2a'||url.pathname==='/.well-known/agent-card.json'||url.pathname.startsWith('/a2a/tasks/'))
  const headers=new Headers(options.headers);headers.set('authorization','Bearer '+token)
  const at=new Date().toISOString()
  await appendFile(join(config.directory,'peer-wire-starts.jsonl'),JSON.stringify({at,pid:process.pid,path:url.pathname,method:options.method??'GET',requestBody:options.body?JSON.parse(options.body):null})+'\n')
  const response=await fetch(url,{...options,headers,redirect:'error'})
  const bytes=Buffer.from(await response.arrayBuffer()),isJson=(response.headers.get('content-type')??'').includes('json')
  await appendFile(join(config.directory,'peer-wire.jsonl'),JSON.stringify({at,finishedAt:new Date().toISOString(),pid:process.pid,path:url.pathname,method:options.method??'GET',version:headers.get('a2a-version'),requestBody:options.body?JSON.parse(options.body):null,status:response.status,responseBody:isJson?JSON.parse(bytes):{sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}})+'\n')
  return new Response(bytes,{status:response.status,headers:response.headers})
}
const transportFactory=new JsonRpcTransportFactory({fetchImpl:request})
const client=await new ClientFactory({transports:[transportFactory],cardResolver:new DefaultAgentCardResolver({fetchImpl:request})}).createFromUrl(origin)
const card=await client.getAgentCard();assert.equal(card.capabilities.streaming,false)
process.send({kind:'ready',pid:process.pid,origin,card})
process.on('message',message=>{if(message?.kind==='operation')void operate(message)})
async function operate({requestId,operation,parameters={}}){
  try{
    let value
    if(operation==='send'){
      const {data,taskId,contextId,returnImmediately}=parameters
      value=await client.sendMessage({message:{messageId:randomUUID(),role:1,parts:[{content:{$case:'data',value:data},mediaType:'application/json',filename:''}],extensions:[],referenceTaskIds:[],...(taskId?{taskId,contextId}:{})},...(returnImmediately===undefined?{}:{configuration:{returnImmediately}})})
    }else if(operation==='get')value=await client.getTask(parameters)
    else if(operation==='list')value=await client.listTasks(parameters)
    else if(operation==='cancel')value=await client.cancelTask(parameters)
    else if(operation==='streaming-negative'){
      let denied
      try{for await(const event of client.resubscribeTask({id:parameters.id}))throw Error('Unexpected stream event '+JSON.stringify(event))}
      catch(cause){denied={name:cause.name,message:cause.message,code:cause.code,envelopeCode:cause.envelopeCode,transport:cause.transport,reason:cause.reason,data:cause.data}}
      assert(denied);assert.equal(denied.envelopeCode,-32004);assert.equal(denied.transport,'jsonrpc');assert.equal(denied.reason,'UNSUPPORTED_OPERATION')
      value=denied
    }
    else if(operation==='download'){
      const task=await client.getTask({id:parameters.taskId}),artifact=task.artifacts.find(row=>row.artifactId===parameters.artifactId)
      assert(artifact);const part=artifact.parts.find(row=>row.content?.$case==='url');assert(part)
      const url=new URL(part.content.value);assert.equal(url.pathname,`/a2a/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.artifactId)}`)
      const response=await request(url);assert.equal(response.status,200)
      const bytes=Buffer.from(await response.arrayBuffer()),filename=join(config.directory,'task-download.xlsx')
      await writeFile(filename,bytes)
      value={filename,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),artifact}
    }else throw Error('Unknown peer operation '+operation)
    process.send({kind:'operation-result',requestId,value})
  }catch(cause){process.send({kind:'operation-result',requestId,error:{name:cause.name,message:cause.message,code:cause.code,envelopeCode:cause.envelopeCode,transport:cause.transport,reason:cause.reason}})}
}
process.on('SIGTERM',()=>process.exit(0))
