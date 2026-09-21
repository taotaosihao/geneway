import { createHash, createHmac, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolveCredentialFile } from './execution-grant.mjs'

const WORK_ORDER_ID = 'WO-26-00096'
const CREATE_PATH = '/api/method/gearjob.api.work_order_p6.create_work_order_comment'
const READBACK_PATH = '/api/method/gearjob.api.work_order_p6.read_work_order_comment'
const WRITE_AUDIENCE = 'gearjob-work-order-comment-writer'
const WRITE_STEP = 'create_work_order_comment'
const READBACK_AUDIENCE = 'gearjob-work-order-comment-reader'
const READBACK_STEP = 'read_work_order_comment'
const PROFILE_VERSION = 'gearjob-work-order-status-dev/1'
const FIELD_MASK_VERSION = 'gearjob-work-order-status-nine-fields/1'

export function createGearJobCommentAdapter({ fetchImpl = fetch, clock = () => new Date(), timeoutMs = 15_000, idFactory = randomUUID } = {}) {
  return {
    async dispatch({ action, connection, secretRoot, deadlineAt, signal, claimAttempt, markNoEffect, authorizeReadback }) {
      const material = await prepareMaterial({ action, connection, secretRoot, deadlineAt, signal, timeoutMs, clock, idFactory })
      const claimed = await claimAttempt()
      if (!claimed?.claimed) return { kind: 'not-claimed', action: claimed?.action }
      if (reached(deadlineAt, clock())) return { kind: 'no-effect', reason: 'DISPATCH_DEADLINE_EXPIRED', action: await markNoEffect('DISPATCH_DEADLINE_EXPIRED') }
      const postPromise = fetchImpl(material.create.url, material.create.init)
      let response
      try {
        response = await postPromise
      } catch (error) {
        return { kind: 'unknown', reason: fetchFailure(error, material.timeoutSignal, signal) }
      }
      if (!response || !Number.isSafeInteger(response.status)) return { kind: 'unknown', reason: 'UPSTREAM_RESULT_UNKNOWN' }
      if (response.status === 409 || response.status === 400 || response.status === 401 || response.status === 404) {
        const body = await safeJson(response)
        if (body?.code === 'SOURCE_REVISION_CONFLICT' || body?.code === 'P6_SCOPE_UNAVAILABLE' || body?.code === 'CONNECTOR_AUTH_FAILED'
          || body?.code === 'INVALID_REQUEST' || body?.code === 'INVALID_COMMENT_ACTION') return { kind: 'no-effect', reason: body.code }
        return { kind: 'unknown', reason: body?.code === 'ACTION_ID_CONFLICT' ? 'ACTION_ID_CONFLICT' : 'UPSTREAM_RESULT_UNKNOWN' }
      }
      if (response.status >= 500) return { kind: 'unknown', reason: response.status === 503 ? 'UPSTREAM_RESULT_UNKNOWN' : 'UPSTREAM_5XX' }
      if (![200, 201].includes(response.status)) return { kind: 'unknown', reason: 'UPSTREAM_RESULT_UNKNOWN' }
      const createBody = await safeJson(response)
      if (!validCreateResponse(createBody, response.status, action)) return { kind: 'unknown', reason: 'INVALID_SUCCESS_RESPONSE' }
      return readback(material.readback, action, fetchImpl, authorizeReadback, { notFound: 'READBACK_NOT_FOUND', signal, timeoutSignal: material.timeoutSignal })
    },

    async reconcile({ action, connection, secretRoot, signal, authorizeReadback }) {
      const material = await prepare({ action, connection, secretRoot, signal, timeoutMs, clock, idFactory })
      return readback(material.readback, action, fetchImpl, authorizeReadback, { notFound: 'READBACK_NOT_FOUND', signal, timeoutSignal: material.timeoutSignal })
    },
  }
}

