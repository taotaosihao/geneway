import { createHash, randomUUID } from 'node:crypto'
import { correlateKivoTpmDevice } from '../plugins/kivo-tpm.mjs'
import { KIVO_TPM_DEVICE_CORRELATION_CAPABILITY } from './capabilities.mjs'
import { isDeepStrictEqual } from 'node:util'
import { assertTpmDeviceCorrelation, correlationAssessment, correlationBusinessFacts, KIVO_TPM_DEVICE_CORRELATION_KIND } from './domain/tpm-device-correlation.mjs'
import { assertRepairReceipt, KIVO_REPAIR_ACTION, repairIntentKey, repairTargetFromCorrelation, repairText } from './domain/kivo-repair.mjs'
import { createKivoRepairAdapter } from './kivo-repair-adapter.mjs'
import { connectionSnapshot } from './execution-grant.mjs'
import { getCapability } from './capabilities.mjs'
import { authorizeWorkBinding } from './work-service.mjs'

const ACTION_KIND = KIVO_REPAIR_ACTION
const RESULT_KIND = KIVO_TPM_DEVICE_CORRELATION_KIND
const PROPOSAL_VERSION = 'geneway-action-proposal/1'
const PREVIEW_VERSION = 'geneway-action-preview/1'
const PREVIEW_TTL_MS = 10 * 60_000
const DISPATCH_TTL_MS = 15_000
const BODY_BLOCKED = /[\u0000-\u001f\u007f]|@|https?:\/\/|www\.|mailto:|data:|\/files\/|!\[|\]\s*\(/i

export function createActionService({ store, adapter, clock = () => new Date().toISOString(), idFactory = randomUUID, connectionCatalog = [], secretRoot, readCorrelation = correlateKivoTpmDevice } = {}) {
  if (!store) throw new Error('store is required')
  const upstream = adapter ?? createKivoRepairAdapter({ clock })

  return {
    async createPreview(actor, workId, body = {}) {
      if (Object.hasOwn(body, 'body')) commentBody(body.body)
      const clientRequestId = requestId(body.clientRequestId)
      let result
      await store.update(state => {
        const context = actionContext(state, actor, workId, connectionCatalog)
        requireActionCapability(context)
        assertRequestFields(body, ['reason', 'description', 'clientRequestId'])
        if (typeof body.clientRequestId !== 'string') throw actionError('INVALID_REQUEST', 'clientRequestId 无效')
        const target = previewTarget(context)
        const content = { reason: repairText(body.reason), description: repairText(body.description) }
        const expectedRevision = context.result.payload.tpm.revision
        const payload = content
        const requestKey = `request-${sha256(`${context.member.id}\n${context.work.id}\n${clientRequestId}`)}`
        const proposalKey = stableProposalKey(context, { target, payload, expectedRevision })
        const byRequest = context.work.actions.find(item => item.requestKeys.includes(requestKey))
        if (byRequest) {
          if (byRequest.proposalKey !== proposalKey) throw actionError('REVISION_CONFLICT', '同一请求已用于不同预览')
          result = byRequest
          return state
        }
        assertNoRelatedUnresolved(state, context.member.id, repairIntentKey(context.member.id, target))
        const sameProposal = context.work.actions.find(item => item.proposalKey === proposalKey && (item.receipt || !item.attempt && !item.decision?.invalidatedAt
          && (!item.decision || item.decision.kind === 'approved') && !reached(item.preview.expiresAt, nowIso(clock))))
        if (sameProposal) {
          result = { ...sameProposal, requestKeys: [...sameProposal.requestKeys, requestKey] }
          return replaceAction(state, context.work, result)
        }
        const now = nowIso(clock)
        assertFresh(context.result.payload, now)
        const createdAt = now
        const expiresAt = new Date(Date.parse(createdAt) + PREVIEW_TTL_MS).toISOString()
        const actionId = `action-${idFactory()}`
        Object.assign(payload, { orderNo: `GW-${actionId.slice(7)}`, deviceId: target.deviceId })
        const digest = previewDigest(context, { target, payload, expectedRevision, createdAt, expiresAt })
        const actions = context.work.actions.map(item => item.decision?.kind === 'approved' && !item.decision.invalidatedAt && !item.attempt
          ? { ...item, decision: { ...item.decision, invalidatedAt: now, invalidationReason: 'PREVIEW_SUPERSEDED' } }
          : item)
        result = {
          id: actionId, requestKeys: [requestKey], proposalKey,
          intent: { kind: ACTION_KIND, targetKey: repairIntentKey(context.member.id, target) },
          preview: { digest, resultId: context.result.id, target, payload, expectedRevision, createdAt, expiresAt },
          decision: null, attempt: null, receipt: null,
        }
        return replaceWork(state, { ...context.work, actions: [...actions, result] })
      })
      return structuredClone(result)
    },

    async approve(actor, workId, actionId, body = {}) {
      let approved
      await store.update(state => {
        const context = actionContext(state, actor, workId, connectionCatalog)
        requireActionCapability(context)
        const action = requireAction(context.work, actionId)
        assertApprovalRequest(action, body)
        if (action.receipt || action.attempt?.noEffectAt) { approved = action; return state }
        if (action.attempt) { approved = action; return state }
        if (action.decision && action.decision.kind !== 'approved') throw actionError('REVISION_CONFLICT', '动作已经决定')
        if (action.decision?.invalidatedAt) throw actionError('REVISION_CONFLICT', '批准已经失效')
        const now = nowIso(clock)
        if (reached(action.preview.expiresAt, now)) {
          const expired = action.decision ? { ...action, decision: { ...action.decision, invalidatedAt: now, invalidationReason: 'PREVIEW_EXPIRED' } } : { ...action, decision: { kind: 'expired', memberId: context.member.id, previewDigest: action.preview.digest, decidedAt: now } }
          approved = expired
          return replaceAction(state, context.work, expired)
        }
        if (currentDigest(context, action) !== action.preview.digest) {
          const invalid = action.decision
            ? { ...action, decision: { ...action.decision, invalidatedAt: now, invalidationReason: 'PREVIEW_DIGEST_CHANGED' } }
            : { ...action, decision: { kind: 'approved', memberId: context.member.id, previewDigest: action.preview.digest, decidedAt: now, invalidatedAt: now, invalidationReason: 'PREVIEW_DIGEST_CHANGED' } }
          approved = invalid
          return replaceAction(state, context.work, invalid)
        }
        approved = action.decision ? action : { ...action, decision: { kind: 'approved', memberId: context.member.id, previewDigest: action.preview.digest, decidedAt: now } }
        return approved === action ? state : replaceAction(state, context.work, approved)
      })
      if (approved.decision?.kind !== 'approved' || approved.decision.invalidatedAt || approved.receipt || approved.attempt) return structuredClone(approved)

      let refreshContext
      try {
        const snapshot = await store.read()
        refreshContext = actionContext(snapshot, actor, workId, connectionCatalog)
        const action = requireAction(refreshContext.work, actionId)
        const fresh = await readCorrelation({
          input: refreshContext.result.input,
          connection: refreshContext.binding.connection,
          traceId: action.id,
          secretRoot,
          authorize: async () => {
            const current = await store.read()
            const authorized = actionContext(current, actor, workId, connectionCatalog)
            const currentAction = requireAction(authorized.work, actionId)
            if (currentAction.decision?.kind !== 'approved' || currentAction.decision.invalidatedAt || currentAction.attempt
              || currentAction.preview.digest !== action.preview.digest || currentDigest(authorized, currentAction) !== currentAction.preview.digest) throw actionError('FORBIDDEN', '动作批准已失效')
          },
        })
        assertTpmDeviceCorrelation(fresh, refreshContext.result.input)
        assertFresh(fresh, nowIso(clock))
        if (!isDeepStrictEqual(correlationBusinessFacts(fresh), correlationBusinessFacts(refreshContext.result.payload))) {
          await invalidate(actor, workId, actionId, 'SOURCE_FACTS_CHANGED')
          throw actionError('REVISION_CONFLICT', '来源事实已经变化')
        }
      } catch (error) {
        await invalidate(actor, workId, actionId, error?.code === 'REVISION_CONFLICT' ? 'SOURCE_FACTS_CHANGED' : 'SOURCE_RECHECK_FAILED')
        throw error
      }

      const deadlineAt = new Date(Date.parse(approved.decision.decidedAt) + DISPATCH_TTL_MS).toISOString()
      const dispatch = await upstream.dispatch({
        action: approved,
        connection: refreshContext.binding.connection,
        secretRoot,
        deadlineAt,
        claimAttempt: () => claim(actor, workId, actionId, deadlineAt),
        markNoEffect: reason => markNoEffect(actor, workId, actionId, reason),
        authorize: () => authorizeReadback(actor, workId, actionId, true),
        authorizeReadback: () => authorizeReadback(actor, workId, actionId),
      })
      if (dispatch.kind === 'not-claimed') return structuredClone(dispatch.action ?? await currentAction(actor, workId, actionId))
      if (dispatch.kind === 'receipt') return recordReceipt(actor, workId, actionId, dispatch.receipt)
      if (dispatch.kind === 'no-effect') return dispatch.action ? structuredClone(dispatch.action) : markNoEffect(actor, workId, actionId, dispatch.reason)
      return markUnknown(actor, workId, actionId, dispatch.reason)
    },

    async reject(actor, workId, actionId, body = {}) {
      return decide(actor, workId, actionId, 'rejected', body)
    },

    async revoke(actor, workId, actionId, body = {}) {
      let result
      await store.update(state => {
        const context = actionContext(state, actor, workId, connectionCatalog)
        const action = requireAction(context.work, actionId)
        assertApprovalRequest(action, body, false)
        if (action.attempt) throw actionError('BUSY', '写入请求已经开始，不能撤销')
        if (action.decision?.kind === 'approved') {
          result = action.decision.invalidatedAt ? action : { ...action, decision: { ...action.decision, invalidatedAt: nowIso(clock), invalidationReason: 'OWNER_REVOKED' } }
        } else if (!action.decision) {
          result = { ...action, decision: decisionFact('revoked', context.member.id, action.preview.digest, clock) }
        } else if (action.decision.kind === 'revoked') result = action
        else throw actionError('REVISION_CONFLICT', '动作已经决定')
        return result === action ? state : replaceAction(state, context.work, result)
      })
      return structuredClone(result)
    },

    async reconcile(actor, workId, actionId) {
      const state = await store.read()
      const context = readbackContext(state, actor, workId, actionId, connectionCatalog)
      requireActionCapability(context)
      if (requireAction(context.work, actionId).receipt) return structuredClone(requireAction(context.work, actionId))
      const action = requireReadbackAttempt(context, actionId)
      const outcome = await upstream.reconcile({ action, connection: context.binding.connection, secretRoot, authorize: () => authorizeReadback(actor, workId, actionId) })
      if (outcome.kind === 'receipt') return recordReceipt(actor, workId, actionId, outcome.receipt)
      return markUnknown(actor, workId, actionId, outcome.reason)
    },
  }

  async function decide(actor, workId, actionId, kind, body) {
    let result
    await store.update(state => {
      const context = actionContext(state, actor, workId, connectionCatalog)
      const action = requireAction(context.work, actionId)
      assertApprovalRequest(action, body, false)
      if (action.attempt) throw actionError('BUSY', '写入请求已经开始')
      if (action.decision) {
        if (action.decision.kind !== kind) throw actionError('REVISION_CONFLICT', '动作已经决定')
        result = action
        return state
      }
      result = { ...action, decision: decisionFact(kind, context.member.id, action.preview.digest, clock) }
      return replaceAction(state, context.work, result)
    })
    return structuredClone(result)
  }

  async function claim(actor, workId, actionId, deadlineAt) {
    let response
    await store.update(state => {
      let context
      try { context = actionContext(state, actor, workId, connectionCatalog) } catch (error) {
        const work = state.works.find(item => item.id === workId && item.ownerMemberId === actorId(actor))
        const action = work?.actions.find(item => item.id === actionId)
        if (!work || !action || action.attempt || action.decision?.kind !== 'approved' || action.decision.invalidatedAt) throw error
        const invalid = { ...action, decision: { ...action.decision, invalidatedAt: nowIso(clock), invalidationReason: 'PREVIEW_DIGEST_CHANGED' } }
        response = { claimed: false, action: invalid }
        return replaceAction(state, work, invalid)
      }
      const action = requireAction(context.work, actionId)
      if (action.receipt || action.attempt) { response = { claimed: false, action }; return state }
      if (action.decision?.kind !== 'approved' || action.decision.invalidatedAt) {
        response = { claimed: false, action }
        return state
      }
      if (currentDigest(context, action) !== action.preview.digest) {
        const invalid = { ...action, decision: { ...action.decision, invalidatedAt: nowIso(clock), invalidationReason: 'PREVIEW_DIGEST_CHANGED' } }
        response = { claimed: false, action: invalid }
        return replaceAction(state, context.work, invalid)
      }
      assertNoRelatedUnresolved(state, context.member.id, action.intent.targetKey, action.id)
      const now = nowIso(clock)
      try { assertFresh(context.result.payload, now) } catch {
        const invalid = { ...action, decision: { ...action.decision, invalidatedAt: now, invalidationReason: 'SOURCE_FACTS_CHANGED' } }
        response = { claimed: false, action: invalid }
        return replaceAction(state, context.work, invalid)
      }
      if (reached(deadlineAt, now)) {
        const invalid = { ...action, decision: { ...action.decision, invalidatedAt: now, invalidationReason: 'DISPATCH_DEADLINE_EXPIRED' } }
        response = { claimed: false, action: invalid }
        return replaceAction(state, context.work, invalid)
      }
      const claimed = { ...action, attempt: { previewDigest: action.preview.digest, preparedAt: now } }
      response = { claimed: true, action: claimed }
      return replaceAction(state, context.work, claimed)
    })
    return response
  }

  async function invalidate(actor, workId, actionId, reason) {
    let result
    await store.update(state => {
      const work = state.works.find(item => item.id === workId && item.ownerMemberId === actorId(actor))
      if (!work) throw actionError('NOT_FOUND', '工作不存在')
      const action = requireAction(work, actionId)
      if (action.attempt || action.decision?.kind !== 'approved' || action.decision.invalidatedAt) { result = action; return state }
      result = { ...action, decision: { ...action.decision, invalidatedAt: nowIso(clock), invalidationReason: reason } }
      return replaceAction(state, work, result)
    })
    return result
  }

  async function markNoEffect(actor, workId, actionId, reason) {
    return settleAttempt(actor, workId, actionId, current => ({ ...current, noEffectAt: nowIso(clock), noEffectReason: reason }))
  }

  async function markUnknown(actor, workId, actionId, reason) {
    return settleAttempt(actor, workId, actionId, current => current.noEffectAt || current.unknownAt ? current : { ...current, unknownAt: nowIso(clock), unknownReason: reason })
  }

  async function settleAttempt(actor, workId, actionId, update) {
    let result
    await store.update(state => {
      const work = state.works.find(item => item.id === workId && item.ownerMemberId === actorId(actor))
      if (!work) throw actionError('NOT_FOUND', '工作不存在')
      const action = requireAction(work, actionId)
      if (!action.attempt || action.receipt) throw actionError('REVISION_CONFLICT', '动作 attempt 不可结算')
      const attempt = update(action.attempt)
      result = attempt === action.attempt ? action : { ...action, attempt }
      return result === action ? state : replaceAction(state, work, result)
    })
    return structuredClone(result)
  }

  async function recordReceipt(actor, workId, actionId, details) {
    let result
    try {
      await store.update(state => {
        const context = readbackContext(state, actor, workId, actionId, connectionCatalog)
        const work = context.work
        const action = requireAction(work, actionId)
        if (action.receipt) { result = action; return state }
        if (!action.attempt || action.attempt.noEffectAt) throw actionError('REVISION_CONFLICT', '动作不能记录回执')
        const receipt = { previewDigest: action.preview.digest, ...details, recordedAt: nowIso(clock) }
        assertRepairReceipt(receipt, action)
        result = { ...action, receipt }
        return replaceAction(state, work, result)
      })
    } catch (error) {
      await markUnknown(actor, workId, actionId, 'RECEIPT_PERSIST_FAILED').catch(() => undefined)
      throw error
    }
    return structuredClone(result)
  }

  async function currentAction(actor, workId, actionId) {
    const context = actionContext(await store.read(), actor, workId, connectionCatalog)
    return requireAction(context.work, actionId)
  }

  async function authorizeReadback(actor, workId, actionId, writing = false) {
    const state = await store.read()
    const context = writing ? actionContext(state, actor, workId, connectionCatalog) : readbackContext(state, actor, workId, actionId, connectionCatalog)
    requireActionCapability(context)
    const action = requireAction(context.work, actionId)
    if (writing) {
      if (!isDeepStrictEqual(previewTarget(context), action.preview.target) || action.attempt?.unknownAt || currentDigest(context, action) !== action.preview.digest) throw actionError('FORBIDDEN', '原批准已失效或写入效果待核对')
    }
    if (action.decision?.kind !== 'approved' || action.decision.invalidatedAt && (writing || !action.attempt) || action.attempt?.noEffectAt
      || (!action.attempt && currentDigest(context, action) !== action.preview.digest)) throw actionError('FORBIDDEN', '动作批准已失效')
  }
}

function actionContext(state, actor, workId, connectionCatalog) {
  const authorized = authorizeWorkBinding(state, actor, workId, connectionCatalog)
  if (getCapability(authorized.work.capabilityId)?.retired) return authorized
  if (authorized.work.capabilityId !== KIVO_TPM_DEVICE_CORRELATION_CAPABILITY) throw actionError('FORBIDDEN', '该工作不支持维修创建')
  const result = [...authorized.work.results].reverse().find(item => item.kind === RESULT_KIND)
  if (!result) throw actionError('REVISION_CONFLICT', '工作没有可用的关联结果')
  assertTpmDeviceCorrelation(result.payload, result.input)
  return { ...authorized, result }
}

function requireActionCapability(context) {
  if (getCapability(context.work.capabilityId)?.retired) throw actionError('CAPABILITY_RETIRED', '旧来源已停止新执行，可查看历史记录')
}

function previewTarget(context, readback = false) {
  const c = context.binding.connection, p = context.result.payload
  if (c.dataMode !== 'synthetic') throw actionError('FORBIDDEN', '维修创建仅限已授权的 synthetic 连接')
  if (p.binding.resource !== c.baseUrl || p.binding.sourceInstance !== c.sourceInstance || p.binding.connectionId !== c.id || (!readback && p.binding.connectionRevision !== c.revision)
    || p.binding.clientId !== c.clientId || p.source.sourceEnvironment !== c.sourceEnvironment || p.source.dataMode !== c.dataMode) throw actionError('REVISION_CONFLICT', '结果连接身份已经变化')
  return repairTargetFromCorrelation(p)
}

function previewDigest(context, preview) {
  return sha256(canonicalJson({
    version: PREVIEW_VERSION,
    proposal: proposalFacts(context, preview),
    payload: preview.payload, createdAt: preview.createdAt, expiresAt: preview.expiresAt,
  }))
}

function stableProposalKey(context, preview) {
  return `proposal-${sha256(canonicalJson({ version: PROPOSAL_VERSION, ...proposalFacts(context, preview) }))}`
}

function proposalFacts(context, preview) {
  return {
    work: { id: context.work.id, resultId: context.result.id },
    intent: { kind: ACTION_KIND, targetKey: repairIntentKey(context.member.id, preview.target) },
    target: preview.target, payload: without(preview.payload, ['orderNo', 'deviceId']), expectedRevision: preview.expectedRevision,
    source: businessProjection(context.result.payload), permission: permissionSnapshot(context),
  }
}

function currentDigest(context, action) {
  if (context.result.id !== action.preview.resultId) return ''
  return previewDigest(context, action.preview)
}

function businessProjection(payload) { return correlationBusinessFacts(payload) }

function permissionSnapshot(context) {
  return { owner: { id: context.member.id, sessionVersion: context.member.sessionVersion }, employeeId: context.work.employeeId,
    skillId: context.work.skillId, capabilityId: context.work.capabilityId, connection: connectionSnapshot(context.binding.connection) }
}

function assertFresh(payload, now) {
  if (!correlationAssessment(payload, now).actionEligible) throw actionError('REVISION_CONFLICT', '当前关联来源或采样不满足维修创建条件')
}

function assertNoRelatedUnresolved(state, memberId, key, exceptId) {
  if (state.works.some(work => work.ownerMemberId === memberId && work.actions.some(action => action.id !== exceptId && action.intent.kind === ACTION_KIND
    && repairIntentKey(memberId, action.preview.target) === key && action.attempt && !action.receipt && !action.attempt.noEffectAt))) throw actionError('BUSY', '同一单据与设备的创建结果待核对，请先核对原动作')
}

function assertApprovalRequest(action, body, requireExpected = true) {
  if (action.intent.kind === ACTION_KIND) {
    assertRequestFields(body, ['expectedRevision', 'previewDigest', 'clientRequestId'])
    if (typeof body.clientRequestId !== 'string') throw actionError('INVALID_REQUEST', 'clientRequestId 无效')
    requestId(body.clientRequestId)
  }
  if (body.previewDigest !== action.preview.digest) throw actionError('REVISION_CONFLICT', 'preview digest 不匹配')
  if (requireExpected && body.expectedRevision !== action.preview.expectedRevision) throw actionError('REVISION_CONFLICT', 'expected revision 不匹配')
}
function assertRequestFields(value, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw actionError('INVALID_REQUEST', '维修动作请求字段无效') }

function readbackContext(state, actor, workId, actionId, connectionCatalog) {
  const authorized = authorizeWorkBinding(state, actor, workId, connectionCatalog)
  if (getCapability(authorized.work.capabilityId)?.retired) return authorized
  const action = requireAction(authorized.work, actionId)
  const result = authorized.work.results.find(item => item.id === action.preview.resultId && item.kind === RESULT_KIND)
  if (!result || authorized.work.capabilityId !== KIVO_TPM_DEVICE_CORRELATION_CAPABILITY) throw actionError('FORBIDDEN', '原动作依据不可用')
  const context = { ...authorized, result }
  assertTpmDeviceCorrelation(result.payload, result.input)
  if (action.intent.kind !== ACTION_KIND || !isDeepStrictEqual(action.preview.target, previewTarget(context, true))
    || action.intent.targetKey !== repairIntentKey(context.member.id, action.preview.target)) throw actionError('FORBIDDEN', '原动作的实例、机器账号或绑定已变化，不能代认')
  return context
}

function requireReadbackAttempt(context, actionId) {
  const action = requireAction(context.work, actionId)
  if (!action.attempt || action.receipt || action.attempt.noEffectAt) throw actionError('REVISION_CONFLICT', '动作没有待核对写入')
  return action
}

function requireAction(work, actionId) {
  const action = work.actions.find(item => item.id === actionId)
  if (!action) throw actionError('NOT_FOUND', '动作不存在')
  return action
}

function replaceAction(state, work, action) {
  return replaceWork(state, { ...work, actions: work.actions.map(item => item.id === action.id ? action : item) })
}
function replaceWork(state, work) { return { ...state, works: state.works.map(item => item.id === work.id ? work : item) } }
function decisionFact(kind, memberId, digest, clock) { return { kind, memberId, previewDigest: digest, decidedAt: nowIso(clock) } }
function actorId(actor) { return actor?.id ?? actor?.memberId }
function requestId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : value === undefined ? 'same-request' : (() => { throw actionError('INVALID_REQUEST', 'clientRequestId 无效') })() }
function commentBody(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || Buffer.byteLength(value) > 2_000 || BODY_BLOCKED.test(value)) throw actionError('INVALID_INPUT', '备注必须是最多 2000 UTF-8 bytes 的安全纯文本')
  return value
}
function without(value, keys) { return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key))) }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function nowIso(clock) { const date = new Date(clock()); if (!Number.isFinite(date.getTime())) throw actionError('INVALID_REQUEST', '服务时间无效'); return date.toISOString() }
function reached(deadline, now) { return Date.parse(now) >= Date.parse(deadline) }
function actionError(code, message) { return Object.assign(new Error(message), { code }) }
