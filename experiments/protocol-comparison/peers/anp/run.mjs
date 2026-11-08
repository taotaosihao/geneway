import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const AWIKI_CHECKOUT = '/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-comparison-sources/awiki-open-server'
export const AWIKI_COMMIT = '09d38fd8afc803c16ab61cd629c0c8ea3747edc6'
const python = join(AWIKI_CHECKOUT,'.venv/bin/python'),exec = promisify(execFile)
export async function startAnpPeer({ root, host = '127.0.0.1', port = 0, didDomain, resolverBaseUrls = {} }) {
  assert.equal(host,'127.0.0.1');root=resolve(root);await mkdir(root,{recursive:true,mode:0o700})
  const commit=(await exec('git',['rev-parse','HEAD'],{cwd:AWIKI_CHECKOUT})).stdout.trim();assert.equal(commit,AWIKI_COMMIT)
  let previous;try{previous=JSON.parse(await readFile(join(root,'peer-config.json'),'utf8'))}catch(cause){if(cause.code!=='ENOENT')throw cause}
  if(previous){assert.equal(previous.root,root);port ||= previous.port;didDomain ??= previous.didDomain;resolverBaseUrls={...previous.resolverBaseUrls,...resolverBaseUrls}}
  if(!port){const reserve=createServer();await new Promise(resolve=>reserve.listen(0,host,resolve));port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve))}
  didDomain??='peer-'+basename(root).toLowerCase().replace(/[^a-z0-9]/g,'').slice(-24)+'.test';const origin=`http://${host}:${port}`,configPath=join(root,'peer-config.json'),config={root,host,port,origin,didDomain,resolverBaseUrls:{...resolverBaseUrls,[didDomain]:origin}}
  if(previous)assert.equal(previous.origin,origin,'Preserve the existing peer origin or create an isolated new identity root')
  await writeFile(configPath,JSON.stringify(config,null,2),{mode:0o600})
  const child=spawn(python,[fileURLToPath(new URL('./server.py',import.meta.url)),configPath],{cwd:AWIKI_CHECKOUT,env:{PATH:process.env.PATH,HOME:root,PYTHONPATH:join(AWIKI_CHECKOUT,'src')},stdio:['ignore','pipe','pipe']});const exit=new Promise(done=>child.once('exit',(code,signal)=>done({code,signal,pid:child.pid,at:new Date().toISOString()})))
  for(const stream of['stdout','stderr'])child[stream].on('data',bytes=>{void appendFile(join(root,'server.'+stream+'.log'),bytes);process.stderr.write(bytes)})
  let closed=false
  async function close(){if(closed)return;closed=true;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const result=await exit;await writeFile(join(root,'process-exit.json'),JSON.stringify(result,null,2))}
  try{
    const deadline=Date.now()+20000;for(;;){assert(child.exitCode===null&&child.signalCode===null,'AWiki peer exited during startup');try{const response=await fetch(origin+'/healthz');if(response.ok)break}catch{}assert(Date.now()<deadline,'AWiki healthz timeout');await new Promise(done=>setTimeout(done,50))}
    const document=await(await fetch(origin+'/.well-known/did.json')).json();await writeFile(join(root,'service-did-document.json'),JSON.stringify(document,null,2));assert.equal(document.id,'did:wba:'+didDomain)
    const metadata=JSON.parse((await exec(python,['-c','import sys,json,importlib.metadata as m;print(json.dumps({"python":sys.version.split()[0],"awiki":m.version("awiki-open-server"),"anpPython":m.version("anp")}))'],{cwd:AWIKI_CHECKOUT})).stdout),versions={...metadata,awikiCommit:commit},identity={serviceDid:document.id,didDomain,document,documentUrl:origin+'/.well-known/did.json',resolverBaseUrls:config.resolverBaseUrls,configPath}
    await writeFile(join(root,'process-ready.json'),JSON.stringify({event:'ready',origin,pid:child.pid,protocol:'anp',versions,identity},null,2));return{origin,child,identity,versions,close}
  }catch(cause){await close();throw cause}
}
export function createPeerIdentity(peer,{handle='peer-owner'}={}){return peerCommand(peer,{operation:'identity',handle})}
export async function peerCommand(peer,command){const configPath=peer.identity?.configPath??peer.configPath;assert(configPath);return new Promise((done,reject)=>{const child=spawn(python,[fileURLToPath(new URL('./member.py',import.meta.url)),configPath],{cwd:AWIKI_CHECKOUT,env:{PATH:process.env.PATH,PYTHONPATH:join(AWIKI_CHECKOUT,'src')},stdio:['pipe','pipe','pipe']}),stdout=[],stderr=[];child.stdout.on('data',chunk=>stdout.push(chunk));child.stderr.on('data',chunk=>stderr.push(chunk));child.once('error',reject);child.once('exit',code=>{if(code!==0)return reject(new Error('Independent peer member command failed: '+Buffer.concat(stderr)));try{done(JSON.parse(Buffer.concat(stdout)))}catch(cause){reject(cause)}});child.stdin.end(JSON.stringify(command))})}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const file=process.argv[process.argv.indexOf('--config')+1];assert(file&&process.argv.includes('--config'));const peer=await startAnpPeer(JSON.parse(await readFile(file,'utf8')));console.log(JSON.stringify({event:'ready',origin:peer.origin,pid:peer.child.pid,protocol:'anp',versions:peer.versions}));for(const signal of['SIGTERM','SIGINT'])process.on(signal,()=>{void peer.close().then(()=>process.exit(0))})}
