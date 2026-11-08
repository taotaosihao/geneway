import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import { journalFault } from './t11-pressure-control.mjs'

registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==='./journal.mjs'&&context.parentURL?.endsWith('/packages/agent-host/remote.mjs'))return{url:new URL('./t11-pressure-journal.mjs',import.meta.url).href,shortCircuit:true}
  return nextResolve(specifier,context)
}})
let host,closing
process.on('message',message=>{
  if(message.kind==='fault'){
    journalFault.mode=message.mode;journalFault.commandId=message.commandId??null
    process.send?.({kind:'fault-configured',requestId:message.requestId,mode:journalFault.mode,commandId:journalFault.commandId});return
  }
  if(message.kind==='start')void(async()=>{
    try{
      const {startRemoteAgentHost}=await import('../../../packages/agent-host/remote.mjs'),profile=JSON.parse(await readFile(message.profile,'utf8'))
      host=await startRemoteAgentHost({...profile,onReady:value=>process.send?.({kind:'ready',...value}),onError:cause=>process.send?.({kind:'host-error',code:cause.code??'REMOTE_UNAVAILABLE',commandId:cause.commandId,capacity:cause.capacity})})
    }catch(cause){process.send?.({kind:'host-start-error',code:cause.code??'HOST_START_FAILED',message:cause.message});process.exitCode=1}
  })()
})
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{closing??=(async()=>{try{await host?.close();process.exit(0)}catch(cause){process.send?.({kind:'close-error',code:cause.code??'HOST_CLOSE_FAILED'});process.exit(1)}})()})
