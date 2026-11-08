import { emptySiteRuleState } from '../src/site-rule-state.mjs'
import { emptySupervisionDiagnosisState } from '../src/supervision-diagnosis-state.mjs'
import assert from 'node:assert/strict'
import { mkdtemp,readFile,writeFile,cp,readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createFileStore,STATE_VERSION } from '../src/store/file-store.mjs'
const evidence='/home/gewu/.codex/task-checkpoints/geneway-evidence',root=await mkdtemp(join(evidence,'a2a-compat-')),empty={tasks:[],groups:[],deliveries:[]}
assert.equal(STATE_VERSION,31)
const sources=['t03b-original27-gLScNH/donors/work-member-http-JDD8os__api__state.json','t03b-original27-gLScNH/donors/work-member-job-JFdw78__api__state.json','protocol-role-baseline-final-DoAjva/result-state.json']
for(let i=0;i<sources.length;i++){
 const source=join(evidence,sources[i]),bytes=await readFile(source),before=JSON.parse(bytes);assert.ok([26,27].includes(before.version));assert.equal(Object.hasOwn(before,'a2aProtocol'),false)
 const path=join(root,`rich-${i}.json`);await writeFile(path,bytes)
 const expected={...before,version:31,...emptySiteRuleState(),routingBatches:[],...emptySupervisionDiagnosisState(),...(before.version===26?{workMemberRemovals:[]}:{}),a2aProtocol:empty}
 assert.deepEqual(await createFileStore(path).read(),expected);await createFileStore(path).update(state=>state);assert.deepEqual(await createFileStore(path).read(),expected);assert.deepEqual(await readFile(source),bytes)
 for(const bad of [null,[],{tasks:[{id:'future'}],groups:[],deliveries:[]}]){const input={...before,a2aProtocol:bad},target=join(root,`future-${i}-${Math.random()}.json`);await writeFile(target,JSON.stringify(input));await assert.rejects(createFileStore(target).read());assert.deepEqual(JSON.parse(await readFile(target)),input)}
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const restore=(input,target)=>spawnSync(process.execPath,['scripts/state-transfer.mjs','restore','--input',input,'--data-root',target],{encoding:'utf8'})
for(const [version,relative] of [[26,'work-member-original26-6WrNui/backup26'],[27,'t03b-original27-gLScNH/backup27']]){
 const backup=join(evidence,relative),manifest=JSON.parse(await readFile(join(backup,'manifest.json')));assert.equal(manifest.schema.stateVersion,version)
 for(const entry of manifest.entries){const b=await readFile(join(backup,entry.path));assert.equal(b.length,entry.bytes);assert.equal(hash(b),entry.sha256)}
 const old=JSON.parse(await readFile(join(backup,'state.json'))),target=join(root,`restore-${version}`),run=restore(backup,target)
 await writeFile(join(root,`restore-${version}-stdout.log`),run.stdout);await writeFile(join(root,`restore-${version}-stderr.log`),run.stderr);assert.equal(run.status,0,run.stderr)
 assert.deepEqual(JSON.parse(await readFile(join(target,'state.json'))),{...old,version:31,...emptySiteRuleState(),routingBatches:[],...emptySupervisionDiagnosisState(),...(version===26?{workMemberRemovals:[]}:{}),a2aProtocol:empty})
 for(const [name,mutate] of [['future-nonempty',s=>{s.a2aProtocol={tasks:[{id:'unsupported'}],groups:[],deliveries:[]}}],['future-malformed',s=>{s.a2aProtocol=null}],['current-nonempty',s=>{s.version=31;s.a2aProtocol={tasks:[],groups:[{id:'unsupported'}],deliveries:[]}}],...[21,22,23,24,25].map(v=>['version-'+v,s=>{s.version=v}])]){
  const input=join(root,`${version}-${name}`);await cp(backup,input,{recursive:true});const state=structuredClone(old);mutate(state);const bytes=Buffer.from(JSON.stringify(state,null,2)+'\n');await writeFile(join(input,'state.json'),bytes)
  const m=structuredClone(manifest);m.schema.stateVersion=state.version;const e=m.entries.find(row=>row.path==='state.json');e.bytes=bytes.length;e.sha256=hash(bytes);await writeFile(join(input,'manifest.json'),JSON.stringify(m))
  const destination=input+'-target',bad=restore(input,destination);assert.notEqual(bad.status,0);await assert.rejects(readdir(destination),{code:'ENOENT'});await writeFile(input+'-stderr.log',bad.stderr)
 }
}
console.log(JSON.stringify({root,sources,ordinaryBackupVersions:[26,27],targetVersion:31,negativeTransfers:16,boundary:'real archived bytes and production FileStore/CLI only; malformed cloned transfers are negative tests, not historical sources; no runtime or nonempty group validation claim'}))
