import { createHash } from 'node:crypto';
export const actors = ['coordinator', 'desktop-office', 'desktop-data', 'gateway', 'analysis'];
export const fixture = Object.freeze({
  version: 1, workspaceId: 'local', owner: 'owner',
  agents: actors.map((id, i) => ({ id, nodeId: ['cloud', 'pc-b', 'pc-a', 'gateway', 'analysis'][i], capabilities: [[ 'collaboration.coordinate.v1' ],[ 'office.xlsx.render.v1' ],[ 'evidence.history.read.v1' ],[ 'evidence.site.inspect.v1' ],[ 'analysis.classify.v1' ]][i] })),
  history: Array.from({ length: 20 }, (_, i) => ({ id: `history-${i}`, machine: `fixture-machine-${i % 3}`, observation: `历史短记录 ${i}`, sourceIndex: i })),
  events: Array.from({ length: 20 }, (_, i) => ({ id: `event-${i}`, message: `现场模拟报警 ${i}`, sourceIndex: i })),
  photo: { mediaType: 'image/svg+xml', bytes: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text x="2" y="30">fixture only</text></svg>' },
  revisions: [{ revision: 1, dueDate: null }, { revision: 2, dueDate: '2026-11-20' }, { revision: 3, dueDate: '2026-11-25' }],
  faults: ['result-response-lost', 'same-key-different-body', 'busy-cancel', 'api-restart', 'member-revoked', 'unknown-no-replay'],
});
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const fixtureDigest = digest(fixture);
export const bindingFields = ['work_id','delegation_id','parent_delegation_id','attempt_id','execution_epoch','agent_id','node_id','launch_id','session_id'];
export const binding = row => Object.fromEntries(bindingFields.map(field => [field,row[field] ?? null]));
