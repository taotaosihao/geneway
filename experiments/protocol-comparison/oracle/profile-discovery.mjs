import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import { readFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

export function jsonPointer(value,pointer) {
  assert.equal(typeof pointer,'string')
  if(pointer==='') return value
  assert.ok(pointer.startsWith('/'),'JSON pointer must be RFC6901')
  let current=value
  for(const part of pointer.slice(1).split('/')) {
    assert.ok(!/~(?:[^01]|$)/.test(part),'invalid JSON pointer escape')
    const key=part.replaceAll('~1','/').replaceAll('~0','~')
    assert.ok(current!==null&&typeof current==='object'&&Object.hasOwn(current,key),`missing JSON pointer ${pointer}`)
    current=current[key]
  }
  return current
}
export async function readCapturedBody(root,reference,{byteLength,sha256}={}) {
  assert.equal(typeof reference,'string')
  const base=resolve(root),path=resolve(base,reference),within=relative(base,path)
  assert.ok(within!==''&&!within.startsWith('..')&&!isAbsolute(within),'capture reference must remain within run root')
  const bytes=await readFile(path)
  assert.ok(Number.isSafeInteger(byteLength)&&byteLength>=0,'actual byte length required')
  assert.equal(bytes.length,byteLength)
  assert.match(sha256??'',/^[a-f0-9]{64}$/,'actual captured bytes digest required')
  assert.equal(createHash('sha256').update(bytes).digest('hex'),sha256)
  return {bytes,json:JSON.parse(bytes.toString('utf8'))}
}
export function assertNoDiscoveryBusinessMutation(before,after) {
  for(const field of ['works','modelRequests','artifacts','evidence','workMemberRemovals']) assert.deepEqual(after[field],before[field],`discovery changed ${field}`)
  assert.deepEqual(after.multisite,before.multisite,'discovery must not create domain execution/receipt effects')
  return {workAndModelFactsUnchanged:true,boundary:'needs original before/after production states and any separate Host Job journals; no implied external provider observation'}
}
export function assertClaimLinked(claim,observations,parsedBodies) {
  const observation=observations.find(row=>row.id===claim.observationId)
  assert.ok(observation,'claim must reference an actual observation')
  assert.equal(claim.role,observation.role)
  const body=parsedBodies.get(observation.id);assert.ok(body)
  return {observationId:observation.id,role:observation.role,pointer:claim.jsonPointer,value:jsonPointer(body,claim.jsonPointer),
    boundary:'wire declaration only; mount, historical method behavior, adopted product scope and next-half obligations remain separate'}
}
export const discoveryOracleStatus={status:'not-run',reason:'Awaiting collector locked manifest fields and terminal run root',
  boundary:'public Card or anonymous capabilities do not authenticate identity; owner Task unknown-bearer 401 is not cross-owner authorization; no all-MUST or winner claim'}

export async function verifyProfileDiscovery(runRoot) {
  const {join}=await import('node:path'),{access}=await import('node:fs/promises')
  const root=resolve(runRoot),load=async ref=>JSON.parse(await readFile(join(root,ref),'utf8'))
  const manifest=await load('manifest.json'),parsed=new Map(),roles=new Map(manifest.roles.map(row=>[row.role,row]))
  assert.equal(roles.size,manifest.roles.length)
  assert.deepEqual(manifest.sources,manifest.sourceEnd)
  assert.deepEqual(await load('source-start.json'),manifest.sources)
  const repo='/home/gewu/work/geneway',sourceReadback=[]
  for(const source of manifest.sources){const bytes=await readFile(source.path);assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sha256);sourceReadback.push({path:source.path,sha256:source.sha256})}
  for(const role of manifest.roles){const path=resolve(repo,role.sourceRef.path),source=manifest.sources.find(row=>row.path===path);assert.ok(source);assert.equal(source.sha256,role.sourceRef.sha256)}
  const observations=[]
  for(const row of manifest.observations){
    assert.ok(roles.has(row.role));assert.equal(new URL(row.url).origin,new URL(roles.get(row.role).endpoint).origin)
    assert.equal(row.captureKind,'actual-http-response-bytes');assert.equal(resolve(row.sourceRun),root)
    const body=await readCapturedBody(root,row.bodyRef,row);parsed.set(row.id,body.json)
    const headers=await load(row.responseHeadersRef);assert.ok(Array.isArray(headers.raw));assert.equal(headers.raw.length%2,0)
    for(let i=0;i<headers.raw.length;i+=2){const name=headers.raw[i].toLowerCase();assert.ok(Object.hasOwn(headers.normalized,name));assert.ok(String(headers.normalized[name]).includes(headers.raw[i+1]))}
    assert.ok(Number.isInteger(row.httpStatus)&&row.httpStatus>=100&&row.httpStatus<600)
    observations.push({id:row.id,role:row.role,requestKind:row.requestKind,httpStatus:row.httpStatus,bodySha256:row.sha256,responseHeaders:headers.normalized})
  }
  const claims=manifest.claims.map(claim=>{
    const linked=assertClaimLinked(claim,manifest.observations,parsed),path=resolve(repo,claim.mountedSource)
    assert.ok(manifest.sources.some(row=>row.path===path),'mounted source must be in captured source index')
    return {...linked,mountedSource:path,actualMethodEvidence:claim.actualMethodEvidence,genewayAdoption:claim.genewayAdoption,nextHalf:claim.nextHalf}
  })
  const historical=[]
  for(const ref of manifest.historicalWire){const bytes=await readFile(ref.path);assert.equal(bytes.length,ref.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.sha256);assert.ok(roles.has(ref.role));historical.push({role:ref.role,path:ref.path,sha256:ref.sha256,boundary:'historical archived wire, not this run'})}
  let businessEvidence
  if(manifest.family==='a2a'){
    for(const role of manifest.roles){const card=manifest.observations.find(row=>row.role===role.role&&row.requestKind==='agent-card'),second=manifest.observations.find(row=>row.role===role.role&&row.requestKind==='official-resolver-card');assert.ok(card&&second);assert.equal(card.httpStatus,200);assert.deepEqual(parsed.get(card.id),parsed.get(second.id));assert.deepEqual(await load(role.sdkParsedRef),JSON.parse(JSON.stringify((await import('@a2a-js/sdk')).AgentCard.fromJSON(parsed.get(card.id)))))}
    const denied=manifest.observations.find(row=>row.requestKind==='unknown-bearer-get-task');assert.equal(denied.role,'a2a-owner-task');assert.equal(denied.httpStatus,401);assert.ok(!parsed.get(denied.id).result?.task)
    await assert.rejects(access(join(root,'owner-task/mapping/protocol-mapping.json')),{code:'ENOENT'})
    await assert.rejects(access(join(root,'no-api-started')),{code:'ENOENT'})
    businessEvidence={mappingFile:'not-created',productApiRoot:'not-created',boundary:'source-verified read-only collector uses no live API/executor; empty Task index count itself is author metadata, not provider traffic monitoring'}
  }else{
    const before=await load(manifest.businessBefore.hostFactsRef),after=await load(manifest.businessAfter.hostFactsRef);assert.deepEqual(after,before);assert.equal(Object.keys(before).length,6)
    const missing=manifest.observations.find(row=>row.requestKind==='nonexistent-member-did');assert.equal(missing.httpStatus,404)
    for(const row of manifest.observations.filter(row=>row.requestKind==='anonymous-live-capabilities')){assert.equal(row.httpStatus,200);assert.ok(parsed.get(row.id).result)}
    businessEvidence={immutableHostTables:Object.fromEntries(Object.entries(before).map(([key,rows])=>[key,rows.length])),deepEqual:true,boundary:'six original immutable Host business tables only; existing outbox delivery retry metadata excluded; no provider monitoring inferred'}
  }
  const mountReadback=[]
  for(const path of [...new Set(claims.map(row=>row.mountedSource))]){const lines=(await readFile(path,'utf8')).split('\n');mountReadback.push({path,locations:lines.flatMap((line,index)=>/agent-card|anp.get_capabilities|ANPMessageService|supportedInterfaces|securitySchemes|capabilities|group\.v1|attachment\.v1|federation\.relay\.v1/.test(line)?[{line:index+1,text:line.trim()}]:[])})}
  return {family:manifest.family,roles:manifest.roles.map(({role,endpoint,principalKind,usedByCandidate})=>({role,endpoint,principalKind,usedByCandidate})),observations,claims,sourceReadback,mountReadback,historical,businessEvidence,
    boundary:'wire declaration is not MUST conformance or method success; source mount/historical behavior/adoption remain separate; anonymous capabilities do not authenticate; unknown Bearer 401 is not cross-owner authorization; loopback is not public resolution; no scores or winner'}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(await verifyProfileDiscovery(process.argv[2]),null,2))}catch(error){console.error(error.stack);process.exitCode=1}
}
