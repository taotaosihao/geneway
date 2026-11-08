import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { arms } from './fixture.mjs'

const entry = new URL('../../src/interaction-service.mjs', import.meta.url)
const known = "if(previousIntent?.workId)attach(state,intent,previousIntent.workId,'deterministic');else if(workIds.length===1)attach(state,intent,workIds[0],'deterministic');else queueRouting(state,intent,{policyId:parameters.routingPolicyId,query:parameters.directoryQuery??''})"
const batch = 'if(prepared.length>=ROUTING_BATCH_LIMITS.maxEvents)break'
export const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function compileAblation(source, arm, finalSha256) {
  assert(arms.includes(arm))
  assert.match(finalSha256, /^[a-f0-9]{64}$/)
  assert.equal(hash(source), finalSha256, 'interaction-service differs from accepted final candidate')
  let output = source
  const replacements = [
    [known, arm === 'A' ? "if(!previous&&active.some(row=>row.workId===(previousIntent?.workId??(workIds.length===1?workIds[0]:null))))queueRouting(state,intent,{policyId:parameters.routingPolicyId,query:parameters.directoryQuery??''});else " + known : known],
    [batch, arm === 'C' ? batch : 'if(prepared.length>=1)break'],
  ]
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, 'Ablation anchor must match exactly once')
    output = output.replace(from, to)
  }
  return { output, proof: { arm, node: process.version, sourceSha256: finalSha256, inMemorySha256: hash(output), replacements } }
}

// 必须在动态导入正式服务之前安装；只有目标模块在当前进程内被替换。
export function installAblation(arm, finalSha256) {
  const { output, proof } = compileAblation(readFileSync(entry, 'utf8'), arm, finalSha256)
  let loads = 0
  const hook = registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (url !== entry.href) return loaded
    assert.equal(hash(loaded.source ?? readFileSync(entry)), finalSha256, 'Ablation source drift at load')
    assert.equal(++loads, 1, 'Ablation target loaded more than once')
    return { ...loaded, source: output }
  } })
  return { proof, assertLoaded() { assert.equal(loads, 1, 'Official service did not load through ablation') }, close() {
    hook.deregister()
    assert.equal(hash(readFileSync(entry)), finalSha256, 'Official service changed on disk')
  } }
}
