import { randomUUID } from 'node:crypto'
import { BRIDGE_LIMIT } from '../agent-contracts/command-bytes.mjs'
import { binding, error } from '../agent-contracts/index.mjs'

export function assertNodeTransport(transport) {
  if (!['internal', 'a2a'].includes(transport)) throw error('INVALID_REQUEST', '节点传输配置无效')
}

// Only a same-origin Message endpoint may receive the paired Node credential.
// Discovery is not authority to redirect it to another receiver or Task service.
export function createA2aNodeClient({ origin, headers, fetchImpl = fetch, signal: channelSignal }) {
  const base = new URL(origin)
  let clientPromise
  async function request(input, options = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== base.origin || !['/.well-known/agent-card.json', '/a2a'].includes(url.pathname) || url.search || url.hash || url.username || url.password) throw error('FORBIDDEN', '协议入口与配对服务不一致')
    const response = await fetchImpl(url, { ...options, headers: { ...Object.fromEntries(new Headers(options.headers)), ...headers() }, redirect: 'error', signal: AbortSignal.any([...(channelSignal ? [channelSignal] : []), ...(options.signal ? [options.signal] : []), AbortSignal.timeout(8000)]) })
    // The SDK owns JSON-RPC decoding; this boundary retains the Host's finite
    // response limit before that decoding can allocate an unbounded document.
    const chunks = []; let length = 0
    for await (const bytes of response.body ?? []) {
      length += bytes.length
      if (length > BRIDGE_LIMIT + 8192) throw error('INVALID_RESPONSE', '节点响应超限')
      chunks.push(bytes)
    }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  async function client() {
    if (!clientPromise) {
      clientPromise = (async () => {
        const { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } = await import('@a2a-js/sdk/client')
        return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: request })], cardResolver: new DefaultAgentCardResolver({ fetchImpl: request }) }).createFromUrl(base.origin)
      })()
      clientPromise.catch(() => { clientPromise = undefined })
    }
    return clientPromise
  }
  async function message(value, { signal, messageId = randomUUID() } = {}) {
    const current = await client()
    const result = await current.sendMessage({ message: { messageId, role: 1, parts: [{ content: { $case: 'data', value }, mediaType: 'application/json', filename: '' }], extensions: [], referenceTaskIds: [] } }, { signal })
    if (!result || typeof result.messageId !== 'string' || !Array.isArray(result.parts) || result.status) throw error('INVALID_RESPONSE', '节点命令必须返回协议消息')
    const parts = result.parts.filter(part => part.content?.$case === 'data')
    if (parts.length !== 1) throw error('INVALID_RESPONSE', '节点协议响应无效')
    return parts[0].content.value
  }
  return {
    message,
    async command(value) {
      const messageId = randomUUID()
      for (let index = 0; index < 3; index++) {
        try {
          const reply = await message(value, { messageId })
          if (!reply || Object.keys(reply).sort().join(',') !== 'body,status' || !Number.isInteger(reply.status) || reply.status < 100 || reply.status > 599 || Buffer.byteLength(JSON.stringify(reply.body) ?? '') > BRIDGE_LIMIT) throw error('INVALID_RESPONSE', '节点协议响应无效')
          if (reply.status < 200 || reply.status >= 300) {
            const cause = Object.assign(error(reply.body?.error?.code ?? 'REMOTE_UNAVAILABLE', reply.body?.error?.message ?? '节点请求失败'), { status: reply.status }), capacity = reply.body?.error?.capacity
            if (cause.code === 'CAPACITY_EXCEEDED' && capacity?.domain === 'cloud' && capacity.queue === 'ordinary') {
              cause.capacity = { domain: 'cloud', queue: 'ordinary' }
              if (typeof capacity.reason === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(capacity.reason)) cause.capacity.reason = capacity.reason
              for (const field of ['count', 'bytes']) if (Number.isSafeInteger(capacity[field]) && capacity[field] >= 0) cause.capacity[field] = capacity[field]
            }
            throw cause
          }
          return reply.body
        } catch (cause) {
          if (cause.status && cause.status < 500 || index === 2) throw cause
          await new Promise(resolve => setTimeout(resolve, 100 * (index + 1)))
        }
      }

    },
  }
}


