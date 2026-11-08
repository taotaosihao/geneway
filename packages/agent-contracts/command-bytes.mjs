import { canonical, error, exact } from './index.mjs'

export const BRIDGE_LIMIT = 256 * 1024
export const COMMAND_FETCH_LIMIT = 4 * 1024 * 1024
export const RESULT_PAYLOAD_LIMIT = 256 * 1024
export const jsonBytes = value => Buffer.byteLength(JSON.stringify(value))
export function assertCommandBytes(command) {
  if (jsonBytes(command) > COMMAND_FETCH_LIMIT) throw error('COMMAND_TOO_LARGE', '命令内容过大，请缩小本次输入或等待范围。')
  return command
}
export function assertResultBytes(payload) {
  if (jsonBytes(canonical(payload)) > RESULT_PAYLOAD_LIMIT) throw error('COMMAND_TOO_LARGE', '回报内容过大，请缩小本次回报范围。')
  return payload
}
export function commandReference(command) { return { kind: 'command_ref', commandId: command.command_id, payloadDigest: command.payload_digest } }
export function commandUnavailable(command) { return { kind: 'command_unavailable', commandId: command.command_id, payloadDigest: command.payload_digest, code: 'COMMAND_TOO_LARGE' } }
export function assertCommandReference(value) {
  exact(value, ['kind', 'commandId', 'payloadDigest'])
  if (value.kind !== 'command_ref' || !/^[a-f0-9]{32}$/.test(value.commandId) || !/^[a-f0-9]{64}$/.test(value.payloadDigest)) throw error('INVALID_RESPONSE', '命令引用无效')
  return value
}
