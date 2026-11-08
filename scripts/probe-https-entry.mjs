import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTlsProxy } from './fixtures/multisite/tls-proxy.mjs'
const directory=await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/https-entry-')
let proxy,child
try{
 const portServer=createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve))
 proxy=await createTlsProxy(join(directory,'tls'),{target:`http://127.0.0.1:${port}`})
 const chunks=[]
 child=fork('scripts/probe-spreadsheet-remote.mjs',[],{cwd:process.cwd(),env:{...process.env,NODE_EXTRA_CA_CERTS:proxy.ca,GENEWAY_TEST_PUBLIC_ORIGIN:proxy.origin,GENEWAY_TEST_BACKEND_PORT:String(port),GENEWAY_TEST_BROWSER_HOME:proxy.browserHome},execArgv:[],stdio:['ignore','pipe','pipe','ipc']})
 child.stdout.on('data',bytes=>{chunks.push(bytes);process.stdout.write(bytes)});child.stderr.on('data',bytes=>{chunks.push(bytes);process.stderr.write(bytes)})
 console.log(JSON.stringify({stage:'native TLS production remote Office journey running',directory,pid:child.pid,origin:proxy.origin}))
 const exit=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})))
 const stdout=Buffer.concat(chunks).toString('utf8');await writeFile(join(directory,'native.log'),stdout)
 const nativeRoot=/Spreadsheet native evidence: (.+)/.exec(stdout)?.[1]
 await writeFile(join(directory,'result.json'),JSON.stringify({directory,...exit,nativeRoot,origin:proxy.origin,proxyObservations:proxy.observations,boundary:'local independent CA and real streaming TLS proxy, real production API/remote parent/DSH/Office worker, simulated provider/data; native script checks original workbook and raw provider ledger'},null,2));assert.equal(exit.code,0)
}finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve))}await proxy?.close()}
