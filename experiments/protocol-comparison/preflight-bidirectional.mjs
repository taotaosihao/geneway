import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { startProgram } from './common/processes.mjs';
import { createLocalCertificate, createA2aClient, applicationReply } from './common/wire.mjs';
const exec = promisify(execFile), directory = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-bidirectional-');
const processes = [];
try {
  const tls = await createLocalCertificate(path.join(root,'tls'));
  const credentials = Object.fromEntries(['owner','coordinator','desktop-office','desktop-data','gateway','analysis','peer-a2a'].map(id=>[id,randomBytes(32).toString('base64url')]));
  const adapter = await startProgram({entry:path.join(directory,'adapters/a2a/server.mjs'),root:path.join(root,'adapter-process'),config:{root:path.join(root,'adapter'),tls,credentials}}); processes.push(adapter);
  const peer = await startProgram({entry:path.join(directory,'peers/a2a/run.mjs'),root:path.join(root,'peer-process'),config:{root:path.join(root,'peer'),tls}}); processes.push(peer);
  const client = await createA2aClient({origin:peer.ready.origin,token:(await readFile(peer.ready.tokenFile,'utf8')).trim(),caFile:tls.certFile,logFile:path.join(root,'adapter-to-peer-wire.jsonl'),targetProcess:peer.ready.pid});
  const message = {message:{messageId:randomUUID(),role:1,parts:[{content:{$case:'text',value:'独立真实对端往返，中文资料'},mediaType:'text/plain',filename:''}],metadata:{peerExecution:{mode:'finite',steps:3,intervalMs:25}}}};
  const task = await client.sendMessage(message,{signal:AbortSignal.timeout(15000)});
  assert.equal(task.status.state,3); assert(task.artifacts.length); assert.deepEqual(await client.getTask({id:task.id}),task);
  const tokenFile=path.join(root,'adapter-peer-token');await writeFile(tokenFile,credentials['peer-a2a'],{mode:0o600});
  const outputFile=path.join(root,'peer-to-adapter.json'),config={origin:adapter.ready.origin,tokenFile,caFile:tls.certFile,operation:'sendMessage',request:{message:{messageId:randomUUID(),role:1,parts:[{content:{$case:'text',value:'独立peer主动发向Geneway'},mediaType:'text/plain',filename:''}]}},outputFile};
  const configFile=path.join(root,'peer-client-config.json');await writeFile(configFile,JSON.stringify(config),{mode:0o600});
  const reverse=await exec(process.execPath,[path.join(directory,'peers/a2a/client.mjs'),'--config',configFile],{timeout:15000});
  await writeFile(path.join(root,'peer-client-stdout.log'),reverse.stdout);await writeFile(path.join(root,'peer-client-stderr.log'),reverse.stderr);
  const reply=JSON.parse(await readFile(outputFile));assert.equal(applicationReply(reply).echo,'独立peer主动发向Geneway');
  const result={result:'passed',root,protocol:'a2a',wireVersion:'1.0',sdk:'1.3.0',tlsVerified:true,processes:processes.map(p=>p.identity),forward:{taskId:task.id,state:task.status.state,artifactCount:task.artifacts.length},reverse:reply,boundary:'X01/X09 minimal actual official SDK discovery and bidirectional exchange with independent peer/real OS executor. Not full X01-X10, cancellation or conformance approval.'};
  await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await writeFile(path.join(root,'failure.json'),JSON.stringify({message:error.message,stack:error.stack},null,2));console.error(root,error);process.exitCode=1;}
finally{for(const child of processes.reverse())await child.close();}
