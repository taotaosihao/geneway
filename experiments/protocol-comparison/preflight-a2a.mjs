import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startProgram } from './common/processes.mjs';
import { createLocalCertificate, createA2aClient, applicationMessage, applicationReply } from './common/wire.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-a2a-');
let adapter;
try {
  const tls = await createLocalCertificate(path.join(root, 'tls')), credentials = Object.fromEntries(['owner','coordinator','desktop-office','desktop-data','gateway','analysis','peer-a2a'].map(id => [id, randomBytes(32).toString('base64url')]));
  adapter = await startProgram({ entry: path.join(directory,'adapters/a2a/server.mjs'), root: path.join(root,'adapter-process'), config: { root: path.join(root,'adapter'), tls, credentials } });
  const owner = await createA2aClient({ origin: adapter.ready.origin, token: credentials.owner, caFile: tls.certFile, logFile: path.join(root,'client-wire.jsonl'), targetProcess: adapter.child.pid });
  const message = applicationMessage('create-work', { operation: 'create', parameters: { employeeId: 'coordinator', goal: '相同授权业务fixture：B自主读取A/G并请求独立analysis。', clientRequestId: 'create-work' } });
  const response = await owner.sendMessage(message), created = applicationReply(response);
  assert(created?.workId, JSON.stringify(response));
  const task = await owner.getTask({ id: created.attemptId });
  assert.equal(task.id,created.attemptId); assert.equal(task.contextId,created.workId);
  const repeat = applicationReply(await owner.sendMessage(message)); assert.deepEqual(repeat,created);
  const peer = await createA2aClient({ origin: adapter.ready.origin, token: credentials['peer-a2a'], caFile: tls.certFile, logFile: path.join(root,'peer-client-wire.jsonl') });
  const echo = await peer.sendMessage({ message: { messageId:'independent-direction-placeholder',role:1,parts:[{content:{$case:'text',value:'中文双向预检'},mediaType:'text/plain',filename:''}] } });
  assert.equal(applicationReply(echo).echo,'中文双向预检');
  await writeFile(path.join(root,'result.json'),JSON.stringify({ result:'passed',root,created,task,repeat,echo, boundary:'Actual official SDK client/server over local verified TLS. Independent peer bidirectional X09 is a separate run; this is not X09 completion.' },null,2));
  console.log(JSON.stringify({result:'passed',root,workId:created.workId,boundary:'official SDK v1 TLS + actual Geneway domain; independent peer not yet'}));
} catch(error) { await writeFile(path.join(root,'failure.json'),JSON.stringify({message:error.message,stack:error.stack},null,2)); console.error(root,error);process.exitCode=1; }
finally { if(adapter) await adapter.close(); }
