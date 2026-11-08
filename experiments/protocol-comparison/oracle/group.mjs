import assert from 'node:assert/strict'
import { sameBinding } from '../../../packages/agent-contracts/index.mjs'

// 这些入口只检查调用者提供的原事实；真实导航/签名原件尚未接入时不生成整体验收结论。
export function assertOpaquePayload(payload, allowedKeys) {
  assert.ok(payload && typeof payload==='object' && !Array.isArray(payload))
  assert.ok(Array.isArray(allowedKeys) && allowedKeys.length)
  for(const [key,value] of Object.entries(payload)) {
    assert.ok(allowedKeys.includes(key),`unexpected group wire field: ${key}`)
    assert.equal(typeof value,'string',`opaque fields must be scalar identifiers: ${key}`)
  }
  return { checkedKeys:Object.keys(payload).sort(),boundary:'exact allowlist must come from locked wire schema; opaque reference alone confers no data permission' }
}

export function assertPrincipalBinding({principal,execution,expectedEmployeeId,expectedWorkId}) {
  assert.equal(execution.agent_id,expectedEmployeeId);assert.equal(execution.work_id,expectedWorkId)
  assert.ok(sameBinding(principal.binding,execution))
  assert.ok(principal.id)
  return {principalId:principal.id,employeeId:execution.agent_id,workId:execution.work_id,
    boundary:'binding linkage only; authenticated credential and protocol proof must be independently verified from raw records'}
}

export function assertRemovalSourcePreserved(before,after,removal) {
  const rows=after.workMemberRemovals.filter(row=>row.workspaceId===removal.workspaceId&&row.workId===removal.workId&&row.employeeId===removal.employeeId)
  assert.equal(rows.length,1);assert.deepEqual(rows[0],removal)
  for(const field of ['nodes','resources','employees']) assert.deepEqual(after[field],before[field])
  assert.equal(after.works.find(row=>row.id===removal.workId).instructionRevision,before.works.find(row=>row.id===removal.workId).instructionRevision)
  return {workId:removal.workId,employeeId:removal.employeeId,globalIdentityAndResourceFactsUnchanged:true}
}

export function assertActualFanout({messageId,expectedRecipients,deliveries,modelBefore,modelAfter}) {
  assert.equal(new Set(expectedRecipients).size,2)
  const actual=deliveries.filter(row=>row.messageId===messageId)
  assert.equal(actual.length,2)
  assert.deepEqual(actual.map(row=>row.recipientId).sort(),[...expectedRecipients].sort())
  assert.deepEqual(modelAfter,modelBefore,'group notification must not create extra model forwards')
  return {messageId,recipients:expectedRecipients,boundary:'receiver rows require original wire/incoming provenance; journal enqueue alone is not actual delivery'}
}

export const groupOracleBoundary={status:'not-run',reason:'Awaiting locked runner navigation and actual terminal package',
  anpCrypto:'not-run',a2aProtocol:'not-run',restartReconciliation:'not-run',businessDataAccess:'not-run',
  boundary:'No producer, score, whole-X03/MUST or winner claim; product denial, protocol roster confirmation and execution stop remain separate facts'}

