import { createArtifactFiles } from './artifact-files.mjs'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import sharp from 'sharp'
import { attachmentRefs, digest, error, exact, key } from '../packages/agent-contracts/index.mjs'

export const ATTACHMENT_LIMITS = Object.freeze({ maxBytes: 10 * 1024 * 1024, historyBytes: 64 * 1024, maxPixels: 20_000_000, maxDimension: 8192, uploadTimeoutMs: 30_000 })
const TYPES = new Map([['image/png', '.png'], ['image/jpeg', '.jpg'], ['application/json', '.json']])
const check = (value, message) => { if (!value) throw error('INVALID_STATE', `附件状态无效：${message}`) }
const idPattern = /^attachment-[a-f0-9-]{36}$/
const declaration = row => Object.fromEntries(['clientRequestId', 'name', 'mediaType', 'sizeBytes', 'sha256'].map(field => [field, row[field]]))
function validateDeclaration(value) {
  exact(value, ['clientRequestId', 'name', 'mediaType', 'sizeBytes', 'sha256'])
  if (typeof value.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.clientRequestId)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\x00-\x1f\x7f/\\]/.test(value.name)
    || !TYPES.has(value.mediaType) || !value.name.toLowerCase().endsWith(TYPES.get(value.mediaType)) && !(value.mediaType === 'image/jpeg' && value.name.toLowerCase().endsWith('.jpeg'))
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0 || value.sizeBytes > (value.mediaType === 'application/json' ? ATTACHMENT_LIMITS.historyBytes : ATTACHMENT_LIMITS.maxBytes)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw error('INVALID_REQUEST', '附件声明无效或格式尚未支持')
  return value
}
export function validateAttachments(state) {
  check(Array.isArray(state.attachments) && state.attachments.length <= 10_000, '文件域')
  check(new Set(state.attachments.map(row => row.id)).size === state.attachments.length, 'ID重复')
  check(new Set(state.attachments.map(row => key(row.workspaceId, row.ownerMemberId, row.clientRequestId))).size === state.attachments.length, '命令重复')
  for (const row of state.attachments) {
    exact(row, ['id', 'workspaceId', 'ownerMemberId', 'clientRequestId', 'name', 'mediaType', 'sizeBytes', 'sha256', 'declarationDigest', 'version', 'status', 'initializedAt', 'readyAt', 'workId'])
    validateDeclaration(declaration(row))
    check(idPattern.test(row.id) && typeof row.workspaceId === 'string' && row.workspaceId.length > 0 && state.members.some(member => member.id === row.ownerMemberId), '归属')
    check(row.declarationDigest === digest(declaration(row)) && row.version === 1 && ['pending', 'ready'].includes(row.status), '声明/版本')
    check(Number.isFinite(Date.parse(row.initializedAt)) && (row.status === 'pending' ? row.readyAt === null : Number.isFinite(Date.parse(row.readyAt))), '就绪事实')
    const work = state.works.find(work => work.id === row.workId)
    check(row.workId === null || row.status === 'ready' && work?.workType === 'multisite' && work.workspaceId === row.workspaceId && work.ownerMemberId === row.ownerMemberId, '工作归属')
  }
  return state
}
export function assertAttachmentsImmutable(before, after) {
  for (const row of before.attachments) {
    const current = after.attachments.find(item => item.id === row.id)
    check(current && isDeepStrictEqual({ ...row, status: undefined, readyAt: undefined, workId: undefined }, { ...current, status: undefined, readyAt: undefined, workId: undefined }), '声明不可改写')
    if (row.status === 'ready') check(current.status === 'ready' && current.readyAt === row.readyAt, '就绪不可改写')
    if (row.workId) check(current.workId === row.workId, '工作绑定不可改写')
  }
}
export function attachmentReference(row) { return { attachmentId: row.id, version: row.version, sha256: row.sha256 } }
export function attachmentForRef(state, ref) {
  attachmentRefs([ref])
  const row = state.attachments.find(row => row.id === ref.attachmentId)
  if (!row || row.status !== 'ready' || row.version !== ref.version || row.sha256 !== ref.sha256) throw error('INVALID_STATE', '附件尚未就绪或版本不匹配')
  return row
}
function member(state, actor) {
  const user = state.members.find(member => member.id === actor?.id && member.enabled)
  if (!user) throw error('UNAUTHORIZED', '会话无效')
  return user
}
function authorize(state, actor, workspaceId, id) {
  const user = member(state, actor), row = state.attachments.find(row => row.id === id && row.workspaceId === workspaceId && row.ownerMemberId === user.id)
  if (!row) throw error('NOT_FOUND', '附件不存在')
  if (row.workId) authorizeWork(state, user, state.works.find(work => work.id === row.workId))
  return row
}
function authorizeWork(state, user, work) {
  const ids = [work?.employeeId, ...state.multisite.attempts.filter(attempt => attempt.work_id === work?.id).map(attempt => attempt.agent_id)]
  if (ids.some(id => !user.employeeIds.includes(id) || !state.employees.some(employee => employee.id === id && employee.enabled))) throw error('FORBIDDEN', '附件工作授权已撤销')
}

