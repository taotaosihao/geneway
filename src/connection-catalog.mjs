import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export const CONNECTION_TARGET_FIELDS = Object.freeze([
  'kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'hostHeader', 'credentialRef', 'sourceSystem',
  'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode',
])
export const CONNECTION_IDENTITY_FIELDS = Object.freeze(CONNECTION_TARGET_FIELDS.filter(key => key !== 'credentialRef'))

export async function readConnectionCatalog(filePath, repoRoot) {
  if (!filePath || !isAbsolute(filePath)) throw new Error('必须配置仓库外绝对路径 GENEWAY_CONNECTION_CATALOG')
  const [catalogPath, rootPath] = await Promise.all([realpath(filePath), realpath(repoRoot)])
  const path = relative(rootPath, catalogPath)
  if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) throw new Error('GENEWAY_CONNECTION_CATALOG 必须位于仓库外')
  const file = await open(catalogPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new Error('连接目标目录必须是常规 0600 文件')
    return parseCatalog(JSON.parse(await file.readFile('utf8')))
  } finally {
    await file.close()
  }
}

export function assertTrustedConnection(catalog, connection) {
  let candidate
  try { candidate = targetTuple(connection) } catch { throw forbiddenTarget() }
  const match = catalog?.find(item => CONNECTION_TARGET_FIELDS.every(key => item[key] === candidate[key]))
  if (!match) throw forbiddenTarget()
  return match
}

function parseCatalog(value) {
  if (value?.version !== 1 || !Array.isArray(value.targets)) throw new Error('连接目标目录格式无效')
  const targets = value.targets.map(targetTuple)
  const credentialTargets = new Map()
  for (const target of targets) {
    const encoded = JSON.stringify(target)
    const existing = credentialTargets.get(target.credentialRef)
    if (existing && existing !== encoded) throw new Error('同一 credentialRef 不得绑定多个连接目标')
    credentialTargets.set(target.credentialRef, encoded)
  }
  return Object.freeze(targets)
}

function targetTuple(value) {
  const result = {
    kind: value?.kind,
    targetIdentity: text(value?.targetIdentity),
    baseUrl: canonicalBaseUrl(value?.baseUrl),
    ...(value?.kind === 'kivo-mcp' ? { issuer: text(value.issuer), clientId: text(value.clientId) } : {}),
    hostHeader: text(value?.hostHeader),
    credentialRef: text(value?.credentialRef),
    sourceSystem: text(value?.sourceSystem),
    sourceInstance: text(value?.sourceInstance),
    sourceEnvironment: text(value?.sourceEnvironment),
    dataMode: text(value?.dataMode),
    evidenceMode: text(value?.evidenceMode),
  }
  if (!['gearjob-rest', 'hive-tenant-records', 'kivo-mcp'].includes(result.kind) || !result.targetIdentity || !result.baseUrl || !simpleRef(result.credentialRef)
    || ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].some(key => !result[key])) throw new Error('连接目标目录条目无效')
  if (result.kind === 'hive-tenant-records' && !uuid(result.targetIdentity)) throw new Error('Hive 连接 targetIdentity 必须是 tenant UUID')
  if (result.kind === 'kivo-mcp') {
    const resource = new URL(result.baseUrl)
    if (text(value.baseUrl) !== result.baseUrl || resource.pathname !== '/api/v1/mes/mcp' || result.issuer !== resource.origin || !uuid(result.clientId)) throw new Error('Kivo 连接 resource、issuer 或 clientId 无效')
  } else if (value.issuer !== undefined || value.clientId !== undefined) throw new Error('旧连接不得包含 Kivo 机器账号字段')
  return Object.freeze(result)
}

function canonicalBaseUrl(value) {
  try {
    const url = new URL(text(value))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined
    return url.pathname === '/' ? url.origin : url.href.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function simpleRef(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..' }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function forbiddenTarget() { return Object.assign(new Error('连接目标未在主机可信目录登记'), { code: 'FORBIDDEN' }) }
