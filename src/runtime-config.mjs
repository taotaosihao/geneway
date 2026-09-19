import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const ZENMUX_PROVIDER = 'zenmux'
const ZENMUX_MODEL = 'deepseek/deepseek-v4-pro'
const ZENMUX_BASE_URL = 'https://zenmux.ai/api/v1'

export function readRuntimeConfig(env = process.env, root = process.cwd()) {
  const settings = readSettings(env)
  const settingsEnv = settings?.env && typeof settings.env === 'object' ? settings.env : {}
  const baseUrl = nonEmpty(env.GENEWAY_GEARJOB_BASE_URL)
  const credentialFile = nonEmpty(env.GENEWAY_GEARJOB_CREDENTIAL_FILE)
  const allowedWorkOrders = splitList(env.GENEWAY_GEARJOB_ALLOWED_WORK_ORDER)
  const dshHome = resolve(root, nonEmpty(env.GENEWAY_DSH_HOME) ?? 'var/dsh')
  const model = ZENMUX_MODEL
  const zenmuxBaseUrl = ZENMUX_BASE_URL
  const provider = ZENMUX_PROVIDER

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
  if (baseUrl && !credentialFile) sourceError ??= '已配置 GearJob 地址但缺少 GENEWAY_GEARJOB_CREDENTIAL_FILE'
  if (baseUrl && allowedWorkOrders.length === 0) sourceError ??= '已配置 GearJob 地址但缺少 GENEWAY_GEARJOB_ALLOWED_WORK_ORDER'

  return {
    root,
    source: {
      baseUrl,
      credentialFile,
      allowedWorkOrders,
      hostHeader: nonEmpty(env.GENEWAY_GEARJOB_HOST_HEADER),
      configured: Boolean(baseUrl && credentialFile && allowedWorkOrders.length && !sourceError),
      error: sourceError,
    },
    model: {
      provider,
      model,
      baseUrl: zenmuxBaseUrl,
      credentialEnv: 'ZENMUX_API_KEY',
      configured: Boolean(nonEmpty(settingsEnv.ANTHROPIC_AUTH_TOKEN)),
    },
    dshHome,
  }
}

export function readSettings(env = process.env) {
  const settingsPath = nonEmpty(env.GENEWAY_ZENMUX_SETTINGS_FILE) ?? join(env.HOME ?? dirname(process.cwd()), '.claude', 'settings.json')
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return undefined
  }
}

export async function validateRuntimeConfig(config) {
  if (!config?.source?.configured) return config
  await access(config.source.credentialFile, constants.R_OK)
  const metadata = await stat(config.source.credentialFile)
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('GearJob credential file permissions must be 0600')
  }
  return config
}

export function splitList(value) {
  return String(value ?? '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
