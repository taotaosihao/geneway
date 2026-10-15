import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createAuthRuntime, isSessionCurrent } from './auth.mjs'
import { createFileStore } from './store/file-store.mjs'
import { createWorkService, ERROR_STATUS, safeServiceError, serviceFailure } from './work-service.mjs'
import { createDshRunner } from './dsh-runner.mjs'
import { createCollaborationRunner } from './collaboration-runner.mjs'
import { readRuntimeConfig } from './runtime-config.mjs'
import { readConnectionCatalog } from './connection-catalog.mjs'
import { readGearJobWorkOrder } from '../plugins/gearjob-work-order.mjs'
import { createFeishuRuntime } from '../plugins/feishu.mjs'
import { createGearJobEventReceiver, readGearJobEventRuntimeConfig } from '../plugins/gearjob-events.mjs'
import { ChannelServiceError, createChannelService } from './channel-service.mjs'
import { AutomationServiceError, createAutomationRuntime, createAutomationService } from './automation-service.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const COOKIE = 'geneway_session'
const JSON_TYPE = 'application/json'
const WORK_FIELDS = ['employeeId', 'skillId', 'capabilityId', 'connectionId', 'goal', 'input', 'workOrderId', 'availableSeconds', 'quantity', 'clientRequestId']
const COLLABORATION_ROOT_FIELDS = ['workType', 'employeeId', 'skillId', 'capabilityId', 'connectionId', 'goal', 'clientRequestId', 'items']
const COLLABORATION_ITEM_FIELDS = ['id', 'employeeId', 'skillId', 'capabilityId', 'connectionId', 'goal', 'input', 'workOrderId', 'availableSeconds', 'quantity', 'knowledgeQuery', 'dependsOn']
const BUSINESS_INPUT_FIELDS = ['workOrderId', 'availableSeconds', 'quantity']

export async function start() {
  const port = positivePort(process.env.GENEWAY_PORT ?? 3471)
  const host = process.env.GENEWAY_HOST ?? '127.0.0.1'
  const statePath = resolve(process.env.GENEWAY_STATE ?? join(root, 'var', 'state.json'))
  const authFile = process.env.GENEWAY_AUTH_FILE
  if (!authFile) throw new Error('必须配置仓库外 GENEWAY_AUTH_FILE')
  const authPath = resolve(authFile)
  const authRelative = relative(root, authPath)
  if (authRelative !== '..' && !authRelative.startsWith(`..${sep}`)) throw new Error('GENEWAY_AUTH_FILE 必须位于仓库外')
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('P2 仅允许 loopback 监听')
  const trustedOrigin = process.env.GENEWAY_TRUSTED_ORIGIN ?? `http://${host === '::1' ? '[::1]' : host}:${port}`
  const origin = new URL(trustedOrigin)
  if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('GENEWAY_TRUSTED_ORIGIN 必须匹配 P2 明文 loopback HTTP 服务')

  const runtimeConfig = readRuntimeConfig({ ...process.env, GENEWAY_STATE: statePath }, root)
  const gearJobEventConfig = await readGearJobEventRuntimeConfig(process.env, root)
  const store = createFileStore(statePath)
  const connectionCatalog = await readConnectionCatalog(runtimeConfig.connectionCatalogFile, root)
  const runner = createDshRunner({ root, config: runtimeConfig })
  const collaborationRunner = createCollaborationRunner({ store, root, dshHome: runtimeConfig.dshHome, secretRoot: runtimeConfig.secretRoot })
  const knowledge = collaborationRunner.getKnowledgeService()
  let channelRuntime, automationRuntime, gearJobEventReceiver
  const service = createWorkService({
    store, runner, collaborationRunner,
    connectionCatalog,
    policyPaths: { stateFile: runtimeConfig.stateFile, dataRoot: runtimeConfig.dataRoot, secretRoot: runtimeConfig.secretRoot },
    connectionTester: async connection => {
      const workOrderId = connection.allowedObjectIds?.[0]
      if (!workOrderId) throw Object.assign(new Error('连接没有可测试的只读对象'), { code: 'INVALID_REQUEST' })
      const result = await readGearJobWorkOrder({ workOrderId, connection, secretRoot: runtimeConfig.secretRoot })
      return result.sourceRecordId
    },
    onAutomationTerminal: () => channelRuntime?.sendAutomationNotifications({ ownerCheck: () => automationRuntime?.ownsLock() === true }),
  })
  const auth = createAuthRuntime({ filePath: authPath })
  const index = await readFile(join(root, 'web', 'index.html'), 'utf8')
  const automation = createAutomationService({ store, workService: service, connectionCatalog, eventSourceId: gearJobEventConfig?.sourceId, eventSourceReady: () => automationRuntime?.ownsLock() === true && gearJobEventReceiver?.isListening() === true })
  automationRuntime = createAutomationRuntime({
    store, automationService: automation, workService: service, dataRoot: runtimeConfig.dataRoot,
    onOwnerLost: async () => { const receiver = gearJobEventReceiver; gearJobEventReceiver = undefined; await receiver?.close() },
    onError: error => console.error(error),
  })
  const channel = createChannelService({ store, workService: service })
  channelRuntime = createFeishuRuntime({ store, channelService: channel, secretRoot: process.env.GENEWAY_SECRET_ROOT?.trim() ? runtimeConfig.secretRoot : undefined, automationOwnerCheck: () => automationRuntime.ownsLock() })
  try {
    await automationRuntime.start()
    if (gearJobEventConfig) {
      gearJobEventReceiver = createGearJobEventReceiver({ automationRuntime, ...gearJobEventConfig })
      await gearJobEventReceiver.start()
    }
    await channelRuntime.start()
  } catch (error) {
    await gearJobEventReceiver?.close?.().catch(() => undefined)
    await automationRuntime.stop().catch(() => undefined)
    await channelRuntime.close().catch(() => undefined)
    await service.close().catch(() => undefined)
    await automationRuntime.close().catch(() => undefined)
    throw error
  }
  const server = createGenewayServer({ service, knowledge, collaborationRunner, channel, channelRuntime, automation, automationRuntime, store, auth, index, trustedOrigin })
  server.listen(port, host, () => console.log(`Geneway listening on ${trustedOrigin}`))

  let shuttingDown = false
  const shutdown = async code => {
    if (shuttingDown) return
    shuttingDown = true
    await shutdownServer(server, service, channelRuntime, automationRuntime, gearJobEventReceiver)
    process.exit(code)
  }
  process.once('SIGTERM', () => shutdown(0))
  process.once('SIGINT', () => shutdown(0))
  return server
}

