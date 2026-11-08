import assert from 'node:assert/strict'

// 只供锁定真实导航后的消费者调用；不把作者passed、声明闭包或加载器resolve当实际业务/加载证据。
export function assertSameRoleFixture(cohort) {
  assert.deepEqual(cohort.map(row => row.candidate).sort(), ['a2a', 'anp', 'baseline'])
  const first = cohort[0]
  for (const row of cohort) {
    for (const field of ['fixtureDigest', 'inputDigest', 'permissionsDigest']) {
      assert.match(row[field], /^[a-f0-9]{64}$/); assert.equal(row[field], first[field])
    }
    assert.deepEqual(row.nodes, first.nodes)
    assert.equal(new Set(row.nodes).size, 2)
  }
  return { fixtureDigest: first.fixtureDigest, inputDigest: first.inputDigest, nodes: first.nodes }
}

export function summarizeRoleTraces(roles) {
  return roles.map(role => {
    assert.ok(Number.isSafeInteger(role.pid) && role.pid > 0 && role.startTicks)
    if (!Array.isArray(role.loadtraceURLs)) return { role: role.role, pid: role.pid, startTicks: role.startTicks, actualLoaded: { status: 'not-run' } }
    for (const url of role.loadtraceURLs) assert.equal(typeof url, 'string')
    return { role: role.role, pid: role.pid, startTicks: role.startTicks,
      actualLoaded: { status: 'recorded', urls: [...new Set(role.loadtraceURLs)].sort(), boundary: 'actual supplied loader trace only; attribution requires trace producer identity and lifecycle evidence' } }
  })
}

export const roleFlowBoundary = {
  status: 'not-run', reason: 'Awaiting main driver navigation/schema and actual terminal roots',
  unknownUsage: null, unknownCost: null,
  boundary: 'No business, proxy isolation/recovery, loaded-module completeness, resource ranking or winner inferred from static declarations'
}

