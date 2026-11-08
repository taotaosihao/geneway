import assert from 'node:assert/strict';
const candidate=process.argv[2],kind=process.argv[3],root=process.argv[4];
assert(['a2a','anp'].includes(candidate)&&['result-reply','task-service'].includes(kind)&&root,'Usage: recovery-flow.mjs a2a|anp result-reply|task-service ROOT');
process.env.GENEWAY_PROTOCOL_RECOVERY_CASE=kind;
if(kind==='task-service')process.env.GENEWAY_PROTOCOL_BUSINESS_ENTRY='1';
process.argv[3]=root;
await import('./normal-flow.mjs');