async function prepareMaterial(options) {
  const prepared = await prepare(options)
  const content = actionContent(options.action)
  const parameters = { actionId: options.action.id, content, expectedRevision: options.action.preview.expectedRevision, workOrderRef: WORK_ORDER_ID }
  const token = connectorToken({ operation: 'create_work_order_comment', parameters, actionId: options.action.id, audience: WRITE_AUDIENCE, step: WRITE_STEP, secret: prepared.credential.invocationSecret, deadlineAt: options.deadlineAt, clock: options.clock, idFactory: options.idFactory })
  return {
    ...prepared,
    create: request(prepared.connection, CREATE_PATH, 'POST', {
      headers: authHeaders(prepared.credential, token, true),
      body: JSON.stringify({ work_order_ref: WORK_ORDER_ID, action_id: options.action.id, expected_revision: options.action.preview.expectedRevision, content }),
      signal: prepared.requestSignal,
    }),
  }
}

async function prepare({ action, connection, secretRoot, signal, timeoutMs, clock, idFactory }) {
  assertAction(action)
  assertConnection(connection)
  const authorizationSnapshot = gearJobReadbackConnectionSnapshot(connection)
  const credential = await readCredential(await resolveCredentialFile(secretRoot, connection.credentialRef))
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const parameters = { actionId: action.id, workOrderRef: WORK_ORDER_ID }
  const token = connectorToken({ operation: 'read_work_order_comment', parameters, actionId: action.id, audience: READBACK_AUDIENCE, step: READBACK_STEP, secret: credential.invocationSecret, deadlineAt: new Date(asDate(clock()).getTime() + timeoutMs).toISOString(), clock, idFactory })
  return {
    connection, credential, timeoutSignal, requestSignal, authorizationSnapshot,
    readback: { ...request(connection, READBACK_PATH, 'GET', {
      query: { work_order_ref: WORK_ORDER_ID, action_id: action.id },
      headers: authHeaders(credential, token), signal: requestSignal,
    }), authorizationSnapshot },
  }
}

async function readback(material, action, fetchImpl, authorizeReadback, context) {
  let response
  if (typeof authorizeReadback !== 'function') return { kind: 'unknown', reason: 'READBACK_AUTHORIZATION_FAILED' }
  try { await authorizeReadback(structuredClone(material.authorizationSnapshot)) } catch { return { kind: 'unknown', reason: 'READBACK_AUTHORIZATION_FAILED' } }
  try { response = await fetchImpl(material.url, material.init) } catch (error) {
    return { kind: 'unknown', reason: fetchFailure(error, context.timeoutSignal, context.signal) }
  }
  if (response?.status === 404) return { kind: 'unknown', reason: context.notFound }
  if (!Number.isSafeInteger(response?.status) || response.status < 200 || response.status >= 300) return { kind: 'unknown', reason: response?.status >= 500 ? 'READBACK_FAILED' : 'READBACK_MISMATCH' }
  const body = await safeJson(response)
  if (!validReadback(body, action)) return { kind: 'unknown', reason: 'READBACK_MISMATCH' }
  return { kind: 'receipt', upstreamRecordId: body.commentName }
}

