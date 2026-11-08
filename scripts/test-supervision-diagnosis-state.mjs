import { emptySiteRuleState } from '../src/site-rule-state.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { emptySupervisionDiagnosisState,validateSupervisionDiagnosisState,assertSupervisionDiagnosisImmutable,validateSupervisionDiagnosisLedger } from '../src/supervision-diagnosis-state.mjs'
const source='/home/gewu/.codex/task-checkpoints/geneway-evidence/t23-original28-a4matH/donors/a2a-collaboration-native-GYVANs__completed-state.json'
const original=JSON.parse(await readFile(source)),state={...structuredClone(original),version:31,...emptySiteRuleState(),routingBatches:[],...emptySupervisionDiagnosisState()}
validateSupervisionDiagnosisState(state)
for(const field of Object.keys(emptySupervisionDiagnosisState()))for(const value of [null,{},[{id:'missing-required-fields'}]]){const bad=structuredClone(state);bad[field]=value;assert.throws(()=>validateSupervisionDiagnosisState(bad))}
const attempt=state.multisite.attempts[0]
state.supervisionToolRejections.push({id:'component-rejection',workspaceId:attempt.workspace_id??'local',subjectBinding:Object.fromEntries(['work_id','delegation_id','parent_delegation_id','attempt_id','execution_epoch','agent_id','node_id','launch_id','session_id'].map(key=>[key,attempt[key]])),instructionRevision:attempt.instruction_revision,clientRequestId:'component-only',tool:'complete_delegation',code:'RESULT_SCHEMA_INVALID',observedAt:new Date().toISOString()})
validateSupervisionDiagnosisState(state)
for(const mutate of [s=>s.supervisionToolRejections.pop(),s=>{s.supervisionToolRejections[0].code='rewritten'}]){const after=structuredClone(state);mutate(after);assert.throws(()=>assertSupervisionDiagnosisImmutable(state,after))}
for(const field of ['work_id','attempt_id','accountingVersion','resumedFromHoldId'])assert.throws(()=>validateSupervisionDiagnosisLedger(state,{purpose:'supervision_diagnosis',[field]:'forbidden'}))
assert.deepEqual(state.modelRequests,original.modelRequests)
console.log(JSON.stringify({source,checks:'empty strict arrays/required structures; tool-rejection append immutable; diagnosis ledger rejects missing and top-level business fields; old ledger unchanged',boundary:'pure structure clones only; constructed rejection is not a real authorized tool observation; no positive diagnosis authority/Session/forward or native proof'}))