export function createGenewayServer({ service, knowledge, collaborationRunner, channel, channelRuntime, automation, automationRuntime, store, auth, index = '', trustedOrigin }) {
  if (!service || !store || !auth || !trustedOrigin) throw new Error('server dependencies are required')
  channel ??= createChannelService({ store, workService: service })
  const channelRuntimeReady = channelAppId => channelRuntime?.isAvailable?.(channelAppId) === true
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', trustedOrigin)
      if (request.method === 'GET' && url.pathname === '/') return send(response, 200, index, 'text/html; charset=utf-8')
      if (request.method === 'GET' && url.pathname === '/favicon.ico') return send(response, 204, '', 'image/x-icon')

      if (url.pathname === '/api/session') {
        if (request.method === 'POST') {
          requireOrigin(request, trustedOrigin)
          const body = await readJson(request, ['loginName', 'password'])
          const state = await store.read()
          const member = state.members.find(item => item.loginName === body.loginName && item.enabled === true)
          const valid = await auth.verifyPassword(member?.authRef ?? 'unknown-login', body.password)
          if (!member || !valid) throw httpError('UNAUTHORIZED', '登录名或密码错误')
          const current = (await store.read()).members.find(item => item.id === member.id && item.enabled === true && item.sessionVersion === member.sessionVersion)
          if (!current) throw httpError('UNAUTHORIZED', '登录名或密码错误')
          const session = await auth.issueSession(current)
          return sendJson(response, 200, { member: safeMember(current), csrfToken: session.csrfToken, expiresAt: session.expiresAt }, { 'set-cookie': sessionCookie(session.token, session.expiresAt) })
        }
        const context = await authenticated(request, store, auth)
        if (request.method === 'GET') {
          return sendJson(response, 200, { member: safeMember(context.member), csrfToken: context.csrfToken, expiresAt: context.session.expiresAt })
        }
        if (request.method === 'DELETE') {
          await protectedWrite(request, context.token, auth, trustedOrigin, [])
          await service.invalidateSession(context.member)
          return sendJson(response, 200, { ok: true, invalidatedAllSessions: true }, { 'set-cookie': clearSessionCookie() })
        }
        return notFound(response)
      }

      const context = await authenticated(request, store, auth)
      const actor = context.member
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') { exactQuery(url); return sendJson(response, 200, await service.bootstrap(actor)) }
      if (request.method === 'GET' && url.pathname === '/api/automations') {
        exactQuery(url)
        return sendJson(response, 200, automation ? { rules: await automation.listRules(actor), occurrences: await automation.listOccurrences(actor), eventSource: automation.eventSourceCapability() } : { rules: [], occurrences: [], eventSource: { status: 'unavailable', code: 'SOURCE_NOT_CONFIGURED' } })
      }
      if (automation && request.method === 'POST' && url.pathname === '/api/automations') {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['employeeId', 'skillId', 'connectionId', 'workOrderId', 'trigger', 'maxRuns', 'notificationConversationId'])
        const rule = await automation.createRule(actor, body)
        return sendJson(response, 200, rule)
      }
      const automationMatch = url.pathname.match(/^\/api\/automations\/([^/]+)(?:\/(enable|pause|resume|revoke|check-now))?$/)
      if (automation && automationMatch && request.method === 'GET' && !automationMatch[2]) {
        exactQuery(url)
        const id = decode(automationMatch[1])
        return sendJson(response, 200, { rule: await automation.getRule(actor, id), occurrences: await automation.listOccurrences(actor, id), eventSource: automation.eventSourceCapability() })
      }
      if (automation && automationMatch && request.method === 'PATCH' && !automationMatch[2]) {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['expectedRevision', 'employeeId', 'skillId', 'connectionId', 'workOrderId', 'trigger', 'maxRuns', 'notificationConversationId'])
        const rule = await automation.updateRule(actor, decode(automationMatch[1]), body)
        await automationRuntime?.refresh?.()
        return sendJson(response, 200, rule)
      }
      if (automation && automationMatch && request.method === 'POST' && automationMatch[2]) {
        exactQuery(url)
        const action = automationMatch[2]
        if (action === 'check-now') {
          const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['expectedRevision', 'clientRequestId'])
          const result = await automationRuntime.checkNow(actor, decode(automationMatch[1]), body)
          return sendJson(response, 200, { accepted: result.accepted, deduplicated: result.deduplicated, workId: result.workId ?? null, skipped: result.skipped ?? false, blocked: result.blocked ?? false, reason: result.reason ?? null })
        }
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['expectedRevision'])
        const rule = await automation[`${action}Rule`](actor, decode(automationMatch[1]), body)
        await automationRuntime?.refresh?.()
        return sendJson(response, 200, rule)
      }
      if (request.method === 'GET' && url.pathname === '/api/confirmations') return sendJson(response, 200, await service.listConfirmations(actor))
      if (request.method === 'POST' && url.pathname === '/api/confirmations') {
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['employeeId', 'label', 'value'])
        return sendJson(response, 200, await service.createConfirmation(actor, body))
      }
      const confirmationMatch = url.pathname.match(/^\/api\/confirmations\/([^/]+)$/)
      if (confirmationMatch && request.method === 'PATCH') {
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['label', 'value'])
        return sendJson(response, 200, await service.updateConfirmation(actor, decode(confirmationMatch[1]), body))
      }
      if (confirmationMatch && request.method === 'DELETE') {
        await protectedWrite(request, context.token, auth, trustedOrigin, [])
        return sendJson(response, 200, await service.deleteConfirmation(actor, decode(confirmationMatch[1])))
      }

      if (request.method === 'POST' && url.pathname === '/api/works') {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, [...WORK_FIELDS, 'workType', 'items'])
        if (body.workType === undefined) { exactObject(body, WORK_FIELDS); if (body.input !== undefined) exactObject(body.input, BUSINESS_INPUT_FIELDS); return resultResponse(response, await service.createWork(actor, body)) }
        if (body.workType !== 'collaboration') throw httpError('INVALID_REQUEST', '工作类型无效')
        exactObject(body, COLLABORATION_ROOT_FIELDS)
        if (!Array.isArray(body.items)) throw httpError('INVALID_REQUEST', '协作计划必须是数组')
        for (const item of body.items) {
          exactObject(item, COLLABORATION_ITEM_FIELDS)
          if (item.input !== undefined) {
            exactObject(item.input, BUSINESS_INPUT_FIELDS)
            if (BUSINESS_INPUT_FIELDS.some(key => item[key] !== undefined)) throw httpError('INVALID_REQUEST', '协作计划项不能同时使用 input 与直接输入字段')
          }
        }
        const { workType: _workType, ...input } = body
        return resultResponse(response, await service.createCollaboration(actor, input))
      }
      const workMatch = url.pathname.match(/^\/api\/works\/([^/]+)(?:\/(plan|continue|refresh|follow-up|recheck|cancel))?$/)
      if (workMatch && request.method === 'GET' && !workMatch[2]) { exactQuery(url); return resultResponse(response, await service.getWork(actor, decode(workMatch[1]))) }
      if (workMatch && request.method === 'PATCH' && workMatch[2] === 'plan') {
        exactQuery(url)
        const current = await service.getWork(actor, decode(workMatch[1]))
        if (!current.ok) return resultResponse(response, current)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['expectedRevision', 'items'])
        if (current.value.workType !== 'collaboration') throw httpError('INVALID_REQUEST', '仅协作工作可修改计划')
        if (!Array.isArray(body.items)) throw httpError('INVALID_REQUEST', '计划修改必须是数组')
        for (const item of body.items) exactObject(item, ['id', 'goal', 'employeeId'])
        return resultResponse(response, await service.updateCollaborationPlan(actor, decode(workMatch[1]), body))
      }
      if (workMatch && request.method === 'POST' && ['continue', 'refresh', 'follow-up', 'recheck', 'cancel'].includes(workMatch[2])) {
        exactQuery(url)
        const id = decode(workMatch[1])
        const action = workMatch[2]
        const current = await service.getWork(actor, id)
        if (!current.ok) return resultResponse(response, current)
        if (current.value.workType === 'collaboration-child') throw httpError('INVALID_REQUEST', '请从所属协作工作执行此操作')
        const collaboration = current.value.workType === 'collaboration'
        const allowed = action === 'continue' ? collaboration ? ['clientRequestId', 'inputs'] : ['input', 'workOrderId', 'availableSeconds', 'quantity', 'clientRequestId']
          : action === 'recheck' && collaboration ? ['clientRequestId', 'inputs']
            : action === 'follow-up' && !collaboration ? ['text', 'clientRequestId']
              : action === 'refresh' && !collaboration ? ['clientRequestId'] : []
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, allowed)
        if ((action === 'recheck' && !collaboration) || (collaboration && ['refresh', 'follow-up'].includes(action))) throw httpError('INVALID_REQUEST', '工作类型不支持此操作')
        if (body.input !== undefined) exactObject(body.input, BUSINESS_INPUT_FIELDS)
        if (body.inputs !== undefined) {
          exactObject(body.inputs, current.value.workType === 'collaboration' ? current.value.plan.items.map(item => item.id) : [])
          for (const value of Object.values(body.inputs)) exactObject(value, BUSINESS_INPUT_FIELDS)
        }
        const result = action === 'continue' ? current.value.workType === 'collaboration'
          ? await service.continueCollaboration(actor, id, body)
          : await service.continueWork(actor, id, body)
          : action === 'recheck' ? current.value.workType === 'collaboration'
            ? await service.recheckCollaboration(actor, id, body)
            : (() => { throw httpError('INVALID_REQUEST', '仅协作工作可重新核对') })()
          : action === 'refresh' ? await service.refreshWork(actor, id, body)
            : action === 'follow-up' ? await service.followUp(actor, id, body.text, body)
              : action === 'cancel' ? await service.cancel(actor, id)
                : (() => { throw httpError('NOT_FOUND', '接口不存在') })()
        return resultResponse(response, result)
      }

      if (channel && request.method === 'GET' && url.pathname === '/api/channels/apps') {
        exactQuery(url)
        return sendJson(response, 200, safeMemberChannelApps(await channel.listChannelApps(actor), channelRuntimeReady))
      }
      if (channel && request.method === 'GET' && url.pathname === '/api/channels') {
        exactQuery(url)
        return sendJson(response, 200, safeChannelState(await channel.memberChannelState(actor)))
      }
      if (channel && request.method === 'POST' && url.pathname === '/api/channels/link-codes') {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['channelAppId'])
        if (!channelRuntimeReady(body.channelAppId)) throw httpError('UNAVAILABLE', '真实渠道传输尚未启用，未生成关联码')
        return sendJson(response, 200, await channel.issueLinkCode(actor, body))
      }
      const linkMatch = url.pathname.match(/^\/api\/channels\/link-codes\/([^/]+)\/confirm$/)
      if (channel && linkMatch && request.method === 'POST') {
        exactQuery(url)
        await protectedWrite(request, context.token, auth, trustedOrigin, [])
        return sendJson(response, 200, await channel.confirmLink(actor, { linkCodeId: decode(linkMatch[1]) }))
      }
      const identityMatch = url.pathname.match(/^\/api\/channels\/identities\/([^/]+)$/)
      if (channel && identityMatch && request.method === 'DELETE') {
        exactQuery(url)
        await protectedWrite(request, context.token, auth, trustedOrigin, [])
        return sendJson(response, 200, await channel.unlinkIdentity(actor, { identityId: decode(identityMatch[1]) }))
      }
      const dispatchMatch = url.pathname.match(/^\/api\/channels\/conversations\/([^/]+)\/default-dispatch$/)
      if (channel && dispatchMatch && request.method === 'PATCH') {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['employeeId', 'skillId', 'capabilityId', 'connectionId'])
        return sendJson(response, 200, await channel.setDefaultDispatch(actor, { conversationId: decode(dispatchMatch[1]), ...body }))
      }
      if (channel && dispatchMatch && request.method === 'DELETE') {
        exactQuery(url)
        await protectedWrite(request, context.token, auth, trustedOrigin, [])
        return sendJson(response, 200, await channel.clearDefaultDispatch(actor, { conversationId: decode(dispatchMatch[1]) }))
      }
      if (channel && request.method === 'POST' && url.pathname === '/api/channels/deliveries') {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['requestId', 'workId', 'resultId'])
        const channelState = await channel.memberChannelState(actor)
        const originApps = new Set(channelState.messages.filter(item => item.workId === body.workId && item.status === 'accepted' && item.command?.type === 'create').map(item => item.channelAppId))
        if (originApps.size === 1 && !channelRuntimeReady([...originApps][0])) throw httpError('UNAVAILABLE', '真实渠道发送尚未启用，未建立待发回复')
        const created = await channel.createWorkDelivery(actor, body)
        if (created.delivery.status !== 'pending') return sendJson(response, 200, created)
        if (!channelRuntimeReady(created.delivery.channelAppId)) throw httpError('UNAVAILABLE', '真实渠道发送尚未启用，回复保留为待发送')
        const delivery = await channelRuntime.sendDelivery(created.delivery.id)
        return sendJson(response, 200, { ...created, delivery })
      }
      const deliveryMatch = url.pathname.match(/^\/api\/channels\/deliveries\/([^/]+)(?:\/(retry))?$/)
      if (channel && deliveryMatch && request.method === 'DELETE' && !deliveryMatch[2]) {
        exactQuery(url)
        await protectedWrite(request, context.token, auth, trustedOrigin, [])
        return sendJson(response, 200, await channel.cancelDelivery(actor, { deliveryId: decode(deliveryMatch[1]) }))
      }
      if (channel && deliveryMatch && request.method === 'POST' && deliveryMatch[2] === 'retry') {
        exactQuery(url)
        await protectedWrite(request, context.token, auth, trustedOrigin, [])
        const delivery = (await channel.memberChannelState(actor)).deliveries.find(item => item.id === decode(deliveryMatch[1]))
        if (!delivery) throw httpError('NOT_FOUND', '投递不存在')
        if (!channelRuntimeReady(delivery.channelAppId)) throw httpError('UNAVAILABLE', '真实渠道发送尚未启用，投递状态未改变')
        return sendJson(response, 200, await channelRuntime.sendDelivery(delivery.id, { retry: true }))
      }

      if (channel && request.method === 'GET' && url.pathname === '/api/admin/channel-apps') {
        exactQuery(url)
        if (actor.role !== 'admin') throw httpError('FORBIDDEN', '需要管理员权限')
        return sendJson(response, 200, await channel.listChannelApps(actor))
      }
      if (channel && request.method === 'POST' && url.pathname === '/api/admin/channel-apps') {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['id', 'provider', 'providerAppId', 'providerTenantId', 'credentialRef', 'enabled', 'allowedScopes'])
        const app = await channel.upsertChannelApp(actor, { ...body, status: body.enabled === false ? 'disabled' : 'unavailable' })
        await channelRuntime?.sync?.()
        return sendJson(response, 200, (await channel.listChannelApps(actor)).find(item => item.id === app.id) ?? app)
      }
      const channelAppMatch = url.pathname.match(/^\/api\/admin\/channel-apps\/([^/]+)$/)
      if (channel && channelAppMatch && request.method === 'PATCH') {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['credentialRef', 'enabled', 'allowedScopes'])
        const app = await channel.upsertChannelApp(actor, { id: decode(channelAppMatch[1]), ...body, status: body.enabled === false ? 'disabled' : 'unavailable' })
        await channelRuntime?.sync?.()
        return sendJson(response, 200, (await channel.listChannelApps(actor)).find(item => item.id === app.id) ?? app)
      }

      if (url.pathname === '/api/knowledge/share-targets' && request.method === 'GET') {
        exactQuery(url)
        return sendJson(response, 200, await requireKnowledge(knowledge).listShareTargets(actor))
      }
      if (url.pathname === '/api/knowledge') {
        if (request.method === 'GET') { exactQuery(url, ['employeeId']); return sendJson(response, 200, await requireKnowledge(knowledge).listMaterials(actor, queryObject(url, ['employeeId']))) }
        if (request.method === 'POST') {
          exactQuery(url)
          const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['employeeIds', 'sharedMemberIds', 'sharedEmployeeIds', 'title', 'body', 'format', 'sourceLabel', 'authorizationBasis'])
          requireKnowledgeEnabled(knowledge, collaborationRunner)
          return sendJson(response, 200, await knowledge.createMaterial(actor, body))
        }
      }
      if (url.pathname === '/api/knowledge/search' && request.method === 'POST') {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['employeeId', 'query'])
        requireKnowledgeEnabled(knowledge, collaborationRunner)
        return sendJson(response, 200, await knowledge.search(actor, body))
      }
      const knowledgeMatch = url.pathname.match(/^\/api\/knowledge\/([^/]+)(?:\/(sharing))?$/)
      if (knowledgeMatch && request.method === 'GET' && !knowledgeMatch[2]) {
        exactQuery(url, ['employeeId'])
        return sendJson(response, 200, await requireKnowledge(knowledge).getMaterial(actor, decode(knowledgeMatch[1]), queryObject(url, ['employeeId'])))
      }
      if (knowledgeMatch && request.method === 'PATCH' && !knowledgeMatch[2]) {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['expectedRevision', 'employeeIds', 'title', 'body', 'format', 'sourceLabel', 'authorizationBasis'])
        return sendJson(response, 200, await requireKnowledge(knowledge).updateMaterial(actor, decode(knowledgeMatch[1]), body))
      }
      if (knowledgeMatch && request.method === 'PATCH' && knowledgeMatch[2] === 'sharing') {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['expectedRevision', 'memberIds', 'employeeIds'])
        return sendJson(response, 200, await requireKnowledge(knowledge).updateSharing(actor, decode(knowledgeMatch[1]), body))
      }
      if (knowledgeMatch && request.method === 'DELETE' && !knowledgeMatch[2]) {
        exactQuery(url)
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['expectedRevision'])
        return sendJson(response, 200, await requireKnowledge(knowledge).deleteMaterial(actor, decode(knowledgeMatch[1]), body))
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/members') return sendJson(response, 200, await service.listMembers(actor))
      const memberMatch = url.pathname.match(/^\/api\/admin\/members\/([^/]+)$/)
      if (memberMatch && request.method === 'PATCH') {
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['displayName', 'role', 'enabled', 'employeeIds', 'expectedEmployeeIds'])
        return sendJson(response, 200, await service.updateMember(actor, decode(memberMatch[1]), body))
      }

      const connectionTest = url.pathname.match(/^\/api\/admin\/connections\/([^/]+)\/test$/)
      if (connectionTest && request.method === 'POST') {
        await protectedWrite(request, context.token, auth, trustedOrigin, [])
        return sendJson(response, 200, await service.testConnection(actor, decode(connectionTest[1])))
      }
      const configMatch = url.pathname.match(/^\/api\/admin\/(employees|connections|skills|model-routes)(?:\/([^/]+))?$/)
      if (configMatch) {
        const kind = configMatch[1] === 'model-routes' ? 'modelRoutes' : configMatch[1]
        const id = configMatch[2] ? decode(configMatch[2]) : undefined
        if (request.method === 'GET' && !id) return sendJson(response, 200, await service.listConfig(actor, kind))
        if (request.method === 'POST' && !id) {
          const body = await protectedWrite(request, context.token, auth, trustedOrigin, configFields(kind, true))
          return sendJson(response, 200, await service.createConfig(actor, kind, body))
        }
        if (request.method === 'PATCH') {
          const body = await protectedWrite(request, context.token, auth, trustedOrigin, configFields(kind, false, !id))
          const targetId = id ?? body.id
          if (!targetId) throw httpError('INVALID_REQUEST', '配置 ID 不能为空')
          const { id: _id, ...changes } = body
          return sendJson(response, 200, await service.updateConfig(actor, kind, targetId, changes))
        }
      }
      return notFound(response)
    } catch (error) {
      const result = serviceFailure(error)
      if (error instanceof ChannelServiceError) result.error.status = CHANNEL_ERROR_STATUS[error.code] ?? 500
      else if (error instanceof AutomationServiceError) result.error.status = AUTOMATION_ERROR_STATUS[error.code] ?? 500
      else if (Number.isInteger(error?.status)) result.error.status = error.status
      return sendJson(response, result.error.status, { error: clientError(result.error) })
    }
  })
}

