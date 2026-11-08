import assert from 'node:assert/strict'
import { mkdtemp,mkdir,readFile,writeFile,readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createFileStore,STATE_VERSION } from '../src/store/file-store.mjs'
import { emptySiteRuleState } from '../src/site-rule-state.mjs'
const evidence='/home/gewu/.codex/task-checkpoints/geneway-evidence',root=await mkdtemp(join(evidence,'site-rule-compat-'))
const empty=emptySiteRuleState(),fields=['siteRuleRevisions','siteRuleEvents','siteRuleReads','siteRuleModelReads','siteDiagnosisDrafts']
assert.equal(STATE_VERSION,31);assert.deepEqual(empty,Object.fromEntries(fields.map(field=>[field,[]])))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),json=async path=>JSON.parse(await readFile(path)),donors=[]
const originals=await json(join(evidence,'t24b-original30-AA834r/archive-result.json'))
for(const [index,donor] of originals.donors.entries()){
 const bytes=await readFile(donor.copy),before=JSON.parse(bytes);assert.equal(hash(bytes),donor.sha256);assert.equal(before.version,30)
 for(const field of fields)assert.equal(Object.hasOwn(before,field),false)
 const copy=join(root,`rich-${index}.json`);await writeFile(copy,bytes)
 const expected={...before,version:31,...empty};const store=createFileStore(copy)
 assert.deepEqual(await store.read(),expected);assert.deepEqual(await readFile(copy),bytes)
 await store.update(state=>state);assert.deepEqual(await createFileStore(copy).read(),expected)
 assert.deepEqual(await readFile(donor.copy),bytes);assert.deepEqual(await readFile(donor.source),bytes)
 donors.push({source:donor.source,sha256:donor.sha256,works:before.works.length,routingBatches:before.routingBatches.length})
 for(const [name,mutate] of [...fields.flatMap(field=>[[field+'-nonempty',s=>{s[field]=[{id:'future'}]}],[field+'-wrong-type',s=>{s[field]=null}]]),['work-origin',s=>{s.works[0].origin='rule'}],['work-pin',s=>{s.works[0].siteRule={}}]]){
  const state=structuredClone(before);mutate(state);const path=join(root,`future-${index}-${name}.json`),negative=Buffer.from(JSON.stringify(state));await writeFile(path,negative)
  await assert.rejects(createFileStore(path).read(),error=>error.code==='INVALID_STATE'&&error.message.includes('模拟采集规则事实无效'));assert.deepEqual(await readFile(path),negative)
 }
}
const restore=(input,target)=>spawnSync(process.execPath,['scripts/state-transfer.mjs','restore','--input',input,'--data-root',target],{encoding:'utf8'})
for(const [version,relative] of [[26,'work-member-original26-6WrNui/backup26'],[27,'t03b-original27-gLScNH/backup27'],[28,'t23-original28-a4matH/backup28'],[29,'t24a-original29-i5VCrw/backup29'],[30,'t24b-original30-AA834r/backup30']]){
 const backup=join(evidence,relative),manifest=await json(join(backup,'manifest.json'));assert.equal(manifest.schema.stateVersion,version)
 for(const entry of manifest.entries){const bytes=await readFile(join(backup,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256)}
 const old=await json(join(backup,'state.json')),target=join(root,`restore-${version}`),run=restore(backup,target)
 await writeFile(target+'-stdout.log',run.stdout);await writeFile(target+'-stderr.log',run.stderr);await writeFile(target+'-exit.txt',String(run.status)+'\n');assert.equal(run.status,0,run.stderr)
 assert.deepEqual(await json(join(target,'state.json')),{...old,version:31,...(version===26?{workMemberRemovals:[]}:{}),...(version<28?{a2aProtocol:{tasks:[],groups:[],deliveries:[]}}:{}),...(version<29?{supervisionDiagnosisGrants:[],supervisionDiagnoses:[],supervisionDiagnosisFeedback:[],supervisionToolRejections:[]}:{}),...(version<30?{routingBatches:[]}:{}),...empty})
}
const backup30=join(evidence,'t24b-original30-AA834r/backup30'),ordinary=await json(join(backup30,'state.json')),manifest=await json(join(backup30,'manifest.json'))
for(const field of fields){
 const state={...ordinary,version:31,...empty,[field]:[{id:'unsupported'}]},bytes=Buffer.from(JSON.stringify(state)),input=join(root,'negative-'+field),target=input+'-restore'
 await mkdir(input);await writeFile(join(input,'state.json'),bytes)
 const m=structuredClone(manifest);m.schema.stateVersion=31;const entry=m.entries.find(row=>row.path==='state.json');entry.bytes=bytes.length;entry.sha256=hash(bytes);await writeFile(join(input,'manifest.json'),JSON.stringify(m))
 const rejected=restore(input,target);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/模拟采集规则事实无效/);await assert.rejects(readdir(target),{code:'ENOENT'});await writeFile(target+'-stderr.log',rejected.stderr)
 const output=input+'-backup',run=spawnSync(process.execPath,['scripts/state-transfer.mjs','backup','--output',output],{env:{...process.env,GENEWAY_STATE:join(input,'state.json'),GENEWAY_DSH_HOME:join(root,'absent-dsh')},encoding:'utf8'})
 assert.notEqual(run.status,0);assert.match(run.stderr,/模拟采集规则事实无效/);await assert.rejects(readdir(output),{code:'ENOENT'});await writeFile(output+'-stderr.log',run.stderr)
}
console.log(JSON.stringify({root,donors,ordinaryRestored:[26,27,28,29,30],futureStoreRejects:24,nonemptyTransferRejects:10,boundary:'two original rich views of one run are FileStore donors only; CLI positive inputs are ordinary original backups; no runtime, service, or rule authority acceptance'}))
