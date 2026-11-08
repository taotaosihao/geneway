import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {startNormalRelay} from '../adapters/normal-relay.mjs';
const index=process.argv.indexOf('--config');assert(index>=0&&process.argv[index+1]);
const config=JSON.parse(await readFile(process.argv[index+1],'utf8'));assert(['a2a','anp'].includes(config.candidate));
let service,closing;
const close=()=>closing??=service?.close();
try{
  service=await startNormalRelay(config);
  const info=JSON.parse(await readFile(path.join(config.root,'relay-ready.json'),'utf8'));
  assert.equal(info.pid,process.pid);assert.equal(info.candidate,config.candidate);
  process.send({kind:'ready',candidate:config.candidate,pid:process.pid,info});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void Promise.resolve(close()).then(()=>process.exit(0),()=>process.exit(1));});
}catch(error){process.send?.({kind:'startup-error',code:error.code??'ROLE_SERVICE_START_FAILED',message:error.message});await Promise.resolve(close()).catch(()=>{});process.exitCode=1;process.disconnect?.();}
