import { emptySiteRuleState } from '../src/site-rule-state.mjs'
import assert from 'node:assert/strict'
import { mkdtemp,readFile,writeFile,cp,readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const emptyRoutingState=()=>({routingBatches:[]})
import { createFileStore,STATE_VERSION,migrateState } from '../src/store/file-store.mjs'
import {validateRoutingLedger} from '../src/routing-gateway.mjs'
const evidence='/home/gewu/.codex/task-checkpoints/geneway-evidence',root=await mkdtemp(join(evidence,'routing-batch-compat-')),empty={tasks:[],groups:[],deliveries:[]}
assert.equal(STATE_VERSION,31)
const sources=['t24a-original29-i5VCrw/donors/BpDS2q-terminal-cloud.json','t24a-original29-i5VCrw/donors/GtVo9h-terminal-cloud.json','t24a-original29-i5VCrw/donors/wM1WZQ-terminal-cloud.json']
for(let i=0;i<sources.length;i++){
 const source=join(evidence,sources[i]),bytes=await readFile(source),before=JSON.parse(bytes);assert.equal(before.version,29);for(const field of Object.keys(emptyRoutingState()))assert.equal(Object.hasOwn(before,field),false)
 const path=join(root,`rich-${i}.json`);await writeFile(path,bytes)
 const expected={...before,version:31,...emptySiteRuleState(),...emptyRoutingState()}
 assert.deepEqual(await createFileStore(path).read(),expected);await createFileStore(path).update(state=>state);assert.deepEqual(await createFileStore(path).read(),expected);assert.deepEqual(await readFile(source),bytes)
 for(const field of Object.keys(emptyRoutingState()))for(const bad of [null,{},[{id:'future'}]]){const input={...before,[field]:bad},target=join(root,`future-${i}-${Math.random()}.json`);await writeFile(target,JSON.stringify(input));await assert.rejects(createFileStore(target).read());assert.deepEqual(JSON.parse(await readFile(target)),input)}
 for(const [name,mutate] of [['request-version',s=>s.routingRequests.push({routingVersion:2})],['request-key',s=>s.routingRequests.push({compatibilityKey:'future'})],['model-version',s=>s.modelRequests.push({purpose:'routing',routingVersion:2})],['model-members',s=>s.modelRequests.push({purpose:'routing',routingVersion:1,members:[]})]]){const input=structuredClone(before);mutate(input);const target=join(root,`future-marker-${i}-${name}.json`);await writeFile(target,JSON.stringify(input));await assert.rejects(createFileStore(target).read(),/旧版本状态不得包含批量路由事实/);assert.deepEqual(JSON.parse(await readFile(target)),input)}
}
// Accepted native-format predecessor, with real single v1 model rows. FileStore
// compatibility is independent of the older ordinary CLI restore whitelist.
const singleSource=join(evidence,'interaction-routing-BSmBtC/state-final.json'),singleBytes=await readFile(singleSource),single=JSON.parse(singleBytes)
assert.equal(single.version,23)
const legacyRows=single.modelRequests.filter(row=>row.purpose==='routing'&&row.routingVersion===1)
assert.equal(legacyRows.length,2)
const expectedSingle={...single,version:31,...emptySiteRuleState(),manualControls:[],contextReadInstances:[],contextReadWindows:[],contextReads:[],supervisionFindings:[],supervisionActions:[],workMemberRemovals:[],a2aProtocol:empty,supervisionDiagnosisGrants:[],supervisionDiagnoses:[],supervisionDiagnosisFeedback:[],supervisionToolRejections:[],routingBatches:[]}
assert.deepEqual(migrateState(structuredClone(single)),expectedSingle)
const singleCopy=join(root,'legacy-single-v1.json');await writeFile(singleCopy,singleBytes)
const singleStore=createFileStore(singleCopy);assert.deepEqual(await singleStore.read(),expectedSingle)
await singleStore.update(state=>state)
const singleReopened=await createFileStore(singleCopy).read();assert.deepEqual(singleReopened,expectedSingle)
for(const row of legacyRows)validateRoutingLedger(singleReopened,row)
assert.deepEqual(await readFile(singleSource),singleBytes)
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const restore=(input,target)=>spawnSync(process.execPath,['scripts/state-transfer.mjs','restore','--input',input,'--data-root',target],{encoding:'utf8'})
for(const [version,relative] of [[26,'work-member-original26-6WrNui/backup26'],[27,'t03b-original27-gLScNH/backup27'],[28,'t23-original28-a4matH/backup28'],[29,'t24a-original29-i5VCrw/backup29']]){
 const backup=join(evidence,relative),manifest=JSON.parse(await readFile(join(backup,'manifest.json')));assert.equal(manifest.schema.stateVersion,version)
 for(const entry of manifest.entries){const b=await readFile(join(backup,entry.path));assert.equal(b.length,entry.bytes);assert.equal(hash(b),entry.sha256)}
 const old=JSON.parse(await readFile(join(backup,'state.json'))),target=join(root,`restore-${version}`),run=restore(backup,target)
 await writeFile(join(root,`restore-${version}-stdout.log`),run.stdout);await writeFile(join(root,`restore-${version}-stderr.log`),run.stderr);assert.equal(run.status,0,run.stderr)
 assert.deepEqual(JSON.parse(await readFile(join(target,'state.json'))),{...old,version:31,...emptySiteRuleState(),...(version===26?{workMemberRemovals:[]}:{}),...(version<28?{a2aProtocol:empty}:{}),...(version<29?{supervisionDiagnosisGrants:[],supervisionDiagnoses:[],supervisionDiagnosisFeedback:[],supervisionToolRejections:[]}:{}),...emptyRoutingState()})
 for(const [name,mutate] of [['future-nonempty',s=>{s.routingBatches=[{id:'unsupported'}]}],['future-malformed',s=>{s.routingBatches=null}],['current-nonempty',s=>{s.version=31;s.routingBatches=[{id:'unsupported'}]}],['future-purpose',s=>{s.modelRequests=[{purpose:'routing',routingVersion:2,members:[]}]}],...[21,22,23,24,25].map(v=>['version-'+v,s=>{s.version=v}])]){
  const input=join(root,`${version}-${name}`);await cp(backup,input,{recursive:true});const state=structuredClone(old);mutate(state);const bytes=Buffer.from(JSON.stringify(state,null,2)+'\n');await writeFile(join(input,'state.json'),bytes)
  const m=structuredClone(manifest);m.schema.stateVersion=state.version;const e=m.entries.find(row=>row.path==='state.json');e.bytes=bytes.length;e.sha256=hash(bytes);await writeFile(join(input,'manifest.json'),JSON.stringify(m))
  const destination=input+'-target',bad=restore(input,destination);assert.notEqual(bad.status,0);await assert.rejects(readdir(destination),{code:'ENOENT'});await writeFile(input+'-stderr.log',bad.stderr)
 }
}
for(const field of Object.keys(emptyRoutingState())) {
 const input=join(root,'backup-reject-'+field+'.json'),output=join(root,'backup-reject-'+field)
 const state=JSON.parse(await readFile(join(evidence,'t24a-original29-i5VCrw/ordinary/state.json')));state.version=31;Object.assign(state,emptyRoutingState());state[field]=[{id:'unsupported'}]
 await writeFile(input,JSON.stringify(state))
 const run=spawnSync(process.execPath,['scripts/state-transfer.mjs','backup','--output',output],{env:{...process.env,GENEWAY_STATE:input,GENEWAY_DSH_HOME:join(root,'absent-dsh')},encoding:'utf8'})
 assert.notEqual(run.status,0);await assert.rejects(readdir(output),{code:'ENOENT'});await writeFile(output+'-stderr.log',run.stderr)
}
console.log(JSON.stringify({root,sources,legacySingle:{source:singleSource,sourceVersion:single.version,routingV1Rows:legacyRows.length},ordinaryBackupVersions:[26,27,28,29],targetVersion:31,negativeTransfers:36,boundary:'real archived bytes and production FileStore/CLI only; malformed cloned transfers are negative tests, not historical sources; no runtime or diagnosis/native execution claim'}))
