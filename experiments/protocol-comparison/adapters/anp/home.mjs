import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as sdk from '@awiki/anp-typescript-sdk';
import bs58 from 'bs58';
import { fixture, digest } from '../../common/fixture.mjs';

const profiles = ['anp.core.binding.v1','anp.identity.discovery.v1','anp.direct.base.v1','anp.group.base.v2'];
const contentTypes = ['text/plain','application/json','application/anp-attachment-manifest+json'];
const json = (response,status,value) => { response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value)); };
function documentPath(did) { const components=did.slice('did:wba:'.length).split(':');components.shift();return components.length?'/'+components.map(decodeURIComponent).join('/')+'/did.json':'/.well-known/did.json'; }
export async function startAnpHome({ root, didDomain, port=0, resolverBaseUrls={}, onIncoming, admitIncoming, openExisting=false }) {
  await mkdir(root,{recursive:true});const documents=new Map(),identities=new Map(),received=[],listeners=[],httpHandlers=[],peers=new Map(Object.entries(resolverBaseUrls));let origin;
  let service;
  try { service=JSON.parse(await readFile(path.join(root,'service-identity.json'))); } catch(error) { if(error.code!=='ENOENT'||openExisting)throw error; service=sdk.createDidWbaDocument(didDomain,{enableE2ee:false}); }
  const serviceDid=service.didDocument.id;assert.equal(serviceDid,'did:wba:'+didDomain);if(openExisting){assert(port>0);try{for(const line of(await readFile(path.join(root,'incoming.jsonl'),'utf8')).trim().split('\n').filter(Boolean))received.push(JSON.parse(line));}catch(error){if(error.code!=='ENOENT')throw error;}}
  async function resolveDocument(did) {
    if(documents.has(did))return documents.get(did);
    assert(did.startsWith('did:wba:'),'Only the pinned DID method is supported');const domain=did.slice(8).split(':')[0],base=peers.get(domain);assert(base,'No configured local test resolver for '+domain);
    const response=await fetch(base+documentPath(did),{signal:AbortSignal.timeout(5000)});assert(response.ok,`DID resolution HTTP ${response.status}`);const document=await response.json();assert.equal(document.id,did);assert(sdk.validateDidDocumentBinding(document,true),'Invalid DID binding/proof');return document;
  }
  function validateReceipt(receipt,document) {
    assert(receipt&&receipt.group_did===document.id);assert.equal(receipt.proof?.proofPurpose,'assertionMethod');const method=sdk.findVerificationMethod(document,receipt.proof.verificationMethod);assert(method);assert(sdk.isAssertionMethodAuthorized(document,method.id));assert.equal(receipt.proof.type,'DataIntegrityProof');assert.equal(receipt.proof.cryptosuite,'eddsa-jcs-2022');assert(receipt.proof.proofValue.startsWith('z'),'Appendix B requires multibase');
    // SDK 0.9.5 generic W3C verifier accepts base64url, while P1 Appendix B uses
    // base58btc. Only the signature encoding is normalized in a verification copy;
    // the protected receipt, proof options and stored wire remain unchanged.
    const signatureBytes=bs58.decode(receipt.proof.proofValue.slice(1));assert.equal(signatureBytes.length,64);
    const verificationCopy={...receipt,proof:{...receipt.proof,proofValue:Buffer.from(signatureBytes).toString('base64url')}};
    assert(sdk.verifyW3cProof(verificationCopy,sdk.extractPublicKey(method),{expectedPurpose:'assertionMethod'}),'Invalid group receipt signature');
    return true;
  }
  const server=createServer(async(request,response)=>{
    let body='';const at=new Date().toISOString();
    try {
      const url=new URL(request.url,origin);
      for(const handler of httpHandlers)if(await handler(request,response))return;
      if(request.method==='GET') { const doc=[...documents.values()].find(item=>documentPath(item.id)===url.pathname);return doc?json(response,200,doc):json(response,404,{error:'NOT_FOUND'}); }
      if(request.method!=='POST'||url.pathname!=='/anp-im/rpc')return json(response,404,{error:'NOT_FOUND'});
      for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>262144)throw Error('Request too large');}
      const rpc=JSON.parse(body),{meta={},body:payload={},auth={}}=rpc.params??{};
      if(rpc.method==='anp.get_capabilities')return json(response,200,{jsonrpc:'2.0',id:rpc.id,result:{service_did:serviceDid,profiles,supported_profiles:profiles,security_profiles:['transport-protected'],supported_content_types:contentTypes,methods:{'direct.incoming':{kind:'notification'},'group.incoming':{kind:'notification'},'group.state_changed':{kind:'notification'}},role:'Geneway application Home client, not a replacement GroupHost'}});
      assert(['group.incoming','group.state_changed','direct.incoming'].includes(rpc.method),'Unsupported method');assert.equal(rpc.jsonrpc,'2.0');assert.equal(rpc.id,undefined,'Incoming is a notification');assert.equal(meta.target?.kind,'agent');assert(documents.has(meta.target.did),'Unknown local recipient');assert(contentTypes.includes(meta.content_type),'Unsupported media type');
      const signature=sdk.extractSignatureMetadata(request.headers),httpDid=signature.keyid.split('#')[0],httpDocument=await resolveDocument(httpDid);
      assert(httpDocument.authentication.includes(signature.keyid),'HTTP key is not authorized');sdk.verifyHttpMessageSignature(httpDocument,'POST',origin+'/anp-im/rpc',request.headers,body);
      let receipt=null,originVerification=null;
      if(rpc.method==='group.incoming'||rpc.method==='group.state_changed') {
        const groupDocument=await resolveDocument(payload.group_did),groupService=groupDocument.service?.find(item=>item.type==='ANPMessageService');assert.equal(groupService?.serviceDid,httpDid);receipt=payload.group_receipt;validateReceipt(receipt,groupDocument);
        assert.equal(receipt.group_event_seq,payload.group_event_seq);assert.equal(receipt.group_state_version,payload.group_state_version);assert.equal(receipt.operation_id,meta.operation_id);
        if(rpc.method==='group.incoming') {
          const originalBody=Object.fromEntries(Object.entries(payload).filter(([key])=>!['group_did','group_state_version','group_event_seq','accepted_at','group_receipt'].includes(key))),originalMeta={...meta,target:{kind:'group',did:payload.group_did}};
          assert.equal(receipt.actor_did,meta.sender_did);assert.equal(receipt.message_id,meta.message_id);assert.equal(receipt.payload_digest,auth.origin_proof?.contentDigest);
          originVerification=sdk.verifyRfc9421OriginProof(auth.origin_proof,'group.send',originalMeta,originalBody,{didDocument:await resolveDocument(meta.sender_did),options:{expectedSignerDid:meta.sender_did}});
        }else{assert.equal(meta.sender_did,payload.group_did);}
      }else{
        const senderDocument=await resolveDocument(meta.sender_did),senderService=senderDocument.service?.find(item=>item.type==='ANPMessageService');assert.equal(senderService?.serviceDid,httpDid);originVerification=sdk.verifyRfc9421OriginProof(auth.origin_proof,'direct.send',meta,payload,{didDocument:senderDocument,options:{expectedSignerDid:meta.sender_did}});
      }
      const key=[rpc.method,meta.target.did,meta.operation_id].join('/'),old=received.find(row=>row.key===key),requestDigest=digest(rpc);
      if(old)assert.equal(old.requestDigest,requestDigest,'Duplicate conflict');else{
        const record={key,at,requestDigest,rpc,httpSignerDid:httpDid,httpSignatureVerified:true,originProofVerified:!!originVerification,groupReceiptVerified:!!receipt,...(admitIncoming?{signedRequest:{method:'POST',url:origin+'/anp-im/rpc',headers:Object.fromEntries(['signature','signature-input','content-digest','content-type'].filter(name=>request.headers[name]!==undefined).map(name=>[name,request.headers[name]])),body}}:{})};if(admitIncoming&&await admitIncoming(record)!==true){await appendFile(path.join(root,'ignored-incoming.jsonl'),JSON.stringify({key,at,requestDigest,method:rpc.method,targetDid:meta.target.did,reason:'UNSUPPORTED_WORK_GROUP_DELIVERY'})+'\n');response.writeHead(204);response.end();return;}received.push(record);await appendFile(path.join(root,'incoming.jsonl'),JSON.stringify(record)+'\n');await onIncoming?.(record);for(const listener of listeners)await listener(record);
      }
      response.writeHead(204);response.end();
      await appendFile(path.join(root,'wire.jsonl'),JSON.stringify({at,direction:'inbound',from:httpDid,request:rpc,status:204,requestBytes:Buffer.byteLength(body)})+'\n');
    }catch(error){await appendFile(path.join(root,'rejected.jsonl'),JSON.stringify({at,message:error.message,...(admitIncoming?{requestDigest:digest(body)}:{requestBody:body})})+'\n');json(response,400,{error:{code:'INVALID_REQUEST',message:error.message}});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});origin=`http://127.0.0.1:${server.address().port}`;
  function withService(bundle){if(openExisting){assert.equal(bundle.didDocument.service.find(item=>item.type==='ANPMessageService').serviceEndpoint,origin+'/anp-im/rpc');assert(sdk.validateDidDocumentBinding(bundle.didDocument,true));documents.set(bundle.didDocument.id,bundle.didDocument);return bundle;}const document={...bundle.didDocument};delete document.proof;document.service=[sdk.buildAnpMessageService(document.id,origin+'/anp-im/rpc',{serviceDid,profiles,securityProfiles:['transport-protected']})];bundle.didDocument=sdk.generateW3cProof(document,bundle.keys['key-1'].privateKeyPem,document.id+'#key-1',{proofType:'DataIntegrityProof',cryptosuite:'eddsa-jcs-2022',proofPurpose:'assertionMethod'});documents.set(document.id,bundle.didDocument);return bundle;}
  service=withService(service);if(!openExisting)await writeFile(path.join(root,'service-identity.json'),JSON.stringify(service,null,2),{mode:0o600});
  for(const actor of ['owner',...fixture.agents.map(row=>row.id)]){
    let bundle;try{bundle=JSON.parse(await readFile(path.join(root,actor+'-identity.json')));}catch(error){if(error.code!=='ENOENT'||openExisting)throw error;bundle=sdk.createDidWbaDocument(didDomain,{pathSegments:['users',actor],enableE2ee:false});}bundle=withService(bundle);identities.set(actor,bundle);if(!openExisting)await writeFile(path.join(root,actor+'-identity.json'),JSON.stringify(bundle,null,2),{mode:0o600});
  }
  function prepareRpc(actor,peerOrigin,method,target,body,{operationId=randomUUID(),messageId,rawBody,headers:extraHeaders={}}={}) {
    const identity=identities.get(actor);assert(identity,'Unknown actor');const meta={profile:method.startsWith('group.')?'anp.group.base.v2':'anp.direct.base.v1',security_profile:'transport-protected',sender_did:identity.didDocument.id,target,operation_id:operationId,content_type:'application/json'};if(method.endsWith('.send'))meta.message_id=messageId??'message-'+operationId;
    const auth={scheme:'anp-rfc9421-origin-proof-v1',origin_proof:sdk.generateRfc9421OriginProof(method,meta,body,identity.keys['key-1'].privateKeyPem,identity.didDocument.id+'#key-1',{created:Math.floor(Date.now()/1000),expires:Math.floor(Date.now()/1000)+300,nonce:randomUUID()})};
    const envelope={jsonrpc:'2.0',id:randomUUID(),method,params:{meta,body,auth}},bytes=rawBody??JSON.stringify(envelope),endpoint=peerOrigin+'/anp-im/rpc',headers=sdk.generateHttpSignatureHeaders(service.didDocument,endpoint,'POST',service.keys['key-1'].privateKeyPem,{'Content-Type':'application/json'},bytes);
    const request=JSON.parse(bytes);assert.equal(request.method,method);assert.equal(request.params.meta.sender_did,identity.didDocument.id);assert.equal(request.params.meta.target.did,target.did);
    return {endpoint,body:bytes,headers:{'Content-Type':'application/json',...headers,...extraHeaders},request};
  }
  async function rpc(actor,peerOrigin,method,target,body,options={}) {
    const prepared=prepareRpc(actor,peerOrigin,method,target,body,options),bytes=prepared.body;
    const response=await fetch(prepared.endpoint,{method:'POST',headers:prepared.headers,body:bytes,signal:AbortSignal.timeout(15000)}),result=await response.json();
    await appendFile(path.join(root,'wire.jsonl'),JSON.stringify({at:new Date().toISOString(),direction:'outbound',actor,request:prepared.request,requestBytes:Buffer.byteLength(bytes),status:response.status,response:result,responseBytes:Buffer.byteLength(JSON.stringify(result))})+'\n');
    return {httpStatus:response.status,...result,request:prepared.request,rawBody:bytes};
  }
  return {origin,serviceDid,serviceDocument:service.didDocument,identities,received,resolveDocument,validateReceipt,prepareRpc,rpc,subscribe(listener){listeners.push(listener);return()=>listeners.splice(listeners.indexOf(listener),1);},handleHttp(handler){httpHandlers.push(handler);return()=>httpHandlers.splice(httpHandlers.indexOf(handler),1);},configurePeer(domain,base){peers.set(domain,base)},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
