import { emptySiteRuleState } from '../src/site-rule-state.mjs'
import { emptySupervisionDiagnosisState } from '../src/supervision-diagnosis-state.mjs'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,readFile,writeFile,cp,readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createFileStore,STATE_VERSION } from '../src/store/file-store.mjs'
const evidence='/home/gewu/.codex/task-checkpoints/geneway-evidence'
const root=await mkdtemp(join(evidence,'work-member-compat-')), hash=b=>createHash('sha256').update(b).digest('hex')
assert.equal(STATE_VERSION,31)
const sources=['protocol-role-baseline-final-DoAjva/result-state.json','protocol-cancel-anp-6fOEXB/business-entry/cancel/final.json']
for(let index=0;index<sources.length;index++){
 const source=join(evidence,sources[index]),bytes=await readFile(source),wrapper=JSON.parse(bytes),before=wrapper.state??wrapper
 assert.equal(before.version,26);assert.equal(Object.hasOwn(before,'workMemberRemovals'),false)
 const path=join(root,`rich-${index}.json`);await writeFile(path,JSON.stringify(before))
 const expected={...before,version:31,...emptySiteRuleState(),routingBatches:[],...emptySupervisionDiagnosisState(),workMemberRemovals:[],a2aProtocol:{tasks:[],groups:[],deliveries:[]}};const store=createFileStore(path)
 assert.deepEqual(await store.read(),expected);await store.update(state=>state);assert.deepEqual(await createFileStore(path).read(),expected)
 assert.deepEqual(await readFile(source),bytes)
}
const backup=join(evidence,'work-member-original26-6WrNui/backup26'),manifest=JSON.parse(await readFile(join(backup,'manifest.json')))
assert.equal(manifest.schema.stateVersion,26)
for(const entry of manifest.entries){const b=await readFile(join(backup,entry.path));assert.equal(b.length,entry.bytes);assert.equal(hash(b),entry.sha256)}
function restore(input,target){return spawnSync(process.execPath,['scripts/state-transfer.mjs','restore','--input',input,'--data-root',target],{encoding:'utf8'})}
const target=join(root,'restored'),success=restore(backup,target);await writeFile(join(root,'restore-stdout.log'),success.stdout);await writeFile(join(root,'restore-stderr.log'),success.stderr);assert.equal(success.status,0,success.stderr)
const old=JSON.parse(await readFile(join(backup,'state.json'))),restored=JSON.parse(await readFile(join(target,'state.json')))
assert.deepEqual(restored,{...old,version:31,...emptySiteRuleState(),routingBatches:[],...emptySupervisionDiagnosisState(),workMemberRemovals:[],a2aProtocol:{tasks:[],groups:[],deliveries:[]}})
for(const [name,mutate] of [
 ['future-deny',state=>{state.workMemberRemovals=[{workspaceId:'local',workId:'untrusted',employeeId:'worker',actorId:'owner',commandId:'deny',acceptedAt:'2026-11-07T00:00:00Z'}]}],
 ['current-deny',state=>{state.version=27;state.workMemberRemovals=[{workspaceId:'local',workId:'untrusted',employeeId:'worker',actorId:'owner',commandId:'deny',acceptedAt:'2026-11-07T00:00:00Z'}]}],
 ['attachments',state=>{state.attachments=[{id:'unsupported'}]}],
 ['model',state=>{state.modelRequests=[{id:'unsupported'}]}],
 ['artifact',state=>{state.artifacts=[{id:'unsupported'}]}],
 ['multisite',state=>{state.nodes=[{id:'unsupported'}]}],
 ...[21,22,23,24,25].map(version=>[`unsupported-${version}`,state=>{state.version=version}]),
 ]){
 const input=join(root,name);await cp(backup,input,{recursive:true});const state=structuredClone(old);mutate(state)
 const b=Buffer.from(JSON.stringify(state,null,2)+'\n');await writeFile(join(input,'state.json'),b)
 const m=structuredClone(manifest);m.schema.stateVersion=state.version;const entry=m.entries.find(row=>row.path==='state.json');entry.bytes=b.length;entry.sha256=hash(b);await writeFile(join(input,'manifest.json'),JSON.stringify(m))
 const destination=join(root,`target-${name}`);const run=restore(input,destination);assert.notEqual(run.status,0,`${name} must fail closed`)
 await assert.rejects(readdir(destination),{code:'ENOENT'});await writeFile(join(root,`${name}-stderr.log`),run.stderr)
}
console.log(JSON.stringify({root,rich26Sources:sources,backup,restoreExit:success.status,negativeCases:11,boundary:'actual FileStore/CLI copies only; invalid cloned transfer packages are negative inputs, not relabeled positive historical sources; no Session execution'}))
