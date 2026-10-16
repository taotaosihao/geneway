import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Client, extractWWWAuthenticateParams, InsufficientScopeError, OAuthError, OAuthErrorCode, PrivateKeyJwtProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { authorizeExecutionGrant, consumeExecutionGrant, resolveCredentialFile } from '../src/execution-grant.mjs'
import { KIVO_TPM_TOOLS, TPM_RECORD_TYPES, TPM_LIST_RECORD_TYPES, normalizeTpmInput, normalizeTpmObservation, tpmToolRequest, tpmSourcePath, tpmError } from '../src/domain/tpm.mjs'
import { CORRELATION_RECORD_TYPES, normalizeTpmCorrelationInput, normalizeTpmDeviceCorrelation } from '../src/domain/tpm-device-correlation.mjs'
import { repairPayload } from '../src/domain/kivo-repair.mjs'

export { KIVO_TPM_TOOLS }
export const name = 'geneway-kivo-tpm'
export const inject = ['tools']
export const KIVO_MCP_PROTOCOL = '2026-07-28'
export const KIVO_MCP_SCOPE = 'tpm.repair.read tpm.maintenance.read tpm.inspection.read tpm.plan.read devices.device.read'

// Official SDK 2.3.1 wire schemas. Discovery includes writes; registration below does not.
export const KIVO_TPM_SCHEMA_FINGERPRINTS = Object.freeze({
  'devices.device.get': '0fdb154d0c96c65a7bc2d6e2e5bad5e4f5780571e9a6df97603118ed3775b995',
  'mes.monitor.current': '2bfbf436b9d23a0a0eb7adadba905391b8cb7339b1f0046755c0bdf12919c6fe',
  'tpm.exception.get': 'b2629c24a10eac579cf776971c4629a58524ba615ef7db2b529fcc6b0a51687d',
  'tpm.exception.list': '4ed40c22d201a1f2db1b6211b4239987932aa8deab1b09594c72b4968ff88d92',
  'tpm.inspection.get': '3c288f338363d728f2e32d128f947325f222766f97d1169fa71d3d651a3bb193',
  'tpm.inspection.list': '11be66a810f16b6c7858b9c8236f86b3edc49a806cc27987b146c6573dd2c085',
  'tpm.maintenance.get': '3794517340b7a7b8ae7b4a39b1504014bff3e1d8d131eed9ed132a1fffb8bd54',
  'tpm.maintenance.list': 'cbf4222d4d5f1db691e1cb7ebe6c1599b4f5af16ef177e63d8b746cde155ada8',
  'tpm.plan.get': 'b22f6344bf9936f4ba65b529de19fb400559aa01a6f8576c15016603badf19f2',
  'tpm.plan.list': '59dd18b8cf31ba3cf8170cb95dfa27186dd54e4f967228073fab6a7b0a0094fb',
  'tpm.repair.create': '2d439dd6775e0725289d8f015ecfaac2ec9ff7f1e481f5bcc9914fcf2646750f',
  'tpm.repair.get': 'f3359b701b4242c4d3fa959cedaeb390af4132f039867017eb33a52e62802ff1',
  'tpm.repair.list': 'c02376fa396966004ab186e616236f146854007ee629f45315e940b36a306c18',
})

const MESSAGES = Object.freeze({
  INVALID_REQUEST: 'TPM 查询参数无效', SOURCE_NOT_CONFIGURED: 'Kivo 连接或服务端凭据不可用',
  FORBIDDEN: '当前授权不允许此 Kivo 查询', NOT_FOUND: '当前 Kivo 读取范围内没有该记录',
  CANCELLED: '本次执行已停止', UPSTREAM_TIMEOUT: 'Kivo 查询超时',
  UPSTREAM_ERROR: 'Kivo 查询失败', INVALID_SOURCE: 'Kivo 工具目录或结构化结果不符合固定契约',
  ACTION_CONFLICT: '维修单号与现有记录冲突', DISPATCH_DEADLINE_EXPIRED: '批准的首次写入时限已过',
})

export function apply(ctx) {
  const lifetime = new AbortController()
  for (const tool of createKivoTpmTools({ signal: lifetime.signal })) ctx.tools.register(tool)
  return () => lifetime.abort(tpmError('CANCELLED', MESSAGES.CANCELLED))
}

