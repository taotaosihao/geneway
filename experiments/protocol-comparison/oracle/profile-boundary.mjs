import assert from 'node:assert/strict'

// 观测到条款不符合仍正常输出failed；原件缺失不能用采集器exit或任意HTTP错误补成通过。
export function classifyJsonRpcError({httpStatus,body,expectedCode,role,clause}) {
  assert.ok(Number.isInteger(httpStatus));assert.ok(Number.isInteger(expectedCode))
  const actualCode=body?.error?.code??null
  return {role,clause,httpStatus,expectedCode,actualCode,status:actualCode===expectedCode?'passed':'failed',
    boundary:'exact protocol error code only; transport rejection is separate and does not substitute for the prescribed JSONRPC error'}
}
export function assertEquivalentGetTaskVersion({positive,variant}) {
  assert.equal(positive.method,variant.method);assert.equal(positive.url,variant.url)
  assert.deepEqual(positive.body,variant.body)
  const strip=headers=>Object.fromEntries(Object.entries(headers).filter(([name])=>name.toLowerCase()!=='a2a-version').map(([name,value])=>[name.toLowerCase(),value]))
  assert.deepEqual(strip(positive.headers),strip(variant.headers))
  const version=headers=>Object.entries(headers).find(([name])=>name.toLowerCase()==='a2a-version')?.[1]
  assert.equal(version(positive.headers),'1.0');assert.equal(version(variant.headers),'9.9')
}
export function classifyNonemptyTaskList({taskId,body,httpStatus}) {
  assert.equal(typeof taskId,'string');assert.ok(taskId)
  const tasks=body?.result?.tasks
  return {httpStatus,positiveTaskId:taskId,observedTaskIds:Array.isArray(tasks)?tasks.map(row=>row.id):null,
    status:Array.isArray(tasks)&&tasks.some(row=>row.id===taskId)?'passed':'failed',
    boundary:'one unfiltered owner ListTask sample; no pagination/filter or cross-owner isolation conclusion'}
}
export function assertNoRejectedSignatureEffects(before,after) {
  assert.deepEqual(after,before,'rejected signature request must not append business message/receipt/event/member delivery effects')
  return {unchanged:true,boundary:'selected actual immutable business tables; audit logging may change separately'}
}
export const profileBoundaryStatus={status:'not-run',reason:'Awaiting locked manifest and actual terminal roots',
  boundary:'collector correctness, observed clause status and seven-gate impact are separate; no full X10/P1-P4 certificate, optional vendor capability support credit or winner'}

