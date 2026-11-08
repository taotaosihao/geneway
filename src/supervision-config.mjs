import { readFile } from 'node:fs/promises'
import { resolveCredentialFile } from './execution-grant.mjs'
import { exact } from '../packages/agent-contracts/index.mjs'

export async function readSupervisionIdentities(path) {
  if (!path) return []
  const config = JSON.parse(await readFile(path, 'utf8'))
  exact(config, ['secretRoot', 'identities'])
  if (!Array.isArray(config.identities)) throw new Error('监督身份配置无效')
  const diagnosisWorkspaces = new Set()
  for (const identity of config.identities) {
    if (identity.role === 'diagnose') {
      if (typeof identity.budgetPolicyId !== 'string' || !identity.budgetPolicyId.trim() || diagnosisWorkspaces.has(identity.workspaceId)) throw new Error('监督诊断身份配置无效')
      diagnosisWorkspaces.add(identity.workspaceId)
    } else if (Object.hasOwn(identity, 'budgetPolicyId')) throw new Error('仅诊断身份可配置诊断预算')
  }
  return Promise.all(config.identities.map(async identity => {
    exact(identity, ['id', 'role', 'workspaceId', 'nodeIds', 'workIds', 'credentialRef', 'budgetPolicyId'])
    const { credentialRef, ...scope } = identity
    const token = (await readFile(await resolveCredentialFile(config.secretRoot, credentialRef), 'utf8')).trim()
    return { ...scope, token }
  }))
}