export function createKivoTpmTools({ authorize = defaultAuthorize, signal, fetchImpl = fetch } = {}) {
  return ['record', 'list', 'correlation'].map(mode => defineTool({
    name: mode === 'correlation' ? KIVO_TPM_TOOLS.correlateDevice : mode === 'record' ? KIVO_TPM_TOOLS.readRecord : KIVO_TPM_TOOLS.listRecords,
    description: mode === 'record'
      ? '读取明确的 Kivo TPM 记录；维修、保养、点检单同时读取同实例关联设备。只读，不接收 URL、凭据或远端工具名。'
      : mode === 'list' ? '按固定过滤条件分页读取 Kivo 当前机器账号组织范围内的 TPM 记录和保养计划。只读，不接收任意路径或查询。'
        : '读取明确的 TPM 单据、同设备台账及当前监控，返回程序关联事实、采样时间与未知项。只读，不创建维修单。',
    parameters: mode !== 'list' ? {
      recordType: { type: 'string', enum: mode === 'correlation' ? CORRELATION_RECORD_TYPES : TPM_RECORD_TYPES, required: true },
      reference: { type: 'string', required: true },
    } : {
      recordType: { type: 'string', enum: TPM_LIST_RECORD_TYPES, required: true },
      filters: { type: 'object', additionalProperties: false, required: true, properties: {
        page: { type: 'integer' }, pageSize: { type: 'integer' }, keyword: { type: 'string' },
        deviceId: { type: 'string' }, archive: { type: 'string' }, status: { type: 'string' }, tab: { type: 'string' }, severity: { type: 'string' },
      } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true },
        observation: { type: 'object', additionalProperties: true },
        error: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
      } },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    async execute(args, invocation = {}) {
      const requestSignal = combineSignals(signal, invocation.signal)
      try {
        const parsed = mode === 'correlation' ? normalizeTpmCorrelationInput(args) : normalizeTpmInput(mode, args)
        if (!parsed.ok) throw tpmError('INVALID_REQUEST', MESSAGES.INVALID_REQUEST)
        const toolName = mode === 'correlation' ? KIVO_TPM_TOOLS.correlateDevice : mode === 'record' ? KIVO_TPM_TOOLS.readRecord : KIVO_TPM_TOOLS.listRecords
        const input = parsed.input
        const grant = await authorize({ toolName, input, invocation })
        const options = {
          input, connection: grant.connection, secretRoot: grant.secretRoot, signal: requestSignal,
          traceId: grant.executionId, fetchImpl,
          authorize: () => authorize({ toolName, input, invocation, grant }),
        }
        return { ok: true, observation: await (mode === 'correlation' ? correlateKivoTpmDevice(options) : mode === 'record' ? readKivoTpmRecord(options) : listKivoTpmRecords(options)) }
      } catch (error) {
        const failure = safeError(error, requestSignal)
        return { ok: false, error: { code: failure.code, message: failure.message } }
      }
    },
  }))
}

async function defaultAuthorize({ toolName, input, grant }) {
  const value = grant ?? await consumeExecutionGrant({ toolName, input })
  await authorizeExecutionGrant(value)
  return value
}

export function readKivoTpmRecord(options) { return readRecords('record', options) }
export function listKivoTpmRecords(options) { return readRecords('list', options) }

export async function correlateKivoTpmDevice(options = {}) {
  const parsed = normalizeTpmCorrelationInput(options.input)
  if (!parsed.ok) throw tpmError('INVALID_REQUEST', MESSAGES.INVALID_REQUEST)
  return withKivoClient(options, async ({ client, tools, signal, connection, traceId }) => {
    const result = await readTool(client, tools, tpmToolRequest('record', parsed.input), signal, traceId)
    if (result.status !== 'ok') throw tpmError('FORBIDDEN', MESSAGES.FORBIDDEN)
    const deviceResult = await readTool(client, tools, tpmToolRequest('record', { recordType: 'device', reference: result.value.deviceId }), signal, traceId)
    if (deviceResult.status !== 'ok' || deviceResult.value.id !== result.value.deviceId) throw tpmError('INVALID_SOURCE', MESSAGES.INVALID_SOURCE)
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(deviceResult.value.code)
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceResult.value.code)) throw tpmError('INVALID_SOURCE', MESSAGES.INVALID_SOURCE)
    const monitorResult = await readTool(client, tools, { name: 'mes.monitor.current', arguments: { deviceId: deviceResult.value.id, deviceCode: deviceResult.value.code } }, signal, traceId)
    await options.authorize()
    throwIfAborted(signal)
    return normalizeTpmDeviceCorrelation({ input: parsed.input, result, deviceResult, monitorResult, connection })
  }, 'correlation')
}

