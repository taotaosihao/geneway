import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { request as httpRequest, createServer } from 'node:http'
import ExcelJS from 'exceljs'
import sharp from 'sharp'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSpreadsheetJobs } from '../packages/agent-host/spreadsheet-jobs.mjs'
import { createSpreadsheetUploader } from '../packages/agent-host/spreadsheet-upload.mjs'
import { templateReference } from '../src/spreadsheet-template.mjs'
import { binding, seal, key } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-remote-')
const owner = { id: 'owner' }, hash = bytes => createHash('sha256').update(bytes).digest('hex'), errors = []
const historyCount = Number(process.argv.find(value => value.startsWith('--histories='))?.split('=')[1] ?? 1), large = process.argv.includes('--large')
assert(historyCount >= 1 && historyCount <= 8)
let fixture, host, offlineServer, responseLossServer
try {
  fixture = await startBridgeService({ directory: join(directory, 'api') })
  const responseLoss = process.argv.includes('--response-loss'), lostResponses = [], upstreamRequests = []
  let clientOrigin = fixture.origin
  if (responseLoss) {
    const lostPaths = new Set()
    responseLossServer = createServer(async (request, response) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks)
        const upstream = await fetch(new URL(request.url, fixture.origin), { method: request.method, headers: { ...request.headers, host: new URL(fixture.origin).host }, body: body.length ? body : undefined }), bytes = Buffer.from(await upstream.arrayBuffer())
        const drop = ['/internal/spreadsheets/upload-token', '/internal/artifacts/candidates/init'].includes(request.url) || /\/internal\/artifacts\/candidates\/[^/]+\/content$/.test(request.url)
        upstreamRequests.push({ path: request.url, digest: hash(body), status: upstream.status })
        if (drop && upstream.ok && !lostPaths.has(request.url)) { lostPaths.add(request.url); lostResponses.push({ path: request.url, digest: hash(body) }); response.destroy(); return }
        response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(bytes)
      } catch { response.destroy() }
    }); await new Promise(resolve => responseLossServer.listen(0, '127.0.0.1', resolve)); clientOrigin = `http://127.0.0.1:${responseLossServer.address().port}`
  }
  const pairing = await fixture.nodes.createPairing(owner, { clientRequestId: 'pair-b', nodeId: 'pc-b', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-office'], expiresAt: new Date(Date.now() + 60000).toISOString() })
  const offlineMode = process.argv.includes('--offline'), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }
  let offline = false, failedRevalidations = 0, successfulRevalidations = 0
  if (offlineMode) { offlineServer = createServer((request, response) => { failedRevalidations++; response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'REMOTE_UNAVAILABLE' } })) }); await new Promise(resolve => offlineServer.listen(0, '127.0.0.1', resolve)) }
  const client = createRemoteClient({ origin: clientOrigin, identity, fetchImpl: (url, options) => fetch(offline && new URL(url).pathname === '/internal/spreadsheets/revalidate' ? `http://127.0.0.1:${offlineServer.address().port}` : url, options) })
  const redeemed = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem', nodeInstanceId: identity.nodeInstanceId, credential: identity.credential })
  Object.assign(identity, { nodeId: redeemed.node.id, registrationRevision: redeemed.node.registrationRevision })
  const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); runtime.supportsAttachments = true
  const evidenceService = { ...client.spreadsheet, async revalidate(...args) { const reply = await client.spreadsheet.revalidate(...args); if (offlineMode && ++successfulRevalidations === 1) offline = true; return reply } }
  const jobs = createSpreadsheetJobs({ journal, root: join(directory, 'jobs'), evidenceService, nodeId: 'pc-b', onError: cause => errors.push(cause.code) })
  host = createAgentHost({ nodeId: 'pc-b', journal, runtime, jobs });host.setOrchestrationHandler({call:(execution,operation,parameters)=>client.command(execution,operation,parameters),event:event=>client.event(event)})
  async function deliver() { const state = await client.resync(); for (const command of state.pending) { const value = await client.resolveCommand(command); await host.accept({ workspaceId: 'local', nodeId: 'pc-b' }, value); await client.ack(value) }; await host.process(); await host.flushEvents(event => client.event(event)) }
  async function upload(name, mediaType, bytes) { const { ref } = await fixture.attachments.init(owner, { clientRequestId: name, name, mediaType, sizeBytes: bytes.length, sha256: hash(bytes) }); await fixture.attachments.upload(owner, ref.attachmentId, Readable.from([bytes])); return ref }
  const stringBounds = process.argv.includes('--strings'), histories = [], photos = [], entries = large ? Array.from({ length: stringBounds ? 9 : 200 }, () => ({ date: '2026-11-01', description: '检'.repeat(stringBounds ? 2000 : 80), owner: stringBounds ? '人'.repeat(200) : '张工' })) : [{ date: '2026-11-01', description: '护罩松动', owner: '张工' }, { date: '2026-11-02', description: '护罩松动', owner: '李工' }]
  for (let index = 0; index < historyCount; index++) histories.push(await upload(`history-${index}.json`, 'application/json', Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries }))))
  for (let index = 0; index < (large ? 8 - historyCount : 1); index++) photos.push(await upload(`site-${index}.png`, 'image/png', await sharp({ create: { width: 30, height: 30, channels: 3, background: '#2277aa' } }).png().toBuffer()))
  const history = histories[0]
  const work = await fixture.service.multisite.apply(owner, 'create', { employeeId: 'desktop-office', goal: '生成远端整改表', clientRequestId: 'create', attachmentRefs: [...histories, ...photos], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-20' } })
  await deliver()
  const interactionLifecycle=process.argv.includes('--interaction-lifecycle');let interactionThread,interactionSource,interactionSelection,interactionSession
  async function interactionApi(path,body,expected=200){const response=await fetch(fixture.origin+path,{method:body?'POST':'GET',headers:{origin:fixture.origin,cookie:interactionSession.cookie,'x-csrf-token':interactionSession.csrfToken,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value}
  if(interactionLifecycle){
    const login=await fetch(fixture.origin+'/api/session',{method:'POST',headers:{origin:fixture.origin,'content-type':'application/json'},body:JSON.stringify({loginName:'owner',password:'synthetic owner password'})});interactionSession={...await login.json(),cookie:login.headers.get('set-cookie').split(';')[0]};interactionThread=await interactionApi('/api/interaction/threads',{clientRequestId:'completion-thread'});interactionSource=await interactionApi(`/api/interaction/threads/${interactionThread.id}/events`,{clientRequestId:'completion-source',sourceEventId:'completion-source',version:1,expectedThreadRevision:1,text:'请为该明确工作继续生成当前要求的整改表。',routingPolicyId:null});const view=await interactionApi('/api/interaction/threads/'+interactionThread.id),selection={clientRequestId:'completion-select',intentId:interactionSource.intentId,expectedRouteRevision:1,targetWorkId:work.workId,candidateVersion:view.directory.candidateVersion};interactionSelection=await interactionApi(`/api/interaction/threads/${interactionThread.id}/selection`,selection);await deliver();const current=(await fixture.store.read()).workIntents.find(row=>row.id===interactionSource.intentId),subscription=(await fixture.store.read()).contextSubscriptions.find(row=>row.id===current.handlerSubscriptionId),active=(await journal.read()).executions[0];assert(subscription.ingestedAt);await runtime.orchestration(active,'accept_intent',{clientRequestId:'completion-accept',intentFence:{intentId:current.id,routeRevision:current.routeRevision,handlerBinding:subscription.handlerBinding,subscriptionRevision:subscription.revision},expectedInstructionRevision:1});await deliver();const accepted=await fixture.store.read(),currentView=await interactionApi('/api/interaction/threads/'+interactionThread.id);await interactionApi(`/api/interaction/threads/${interactionThread.id}/selection`,{...selection,clientRequestId:'accepted-cannot-reselect',expectedRouteRevision:current.routeRevision,candidateVersion:currentView.directory.candidateVersion},409);assert.deepEqual(await fixture.store.read(),accepted);assert.deepEqual(await interactionApi(`/api/interaction/threads/${interactionThread.id}/selection`,selection),interactionSelection);await writeFile(join(directory,'interaction-before-natural-completion.json'),JSON.stringify(await fixture.store.read(),null,2))
  }
  const execution = (await journal.read()).executions[0]
  const authorized = await client.spreadsheet.authorize(execution); assert.equal(authorized.work.spreadsheetRequest.dueDate, '2026-11-20'); assert.equal(authorized.state, undefined)
  const evidence = await runtime.spreadsheet(execution, 'read_evidence', { ref: history }); assert.equal(evidence.entries.length, entries.length)
  const parameters = { clientRequestId: 'remote-job', instructionRevision: (await fixture.store.read()).works.find(row=>row.id===work.workId).instructionRevision, template: templateReference(), historyRefs: histories, rows: histories.flatMap(sourceRef => entries.map((_, entryIndex) => ({ sourceRef, entryIndex, dueDate: '2026-11-20', photoRefs: photos }))) }
  const prepared = await client.spreadsheet.prepare(execution, parameters)
  if (stringBounds) await assert.rejects(client.spreadsheet.prepare(execution, { ...parameters, unexpected: 'x'.repeat(4 * 1024 * 1024) }), { code: 'INVALID_REQUEST' })
  const bytes = value => Buffer.byteLength(JSON.stringify(value)), requestBytes = bytes({ binding: binding(execution), parameters }), responseBytes = bytes(prepared)
  for (const invalid of [{ ...parameters, rows: [...parameters.rows, ...Array.from({ length: 1601 - parameters.rows.length }, () => parameters.rows[0])] }, { ...parameters, clientRequestId: 'x'.repeat(129) }, { ...parameters, rows: [{ ...parameters.rows[0], entryIndex: 200 }] }, { ...parameters, rows: [{ ...parameters.rows[0], dueDate: 'x'.repeat(16000) }] }]) await assert.rejects(client.spreadsheet.prepare(execution, invalid), { code: 'INVALID_REQUEST' })
  const revisionStopMode = process.argv.includes('--revision-stop'), stopMode = process.argv.includes('--stop') || revisionStopMode
  let heldWorker
  const hold = stopMode ? (async () => { await until(async () => { const row = (await journal.read()).jobs.find(row => row.worker && row.state === 'running'); if (!row) return false; process.kill(row.worker.pid, 'SIGSTOP'); heldWorker = row.worker; return true }) })() : null
  const job = await runtime.spreadsheet(execution, 'start_spreadsheet', parameters)
  if (offlineMode) {
    await jobs.process(); const accepted = (await journal.read()).jobs[0]
    assert.equal(accepted.state, 'accepted'); assert.equal(accepted.launchState, 'not_started'); assert.equal(accepted.worker, null); assert(failedRevalidations >= 3)
    offline = false; await jobs.process()
  }
  if (stopMode) {
    await hold; await host.flushEvents(event => client.event(event))
    if (revisionStopMode) {
      await fixture.service.multisite.apply(owner, 'input', { workId: work.workId, clientRequestId: 'revise-busy', text: '修订期限并生成新版本', spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-25' } })
      // Exercise the actual Job stop producer while the owning Attempt remains runnable.
      await jobs.stopExecution(execution); await deliver()
      let state = await fixture.store.read(); assert.equal(state.multisite.jobs[0].state, 'stopped'); assert.equal(state.multisite.attempts[0].observed_revision, 2); assert.equal(state.multisite.attempts[0].status, 'running')
      const newJob = await runtime.spreadsheet(execution, 'start_spreadsheet', { ...parameters, clientRequestId: 'revision-2-job', instructionRevision: 2, rows: parameters.rows.map(row => ({ ...row, dueDate: '2026-11-25' })) })
      await until(async () => (await jobs.get(execution, { jobId: newJob.id })).state === 'candidate'); await host.flushEvents(event => client.event(event))
      await createSpreadsheetUploader({ journal, jobs, origin: fixture.origin, issueUploadToken: row => client.spreadsheet.issueUploadToken(row), onError: cause => errors.push(cause.code) })(); await deliver()
      state = await fixture.store.read(); assert.equal(state.works[0].status, 'completed'); assert.equal(state.artifacts[0].instructionRevision, 2); assert.equal((await journal.read()).executions[0].status, 'settled'); assert.deepEqual(errors, [])
      const result = { result: 'passed', directory, boundary: 'real HTTP and actual Jobs.stopExecution producer; simulated Agent, not an additional model-facing stop tool', oldJobActualStopWithRunnableAttempt: true, oldRevisionStopProjectedHistorically: true, newInputIngested: true, sameSessionRevision2JobCompletedSettled: true }
      await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
    } else {
    await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'stop-job' }); await deliver()
    const local = await journal.read(), state = await fixture.store.read()
    assert.equal(state.works[0].status, 'cancelled'); assert.equal(local.jobs[0].state, 'stopped'); assert.equal(local.jobs[0].stopEvidence.workerExit, 'exit_confirmed')
    assert(local.outbox.some(row => row.event.kind === 'spreadsheet_job' && !row.acknowledged)); assert(local.outbox.find(row => row.event.kind === 'stopped').acknowledged)
    assert.equal(state.multisite.jobs[0].state, 'running'); assert.equal(state.artifacts.length, 0)
    const response = await fixture.service.getWork(owner, work.workId)
    assert.equal(response.value.multisite.reports[0].jobStopEvidence[0].workerExit, 'exit_confirmed')
    const result = { result: 'passed', directory, actualStoppedWorker: heldWorker.pid, ordinaryJobForbiddenUnacked: true, stoppedAckAfterForbiddenJob: true, immutableCloudJobHistory: true, projectedActualJobStopEvidence: true, cancelledNoArtifact: true }
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
    }
  } else {
  await until(async () => (await jobs.get(execution, { jobId: job.id })).state === 'candidate')
  await assert.rejects(client.spreadsheet.issueUploadToken({ ...execution, id: job.id }), { code: 'JOB_PROJECTION_PENDING' })
  await host.flushEvents(event => client.event(event))
  const projection = (await fixture.store.read()).multisite.jobs[0], candidate = await jobs.readCandidate(job.id)
  const event = (await journal.read()).outbox.find(row => row.event.kind === 'spreadsheet_job').event, jobEventBytes = bytes({ event })
  const acceptedJobAck = await client.event(event)
  await assert.rejects(client.event({ ...event, job: { ...event.job, localPath: '/untrusted' } }), { code: 'INVALID_REQUEST' })
  await assert.rejects(client.event({ ...event, input_id: 'x'.repeat(16001) }), { code: 'INVALID_REQUEST' })
  await assert.rejects(client.event({ ...event, job: { ...event.job, reason: 'x'.repeat(16001) } }), { code: 'INVALID_REQUEST' })
  if (stringBounds) await assert.rejects(client.event({ ...event, job: { ...event.job, reason: 'x'.repeat(4 * 1024 * 1024) } }), { code: 'INVALID_REQUEST' })
  assert.equal(projection.output.sha256, hash(candidate.bytes)); assert.equal(projection.state, 'candidate')
  await assert.rejects(client.post('/internal/spreadsheets/upload-token', { binding: binding(execution), jobId: job.id, output: projection.output }), { code: 'INVALID_REQUEST' })
  await assert.rejects(client.spreadsheet.issueUploadToken({ ...execution, id: 'f'.repeat(32) }), { code: 'JOB_PROJECTION_PENDING' })
  await assert.rejects(client.spreadsheet.authorize({ ...execution, node_id: 'cloud' }), { code: 'FORBIDDEN' })
  const transferFaults = []
  const uploadCandidates = createSpreadsheetUploader({ journal, jobs, origin: clientOrigin, issueUploadToken: job => client.spreadsheet.issueUploadToken(job), onError: cause => { if (responseLoss && cause instanceof TypeError) transferFaults.push('HTTP_RESPONSE_LOST'); else errors.push(cause.code) } })
  let oldCandidateToken = (await client.spreadsheet.issueUploadToken(candidate.job)).token
  const apiRestart = process.argv.includes('--api-restart')
  if (apiRestart) {
    const port = Number(new URL(fixture.origin).port), oldToken = oldCandidateToken, outputPath = join(directory, 'jobs', job.id, 'incident-register.xlsx'), inode = (await stat(outputPath)).ino
    await fixture.close(); fixture = await startBridgeService({ directory: join(directory, 'api'), listenPort: port })
    const stale = await fetch(fixture.origin + '/internal/artifacts/candidates/init', { method: 'POST', headers: { authorization: `Bearer ${oldToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.id, version: 1, sha256: candidate.job.output.sha256, sizeBytes: candidate.bytes.length }) }); assert.equal(stale.status, 401)
    oldCandidateToken = (await client.spreadsheet.issueUploadToken(candidate.job)).token
    assert.notEqual(oldCandidateToken, oldToken); assert.equal((await stat(outputPath)).ino, inode); assert.deepEqual((await jobs.readCandidate(job.id)).bytes, candidate.bytes); assert.equal((await journal.read()).jobs.length, 1)
  }
  const initParameters = { jobId: job.id, version: 1, sha256: candidate.job.output.sha256, sizeBytes: candidate.bytes.length }
  for (const [path, token, body, expected] of [['/internal/artifacts/candidates/init', oldCandidateToken, { ...initParameters, jobId: 'f'.repeat(32) }, 403], ['/internal/artifacts/candidates/init', identity.credential, initParameters, 401], ['/internal/spreadsheets/authorize', oldCandidateToken, { binding: binding(execution) }, 401]]) {
    const response = await fetch(fixture.origin + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-geneway-node-instance': identity.nodeInstanceId, 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, expected)
  }
  if (process.argv.includes('--old-version')) {
    const initialized = await fetch(fixture.origin + '/internal/artifacts/candidates/init', { method: 'POST', headers: { authorization: `Bearer ${oldCandidateToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.id, version: 1, sha256: candidate.job.output.sha256, sizeBytes: candidate.bytes.length }) }), metadata = await initialized.json(); assert.equal(initialized.status, 200)
    await fixture.service.multisite.apply(owner, 'input', { workId: work.workId, clientRequestId: 'new-version', text: '修订期限', spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-25' } }); await deliver()
    await assert.rejects(client.spreadsheet.issueUploadToken(candidate.job), { code: 'REVISION_CONFLICT' })
    const staleUpload = await fetch(fixture.origin + `/internal/artifacts/candidates/${metadata.id}/content`, { method: 'PUT', headers: { authorization: `Bearer ${oldCandidateToken}`, 'content-type': 'application/octet-stream' }, body: candidate.bytes }); assert.equal(staleUpload.status, 409)
    assert.equal((await staleUpload.json()).error.code, 'REVISION_CONFLICT')
    assert.deepEqual((await jobs.readCandidate(job.id)).bytes, candidate.bytes)
    await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'cancel-old' }); await deliver()
    assert.equal((await fixture.store.read()).works[0].status, 'cancelled'); assert(!(await fixture.store.read()).artifacts.some(row => row.status === 'ready'))
    const result = { result: 'passed', directory, originalCandidateBytesPreserved: true, oldVersionNewTokenRejected: true, oldTokenCannotUploadAfterRevision: true, noReadyAndActualStop: true }
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  } else {
  await uploadCandidates()
  if (responseLoss) await until(async () => { if ((await fixture.store.read()).works[0].status === 'completed') return true; await uploadCandidates(); return false })
  assert.deepEqual(errors, [])
  if (responseLoss) {
    assert.equal(lostResponses.length, 3); assert.equal(transferFaults.length, 2)
    const tokenRetry = upstreamRequests.filter(row => row.path === '/internal/spreadsheets/upload-token' && row.status === 200); assert.equal(tokenRetry[0].digest, tokenRetry[1].digest)
    const state = await fixture.store.read(); assert.equal(state.artifacts.length, 1); const path = join(directory, 'api/artifacts', state.artifacts[0].id), inode = (await stat(path)).ino
    await uploadCandidates(); assert.equal((await stat(path)).ino, inode); assert.equal((await fixture.store.read()).artifacts.length, 1)
    await writeFile(join(directory, 'lost-responses.json'), JSON.stringify({ lostResponses, upstreamRequests, transferFaults }, null, 2))
  }
  const completed = (await fixture.store.read()).works.find(row => row.id === work.workId); assert.equal(completed.status, 'completed')
  const ready = (await client.spreadsheet.issueUploadToken(candidate.job)).artifact
  assert(ready); const readyInitBody = JSON.stringify({ jobId: job.id, version: 1, sha256: candidate.job.output.sha256, sizeBytes: candidate.job.output.sizeBytes })
  const readyInit = await fetch(fixture.origin + '/internal/artifacts/candidates/init', { method: 'POST', headers: { authorization: `Bearer ${oldCandidateToken}`, 'content-type': 'application/json' }, body: readyInitBody })
  assert.equal(readyInit.status, 200); assert.equal((await readyInit.json()).status, 'ready')
  assert.equal(ready.sha256, hash(candidate.bytes)); await deliver()
  assert.equal((await journal.read()).executions[0].status, 'settled')
  if(interactionLifecycle){
    const before=await fixture.store.read();assert(before.contextSubscriptions.filter(row=>row.workId===work.workId).every(row=>row.lifecycle==='closed'));const view=await interactionApi('/api/interaction/threads/'+interactionThread.id),source=await interactionApi(`/api/interaction/threads/${interactionThread.id}/events`,{clientRequestId:'after-natural-completion',sourceEventId:'after-natural-completion',version:1,expectedThreadRevision:view.thread.revision,text:'请判断新的未定向请求需要补充哪些定位条件。'}),after=await fixture.store.read();assert.equal(source.state,'clarify');assert.equal(after.routingDecisions.find(row=>row.id===after.workIntents.find(row=>row.id===source.intentId).decisionId).targetWorkId,null);const refreshed=await interactionApi('/api/interaction/threads/'+interactionThread.id),history=await interactionApi(`/api/interaction/threads/${interactionThread.id}/events`,{clientRequestId:'explicit-completed-history',sourceEventId:'explicit-completed-history',version:1,expectedThreadRevision:refreshed.thread.revision,text:'明确回看原已完成工作，再决定新关联工作。',replyToEventId:after.sourceEvents.find(row=>row.id===after.workIntents.find(row=>row.id===interactionSource.intentId).sourceEventId).id});assert.equal(history.state,'proposal');assert.equal((await fixture.store.read()).works[0].status,'completed');assert.equal((await fixture.store.read()).modelRequests.length,0);await writeFile(join(directory,'interaction-after-natural-completion.json'),JSON.stringify(await fixture.store.read(),null,2))
  }
  const downloaded = await fixture.spreadsheetArtifacts.download(owner, work.workId, ready.id)
  assert.equal(hash(downloaded.bytes), hash(candidate.bytes)); const book = new ExcelJS.Workbook(); await book.xlsx.load(downloaded.bytes)
  assert.equal(book.worksheets[0].getCell('F3').value, large ? entries.length * historyCount : 2)
  const originalRead = fixture.store.read; let observedRead
  const readObserved = new Promise(resolve => { observedRead = resolve })
  fixture.store.read = async (...args) => { const value = await originalRead(...args); observedRead(); return value }
  const rawBody = JSON.stringify({ binding: binding(execution), jobId: job.id })
  let pausedRequest
  const raced = new Promise((resolve, reject) => {
    pausedRequest = httpRequest(fixture.origin + '/internal/spreadsheets/upload-token', { method: 'POST', headers: { authorization: `Bearer ${identity.credential}`, 'x-geneway-node-instance': identity.nodeInstanceId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(rawBody) } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })) }); pausedRequest.on('error', reject); pausedRequest.write(rawBody.slice(0, 1))
  })
  await readObserved; fixture.store.read = originalRead
  await fixture.nodes.revoke(owner, 'pc-b', { clientRequestId: 'revoke-ready', expectedRevision: (await fixture.store.read()).nodes[0].revision })
  pausedRequest.end(rawBody.slice(1)); const racedResult = await raced
  assert.deepEqual(await client.event(event), acceptedJobAck)
  const { payload_digest, ...originalEvent } = event
  await assert.rejects(client.event(seal({ ...originalEvent, job: { ...event.job, reason: 'changed-body' } })), { code: 'FORBIDDEN' })
  await assert.rejects(client.event(seal({ ...originalEvent, event_id: key('new-job-event-after-revoke', event.event_id) })), { code: 'FORBIDDEN' })
  const beforeAuthFix = process.argv.includes('--auth-race-before')
  assert.equal(racedResult.status, beforeAuthFix ? 200 : 403)
  const readyReplayStatuses = []
  for (const [path, method, contentType, body] of [['/internal/artifacts/candidates/init', 'POST', 'application/json', readyInitBody], [`/internal/artifacts/candidates/${ready.id}/verify`, 'POST', 'application/json', '{}'], [`/internal/artifacts/candidates/${ready.id}/content`, 'PUT', 'application/octet-stream', candidate.bytes]]) {
    const response = await fetch(fixture.origin + path, { method, headers: { authorization: `Bearer ${oldCandidateToken}`, 'content-type': contentType }, body }); readyReplayStatuses.push(response.status); assert.equal(response.status, beforeAuthFix && !path.endsWith('/init') ? 200 : 403)
  }
  await assert.rejects(client.spreadsheet.issueUploadToken(candidate.job), { code: 'FORBIDDEN' })
  await assert.rejects(client.spreadsheet.authorize(execution), { code: 'FORBIDDEN' })
  const result = { result: 'passed', directory, large, historyCount, rows: parameters.rows.length, requestBytes, responseBytes, jobEventBytes, beforeAuthFix, racedReadyStatus: racedResult.status, readyReplayStatuses, exactAcceptedJobAckAfterRevoke: true, changedOrNewJobRejectedAfterRevoke: true, apiRestart, tokenMapLostOld401SameJobNewTokenOriginalBytes: apiRestart, responseLoss, lostResponses: lostResponses.length, tokenPurposeAndOtherJobDenied: true, offlineMode, failedRevalidations, acceptedWithoutDispatchWhileOffline: offlineMode, interactionLifecycle,realNaturalHandlerCompletionEndsSubscription:interactionLifecycle,acceptedSelectionRejectedAndOriginalAckReplayed:interactionLifecycle,actualFileStoreHttpRemoteJob: true, realWorkerCandidate: true, originalBytesCloudVerified: true, sealedProjectionRequired: true, readyReplayAuthorized: true, revokeReadyDenied: true, boundsRejected: true, singleAttempt: (await fixture.store.read()).multisite.attempts.length === 1, toolsChargeZeroBudget: completed.modelRequestBudget.reserved === 0, independentExcelOracle: true, errors }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  }
  }
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack }, null, 2)); throw cause }
finally { await host?.close(); await fixture?.close(); for (const server of [offlineServer, responseLossServer]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
async function until(predicate) { const end = Date.now() + 20000; while (!await predicate()) { assert(Date.now() < end, 'candidate timed out'); await new Promise(resolve => setTimeout(resolve, 25)) } }
