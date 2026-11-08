import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Role, TaskState } from '@a2a-js/sdk'
import { createA2aClient } from './client.mjs'

function requireTask(value) {
  assert(value && typeof value.id === 'string' && value.id && typeof value.contextId === 'string' && value.status && Array.isArray(value.artifacts), 'The official endpoint must return a Task, not a Message or a business ACK')
  return value
}
async function downloadArtifact(config, task) {
  assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED, 'Download requires the current server Task to be Completed')
  assert(config.downloadFile, 'Provide downloadFile for the actual artifact bytes')
  const artifact = task.artifacts[0], part = artifact?.parts?.find(part => part.content?.$case === 'url' && typeof part.content.value === 'string')
  assert(artifact?.artifactId && part, 'The completed Task must expose a typed artifact URL')
  const origin = new URL(config.origin), url = new URL(part.content.value, origin)
  assert.equal(url.origin, origin.origin, 'Artifact download must stay on the authenticated origin')
  assert(!url.username && !url.password, 'Artifact URL must not contain credentials')
  const token = (await readFile(config.tokenFile, 'utf8')).trim()
  assert(token, 'Provide the opaque peer credential for artifact download')
  if (config.caFile) assert.equal(url.protocol, 'https:', 'An explicit private CA requires HTTPS')
  const ca = config.caFile ? await readFile(config.caFile) : undefined
  const response = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', headers: { authorization: 'Bearer ' + token },
      ...(ca ? { ca } : {}), signal: AbortSignal.timeout(config.timeoutMs ?? 30000),
    }, resolve)
    request.once('error', reject); request.end()
  })
  if (response.statusCode !== 200) { response.resume(); throw new Error('Artifact download failed with HTTP ' + response.statusCode) }
  await mkdir(dirname(resolve(config.downloadFile)), { recursive: true })
  let file, completed = false, size = 0
  const hash = createHash('sha256')
  try {
    file = await open(config.downloadFile, 'wx', 0o600)
    for await (const bytes of response) { hash.update(bytes); size += bytes.length; await file.writeFile(bytes) }
    await file.sync(); completed = true
  } finally {
    await file?.close()
    if (!completed) { response.destroy(); if (file) await unlink(config.downloadFile) }
  }
  return { file: resolve(config.downloadFile), sha256: hash.digest('hex'), size, taskArtifactId: artifact.artifactId, globalRef: artifact.metadata?.globalRef ?? null, url: url.href }
}

export async function runBusinessClient(config) {
  assert(['create', 'input', 'get', 'download', 'cancel'].includes(config.operation), 'Choose create, input, get, download or cancel')
  assert(config.outputFile, 'Provide outputFile for the observed Task and business receipt')
  if (['create', 'input'].includes(config.operation)) assert(typeof config.clientRequestId === 'string' && config.clientRequestId, 'Provide the stable protocol clientRequestId')
  if (config.operation !== 'create') assert(typeof config.taskId === 'string' && config.taskId, 'Provide the current protocol Task ID')
  if (config.operation === 'input') assert(typeof config.contextId === 'string' && config.contextId, 'Provide the current protocol context ID')
  const { client } = await createA2aClient(config), options = { signal: AbortSignal.timeout(config.timeoutMs ?? 30000) }
  let task
  if (config.operation === 'create' || config.operation === 'input') {
    // Parameters remain the original production request body. The protocol
    // idempotency key and Task identity are not substitutes for business facts.
    const payload = { schema: 'geneway.protocol-task/1', operation: config.operation, clientRequestId: config.clientRequestId, parameters: config.parameters ?? {} }
    task = requireTask(await client.sendMessage({
      message: { messageId: config.clientRequestId, contextId: config.operation === 'input' ? config.contextId : '', taskId: config.operation === 'input' ? config.taskId : '', role: Role.ROLE_USER, parts: [{ content: { $case: 'data', value: payload }, mediaType: 'application/json', filename: '', metadata: {} }], metadata: {}, extensions: [], referenceTaskIds: [] },
      configuration: { returnImmediately: true },
    }, options))
  } else if (config.operation === 'cancel') task = requireTask(await client.cancelTask({ id: config.taskId }, options))
  else task = requireTask(await client.getTask({ id: config.taskId }, options))
  if (config.operation !== 'create') assert.equal(task.id, config.taskId, 'The observed Task must retain its protocol identity')
  if (config.operation === 'input') assert.equal(task.contextId, config.contextId, 'Input must retain the original Task context')
  const result = { operation: config.operation, task, geneway: task.metadata?.geneway ?? null }
  if (config.operation === 'download') result.download = await downloadArtifact(config, task)
  await mkdir(dirname(resolve(config.outputFile)), { recursive: true })
  await writeFile(config.outputFile, JSON.stringify(result, null, 2), { mode: 0o600 })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--config'); if (index < 0) throw new Error('Usage: node peers/a2a/business-client.mjs --config FILE')
  const config = JSON.parse(await readFile(resolve(process.argv[index + 1]), 'utf8'))
  await runBusinessClient(config)
  process.stdout.write(JSON.stringify({ event: 'saved', operation: config.operation, outputFile: resolve(config.outputFile), ...(config.operation === 'download' ? { downloadFile: resolve(config.downloadFile) } : {}) }) + '\n')
}
