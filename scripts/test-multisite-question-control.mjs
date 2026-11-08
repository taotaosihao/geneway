import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { authorizeQuestionClosureCommand } from '../src/multisite-authorization.mjs'
import { seal } from '../packages/agent-contracts/index.mjs'

const source = process.argv[2]
assert(source, 'Provide an actual native control-boundary.json; never create positive receipts here')
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/question-control-guards-'), original = JSON.parse(await readFile(source)), state = original.after
const command = state.multisite.outbox.find(row => row.command.parameters.messages?.[0]?.kind === 'question_closed').command
// The positive facts come only from the referenced actual native producer.
authorizeQuestionClosureCommand(state, command)
const tests = [
  ['ordinary-wake', (state, command) => { command.parameters.messages[0].kind = 'answer' }],
  ['wrong-message-id', (state, command) => { command.parameters.messages[0].id = 'wrong' }],
  ['wrong-release-kind', (state, command) => { command.parameters.waitRelease.kind = 'dependency' }],
  ['wrong-question-id', (state, command) => { command.parameters.waitRelease.id = 'wrong' }],
  ['wrong-target', (state, command) => { command.parameters.messages[0].targetAttemptId = state.multisite.attempts.find(row => row.agent_id === 'gateway').attempt_id }],
  ['wrong-binding', (state, command) => { command.session_id = 'other-session' }],
  ['wrong-revision', (state, command) => { command.instruction_revision++ }],
  ['nonterminal-question', state => { state.multisite.questions[0].state = 'open' }],
  ['unknown-attempt', state => { state.multisite.attempts.find(row => row.agent_id === 'desktop-office').status = 'unknown' }],
  ['receiver-revoked', state => { state.nodes.find(row => row.id === 'pc-b').status = 'cleanup_only' }],
  ['employee-version-changed', state => { state.employees.find(row => row.id === 'desktop-office').revision++ }],
  ['not-original-outbox', state => { state.multisite.outbox = [] }],
]
for (const [name, mutate] of tests) {
  const copy = structuredClone(state), candidate = structuredClone(command); mutate(copy, candidate)
  const { payload_digest, ...body } = candidate, sealed = seal(body), entry = copy.multisite.outbox.find(row => row.id === command.command_id)
  if (entry) entry.command = sealed
  assert.throws(() => authorizeQuestionClosureCommand(copy, sealed), { code: 'FORBIDDEN' }, name)
}
const result = { result: 'passed', directory, source, boundary: 'real native positive snapshot reused; isolated negative cloned proof/authority views, not additional HTTP/native journeys', actualConsumedClosureStillFetchable: true, rejected: tests.map(row => row[0]) }
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
