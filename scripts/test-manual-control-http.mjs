import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { authorizeMultisiteExecution } from '../src/multisite-authorization.mjs'
import { binding } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-control-http-')
const observations = []
let fixture
try {
  fixture = await startBridgeService({ directory: join(directory, 'api') })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  assert.equal(login.status, 200)
  const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function api(path, body, expected = 200, method = 'POST') {
    const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json(); observations.push({ path, method, status: response.status, value })
    assert.equal(response.status, expected, JSON.stringify(value)); return value
  }
  const pair = await api('/api/admin/nodes/pairings', { clientRequestId: 'manual-pair', nodeId: 'cloud', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 60000).toISOString() })
  const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity })
  const paired = await client.post('/internal/nodes/pair', { pairingId: pair.pairingId, pairingCode: pair.pairingCode, clientRequestId: 'manual-redeem', ...identity }); identity.registrationRevision = paired.node.registrationRevision
  const created = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '人工控制HTTP受理边界，尚未启动Host。', clientRequestId: 'manual-create' })
  const before = await fixture.store.read(), attempt = before.multisite.attempts.find(row => row.work_id === created.id)
  const execution = { ...binding(attempt), session_id: `geneway-${attempt.launch_id}` }
  authorizeMultisiteExecution(before, execution)
  const pauseBody = { clientRequestId: 'manual-pause', scope: { kind: 'work' }, expectedControlGeneration: 0 }
  const pause = await api(`/api/works/${created.id}/multisite/pause`, pauseBody)
  assert.equal(pause.stage, 'pausing'); assert.equal(pause.controlGeneration, 1); assert.equal(pause.canWake, false)
  assert.deepEqual(await api(`/api/works/${created.id}/multisite/pause`, pauseBody), pause)
  await api(`/api/works/${created.id}/multisite/pause`, { ...pauseBody, clientRequestId: 'stale-pause' }, 409)
  await api(`/api/works/${created.id}/multisite/unknown`, { clientRequestId: 'unknown' }, 404)
  const paused = await fixture.store.read()
  assert.throws(() => authorizeMultisiteExecution(paused, execution), { code: 'MANUALLY_PAUSED' })
  const pending = await client.resync()
  assert.equal(pending.pending.filter(row => row.operation === 'launch').length, 0)
  assert.equal(pending.pending.filter(row => row.operation === 'manual_pause').length, 1)
  const view = await api('/api/works/' + created.id, undefined, 200, 'GET')
  assert.equal(view.multisite.manualControls.find(row => row.scope.kind === 'work').stage, 'pausing')
  const input = await api(`/api/works/${created.id}/multisite/inputs`, { clientRequestId: 'human-while-paused', text: '暂停期间保存的最新要求，不视为执行。' })
  assert.equal(input.workId, created.id)
  const resume = await api(`/api/works/${created.id}/multisite/resume`, { clientRequestId: 'manual-resume', scope: { kind: 'work' }, expectedControlGeneration: 1 })
  assert.equal(resume.stage, 'released'); assert.equal(resume.canWake, false)
  const final = await fixture.store.read()
  assert.throws(() => authorizeMultisiteExecution(final, execution), { code: 'MANUAL_RELEASE_PENDING' })
  assert.equal(final.works.find(row => row.id === created.id).instructionRevision, 2)
  assert.equal(final.manualControls.length, 2)
  assert.equal(final.modelRequests.length, 0)
  assert.deepEqual(final.works.find(row => row.id === created.id).modelRequestBudget, before.works.find(row => row.id === created.id).modelRequestBudget)
  assert(final.manualControls.flatMap(row => row.holders).every(row => !row.idleAt && !row.releasedAt && !row.resumeConsumedAt))
  const raw = JSON.parse(await readFile(join(directory, 'api/state.json'), 'utf8')); assert.equal(raw.version, 24)
  await writeFile(join(directory, 'before.json'), JSON.stringify(before, null, 2)); await writeFile(join(directory, 'final.json'), JSON.stringify(final, null, 2))
  await api(`/api/works/${created.id}/multisite/pause`, { clientRequestId: 'manual-pause-again', scope: { kind: 'work' }, expectedControlGeneration: 2 })
  await api('/api/admin/employees/coordinator', { expectedRevision: attempt.employeeRevision, enabled: false }, 200, 'PATCH')
  const disabled = await fixture.store.read()
  for (const operation of ['pause', 'resume']) await api(`/api/works/${created.id}/multisite/${operation}`, { clientRequestId: 'disabled-' + operation, scope: { kind: 'work' }, expectedControlGeneration: 3 }, 403)
  assert.deepEqual((await fixture.store.read()).manualControls, disabled.manualControls)
  assert.deepEqual(await api(`/api/works/${created.id}/multisite/pause`, pauseBody), pause)
  await writeFile(join(directory, 'disabled-root.json'), JSON.stringify(await fixture.store.read(), null, 2))
  const result = { result: 'passed', directory, workId: created.id, scopeGeneration: 2, actualHttpPauseResumeAndReplay: true, pauseDispatchesOnlyExactControl: true, humanInputPersistsWhilePaused: true, releaseDoesNotPretendSafeOrWake: true, disabledRootRejectsNewControlsKeepsExactReplay: true, actualModelForwards: 0, boundary: 'real authenticated HTTP, durable FileStore and paired Node Bridge; no Host/runtime started and no idle/resume-consumption facts manufactured; native/physical parking remains separate' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { await fixture?.close(); await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2)); console.log('Manual control root:', directory) }
