import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const check = `
import assert from 'node:assert/strict'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createDshRunner } from './src/dsh-runner.mjs'
import { createCollaborationRunner } from './src/collaboration-runner.mjs'
const dshHome = process.env.GENEWAY_TEST_DSH_HOME
const scenario = process.env.GENEWAY_TEST_HOME_CASE
const stopped = Object.assign(new Error('injected before native startup'), { code: 'INJECTED_STOP' })
let harnessFactories = 0, profileCalls = 0
const runner = createDshRunner({
  config: { dshHome, dataRoot: dshHome, stateFile: join(dshHome, 'state.json'), secretRoot: join(dshHome, 'secrets'), source: {}, model: { configured: true } },
  harnessFactory(options) {
    harnessFactories += 1
    assert.equal(options.dshHome, dshHome)
    assert.equal(options.env.DSH_HOME, dshHome)
    throw stopped
  },
})
await assert.rejects(runner.run({
  capabilityId: 'cycle-time-calculate', input: { availableSeconds: 60, quantity: 1 },
  sessionMetadata: { ownerMemberId: 'member', workId: 'work', employeeId: 'employee', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', modelRouteId: 'route', confirmationFingerprint: 'none', confirmationRefs: [], connectionId: null, connectionRevision: null },
}), error => error === stopped)
const collaboration = createCollaborationRunner({
  store: {}, dshHome,
  runProfileImpl: async options => {
    profileCalls += 1
    assert.equal(options.environment.get('DSH_HOME').value, dshHome)
    throw stopped
  },
})
await assert.rejects(collaboration.enableKnowledge(), error => scenario === 'matching' ? error === stopped : error.code === 'RUNTIME_HOME_MISMATCH')
await collaboration.close()
await runner.close()
await assert.rejects(lstat(join(process.env.HOME, '.dsh')), error => error.code === 'ENOENT')
console.log(JSON.stringify({ scenario, harnessFactories, profileCalls, nativeStarts: 0 }))
`

const root = await mkdtemp(join(tmpdir(), 'geneway-runtime-home-'))
try {
  for (const scenario of ['missing', 'different', 'matching']) {
    const expectedHome = join(root, scenario, 'runtime')
    const env = { PATH: process.env.PATH, HOME: join(root, scenario, 'home'), GENEWAY_TEST_DSH_HOME: expectedHome, GENEWAY_TEST_HOME_CASE: scenario }
    if (scenario !== 'missing') env.DSH_HOME = scenario === 'matching' ? expectedHome : join(root, 'other')
    const child = spawnSync(process.execPath, ['--input-type=module'], { cwd: process.cwd(), input: check, env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(child.status, 0, `${scenario}: ${child.stderr}`)
    assert.deepEqual(JSON.parse(child.stdout), { scenario, harnessFactories: 1, profileCalls: scenario === 'matching' ? 1 : 0, nativeStarts: 0 })
  }
  console.log('DSH home checks passed in 3 isolated processes; native SDK/Cordis/model starts=0')
} finally {
  await rm(root, { recursive: true, force: true })
}
