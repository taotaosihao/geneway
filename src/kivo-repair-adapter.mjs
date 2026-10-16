import { createKivoRepair, readKivoRepair } from '../plugins/kivo-tpm.mjs'
import { repairPayload, repairReadback } from './domain/kivo-repair.mjs'

export function createKivoRepairAdapter({ createRepair = createKivoRepair, readRepair = readKivoRepair, clock = () => new Date().toISOString() } = {}) {
  return {
    async dispatch({ action, connection, secretRoot, deadlineAt, claimAttempt, authorize, authorizeReadback = authorize }) {
      repairPayload(action.preview.payload)
      let claim, sent = false
      try {
        const created = await createRepair({
          input: action.preview.payload, connection, secretRoot, traceId: action.id, deadlineAt, clock,
          authorize,
          beforeWrite: async () => {
            claim = await claimAttempt()
            if (!claim.claimed) throw Object.assign(new Error('动作不可派发'), { code: 'FORBIDDEN' })
          },
          onWriteStarted: () => { sent = true },
        })
        // The POST reply alone is insufficient: close with a separate authorized read.
        const original = repairReadback(created, action)
        const readback = await readRepair({ connection, secretRoot, orderNo: action.preview.payload.orderNo, traceId: action.id, authorize: authorizeReadback })
        const receipt = repairReadback(readback, action)
        if (receipt.upstreamRecordId !== original.upstreamRecordId) return { kind: 'unknown', reason: 'READBACK_MISMATCH' }
        return { kind: 'receipt', receipt: { ...receipt, replayed: original.replayed } }
      } catch (error) {
        if (!claim?.claimed) {
          if (claim) return { kind: 'not-claimed', action: claim.action }
          throw error
        }
        if (!sent || ['ACTION_CONFLICT', 'INVALID_REQUEST'].includes(error.code)) return { kind: 'no-effect', reason: error.code === 'DISPATCH_DEADLINE_EXPIRED' ? 'DISPATCH_DEADLINE_EXPIRED' : error.code === 'ACTION_CONFLICT' ? 'ACTION_ID_CONFLICT' : error.code === 'FORBIDDEN' ? 'OWNER_REVOKED' : 'INVALID_REQUEST' }
        return { kind: 'unknown', reason: unknownReason(error) }
      }
    },

    async reconcile({ action, connection, secretRoot, authorize }) {
      try {
        const result = await readRepair({ connection, secretRoot, orderNo: action.preview.payload.orderNo, traceId: action.id, authorize })
        return { kind: 'receipt', receipt: repairReadback(result, action) }
      } catch (error) {
        return { kind: 'unknown', reason: unknownReason(error) }
      }
    },
  }
}

function unknownReason(error) {
  return { UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT', NOT_FOUND: 'READBACK_NOT_FOUND', READBACK_MISMATCH: 'READBACK_MISMATCH', FORBIDDEN: 'READBACK_AUTHORIZATION_FAILED', INVALID_SOURCE: 'INVALID_SUCCESS_RESPONSE' }[error?.code] ?? 'UPSTREAM_RESULT_UNKNOWN'
}
