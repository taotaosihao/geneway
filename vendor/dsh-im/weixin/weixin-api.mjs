// Adapted from @xmanrui/dsh-im 4.39.0; see SOURCES.md and LICENSE.
import { randomBytes } from 'node:crypto'

export const WEIXIN_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/'
export const WEIXIN_PROTOCOL_VERSION = '2.4.6'
export const DEFAULT_WEIXIN_MAX_MESSAGE_CHARS = 1800
const LOGIN_STATUSES = new Set(['wait', 'scaned', 'confirmed', 'expired', 'scaned_but_redirect', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'])

export class WeixinApiError extends Error {
  constructor(code, message, { status, providerCode } = {}) {
    super(message)
    this.name = 'WeixinApiError'
    this.code = code
    if (status !== undefined) this.status = status
    if (providerCode !== undefined) this.providerCode = providerCode
  }
}

export function normalizeWeixinApiBaseUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new WeixinApiError('invalid-base-url', '微信连接地址无效') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || !['weixin.qq.com', 'wechat.com'].some(domain => host === domain || host.endsWith(`.${domain}`))
    || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash) throw new WeixinApiError('untrusted-base-url', '微信连接地址不受信任')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

export function rejectedProviderResponse(value, fields = ['ret', 'errcode']) {
  let rejection = null
  for (const field of fields) {
    const code = value?.[field]
    if (code === undefined) continue
    if (!['number', 'string'].includes(typeof code) || (typeof code === 'number' && !Number.isSafeInteger(code)) || !/^-?\d{1,10}$/.test(String(code))) throw new WeixinApiError('invalid-response', '微信协议状态码无效')
    if (BigInt(code) !== 0n && rejection === null) rejection = BigInt(code).toString()
  }
  return rejection
}

export function createWeixinApi({ testMode = false, testBaseUrl, timeoutMs = 15000, longPollTimeoutMs = 35000 } = {}) {
  for (const value of [timeoutMs, longPollTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Weixin timeout must be a positive integer')
  let testUrl
  if (testBaseUrl !== undefined) {
    try { testUrl = new URL(testBaseUrl) } catch { throw new WeixinApiError('untrusted-base-url', '微信测试地址无效') }
    if (testMode !== true || testUrl.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(testUrl.hostname)
      || testUrl.username || testUrl.password || testUrl.pathname !== '/' || testUrl.search || testUrl.hash) throw new WeixinApiError('untrusted-base-url', '微信测试地址只允许本机测试配置')
  }
  const qrBaseUrl = testUrl?.href ?? WEIXIN_QR_BASE_URL
  function normalizeBaseUrl(value) {
    if (!testUrl) return normalizeWeixinApiBaseUrl(value)
    let url
    try { url = new URL(value) } catch { throw new WeixinApiError('invalid-base-url', '微信连接地址无效') }
    if (url.origin !== testUrl.origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new WeixinApiError('untrusted-base-url', '微信测试响应越过本机测试地址')
    return url.href
  }
  function serverBase(value, fallback) {
    return normalizeBaseUrl(value ? (/^https?:\/\//.test(value) ? value : `https://${value}/`) : fallback)
  }
  async function request({ method = 'POST', baseUrl, endpoint, body, token, signal, authenticated = true, longPoll = false }) {
    const url = new URL(endpoint, normalizeBaseUrl(baseUrl))
    const controller = new AbortController()
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const timer = setTimeout(() => controller.abort(), longPoll ? longPollTimeoutMs : timeoutMs)
    try {
      signal?.throwIfAborted()
      const response = await fetch(url, {
        method, redirect: 'error', signal: requestSignal,
        headers: {
          'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
          ...(authenticated ? {
            'content-type': 'application/json', AuthorizationType: 'ilink_bot_token',
            'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new WeixinApiError('http-error', '微信协议请求失败', { status: response.status }) }
      let value
      try { value = await response.json() } catch { throw new WeixinApiError('invalid-response', '微信协议响应无法解析') }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WeixinApiError('invalid-response', '微信协议响应格式无效')
      return value
    } catch (error) {
      if (signal?.aborted) throw new WeixinApiError('aborted', '微信协议请求已停止')
      if (controller.signal.aborted) throw new WeixinApiError('timeout', '微信协议请求超时')
      if (error instanceof WeixinApiError) throw error
      throw new WeixinApiError('network-error', '暂时无法连接微信服务')
    } finally { clearTimeout(timer) }
  }
  const baseInfo = () => ({ channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' })
  return Object.freeze({
    normalizeBaseUrl,
    async beginLogin({ signal } = {}) {
      const value = await request({ baseUrl: qrBaseUrl, endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3', body: { local_token_list: [] }, signal })
      const providerCode = rejectedProviderResponse(value)
      if (providerCode) throw new WeixinApiError('qr-request-rejected', '微信服务拒绝二维码申请', { providerCode })
      if (!nonEmptyString(value.qrcode)) throw new WeixinApiError('invalid-qr', '微信二维码令牌缺失')
      let qr
      try { qr = new URL(value.qrcode_img_content) } catch { throw new WeixinApiError('invalid-qr', '微信扫码地址无效') }
      const trusted = new URL(qr.href); trusted.search = ''; trusted.hash = ''
      normalizeBaseUrl(testUrl ? trusted.origin + '/' : trusted.href)
      if (qr.username || qr.password) throw new WeixinApiError('invalid-qr', '微信扫码地址无效')
      return { qrcode: value.qrcode, qrcodeUrl: qr.href }
    },
    async pollLogin({ qrcode, baseUrl = qrBaseUrl, verifyCode, signal, onConfirmed } = {}) {
      if (!nonEmptyString(qrcode)) throw new TypeError('qrcode is required')
      const query = new URLSearchParams({ qrcode })
      if (nonEmptyString(verifyCode)) query.set('verify_code', verifyCode.trim())
      const value = await request({ method: 'GET', baseUrl, endpoint: `ilink/bot/get_qrcode_status?${query}`, signal, authenticated: false, longPoll: true })
      const providerCode = rejectedProviderResponse(value)
      if (providerCode) throw new WeixinApiError('login-rejected', '微信扫码请求被拒绝', { providerCode })
      if (!LOGIN_STATUSES.has(value.status)) throw new WeixinApiError('invalid-login-status', '微信扫码状态无法识别')
      if (value.status === 'scaned_but_redirect') return { status: value.status, baseUrl: serverBase(value.redirect_host, baseUrl) }
      if (value.status !== 'confirmed') return { status: value.status }
      const token = nonEmptyString(value.bot_token)
      if (!token || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token) || !officialId(value.ilink_bot_id) || !officialId(value.ilink_user_id)) throw new WeixinApiError('incomplete-login', '微信账号凭据不完整')
      const result = { status: value.status, botId: value.ilink_bot_id, ownerUserId: value.ilink_user_id, baseUrl: serverBase(value.baseurl, baseUrl) }
      if (typeof onConfirmed !== 'function') throw new TypeError('onConfirmed secret sink is required')
      if (signal?.aborted) throw new WeixinApiError('aborted', '微信扫码已停止')
      try { await onConfirmed({ ...result, token }) } catch { throw new WeixinApiError('credential-save-failed', '微信凭据保存失败') }
      if (signal?.aborted) throw new WeixinApiError('aborted', '微信扫码已停止')
      return result
    },
    async getUpdates({ baseUrl, token, getUpdatesBuf = '', signal }) {
      try {
        return await request({ baseUrl, endpoint: 'ilink/bot/getupdates', token, signal, longPoll: true, body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() } })
      } catch (error) {
        if (error.code === 'timeout') return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
        throw error
      }
    },
    async sendText({ baseUrl, token, toUserId, text, contextToken, clientId, signal }) {
      if (!officialId(toUserId) || !nonEmptyString(text) || !officialId(clientId)) throw new TypeError('Weixin send envelope is invalid')
      const value = await request({ baseUrl, endpoint: 'ilink/bot/sendmessage', token, signal, body: {
        msg: { from_user_id: '', to_user_id: toUserId, client_id: clientId, message_type: 2, message_state: 2,
          item_list: [{ type: 1, text_item: { text } }], ...(contextToken ? { context_token: contextToken } : {}) }, base_info: baseInfo(),
      } })
      const providerCode = rejectedProviderResponse(value)
      if (providerCode) throw new WeixinApiError('send-rejected', '微信拒绝发送消息', { providerCode })
      if (![value.ret, value.errcode].some(code => code === 0 || code === '0')) throw new WeixinApiError('delivery-unknown', '微信发送结果待核对')
      return { providerMessageId: clientId }
    },
  })
}

export function orderWeixinMessages(messages) {
  const field = ['seq', 'create_time_ms'].find(key => messages.every(message => key === 'seq' ? weixinSequence(message?.seq) !== undefined : (
    (typeof message?.[key] === 'number' && Number.isFinite(message[key]))
    || (typeof message?.[key] === 'string' && message[key].trim() && Number.isFinite(Number(message[key])))
  )))
  return field ? messages.map((message, index) => ({ message, index, order: field === 'seq' ? BigInt(weixinSequence(message.seq)) : Number(message[field]) }))
    .sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.index - b.index).map(({ message }) => message) : messages
}

export function weixinSequence(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString()
  return undefined
}

export function weixinMessageId(message) {
  if (typeof message?.message_id === 'string' && officialId(message.message_id)) return message.message_id
  if (typeof message?.message_id === 'number' && Number.isSafeInteger(message.message_id)) return String(message.message_id)
  return officialId(message?.client_id) ? message.client_id : undefined
}

export function splitWeixinText(text, maxChars = DEFAULT_WEIXIN_MAX_MESSAGE_CHARS) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw new TypeError('Weixin segment size is invalid')
  const chunks = []
  let remaining = text
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars)
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars
    if (/[\uD800-\uDBFF]/u.test(remaining[splitAt - 1]) && /[\uDC00-\uDFFF]/u.test(remaining[splitAt])) splitAt -= 1
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n+/, '')
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export function officialId(value) { return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value) }
function nonEmptyString(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
