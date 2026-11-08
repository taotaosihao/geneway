import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client'

export async function workGroupClient({ card, token, caFile }) {
  const origin = new URL(card.supportedInterfaces[0].url).origin, ca = caFile ? await readFile(caFile) : undefined
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== origin) throw new Error('Work group client target changed')
    const headers = new Headers(options.headers); headers.set('authorization', 'Bearer ' + token)
    if (!ca) return fetch(url, { ...options, headers, redirect: 'error' })
    if (url.protocol !== 'https:') throw new Error('A private CA requires HTTPS')
    return new Promise((resolve, reject) => {
      const request = httpsRequest(url, { method: options.method ?? 'GET', headers: Object.fromEntries(headers), ca, signal: options.signal }, response => {
        const headers = new Headers(); for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers }))
      }); request.once('error', reject); request.end(options.body)
    })
  }
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], preferredTransports: ['JSONRPC'] }).createFromAgentCard(card)
}
