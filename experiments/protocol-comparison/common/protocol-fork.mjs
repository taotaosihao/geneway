import { fork as originalFork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let starting,relay;
export function fork(modulePath,args,options){
  const root=process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT,candidate=process.env.GENEWAY_PROTOCOL_COMPARISON_CANDIDATE;
  if(String(modulePath).endsWith('/fixtures/multisite/production-service.mjs')&&candidate!=='baseline'){
    starting=import('../adapters/normal-relay.mjs').then(({startNormalRelay})=>startNormalRelay({candidate,root:path.join(root,'relay'),backendOrigin:'http://127.0.0.1:'+options.env.GENEWAY_PORT,stateFile:options.env.GENEWAY_STATE,recoveryCase:process.env.GENEWAY_PROTOCOL_RECOVERY_CASE})).then(async value=>{relay=value;await writeFile(path.join(root,'relay-runtime.json'),JSON.stringify(value,null,2));return value;});starting.catch(error=>{console.error('Protocol relay start failed',error);});
  }
  if(String(modulePath).endsWith('/packages/agent-host/remote.mjs')&&candidate!=='baseline')options={...options,env:{...options.env,GENEWAY_PROTOCOL_COMPARISON_ROOT:root,GENEWAY_PROTOCOL_COMPARISON_CANDIDATE:candidate,GENEWAY_PROTOCOL_RECOVERY_CASE:process.env.GENEWAY_PROTOCOL_RECOVERY_CASE},execArgv:['--import',fileURLToPath(new URL('./register.mjs',import.meta.url))]};
  return originalFork(modulePath,args,options);
}
export async function closeRelay(){if(starting)await starting;if(relay)await relay.close();}

export async function currentRelay(){if(starting)await starting;return relay;}