// These are executor functions, deliberately absent from createKivoTpmTools.
export async function createKivoRepair(options) {
  repairPayload(options.input)
  if (typeof options.beforeWrite !== 'function' || !Number.isFinite(Date.parse(options.deadlineAt))) throw tpmError('INVALID_REQUEST', MESSAGES.INVALID_REQUEST)
  return withKivoClient(options, ({ client, tools, signal, traceId }) => readTool(client, tools, { name: 'tpm.repair.create', arguments: options.input }, signal, traceId), 'repair-create')
}

export async function readKivoRepair(options) {
  return withKivoClient(options, ({ client, tools, signal, traceId }) => readTool(client, tools, { name: 'tpm.repair.get', arguments: { orderNo: options.orderNo } }, signal, traceId), 'repair-readback')
}

async function readRecords(mode, options = {}) {
  const parsed = normalizeTpmInput(mode, options.input)
  if (!parsed.ok) throw tpmError('INVALID_REQUEST', MESSAGES.INVALID_REQUEST)
  const input = parsed.input
  return withKivoClient(options, async ({ client, tools, signal, connection, traceId }) => {
    const request = tpmToolRequest(mode, input)
    const result = await readTool(client, tools, request, signal, traceId)
    let deviceResult
    if (mode === 'record' && ['repair', 'maintenance', 'inspection'].includes(input.recordType) && result.status === 'ok') {
      const deviceId = result.value?.deviceId
      const deviceRequest = tpmToolRequest('record', { recordType: 'device', reference: deviceId })
      deviceResult = await readTool(client, tools, deviceRequest, signal, traceId)
    }
    await options.authorize()
    throwIfAborted(signal)
    return normalizeTpmObservation({ mode, input, result, deviceResult, connection })
  })
}

export async function testKivoTpmConnection(options) {
  return withKivoClient(options, async ({ tools }) => ({ protocolVersion: KIVO_MCP_PROTOCOL, toolNames: [...tools.keys()].sort() }))
}

export function assertKivoTpmTools(tools) {
  const expected = Object.keys(KIVO_TPM_SCHEMA_FINGERPRINTS)
  if (!Array.isArray(tools) || tools.length !== expected.length) throw tpmError('INVALID_SOURCE', MESSAGES.INVALID_SOURCE)
  const result = new Map()
  for (const tool of tools) {
    if (!tool || !Object.hasOwn(KIVO_TPM_SCHEMA_FINGERPRINTS, tool.name) || result.has(tool.name)
      || schemaFingerprint(tool) !== KIVO_TPM_SCHEMA_FINGERPRINTS[tool.name]) throw tpmError('INVALID_SOURCE', MESSAGES.INVALID_SOURCE)
    result.set(tool.name, structuredClone(tool))
  }
  return result
}

export function schemaFingerprint(tool) {
  return createHash('sha256').update(JSON.stringify(canonical({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }))).digest('hex')
}

