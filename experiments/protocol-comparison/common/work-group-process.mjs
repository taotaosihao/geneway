import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:net';
import {appendFile,chmod,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {processIdentity} from './processes.mjs';

async function reservePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}

async function osIdentity(pid){
  try{return await processIdentity(pid);}
  catch(error){if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;}
}

export async function startWorkGroupProcess({candidate,root,config,entryFile,listenPort}){
  assert(['a2a','anp'].includes(candidate));
  assert(config&&typeof config==='object'&&!Array.isArray(config));
  assert(listenPort===undefined||(Number.isInteger(listenPort)&&listenPort>=1&&listenPort<=65535),'listenPort must be an integer from 1 to 65535');
  root=path.resolve(root);entryFile=path.resolve(entryFile);
  await mkdir(root,{recursive:true,mode:0o700});
  const privateConfig=JSON.parse(JSON.stringify(config)),port=listenPort??await reservePort();
  const configFile=path.join(root,'work-group-private.json'),events=path.join(root,'process-events.jsonl');
  let current,generation=0,requestNumber=0,closed=false,expectedOrigin,expectedIdentity,eventWrites=Promise.resolve();
  function record(value){
    eventWrites=eventWrites.then(()=>appendFile(events,JSON.stringify({at:new Date().toISOString(),...value})+'\n',{mode:0o600}));
    eventWrites.catch(()=>{});
    return eventWrites;
  }

  async function launch(openExisting){
    assert(!closed,'Work group manager is closed');
    assert(!current||current.child.exitCode!==null||current.child.signalCode!==null,'Previous work group child is still live');
    if(current)await current.persisted;
    await writeFile(configFile,JSON.stringify({...privateConfig,candidate,root,port,openExisting},null,2),{mode:0o600});
    await chmod(configFile,0o600);
    const child=fork(entryFile,['--config',configFile],{env:{PATH:process.env.PATH,HOME:root},execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
    const number=++generation,pending=new Map();
    let readyResolve,readyReject,readySettled=false;
    const readyPromise=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    readyPromise.catch(()=>{});
    const failReady=error=>{if(!readySettled){readySettled=true;readyReject(error);}};
    const readyTimer=setTimeout(()=>failReady(Error('Work group child ready timeout')),30000);
    const childClosed=new Promise(resolve=>child.once('close',resolve));
    const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{
      clearTimeout(readyTimer);
      failReady(Error(`Work group child exited before ready: ${code}/${signal}`));
      for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('Work group child exited during control request'));}
      pending.clear();
      resolve({code,signal,at:new Date().toISOString()});
    }));
    child.on('error',error=>{clearTimeout(readyTimer);failReady(error);});
    child.on('message',value=>{
      if(!value||typeof value!=='object')return;
      if(value.kind==='ready'&&!readySettled){readySettled=true;clearTimeout(readyTimer);readyResolve(value);}
      else if(value.kind==='startup-error'){clearTimeout(readyTimer);failReady(Error(value.message??'Work group child startup failed'));}
      else if(value.kind==='control-result'){
        const request=pending.get(value.requestId);if(!request)return;
        pending.delete(value.requestId);clearTimeout(request.timer);
        if(Object.hasOwn(value,'error')){
          const error=Error(typeof value.error==='string'?value.error:value.error?.message??'Work group control failed');
          if(value.error?.code)error.code=value.error.code;
          request.reject(error);
        }else request.resolve(value.value);
      }
    });
    const item={child,exit,number,pending};current=item;
    for(const name of ['stdout','stderr'])child[name].setEncoding('utf8').on('data',text=>{
      void record({kind:name,generation:number,pid:child.pid,text});
    });
    item.persisted=exit.then(async terminal=>{
      await childClosed;
      await record({kind:'terminal',generation:number,identity:item.identity,terminal});
      item.finalIdentity=await osIdentity(child.pid);
      await record({kind:'os-final',generation:number,identity:item.identity,finalIdentity:item.finalIdentity,
        originalGone:!item.finalIdentity||item.finalIdentity.startTicks!==item.identity?.startTicks});
    });
    item.persisted.catch(()=>{});
    try{
      item.identity=await processIdentity(child.pid);
      await record({kind:'start',generation:number,openExisting,identity:item.identity});
      const ready=await readyPromise;
      assert.equal(ready.candidate,candidate);assert.equal(ready.pid,child.pid);
      const endpoint=new URL(ready.origin);
      assert.equal(endpoint.hostname,'127.0.0.1');assert.equal(endpoint.port,String(port));
      assert(ready.info&&typeof ready.info==='object','Work group child ready requires info');
      if(openExisting){
        assert.equal(ready.origin,expectedOrigin,'Restart changed endpoint');
        assert.deepEqual(ready.identity??ready.info,expectedIdentity,'Restart changed endpoint identity');
      }else{
        expectedOrigin=ready.origin;expectedIdentity=structuredClone(ready.identity??ready.info);
      }
      item.ready=ready;
      // Keep private DTOs, credential paths and control results out of process events.
      await record({kind:'ready',generation:number,identity:item.identity,origin:ready.origin});
      return ready;
    }catch(error){
      await stop('SIGTERM');
      await record({kind:'startup-failed',generation:number,identity:item.identity});
      throw error;
    }
  }

  async function stop(signal){
    const item=current;if(!item)return null;
    if(item.child.exitCode===null&&item.child.signalCode===null){
      const actual=await osIdentity(item.child.pid);
      assert(actual&&(!item.identity||actual.startTicks===item.identity.startTicks),'Work group child identity changed');
      // A failed evidence write must still allow cleanup of this owned child.
      await record({kind:'signal',generation:item.number,identity:item.identity,signal}).catch(()=>{});
      assert(item.child.kill(signal),'Could not signal work group child');
    }
    const terminal=await item.exit;await item.persisted;
    assert(!item.finalIdentity||item.finalIdentity.startTicks!==item.identity?.startTicks,'Work group child remains in OS');
    return terminal;
  }

  try{
    await launch(false);
    return{
      get child(){return current.child;},
      get identity(){return current.identity;},
      get startTicks(){return current.identity.startTicks;},
      get origin(){return current.ready.origin;},
      get info(){return current.ready.info;},
      get ready(){return current.ready;},
      async kill(){
        const terminal=await stop('SIGKILL');
        assert.equal(terminal.signal,'SIGKILL','Work group recovery requires actual SIGKILL exit');
        return terminal;
      },
      async startExisting(){
        const previous=current.identity;
        assert(current.child.exitCode!==null||current.child.signalCode!==null,'Must observe old child exit before restarting');
        await launch(true);
        assert.notEqual(current.identity.pid,previous.pid,'Restart must use a new PID');
        return{child:current.child,identity:current.identity,startTicks:current.identity.startTicks,origin:current.ready.origin,info:current.ready.info,ready:current.ready};
      },
      request(operation,parameters){
        assert(!closed,'Work group manager is closed');assert.equal(typeof operation,'string');assert(operation.length>0);
        const item=current;
        assert(item.ready&&item.child.connected&&item.child.exitCode===null&&item.child.signalCode===null,'Work group child is not ready');
        const requestId=`${item.number}:${++requestNumber}`;
        return new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{item.pending.delete(requestId);reject(Error(`Work group control timeout: ${operation}`));},30000);
          item.pending.set(requestId,{resolve,reject,timer});
          const failed=error=>{if(!error)return;const request=item.pending.get(requestId);if(!request)return;item.pending.delete(requestId);clearTimeout(timer);reject(error);};
          try{item.child.send({kind:'control',requestId,operation,parameters},failed);}catch(error){failed(error);}
        });
      },
      async close(){if(closed)return;closed=true;await stop('SIGTERM');}
    };
  }catch(error){await stop('SIGTERM').catch(()=>{});throw error;}
}
