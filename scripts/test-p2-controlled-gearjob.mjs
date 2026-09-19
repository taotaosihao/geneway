import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTROLLED_WORK_ORDER_ID, startControlledGearJob } from './p2-controlled-gearjob.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p2-controlled-'))
const sourceFile = join(root, 'source-token')
const controlFile = join(root, 'control-token')
await writeFile(sourceFile, 'Bearer source-secret\n')
await writeFile(controlFile, JSON.stringify({ token: 'control-secret' }))
await chmod(sourceFile, 0o600)
await chmod(controlFile, 0o600)

const instance = await startControlledGearJob({ env: {
  GENEWAY_P2_CONTROLLED_SOURCE_CREDENTIAL_FILE: sourceFile,
  GENEWAY_P2_CONTROLLED_CONTROL_CREDENTIAL_FILE: controlFile,
  GENEWAY_P2_CONTROLLED_ENABLE: 'true',
  GENEWAY_P2_CONTROLLED_HOST_HEADER: 'controlled-b.local',
} })
const resource = `${instance.address}/api/resource/Work%20Order/${CONTROLLED_WORK_ORDER_ID}`
const sourceHeaders = { authorization: 'Bearer source-secret', host: 'controlled-b.local' }
const controlHeaders = { authorization: 'Bearer control-secret', 'content-type': 'application/json' }

try {
  assert.equal(instance.server.address().address, '127.0.0.1')
  assert.equal((await requestJson(resource)).status, 401)
  assert.equal((await requestJson(resource, { authorization: 'Bearer source-secret', host: 'wrong.local' })).status, 403)
  assert.equal((await requestJson(resource, { authorization: 'Bearer wrong', host: 'controlled-b.local' })).status, 403)

  const first = await requestJson(resource, sourceHeaders)
  assert.equal(first.status, 200)
  const firstRecord = first.body.data
  assert.deepEqual(
    [firstRecord.name, firstRecord.qty, firstRecord.produced_qty, firstRecord.source_time, firstRecord.revision],
    [CONTROLLED_WORK_ORDER_ID, 10, 7, '2026-09-19T00:00:00.000Z', 'controlled-b-r1'],
  )
  assert.equal(firstRecord._geneway_controlled_source, true)
  assert.equal(firstRecord.source_system, 'Frappe-compatible controlled source')

  assert.equal((await requestJson(`${instance.address}/api/resource/Work%20Order/MISSING`, sourceHeaders)).status, 404)
  assert.equal((await fetch(`${instance.address}/__control/state`)).status, 401)
  assert.equal((await fetch(`${instance.address}/__control/state`, { headers: { authorization: 'Bearer wrong' } })).status, 403)

  const updated = await fetch(`${instance.address}/__control/update`, {
    method: 'POST',
    headers: controlHeaders,
    body: JSON.stringify({ completedQuantity: 7, delayMs: 1 }),
  })
  assert.equal(updated.status, 200)
  assert.deepEqual(Object.assign({}, await updated.json()), {
    plannedQuantity: 10,
    completedQuantity: 7,
    delayMs: 1,
    callCount: 1,
    revision: 2,
    sourceTime: '2026-09-19T00:00:01.000Z',
    workOrderId: CONTROLLED_WORK_ORDER_ID,
    controlled: true,
    sourceKind: 'Frappe-compatible controlled source',
  })

  const secondRecord = (await requestJson(resource, sourceHeaders)).body.data
  assert.equal(secondRecord.produced_qty, 7)
  assert.equal(secondRecord.revision, 'controlled-b-r2')
  const state = await (await fetch(`${instance.address}/__control/state`, { headers: controlHeaders })).json()
  assert.equal(state.callCount, 2)

  const reset = await fetch(`${instance.address}/__control/reset`, { method: 'POST', headers: controlHeaders })
  assert.equal(reset.status, 200)
  assert.equal((await reset.json()).callCount, 0)
  console.log('P2 controlled Frappe-compatible source checks passed')
} finally {
  await instance.close()
  await rm(root, { recursive: true, force: true })
}

const disabled = await startControlledGearJob({ env: { GENEWAY_P2_CONTROLLED_SOURCE_AUTHORIZATION: 'token source-secret' } })
try {
  assert.equal((await fetch(`${disabled.address}/__control/state`, { headers: { authorization: 'Bearer control-secret' } })).status, 404)
  assert.equal((await fetch(`${disabled.address}/api/resource/Work%20Order/${CONTROLLED_WORK_ORDER_ID}`, { headers: { authorization: 'token source-secret' } })).status, 200)
} finally {
  await disabled.close()
}

const customId = 'WO-26-00096'
const custom = await startControlledGearJob({ env: { GENEWAY_P2_CONTROLLED_SOURCE_AUTHORIZATION: 'Bearer source-secret', GENEWAY_P2_CONTROLLED_WORK_ORDER_ID: customId } })
try {
  const response = await fetch(`${custom.address}/api/resource/Work%20Order/${customId}`, { headers: { authorization: 'Bearer source-secret' } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.name, customId)
} finally {
  await custom.close()
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const pending = request(url, { headers }, response => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { raw += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) }))
    })
    pending.once('error', reject)
    pending.end()
  })
}
