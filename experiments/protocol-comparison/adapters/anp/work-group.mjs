import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createServer,request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openWorkGroupJournal} from '../../common/work-group-journal.mjs';
import {AWIKI_CHECKOUT,peerCommand} from '../../peers/anp/run.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
function independent(command){return new Promise((done,reject)=>{const child=spawn(path.join(AWIKI_CHECKOUT,'.venv/bin/python'),[fileURLToPath(new URL('../../peers/anp/group-control.py',import.meta.url))],{cwd:AWIKI_CHECKOUT,env:{PATH:process.env.PATH,PYTHONPATH:path.join(AWIKI_CHECKOUT,'src')},stdio:['pipe','pipe','pipe']}),out=[],err=[];child.stdout.on('data',bytes=>out.push(bytes));child.stderr.on('data',bytes=>err.push(bytes));child.once('error',reject);child.once('exit',code=>{if(code!==0)return reject(Error(Buffer.concat(err).toString()));try{done(JSON.parse(Buffer.concat(out)))}catch(error){reject(error);}});child.stdin.end(JSON.stringify(command));});}


// Authentication may expire while the stable GroupHost domain operation remains
// valid. Renew only authentication; keep the first wire forever as evidence.
export async function renewPrepared(original,prepareFresh){
  assert.deepEqual(JSON.parse(original.body),original.request);
  const next=await prepareFresh(structuredClone(original.request));
  assert.deepEqual(JSON.parse(next.body),next.request);
  assert.equal(next.endpoint,original.endpoint);assert.equal(!!next.admin,!!original.admin);
  assert.equal(next.request.jsonrpc,original.request.jsonrpc);
  for(const field of ['method'])assert.equal(next.request[field],original.request[field]);
  assert(isDeepStrictEqual(next.request.params.meta,original.request.params.meta),'Authentication renewal changed protected meta');
  assert(isDeepStrictEqual(next.request.params.body,original.request.params.body),'Authentication renewal changed domain body');
  assert.equal(next.request.params.auth.scheme,original.request.params.auth.scheme);
  assert.equal(next.request.params.auth.origin_proof.contentDigest,original.request.params.auth.origin_proof.contentDigest,'Authentication renewal changed domain digest');
  return next;
}
function expiry(prepared){const origin=prepared.request.params.auth.origin_proof.signatureInput,headers=prepared.headers??{},transport=Object.entries(headers).find(([name])=>name.toLowerCase()==='signature-input')?.[1];const parse=value=>{const match=/;expires=(\d+)/.exec(value??'');assert(match,'Signed request must declare an expiry');return Number(match[1]);};return{originExpiresAt:parse(origin),httpExpiresAt:transport?parse(transport):null};}