const CHANNEL_ERROR_STATUS = {
  INVALID_REQUEST: 400, LINK_CODE_INVALID: 400, UNAUTHORIZED: 401, FORBIDDEN: 403,
  DELIVERY_FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INVALID_STATE: 409, UNAVAILABLE: 503,
}

const AUTOMATION_ERROR_STATUS = {
  INVALID_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  REVISION_CONFLICT: 409, INVALID_STATE: 409, BUDGET_EXHAUSTED: 409, CONFLICT: 409,
  SOURCE_NOT_CONFIGURED: 503,
  OWNER_NOT_RUNNING: 503, OWNER_LOCK_LOST: 503,
}

function safeChannelState(value) {
  const workChannels = [...new Map(value.messages.filter(item => item.status === 'accepted' && item.direction === 'inbound' && item.workId && item.conversationId).map(item => [`${item.workId}:${item.conversationId}`, { workId: item.workId, channelAppId: item.channelAppId, conversationId: item.conversationId }])).values()]
  return {
    identities: value.identities.map(item => ({ id: item.id, channelAppId: item.channelAppId, status: item.status, externalIdentity: maskOfficialId(item.providerUserId), updatedAt: item.updatedAt })),
    conversations: value.conversations.map(item => ({ id: item.id, channelAppId: item.channelAppId, identityId: item.identityId, type: item.type, status: item.status, externalConversation: maskOfficialId(item.providerConversationId), defaultDispatch: item.defaultDispatch, updatedAt: item.updatedAt })),
    deliveries: value.deliveries.map(item => ({ id: item.id, channelAppId: item.channelAppId, workId: item.workId, resultId: item.resultId, targetConversationId: item.targetConversationId, status: item.status, attempts: item.attempts, error: item.error, createdAt: item.createdAt, updatedAt: item.updatedAt })),
    linkCodes: value.linkCodes.map(item => ({ id: item.id, channelAppId: item.channelAppId, status: item.status, expiresAt: item.expiresAt, matchedIdentityId: item.matchedIdentityId, matchedConversationId: item.matchedConversationId, updatedAt: item.updatedAt })),
    workChannels,
  }
}

