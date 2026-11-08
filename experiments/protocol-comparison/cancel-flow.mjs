import assert from 'node:assert/strict';
assert(['a2a','anp'].includes(process.argv[2])&&process.argv[3],'Usage: cancel-flow.mjs a2a|anp UNIQUE_ROOT');
process.env.GENEWAY_PROTOCOL_BUSINESS_ENTRY='1';process.env.GENEWAY_PROTOCOL_CANCEL='1';
process.argv.push('--busy-stop');
await import('./normal-flow.mjs');
