import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSpreadsheetJobs } from '../packages/agent-host/spreadsheet-jobs.mjs'
import { templateReference } from '../src/spreadsheet-template.mjs'
import { verifyIncidentSpreadsheet } from '../src/spreadsheet-verification.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-deadline-'), candidateMode = process.argv.includes('--candidate'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
let fixture, host, releaseVerification
const verificationEntered = Promise.withResolvers()
try {
  console.log(JSON.stringify({ stage: 'starting', directory, candidateMode }))
  fixture = await startBridgeService({ directory: join(directory, 'api'), ...(candidateMode ? { spreadsheetVerification: async (...args) => { const result = await verifyIncidentSpreadsheet(...args); verificationEntered.resolve(); await new Promise(resolve => { releaseVerification = resolve }); return result } } : {}) })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), actor = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function api(path, value, method = 'POST') { const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie: actor.cookie, 'x-csrf-token': actor.csrfToken, 'content-type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) }); return { status: response.status, value: await response.json() } }
  const state = await fixture.store.read(), employee = state.employees.find(row => row.id === 'desktop-office'), route = state.modelRoutes.find(row => row.id === employee.modelRouteId), limits = { maxModelRequests: 20, maxReservedTokens: 1000000, maxReservedCostMicros: 1000000 }
  assert.equal((await api('/api/admin/budget-policies/office-deadline', { clientRequestId: 'policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'desktop-office', enabled: true, accountingMode: 'conservative_estimate', limits, executionTimeoutMs: 60000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 8 }, modelPrices: [{ provider: route.provider, model: route.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }] }, 'PUT')).status, 200)
  const owner = { id: 'owner' }, identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity })
  const pairing = await fixture.nodes.createPairing(owner, { clientRequestId: 'pair', nodeId: 'pc-b', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-office'], expiresAt: new Date(Date.now() + 60000).toISOString() }), redeemed = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem', ...identity }); Object.assign(identity, { nodeId: 'pc-b', registrationRevision: redeemed.node.registrationRevision })
  const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); runtime.supportsAttachments = true
  const errors = [], jobs = createSpreadsheetJobs({ journal, root: join(directory, 'jobs'), evidenceService: client.spreadsheet, nodeId: 'pc-b', onError: cause => errors.push(cause.code) }); host = createAgentHost({ nodeId: 'pc-b', journal, runtime, jobs })
  async function pump() { for (const command of (await client.resync()).pending) { const value = await client.resolveCommand(command); await host.accept({ workspaceId: 'local', nodeId: 'pc-b' }, value); await client.ack(value) }; await host.process(); await host.flushEvents(event => client.event(event)) }
  const history = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '护罩松动', owner: '张工' }] })), ref = (await fixture.attachments.init(owner, { clientRequestId: 'history', name: 'history.json', mediaType: 'application/json', sizeBytes: history.length, sha256: hash(history) })).ref; await fixture.attachments.upload(owner, ref.attachmentId, Readable.from([history]))
  const created = await api('/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: '执行期限不等于业务表格期限', clientRequestId: 'create', budgetPolicyId: 'office-deadline', attachmentRefs: [ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-20' } }); assert.equal(created.status, 200)
  const workId = created.value.id; await pump(); const execution = (await journal.read()).executions[0]
  const job = await runtime.spreadsheet(execution, 'start_spreadsheet', { clientRequestId: 'job', instructionRevision: 1, template: templateReference(), historyRefs: [ref], rows: [{ sourceRef: ref, entryIndex: 0, dueDate: '2026-11-20', photoRefs: [] }] })
  const until = async predicate => { const end = Date.now() + 20000; while (!await predicate()) { assert(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 25)) } }
  await until(async () => (await jobs.get(execution, { jobId: job.id })).state === 'candidate'); await host.flushEvents(event => client.event(event)); const candidate = await jobs.readCandidate(job.id)
  let deadline
  async function shorten(ms) { deadline = new Date(Date.now() + ms).toISOString(); assert.equal((await api(`/api/admin/works/${workId}/budget`, { clientRequestId: 'shorten', expectedRevision: 1, reason: '真实candidate/ready跨执行截止', limits, executionDeadlineAt: deadline })).status, 200) }
  if (!candidateMode) await shorten(2000)
  const issued = await client.spreadsheet.issueUploadToken(candidate.job); assert(issued.expiresAt <= Date.parse((await fixture.store.read()).works.find(row => row.id === workId).modelRequestBudget.executionDeadlineAt))
  const initialized = await fetch(fixture.origin + '/internal/artifacts/candidates/init', { method: 'POST', headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.id, version: 1, sha256: hash(candidate.bytes), sizeBytes: candidate.bytes.length }) }); assert.equal(initialized.status, 200); const metadata = await initialized.json()
  const uploading = fetch(fixture.origin + `/internal/artifacts/candidates/${metadata.id}/content`, { method: 'PUT', headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/octet-stream' }, body: candidate.bytes })
  if (candidateMode) { await verificationEntered.promise; await shorten(100); await until(async () => Date.now() >= Date.parse(deadline)); releaseVerification() }
  const uploaded = await uploading, value = await uploaded.json()
  if (candidateMode) {
    assert.equal(uploaded.status, 409); assert.equal(value.error.code, 'EXECUTION_DEADLINE'); const after = await fixture.store.read(); assert.equal(after.artifacts[0].status, 'candidate'); assert.equal(after.works[0].status, 'running'); assert.equal((after.works[0].artifactRefs ?? []).length, 0)
    await assert.rejects(client.spreadsheet.issueUploadToken(candidate.job), { code: 'EXECUTION_DEADLINE' }); await assert.rejects(client.spreadsheet.revalidate(execution, { instructionRevision: 1, dueDate: '2026-11-20' }), { code: 'EXECUTION_DEADLINE' })
    await fixture.service.multisite.apply(owner, 'cancel', { workId, clientRequestId: 'stop' }); await pump(); assert.equal((await fixture.store.read()).works[0].status, 'cancelled')
  } else {
    assert.equal(uploaded.status, 200, JSON.stringify(value)); await pump(); await until(async () => Date.now() >= Date.parse(deadline))
    const download = await fetch(fixture.origin + `/api/works/${workId}/artifacts/${metadata.id}/content`, { headers: { cookie: actor.cookie } }); assert.equal(download.status, 200); const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(hash(bytes), hash(candidate.bytes)); const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes); assert.equal(book.worksheets[0].getCell('E3').text, '2026-11-20')
    await assert.rejects(client.spreadsheet.authorize(execution), { code: 'FORBIDDEN' }); await fixture.nodes.revoke(owner, 'pc-b', { clientRequestId: 'revoke', expectedRevision: redeemed.node.registrationRevision }); const denied = await fetch(fixture.origin + `/api/works/${workId}/artifacts/${metadata.id}/content`, { headers: { cookie: actor.cookie } }); assert.equal(denied.status, 403)
  }
  assert.deepEqual(errors, []); const final = await fixture.store.read(); assert.equal(final.modelRequests.length, 0)
  const result = { result: 'passed', directory, boundary: 'real remote HTTP + actual isolated XLSX worker and cloud verifier; simulated AgentDelivery, simulated price; controlled verifier barrier only in candidate mode', candidateMode, uploadTokenExpiryBounded: true, candidateVerificationCrossesDeadlineWithoutReady: candidateMode, expiredCandidateStopReachable: candidateMode, readyExpiredUserHttpDownloadOriginalBytesAndBusinessDate: !candidateMode, expiredDownloadStillChecksNodeDataRights: !candidateMode, actualProviderRequests: 0 }
  await writeFile(join(directory, 'final-state.json'), JSON.stringify(final, null, 2)); await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, message: cause.message, stack: cause.stack }, null, 2)); console.error(directory); throw cause } finally { releaseVerification?.(); await host?.close(); await fixture?.close() }