function safeMemberChannelApps(items, runtimeReady) {
  return items.filter(item => item.enabled === true && item.status === 'active' && runtimeReady(item.id)).map(item => ({ id: item.id, provider: item.provider, runtimeStatus: 'ready' }))
}

function maskOfficialId(value) {
  const text = String(value ?? '')
  return text.length <= 4 ? '•'.repeat(text.length) : `…${text.slice(-4)}`
}

export async function shutdownServer(server, service, channelRuntime, automationRuntime, gearJobEventReceiver) {
  const intakeClosed = new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
  await gearJobEventReceiver?.close?.().catch(() => undefined)
  await automationRuntime?.stop?.().catch(() => undefined)
  await channelRuntime?.close?.().catch(() => undefined)
  await service.close().catch(() => undefined)
  await intakeClosed
  await automationRuntime?.close?.().catch(() => undefined)
}

async function authenticated(request, store, auth) {
  const token = cookieValue(request.headers.cookie, COOKIE)
  const view = token && await auth.sessionView(token)
  const session = view?.session
  const state = await store.read()
  const member = state.members.find(item => item.id === session?.memberId)
  if (!isSessionCurrent(session, member)) throw httpError('UNAUTHORIZED', '会话无效或已过期')
  return { token, session, member, csrfToken: view.csrfToken }
}

