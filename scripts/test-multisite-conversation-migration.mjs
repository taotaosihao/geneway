import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migrateState } from '../src/store/file-store.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
const source = process.argv[2]
assert(source, 'Provide the actual D3a before-sigkill.json; never seed positive Evidence facts')
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/conversation-migration-'), original = JSON.parse(await readFile(source)), old = original.cloud
assert.equal(old.version, 19)
const next = migrateState(structuredClone(old)); assert.equal(next.version, 21); assert.deepEqual(next.multisite.questions, [])
const comparison = structuredClone(next); comparison.version = 19; delete comparison.multisite.questions;for(const field of ['budgetPolicies','budgetCommands','budgetAdjustments','budgetHolds']){assert.deepEqual(comparison[field],[]);delete comparison[field]}; assert.deepEqual(comparison, old)
assert.deepEqual(migrateState(next), next)
for (const mutate of [copy => copy.multisite.questions = [{ id: 'invalid-old-question' }], copy => copy.multisite.results.push({ schema: 'geneway.analysis-result/1' }), copy => copy.evidenceAccessReceipts.push({ reason: 'share' })]) { const copy = structuredClone(old); mutate(copy); assert.throws(() => migrateState(copy), /旧版本状态不得包含定向协作事实/) }
const path = join(directory, 'host.json'); await writeFile(path, JSON.stringify(original.journal)); const journal = createHostJournal(path); assert.deepEqual(await journal.read(), original.journal); await journal.update(() => {}); assert.deepEqual(await journal.read(), original.journal)
const result = { result: 'passed', directory, source, actualV19EvidenceBudgetModelDelegationFactsPreserved: true, actualHostV3CaptureAndExecutionFactsPreserved: true, mislabeledNewConversationFactsRejected: true, boundary: 'actual earlier D3a producer state/journal read and migrate/no-op persist; not a new business or OS recovery journey' }
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
