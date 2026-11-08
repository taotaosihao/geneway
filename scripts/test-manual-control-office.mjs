import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSpreadsheetJobs } from '../packages/agent-host/spreadsheet-jobs.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { templateReference } from '../src/spreadsheet-template.mjs'
import { binding, seal, key, digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-office-'), observations = []
const prepareIoMode = process.argv.includes('--prepare-io'), unacknowledgedMode = process.argv.includes('--unacknowledged-job')
let fixture, host, jobs, deferLaunch = true
try {
  fixture = await startBridgeService({ directory: join(directory, 'api') })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function api(path, body) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); observations.push({ path, status: response.status }); return value }
  const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 'pair', nodeId: 'pc-b', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-office'], expiresAt: new Date(Date.now() + 60000).toISOString() }), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity }), paired = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem', ...identity }); identity.registrationRevision = paired.node.registrationRevision
  const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); runtime.supportsAttachments = true
  jobs = createSpreadsheetJobs({ journal, root: join(directory, 'jobs'), nodeId: 'pc-b', evidenceService: { ...client.spreadsheet, async revalidate(execution, input) { if (execution.id && deferLaunch) throw Object.assign(Error('controlled transport deferral before launch'), { retryableConnection: true }); return client.spreadsheet.revalidate(execution, input) } } })
  host = createAgentHost({ nodeId: 'pc-b', journal, runtime, jobs }); host.setOrchestrationHandler({ call: (execution, operation, parameters, context) => client.command(execution, operation, parameters, context), event: event => client.event(event) })
  async function pump() { for (const delivery of (await client.resync()).pending) { const command = await client.resolveCommand(delivery); await host.accept({ workspaceId: 'local', nodeId: 'pc-b' }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event)) }
  const bytes = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '人工暂停前已受理的原生成任务', owner: '张工' }] })), owner = { id: 'owner' }, reference = (await fixture.attachments.init(owner, { clientRequestId: 'history', name: 'history.json', mediaType: 'application/json', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })).ref
  await fixture.attachments.upload(owner, reference.attachmentId, Readable.from([bytes]))
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: '人工控制既有Job与新Job受理分开', clientRequestId: 'create', attachmentRefs: [reference], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-20' } }); await pump()
  const execution = (await journal.read()).executions[0], parameters = { clientRequestId: 'existing-job', instructionRevision: 1, template: templateReference(), historyRefs: [reference], rows: [{ sourceRef: reference, entryIndex: 0, dueDate: '2026-11-20', photoRefs: [] }] }
  if (prepareIoMode) {
    const originalPrepare = fixture.spreadsheetService.prepare
    let reached, release
    const held = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { release = resolve })
    fixture.spreadsheetService.prepare = async (...args) => { const result = await originalPrepare(...args); reached(); await gate; return result }
    const racing = client.spreadsheet.prepare(execution, { ...parameters, clientRequestId: 'race-after-prepare-io' })
    await held
    await api(`/api/works/${work.id}/multisite/pause`, { clientRequestId: 'pause-during-prepare-io', scope: { kind: 'work' }, expectedControlGeneration: 0 })
    release(); await assert.rejects(racing, { code: 'MANUALLY_PAUSED' }); fixture.spreadsheetService.prepare = originalPrepare
    const rejected = await fixture.store.read(); assert(!rejected.multisite.commands.some(row => row.receiptKind === 'spreadsheet_prepared')); assert.equal(rejected.multisite.jobs.length, 0); assert.equal(rejected.artifacts.length, 0)
    await writeFile(join(directory, 'prepare-io-rejected.json'), JSON.stringify(rejected, null, 2))
    await pump(); await api(`/api/works/${work.id}/multisite/resume`, { clientRequestId: 'release-prepare-io', scope: { kind: 'work' }, expectedControlGeneration: 1 }); await pump(); await pump()
    assert((await fixture.store.read()).manualControls.at(-1).holders[0].resumeConsumedAt)
  }
  const controlGeneration = (await fixture.store.read()).manualControls.at(-1)?.generation ?? 0
  const job = await runtime.spreadsheet(execution, 'start_spreadsheet', parameters); if (!unacknowledgedMode) await pump()
  const accepted = (await journal.read()).jobs.find(row => row.id === job.id); assert.equal(accepted.state, 'accepted'); assert.equal(accepted.launchState, 'not_started'); assert.equal(accepted.worker, null); assert.equal((await fixture.store.read()).multisite.jobs.length, unacknowledgedMode ? 0 : 1)
  await api(`/api/works/${work.id}/multisite/pause`, { clientRequestId: 'pause', scope: { kind: 'work' }, expectedControlGeneration: controlGeneration }); await pump()
  const paused = await fixture.store.read(); assert(paused.manualControls.at(-1).holders[0].idleAt); assert.deepEqual(paused.manualControls.at(-1).holders[0].jobEvidence, [{ jobId: job.id, workerState: 'not_started' }])
  const originalEvent = (await journal.read()).outbox.find(row => row.event.kind === 'spreadsheet_job').event
  const {payload_digest,...eventBody}=originalEvent, forgedJob={...originalEvent.job,id:key('spreadsheet-job',binding(execution),'unadmitted-job'),clientRequestId:'unadmitted-job',requestDigest:digest({...parameters,clientRequestId:'unadmitted-job'})}
  await assert.rejects(client.event(seal({...eventBody,event_id:key('spreadsheet-job-event','pc-b',forgedJob.id,forgedJob.sequence),job:forgedJob})),{code:'MANUALLY_PAUSED'})
  assert.equal((await fixture.store.read()).multisite.jobs.length,1)
  await api(`/api/works/${work.id}/multisite/resume`, { clientRequestId: 'resume', scope: { kind: 'work' }, expectedControlGeneration: controlGeneration + 1 }); await pump()
  const released = await fixture.store.read(); assert(released.manualControls.at(-1).holders[0].releasedAt); assert.equal(released.manualControls.at(-1).holders[0].resumeConsumedAt, null)
  for (const operation of ['authorize', 'prepare']) await assert.rejects(operation === 'authorize' ? client.spreadsheet.authorize(execution) : client.spreadsheet.prepare(execution, { ...parameters, clientRequestId: 'new-job-before-resume-consume' }), { code: 'MANUAL_RESUME_PENDING' })
  await assert.rejects(client.spreadsheet.revalidate(execution, accepted.input), { code: 'MANUAL_RESUME_PENDING' })
  assert.equal(await client.spreadsheet.revalidate(accepted, accepted.input), true)
  await assert.rejects(client.post('/internal/spreadsheets/revalidate', { binding: binding(execution), input: { instructionRevision: 1, dueDate: '2026-11-20' }, job: { id: '0'.repeat(32), inputDigest: accepted.inputDigest } }), { code: 'FORBIDDEN' })
  const unchanged = await fixture.store.read(); assert.equal(unchanged.multisite.jobs.length, 1); assert.equal(unchanged.artifacts.length, 0); assert.equal(unchanged.modelRequests.length, 0)
  deferLaunch = false; await jobs.process()
  await until(async () => (await journal.read()).jobs.find(row => row.id === job.id).state === 'candidate')
  await host.flushEvents(event => client.event(event))
  const candidate = await fixture.store.read(); assert.equal(candidate.multisite.jobs[0].id, job.id); assert.equal(candidate.multisite.jobs[0].state, 'candidate'); assert.equal(candidate.manualControls.at(-1).holders[0].resumeConsumedAt, null); assert.equal(candidate.artifacts.length, 0)
  await pump(); const consumed = await fixture.store.read(); assert(consumed.manualControls.at(-1).holders[0].resumeConsumedAt)
  const prepared = await client.spreadsheet.prepare(execution, { ...parameters, clientRequestId: 'new-prepare-after-real-resume-consume' }); assert.equal(prepared.input.dueDate, '2026-11-20')
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'cancel' }); await pump()
  for (const [name, value] of Object.entries({ paused, released, candidate, consumed, final: await fixture.store.read() })) await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2))
  const result = { result: 'passed', directory, workId: work.id, jobId: job.id, actualAcceptedNotStartedJobSafeWhilePaused: true, newOfficeAdmissionRejectedBeforeFreshResumeConsume: true, existingExactJobCanLaunchAfterReleaseWithoutNewInference: true, wrongJobIdentityRejected: true, originalJobCandidateFactRetained: true, afterPrepareIoPauseRejectsAdmission: prepareIoMode ? true : null, unacknowledgedLocalJobUsesExactOriginalPreparation: unacknowledgedMode ? true : null, unknownUnadmittedJobFactRejectedWhilePaused: true, actualModelForwards: 0, artifactCount: 0, boundary: 'real authenticated HTTP/Node/Host/AgentDelivery simulator and actual spreadsheet worker; controlled retryable transport deferral kept one accepted Job not_started before pause; no official DSH/model/browser claim; unacknowledged-local-Job mode uses exact real preparation receipt, never accepts unknown unadmitted Job' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { deferLaunch = false; await host?.close(); await fixture?.close(); await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2)); console.log('Manual Office root:', directory) }
async function until(test) { const deadline = Date.now() + 15000; while (!await test()) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)) } }
