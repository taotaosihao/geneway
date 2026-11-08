import { captureWorkMemberSources } from './fixtures/multisite/work-member-sources.mjs'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { seedDelegation, childRequest } from './fixtures/multisite/delegation.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createEvidenceCaptures } from '../packages/agent-host/evidence-captures.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/work-member-http-'), owner = { id: 'owner' }, peers = new Map()
const nodeFor = id => ({ coordinator: 'cloud', 'desktop-office': 'pc-b', 'desktop-data': 'pc-a', gateway: 'gateway', analysis: 'analysis' })[id]
const bodies = [], observations = [], uiMode = process.argv.includes('--ui')
let uiDriver, uiExit, attachmentGate, pendingAttachment
const provider = createServer(async (request, response) => {const chunks=[]; for await (const chunk of request) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks))); response.writeHead(200, {'content-type':'text/event-stream'}); response.end('data: {\"choices\":[{\"delta\":{\"content\":\"正常授权请求\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n')})
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve))
await captureWorkMemberSources(directory,'start',['scripts/test-work-member-removal.mjs','scripts/probe-work-member-removal-ui.mjs'])
const fixture = await startBridgeService({ directory: join(directory, 'api'), ...(uiMode ? {index: await readFile('web/index.html','utf8')} : {}), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`, seedState(state) { seedDelegation(state); for (const row of state.employees) { row.placement.nodeId = nodeFor(row.id); row.placement.resourceRefs = row.id === 'desktop-data' ? ['fixture:history'] : row.id === 'gateway' ? ['fixture:site'] : [] }; return state } })
const execution = async id => (await peers.get(id).journal.read()).executions.findLast(row => row.agent_id === id)
async function pump() {
  for (let i = 0; i < 3; i++) for (const peer of peers.values()) {
    for (const command of (await peer.client.resync()).pending) { await peer.host.accept({ workspaceId: 'local', nodeId: peer.nodeId }, command); await peer.client.ack(command) }
    await peer.host.process(); await peer.host.flushEvents(event => peer.client.event(event))
  }
}
const call = async (id, operation, parameters) => peers.get(id).runtime.orchestration(await execution(id), operation, { instructionRevision: 1, ...parameters })
const read = async (id, ref) => peers.get(id).runtime.evidence(await execution(id), 'read_shared_evidence', { ref })


try {
  const readerIds = ['desktop-office', 'desktop-data', 'gateway', 'analysis']
  for (const agentId of readerIds) {
    const nodeId = nodeFor(agentId), root = join(directory, agentId); await mkdir(root, { recursive: true })
    const pair = await fixture.nodes.createPairing(owner, { clientRequestId: `pair-${nodeId}`, nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: [agentId], expiresAt: new Date(Date.now() + 120000).toISOString() })
    const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity })
    const paired = await client.post('/internal/nodes/pair', { pairingId: pair.pairingId, pairingCode: pair.pairingCode, clientRequestId: 'redeem', ...identity }); Object.assign(identity, { nodeId, registrationRevision: paired.node.registrationRevision })
    const resources = []
    if (agentId === 'desktop-data' || agentId === 'gateway') {
      const history = agentId === 'desktop-data', resourceId = history ? 'fixture:history' : 'fixture:site', cap = history ? 'evidence.history.read.v1' : 'evidence.site.inspect.v1', sourceRoot = join(root, 'source'); await mkdir(sourceRoot)
      const source = history ? { format: 'geneway.incident-history', version: 1, entries: Array.from({ length: 20 }, (_, i) => ({ date: '2026-11-01', description: `独立历史${i}`, owner: '测试员' })) } : { sourceTime: null, health: { connection: 'unknown', lastSuccessAt: null, queueDepth: null }, events: Array.from({ length: 20 }, (_, i) => ({ sourceEventId: `event-${i}`, sourceTimestamp: null, code: 'ALARM', severity: 'unknown', message: `独立事件${i}` })) }
      await writeFile(join(sourceRoot, 'source.json'), JSON.stringify(source))
      await fixture.nodes.putResource(owner, resourceId, { clientRequestId: `resource-${nodeId}`, expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: history ? 'history_directory' : 'site_diagnostics', ownerNodeId: nodeId, capabilityIds: [cap], evidenceReaderAgentIds: readerIds, enabled: true })
      resources.push({ resourceId, capabilityIds: [cap], adapterKind: history ? 'history_json' : 'site_snapshot_json', root: sourceRoot, datasets: { history: 'source.json' }, fixedFiles: { snapshot: 'source.json' }, allowedSections: ['collector_health', 'recent_events'], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: process.argv.includes('--denied-export') ? readerIds.filter(id => id !== 'analysis') : readerIds, clockTrust: 'fixture' })
    }
    const journal = createHostJournal(join(root, 'host.json')), runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') }), evidence = createEvidenceCaptures({ journal, root: join(root, 'sealed'), profile: { profileVersion: 1, resources }, client })
    // This simulator persists attachment-bearing deliveries; byte access below is real HTTP.
    if (process.argv.includes('--attachment-race')) runtime.supportsAttachments = true
    const host = createAgentHost({ nodeId, journal, runtime, evidence }); host.setOrchestrationHandler({ call: (execution, operation, parameters) => client.command(execution, operation, parameters), event: event => client.event(event) }); peers.set(agentId, { journal, runtime, client, host, nodeId, identity })
  }

  if(uiMode){const served=await fetch(fixture.origin);await writeFile(join(directory,'served-index.html'),await served.text())}
  await mkdir(join(directory,'api/secrets'),{recursive:true}); await writeFile(join(directory,'api/secrets/key'),'synthetic-member-key',{mode:0o600})
  const login=await fetch(fixture.origin+'/api/session',{method:'POST',headers:{origin:fixture.origin,'content-type':'application/json'},body:JSON.stringify({loginName:'owner',password:'synthetic owner password'})}),session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0]
  async function api(path,body,expected=200){const response=await fetch(fixture.origin+path,{method:body?'POST':'GET',headers:{origin:fixture.origin,cookie,'x-csrf-token':session.csrfToken,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),value=await response.json();observations.push({path,status:response.status,value});assert.equal(response.status,expected,JSON.stringify(value));return value}
  let attachment, attachmentBytes
  if(process.argv.includes('--attachment-race')){attachmentBytes=Buffer.from(JSON.stringify({format:'geneway.incident-history',version:1,entries:[{date:'2026-11-01',description:'只给获准本工作执行的原附件',owner:'测试'}]}));attachment=await fixture.attachments.init(owner,{clientRequestId:'member-photo',name:'history.json',mediaType:'application/json',sizeBytes:attachmentBytes.length,sha256:createHash('sha256').update(attachmentBytes).digest('hex')});await fixture.attachments.upload(owner,attachment.id,Readable.from([attachmentBytes]))}
  const work=await api('/api/works',{workType:'multisite',employeeId:'desktop-office',goal:'本工作精确移除与证据读者',clientRequestId:'create',...(attachment?{attachmentRefs:[attachment.ref]}:{})});const workId=work.value?.id??work.workId??work.id; assert(workId);await pump()
  const a=await call('desktop-office','delegate',childRequest('delegate-a','desktop-data')),g=await call('desktop-office','delegate',childRequest('delegate-g','gateway')); await pump()
  const captured=await peers.get('desktop-data').runtime.evidence(await execution('desktop-data'),'read_history',{clientRequestId:'capture',instructionRevision:1,resourceId:'fixture:history',datasetId:'history'})
  const share=await call('desktop-office','share_evidence',{clientRequestId:'share-a-g',targetAttemptId:g.attemptId,evidenceRefs:[]});assert.equal(share.status,'shared')
  await call('desktop-data','share_evidence',{clientRequestId:'share-own-g',targetAttemptId:g.attemptId,evidenceRefs:[captured.ref]})
  const gp=peers.get('gateway'),gb=await execution('gateway'),token=await gp.client.post('/internal/evidence/read-token',{binding:gb,instructionRevision:1,ref:captured.ref})
  async function page(cursor,expected){const response=await fetch(fixture.origin+`/internal/evidence/${captured.ref.id}/content`+(cursor?'?cursor='+encodeURIComponent(cursor):''),{headers:{authorization:'Bearer '+gp.identity.credential,'x-geneway-node-instance':gp.identity.nodeInstanceId,'x-geneway-evidence-token':token.token}}),value=await response.json();observations.push({kind:'evidence-page',status:response.status,value});assert.equal(response.status,expected,JSON.stringify(value));return value}
  const first=await page(null,200);assert(first.nextCursor)
  const observed={clientRequestId:'g-observation',text:'移除前真实读取第一页',evidenceRefs:[captured.ref]}, receipt=await call('gateway','publish_observation',observed)
  const modelToken=await gp.client.issue(gb,{request:true,inputMessageId:messageId((await fixture.store.read()).multisite.inputs.find(row=>row.workId===workId).id,gb.attempt_id,gb.session_id)})
  await call('desktop-office','wait_dependencies',{clientRequestId:'wait-g',dependencyIds:[g.delegationId]});await pump()
  if(attachment){
    const url=fixture.origin+`/internal/model/attachments/${attachment.id}/content?version=${attachment.ref.version}&sha256=${attachment.ref.sha256}`,headers={authorization:'Bearer '+modelToken.token},positive=await fetch(url,{headers});assert.equal(positive.status,200);assert.deepEqual(Buffer.from(await positive.arrayBuffer()),attachmentBytes)
    let reached,release;const ready=new Promise(resolve=>reached=resolve),wait=new Promise(resolve=>release=resolve);attachmentGate={release};const original=fixture.attachments.download.bind(fixture.attachments)
    fixture.attachments.download=async(...args)=>{const value=await original(...args);await writeFile(join(directory,'attachment-io-complete.json'),JSON.stringify({at:new Date().toISOString(),id:attachment.id,bytes:value.bytes.length,sha256:createHash('sha256').update(value.bytes).digest('hex')}));reached();await wait;return value}
    pendingAttachment=fetch(url,{headers});await ready
  }
  let heldManual
  if(process.argv.includes('--pending-control-ack')){
    await api(`/api/works/${workId}/multisite/pause`,{clientRequestId:'hold-g',scope:{kind:'agent',agentId:'gateway'},expectedControlGeneration:0})
    heldManual=(await gp.client.resync()).pending.find(command=>command.operation==='manual_pause');assert(heldManual);heldManual=await gp.client.resolveCommand(heldManual);await gp.host.accept({workspaceId:'local',nodeId:gp.nodeId},heldManual)
    await writeFile(join(directory,'control-inbox-before-remove.json'),JSON.stringify(await gp.journal.read(),null,2))
  }
  const before=await fixture.store.read();await writeFile(join(directory,'before.json'),JSON.stringify(before,null,2))
  let removeBody={employeeId:'gateway',clientRequestId:'remove-g'},remove
  if(uiMode){
    const config=join(directory,'ui-config.json');await writeFile(config,JSON.stringify({workId,employeeId:'gateway',stateFile:join(directory,'api/state.json')}))
    const stdout=[],stderr=[];uiDriver=fork(fileURLToPath(new URL('./probe-work-member-removal-ui.mjs',import.meta.url)),[fixture.origin,config],{cwd:process.cwd(),execArgv:[],stdio:['ignore','pipe','pipe','ipc']});uiDriver.stdout.on('data',x=>stdout.push(x));uiDriver.stderr.on('data',x=>stderr.push(x))
    uiExit=new Promise(resolve=>uiDriver.once('exit',(code,signal)=>resolve({code,signal})))
    const phase=await Promise.race([new Promise(resolve=>uiDriver.on('message',message=>{if(message.kind==='work-member-ui-phase'&&message.phase==='member-removal-stopping-observed')resolve(message)})),uiExit.then(exit=>{throw Error('UI exited before pending '+JSON.stringify(exit))})])
    await writeFile(join(directory,'ui-pending-store.json'),JSON.stringify(await fixture.store.read(),null,2));await writeFile(join(directory,'ui-phase.json'),JSON.stringify(phase,null,2));const pending=JSON.parse(await readFile(join(phase.directory,'pending.json')));removeBody=pending.submitted;remove=pending.receipt
    uiExit=uiExit.then(async exit=>{await writeFile(join(directory,'ui-stdout.log'),Buffer.concat(stdout));await writeFile(join(directory,'ui-stderr.log'),Buffer.concat(stderr));await writeFile(join(directory,'ui-exit.json'),JSON.stringify(exit));return exit})
  }else remove=await api(`/api/works/${workId}/multisite/remove-member`,removeBody)
  if(attachmentGate){attachmentGate.release();const response=await pendingAttachment,value=await response.json();assert.equal(response.status,403);assert.equal(value.error.code,'FORBIDDEN');await writeFile(join(directory,'attachment-race-response.json'),JSON.stringify({at:new Date().toISOString(),status:response.status,value}));attachmentGate=undefined}
  assert.deepEqual(await api(`/api/works/${workId}/multisite/remove-member`,removeBody),remove)
  await api(`/api/works/${workId}/multisite/remove-member`,{...removeBody,employeeId:'desktop-data'},409)
  if(heldManual){await gp.client.ack(heldManual);await assert.rejects(gp.client.ack({...heldManual,payload_digest:'0'.repeat(64)}),{code:'ACK_MISMATCH'});await assert.rejects(gp.client.post('/internal/bridge/command',{commandId:heldManual.command_id,payloadDigest:heldManual.payload_digest}),{code:'FORBIDDEN'});await writeFile(join(directory,'control-ack-after-remove.json'),JSON.stringify(await fixture.store.read(),null,2))}
  const after=await fixture.store.read();assert.equal(after.workMemberRemovals.length,1);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.resources,before.resources);assert.deepEqual(after.employees,before.employees);assert.equal(after.works.find(row=>row.id===workId).instructionRevision,1)
  await page(first.nextCursor,heldManual?409:403);await assert.rejects(gp.client.command(gb,'publish_observation',{instructionRevision:1,...observed,clientRequestId:'fresh-after-remove'}),{code:heldManual?'MANUALLY_PAUSED':'FORBIDDEN'})
  assert.deepEqual(await gp.client.command(gb,'publish_observation',{instructionRevision:1,...observed}),receipt)
  await assert.rejects(gp.client.command(gb,'publish_observation',{instructionRevision:1,...observed,text:'异体'}),{code:'IDEMPOTENCY_CONFLICT'})
  const model=await fetch(fixture.origin+'/internal/model/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+modelToken.token,'content-type':'application/json'},body:JSON.stringify({model:modelToken.modelSnapshot.model,stream:true,max_tokens:64,messages:[{role:'user',content:'旧token不可继续'}],tools:[]})});assert.equal(model.status,403);await model.text();assert.equal(bodies.length,0);assert.equal((await fixture.store.read()).modelRequests.length,before.modelRequests.length)
  await assert.rejects(peers.get('desktop-office').client.command(await execution('desktop-office'),'delegate',childRequest('new-g-after-remove','gateway')),{code:'FORBIDDEN'})
  await call('desktop-data','publish_observation',{clientRequestId:'a-still-valid',text:'其他参与者仍获原权',evidenceRefs:[captured.ref]})
  await assert.rejects(read('desktop-office',captured.ref),{code:'FORBIDDEN'})
  await pump();const stopped=await fixture.store.read();assert.equal(stopped.multisite.attempts.find(row=>row.attempt_id===gb.attempt_id).status,'cancelled');assert.notEqual(stopped.works.find(row=>row.id===workId).status,'cancelled');assert(stopped.multisite.messages.some(row=>row.kind==='dependency_unavailable'&&row.ingestedAt));assert.equal((await fixture.service.getWork({id:'owner'},workId)).value.multisite.workMembers.find(row=>row.employeeId==='gateway').cleanup,'stopped')
  if(uiExit)assert.equal((await uiExit).code,0)
  const second=await fixture.service.multisite.apply(owner,'create',{employeeId:'gateway',goal:'同一逻辑员工在另一工作仍合法',clientRequestId:'work-b'});await pump();assert.notEqual(second.workId,workId)
  await call('gateway','publish_observation',{clientRequestId:'other-work-valid',text:'相同Node身份新工作仍合法',evidenceRefs:[]})
  await writeFile(join(directory,'after.json'),JSON.stringify(await fixture.store.read(),null,2))
  for(const id of [workId,second.workId])await fixture.service.multisite.apply(owner,'cancel',{workId:id,clientRequestId:'cleanup-'+id});await pump()
  const result={result:'passed',directory,workId,otherWorkId:second.workId,boundary:'真实HTTP/Node身份/证据封存/旧token/真实gateway拒绝/HostSim消息消费和停稳；非原生SDK',providerForwards:bodies.length};await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
} catch(cause){await writeFile(join(directory,'failure.json'),JSON.stringify({code:cause.code,message:cause.message,stack:cause.stack},null,2));console.error(directory);throw cause}finally{attachmentGate?.release();if(pendingAttachment)await pendingAttachment.catch(()=>{});if(uiDriver&&uiDriver.exitCode===null){uiDriver.kill('SIGTERM');await uiExit};for(const peer of peers.values())await peer.host.close();await fixture.close();await new Promise(resolve=>provider.close(resolve));await writeFile(join(directory,'http.json'),JSON.stringify(observations,null,2));await writeFile(join(directory,'provider-bodies.json'),JSON.stringify(bodies,null,2));await captureWorkMemberSources(directory,'end',['scripts/test-work-member-removal.mjs','scripts/probe-work-member-removal-ui.mjs'])}