async function withKivoClient(options = {}, run, purpose = 'read') {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = combineSignals(options.signal, timeout)
  let client, authorizationFailure
  try {
    if (typeof options.authorize !== 'function') throw tpmError('FORBIDDEN', MESSAGES.FORBIDDEN)
    await options.authorize()
    throwIfAborted(signal)
    const connection = validateConnection(options.connection)
    const traceId = typeof options.traceId === 'string' && /^[\x21-\x7e]{1,128}$/.test(options.traceId) ? options.traceId : randomUUID()
    const privateKey = await readPrivateKey(options.secretRoot, connection.credentialRef)
    const scope = purpose === 'correlation' ? `${KIVO_MCP_SCOPE} mes.monitor.read`
      : purpose === 'repair-create' ? 'tpm.repair.read devices.device.read tpm.repair.report'
        : purpose === 'repair-readback' ? 'tpm.repair.read devices.device.read' : KIVO_MCP_SCOPE
    const provider = new PrivateKeyJwtProvider({ clientId: connection.clientId, privateKey, algorithm: 'RS256', scope, expectedIssuer: connection.issuer })
    // SDK metadata scopes take precedence over clientMetadata.scope. The provider's
    // public token seam keeps a global discovery catalogue from widening this call.
    const prepareTokenRequest = provider.prepareTokenRequest.bind(provider)
    provider.prepareTokenRequest = () => prepareTokenRequest(scope)
    provider.validateResourceURL = async (serverUrl, resource) => {
      if (new URL(serverUrl).href !== connection.baseUrl || resource !== connection.baseUrl) throw tpmError('FORBIDDEN', MESSAGES.FORBIDDEN)
      return new URL(connection.baseUrl)
    }
    let writeStarted = false
    const guardedFetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const resource = new URL(connection.baseUrl)
      const isResource = url.href === resource.href && request.method === 'POST'
      const metadataPaths = ['/.well-known/oauth-authorization-server', `/.well-known/oauth-protected-resource${resource.pathname}`]
      const isMetadata = url.origin === connection.issuer && metadataPaths.includes(url.pathname) && !url.search && request.method === 'GET'
      const isToken = url.href === `${connection.issuer}/api/v1/oauth/token` && request.method === 'POST'
      if (!isResource && !isMetadata && !isToken) throw tpmError('FORBIDDEN', MESSAGES.FORBIDDEN)
      if (isToken) {
        const form = new URLSearchParams(await request.clone().text())
        const scopes = form.getAll('scope')
        if (form.getAll('resource').length !== 1 || form.get('resource') !== connection.baseUrl
          || form.get('grant_type') !== 'client_credentials' || scopes.length !== 1 || !scopes[0]
          || scopes[0].split(' ').some(item => !scope.split(' ').includes(item))) throw tpmError('FORBIDDEN', MESSAGES.FORBIDDEN)
      }
      await options.authorize()
      throwIfAborted(signal)
      if (isResource) {
        const rpc = await request.clone().json()
        if (rpc.method === 'tools/call') {
          const allowed = purpose === 'read' ? Object.keys(KIVO_TPM_SCHEMA_FINGERPRINTS).filter(item => item !== 'tpm.repair.create' && item !== 'mes.monitor.current')
            : purpose === 'correlation' ? [`tpm.${options.input.recordType}.get`, 'devices.device.get', 'mes.monitor.current']
              : [purpose === 'repair-create' ? 'tpm.repair.create' : 'tpm.repair.get']
          if (!allowed.includes(rpc.params?.name)) throw tpmError('FORBIDDEN', MESSAGES.FORBIDDEN)
          if (rpc.params.name === 'tpm.repair.create') {
            // Even an OAuth challenge must never transparently resend a business write.
            if (writeStarted || typeof options.beforeWrite !== 'function' || JSON.stringify(canonical(rpc.params.arguments)) !== JSON.stringify(canonical(options.input))) throw tpmError('FORBIDDEN', MESSAGES.FORBIDDEN)
            await options.beforeWrite()
            await options.authorize()
            throwIfAborted(signal)
            if (Date.parse((options.clock ?? (() => new Date().toISOString()))()) >= Date.parse(options.deadlineAt)) throw tpmError('DISPATCH_DEADLINE_EXPIRED', MESSAGES.DISPATCH_DEADLINE_EXPIRED)
            writeStarted = true
            options.onWriteStarted?.()
          }
        }
      }
      const headers = new Headers(request.headers)
      headers.set('x-trace-id', traceId)
      const response = await (options.fetchImpl ?? fetch)(new Request(request, { headers, redirect: 'error', signal: combineSignals(signal, request.signal) }))
      if (isResource && [401, 403].includes(response.status)) {
        const challenge = extractWWWAuthenticateParams(response)
        if (challenge.scope?.split(' ').some(item => !scope.split(' ').includes(item))) {
          authorizationFailure = tpmError('FORBIDDEN', MESSAGES.FORBIDDEN)
          throw authorizationFailure
        }
      }
      return response
    }
    client = new Client({ name: 'geneway-kivo-tpm', version: '1' }, {
      versionNegotiation: { mode: { pin: KIVO_MCP_PROTOCOL }, probe: { maxRetries: 0 } },
      enforceStrictCapabilities: true,
    })
    const transport = new StreamableHTTPClientTransport(new URL(connection.baseUrl), {
      authProvider: provider, fetch: guardedFetch, protocolVersion: KIVO_MCP_PROTOCOL,
      onInsufficientScope: 'throw', requestInit: { redirect: 'error' },
    })
    await client.connect(transport, { signal })
    if (client.getNegotiatedProtocolVersion() !== KIVO_MCP_PROTOCOL) throw tpmError('INVALID_SOURCE', MESSAGES.INVALID_SOURCE)
    const listing = await client.listTools(undefined, { signal, cacheMode: 'refresh' })
    const tools = assertKivoTpmTools(listing.tools)
    await options.authorize()
    throwIfAborted(signal)
    return await run({ client, tools, signal, connection, traceId })
  } catch (error) {
    throw safeError(authorizationFailure ?? error, options.signal, timeout)
  } finally {
    await client?.close().catch(() => undefined)
  }
}

