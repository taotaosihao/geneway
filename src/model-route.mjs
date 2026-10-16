import { isDeepStrictEqual } from 'node:util'

export const MODEL_IDS = Object.freeze(['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'])
export const MODEL_PROVIDER = 'zenmux'
export const MODEL_API = 'openai-completions'
export const MODEL_BASE_URL = 'https://zenmux.ai/api/v1'
export const MODEL_CREDENTIAL_ENV = 'ZENMUX_API_KEY'

export function modelRouteSnapshot(route) {
  const parameters = route?.parameters === undefined ? {} : route.parameters
  if (!route || typeof route.id !== 'string' || !route.id.trim() || route.enabled !== true || route.provider !== MODEL_PROVIDER || !MODEL_IDS.includes(route.model)
    || (route.credentialRef ?? MODEL_CREDENTIAL_ENV) !== MODEL_CREDENTIAL_ENV || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    || Object.keys(parameters).some(key => key !== 'maxOutputTokens')) throw routeError()
  const maxOutputTokens = parameters.maxOutputTokens ?? 4096
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096) throw routeError()
  return Object.freeze({ modelRouteId: route.id, provider: MODEL_PROVIDER, model: route.model,
    api: MODEL_API, baseUrl: MODEL_BASE_URL, credentialRef: MODEL_CREDENTIAL_ENV,
    parameters: Object.freeze({ maxOutputTokens }) })
}

export function validateModelSnapshot(snapshot) {
  if (!snapshot || !isDeepStrictEqual(modelRouteSnapshot({ id: snapshot.modelRouteId, provider: snapshot.provider, model: snapshot.model, credentialRef: snapshot.credentialRef, parameters: snapshot.parameters, enabled: true }), snapshot)) throw routeError()
  return snapshot
}

export function employeeModelRoute(state, employee) {
  return modelRouteSnapshot(state.modelRoutes.find(route => route.id === employee?.modelRouteId))
}

export function assertModelRoute(state, employee, snapshot) {
  if (!isDeepStrictEqual(employeeModelRoute(state, employee), snapshot)) throw routeError()
}

export function modelAgentOptions(snapshot) {
  return { provider: snapshot.provider, model: snapshot.model, maxTokens: snapshot.parameters.maxOutputTokens }
}

function routeError() { return Object.assign(new Error('模型路由不可用'), { code: 'MODEL_NOT_CONFIGURED' }) }
