import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

export async function createILinkSimulator({ holdMs = 100 } = {}) {
  const accounts = new Map(), byToken = new Map(), loginReplies = [], qrReplies = [], calls = [], failures = []
  let url, qrCount = 0, closed = false
  const server = createServer(async (request, response) => {
    try {
      const endpoint = new URL(request.url, url).pathname
      assert.equal(request.headers['ilink-app-id'], 'bot')
      assert.equal(request.headers['ilink-app-clientversion'], '132102')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '')
      const account = byToken.get(token)
      const call = { endpoint, method: request.method, botId: account?.id }
      calls.push(call)
      if (endpoint === '/ilink/bot/get_bot_qrcode') {
        assert.equal(request.method, 'POST')
        assert.equal(new URL(request.url, url).searchParams.get('bot_type'), '3')
        assert.deepEqual(body, { local_token_list: [] })
        if (qrReplies.length) return json(response, qrReplies.shift())
        const qrcode = `test-qr-${++qrCount}`
        return json(response, { ret: 0, qrcode, qrcode_img_content: `${url}scan/${qrcode}` })
      }
      if (endpoint === '/ilink/bot/get_qrcode_status') {
        assert.equal(request.method, 'GET')
        assert.equal(request.headers.authorization, undefined)
        call.hasQr = Boolean(new URL(request.url, url).searchParams.get('qrcode'))
        const reply = loginReplies.shift() ?? { status: 'wait' }
        if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs))
        if (!response.destroyed) return json(response, reply.value ?? reply)
        return
      }
      if (!account) return json(response, { ret: -14 }, 401)
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.authorizationtype, 'ilink_bot_token')
      assert.match(Buffer.from(request.headers['x-wechat-uin'], 'base64').toString(), /^\d+$/)
      assert.equal(body?.base_info?.channel_version, '2.4.6')
      if (endpoint === '/ilink/bot/getupdates') {
        assert.equal(typeof body.get_updates_buf, 'string')
        call.startedAt = Date.now()
        call.cursorDigest = digest(body.get_updates_buf)
        account.activePolls += 1
        account.maxActivePolls = Math.max(account.maxActivePolls, account.activePolls)
        const finish = () => {
          account.activePolls -= 1
          call.endedAt = Date.now()
          call.heldMs = call.endedAt - call.startedAt
          call.completed = response.writableEnded
          call.aborted = !call.completed
        }
        response.once('close', finish)
        if (account.pollReplies.length) return reply(response, account.pollReplies.shift())
        const index = body.get_updates_buf === '' ? 0 : account.batches.findIndex(batch => batch.cursor === body.get_updates_buf) + 1
        if (body.get_updates_buf && index === 0) return json(response, { ret: 400 })
        const send = () => {
          if (response.destroyed || response.writableEnded) return true
          const batch = account.batches[index]
          if (!batch) return false
          json(response, { ret: 0, msgs: batch.messages, get_updates_buf: batch.cursor })
          return true
        }
        if (send()) return
        const timer = setTimeout(() => { if (!response.destroyed) json(response, { ret: 0, msgs: [], get_updates_buf: body.get_updates_buf }) }, holdMs)
        const wake = () => { if (send()) { clearTimeout(timer); account.waiters.delete(wake) } }
        account.waiters.add(wake)
        response.once('close', () => { clearTimeout(timer); account.waiters.delete(wake) })
        return
      }
      if (endpoint === '/ilink/bot/sendmessage') {
        assert.equal(body.msg?.message_type, 2)
        assert.equal(body.msg?.message_state, 2)
        assert.equal(body.msg?.item_list?.length, 1)
        assert.equal(body.msg?.item_list[0]?.type, 1)
        Object.assign(call, { clientId: body.msg.client_id, toUserId: body.msg.to_user_id, text: body.msg.item_list[0].text_item.text, contextDigest: digest(body.msg.context_token ?? '') })
        return reply(response, account.sendReplies.shift() ?? { ret: 0 })
      }
      json(response, { ret: 404 }, 404)
    } catch (error) {
      failures.push(error.code ?? error.name)
      if (!response.headersSent && !response.destroyed) json(response, { ret: 500 }, 500)
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  url = `http://127.0.0.1:${server.address().port}/`
  return {
    url, calls, failures,
    addAccount({ id, ownerUserId, token }) {
      assert(!accounts.has(id) && !byToken.has(token))
      const account = { id, ownerUserId, token, batches: [], pollReplies: [], sendReplies: [], waiters: new Set(), activePolls: 0, maxActivePolls: 0 }
      accounts.set(id, account); byToken.set(token, account)
      return { id, ownerUserId }
    },
    queueLogin(...responses) { loginReplies.push(...responses) },
    queueQr(...responses) { qrReplies.push(...responses) },
    confirmedLogin(id) {
      const account = accounts.get(id)
      return { status: 'confirmed', bot_token: account.token, ilink_bot_id: id, ilink_user_id: account.ownerUserId, baseurl: url }
    },
    push(id, messages) {
      const account = accounts.get(id)
      const cursor = `test-secret-cursor-${id}-${account.batches.length + 1}`
      account.batches.push({ cursor, messages })
      for (const wake of [...account.waiters]) wake()
      return cursor
    },
    queuePoll(id, ...responses) { accounts.get(id).pollReplies.push(...responses) },
    queueSend(id, ...responses) { accounts.get(id).sendReplies.push(...responses) },
    activePolls(id) { return accounts.get(id).activePolls },
    maxActivePolls(id) { return accounts.get(id).maxActivePolls },
    async close() {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

function json(response, value, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
function reply(response, value) {
  if (value.drop) return response.destroy()
  if (value.invalidJson) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{'); return }
  if (value.redirect) { response.writeHead(307, { location: value.redirect }); response.end(); return }
  return json(response, value.body ?? value, value.httpStatus ?? 200)
}
function digest(value) { return createHash('sha256').update(value).digest('hex') }
