// Ported from dsh-superagent-prototype@6337fc8 src/app/delivery.ts (MIT).
// The producer uses Geneway stable IDs; accepted means the persistence barrier succeeded.
import { key } from '../agent-contracts/index.mjs'
export const messageId = (inputId, attemptId, sessionId) => `geneway:${key(inputId, attemptId, sessionId)}`
const deliveryId = message => ['geneway-multisite', 'geneway-agent-message', 'geneway-intent-review'].includes(message?.source?.kind) ? message.id : undefined

export class AgentDelivery {
  #seen = new WeakMap()
  constructor(ctx, freezeMessage = value => Object.freeze(value)) {
    this.ctx = ctx; this.freezeMessage = freezeMessage
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const id = deliveryId(event.data)
      if (id) this.#seen.get(session)?.ids.add(id)
    })
  }
  async history(agent) {
    let seen = this.#seen.get(agent.session)
    if (!seen) { seen = { ids: new Set() }; this.#seen.set(agent.session, seen) }
    const state = seen
    state.loaded ??= (async () => {
      await this.ctx.sessionPersistence.flush()
      const handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      try {
        for (let offset = 0; ;) {
          const { events } = await handle.read(offset, 512)
          if (!events.length) break
          for (const event of events) {
            if (event.type !== 'user/message') continue
            const id = deliveryId(event.data)
            if (id) state.ids.add(id)
          }
          offset += events.length
        }
      } finally { await handle.close() }
    })().catch(cause => { state.loaded = undefined; throw cause })
    await state.loaded
    return state
  }
  async inspect(agent, id) {
    const seen = await this.history(agent)
    // Snapshot history also covers events emitted before the listener was installed.
    for (const event of agent.session.snapshotEvents()) if (event.type === 'user/message') {
      const delivered = deliveryId(event.data); if (delivered) seen.ids.add(delivered)
    }
    return { ingested: seen.ids.has(id), pending: [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id) }
  }
  async inspectInputs(agent, ids) {
    const seen = await this.history(agent)
    const consumed = new Set(seen.ids)
    for (const event of agent.session.snapshotEvents()) if (event.type === 'user/message') {
      const id = deliveryId(event.data); if (id) consumed.add(id)
    }
    const pending = new Set([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(deliveryId))
    // Capture positive facts before the barrier; events arriving during flush belong to the next inspection.
    const facts = ids.map(id => Object.freeze({ id, delivered: consumed.has(id) || pending.has(id), ingested: consumed.has(id) }))
    await this.ctx.sessionPersistence.flush()
    return Object.freeze(facts)
  }
  async send(agent, id, text, authorize = async () => {}, contentFor = async () => [{ type: 'text', text }], sourceKind = 'geneway-multisite') {
    const held = await this.inspect(agent, id)
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    await authorize()
    if (!held.ingested && !held.pending) {
      const message = this.freezeMessage({ id, role: 'user', content: await contentFor(), source: { kind: sourceKind, form: 'relay' } })
      agent.followup(message)
    }
    const [status] = await this.inspectInputs(agent, [id])
    return { delivered: true, ingested: status.ingested }
  }
}