// Protocol receipt polling never feeds the Agent Inbox. The cloud owns delivery
// durability; this finite observer keeps only opaque metadata for local diagnosis.
export function createA2aGroupPump({ client, executions, readMetadata = async () => null, onMetadata = async () => {}, onError = () => {} }) {
  const abort = new AbortController(), offered = new Map(), resolving = new Map()
  let active, closed = false, cursor = 0, loaded = false, recent = []
  const metadata = () => ({ schema: 'geneway.a2a.node-group-observation/1', observedAt: new Date().toISOString(), deliveries: recent.slice(-8), pending: [...offered.values()], resolving: [...resolving.values()] })
  const persist = () => onMetadata(metadata())
  function validate(row) {
    if (!row?.binding || !['deliveryId', 'locator', 'payloadDigest'].every(field => typeof row[field] === 'string' && row[field].length > 0 && row[field].length <= 512)) throw error('INVALID_STATE', '本地群收件元数据无效')
    return { binding: binding(row.binding), groupId: row.groupId, contextId: row.contextId, deliveryId: row.deliveryId, locator: row.locator, payloadDigest: row.payloadDigest, offeredAt: row.offeredAt, acknowledgedAt: row.acknowledgedAt, ackOperationId: row.ackOperationId ?? randomUUID(), dataState: row.dataState ?? 'unresolved' }
  }
  async function resolve(row, signal) {
    try {
      // Metadata ACK has already succeeded. This separate fresh read grants no
      // execution and is never persisted or delivered into the Agent Session.
      await client.group.body(row.binding, row.locator, { signal })
      resolving.delete(row.deliveryId); recent.push({ ...row, dataState: 'resolved', resolvedAt: new Date().toISOString() })
    } catch (cause) {
      if (closed) return
      const denied = cause.status === 403 || cause.status === 404
      const state = { ...row, dataState: denied ? 'denied' : 'unknown', dataCode: typeof cause.code === 'string' ? cause.code : 'REMOTE_UNAVAILABLE' }
      if (denied) resolving.delete(row.deliveryId); else resolving.set(row.deliveryId, state)
      recent.push(state)
    }
    recent = recent.slice(-8); await persist()
  }
  async function acknowledge(row, signal) {
    await persist()
    await client.group.ack(row.binding, row, { signal, operationId: row.ackOperationId })
    offered.delete(row.deliveryId)
    const acknowledged = { ...row, acknowledgedAt: new Date().toISOString(), dataState: 'unresolved' }
    resolving.set(row.deliveryId, acknowledged)
    await persist()
    await resolve(acknowledged, signal)
  }
  function run() {
    if (closed) return Promise.resolve()
    return active ??= (async () => {
      if (!loaded) {
        const previous = await readMetadata()
        if (previous) {
          if (previous.schema !== 'geneway.a2a.node-group-observation/1' || !Array.isArray(previous.pending) || (previous.pending.length + (previous.resolving?.length ?? 0)) > 8) throw error('INVALID_STATE', '本地群收件元数据无效')
          for (const row of previous.pending) { const value = validate(row); offered.set(value.deliveryId, value) }
          for (const row of previous.resolving ?? []) { const value = validate(row); resolving.set(value.deliveryId, value) }
        }
        loaded = true
      }
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]), retryResolve = [...resolving.values()]
      let remaining = 8
      for (const row of [...offered.values()]) {
        if (signal.aborted || remaining-- <= 0) break
        try { await acknowledge(row, signal) } catch (cause) { if (!closed && !signal.aborted) onError(cause) }
      }
      for (const row of retryResolve) {
        if (signal.aborted || remaining-- <= 0) break
        if (resolving.has(row.deliveryId)) await resolve(row, signal)
      }
      if (!signal.aborted && remaining > 0 && offered.size + resolving.size < 8) {
        const known = (await executions()).filter(row => row.runtimeStarted && row.session_id && ['accepted', 'running'].includes(row.status))
        if (known.length) {
          const execution = known[cursor++ % known.length], page = await client.group.receive(execution, { signal })
          for (const delivery of page.deliveries.slice(0, Math.min(remaining, 8 - offered.size - resolving.size))) {
            if (signal.aborted) break
            if (offered.has(delivery.deliveryId) || resolving.has(delivery.deliveryId)) continue
            const row = { binding: binding(execution), groupId: page.groupId, contextId: page.contextId, ...delivery, offeredAt: new Date().toISOString(), ackOperationId: randomUUID(), dataState: 'unresolved' }
            offered.set(row.deliveryId, row)
            // Acknowledgement is only a locator receipt. Persist it before any
            // ACK, then resolve content independently under current authority.
            try { await acknowledge(row, signal) } catch (cause) { if (!closed && !signal.aborted) onError(cause) }
          }
        }
      }
    })().catch(cause => { if (!closed && !abort.signal.aborted) onError(cause) }).finally(() => { active = undefined })
  }
  return { run, close() { closed = true; abort.abort(); client.group.close(); return active ?? Promise.resolve() } }
}
