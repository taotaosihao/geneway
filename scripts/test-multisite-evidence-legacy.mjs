import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createEvidenceCaptures } from '../packages/agent-host/evidence-captures.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { evidenceDeclaration } from '../packages/agent-contracts/evidence.mjs'
import { binding, key, seal } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/evidence-legacy-'), source = '/home/gewu/.codex/task-checkpoints/geneway-evidence/evidence-parent-recovery-tvkq42', saved = JSON.parse(await readFile(join(source, 'before-sigkill.json')))
// Restore exact facts produced by the original native v1 barrier; never fabricate a receipt.
await mkdir(join(directory, 'api')); await writeFile(join(directory, 'api/state.json'), JSON.stringify(saved.cloud)); await writeFile(join(directory, 'host.json'), JSON.stringify(saved.journal))
const old = saved.journal.captures[0], identity = JSON.parse(await readFile(join(source, 'pc-a/node-identity.json'))), original = await readFile(join(source, 'pc-a/evidence-captures', `evidence-${old.id}`))
await mkdir(join(directory, 'sealed')); await writeFile(join(directory, 'sealed', `evidence-${old.id}`), original)
const fixture = await startBridgeService({ directory: join(directory, 'api') })
try {
  const client = createRemoteClient({ origin: fixture.origin, identity }), journal = createHostJournal(join(directory, 'host.json')), profile = { profileVersion: 1, resources: [{ resourceId: 'fixture:history', capabilityIds: ['evidence.history.read.v1'], adapterKind: 'history_json', root: join(directory, 'source-is-absent'), datasets: { history: 'source.json' }, allowedSections: [], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: ['desktop-data'], clockTrust: 'fixture' }] }
  assert.equal(old.captureFormatVersion, undefined); assert.equal(saved.cloud.evidence.length, 0)
  const captures = createEvidenceCaptures({ journal, root: join(directory, 'sealed'), profile, client }), args = { clientRequestId: old.requestId, instructionRevision: old.instructionRevision, resourceId: old.resourceId, datasetId: old.sourceId }
  const result = await captures.call(old.producerBinding, 'read_history', args); assert.equal(result.ref.id, `evidence-${old.id}`)
  let state = await fixture.store.read(); assert.equal(state.evidence[0].captureFormatVersion, undefined); assert.equal(state.evidence[0].profileDigest, undefined); assert.equal(state.evidence[0].declarationDigest, undefined); assert.equal(state.evidenceAccessReceipts.length, 1); assert.deepEqual(await readFile(join(directory, 'api/evidence', result.ref.id)), original)
  const local = (await journal.read()).captures[0]; assert.equal(local.captureFormatVersion, undefined); assert.equal(local.declarationDigest, undefined)
  const declaration = { ...evidenceDeclaration(old), legacyRetry: true }; assert.equal((await client.evidence.init(declaration)).status, 'ready')
  const attempt = state.multisite.attempts[0], input = state.multisite.inputs[0]
  // A real unavailable event changes authority; no direct Attempt/status seeding.
  await client.event(seal({ schema: 'geneway.multisite/1', event_id: key('legacy-unavailable', attempt.attempt_id), workspace_id: 'local', kind: 'runtime_unavailable', ...binding(attempt), input_id: input.id, instruction_revision: 1, observed_revision: 1, reason: 'RECOVERY_EXECUTION_UNCONFIRMED' }))
  await assert.rejects(client.evidence.init(declaration), { code: 'FORBIDDEN' })
  await assert.rejects(client.evidence.resume({ ...old, declarationDigest: '0'.repeat(64) }), { code: 'CAPTURE_RECOVERY_UNAVAILABLE' })
  assert.equal((await fixture.store.read()).evidence[0].captureFormatVersion, undefined)
  const output = { result: 'passed', directory, boundary: 'exact native v1 producer snapshot restored into isolated HTTP/FileStore fixture; no new positive receipt fabricated', legacySealedCurrentRetryWithNoCloudRow: true, originalBytesWithoutSourceRead: true, oldFactsNotPromotedOrDigested: true, legacyRetryUnknownRejected: true, legacyResumeRejected: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2))
} finally { await fixture.close() }
