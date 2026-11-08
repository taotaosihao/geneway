import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import { startAnpHome } from './adapters/anp/home.mjs';
import { startAnpPeer,peerCommand } from './peers/anp/run.mjs';
const root=await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-anp-');let home,peer;
async function until(check,label){const deadline=Date.now()+20000;for(;;){const value=await check();if(value)return value;if(Date.now()>deadline)throw Error(label);await new Promise(resolve=>setTimeout(resolve,50));}}
try{
  home=await startAnpHome({root:path.join(root,'adapter'),didDomain:'geneway-comparison.test'});
  peer=await startAnpPeer({root:path.join(root,'peer'),didDomain:'independent-comparison.test',resolverBaseUrls:{'geneway-comparison.test':home.origin}});home.configurePeer('independent-comparison.test',peer.origin);
  await writeFile(path.join(root,'process-start.json'),JSON.stringify({root,adapterPid:process.pid,peerPid:peer.child.pid,homeOrigin:home.origin,peerOrigin:peer.origin},null,2));
  const identity=await peerCommand(peer,{operation:'identity',handle:'peer-owner'});
  const created=await peerCommand(peer,{operation:'rpc',handle:'peer-owner',method:'group.create',operationId:'peer-create',body:{group_profile:{display_name:'独立真实群',discoverability:'public'},group_policy:{message_security_profile:'transport-protected',bootstrap_security_profile:'transport-protected',admission_mode:'open-join',permissions:{send:'member',add:'admin',remove:'admin',update_profile:'admin',update_policy:'owner'},attachments_allowed:false,max_members:'100'}}});
  const groupDid=created.group_did;assert(groupDid);
  const join=await home.rpc('coordinator',peer.origin,'group.join',{kind:'group',did:groupDid}, {},{operationId:'adapter-join'});assert(!join.error,JSON.stringify(join));
  const info=await home.rpc('coordinator',peer.origin,'group.get_info',{kind:'group',did:groupDid},{},{operationId:'adapter-info'});assert(!info.error,JSON.stringify(info));
  const forward=await home.rpc('coordinator',peer.origin,'group.send',{kind:'group',did:groupDid},{payload:{kind:'preflight',text:'Geneway TS真实签名→独立Python Host'}},{operationId:'adapter-send',messageId:'adapter-message'});assert(!forward.error,JSON.stringify(forward));
  const reverse=await peerCommand(peer,{operation:'rpc',handle:'peer-owner',method:'group.send',target:groupDid,operationId:'peer-reverse-send',messageId:'peer-reverse-message',body:{payload:{kind:'preflight',text:'独立Python Host→Geneway TS真实校验'}}});
  const incoming=await until(()=>home.received.find(row=>row.rpc.method==='group.incoming'&&row.rpc.params.meta.message_id==='peer-reverse-message'),'Actual independent peer incoming was not delivered/verified');
  assert(incoming.httpSignatureVerified);assert(incoming.originProofVerified);assert(incoming.groupReceiptVerified);
  const listed=await peerCommand(peer,{operation:'rpc',handle:'peer-owner',method:'group.list_messages',parameters:{group_did:groupDid}});assert(listed.messages.some(row=>row.message_id==='adapter-message'));
  const result={result:'passed',root,sdk:'0.9.5',peer:peer.versions,groupDid,created,join,info,forward,reverse,incoming,listed,boundary:'Minimal X01/X09 actual TS SDK origin/HTTP signatures and independent pinned AWiki GroupHost. Local resolver-map HTTP test transport, not public TLS/two-egress or full Profiles/X01-X10.'};await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({result:'passed',root,groupDid,peerPid:peer.child.pid,actualVerifiedIncoming:true}));
}catch(error){await writeFile(path.join(root,'failure.json'),JSON.stringify({message:error.message,stack:error.stack},null,2));console.error(root,error);process.exitCode=1;}
finally{if(peer)await peer.close();if(home)await home.close();}
