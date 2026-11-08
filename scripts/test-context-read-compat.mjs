import { emptySiteRuleState } from '../src/site-rule-state.mjs'
import { emptySupervisionDiagnosisState } from '../src/supervision-diagnosis-state.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileStore, STATE_VERSION } from '../src/store/file-store.mjs'
import { emptyContextReadState } from '../src/context-read-state.mjs'
import { emptySupervisionState } from '../src/supervision-state.mjs'

// 真实前phase归档，只复制状态文件；不复制秘密或Node identity，不运行旧Session。
const evidenceRoot = process.env.GENEWAY_CONTEXT_COMPAT_EVIDENCE_ROOT ?? '/home/gewu/.codex/task-checkpoints/geneway-evidence'
const sources = [
  ['native-manual-released', 'manual-control-native-2RvRxX/after-resume.json'],
  ['retained-evidence-artifact-budget', 'manual-preservation-sol-20261106/old-evidence-budget-artifact/state.json'],
  ['retained-router-unknown', 'manual-preservation-sol-20261106/router-unknown/state.json'],
]
const directory = await mkdtemp(join(evidenceRoot, 'context-read-compat-'))
const additions = { ...emptySiteRuleState(), routingBatches: [], ...emptySupervisionDiagnosisState(), ...emptyContextReadState(), ...emptySupervisionState(), workMemberRemovals: [], a2aProtocol: { tasks: [], groups: [], deliveries: [] } }
assert.equal(STATE_VERSION, 31)
assert.deepEqual(Object.keys(additions).sort(), ['contextReadInstances', 'contextReadWindows', 'contextReads', 'supervisionFindings', 'supervisionActions', 'workMemberRemovals', 'a2aProtocol', ...Object.keys(emptySupervisionDiagnosisState()), 'routingBatches', ...Object.keys(emptySiteRuleState())].sort())
const results = []
const counts = value => Object.fromEntries(Object.entries(value).flatMap(([name, item]) => Array.isArray(item) ? [[name, item.length]] : name === 'multisite' ? [[name, counts(item)]] : []))
for (const [name, relative] of sources) {
  const source = join(evidenceRoot, relative), bytes = await readFile(source), before = JSON.parse(bytes)
  assert.equal(before.version, 24, `${source} must be an actual retained v24 source`)
  for (const field of Object.keys(additions)) assert.equal(Object.hasOwn(before, field), false, `${field} must not be fabricated into old source`)
  const targetDirectory = join(directory, name); await mkdir(targetDirectory)
  const target = join(targetDirectory, 'state.json'); await writeFile(target, bytes)
  const expected = { ...before, version: 31, ...additions }
  assert.deepEqual(await createFileStore(target).read(), expected)
  assert.deepEqual(await readFile(target), bytes, 'read must not rewrite even copied bytes')
  await createFileStore(target).update(state => state)
  const persisted = JSON.parse(await readFile(target, 'utf8'))
  assert.deepEqual(persisted, expected, 'all prior fields, including seals and control/ledger facts, must remain equal')
  assert.deepEqual(await createFileStore(target).read(), expected, 'fresh FileStore reopen must preserve the committed migration')
  assert.deepEqual(await readFile(source), bytes, 'original archived source bytes must remain unchanged')
  const result = { name, source, target, sourceVersion: before.version, targetVersion: persisted.version,
    sourceBytes: bytes.length, sourceBytesUnchanged: true, allOldFieldsDeepEqual: true,
    allowedDifferences: ['version:24→31', ...Object.keys(additions).map(field => `${field}:${JSON.stringify(additions[field])} newly added`)],
    oldFacts: counts(before), unknownModelRequests: before.modelRequests.filter(row => row.outcome === 'unknown').length,
    positiveContextFactsAdded: 0 }
  results.push(result)
  console.log(JSON.stringify(result))
}
const result = { result: 'passed', directory, cases: results,
  sourceProvenance: 'native-manual source is actual prior HTTP/Host/native archive; two retained sources are independently verified prior-phase real 23→24 FileStore migration outputs, never relabeled or stripped',
  boundary: 'public FileStore read/noop update/persist/reopen on independent copies only; exact whole-state equality except version and three empty context arrays and two empty supervision arrays and empty workMemberRemovals plus empty a2aProtocol tasks/groups/deliveries; no runtime/provider/API/Host/worker, new read/permission/consume facts or artifact binary/session execution acceptance' }
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ result: result.result, directory, cases: results.length }))
