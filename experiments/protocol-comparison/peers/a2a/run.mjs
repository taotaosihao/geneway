import express from 'express'
import { createServer as createHTTPServer } from 'node:http'
import { createServer as createHTTPSServer } from 'node:https'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, TaskState } from '@a2a-js/sdk'
import { DefaultRequestHandler } from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express'
import { UnsupportedOperationError } from '@a2a-js/sdk/errors'
import { FileTaskStore } from './storage.mjs'
import { ProcessExecutor } from './executor.mjs'

export async function startA2aPeer({ root, host = '127.0.0.1', port = 0, tls } = {}) {
  if (!root || host !== '127.0.0.1') throw new Error('The independent fixture requires an explicit root and loopback host')
  root = resolve(root); await mkdir(join(root, 'executions'), { recursive: true, mode: 0o700 })
  const tokenFile = join(root, 'client-token')
  try { const file = await open(tokenFile, 'wx', 0o600); try { await file.writeFile(randomBytes(32).toString('hex')); await file.sync() } finally { await file.close() } } catch (error) { if (error.code !== 'EEXIST') throw error }
  const token = (await readFile(tokenFile, 'utf8')).trim(); if (token.length < 32) throw new Error('Peer token is invalid')
  const store = new FileTaskStore(root), executor = new ProcessExecutor(root)
  // The fixed official handler cancels without invoking the executor when its
  // event bus was lost on restart. Stop and prove exit before allowing that path.
  class ExitGuardedHandler extends DefaultRequestHandler {
    async requireNewExecution(params, context) {
      if (params.message?.taskId && await store.load(params.message.taskId, context)) throw new UnsupportedOperationError('This deterministic peer does not execute follow-up messages on an existing Task')
    }
    async sendMessage(params, context) { await this.requireNewExecution(params, context); return super.sendMessage(params, context) }
    async *sendMessageStream(params, context) { await this.requireNewExecution(params, context); yield* super.sendMessageStream(params, context) }
    async cancelTask(params, context) {
      const task = await store.load(params.id, context)
      if (task && ![TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED].includes(task.status?.state)) await executor.stopTask(params.id)
      return super.cancelTask(params, context)
    }
  }
  const card = {
    name: 'Independent official A2A peer', description: 'Deterministic isolated process executor; no Geneway adapter or business state imports', version: '0.1.0',
    supportedInterfaces: [{ url: '', protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    securitySchemes: { peerBearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { scheme: 'Bearer', bearerFormat: 'opaque', description: 'A private token belonging to this isolated peer' } } } },
    securityRequirements: [{ schemes: { peerBearer: { list: [] } } }],
    skills: [{ id: 'process-echo', name: 'Process echo', description: 'Produce deterministic file side effects and echo input text; supports physical process cancellation', tags: ['fixture'], examples: [], inputModes: ['text/plain'], outputModes: ['text/plain'], securityRequirements: [] }],
    signatures: [], documentationUrl: '',
  }
  const handler = new ExitGuardedHandler(card, store, executor), app = express()
  app.use((request, response, next) => { response.on('finish', () => { void appendFile(join(root, 'wire.jsonl'), JSON.stringify({ at: new Date().toISOString(), method: request.method, path: request.path, status: response.statusCode, a2aVersion: request.headers['a2a-version'] ?? null }) + '\n', { mode: 0o600 }).catch(error => console.error(error.code)) }); next() })
  app.use('/' + AGENT_CARD_PATH, agentCardHandler({ agentCardProvider: handler }))
  app.use('/a2a', (request, response, next) => {
    const candidate = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1], actual = Buffer.from(candidate ?? ''), expected = Buffer.from(token)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.setHeader('www-authenticate', 'Bearer'); response.status(401).json({ error: 'UNAUTHENTICATED' }); return }
    next()
  }, jsonRpcHandler({ requestHandler: handler, userBuilder: () => ({ isAuthenticated: true, userName: 'independent-peer-client' }) }))
  const server = tls ? createHTTPSServer({ key: await readFile(tls.keyFile), cert: await readFile(tls.certFile) }, app) : createHTTPServer(app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  const origin = `${tls ? 'https' : 'http'}://${host}:${server.address().port}`; card.supportedInterfaces[0].url = origin + '/a2a'
  let closing
  return { origin, root, tokenFile, protocol: 'a2a', versions: { sdk: '1.3.0', wire: A2A_PROTOCOL_VERSION }, pid: process.pid,
    close(options = {}) { return closing ??= (async () => { const closed = new Promise(resolve => server.close(resolve)); await executor.close(options); server.closeAllConnections(); await closed })() },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log = (...values) => console.error(...values)
  const index = process.argv.indexOf('--config'); if (index < 0) throw new Error('Usage: node peers/a2a/run.mjs --config FILE')
  const config = JSON.parse(await readFile(resolve(process.argv[index + 1]), 'utf8')), peer = await startA2aPeer(config)
  process.stdout.write(JSON.stringify({ event: 'ready', origin: peer.origin, pid: process.pid, protocol: 'a2a', versions: peer.versions, root: peer.root, tokenFile: peer.tokenFile }) + '\n')
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { peer.close({ preserveExecutors: config.preserveExecutorsOnClose === true }).then(() => process.exit(0), error => { console.error(error.stack); process.exit(1) }) })
}