export async function verifyGroupFacts(runRoot) {
  const {readFile}=await import('node:fs/promises'),{join,resolve}=await import('node:path')
  const root=resolve(runRoot),load=async name=>JSON.parse(await readFile(join(root,name+'.json'),'utf8'))
  const [before,committed,after,pre,restored,final,killed,reopened,bindings,facts]=await Promise.all(['before-remove-product','product-committed-pre-enqueue','after-remove-product','control-pre-enqueue','restored-before-Host','after-remove-group','bridge-killed','bridge-reopened','bridge/domain/principal-bindings','full-managed-facts'].map(load))
  const lines=async name=>(await readFile(join(root,name),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const processEvents=await lines('bridge/process-events.jsonl')
  assert.equal(processEvents.find(row=>row.kind==='terminal'&&row.generation===1).terminal.signal,'SIGKILL')
  assert.equal(processEvents.find(row=>row.kind==='os-final'&&row.generation===1).finalIdentity,null)
  assert.equal(processEvents.find(row=>row.kind==='start'&&row.generation===2).openExisting,true)
  const removal=committed.workMemberRemovals.find(row=>row.employeeId==='gateway');assert.ok(removal)
  const preservation=assertRemovalSourcePreserved(before,after,removal)
  for(const principal of bindings){const attempt=before.multisite.attempts.find(row=>sameBinding(row,principal.binding));assert.ok(attempt);assert.equal(principal.employeeId,attempt.agent_id)}
  if(final.group.journal) return verifyAnpGroup({root,load,lines,before,after,pre,restored,final,killed,reopened,removal,preservation,bindings})
  assert.equal(pre.group.operations.some(row=>row.kind==='remove'),false)
  const intent=restored.group.operations.filter(row=>row.kind==='remove');assert.equal(intent.length,1);assert.equal(intent[0].removalCommandId,removal.commandId);assert.equal(intent[0].appliedAt,null)
  const operation=final.group.operations.find(row=>row.id===intent[0].id);assert.ok(operation.confirmedAt);assert.equal(operation.removalCommandId,removal.commandId)
  assert.equal(final.group.pending,false)
  assert.notEqual(killed.originalIdentity.pid,reopened.identity.pid);assert.notEqual(killed.originalIdentity.startTicks,reopened.identity.startTicks);assert.equal(killed.originalOrigin,reopened.origin)
  assert.deepEqual(reopened.info.identity,pre.group.identity)
  const pageBefore=await load('g-page-before'),pageAfter=await load('g-page-after'),modelAfter=await load('old-model-denied')
  assert.equal(pageBefore.status,200);assert.equal(pageAfter.status,403);assert.equal(modelAfter.status,403)
  const q=await load('question-session-no-second-wake');assert.deepEqual(q.after,q.before)
  const other=await load('other-work-valid');assert.notEqual(other.workId,removal.workId);assert.ok(other.state.multisite.commands.some(row=>row.senderBinding?.work_id===other.workId&&row.senderBinding.agent_id==='gateway'))
  const denied=facts.filter(row=>row.status===403&&row.employeeId==='gateway');assert.ok(denied.length)
  if(final.group.candidate==='a2a') {
    const wire=await lines('bridge/group/wire.jsonl')
    for(const row of wire){assert.equal(row.request.method,'SendMessage');assert.equal(row.request.params.message.role,'ROLE_USER');assert.deepEqual(row.request.params.message.parts[0].data,row.requestPayload);assertOpaquePayload(row.requestPayload,['opaqueSchema','op','groupId','operationId','locator']);const principal=final.group.principals.find(p=>p.id===row.actorId);assert.ok(principal);assert.equal(row.request.params.message.contextId,principal.contextId)}
    assert.equal(final.group.applicationGroup,true);assert.equal(final.group.nativeProtocolGroup,false)
    assert.equal(final.group.members.find(row=>row.employeeId==='gateway').active,false)
    const offer=await load('old-offered'),ack=await load('old-opaque-transport-ack')
    assertOpaquePayload(offer,['opaqueSchema','op','groupId','operationId','locator'])
    assert.equal(ack.code,0);assert.equal(ack.payload.locator,offer.locator)
    assert.equal(new Set(final.group.principals.filter(row=>row.role==='member').map(row=>row.contextId)).size,3)
  }
  return {candidate:final.group.candidate,removal,preservation,recoveredOperationId:operation.id,confirmedAt:operation.confirmedAt,principalsMatched:bindings.length,deniedManagedCalls:denied.length,
    boundary:'read-only product/control linkage and access observations; raw protocol crypto, complete receiver fanout, UI visual review are not yet independently checked by this entrypoint'}
}
if(process.argv[1]?.endsWith('/oracle/group.mjs')) {try{console.log(JSON.stringify(await (process.argv.includes('--post-confirm-positive')?verifyPostConfirmPositive(process.argv[2]):verifyGroupFacts(process.argv[2])),null,2))}catch(error){console.error(error.stack);process.exitCode=1}}

async function verifyAnpGroup({root,load,lines,before,after,pre,restored,final,killed,reopened,removal,preservation,bindings}) {
  const {verifyRfc9421OriginProof,verifyHttpMessageSignature,verifyW3cProof,extractPublicKey}=await import('@awiki/anp-typescript-sdk')
  const {default:bs58}=await import('bs58')
  const journal=final.group.journal,entry=journal.removals.find(row=>row.commandId===removal.commandId),gateway=journal.members.find(row=>row.employeeId==='gateway')
  assert.equal(pre.group.journal.removals.length,0)
  assert.equal(restored.group.journal.removals[0].commandId,removal.commandId);assert.equal(restored.group.journal.removals[0].confirmed,false)
  assert.ok(entry);assert.equal(entry.receipt.subject_method,'group.remove');assert.equal(entry.receipt.group_did,journal.groupDid)
  const roster=entry.roster.result;assert.equal(roster.group_did,journal.groupDid)
  assert.equal(roster.group_state_version,entry.receipt.group_state_version);assert.equal(roster.group_event_seq,entry.receipt.group_event_seq)
  assert.equal(roster.member_list.some(row=>row.member_did===gateway.protocol.did&&row.status==='active'),false)
  assert.equal(entry.roster.signed,false);assert.equal(roster.group_profile.discoverability,'private');assert.equal(roster.group_policy.admission_mode,'admin-add')
  assert.deepEqual(entry.calibration.outstanding,[]);assert.equal(entry.calibration.finalStateNotificationReceived,true)
  assert.equal(final.group.status.members.find(row=>row.employeeId==='gateway').status,'confirmed')
  assert.notEqual(killed.originalIdentity.pid,reopened.identity.pid);assert.equal(killed.originalOrigin,reopened.origin);assert.equal(reopened.info.groupDid,journal.groupDid)
  const documents=new Map()
  const {readdir}=await import('node:fs/promises'),{join}=await import('node:path')
  for(const member of await readdir(join(root,'independent-group-host/members'))){const file=await load(`independent-group-host/members/${member}/identity`);documents.set(file.document.id,file.document)}
  for(const actor of ['service','owner','desktop-office','desktop-data','gateway']) {const value=await load(`bridge/home/${actor}-identity`);documents.set(value.didDocument.id,value.didDocument)}
  for(const row of await lines('independent-group-host/wire.jsonl')) if(row.method==='GET'&&row.status===200&&row.path.endsWith('/did.json')){const doc=JSON.parse(row.responseBody);documents.set(doc.id,doc)}
  function receipt(value){const doc=documents.get(value.group_did);assert.ok(doc);const method=doc.verificationMethod.find(row=>row.id===value.proof.verificationMethod);assert.ok(method&&doc.assertionMethod.includes(method.id));const bytes=bs58.decode(value.proof.proofValue.slice(1));assert.equal(bytes.length,64);assert.ok(verifyW3cProof({...value,proof:{...value.proof,proofValue:Buffer.from(bytes).toString('base64url')}},extractPublicKey(method),{expectedPurpose:'assertionMethod'}))}
  receipt(entry.receipt)
  const removeOperation=journal.operations.find(row=>row.method==='group.remove'&&row.operationId===entry.receipt.operation_id)
  assert.ok(removeOperation);assert.equal(removeOperation.body.member_did,gateway.protocol.did)
  const request=removeOperation.prepared.request,{meta,body,auth}=request.params
  assert.equal(meta.target.did,journal.groupDid)
  verifyRfc9421OriginProof(auth.origin_proof,'group.remove',meta,body,{didDocument:documents.get(meta.sender_did),options:{expectedSignerDid:meta.sender_did}})
  const control=await lines('bridge/group/control-wire.jsonl')
  assert.ok(control.some(row=>row.phase==='forward-to-Host'&&row.operationId===removeOperation.operationId))
  let httpVerified=0,originVerified=0,receiptsVerified=1
  const incoming=await lines('bridge/home/incoming.jsonl')
  for(const row of incoming){const {meta,body,auth}=row.rpc.params,doc=documents.get(row.httpSignerDid);assert.ok(doc);const raw=row.signedRequest;verifyHttpMessageSignature(doc,raw.method,raw.url,raw.headers,raw.body);httpVerified++
    if(row.rpc.method==='group.incoming'){verifyRfc9421OriginProof(auth.origin_proof,'group.send',{...meta,target:{kind:'group',did:body.group_did}},{payload:body.payload},{didDocument:documents.get(meta.sender_did),options:{expectedSignerDid:meta.sender_did}});originVerified++}
    assert.equal(body.group_did,journal.groupDid)
    if(body.group_receipt){receipt(body.group_receipt);receiptsVerified++}
    if(row.rpc.method==='group.incoming'){const payload=body.message?.payload??body.payload;assert.ok(payload);assertOpaquePayload(payload,['schema','locator'])}
  }
  assert.ok(httpVerified&&originVerified)
  assert.equal((await load('g-page-before')).status,200);assert.equal((await load('g-page-after')).status,403);assert.equal((await load('old-model-denied')).status,403)
  const q=await load('question-session-no-second-wake');assert.deepEqual(q.before,q.after)
  assert.deepEqual(after.workMemberRemovals.find(row=>row.commandId===removal.commandId),removal)
  return {candidate:'anp',removal,preservation,principalsMatched:bindings.length,groupDid:journal.groupDid,version:roster.group_state_version,eventSeq:roster.group_event_seq,httpVerified,originVerified,receiptsVerified,
    boundary:'fresh roster is authenticated unsigned query; receipt and incoming signatures independently recomputed; complete fanout/UI visual/SQLite corroboration not yet checked by this entrypoint'}
}

export async function verifyPostConfirmPositive(runRoot) {
  const {readFile,readdir}=await import('node:fs/promises'),{join,resolve}=await import('node:path')
  const root=resolve(runRoot),load=async name=>JSON.parse(await readFile(join(root,name+'.json'),'utf8'))
  const lines=async name=>(await readFile(join(root,name),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const before=await load('positive-before-new-publish'),after=await load('positive-new-publish')
  assert.equal(after.fresh.length,2);assert.deepEqual(after.fresh.map(row=>[row.sender,row.recipient]),[['desktop-office','desktop-data'],['desktop-data','desktop-office']])
  assert.deepEqual(after.product.modelRequests,before.product.modelRequests)
  const candidate=after.group.group.journal?'anp':'a2a',details=[]
  assert.ok(before.product.workMemberRemovals.some(row=>row.employeeId==='gateway'&&row.commandId===after.removed.commandId))
  if(candidate==='anp') assert.equal(before.group.group.status.members.find(row=>row.employeeId==='gateway').status,'confirmed')
  else {assert.equal(before.group.group.pending,false);assert.equal(before.group.group.members.find(row=>row.employeeId==='gateway').active,false)}
  for(const row of after.fresh){
    const id=row.submitted.messageId,locator=row.registered.locator
    assert.equal(before.product.multisite.messages.some(message=>message.id===id),false)
    const message=after.product.multisite.messages.find(message=>message.id===id);assert.ok(message)
    assert.equal(message.senderBinding.agent_id,row.sender);assert.equal(row.body.messageId,id);assert.equal(row.body.text,message.text)
    assert.equal(row.body.text,`确认后全新的${row.sender}观察`)
    assert.equal(row.registered.messageId,id);assert.equal(row.delivered.locator,locator)
    assert.equal(JSON.stringify(before.group).includes(locator),false)
    assert.ok(after.group.domain.events.some(event=>event.locator===locator&&event.messageId===id))
    details.push({sender:row.sender,recipient:row.recipient,messageId:id,locator,operationId:row.delivered.operationId})
  }
  let crypto=null
  if(candidate==='a2a'){
    assert.notEqual(after.raw.code,0)
    const wire=await lines('bridge/group/wire.jsonl')
    for(const row of after.fresh){const sent=wire.filter(event=>event.actorId===row.sender&&event.requestPayload.op==='publish'&&event.requestPayload.locator===row.registered.locator&&event.status===200);assert.equal(sent.length,1);assert.ok(after.group.group.deliveries.some(delivery=>delivery.id===row.delivered.operationId&&delivery.employeeId===row.recipient&&delivery.locator===row.registered.locator&&delivery.offeredAt&&delivery.transportAckedAt));assert.equal(after.group.group.deliveries.some(delivery=>delivery.employeeId==='gateway'&&delivery.locator===row.registered.locator),false);assertOpaquePayload(sent[0].requestPayload,['opaqueSchema','op','groupId','operationId','locator'])}
  } else {
    const {verifyRfc9421OriginProof,verifyHttpMessageSignature,verifyW3cProof,extractPublicKey}=await import('@awiki/anp-typescript-sdk'),{default:bs58}=await import('bs58')
    const docs=new Map()
    for(const actor of ['service','desktop-office','desktop-data','gateway']){const value=await load(`bridge/home/${actor}-identity`);docs.set(value.didDocument.id,value.didDocument)}
    for(const row of await lines('independent-group-host/wire.jsonl'))if(row.method==='GET'&&row.status===200&&row.path.endsWith('/did.json')){const doc=JSON.parse(row.responseBody);docs.set(doc.id,doc)}
    assert.equal(after.raw.error.data.anp_code,'group.not_member')
    const journal=after.group.group.journal,incoming=await lines('bridge/home/incoming.jsonl');let verified=0
    for(const row of after.fresh){
      const receipt=row.sent.group_receipt,doc=docs.get(receipt.group_did),method=doc.verificationMethod.find(value=>value.id===receipt.proof.verificationMethod)
      assert.ok(doc.assertionMethod.includes(method.id));const signature=bs58.decode(receipt.proof.proofValue.slice(1));assert.equal(signature.length,64)
      assert.ok(verifyW3cProof({...receipt,proof:{...receipt.proof,proofValue:Buffer.from(signature).toString('base64url')}},extractPublicKey(method),{expectedPurpose:'assertionMethod'}))
      assert.equal(receipt.operation_id,row.delivered.operationId)
      const target=journal.members.find(member=>member.employeeId===row.recipient).protocol.did,gateway=journal.members.find(member=>member.employeeId==='gateway').protocol.did
      const matched=incoming.filter(value=>value.rpc.method==='group.incoming'&&value.rpc.params.body.payload.locator===row.registered.locator)
      assert.ok(matched.some(value=>value.rpc.params.meta.target.did===target));assert.equal(matched.some(value=>value.rpc.params.meta.target.did===gateway),false)
      for(const value of matched){const {meta,body,auth}=value.rpc.params,raw=value.signedRequest;verifyHttpMessageSignature(docs.get(value.httpSignerDid),raw.method,raw.url,raw.headers,raw.body);verifyRfc9421OriginProof(auth.origin_proof,'group.send',{...meta,target:{kind:'group',did:body.group_did}},{payload:body.payload},{didDocument:docs.get(meta.sender_did),options:{expectedSignerDid:meta.sender_did}});assertOpaquePayload(body.payload,['schema','locator']);verified++}
    }
    crypto={freshReceipts:2,signedIncoming:verified,boundary:'no new gateway incoming in archived receiver records; SQLite independently not checked'}
  }
  return {candidate,mode:'post-confirm-positive',fresh:details,modelsBefore:before.product.modelRequests.length,modelsAfter:after.product.modelRequests.length,crypto,
    boundary:'separate positive-only Work/HostSim sample, not stitched into original full run; no native extra-wake or full queue empty claim'}
}