async function readTool(client, tools, request, signal, traceId) {
  const tool = tools.get(request.name)
  if (!tool) throw tpmError('FORBIDDEN', MESSAGES.FORBIDDEN)
  // Passing the checked definition also disables SDK header-mismatch auto-refresh/retry.
  const result = await client.callTool(request, { signal, toolDefinition: tool })
  if (result.isError) {
    let code
    try { code = JSON.parse(result.content?.[0]?.text).code } catch {}
    const mapped = { not_found: 'NOT_FOUND', unauthorized: 'FORBIDDEN', permission_denied: 'FORBIDDEN', invalid_upstream_response: 'INVALID_SOURCE', conflict: 'ACTION_CONFLICT', invalid_request: 'INVALID_REQUEST' }[code] ?? 'UPSTREAM_ERROR'
    throw tpmError(mapped, MESSAGES[mapped])
  }
  if (!result.structuredContent || result.structuredContent.source?.traceId !== traceId) throw tpmError('INVALID_SOURCE', MESSAGES.INVALID_SOURCE)
  const actual = new URL(result.structuredContent.source.path, 'http://kivo.invalid')
  const path = request.name === 'mes.monitor.current' ? `/api/v1/mes/equipment/monitor/${encodeURIComponent(request.arguments.deviceCode)}/current`
    : request.name === 'tpm.repair.create' ? '/api/v1/mes/tpm/repairs' : tpmSourcePath(request)
  const expected = new URL(path, 'http://kivo.invalid')
  actual.searchParams.sort(); expected.searchParams.sort()
  if (actual.href !== expected.href) throw tpmError('INVALID_SOURCE', MESSAGES.INVALID_SOURCE)
  return result.structuredContent
}

function validateConnection(value) {
  if (!value || value.kind !== 'kivo-mcp' || !Array.isArray(value.allowedObjectIds) || value.allowedObjectIds.length !== 0
    || typeof value.clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.clientId)) throw tpmError('SOURCE_NOT_CONFIGURED', MESSAGES.SOURCE_NOT_CONFIGURED)
  const resource = new URL(value.baseUrl), issuer = new URL(value.issuer)
  if (!['http:', 'https:'].includes(resource.protocol) || resource.username || resource.password || resource.search || resource.hash || resource.pathname !== '/api/v1/mes/mcp'
    || issuer.href !== `${issuer.origin}/` || value.issuer !== issuer.origin || issuer.origin !== resource.origin) throw tpmError('SOURCE_NOT_CONFIGURED', MESSAGES.SOURCE_NOT_CONFIGURED)
  return structuredClone(value)
}

async function readPrivateKey(secretRoot, credentialRef) {
  let handle
  try {
    const file = await resolveCredentialFile(secretRoot, credentialRef)
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new Error('permissions')
    const value = (await handle.readFile('utf8')).trim()
    if (!value.startsWith('-----BEGIN PRIVATE KEY-----\n') || !value.endsWith('\n-----END PRIVATE KEY-----')) throw new Error('format')
    return value
  } catch {
    throw tpmError('SOURCE_NOT_CONFIGURED', MESSAGES.SOURCE_NOT_CONFIGURED)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value }
function combineSignals(...signals) { const values = signals.filter(Boolean); return values.length ? AbortSignal.any(values) : undefined }
function throwIfAborted(signal) { if (signal?.aborted) throw tpmError('CANCELLED', MESSAGES.CANCELLED) }
function safeError(error, signal, timeout) {
  const code = signal?.aborted ? signal.reason?.code === 'UPSTREAM_TIMEOUT' || signal.reason?.name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'CANCELLED'
    : timeout?.aborted ? 'UPSTREAM_TIMEOUT'
      : Object.hasOwn(MESSAGES, error?.code) ? error.code
        : error instanceof InsufficientScopeError
          || (error instanceof OAuthError && [OAuthErrorCode.InvalidClient, OAuthErrorCode.UnauthorizedClient].includes(error.code))
          || [401, 403].includes(error?.status ?? error?.code) ? 'FORBIDDEN'
          : [-32600, -32602].includes(error?.code) ? 'INVALID_SOURCE' : 'UPSTREAM_ERROR'
  return tpmError(code, MESSAGES[code])
}