export async function startAnpWorkGroup({root,work,actors,home,peer,readState,authorize,calibrate,controlOrigin}){
  root=path.resolve(root);await mkdir(root,{recursive:true,mode:0o700});assert(work.workspaceId&&work.workId);assert.equal(typeof authorize,'function');assert.equal(typeof calibrate,'function');
  const members=structuredClone(actors),subject=hash([work.workspaceId,work.workId]).slice(0,24),handle='work-group-owner-'+subject.slice(0,12);
  assert.equal(new Set(members.map(row=>row.employeeId)).size,members.length);
  for(const actor of members){assert.equal(actor.binding.work_id,work.workId);assert.equal(actor.binding.agent_id,actor.employeeId);assert.equal(home.identities.get(actor.protocol.homeActor)?.didDocument.id,actor.protocol.did,'Protocol DID must be the verified actor identity');}
  const journal=await openWorkGroupJournal({file:path.join(root,'anp-work-group.json'),initial:{version:1,kind:'anp-work-group',work,members,groupDid:null,operations:[],removals:[],roster:null,removeBlocked:false}});
  const initial=await journal.read();assert.deepEqual(initial.work,work);assert.deepEqual(initial.members,members,'Existing member binding cannot silently change');
  const owner=await peerCommand(peer,{operation:'identity',handle});assert(!members.some(row=>row.protocol.did===owner.did),'Group admin is separate from device identity');
  const peerConfig=JSON.parse(await readFile(peer.identity.configPath,'utf8')),ownerIdentity=JSON.parse(await readFile(owner.identityFile,'utf8'));
  let queue=Promise.resolve(),closed=false,blocked=initial.removeBlocked,release,observedBlock,waitBlock;
  const sockets=new Set();const newBlock=()=>{waitBlock=new Promise(done=>{observedBlock=done;});};newBlock();
  const wire=value=>appendFile(path.join(root,'control-wire.jsonl'),JSON.stringify({at:new Date().toISOString(),...value})+'\n');
  const proxy=createServer(async(request,response)=>{
    try{const parts=[];for await(const bytes of request)parts.push(bytes);const bytes=Buffer.concat(parts),rpc=JSON.parse(bytes);
      if(rpc.method==='group.remove'&&blocked){await wire({phase:'remove-blocked-before-Host',request:rpc,bodySha256:hash(bytes.toString())});observedBlock({operationId:rpc.params.meta.operation_id,at:new Date().toISOString()});await new Promise(done=>{release=done;});}
      if(closed){response.destroy();return;}
      await wire({phase:'forward-to-Host',method:rpc.method,operationId:rpc.params.meta.operation_id,bodySha256:hash(bytes.toString())});
      const target=new URL(request.url,controlOrigin??peer.origin),upstream=httpRequest(target,{method:request.method,headers:{...request.headers,host:target.host}},incoming=>{response.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(response);});upstream.on('error',()=>response.destroy());response.once('close',()=>upstream.destroy());upstream.end(bytes);
    }catch{response.writeHead(502);response.end('{}');}
  });proxy.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});await new Promise((done,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',done);});const proxyOrigin='http://127.0.0.1:'+proxy.address().port;
  const serial=fn=>{const next=queue.then(()=>{assert(!closed);return fn();});queue=next.catch(()=>{});return next;};
  async function removals(){const state=await readState();return state.workMemberRemovals.filter(row=>row.workspaceId===work.workspaceId&&row.workId===work.workId&&members.some(actor=>actor.employeeId===row.employeeId));}
  async function gate(actor){const rows=await removals(),state=await journal.read();if(rows.some(row=>!state.removals.some(saved=>saved.commandId===row.commandId&&saved.employeeId===row.employeeId&&saved.confirmed)))fail('WORK_GROUP_RECONCILING');if(rows.some(row=>row.employeeId===actor.employeeId))fail('WORK_MEMBER_REMOVED');assert.equal(await authorize(actor,{purpose:'publish'}),true);}
  async function prepareAdmin(method,target,body,operationId,originalRequest){const sealed=await independent({operation:'seal',peerConfigPath:peer.identity.configPath,handle,method,target,body,operationId,...(originalRequest?{originalRequest}:{})});return{...sealed,endpoint:'/im/rpc',headers:{'content-type':'application/json'},admin:true};}
  async function operation({key,method,target,body,actor}){
    let state=await journal.read(),op=state.operations.find(row=>row.key===key);const operationId='wg-'+hash([work.workspaceId,work.workId,key]).slice(0,40);
    if(op){assert.equal(op.method,method);assert.deepEqual(op.body,body);assert.equal(op.target,target);}
    else{const prepared=actor?home.prepareRpc(actor.protocol.homeActor,peer.origin,method,{kind:'group',did:target},body,{operationId,messageId:'message-'+operationId}):await prepareAdmin(method,target,body,operationId);assert.equal(prepared.request.params.meta.operation_id,operationId);await journal.update(value=>{value.operations.push({key,method,target,body,operationId,prepared,attempts:[],acceptedAt:null,result:null});});op=(await journal.read()).operations.find(row=>row.key===key);}
    if(op.result)return op.result;
    if(actor)await gate(actor);
    let prepared=op.attempts?.at(-1)?.prepared??op.prepared;const expires=expiry(prepared),now=Math.floor(Date.now()/1000);
    if(expires.originExpiresAt<=now||expires.httpExpiresAt!==null&&expires.httpExpiresAt<=now){
      prepared=await renewPrepared(op.prepared,async originalRequest=>{
        if(op.prepared.admin)return prepareAdmin(method,target,body,operationId,originalRequest);
        const options={operationId,messageId:originalRequest.params.meta.message_id},fresh=home.prepareRpc(actor.protocol.homeActor,peer.origin,method,originalRequest.params.meta.target,body,options);
        fresh.request.id=originalRequest.id;
        return home.prepareRpc(actor.protocol.homeActor,peer.origin,method,originalRequest.params.meta.target,body,{...options,rawBody:JSON.stringify(fresh.request)});
      });
      await journal.update(value=>{const saved=value.operations.find(row=>row.key===key);(saved.attempts??=[]).push({at:new Date().toISOString(),reason:{kind:'authentication-expired',...expires},prepared});});
    }
    const endpoint=prepared.admin?proxyOrigin+prepared.endpoint:prepared.endpoint,headers={...prepared.headers,...(prepared.admin?{authorization:'Bearer '+ownerIdentity.token}:{})};
    try{const response=await fetch(endpoint,{method:'POST',headers,body:prepared.body,redirect:'error'}),reply=await response.json();await wire({phase:'Host-response',key,operationId,request:prepared.request,status:response.status,response:reply});
    if(!response.ok||reply.error)fail(reply.error?.message??'GROUP_HOST_UNAVAILABLE');
    const result=reply.result,groupDid=method==='group.create'?result.group_did:target,receipt=result.group_receipt;
    if(method!=='group.get_info'){assert(receipt,'Actual GroupHost receipt is required');assert.equal(receipt.group_did,groupDid);assert.equal(receipt.subject_method,method);assert.equal(receipt.operation_id,operationId);assert.equal(receipt.actor_did,prepared.request.params.meta.sender_did);assert.equal(receipt.payload_digest,prepared.request.params.auth.origin_proof.contentDigest);assert.equal(receipt.group_state_version,result.group_state_version);assert.equal(receipt.group_event_seq,result.group_event_seq);home.validateReceipt(receipt,await home.resolveDocument(groupDid));}
    await journal.update(value=>{const saved=value.operations.find(row=>row.key===key);saved.result=result;saved.acceptedAt=new Date().toISOString();delete saved.lastError;});return result;}catch(error){await journal.update(value=>{value.operations.find(row=>row.key===key).lastError={at:new Date().toISOString(),code:error.code??'GROUP_CONTROL_UNVERIFIED'};});throw error;}
  }
  async function freshRoster(groupDid,label){const operationId='wg-roster-'+hash([work.workspaceId,work.workId,label,Date.now(),Math.random()]).slice(0,32),prepared=await prepareAdmin('group.get_info',groupDid,{include_policy:true,include_member_list:true},operationId);const response=await fetch(proxyOrigin+'/im/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+ownerIdentity.token},body:prepared.body,redirect:'error'}),reply=await response.json();assert(response.ok&&!reply.error,JSON.stringify(reply));assert.equal(reply.result.group_did,groupDid);assert.equal(reply.result.group_profile.discoverability,'private');assert.equal(reply.result.group_policy.admission_mode,'admin-add');const roster={observedAt:new Date().toISOString(),signed:false,source:'fresh-authenticated-GroupHost-get_info',request:prepared.request,result:reply.result};await journal.update(value=>{value.roster=roster;});return roster;}
  async function bootstrap(){return serial(async()=>{let state=await journal.read();if(!state.groupDid){const created=await operation({key:'create',method:'group.create',target:peer.identity.serviceDid??'did:wba:'+peerConfig.didDomain,body:{group_profile:{display_name:'Private Work '+subject,discoverability:'private'},group_policy:{message_security_profile:'transport-protected',bootstrap_security_profile:'transport-protected',admission_mode:'admin-add',permissions:{send:'member',add:'admin',remove:'admin',update_profile:'admin',update_policy:'owner'},attachments_allowed:false,max_members:String(members.length+1)}}});await journal.update(value=>{value.groupDid=created.group_did;});state=await journal.read();}
    const denied=await removals();for(const actor of members){if(denied.some(row=>row.employeeId===actor.employeeId))continue;await operation({key:'add:'+actor.employeeId,method:'group.add',target:state.groupDid,body:{member_did:actor.protocol.did,role:'member'}});}await freshRoster(state.groupDid,'bootstrap');return snapshot();});}
  async function reconcile(){return serial(async()=>{let state=await journal.read();assert(state.groupDid,'Bootstrap must bind a real group first');for(const removal of await removals()){const actor=members.find(row=>row.employeeId===removal.employeeId),key='remove:'+removal.employeeId+':'+removal.commandId;await journal.update(value=>{if(!value.removals.some(row=>row.commandId===removal.commandId&&row.employeeId===removal.employeeId))value.removals.push({...removal,key,confirmed:false});});
      try{const result=await operation({key,method:'group.remove',target:state.groupDid,body:{member_did:actor.protocol.did}}),roster=await freshRoster(state.groupDid,key);assert(!roster.result.member_list.some(row=>row.member_did===actor.protocol.did&&row.status==='active'));assert(BigInt(roster.result.group_state_version)>=BigInt(result.group_receipt.group_state_version));assert(BigInt(roster.result.group_event_seq)>=BigInt(result.group_receipt.group_event_seq));
      const hostSnapshot=await independent({operation:'snapshot',peerConfigPath:peer.identity.configPath,groupDid:state.groupDid});await appendFile(path.join(root,'host-snapshots.jsonl'),JSON.stringify({observedAt:new Date().toISOString(),...hostSnapshot})+'\n');const calibration=await calibrate({groupDid:state.groupDid,employeeId:actor.employeeId,removal,receipt:result.group_receipt,roster,hostSnapshot});assert.equal(typeof calibration.complete,'boolean');assert(calibration.observedAt&&Array.isArray(calibration.deliveries));await journal.update(value=>{const saved=value.removals.find(row=>row.commandId===removal.commandId&&row.employeeId===actor.employeeId);saved.receipt=result.group_receipt;saved.roster=roster;saved.calibration=calibration;saved.confirmed=calibration.complete;delete saved.error;});}catch(error){await journal.update(value=>{value.removals.find(row=>row.commandId===removal.commandId&&row.employeeId===actor.employeeId).error={at:new Date().toISOString(),code:error.code??'GROUP_RECONCILIATION_UNVERIFIED'};});throw error;}}
    return status();});}
  async function publish({employeeId,locator,eventId}){const actor=members.find(row=>row.employeeId===employeeId);assert(actor&&eventId);assert(typeof locator==='string'&&/^[A-Za-z0-9_-]{12,160}$/.test(locator),'Only an opaque locator is allowed on the group wire');await gate(actor);return serial(async()=>{await gate(actor);const state=await journal.read();assert(state.groupDid);return operation({key:'send:'+employeeId+':'+eventId,method:'group.send',target:state.groupDid,body:{payload:{schema:'geneway.work-group-event/1',locator}},actor});});}
  async function memberStatus(employeeId,removal){
    const state=await journal.read(),actor=members.find(row=>row.employeeId===employeeId);if(!actor||!state.groupDid)return 'unknown';
    const current=(await removals()).find(row=>row.employeeId===employeeId);
    if(!removal)return current||!state.operations.some(row=>row.key==='add:'+employeeId&&row.result?.member_did===actor.protocol.did)||!state.roster?.result.member_list.some(row=>row.member_did===actor.protocol.did&&row.status==='active')?'unknown':'confirmed';
    if(removal.workspaceId!==work.workspaceId||removal.workId!==work.workId||removal.employeeId!==employeeId||current?.commandId!==removal.commandId)return 'unknown';
    const saved=state.removals.find(row=>row.commandId===removal.commandId&&row.employeeId===employeeId);
    if(!saved)return 'pending';
    if(saved.workspaceId!==work.workspaceId||saved.workId!==work.workId||saved.error||state.operations.find(row=>row.key===saved.key)?.lastError)return 'unknown';
    if(!saved.confirmed)return 'pending';
    const receipt=saved.receipt,roster=saved.roster,calibration=saved.calibration;
    if(!receipt||receipt.group_did!==state.groupDid||receipt.operation_id!==state.operations.find(row=>row.key===saved.key)?.operationId||receipt.subject_method!=='group.remove'||!roster||roster.result.group_did!==state.groupDid||roster.result.member_list.some(row=>row.member_did===actor.protocol.did&&row.status==='active')||!calibration?.complete)return 'unknown';
    return 'confirmed';
  }
  async function status(){const state=await journal.read(),denied=await removals();return{candidate:'anp',workspaceId:work.workspaceId,workId:work.workId,configured:!!state.groupDid,members:await Promise.all(members.map(async actor=>{const removal=denied.find(row=>row.employeeId===actor.employeeId);return{employeeId:actor.employeeId,removalCommandId:removal?.commandId??null,status:await memberStatus(actor.employeeId,removal)};}))};}
  async function snapshot(){return{journal:await journal.read(),status:await status()};}
  return{bootstrap,publish,reconcile,sync:reconcile,status,memberStatus,snapshot,async setRemoveBlocked(value){assert.equal(typeof value,'boolean');blocked=value;await journal.update(state=>{state.removeBlocked=value;});if(!value){release?.();release=undefined;}else newBlock();},waitRemoveBlocked(){return waitBlock;},async close(){closed=true;release?.();for(const socket of sockets)socket.destroy();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));await queue;}};
}
