import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveCredentialFile } from './execution-grant.mjs'

import { MODEL_IDS, MODEL_PROVIDER as ZENMUX_PROVIDER, MODEL_BASE_URL as ZENMUX_BASE_URL } from './model-route.mjs'
export { modelRouteSnapshot, employeeModelRoute, assertModelRoute, modelAgentOptions } from './model-route.mjs'
const ZENMUX_MODEL = MODEL_IDS[0]

export function readRuntimeConfig(env = process.env, root = process.cwd()) {
  const baseUrl = nonEmpty(env.GENEWAY_GEARJOB_BASE_URL)
  const credentialFile = nonEmpty(env.GENEWAY_GEARJOB_CREDENTIAL_FILE)
  const explicitSecretRoot = nonEmpty(env.GENEWAY_SECRET_ROOT)
  const secretRoot = resolve(explicitSecretRoot ?? (credentialFile ? dirname(credentialFile) : join(root, 'var', 'secrets')))
  const credentialRef = nonEmpty(env.GENEWAY_GEARJOB_CREDENTIAL_REF) ?? (credentialFile ? basename(credentialFile) : undefined)
  const allowedWorkOrders = splitList(env.GENEWAY_GEARJOB_ALLOWED_WORK_ORDER)
  const dshHome = resolve(root, nonEmpty(env.GENEWAY_DSH_HOME) ?? 'var/dsh')
  const stateFile = resolve(nonEmpty(env.GENEWAY_STATE) ?? join(root, 'var', 'state.json'))
  const connectionCatalogFile = nonEmpty(env.GENEWAY_CONNECTION_CATALOG)
  const dataRoot = dirname(stateFile)
  const model = ZENMUX_MODEL
  const zenmuxBaseUrl = ZENMUX_BASE_URL
  const provider = ZENMUX_PROVIDER
  const modelCredentialRef = nonEmpty(env.GENEWAY_MODEL_CREDENTIAL_REF)
  const hostHeader = nonEmpty(env.GENEWAY_GEARJOB_HOST_HEADER)
  const targetIdentity = nonEmpty(env.GENEWAY_GEARJOB_TARGET_IDENTITY) ?? safeHost(baseUrl)

  let sourceError
  if (baseUrl) {
    try {
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        sourceError = 'GENEWAY_GEARJOB_BASE_URL 必须是无凭据、无查询参数的 HTTP(S) 地址'
      }
    } catch {
      sourceError = 'GENEWAY_GEARJOB_BASE_URL 不是有效 HTTP(S) 地址'
    }
  }
  if (credentialFile && !isAbsolute(credentialFile)) sourceError ??= 'GENEWAY_GEARJOB_CREDENTIAL_FILE 必须是绝对路径'
  if (credentialFile && explicitSecretRoot && !within(secretRoot, resolve(credentialFile))) sourceError ??= 'GENEWAY_GEARJOB_CREDENTIAL_FILE 必须位于 GENEWAY_SECRET_ROOT 内'
  if (baseUrl && !credentialFile) sourceError ??= '已配置 GearJob 地址但缺少 GENEWAY_GEARJOB_CREDENTIAL_FILE'
  if (baseUrl && allowedWorkOrders.length === 0) sourceError ??= '已配置 GearJob 地址但缺少 GENEWAY_GEARJOB_ALLOWED_WORK_ORDER'

  return {
    root,
    source: {
      baseUrl,
      credentialFile,
      credentialRef,
      secretRoot,
      allowedWorkOrders,
      allowedObjectIds: allowedWorkOrders,
      hostHeader,
      targetIdentity,
      kind: 'gearjob-rest',
      revision: 1,
      sourceSystem: 'GearJob',
      sourceInstance: targetIdentity,
      sourceEnvironment: 'external-test',
      dataMode: 'synthetic',
      evidenceMode: 'real-frappe-rest',
      configured: Boolean(baseUrl && credentialFile && allowedWorkOrders.length && !sourceError),
      error: sourceError,
    },
    model: {
      provider,
      model,
      baseUrl: zenmuxBaseUrl,
      credentialEnv: 'ZENMUX_API_KEY',
      credentialRef: modelCredentialRef,
      secretRoot,
      configured: Boolean(modelCredentialRef),
    },
    dshHome,
    stateFile,
    dataRoot,
    secretRoot,
    connectionCatalogFile,
  }
}

export async function readModelCredential(config = readRuntimeConfig()) {
  try {
    const filePath = await resolveCredentialFile(config.model.secretRoot ?? config.secretRoot, config.model.credentialRef)
    const key = (await readFile(filePath, 'utf8')).trim()
    if (!key || /\s/.test(key)) throw new Error('invalid-key')
    return key
  } catch {
    throw Object.assign(new Error('模型凭据不可用，请配置 Geneway 服务端秘密引用'), { code: 'MODEL_NOT_CONFIGURED' })
  }
}

export function assertDshHome(dshHome, env = process.env) {
  const home = nonEmpty(env.DSH_HOME)
  if (!home || !isAbsolute(home) || resolve(home) !== resolve(dshHome)) {
    throw Object.assign(new Error('DSH_HOME 必须与当前 Geneway 运行目录一致'), { code: 'RUNTIME_HOME_MISMATCH' })
  }
}

export async function validateRuntimeConfig(config) {
  if (config?.source?.configured) await resolveCredentialFile(config.source.secretRoot, config.source.credentialRef)
  if (config?.model?.configured) await readModelCredential(config)
  return config
}

export function splitList(value) {
  return String(value ?? '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function within(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function safeHost(value) {
  try { return new URL(value).host } catch { return undefined }
}
