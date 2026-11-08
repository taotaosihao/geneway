import { emptySiteRuleState } from '../src/site-rule-state.mjs'
import assert from 'node:assert/strict'
import { mkdtemp,readFile,writeFile,cp,readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { emptySupervisionDiagnosisState } from '../src/supervision-diagnosis-state.mjs'
import { createFileStore,STATE_VERSION } from '../src/store/file-store.mjs'
const evidence='/home/gewu/.codex/task-checkpoints/geneway-evidence',root=await mkdtemp(join(evidence,'supervision-diagnosis-compat-')),empty={tasks:[],groups:[],deliveries:[]}
assert.equal(STATE_VERSION,31)
const sources=['t23-original28-a4matH/donors/a2a-collaboration-native-GYVANs__completed-state.json','t23-original28-a4matH/donors/r15-session-compat-20261107-1__api__state.json']
for(let i=0;i<sources.length;i++){
 const source=join(evidence,sources[i]),bytes=await readFile(source),before=JSON.parse(bytes);assert.equal(before.version,28);for(const field of Object.keys(emptySupervisionDiagnosisState()))assert.equal(Object.hasOwn(before,field),false)
 const path=join(root,`rich-${i}.json`);await writeFile(path,bytes)
 const expected={...before,version:31,...emptySiteRuleState(),routingBatches:[],...emptySupervisionDiagnosisState()}
 assert.deepEqual(await createFileStore(path).read(),expected);await createFileStore(path).update(state=>state);assert.deepEqual(await createFileStore(path).read(),expected);assert.deepEqual(await readFile(source),bytes)
 for(const field of Object.keys(emptySupervisionDiagnosisState()))for(const bad of [null,{},[{id:'future'}]]){const input={...before,[field]:bad},target=join(root,`future-${i}-${Math.random()}.json`);await writeFile(target,JSON.stringify(input));await assert.rejects(createFileStore(target).read());assert.deepEqual(JSON.parse(await readFile(target)),input)}
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const restore=(input,target)=>spawnSync(process.execPath,['scripts/state-transfer.mjs','restore','--input',input,'--data-root',target],{encoding:'utf8'})
for(const [version,relative] of [[26,'work-member-original26-6WrNui/backup26'],[27,'t03b-original27-gLScNH/backup27'],[28,'t23-original28-a4matH/backup28']]){
 const backup=join(evidence,relative),manifest=JSON.parse(await readFile(join(backup,'manifest.json')));assert.equal(manifest.schema.stateVersion,version)
 for(const entry of manifest.entries){const b=await readFile(join(backup,entry.path));assert.equal(b.length,entry.bytes);assert.equal(hash(b),entry.sha256)}
 const old=JSON.parse(await readFile(join(backup,'state.json'))),target=join(root,`restore-${version}`),run=restore(backup,target)
 await writeFile(join(root,`restore-${version}-stdout.log`),run.stdout);await writeFile(join(root,`restore-${version}-stderr.log`),run.stderr);assert.equal(run.status,0,run.stderr)
 assert.deepEqual(JSON.parse(await readFile(join(target,'state.json'))),{...old,version:31,...emptySiteRuleState(),routingBatches:[],...(version===26?{workMemberRemovals:[]}:{}),...(version<28?{a2aProtocol:empty}:{}),...emptySupervisionDiagnosisState()})
 for(const [name,mutate] of [['future-nonempty',s=>{s.supervisionDiagnoses=[{id:'unsupported'}]}],['future-malformed',s=>{s.supervisionDiagnoses=null}],['current-nonempty',s=>{s.version=31;s.supervisionDiagnosisFeedback=[{id:'unsupported'}]}],['future-purpose',s=>{s.modelRequests=[{purpose:'supervision_diagnosis'}]}],...[21,22,23,24,25].map(v=>['version-'+v,s=>{s.version=v}])]){
  const input=join(root,`${version}-${name}`);await cp(backup,input,{recursive:true});const state=structuredClone(old);mutate(state);const bytes=Buffer.from(JSON.stringify(state,null,2)+'\n');await writeFile(join(input,'state.json'),bytes)
  const m=structuredClone(manifest);m.schema.stateVersion=state.version;const e=m.entries.find(row=>row.path==='state.json');e.bytes=bytes.length;e.sha256=hash(bytes);await writeFile(join(input,'manifest.json'),JSON.stringify(m))
  const destination=input+'-target',bad=restore(input,destination);assert.notEqual(bad.status,0);await assert.rejects(readdir(destination),{code:'ENOENT'});await writeFile(input+'-stderr.log',bad.stderr)
 }
}
for(const field of Object.keys(emptySupervisionDiagnosisState())) {
 const input=join(root,'backup-reject-'+field+'.json'),output=join(root,'backup-reject-'+field)
 const state=JSON.parse(await readFile(join(evidence,'t23-original28-a4matH/ordinary/state.json')));state.version=31;Object.assign(state,emptySupervisionDiagnosisState());state[field]=[{id:'unsupported'}]
 await writeFile(input,JSON.stringify(state))
 const run=spawnSync(process.execPath,['scripts/state-transfer.mjs','backup','--output',output],{env:{...process.env,GENEWAY_STATE:input,GENEWAY_DSH_HOME:join(root,'absent-dsh')},encoding:'utf8'})
 assert.notEqual(run.status,0);await assert.rejects(readdir(output),{code:'ENOENT'});await writeFile(output+'-stderr.log',run.stderr)
}
console.log(JSON.stringify({root,sources,ordinaryBackupVersions:[26,27,28],targetVersion:31,negativeTransfers:27,boundary:'real archived bytes and production FileStore/CLI only; malformed cloned transfers are negative tests, not historical sources; no runtime or diagnosis/native execution claim'}))