export async function verifyRoleFlow(runRoot) {
  const { readFile } = await import('node:fs/promises')
  const { resolve, join } = await import('node:path')
  const { createHash } = await import('node:crypto')
  const { digest, assertSealed, sameBinding } = await import('../../../packages/agent-contracts/index.mjs')
  const root = resolve(runRoot), load = async name => JSON.parse(await readFile(join(root, name), 'utf8'))
  const lines = async name => (await readFile(join(root,name),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const [manifest, fixture, state, pending, journals, providers] = await Promise.all([load('manifest.json'),load('fixture.json'),load('result-state.json'),load('pending-state.json'),load('journals.json'),lines('provider-requests.jsonl')])
  assert.equal(digest(fixture),manifest.fixtureDigest)
  assert.deepEqual(manifest.edges.map(row=>row.node),fixture.nodes)
  assert.equal(manifest.edges.length,2)
  const results=state.multisite.results;assert.equal(results.length,1)
  const result=results[0];assert.equal(result.senderBinding.agent_id,'desktop-data');assert.equal(result.senderBinding.node_id,'pc-a')
  assert.equal(result.payload.summary,fixture.summary);assert.equal(digest(result.payload),result.payloadDigest)
  const feedback=state.multisite.messages.filter(row=>row.kind==='dependency_result'&&row.resultRef===result.id)
  assert.equal(feedback.length,1);assert.ok(feedback[0].ingestedAt&&feedback[0].deliveredAt)
  const parent=state.multisite.attempts.find(row=>row.attempt_id===feedback[0].targetAttemptId)
  assert.equal(parent.agent_id,'coordinator');assert.equal(parent.node_id,'cloud')
  const ledger=state.modelRequests.filter(row=>row.work_id===result.workId)
  assert.equal(ledger.length,providers.length)
  const remaining=ledger.map(row=>row.bodyDigest)
  for(const row of providers){const i=remaining.indexOf(digest(row.body));assert.ok(i>=0,'provider body must match unique production ledger');remaining.splice(i,1);assert.equal(row.requestBytes,Buffer.byteLength(JSON.stringify(row.body)))}
  assert.ok(providers.some(row=>row.agent==='coordinator'&&JSON.stringify(row.body).includes(result.id)&&JSON.stringify(row.body).includes(fixture.summary)))
  const sessions=[]
  for(const attempt of state.multisite.attempts){const journal=journals[attempt.node_id];const execution=journal.executions.find(row=>sameBinding(row,attempt));assert.ok(execution);assert.ok(execution.session_id);sessions.push(execution.session_id)}
  assert.equal(new Set(sessions).size,2)
  const launch=pending.multisite.outbox.filter(row=>row.command.operation==='launch'&&row.command.agent_id==='desktop-data')
  assert.equal(launch.length,1);assert.equal(launch[0].acceptedAt,null);assertSealed(launch[0].command)
  const proxies=await Promise.all([load('proxy-final-edge-0.json'),load('proxy-final-edge-1.json')])
  const events=await Promise.all([lines('proxy-0/events.jsonl'),lines('proxy-1/events.jsonl')])
  const cut=events[1].find(row=>row.event==='disconnect-policy-after'&&row.disconnected)
  const restore=events[1].find(row=>row.event==='disconnect-policy-after'&&!row.disconnected&&Date.parse(row.at)>Date.parse(cut.at))
  assert.ok(cut&&restore)
  assert.ok(!events[0].some(row=>row.event==='disconnect-policy-after'&&row.disconnected))
  for(const proxy of proxies){assert.ok(proxy.requests.some(row=>row.path==='/internal/bridge/events'&&row.status===200&&row.responseBytes>0));assert.ok(proxy.requests.some(row=>row.method==='POST'&&row.status===200&&row.requestBytes>0))}
  assert.ok(proxies[0].requests.some(row=>Date.parse(row.startedAt)>=Date.parse(cut.at)&&Date.parse(row.startedAt)<=Date.parse(restore.at)&&row.status===200))
  const phases=await Promise.all(['idle','busy','after-fault'].map(name=>load(`sample-${name}.json`)))
  for(const edge of manifest.edges) for(const phase of phases){const sample=phase.processes.find(row=>row.pid===edge.identity.pid);assert.ok(sample?.available);assert.equal(sample.startTicks,edge.identity.startTicks);const sockets=phase.sockets.find(row=>row.pid===edge.identity.pid);assert.ok(sockets);assert.equal(sockets.rows.some(row=>row.stateHex==='0A'),false,'edge must not have business listen socket in sampled proc FDs')}
  if(manifest.candidate!=='baseline') {
    assert.ok(manifest.receiver?.identity?.pid)
    assert.ok(!manifest.edges.some(edge=>edge.identity.pid===manifest.receiver.identity.pid))
    for(const proxy of proxies) assert.ok(proxy.requests.some(row=>row.channel==='protocol'&&row.method==='POST'&&row.path.startsWith('/protocol/')&&row.status===200&&row.requestBytes>0))
    if(manifest.candidate==='a2a') for(const proxy of proxies) assert.ok(proxy.requests.some(row=>row.channel==='protocol'&&row.path==='/protocol/.well-known/agent-card.json'&&row.status===200))
    for(const phase of phases){const sample=phase.processes.find(row=>row.pid===manifest.receiver.identity.pid);assert.ok(sample?.available);assert.equal(sample.startTicks,manifest.receiver.identity.startTicks)}
  }
  let application = {status:'not-applicable-baseline'}
  if(manifest.candidate!=='baseline') {
    const rawExchanges=await lines('receiver/application-wire.jsonl')
    for(const row of rawExchanges) assert.equal(row.requestBytes,Buffer.byteLength(JSON.stringify(row.request)))
    const exchanges=rawExchanges.map(row=>manifest.candidate==='a2a'?{...row,request:row.request.params.message.parts[0].data,response:row.response.result.message.parts[0].data}:row)
    const delegated=exchanges.filter(row=>row.request.operation==='delegate')
    assert.equal(delegated.length,1);assert.deepEqual(delegated[0].request.parameters,fixture.child)
    assert.equal(delegated[0].request.binding.agent_id,'coordinator');assert.equal(delegated[0].response.status,200)
    const completed=exchanges.filter(row=>row.request.operation==='complete_delegation')
    assert.equal(completed.length,1);assert.ok(sameBinding(completed[0].request.binding,result.senderBinding))
    assert.equal(completed[0].response.body.resultId,result.id);assert.equal(completed[0].response.status,200)
    for(const row of exchanges){assert.ok(state.multisite.attempts.some(attempt=>sameBinding(attempt,row.request.binding)))}
    application={exchanges:exchanges.length,delegationActor:'coordinator',resultActor:'desktop-data',originalResultId:result.id,cryptographicVerification:'not-run by this oracle'}
    if(manifest.candidate==='anp') {
      const peerPid=manifest.receiver.info.peerPid;assert.ok(Number.isSafeInteger(peerPid));assert.notEqual(peerPid,manifest.receiver.identity.pid)
      for(const phase of phases) assert.ok(phase.processes.some(row=>row.pid===peerPid&&row.available))
      application.pythonPeerPid=peerPid;application.pythonImportTrace='not-run'
    }
  }
  const traces=[]
  for(let index=0;index<2;index++){try{traces.push({role:`edge-${index}`,records:await lines(`edge-${index}/module-loads.jsonl`)})}catch(error){if(error.code!=='ENOENT')throw error;traces.push({role:`edge-${index}`,status:'not-run'})}}
  if(manifest.receiver) {try {traces.push({role:'receiver',records:await lines('receiver/module-loads.jsonl')})} catch(error){if(error.code!=='ENOENT')throw error;traces.push({role:'receiver',status:'not-run'})}}
  const authority = { attempts: state.multisite.attempts.map(row=>({agent_id:row.agent_id,node_id:row.node_id,employeeRevision:row.employeeRevision,instruction_revision:row.instruction_revision,grant:row.grant,modelSnapshot:row.modelSnapshot})).sort((a,b)=>a.agent_id.localeCompare(b.agent_id)),
    owner: state.members.filter(row=>row.id==='owner').map(({id,enabled,employeeIds,role})=>({id,enabled,employeeIds,role})), resources:state.resources,
    modelRoutes:state.modelRoutes }
  assert.equal(authority.owner.length,1);assert.equal(authority.owner[0].enabled,true)
  const fixtureBytesSha256=createHash('sha256').update(await readFile(join(root,'fixture.json'))).digest('hex')
  return {candidate:manifest.candidate,fixtureBytesSha256,authority,authorityDigest:digest(authority),fixtureDigest:manifest.fixtureDigest,originalResultId:result.id,application,providerBodies:providers.length,modelLedger:ledger.length,sessions,dependencyIngested:true,originalPendingLaunch:launch[0].command.command_id,
    proxyWindow:{cutAt:cut.at,restoredAt:restore.at},traces,usage:ledger.map(row=>row.usage??null),actualCost:null,
    boundary:'loopback proxies and sampled edge sockets; not namespaces/NAT/public egress; role resource samples not physical total memory; SDK workers/Python trace and exact role attribution remain limited; no winner'}
}

if (process.argv[1]?.endsWith('/oracle/role-flow.mjs')) {
  try { console.log(JSON.stringify(await verifyRoleFlow(process.argv[2]),null,2)) }
  catch(error){console.error(error.stack);process.exitCode=1}
}
