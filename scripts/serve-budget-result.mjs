import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
const directory = resolve(process.argv[2]), result = JSON.parse(await readFile(join(directory, 'result.json')))
if (result.result !== 'passed' || !result.sameWorkBudgetReasonAuditAndCasDraft) throw new Error('需要已完成的预算界面验收对象')
const fixture = await startBridgeService({ directory: join(directory, 'api'), index: await readFile('web/index.html', 'utf8') })
console.log(JSON.stringify({ directory, origin: fixture.origin, pid: process.pid, workId: result.workId, mode: 'existing-budget-result-no-Host' }))
let closing
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { closing ??= fixture.close().finally(() => process.exit(0)) })
