import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {processIdentity} from '../common/processes.mjs';

export async function startRoleService({candidate,root,backendOrigin}){
  assert(['a2a','anp'].includes(candidate),'Baseline must not start a candidate role service');
  root=path.resolve(root);await mkdir(root,{recursive:true,mode:0o700});const configFile=path.join(root,'role-service-config.json');
  await writeFile(configFile,JSON.stringify({candidate,root,backendOrigin},null,2),{mode:0o600});
  const spawnedAt=new Date().toISOString(),child=fork(fileURLToPath(new URL('./role-service-child.mjs',import.meta.url)),['--config',configFile],{env:{PATH:process.env.PATH,HOME:root,GENEWAY_ROLE_LOAD_TRACE:path.join(root,'module-loads.jsonl')},execArgv:['--import',fileURLToPath(new URL('./role-loaded.mjs',import.meta.url))],stdio:['ignore','pipe','pipe','ipc']});
  const exited=new Promise(done=>child.once('exit',(code,signal)=>done({code,signal,at:new Date().toISOString()}))),closed=new Promise(done=>child.once('close',done));
  const ready=new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('Role service ready timeout')),30000);const cleanup=()=>clearTimeout(timer);child.on('message',value=>{if(value.kind==='ready'){cleanup();done(value);}else if(value.kind==='startup-error'){cleanup();reject(Error(value.message));}});child.once('error',error=>{cleanup();reject(error);});child.once('exit',(code,signal)=>{cleanup();reject(Error(`Role service exited before ready: ${code}/${signal}`));});});
  const streams=['stdout','stderr'].map(name=>{const stream=createWriteStream(path.join(root,'role-service.'+name+'.log'),{mode:0o600});child[name].pipe(stream);return stream;});
  let identity,info,closePromise;
  async function finalIdentity(){try{return await processIdentity(child.pid);}catch(error){if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;}}
  function close(){return closePromise??=(async()=>{if(child.exitCode===null&&child.signalCode===null){const actual=await finalIdentity();assert(actual&&(!identity||actual.startTicks===identity.startTicks),'Role process identity changed');child.kill('SIGTERM');}const terminal=await exited;await closed;await Promise.all(streams.map(stream=>new Promise(done=>{if(stream.writableFinished)return done();stream.once('finish',done);})));const final=await finalIdentity();await writeFile(path.join(root,'role-service-process-exit.json'),JSON.stringify({identity,terminal,finalIdentity:final,sameIdentityLive:!!final&&final.startTicks===identity?.startTicks&&final.state!=='Z'},null,2));return terminal;})();}
  try{
    identity=await processIdentity(child.pid);const value=await ready;assert.equal(value.candidate,candidate);assert.equal(value.pid,child.pid);info=value.info;assert.equal(info.pid,child.pid);
    const peerIdentity=info.peerPid?await processIdentity(info.peerPid):null;
    await writeFile(path.join(root,'role-service-process-start.json'),JSON.stringify({spawnedAt,readyAt:new Date().toISOString(),identity,info,peerIdentity},null,2));
    return{child,identity,info,close};
  }catch(error){await close();throw error;}
}
