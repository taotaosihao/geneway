import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { AWIKI_CHECKOUT, peerCommand } from './run.mjs'

// This client observes the independent Host's persisted messages, never the Home's memory.
export async function runBusinessClient(config) {
  const { peerConfigPath, handle = 'business-owner', groupDid, homeDid, clientRequestId, outputFile } = config
  assert(['create', 'input', 'get', 'download', 'cancel'].includes(config.operation))
  assert(clientRequestId && groupDid && homeDid && outputFile)
  const peer = { identity: { configPath: resolve(peerConfigPath) } }
  const payload = { schema: 'geneway.protocol-task/1', operation: config.operation === 'download' ? 'get' : config.operation, clientRequestId, requestId: clientRequestId }
  for (const key of ['parameters', 'taskId', 'contextId']) if (config[key] !== undefined) payload[key] = config[key]
  const hostReceipt = await peerCommand(peer, { operation: 'rpc', handle, method: 'group.send', operationId: 'business-' + clientRequestId, messageId: 'business-' + clientRequestId, target: groupDid, body: { payload } })
  const result = { request: payload, hostReceipt, response: null, task: null }
  await writeFile(outputFile, JSON.stringify(result, null, 2))
  const deadline = Date.now() + (config.timeoutMs ?? 60000)
  let since = 0
  for (;;) {
    const page = await peerCommand(peer, { operation: 'rpc', handle, method: 'group.list_messages', parameters: { group_did: groupDid, since_event_seq: since, limit: 100 } })
    for (const message of page.messages) {
      const body = message.body?.payload
      since = Math.max(since, Number(message.group_event_seq))
      if (message.sender_did === homeDid && body?.schema === 'geneway.protocol-task-response/1' && body.requestId === clientRequestId) {
        result.response = body; result.responseMessage = message; result.task = body.task ?? null
        await writeFile(outputFile, JSON.stringify(result, null, 2))
        if (body.error) throw new Error('Home business response: ' + JSON.stringify(body.error))
        assert.equal(result.task?.schema, 'geneway.task/1')
        if (config.operation === 'download') {
          assert.equal(result.task.state, 'completed', 'Download requires actual completed Task')
          const artifact = result.task.artifacts?.[0]
          assert(artifact?.url && config.downloadFile, 'Completed Task must expose an artifact URL and downloadFile')
          result.download = await download({ peerConfigPath, handle, url: artifact.url, downloadFile: config.downloadFile })
          if (artifact.sha256) assert.equal(result.download.sha256, artifact.sha256)
          if (artifact.sizeBytes !== undefined) assert.equal(result.download.sizeBytes, Number(artifact.sizeBytes))
          await writeFile(outputFile, JSON.stringify(result, null, 2))
        }
        return result
      }
    }
    assert(Date.now() < deadline, 'Timed out awaiting persisted Home business response')
    if (!page.has_more) await new Promise(done => setTimeout(done, 100))
  }
}
function download(config) {
  return new Promise((done, reject) => {
    const child = spawn(join(AWIKI_CHECKOUT, '.venv/bin/python'), [fileURLToPath(new URL('./business-download.py', import.meta.url))], { cwd: AWIKI_CHECKOUT, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    child.stdout.on('data', part => stdout.push(part)); child.stderr.on('data', part => stderr.push(part))
    child.once('error', reject)
    child.once('exit', code => { if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString())); try { done(JSON.parse(Buffer.concat(stdout))) } catch (cause) { reject(cause) } })
    child.stdin.end(JSON.stringify(config))
  })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--config'); assert(index !== -1 && process.argv[index + 1])
  const result = await runBusinessClient(JSON.parse(await readFile(process.argv[index + 1], 'utf8')))
  console.log(JSON.stringify({ taskId: result.task.id, state: result.task.state, outputFile: JSON.parse(await readFile(process.argv[index + 1], 'utf8')).outputFile }))
}