export async function verifyProfileBoundary(runRoot) {
  const {readFile}=await import('node:fs/promises'),{join,resolve}=await import('node:path'),{createHash}=await import('node:crypto')
  const root=resolve(runRoot),load=async name=>JSON.parse(await readFile(join(root,name),'utf8')),sha=bytes=>createHash('sha256').update(bytes).digest('hex')
  const manifest=await load('manifest.json'),captured=new Map()
  assert.deepEqual(manifest.sourceStart,manifest.sourceEnd)
  const sourceReadback=[]
  for(const source of manifest.sourceStart){const current=await readFile(source.path),currentSha256=sha(current)
    let deltaVerified=false
    if(currentSha256!==source.sha256){
      assert.equal(manifest.family,'anp');const delta=await load('collector-source-delta.json')
      assert.ok(source.path === 'experiments/protocol-comparison/profile-boundary.mjs')
      assert.equal(delta.capturedSha256,source.sha256);assert.equal(delta.currentSha256,currentSha256);assert.equal(delta.affectedFamily,'a2a');assert.equal(delta.deltas.length,2)
      let reversed=current.toString('utf8')
      for(const item of delta.deltas){assert.equal(item.after.replace("accept:'application/json',",''),item.before);assert.equal(reversed.split(item.after).length,2);reversed=reversed.replace(item.after,item.before)}
      assert.equal(sha(Buffer.from(reversed)),source.sha256);deltaVerified=true
    }
    sourceReadback.push({...source,currentSha256,currentMatchesCaptured:currentSha256===source.sha256,a2aOnlyAcceptDeltaIndependentlyVerified:deltaVerified})
  }
  for(const row of manifest.observations){const bytes=await readFile(join(root,row.bodyRef));assert.equal(bytes.length,row.byteLength);assert.equal(sha(bytes),row.sha256);const headers=await load(row.responseHeadersRef);assert.equal(headers.raw.length%2,0);for(let i=0;i<headers.raw.length;i+=2)assert.ok(String(headers.normalized[headers.raw[i].toLowerCase()]).includes(headers.raw[i+1]));let request=null;if(row.requestRef){const raw=await readFile(join(root,row.requestRef));assert.equal(sha(raw),row.requestSha256);request=JSON.parse(raw)}captured.set(row.label,{...row,body:JSON.parse(bytes),request})}
  let results
  if(manifest.family==='a2a'){
    const rows=[...captured.values()],positive=rows.find(row=>row.label.includes('authorized')||row.label.includes('positive'))
    assert.ok(positive);assert.equal(positive.httpStatus,200)
    const task=positive.body.result;assert.equal(task.id,manifest.knownTask.id);assert.equal(task.contextId,manifest.knownTask.contextId);assert.equal(task.metadata.geneway.workId,manifest.knownTask.workId)
    const version=rows.find(row=>row.requestHeaders['a2a-version']==='9.9');assert.ok(version)
    assertEquivalentGetTaskVersion({positive:{method:positive.method,url:positive.url,body:positive.request,headers:positive.requestHeaders},variant:{method:version.method,url:version.url,body:version.request,headers:version.requestHeaders}})
    const missing=rows.find(row=>row.label.includes('missing')),list=rows.find(row=>row.label.includes('list'))
    assert.ok(missing&&list)
    results=[{name:'authorized-GetTask-1.0',status:'passed',taskId:task.id},classifyJsonRpcError({httpStatus:version.httpStatus,body:version.body,expectedCode:-32009,role:'owner-task',clause:'A2A lines737/1190'}),classifyJsonRpcError({httpStatus:missing.httpStatus,body:missing.body,expectedCode:-32001,role:'owner-task',clause:'A2A section3.1.3/1182'}),classifyNonemptyTaskList({taskId:task.id,body:list.body,httpStatus:list.httpStatus})]
    assert.deepEqual(await load('product-after.json'),await load('product-before.json'))
    const mapping=await load('mapping-before-after.json');assert.deepEqual(mapping.before??mapping.original,mapping.after)
  }else{
    const {verifyHttpMessageSignature,verifyRfc9421OriginProof}=await import('@awiki/anp-typescript-sdk')
    const service=(await load('home/service-identity.json')).didDocument,member=(await load('home/desktop-data-identity.json')).didDocument
    assert.equal(service.id,manifest.identity.homeServiceDid);assert.equal(member.id,manifest.identity.memberDid)
    const positive=await load('valid-prepared.json'),badHttp=await load('bad-http-prepared.json'),badOrigin=await load('bad-origin-prepared.json'),info=await load('authenticated-info-prepared.json')
    const outer=prepared=>verifyHttpMessageSignature(service,'POST',prepared.endpoint,prepared.headers,prepared.body)
    const inner=prepared=>{const rpc=JSON.parse(prepared.body),{meta,body,auth}=rpc.params;assert.deepEqual(rpc,prepared.request);return verifyRfc9421OriginProof(auth.origin_proof,rpc.method,meta,body,{didDocument:member,options:{expectedSignerDid:member.id}})}
    outer(positive);inner(positive);inner(badHttp);assert.throws(()=>outer(badHttp));outer(badOrigin);assert.throws(()=>inner(badOrigin));outer(info);inner(info)
    for(const [label,prepared] of [['valid-signed-notice',positive],['bad-http-signature',badHttp],['bad-origin-signature',badOrigin],['authenticated-info-first',info],['authenticated-info-exact-http-replay',info]]){const observed=captured.get(label);assert.equal(observed.url,prepared.endpoint);assert.deepEqual(observed.request,prepared.request);assert.deepEqual(observed.requestHeaders,prepared.headers)}
    const used=[positive,badHttp,badOrigin].map(value=>value.request.params.meta.operation_id);assert.equal(new Set(used).size,3)
    for(const name of ['bad-http','bad-origin']){const effects=await load(name+'-effects.json');assertNoRejectedSignatureEffects(effects.before,effects.after)}
    const rows=[...captured.values()],valid=rows.find(row=>row.label==='valid-signed-notice');assert.equal(valid.httpStatus,200);assert.ok(valid.body.result)
    for(const label of ['bad-http','bad-origin']){const row=rows.find(row=>row.label.includes(label));assert.ok(row);assert.equal(row.httpStatus,401);assert.equal(row.body.error.code,1005);assert.equal(row.body.error.message,label==='bad-http'?'invalid_peer_http_signature':'invalid_origin_proof_signature')}
    const recipient=await load('actual-positive-recipient.json');assert.equal(recipient.rpc.params.meta.operation_id,positive.request.params.meta.operation_id);assert.deepEqual(recipient.rpc.params.body.payload,positive.request.params.body.payload)
    const replay=rows.filter(row=>row.label.includes('info'));assert.equal(replay.length,2);assert.deepEqual(replay[0].request,replay[1].request);assert.deepEqual(replay[0].requestHeaders,replay[1].requestHeaders)
    results=[{name:'valid-member-notice',status:'passed',boundary:'actual recipient RPC linked; recipient verified flags not used as crypto proof'}, {name:'bad-http-valid-inner',status:'passed'},{name:'bad-origin-valid-outer',status:'passed'}, {name:'authenticated-HTTP-read-replay-rejection',status:replay.every(row=>row.httpStatus===200)?'not-run':'observed',actualStatuses:replay.map(row=>row.httpStatus),boundary:'both exact authenticated reads accepted; HTTP replay rejection not demonstrated; business idempotency is not authentication anti-replay'}]
  }
  return {family:manifest.family,sourceReadback,observations:[...captured.values()].map(({label,httpStatus,body})=>({label,httpStatus,body})),results,
    boundary:'collector correctness separated from clause status; version/List differences are observed failures, not automatic P1 fixes; no full X10/Profile certificate, TLS/public deployment qualification, scores or winner'}
}
if(process.argv[1]?.endsWith('/oracle/profile-boundary.mjs')){try{console.log(JSON.stringify(await verifyProfileBoundary(process.argv[2]),null,2))}catch(error){console.error(error.stack);process.exitCode=1}}
