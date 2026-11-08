import assert from 'node:assert/strict'
import { readFile,mkdtemp,writeFile } from 'node:fs/promises'
import { createFileStore } from '../src/store/file-store.mjs'
import { removeWorkMember, workMemberAffected, assertWorkMemberAccess, workMembersProjection, validateWorkMemberRemovalState, assertWorkMemberRemovalImmutable } from '../src/work-member-removal.mjs'
const source='/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-role-baseline-final-DoAjva/result-state.json'
const original=JSON.parse(await readFile(source,'utf8')), state=structuredClone(original)
state.workMemberRemovals=[]
const work=state.works.find(row=>row.workType==='multisite'), actor=state.members.find(row=>row.id===work.ownerMemberId)
const child=state.multisite.attempts.find(row=>row.agent_id==='desktop-data'), parent=state.multisite.attempts.find(row=>row.agent_id==='coordinator')
const queued=[], options={at:new Date().toISOString(),queue:(_state,attempt,operation)=>queued.push({attemptId:attempt.attempt_id,operation}),closeQuestions:()=>{}}
assert.throws(()=>removeWorkMember(state,work,{id:'peer'},child.agent_id,'wrong-owner',options))
assert.throws(()=>removeWorkMember(state,work,actor,'nonparticipant','wrong-subject',options))
assert.equal(state.workMemberRemovals.length,0)
removeWorkMember(state,work,actor,child.agent_id,'remove-child',options)
validateWorkMemberRemovalState(state)
assert.equal(state.workMemberRemovals.length,1);assert.equal(workMemberAffected(state,child),true);assert.equal(workMemberAffected(state,parent),false)
assert.throws(()=>assertWorkMemberAccess(state,work.id,child.agent_id));assert.doesNotThrow(()=>assertWorkMemberAccess(state,'another-work',child.agent_id))
const count=queued.length;removeWorkMember(state,work,actor,child.agent_id,'new-command-same-subject',options);assert.equal(queued.length,count)
assert.notEqual(work.status,'cancelled');assert.deepEqual(state.modelRequests,original.modelRequests);assert.deepEqual(state.multisite.results,original.multisite.results)
const projection=workMembersProjection(state,work,actor).find(row=>row.employeeId===child.agent_id)
assert.equal(projection.access,'removed');assert.equal(projection.protocolGroup,'not_applicable')
const before=structuredClone(state)
for(const mutate of [value=>value.workMemberRemovals.pop(),value=>{value.workMemberRemovals[0].commandId='rewritten'}]){const after=structuredClone(state);mutate(after);assert.throws(()=>assertWorkMemberRemovalImmutable(before,after))}
const duplicate=structuredClone(state);duplicate.workMemberRemovals.push({...duplicate.workMemberRemovals[0]});assert.throws(()=>validateWorkMemberRemovalState(duplicate))
const directory=await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/work-member-state-')
const path=directory+'/state.json';await writeFile(path,JSON.stringify(original))
await createFileStore(path).update(next=>{const w=next.works.find(row=>row.id===work.id);removeWorkMember(next,w,next.members.find(row=>row.id===actor.id),child.agent_id,'persist-denial',options);return next})
const persisted=await createFileStore(path).read();assert.equal(persisted.version,27);assert.equal(persisted.workMemberRemovals.length,1)
await assert.rejects(createFileStore(path).update(next=>{next.workMemberRemovals=[];return next}))
assert.deepEqual((await createFileStore(path).read()).workMemberRemovals,persisted.workMemberRemovals)
console.log(JSON.stringify({source,directory,checks:'owner/participant,work-local denial,independent-parent,subject-idempotency,history/unknown preservation,projection,append-only/duplicate',boundary:'pure component with captured queue callbacks; no claim of actual cleanup/HTTP/OS stop'}))
