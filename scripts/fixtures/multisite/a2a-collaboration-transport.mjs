import assert from 'node:assert/strict'
import { createServer,request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { appendFile,readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTlsProxy } from './tls-proxy.mjs'

export async function createCollaborationTransport(directory,target){
  let writes=Promise.resolve(),failure
  const record=(file,value)=>{
    writes=writes.then(()=>appendFile(join(directory,file),JSON.stringify(value)+'\n',{mode:0o600})).catch(cause=>{failure??=cause})
  }
  const wire=[],http=[],server=createServer((request,response)=>{
    const pathname=new URL(request.url,'http://fixture').pathname,startedAt=new Date().toISOString(),requestBytes=[],responseBytes=[]
    const capture=pathname==='/a2a'||pathname==='/internal/a2a/group-body'||pathname==='/.well-known/agent-card.json'
    const stream=pathname==='/internal/bridge/events'&&request.method==='GET'
    request.on('data',bytes=>{if(capture)requestBytes.push(bytes)})
    const outgoing=httpRequest(new URL(request.url,target),{method:request.method,headers:request.headers},incoming=>{
      response.writeHead(incoming.statusCode,incoming.headers);response.flushHeaders()
      let frames=''
      if(stream)incoming.setEncoding('utf8')
      incoming.on('data',bytes=>{
        if(capture)responseBytes.push(Buffer.from(bytes))
        if(stream){
          frames+=bytes
          for(;;){const end=frames.indexOf('\n\n');if(end<0)break;record('bridge-frames.jsonl',{at:new Date().toISOString(),nodeInstanceId:request.headers['x-geneway-node-instance'],frame:frames.slice(0,end)});frames=frames.slice(end+2)}
        }
      })
      incoming.on('error',()=>response.destroy())
      incoming.pipe(response)
      incoming.once('end',()=>{
        const row={at:startedAt,finishedAt:new Date().toISOString(),method:request.method,path:pathname,status:incoming.statusCode,nodeInstanceId:request.headers['x-geneway-node-instance'],hostRunId:request.headers['x-geneway-host-run'],credentialPresent:!!request.headers.authorization,version:request.headers['a2a-version']??null}
        http.push(row);record('http.jsonl',row)
        if(capture){
          const decode=bytes=>{const text=Buffer.concat(bytes).toString('utf8');try{return JSON.parse(text)}catch{return text}}
          const frame={...row,requestBody:decode(requestBytes),responseBody:decode(responseBytes)}
          wire.push(frame);record('a2a-wire.jsonl',frame)
        }
      })
      response.once('close',()=>{outgoing.destroy();incoming.destroy()})
    })
    outgoing.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end()})
    request.once('aborted',()=>outgoing.destroy());request.pipe(outgoing)
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  let tls
  try{tls=await createTlsProxy(join(directory,'tls'),{target:`http://127.0.0.1:${server.address().port}`,idleTimeoutMs:600000})}
  catch(cause){await new Promise(resolve=>server.close(resolve));throw cause}
  const ca=await readFile(tls.ca)
  async function fetchImpl(input,options={}){
    const url=new URL(input);assert.equal(url.origin,tls.origin)
    return new Promise((resolve,reject)=>{
      const request=httpsRequest(url,{method:options.method??'GET',headers:options.headers,ca,family:4,signal:options.signal??AbortSignal.timeout(30000)},incoming=>{
        const chunks=[];incoming.on('data',bytes=>chunks.push(bytes));incoming.once('error',reject)
        incoming.once('end',()=>resolve(new Response(Buffer.concat(chunks),{status:incoming.statusCode,headers:incoming.headers})))
      })
      request.once('error',reject);request.end(options.body)
    })
  }
  return{...tls,wire,http,fetchImpl,tapPort:server.address().port,
    async flush(){await writes;if(failure)throw failure},
    async close(){await tls.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writes;if(failure)throw failure}
  }
}
