import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { emptyInteractionState } from '../src/interaction-state.mjs'
const source = '/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-collaboration-native-os4rmP/api/state.json'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/interaction-migration-'), bytes = await readFile(source), before = JSON.parse(bytes)
assert.equal(before.version, 22)
const path = join(directory, 'state.json'); await writeFile(path, bytes)
const store = createFileStore(path); await store.update(state => state)
const after = await createFileStore(path).read()
assert.equal(after.version, 23)
for (const field of Object.keys(before).filter(field => field !== 'version')) assert.deepEqual(after[field], before[field], field)
for (const field of Object.keys(emptyInteractionState())) assert.deepEqual(after[field], [])
assert.deepEqual(await readFile(source), bytes)
const result = { result: 'passed', directory, source, originalVersion: 22, currentVersion: 23, originalFieldsDeepEqual: true, sourceBytesUnchanged: true, oldModelRequests: before.modelRequests.length, oldEvidence: before.evidence.length, oldReceipts: before.evidenceAccessReceipts.length, oldArtifacts: before.artifacts.length, boundary: 'actual retained v22 native D4 state copied to isolated FileStore; real migration/update/reopen, no execution or new positive interaction facts' }
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
