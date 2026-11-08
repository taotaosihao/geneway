import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createBusinessTasks} from './business-tasks.mjs';
import {startBusinessA2a} from '../adapters/a2a/business-server.mjs';
import {startAnpHome} from '../adapters/anp/home.mjs';
import {startBusinessAnp} from '../adapters/anp/business-entry.mjs';

const index=process.argv.indexOf('--config');assert(index>=0&&process.argv[index+1]);
const config=JSON.parse(await readFile(process.argv[index+1],'utf8'));
let entry,home,closing;
async function close(){return closing??=(async()=>{await entry?.close();await home?.close();})();}
try{
  let peerConfig,origin;
  if(config.candidate==='a2a'){
    const principal='independent-a2a-owner',tasks=await createBusinessTasks({root:path.join(config.root,'mapping'),apiRoot:config.apiRoot,origin:config.originAPI,session:config.session,principal,allowCancel:config.allowCancel});
    entry=await startBusinessA2a({root:path.join(config.root,'a2a'),tasks,principal,openExisting:config.openExisting,port:config.port,allowCancel:config.allowCancel});
    origin=entry.origin;peerConfig={origin,tokenFile:entry.tokenFile,caFile:entry.caFile};
  }else{
    assert.equal(config.candidate,'anp');
    home=await startAnpHome({root:path.join(config.root,'recovery-home'),didDomain:'geneway-recovery-home.test',port:config.port,resolverBaseUrls:{'business-recovery-peer.test':config.peer.origin},openExisting:config.openExisting});
    entry=await startBusinessAnp({root:path.join(config.root,'anp'),apiRoot:config.apiRoot,origin:config.originAPI,session:config.session,home,peer:config.peer,openExisting:config.openExisting,allowCancel:config.allowCancel});
    origin=home.origin;peerConfig={peerConfigPath:entry.peerConfigPath,handle:entry.handle,groupDid:entry.groupDid,homeDid:entry.homeDid};
  }
  process.send({kind:'ready',candidate:config.candidate,pid:process.pid,peerConfig,origin});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void close().then(()=>process.exit(0),()=>process.exit(1));});
}catch(error){process.send?.({kind:'startup-error',code:error.code??'BUSINESS_ENTRY_START_FAILED',message:error.message});await close().catch(()=>{});process.exitCode=1;process.disconnect?.();}
