import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:net';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {processIdentity} from './processes.mjs';
import {startAnpPeer} from '../peers/anp/run.mjs';

async function reservePort(){const server=createServer();await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});const port=server.address().port;await new Promise(done=>server.close(done));return port;}
export async function startBusinessProcess({candidate,root,apiRoot,origin,session,allowCancel=false}){
  assert(['a2a','anp'].includes(candidate));assert.equal(typeof allowCancel,'boolean');root=path.resolve(root);await mkdir(root,{recursive:true,mode:0o700});
  const port=await reservePort(),configFile=path.join(root,'business-service-private.json'),events=path.join(root,'business-process-events.jsonl');
  let peer,current,expectedPeerConfig,expectedOrigin,generation=0,closed=false;
  const record=value=>appendFile(events,JSON.stringify({at:new Date().toISOString(),...value})+'\n');
  async function finalOs(pid){try{return await processIdentity(pid);}catch(error){if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;}}
  async function launch(openExisting){
    assert(!closed,'Business manager is closed');assert(!current||current.child.exitCode!==null||current.child.signalCode!==null,'Previous business service is still live');
    const config={candidate,root,apiRoot,originAPI:origin,session,port,openExisting,allowCancel,...(peer?{peer:{origin:peer.origin,identity:{configPath:peer.identity.configPath}}}:{})};
    await writeFile(configFile,JSON.stringify(config,null,2),{mode:0o600});
    const child=fork(fileURLToPath(new URL('./business-child.mjs',import.meta.url)),['--config',configFile],{env:{PATH:process.env.PATH,HOME:root},execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
    const incoming=[];child.on('message',value=>incoming.push(value));const childClosed=new Promise(done=>child.once('close',done));
    const exit=new Promise(done=>child.once('exit',(code,signal)=>done({code,signal,at:new Date().toISOString()}))),identity=await processIdentity(child.pid),number=++generation;
    const outputs=['stdout','stderr'].map(name=>{const stream=createWriteStream(path.join(root,`business-child-${number}.${name}.log`),{mode:0o600});child[name].pipe(stream);return stream;});
    current={child,identity,exit,number};await record({kind:'start',generation:number,openExisting,identity});
    try{
      const ready=await new Promise((done,reject)=>{
        const timer=setTimeout(()=>reject(Error('Business child ready timeout')),30000);
        const message=value=>{if(value.kind==='ready'){clearTimeout(timer);child.off('message',message);done(value);}else if(value.kind==='startup-error'){clearTimeout(timer);reject(Error(value.message));}};
        child.on('message',message);for(const value of incoming)message(value);if(child.exitCode!==null||child.signalCode!==null){clearTimeout(timer);reject(Error('Business child already exited before ready'));}child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',(code,signal)=>{clearTimeout(timer);reject(Error(`Business child exited before ready: ${code}/${signal}`));});
      });
      assert.equal(ready.candidate,candidate);assert.equal(ready.pid,child.pid);assert.equal(new URL(ready.origin).port,String(port));
      if(openExisting){assert.deepEqual(ready.peerConfig,expectedPeerConfig,'Restart changed public peer configuration');assert.equal(ready.origin,expectedOrigin,'Restart changed endpoint');}else{expectedPeerConfig=ready.peerConfig;expectedOrigin=ready.origin;}
      current.ready=ready;await record({kind:'ready',generation:number,identity,ready});return ready;
    }catch(error){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exit;await record({kind:'startup-failed',generation:number,identity,error:error.message});throw error;}
    finally{current.persisted=exit.then(async terminal=>{await childClosed;await Promise.all(outputs.map(stream=>new Promise(done=>{if(stream.writableFinished)return done();stream.once('finish',done);})));await record({kind:'exit',generation:number,identity,terminal,finalIdentity:await finalOs(child.pid)});});}
  }
  async function stop(signal){if(!current)return null;const item=current;if(item.child.exitCode===null&&item.child.signalCode===null){const actual=await finalOs(item.child.pid);assert(actual&&actual.startTicks===item.identity.startTicks,'Business child identity changed');await record({kind:'signal',generation:item.number,identity:item.identity,signal});item.child.kill(signal);}const terminal=await item.exit;await item.persisted;await record({kind:'stop-confirmed',generation:item.number,identity:item.identity,terminal,finalIdentity:await finalOs(item.child.pid)});return terminal;}
  try{
    if(candidate==='anp')peer=await startAnpPeer({root:path.join(root,'recovery-peer'),didDomain:'business-recovery-peer.test',resolverBaseUrls:{'geneway-recovery-home.test':`http://127.0.0.1:${port}`}});
    await launch(false);
    return{get peerConfig(){return current.ready.peerConfig;},get child(){return current.child;},get identity(){return current.identity;},get origin(){return current.ready.origin;},get peer(){return peer;},async kill(){const terminal=await stop('SIGKILL');assert.equal(terminal.signal,'SIGKILL','X07 requires actual SIGKILL exit');return terminal;},async startExisting(){assert(current.child.exitCode!==null||current.child.signalCode!==null,'Must observe old process exit before restarting');await launch(true);return{peerConfig:current.ready.peerConfig,child:current.child,identity:current.identity,origin:current.ready.origin};},async restart(){const old=current.identity;await this.kill();const next=await this.startExisting();assert.notEqual(old.pid,next.identity.pid);await record({kind:'restart',oldIdentity:old,newIdentity:next.identity,unchangedEndpoint:expectedOrigin});return next;},async close(){if(closed)return;closed=true;await stop('SIGTERM');await peer?.close();}};
  }catch(error){await stop('SIGTERM').catch(()=>{});await peer?.close();throw error;}
}
