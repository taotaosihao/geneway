import { fork, spawn } from 'node:child_process'
import { captureWorkMemberSources } from '../../scripts/fixtures/multisite/work-member-sources.mjs'
import { messageId } from '../../packages/agent-host/delivery.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { startGroupFixture } from './common/group-fixture.mjs'
import { startWorkGroupProcess } from './common/work-group-process.mjs'
import { createWireFetch } from './common/wire.mjs'
import { processIdentity } from './common/processes.mjs'

const candidate = process.argv[2] ?? 'a2a', normalOnly = process.argv.includes('--normal-only'), positiveOnly = process.argv.includes('--positive-only')
assert(['a2a', 'anp'].includes(candidate))
const root = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-work-group-' + candidate + '-')
let fixture, manager, peer, managedWorkId, uiDriver, uiExit
const statusCredential = randomBytes(32).toString('base64url'), facts = []
const save = async (name, value) => writeFile(path.join(root, name + '.json'), JSON.stringify(value, null, 2))
const sourcePaths = ['experiments/protocol-comparison/group-flow.mjs','experiments/protocol-comparison/common/group-fixture.mjs','experiments/protocol-comparison/common/work-group-child.mjs','experiments/protocol-comparison/common/work-group-domain.mjs','experiments/protocol-comparison/common/work-group-process.mjs','experiments/protocol-comparison/common/work-group-journal.mjs','experiments/protocol-comparison/adapters/a2a/work-group.mjs','experiments/protocol-comparison/adapters/a2a/work-group-wire.mjs','experiments/protocol-comparison/adapters/anp/work-group.mjs','experiments/protocol-comparison/adapters/anp/home.mjs','experiments/protocol-comparison/peers/anp/group-control.py','scripts/probe-work-group-ui.mjs']
await captureWorkMemberSources(root,'start',sourcePaths)
await save('runtime',{nodeVersion:process.version,platform:process.platform,arch:process.arch,execPath:process.execPath})
console.log(JSON.stringify({ stage: 'starting', root, candidate, pid: process.pid }))
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value }
try {
  fixture = await startGroupFixture({ root, workMemberProtocolStatus: async request => {
    if (request.workId !== managedWorkId) return { ...request, configured: false }
    if (!manager) throw Error('Configured Work group is not connected')
    const response = await fetch(manager.origin + '/status?employeeId=' + encodeURIComponent(request.employeeId), { headers: { 'x-work-group-status': statusCredential }, signal: AbortSignal.timeout(1000) })
    assert(response.ok); return response.json()
  } })
  managedWorkId = fixture.workId
  const actors = await Promise.all([...fixture.peers.values()].map(async value => ({ employeeId: value.employeeId, binding: await fixture.execution(value.employeeId), identity: value.identity, protocolToken: randomBytes(32).toString('base64url') })))
  const homePort = await port(), groupRoot = path.join(root, 'bridge'), config = { stateFile: path.join(root, 'api/state.json'), work: { workspaceId: 'local', workId: fixture.workId }, actors, statusCredential, groupAdmin: { id: 'group-admin', token: randomBytes(32).toString('base64url') } }
  if (candidate === 'anp') {
    const { startAnpPeer } = await import('./peers/anp/run.mjs')
    config.homeDomain = 'work-group-home.test'
    peer = await startAnpPeer({ root: path.join(root, 'independent-group-host'), didDomain: 'work-group-host.test', resolverBaseUrls: { [config.homeDomain]: 'http://127.0.0.1:' + homePort } })
    config.peer = { origin: peer.origin, didDomain: peer.identity.didDomain, identity: peer.identity }
  }
  manager = await startWorkGroupProcess({ candidate, root: groupRoot, config, entryFile: 'experiments/protocol-comparison/common/work-group-child.mjs', listenPort: homePort })
  await save('bridge-ready', { identity: manager.identity, origin: manager.origin, info: manager.info, peerPid: peer?.child.pid ?? null })
  const fetchWire = await createWireFetch({ logFile: path.join(root, 'managed-client-wire.jsonl'), targetProcess: manager.child.pid })
  async function managed(employeeId, operation, parameters = {}, expected = 200) {
    const actor = actors.find(row => row.employeeId === employeeId), response = await fetchWire(manager.origin + '/managed/' + operation, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + actor.identity.credential, 'x-geneway-node-instance': actor.identity.nodeInstanceId }, body: JSON.stringify({ binding: actor.binding, ...parameters }) }), result = await response.json()
    facts.push({ at: new Date().toISOString(), employeeId, operation, parameters, status: response.status, result }); assert.equal(response.status, expected, JSON.stringify(result)); return result
  }
  let independentSequence=0

    async function independentA2a(employeeId,op,locator,operationId){
      const actorConfig=manager.info.actorConfigs[employeeId], id=operationId??'external-'+(++independentSequence), configPath=path.join(root,'independent-a2a-'+independentSequence+'-'+op+'.json'),outputFile=configPath+'.output.json'
      const payload={opaqueSchema:'geneway.a2a-work-group/1',op,groupId:manager.info.identity.groupId,operationId:id,...(locator?{locator}:{})}
      await writeFile(configPath,JSON.stringify({...actorConfig,operation:'sendMessage',request:{message:{messageId:id,contextId:actorConfig.contextId,taskId:'',role:1,parts:[{content:{$case:'data',value:payload},mediaType:'application/json',filename:''}],extensions:[],referenceTaskIds:[]}},outputFile,timeoutMs:15000}),{mode:0o600})
      const child=spawn(process.execPath,['experiments/protocol-comparison/peers/a2a/client.mjs','--config',configPath],{stdio:['ignore','pipe','pipe']}),stdout=[],stderr=[];child.stdout.on('data',x=>stdout.push(x));child.stderr.on('data',x=>stderr.push(x));const terminal=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));await writeFile(configPath+'.stdout',Buffer.concat(stdout));await writeFile(configPath+'.stderr',Buffer.concat(stderr));await save('independent-a2a-'+independentSequence+'-'+op,{pid:child.pid,...terminal,payload,employeeId});let output;try{output=JSON.parse(await readFile(outputFile))}catch(cause){if(cause.code!=='ENOENT')throw cause}return{...terminal,output,payload}
    }
  const publication = await fixture.call('desktop-office', 'publish_observation', { clientRequestId: 'group-broadcast', text: '已受权本工作三方共享的有限观察摘要', evidenceRefs: [] })
  const event = await managed('desktop-office', 'register', { messageId: publication.messageId })
  await managed('desktop-office', 'publish', { locator: event.locator })
  for (const employeeId of ['desktop-data', 'gateway']) {
    const deadline = Date.now() + 15000
    for (;;) {
      const received = await managed(employeeId, 'receive')
      const items = Array.isArray(received) ? received : received.deliveries
      if (items.some(row => row.locator === event.locator)) break
      assert(Date.now() < deadline, 'Actual group delivery not received'); await new Promise(resolve => setTimeout(resolve, 50))
    }
    const body = await managed(employeeId, 'body', { locator: event.locator }); assert.equal(body.text, '已受权本工作三方共享的有限观察摘要')
  }
  await save('normal-product-state', await fixture.store.read()); await save('normal-group-state', await manager.request('snapshot')); await save('normal-managed-facts', facts)
  if (positiveOnly) {
    const before = await fixture.store.read(), removed = await fixture.api(`/api/works/${fixture.workId}/multisite/remove-member`,{employeeId:'gateway',clientRequestId:'positive-remove-g'})
    await fixture.pump();const deadline=Date.now()+30000
    for(;;){const view=await fixture.api('/api/works/'+fixture.workId);if(view.multisite.workMembers.find(row=>row.employeeId==='gateway').protocolGroup==='confirmed')break;assert(Date.now()<deadline,'Removal not confirmed');await new Promise(resolve=>setTimeout(resolve,100))}
    await save('positive-before-new-publish',{product:await fixture.store.read(),group:await manager.request('snapshot')})
    const fresh=[]
    for(const [sender,recipient] of [['desktop-office','desktop-data'],['desktop-data','desktop-office']]){
      const submitted=await fixture.call(sender,'publish_observation',{clientRequestId:'post-confirm-new-'+sender,text:'确认后全新的'+sender+'观察',evidenceRefs:[]}),registered=await managed(sender,'register',{messageId:submitted.messageId})
      const sent=await managed(sender,'publish',{locator:registered.locator});let delivered
      for(let index=0;;index++){const value=await managed(recipient,'receive'),items=Array.isArray(value)?value:value.deliveries;delivered=items.find(row=>row.locator===registered.locator);if(delivered)break;assert(index<100,'New event not actually received');await new Promise(resolve=>setTimeout(resolve,50))}
      const body=await managed(recipient,'body',{locator:registered.locator});assert.equal(body.messageId,submitted.messageId);assert.equal(body.text,'确认后全新的'+sender+'观察');await managed('gateway','body',{locator:registered.locator},403)
      fresh.push({sender,recipient,submitted,registered,sent,delivered,body})
    }
    const raw=candidate==='a2a'?await independentA2a('gateway','publish',fresh[0].registered.locator):await manager.request('raw-send',{employeeId:'gateway',locator:fresh[0].registered.locator});if(candidate==='a2a')assert.notEqual(raw.code,0);else assert(raw.error)
    const after=await fixture.store.read();assert.deepEqual(after.modelRequests,before.modelRequests);await save('positive-new-publish',{removed,fresh,raw,product:after,group:await manager.request('snapshot')})
  } else if (!normalOnly) {
    const g = fixture.peers.get('gateway'), gExecution = await fixture.execution('gateway'), a = fixture.peers.get('desktop-data')
    const capturedG = await g.runtime.evidence(gExecution,'inspect_site',{clientRequestId:'group-g-source',instructionRevision:1,resourceId:'fixture:site',sections:['collector_health','recent_events']})
    const capturedA = await a.runtime.evidence(await fixture.execution('desktop-data'),'read_history',{clientRequestId:'group-a-source',instructionRevision:1,resourceId:'fixture:history',datasetId:'history'})
    await assert.rejects(a.runtime.evidence(await fixture.execution('desktop-data'),'read_shared_evidence',{ref:capturedG.ref}),{code:'FORBIDDEN'})
    await a.runtime.evidence(await fixture.execution('desktop-data'),'read_shared_evidence',{ref:capturedA.ref})
    const evidenceToken = await g.client.post('/internal/evidence/read-token',{binding:gExecution,instructionRevision:1,ref:capturedG.ref})
    async function gPage(cursor,expected) {const response=await fetch(fixture.origin+'/internal/evidence/'+capturedG.ref.id+'/content'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{headers:{authorization:'Bearer '+g.identity.credential,'x-geneway-node-instance':g.identity.nodeInstanceId,'x-geneway-evidence-token':evidenceToken.token}}),body=await response.json();assert.equal(response.status,expected);await save(expected===200?'g-page-before':'g-page-after',{status:response.status,body});return body}
    const firstPage=await gPage(null,200);assert(firstPage.nextCursor)
    const initial = await fixture.store.read(), input=initial.multisite.inputs.find(row=>row.workId===fixture.workId), oldModelToken=await g.client.issue(gExecution,{request:true,inputMessageId:messageId(input.id,gExecution.attempt_id,gExecution.session_id)})
    const gObservation = await fixture.call('gateway','publish_observation',{clientRequestId:'g-group-source-observation',text:'G 的受权本工作观察摘要',evidenceRefs:[capturedG.ref]})
    const gEvent = await managed('gateway','register',{messageId:gObservation.messageId});await managed('gateway','publish',{locator:gEvent.locator})
    const question = await fixture.call('desktop-office','ask_agent',{clientRequestId:'group-question',targetAgentId:'gateway',text:'请原责任员工确认当前封存范围。',evidenceRefs:[]});await fixture.pump()
    const questionState=await fixture.store.read(), questionRow=questionState.multisite.questions.find(row=>row.id===question.questionId), questionEvent=await managed('desktop-office','register',{messageId:questionRow.messageId})
    const sessionsBeforeGroup=await Promise.all([...fixture.peers.values()].map(async row=>JSON.parse(await readFile(path.join(root,row.employeeId,'sessions.json')))))
    await managed('desktop-office','publish',{locator:questionEvent.locator});
    for(let index=0;;index++){const received=await managed('gateway','receive'),items=Array.isArray(received)?received:received.deliveries;if(items.some(row=>row.locator===questionEvent.locator))break;assert(index<100,'Question locator not actually received');await new Promise(resolve=>setTimeout(resolve,50))}
    await managed('gateway','body',{locator:questionEvent.locator});await managed('desktop-data','body',{locator:questionEvent.locator},403)
    const sessionsAfterGroup=await Promise.all([...fixture.peers.values()].map(async row=>JSON.parse(await readFile(path.join(root,row.employeeId,'sessions.json')))));assert.deepEqual(sessionsAfterGroup,sessionsBeforeGroup)
    await fixture.call('gateway','answer_agent',{clientRequestId:'group-answer',questionId:question.questionId,text:'只使用原已封存资料，未声明新的现场事实。',evidenceRefs:[]});await fixture.pump();await save('question-consumed-state',await fixture.store.read());await save('question-session-no-second-wake',{before:sessionsBeforeGroup,after:sessionsAfterGroup})
    const pendingPublication=await fixture.call('desktop-office','publish_observation',{clientRequestId:'pending-broadcast',text:'移除前已登记而尚未解读的事件',evidenceRefs:[]}), pendingEvent=await managed('desktop-office','register',{messageId:pendingPublication.messageId});await managed('desktop-office','publish',{locator:pendingEvent.locator})
    let oldOffered
    if(candidate==='a2a') {const offered=await independentA2a('gateway','receive');assert.equal(offered.code,0);oldOffered=offered.output.parts.map(part=>part.content?.value).find(row=>row.locator===pendingEvent.locator);assert(oldOffered);await save('old-offered',oldOffered)}
    await manager.request('pause-scan',{value:true});await manager.request('block-remove',{value:true})
    await save('before-remove-product',await fixture.store.read());await save('before-remove-group',await manager.request('snapshot'))
    const uiConfig=path.join(root,'ui-config.json');await writeFile(uiConfig,JSON.stringify({workId:fixture.workId,employeeId:'gateway',stateFile:path.join(root,'api/state.json'),timeoutMs:60000}))
    const phases=[],waiters=new Map(),stdout=[],stderr=[]
    uiDriver=fork('scripts/probe-work-group-ui.mjs',[fixture.origin,uiConfig],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});uiDriver.stdout.on('data',x=>stdout.push(x));uiDriver.stderr.on('data',x=>stderr.push(x));uiExit=new Promise(resolve=>uiDriver.once('exit',(code,signal)=>resolve({code,signal})))
    uiDriver.on('message',value=>{if(value.kind==='work-group-ui-phase'){phases.push(value);waiters.get(value.phase)?.(value)}})
    async function phase(name){const old=phases.find(row=>row.phase===name);if(old)return old;return Promise.race([new Promise(resolve=>waiters.set(name,resolve)),uiExit.then(value=>{throw Error('UI exited before '+name+':'+JSON.stringify(value)+' '+Buffer.concat(stderr))})])}
    const acknowledge=name=>uiDriver.send({kind:'work-group-ui-ack',phase:name})
    const pending=await phase('protocol-pending');await save('ui-pending-phase',pending)
    await save('product-committed-pre-enqueue',await fixture.store.read());const preEnqueue=await manager.request('snapshot');await save('control-pre-enqueue',preEnqueue)
    assert(candidate==='anp'?!preEnqueue.group.journal.removals.length:!preEnqueue.group.operations.some(row=>row.kind==='remove'))
    await gPage(firstPage.nextCursor,403)
    await assert.rejects(g.client.command(gExecution,'publish_observation',{instructionRevision:1,clientRequestId:'removed-direct-node',text:'不得提交',evidenceRefs:[]}),{code:'FORBIDDEN'})
    await managed('gateway','body',{locator:pendingEvent.locator},403);await managed('gateway','publish',{locator:gEvent.locator},403);await managed('desktop-office','publish',{locator:pendingEvent.locator},403)
    const deniedModel=await fetch(fixture.origin+'/internal/model/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+oldModelToken.token,'content-type':'application/json'},body:JSON.stringify({model:oldModelToken.modelSnapshot.model,stream:true,max_tokens:32,messages:[{role:'user',content:'旧token不能再执行'}],tools:[]})});assert.equal(deniedModel.status,403);await save('old-model-denied',{status:deniedModel.status,body:await deniedModel.json()})
    if(candidate==='a2a'){const ack=await independentA2a('gateway','ack',oldOffered.locator,oldOffered.operationId);assert.equal(ack.code,0);await save('old-opaque-transport-ack',ack)}
    const originalIdentity=manager.identity, originalOrigin=manager.origin;await manager.kill();await save('bridge-killed',{originalIdentity,originalOrigin,product:await fixture.store.read(),peerIdentity:peer?await processIdentity(peer.child.pid):null});acknowledge('protocol-pending')
    const unknown=await phase('protocol-unknown');await save('ui-unknown-phase',unknown);await manager.startExisting();assert.equal(manager.origin,originalOrigin);assert.notEqual(manager.identity.pid,originalIdentity.pid);await save('bridge-reopened',{identity:manager.identity,origin:manager.origin,info:manager.info});acknowledge('protocol-unknown')
    await manager.request('wait-remove-blocked');const restored=await phase('protocol-pending-restored');await save('ui-restored-phase',restored);await save('restored-before-Host',await manager.request('snapshot'))
    await managed('desktop-office','publish',{locator:pendingEvent.locator},403)
    await manager.request('block-remove',{value:false});await fixture.pump();acknowledge('protocol-pending-restored')
    const uiTerminal=await uiExit;await writeFile(path.join(root,'ui.stdout.log'),Buffer.concat(stdout));await writeFile(path.join(root,'ui.stderr.log'),Buffer.concat(stderr));await save('ui-terminal',uiTerminal);assert.equal(uiTerminal.code,0,Buffer.concat(stderr).toString())
    const finalGroup=await manager.request('snapshot'), finalState=await fixture.store.read();await save('after-remove-group',finalGroup);await save('after-remove-product',finalState)
    const sourceBefore=JSON.parse(await readFile(path.join(root,'before-remove-product.json')));assert.deepEqual(finalState.nodes,sourceBefore.nodes);assert.deepEqual(finalState.resources,sourceBefore.resources);assert.deepEqual(finalState.employees,sourceBefore.employees);assert.equal(finalState.modelRequests.length,sourceBefore.modelRequests.length);assert.deepEqual(finalState.multisite.results,sourceBefore.multisite.results)
    await managed('desktop-office','publish',{locator:pendingEvent.locator});await managed('desktop-data','body',{locator:pendingEvent.locator});await managed('gateway','body',{locator:pendingEvent.locator},403)
    const directProtocol = candidate==='a2a'?await independentA2a('gateway','publish',gEvent.locator):await manager.request('raw-send',{employeeId:'gateway',locator:gEvent.locator});await save('removed-valid-protocol-principal',directProtocol);if(candidate==='a2a')assert.notEqual(directProtocol.code,0);else assert(directProtocol.error)
    const second=await fixture.api('/api/works',{workType:'multisite',employeeId:'gateway',goal:'同一逻辑员工另一工作原权限',clientRequestId:'other-work'}),secondId=second.value?.id??second.id;await fixture.pump();await fixture.call('gateway','publish_observation',{clientRequestId:'other-work-valid',text:'其他Work仍合法',evidenceRefs:[]});await save('other-work-valid',{workId:secondId,state:await fixture.store.read()});await save('full-managed-facts',facts)
  }
  const result = { root, candidate, result: 'passed', scope: positiveOnly?'new-publish-after-confirmation':normalOnly?'initial-normal-only':'work-group-removal-reconciliation', workId: fixture.workId, actualRecipients: ['desktop-data', 'gateway'], groupPid: manager.child.pid, peerPid: peer?.child.pid ?? null, boundary: 'Actual original Node credentials/current Work, real protocol group child and actual receivers/controlled body resolution. HostSim, local loopback; not full X03, native SDK business flow, TLS or physical network qualification.' }
  await save('result', result); console.log(JSON.stringify(result))
} catch (cause) { await save('failure', { code: cause.code, message: cause.message, stack: cause.stack }); console.error(root); throw cause }
finally {
  if(uiDriver&&uiDriver.exitCode===null){uiDriver.send({kind:'work-group-ui-ack',phase:'protocol-pending',abort:'Owner finalizer'});uiDriver.kill('SIGTERM');await uiExit}
  await manager?.close(); await peer?.close(); await fixture?.close()
  await save('managed-facts', facts)
  await captureWorkMemberSources(root,'end',sourcePaths)
  await save('owner-terminal-observation', { at: new Date().toISOString(), pid: process.pid, manager: manager ? { pid: manager.child.pid, final: await processIdentity(manager.child.pid).catch(() => null) } : null, peer: peer ? { pid: peer.child.pid, final: await processIdentity(peer.child.pid).catch(() => null) } : null, boundary: 'This finalizer records child readback; the parent actual terminal exit is the tool result.' })
}
