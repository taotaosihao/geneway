import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client'

export async function createA2aClient({ origin, tokenFile, caFile, cardPath } = {}) {
  const target = new URL(origin)
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Use HTTPS or explicit loopback HTTP')
  const token = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : null, ca = caFile ? await readFile(caFile) : undefined
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== target.origin) throw new Error('The independent client will not send credentials to another origin')
    const headers = new Headers(options.headers); if (token) headers.set('authorization', 'Bearer ' + token)
    if (!ca) return fetch(url, { ...options, headers, redirect: 'error' })
    if (url.protocol !== 'https:') throw new Error('A private CA requires HTTPS')
    return new Promise((resolve, reject) => {
      const request = httpsRequest(url, { method: options.method ?? 'GET', headers: Object.fromEntries(headers), ca, signal: options.signal }, response => {
        const headers = new Headers(); for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers }))
      }); request.once('error', reject); request.end(options.body)
    })
  }
  const resolver = new DefaultAgentCardResolver({ fetchImpl })
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: resolver, preferredTransports: ['JSONRPC'] })
  return { client: await factory.createFromUrl(origin, cardPath), card: await resolver.resolve(origin, cardPath) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--config'); if (index < 0) throw new Error('Usage: node peers/a2a/client.mjs --config FILE')
  const config = JSON.parse(await readFile(resolve(process.argv[index + 1]), 'utf8')), { client, card } = await createA2aClient(config)
  const parameters = config.requestFile ? JSON.parse(await readFile(config.requestFile, 'utf8')) : config.request ?? {}, options = { signal: AbortSignal.timeout(config.timeoutMs ?? 10000) }
  const method = config.operation ?? 'discover'
  let result
  if (method === 'discover') result = card
  else if (method === 'stream') { result = []; for await (const event of client.sendMessageStream(parameters, options)) { result.push(event); if (!config.outputFile) process.stdout.write(JSON.stringify({ event: 'stream', value: event }) + '\n') } }
  else if (['sendMessage', 'getTask', 'cancelTask', 'listTasks'].includes(method)) result = await client[method](parameters, options)
  else throw new Error('Unsupported independent client operation')
  if (config.outputFile) await writeFile(config.outputFile, JSON.stringify(result, null, 2), { mode: 0o600 })
  else process.stdout.write(JSON.stringify({ event: 'result', operation: method, result }) + '\n')
}
