import { readFile,appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createWireFetch,applicationMessage,applicationReply } from './wire.mjs';
let configuration;
const clients=new Map();
async function config(){if(configuration)return configuration;const file=path.join(process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT,'relay-runtime.json'),deadline=Date.now()+30000;for(;;){try{configuration=JSON.parse(await readFile(file));return configuration;}catch(error){if(error.code!=='ENOENT')throw error;if(Date.now()>deadline)throw Error('Protocol relay not ready');await new Promise(resolve=>setTimeout(resolve,25));}}}
async function sendProtocol(input,options,originalFetch){
  const url=new URL(input);if(url.pathname!=='/internal/agent/commands'||options.method!=='POST')return originalFetch(input,options);
  const current=await config(),baseFetch=await createWireFetch({caFile:current.caFile});
  const fetchImpl=(target,init={})=>baseFetch(process.env.GENEWAY_PROTOCOL_EGRESS_PROXY?new URL('/protocol'+new URL(target).pathname+new URL(target).search,process.env.GENEWAY_PROTOCOL_EGRESS_PROXY):target,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),authorization:options.headers.authorization,'x-geneway-node-instance':options.headers['x-geneway-node-instance'],'x-geneway-host-run':options.headers['x-geneway-host-run']}});
  if(current.candidate==='anp')return fetchImpl(current.origin+'/submit',{method:'POST',headers:{'content-type':'application/json'},body:options.body,signal:options.signal});
  const key=options.headers.authorization+'\0'+options.headers['x-geneway-node-instance'];let client=clients.get(key);
  if(!client){const {ClientFactory,JsonRpcTransportFactory,DefaultAgentCardResolver}=await import('@a2a-js/sdk/client');client=await new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl})],cardResolver:new DefaultAgentCardResolver({fetchImpl})}).createFromUrl(current.origin);clients.set(key,client);}
  const command=JSON.parse(options.body),requestId=command.parameters?.clientRequestId??crypto.randomUUID();
  const result=applicationReply(await client.sendMessage(applicationMessage(requestId,command),{signal:options.signal}));
  if(!result||!Number.isInteger(result.status))throw Error('Invalid actual domain result through A2A Message');
  return new Response(JSON.stringify(result.body),{status:result.status,headers:{'content-type':'application/json'}});
}

let completeRecovered=false;
export async function protocolFetch(input,options,originalFetch){
  let command;try{command=JSON.parse(options.body);}catch{}
  const target=process.env.GENEWAY_PROTOCOL_RECOVERY_CASE==='result-reply'&&new URL(input).pathname==='/internal/agent/commands'&&command?.binding?.agent_id==='desktop-data'&&command.operation==='complete_delegation'&&command.parameters?.clientRequestId==='complete';
  if(!target)return sendProtocol(input,options,originalFetch);
  const file=path.join(process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT,'relay/caller-attempts.jsonl'),identity={pid:process.pid,nodeInstanceId:options.headers['x-geneway-node-instance'],hostRunId:options.headers['x-geneway-host-run']};
  await appendFile(file,JSON.stringify({at:new Date().toISOString(),type:'actual-host-send',identity,command})+'\n');
  let response;
  try{response=await sendProtocol(input,options,originalFetch);await appendFile(file,JSON.stringify({at:new Date().toISOString(),type:'actual-host-response',identity,command,status:response.status,reply:await response.clone().json()})+'\n');}
  catch(error){await appendFile(file,JSON.stringify({at:new Date().toISOString(),type:'actual-host-transport-error',identity,command,error:{name:error.name,message:error.message,code:error.code}})+'\n');throw error;}
  if(response.ok&&!completeRecovered){
    completeRecovered=true;const changed=structuredClone(command);changed.parameters.result.summary+='改';
    const negative=await sendProtocol(input,{...options,body:JSON.stringify(changed),signal:AbortSignal.timeout(20000)},originalFetch),body=await negative.json();
    await appendFile(file,JSON.stringify({at:new Date().toISOString(),type:'same-host-changed-summary',identity,command:changed,status:negative.status,reply:body})+'\n');
    if(negative.status!==409||body.error?.code!=='IDEMPOTENCY_CONFLICT')throw Error('Same-key changed result did not conflict');
  }
  return response;
}