async function protectedWrite(request, token, auth, trustedOrigin, allowed) {
  requireOrigin(request, trustedOrigin)
  if (!await auth.verifyCsrf(token, request.headers['x-csrf-token'])) throw httpError('FORBIDDEN', 'CSRF 校验失败')
  return readJson(request, allowed)
}

function requireOrigin(request, trustedOrigin) {
  if (request.headers.origin !== trustedOrigin) throw httpError('FORBIDDEN', '请求 Origin 不受信任')
}

async function readJson(request, allowed) {
  if (String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== JSON_TYPE) throw httpError('INVALID_REQUEST', '请求必须使用 application/json')
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > 64 * 1024) throw httpError('INVALID_REQUEST', '请求内容过大')
  }
  let parsed
  try { parsed = body === '' ? {} : JSON.parse(body) } catch { throw httpError('INVALID_REQUEST', '请求内容不是有效 JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw httpError('INVALID_REQUEST', '请求 JSON 必须是对象')
  const unexpected = Object.keys(parsed).find(key => !allowed.includes(key))
  if (unexpected) throw httpError('INVALID_REQUEST', `请求包含未声明字段 ${unexpected}`)
  return parsed
}

function configFields(kind, create, collectionPatch = false) {
  const id = create || collectionPatch ? ['id'] : []
  if (kind === 'employees') return [...id, 'name', 'description', 'instructions', 'enabled', 'modelRouteId', 'connectionIds', 'skillIds', 'memberIds', ...(!create ? ['expectedRevision'] : [])]
  if (kind === 'connections') return [...id, 'name', 'kind', 'targetIdentity', 'baseUrl', 'hostHeader', 'credentialRef', 'allowedObjectIds', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'enabled', 'skillIds']
  if (kind === 'skills') return [...id, 'name', 'capabilityId', 'enabled']
  return [...id, 'provider', 'model', 'displayName', 'enabled', 'credentialRef']
}

function resultResponse(response, result) { return result.ok ? sendJson(response, 200, result.value) : sendJson(response, result.error.status, { error: clientError(result.error) }) }
function clientError(error) { return error.status >= 500 ? { ...safeServiceError(error), status: error.status } : error }
function notFound(response) { return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '接口不存在', status: 404 } }) }
function sendJson(response, status, value, headers = {}) { return send(response, status, JSON.stringify(value), 'application/json; charset=utf-8', headers) }
function send(response, status, body, contentType, headers = {}) { response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); response.end(body) }
function sessionCookie(token, expiresAt) { return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}` }
function clearSessionCookie() { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }
function cookieValue(header, name) { for (const part of String(header ?? '').split(';')) { const [key, ...rest] = part.trim().split('='); if (key === name) { try { return decodeURIComponent(rest.join('=')) } catch { return undefined } } } return undefined }
function safeMember(member) { return Object.fromEntries(['id', 'loginName', 'displayName', 'role', 'enabled', 'sessionVersion', 'employeeIds'].map(key => [key, structuredClone(member[key])])) }
function exactObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('INVALID_REQUEST', '请求 JSON 必须是对象')
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected) throw httpError('INVALID_REQUEST', `请求包含未声明字段 ${unexpected}`)
}
function exactQuery(url, allowed = []) {
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw httpError('INVALID_REQUEST', `查询参数 ${key} 无效`)
  }
}
function queryObject(url, allowed) { return Object.fromEntries(allowed.filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)])) }
function requireKnowledge(knowledge) { if (!knowledge) throw httpError('KNOWLEDGE_PLUGIN_DISABLED', '知识能力已停用'); return knowledge }
function requireKnowledgeEnabled(knowledge, runner) {
  requireKnowledge(knowledge)
  if (runner?.isKnowledgeEnabled?.() === false) throw httpError('KNOWLEDGE_PLUGIN_DISABLED', '知识能力已停用')
}
function decode(value) { try { return decodeURIComponent(value) } catch { throw httpError('INVALID_REQUEST', '路径参数无效') } }
function positivePort(value) { const port = Number(value); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GENEWAY_PORT 无效'); return port }
function httpError(code, message) { return Object.assign(new Error(message), { code, status: ERROR_STATUS[code] ?? (code === 'UNAVAILABLE' ? 503 : 500) }) }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start()