export function createArtifactService({ store, root, workspaceId = 'local', clock = () => new Date().toISOString(), uploadTimeoutMs = ATTACHMENT_LIMITS.uploadTimeoutMs, fsOps = {} }) {
  if (!store || !root) throw new Error('附件服务需要独立存储根与产品存储')
  const files = createArtifactFiles({ root, fsOps, maxBytes: ATTACHMENT_LIMITS.maxBytes, uploadTimeoutMs, validate: validateBytes }), pending = new Map()
  async function withObject(id, operation) {
    const previous = pending.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    pending.set(id, result)
    try { return await result } finally { if (pending.get(id) === result) pending.delete(id) }
  }
  return {
    workspaceId,
    async init(actor, parameters) {
      const value = validateDeclaration(parameters)
      let result
      await store.update(state => {
        const user = member(state, actor)
        const existing = state.attachments.find(row => row.workspaceId === workspaceId && row.ownerMemberId === user.id && row.clientRequestId === value.clientRequestId)
        if (existing) {
          authorize(state, actor, workspaceId, existing.id)
          if (existing.declarationDigest !== digest(value)) throw error('IDEMPOTENCY_CONFLICT', '附件命令 ID 已被其他声明使用')
          result = existing
        } else {
          result = { id: `attachment-${randomUUID()}`, workspaceId, ownerMemberId: user.id, ...structuredClone(value), declarationDigest: digest(value), version: 1, status: 'pending', initializedAt: clock(), readyAt: null, workId: null }
          state.attachments.push(result)
        }
        return state
      })
      return metadata(result)
    },
    async get(actor, id) { return metadata(authorize(await store.read(), actor, workspaceId, id)) },
    async download(actor, id) {
      const row = authorize(await store.read(), actor, workspaceId, id)
      if (row.status !== 'ready') throw error('INVALID_STATE', '附件尚未就绪')
      const bytes = await files.read(row, { sync: true })
      authorize(await store.read(), actor, workspaceId, id)
      return { metadata: metadata(row), bytes }
    },
    async upload(actor, id, source) {
      return withObject(id, async () => {
        const row = authorize(await store.read(), actor, workspaceId, id)
        await files.write(row, source)
          await store.update(state => {
            const current = authorize(state, actor, workspaceId, id)
            if (current.declarationDigest !== row.declarationDigest) throw error('IDEMPOTENCY_CONFLICT')
            current.status = 'ready'; current.readyAt ??= clock()
            return state
          })
          return metadata(authorize(await store.read(), actor, workspaceId, id))

      })
    },
    bind(state, actor, refs, work) {
      attachmentRefs(refs)
      authorizeWork(state, member(state, actor), work)
      for (const ref of refs) {
        const row = attachmentForRef(state, ref)
        authorize(state, actor, workspaceId, row.id)
        if (work.workspaceId !== workspaceId || work.ownerMemberId !== actor.id || row.workId && row.workId !== work.id) throw error('FORBIDDEN', '附件不属于当前工作')
        row.workId = work.id
      }
    },
    async verifyReferences(state, refs) {
      for (const ref of attachmentRefs(refs)) await files.read(attachmentForRef(state, ref), { sync: true })
    },
  }
}
function metadata(row) {
  return { id: row.id, name: row.name, mediaType: row.mediaType, sizeBytes: row.sizeBytes, status: row.status, initializedAt: row.initializedAt, readyAt: row.readyAt, ref: attachmentReference(row), workId: row.workId }
}
async function validateBytes(bytes, mediaType) {
  if (mediaType === 'application/json') {
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      exact(value, ['format', 'version', 'entries'])
      if (value.format !== 'geneway.incident-history' || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 200) throw new Error('format')
      for (const entry of value.entries) {
        exact(entry, ['date', 'description', 'owner'])
        if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isFinite(Date.parse(entry.date)) || new Date(entry.date).toISOString().slice(0, 10) !== entry.date || typeof entry.description !== 'string' || !entry.description.trim() || entry.description.length > 2000 || typeof entry.owner !== 'string' || !entry.owner.trim() || entry.owner.length > 200) throw new Error('entry')
      }
    } catch { throw error('INVALID_REQUEST', '历史文件必须为受支持的异常记录 JSON') }
    return
  }
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: ATTACHMENT_LIMITS.maxPixels, animated: false })
    const info = await image.metadata()
    if (info.format !== (mediaType === 'image/png' ? 'png' : 'jpeg') || !info.width || !info.height || info.width > ATTACHMENT_LIMITS.maxDimension || info.height > ATTACHMENT_LIMITS.maxDimension || (info.pages ?? 1) !== 1) throw new Error('format/dimensions')
    await image.raw().toBuffer()
  } catch { throw error('INVALID_REQUEST', '图片无法解码、类型不匹配或尺寸超限') }
}
