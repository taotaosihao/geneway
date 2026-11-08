import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { error, exact } from '../packages/agent-contracts/index.mjs'

const location = new URL('../templates/incident-register-v1.xlsx', import.meta.url)
export const INCIDENT_TEMPLATE = Object.freeze(JSON.parse(readFileSync(new URL('../templates/incident-register-v1.json', import.meta.url), 'utf8')))
export const COLLABORATION_TEMPLATE = Object.freeze(JSON.parse(readFileSync(new URL('../templates/incident-collaboration-v1.json', import.meta.url), 'utf8')))
export const templateReference = () => ({ id: INCIDENT_TEMPLATE.id, version: INCIDENT_TEMPLATE.version, sha256: INCIDENT_TEMPLATE.sha256 })
export const collaborationTemplateReference = () => ({ id: COLLABORATION_TEMPLATE.id, version: COLLABORATION_TEMPLATE.version, sha256: COLLABORATION_TEMPLATE.sha256 })
export const isCollaborationSpreadsheet = request => request?.templateId === COLLABORATION_TEMPLATE.id
export const validCalendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
export function spreadsheetRequest(value) {
  exact(value, ['templateId', 'dueDate'])
  const template = [INCIDENT_TEMPLATE, COLLABORATION_TEMPLATE].find(row => row.id === value.templateId)
  if (!template || value.dueDate !== null && !validCalendarDate(value.dueDate)) throw error('INVALID_REQUEST', '整改表模板或期限无效')
  return { templateId: template.id, templateVersion: template.version, templateSha256: template.sha256, calculationVersion: template.calculationVersion, dueDate: value.dueDate }
}
export function assertSpreadsheetRequest(value) {
  if (!value) return
  exact(value, ['templateId', 'templateVersion', 'templateSha256', 'calculationVersion', 'dueDate'])
  const expected = spreadsheetRequest({ templateId: value.templateId, dueDate: value.dueDate })
  if (Object.keys(expected).some(field => expected[field] !== value[field])) throw error('INVALID_STATE', '整改表要求快照无效')
}
export async function readIncidentTemplate() {
  const bytes = await readFile(location)
  if (createHash('sha256').update(bytes).digest('hex') !== INCIDENT_TEMPLATE.sha256) throw error('INVALID_STATE', '受控模板字节已变化')
  return { bytes, path: fileURLToPath(location), reference: templateReference() }
}
export async function readCollaborationTemplate() {
  const bytes = await readFile(new URL('../templates/incident-collaboration-v1.xlsx', import.meta.url))
  if (createHash('sha256').update(bytes).digest('hex') !== COLLABORATION_TEMPLATE.sha256) throw error('INVALID_STATE', '受控模板字节已变化')
  return { bytes, reference: collaborationTemplateReference() }
}