async function readCredential(filePath) {
  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('mode')
    const value = JSON.parse(await handle.readFile('utf8'))
    if (!plain(value) || Object.keys(value).some(key => !['apiKey', 'apiSecret', 'invocationSecret'].includes(key))) throw new Error('shape')
    const apiKey = secret(value.apiKey), apiSecret = secret(value.apiSecret), invocationSecret = secret(value.invocationSecret)
    if (/[:\s]/.test(apiKey) || /[:\s]/.test(apiSecret) || Buffer.byteLength(invocationSecret) < 32) throw new Error('shape')
    return { apiKey, apiSecret, invocationSecret }
  } catch {
    throw adapterError('SOURCE_NOT_CONFIGURED', 'GearJob 写入凭据不可用')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function connectorToken({ operation, parameters, actionId, audience, step, secret, deadlineAt, clock, idFactory }) {
  const now = Math.floor(asDate(clock()).getTime() / 1000)
  const deadline = asDate(deadlineAt)
  const invocationId = idFactory()
  const claims = {
    schemaVersion: 'connector-invocation-token/1', iss: 'geneway-control-plane', aud: audience,
    tenantId: 'geneway-p6', principal: 'geneway-p6-action-service', taskId: actionId,
    workflowVersionId: 'gearjob-work-order-comment/1', workflowHash: sha256('gearjob-work-order-comment/1'),
    stepId: step, attemptId: `attempt-${actionId}`, effectId: actionId, connectorInvocationId: invocationId,
    connectorQuerySpecHash: sha256(canonicalJson({ operation, parameters, schemaVersion: 'gearjob-p6-request/1' })),
    connectorProfileVersion: PROFILE_VERSION, workOrderRefHash: sha256(WORK_ORDER_ID), fieldMaskVersion: FIELD_MASK_VERSION,
    resourceContextDigest: sha256(`gearjob:${WORK_ORDER_ID}:${actionId}`), deadline: deadline.toISOString(), fence: 1,
    jti: idFactory(), iat: now, exp: Math.max(now + 1, Math.floor(deadline.getTime() / 1000)),
  }
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`
}

function request(connection, path, method, { query, headers, body, signal }) {
  const url = new URL(connection.baseUrl)
  url.pathname = path
  url.search = query ? new URLSearchParams(query).toString() : ''
  url.hash = ''
  return {
    url,
    init: {
      method, redirect: 'error', signal,
      headers: { accept: 'application/json', ...headers, ...(body ? { 'content-type': 'application/json' } : {}), ...(connection.hostHeader ? { host: connection.hostHeader } : {}) },
      ...(body ? { body } : {}),
    },
  }
}

function authHeaders(credential, token) {
  return { authorization: `token ${credential.apiKey}:${credential.apiSecret}`, 'x-geneway-connector-token': token }
}

function validCreateResponse(value, status, action) {
  return plain(value) && value.status === (status === 201 ? 'created' : 'replayed') && validReadback(value, action)
}

function validReadback(value, action) {
  const content = actionContent(action)
  return plain(value) && value.actionId === action.id && value.commentName === `geneway-p6-${action.id}`
    && value.workOrderRef === WORK_ORDER_ID && value.content === content && value.contentSha256 === sha256(content)
    && value.expectedRevision === action.preview.expectedRevision && value.published === false
}

async function safeJson(response) {
  try { const value = await response.json(); return plain(value) ? value : null } catch { return null }
}

function fetchFailure(error, timeoutSignal, signal) {
  if (signal?.aborted) return 'UPSTREAM_RESULT_UNKNOWN'
  if (timeoutSignal?.aborted || error?.name === 'TimeoutError') return 'UPSTREAM_TIMEOUT'
  return 'UPSTREAM_DISCONNECTED'
}

function assertAction(action) {
  if (!plain(action) || !/^action-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(action.id)
    || action.intent?.kind !== 'gearjob.work-order.comment' || action.preview?.target?.workOrderId !== WORK_ORDER_ID) throw adapterError('INVALID_REQUEST', '动作身份无效')
  actionContent(action)
}

function assertConnection(connection) {
  if (!plain(connection) || connection.kind !== 'gearjob-rest' || !connection.allowedObjectIds?.includes(WORK_ORDER_ID)
    || connection.sourceEnvironment !== 'external-test' || connection.dataMode !== 'synthetic') throw adapterError('FORBIDDEN', 'GearJob 写入连接不在 P6 范围内')
  try { const url = new URL(connection.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error() } catch { throw adapterError('SOURCE_NOT_CONFIGURED', 'GearJob 写入地址无效') }
}

export function gearJobReadbackConnectionSnapshot(connection) {
  return {
    id: connection?.id, revision: connection?.revision, credentialRef: connection?.credentialRef,
    baseUrl: connection?.baseUrl, hostHeader: connection?.hostHeader ?? null,
    targetIdentity: connection?.targetIdentity, sourceInstance: connection?.sourceInstance,
    sourceEnvironment: connection?.sourceEnvironment, dataMode: connection?.dataMode,
    kind: connection?.kind, status: connection?.status,
    allowedObjectIds: Array.isArray(connection?.allowedObjectIds) ? [...connection.allowedObjectIds] : null,
  }
}

function actionContent(action) {
  if (typeof action?.preview?.payload?.body !== 'string') throw adapterError('INVALID_REQUEST', '动作正文无效')
  return action.preview.payload.body
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${asciiJson(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return asciiJson(value)
}
function asciiJson(value) { return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function reached(deadline, now) { return asDate(now).getTime() >= asDate(deadline).getTime() }
function asDate(value) { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw adapterError('INVALID_REQUEST', '时间无效'); return date }
function plain(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function secret(value) { if (typeof value !== 'string' || !value.trim()) throw new Error('secret'); return value.trim() }
function adapterError(code, message) { return Object.assign(new Error(message), { code }) }
