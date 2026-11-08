import { createServer } from 'node:https';
import { readFile,writeFile,mkdir,appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createLocalCertificate } from '../common/wire.mjs';

// The experiment changes only the application-command wire. The production
// Bridge remains the sole authority for node credentials, grants and commits.
export async function startNormalRelay({candidate,root,backendOrigin,stateFile,recoveryCase}) {
  await mkdir(root,{recursive:true});const tls=await createLocalCertificate(path.join(root,'tls')),pending=new Map(),sealedRequests=new Map();let home,peer,handler,transport,origin,sequence=0;
  async function backend(headers,command){
    const response=await fetch(backendOrigin+'/internal/agent/commands',{method:'POST',headers:{'content-type':'application/json',authorization:headers.authorization,'x-geneway-node-instance':headers['x-geneway-node-instance'],'x-geneway-host-run':headers['x-geneway-host-run']},body:JSON.stringify(command),signal:AbortSignal.timeout(20000)});
    return{status:response.status,body:await response.json()};
  }
  const {DefaultRequestHandler,JsonRpcTransportHandler,ServerCallContext,AgentEvent,validateVersion}=candidate==='a2a'?await import('@a2a-js/sdk/server'):{};
  let lostCommand;
  const target=command=>recoveryCase==='result-reply'&&command?.binding?.agent_id==='desktop-data'&&command.operation==='complete_delegation'&&command.parameters?.clientRequestId==='complete';
  const snapshot=async(name,command,reply)=>writeFile(path.join(root,'recovery-'+name+'.json'),JSON.stringify({at:new Date().toISOString(),command,reply,state:JSON.parse(await readFile(stateFile))},null,2));
  const event=value=>appendFile(path.join(root,'recovery-events.jsonl'),JSON.stringify({at:new Date().toISOString(),...value})+'\n');
  async function acceptedReceipt(command){
    const state=JSON.parse(await readFile(stateFile));return state.multisite.commands.find(row=>row.issuerKind==='agent'&&row.issuerId===command.binding.attempt_id&&row.commandId===command.parameters.clientRequestId&&Object.entries(row.senderBinding).every(([name,value])=>command.binding[name]===value));
  }
  if(candidate==='anp'){
    const {startAnpHome}=await import('./anp/home.mjs'),{startAnpPeer,peerCommand}=await import('../peers/anp/run.mjs');
    home=await startAnpHome({root:path.join(root,'home'),didDomain:'geneway-normal-flow.test',onIncoming:async record=>{
      if(record.rpc.method!=='group.incoming')return;const {meta,body}=record.rpc.params,payload=body.payload;if(!payload?.requestId)return;
      const item=pending.get(payload.requestId);if(!item)return;
      if(['geneway.command.request/1','geneway.command.result-query/1'].includes(payload.kind)&&meta.target.did===home.identities.get('coordinator').didDocument.id){
        assert.equal(meta.sender_did,home.identities.get(item.actor).didDocument.id);assert.equal(payload.actor,item.actor);assert.equal(payload.commandDigest,item.commandDigest);if(item.started)return;item.started=true;
        const reply=await backend(item.headers,item.command);item.reply=reply;item.responseRef=randomUUID();
        const sent=await home.rpc('coordinator',peer.origin,'group.send',{kind:'group',did:item.groupDid},{payload:{kind:'geneway.command.response/1',requestId:payload.requestId,actor:item.actor,commandDigest:item.commandDigest,responseRef:item.responseRef}},{operationId:'response-'+payload.requestId,messageId:'response-'+payload.requestId});
        if(sent.error)throw Error(JSON.stringify(sent));
      }else if(payload.kind==='geneway.command.response/1'&&meta.target.did===home.identities.get(item.actor).didDocument.id){assert.equal(meta.sender_did,home.identities.get('coordinator').didDocument.id);assert.equal(payload.commandDigest,item.commandDigest);assert.equal(payload.responseRef,item.responseRef);assert(item.reply);item.resolve(item.reply);}
    }});
    peer=await startAnpPeer({root:path.join(root,'independent-group-peer'),didDomain:'normal-group-peer.test',resolverBaseUrls:{'geneway-normal-flow.test':home.origin}});home.configurePeer('normal-group-peer.test',peer.origin);
    await peerCommand(peer,{operation:'identity',handle:'independent-owner'});
    const created=await peerCommand(peer,{operation:'rpc',handle:'independent-owner',method:'group.create',operationId:'normal-group-create',body:{group_profile:{display_name:'Geneway正常五角色本地实验',discoverability:'public'},group_policy:{message_security_profile:'transport-protected',bootstrap_security_profile:'transport-protected',admission_mode:'open-join',permissions:{send:'member',add:'admin',remove:'admin',update_profile:'admin',update_policy:'owner'},attachments_allowed:false,max_members:'100'}}});
    const groupDid=created.group_did;
    for(const actor of ['coordinator','desktop-office','desktop-data','gateway','analysis']){const joined=await home.rpc(actor,peer.origin,'group.join',{kind:'group',did:groupDid},{},{operationId:'normal-join-'+actor});assert(!joined.error,JSON.stringify(joined));}
    await writeFile(path.join(root,'group.json'),JSON.stringify({created,groupDid,memberDids:Object.fromEntries([...home.identities].filter(([actor])=>actor!=='owner').map(([actor,bundle])=>[actor,bundle.didDocument.id]))},null,2));
    home.normalGroupDid=groupDid;
  }
  const server=createServer({key:await readFile(tls.keyFile),cert:await readFile(tls.certFile)},async(request,response)=>{
    let raw='';const at=new Date().toISOString();
    try{
      if(candidate==='a2a'&&request.method==='GET'&&request.url==='/.well-known/agent-card.json'){response.writeHead(200,{'content-type':'application/json'});return response.end(JSON.stringify(await handler.getAgentCard()));}
      for await(const chunk of request){raw+=chunk;if(Buffer.byteLength(raw)>1048576)throw Error('Too large');}const value=JSON.parse(raw);
      let reply;
      if(candidate==='a2a'){
        validateVersion(request.headers['a2a-version']??'0.3',await handler.getAgentCard(),'JSONRPC');
        reply=await transport.handle(value,new ServerCallContext({requestedVersion:request.headers['a2a-version'],user:{isAuthenticated:true,userName:'node-credential-validated-by-domain'},state:new Map([['headers',request.headers]])}));
      }else{
        const actor=value.binding?.agent_id;assert(home.identities.has(actor)&&actor!=='owner');
        // Admission uses the original current execution credential; group membership
        // alone never grants a Work tool or transfers secrets to a group payload.
        const admitted=await fetch(backendOrigin+'/internal/executions/authorize',{method:'POST',headers:{'content-type':'application/json',authorization:request.headers.authorization,'x-geneway-node-instance':request.headers['x-geneway-node-instance'],'x-geneway-host-run':request.headers['x-geneway-host-run']},body:JSON.stringify({binding:value.binding}),signal:AbortSignal.timeout(8000)});
        if(!admitted.ok&&!(recoveryCase==='result-reply'&&await acceptedReceipt(value))){response.writeHead(admitted.status,{'content-type':'application/json'});return response.end(await admitted.text());}
        const requestId=randomUUID();let resolve,reject;const completed=new Promise((a,b)=>{resolve=a;reject=b});const commandDigest=createHash('sha256').update(raw).digest('hex');pending.set(requestId,{actor,headers:request.headers,command:value,commandDigest,groupDid:home.normalGroupDid,resolve,reject,started:false});
        try{
          const logicalKey=JSON.stringify([value.binding,value.operation,value.parameters.clientRequestId]),previous=sealedRequests.get(logicalKey);let kind='geneway.command.request/1';
          if(previous&&target(value)){
            const replay=await home.rpc(actor,peer.origin,'group.send',{kind:'group',did:home.normalGroupDid},{},{rawBody:previous.rawBody});assert(!replay.error,JSON.stringify(replay));
            assert.deepEqual(replay.request,previous.request);await event({type:'p4-exact-replay',request:previous.request,replayedRequest:replay.request,originalReceipt:previous.result,replayedReceipt:replay.result});kind='geneway.command.result-query/1';
          }
          const sent=await home.rpc(actor,peer.origin,'group.send',{kind:'group',did:home.normalGroupDid},{payload:{kind,requestId,actor,commandDigest}},{operationId:(kind==='geneway.command.result-query/1'?'result-query-':'request-')+requestId,messageId:(kind==='geneway.command.result-query/1'?'result-query-':'request-')+requestId});if(sent.error)throw Error(JSON.stringify(sent));
          if(!previous)sealedRequests.set(logicalKey,sent);if(kind==='geneway.command.result-query/1')await event({type:'new-result-query',request:sent.request,hostReceipt:sent.result});
          const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);try{reply=await Promise.race([completed,new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Group application response not delivered')),{once:true}))]);}finally{clearTimeout(timeout);}
        }finally{pending.delete(requestId);}
      }
      const command=candidate==='a2a'?value.params?.message?.parts?.find(part=>part.data)?.data:value;
      const domainReply=candidate==='a2a'?(reply?.result?.message??reply?.result)?.parts?.find(part=>part.data)?.data:reply;
      if(target(command)&&domainReply?.status===200){
        if(!lostCommand){lostCommand=structuredClone(command);await snapshot('committed',command,domainReply);assert(domainReply.body.resultId);await event({type:'committed-response-dropped',command,reply:domainReply,credentialSha256:createHash('sha256').update(request.headers.authorization??'').digest('hex'),nodeInstanceId:request.headers['x-geneway-node-instance'],hostRunId:request.headers['x-geneway-host-run']});response.destroy();return;}
        if(JSON.stringify(command)===JSON.stringify(lostCommand)){await snapshot('replayed',command,domainReply);await event({type:'exact-result-returned',command,reply:domainReply});}
      }
      if(target(command)&&domainReply?.status===409){await snapshot('conflict',command,domainReply);await event({type:'changed-summary-conflict',command,reply:domainReply});}
      const text=JSON.stringify(reply);response.writeHead(candidate==='a2a'?200:reply.status,{'content-type':'application/json'});response.end(candidate==='a2a'?text:JSON.stringify(reply.body));
      await appendFile(path.join(root,'application-wire.jsonl'),JSON.stringify({id:'exchange-'+ ++sequence,at,candidate,request:value,response:reply,requestBytes:Buffer.byteLength(raw),responseBytes:Buffer.byteLength(text)})+'\n');
    }catch(error){await appendFile(path.join(root,'errors.jsonl'),JSON.stringify({at,message:error.message,stack:error.stack})+'\n');if(!response.headersSent){response.writeHead(502,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'PROTOCOL_RELAY_UNAVAILABLE',message:error.message}}));}else response.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});origin=`https://127.0.0.1:${server.address().port}`;
  if(candidate==='a2a'){
    const card={name:'Geneway experimental application command relay',description:'JSON-RPC v1 Message-only application commands; original domain validates execution.',version:'1.0.0',supportedInterfaces:[{url:origin+'/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0',tenant:''}],capabilities:{streaming:false,pushNotifications:false},securitySchemes:{bearer:{httpAuthSecurityScheme:{scheme:'Bearer'}}},securityRequirements:[{schemes:{bearer:[]}}],defaultInputModes:['application/json'],defaultOutputModes:['application/json'],skills:[{id:'geneway-execution-command',name:'Current bound execution command',description:'Original Geneway execution policy applies',tags:['experimental'],examples:[]}],signatures:[]};
    const executor={async execute(context,bus){const command=context.userMessage.parts.find(part=>part.content?.$case==='data')?.content.value;assert(command);const reply=await backend(context.context.state.get('headers'),command);bus.publish(AgentEvent.message({messageId:'reply-'+context.userMessage.messageId,contextId:context.contextId,taskId:'',role:2,parts:[{content:{$case:'data',value:reply},mediaType:'application/json',filename:''}],extensions:[],referenceTaskIds:[]}));bus.finished();},async cancelTask(){throw Error('Relay does not advertise protocol Tasks');}};
    const store={async load(){return undefined},async save(){throw Error('No Task authority in Message relay')},async list(){return{tasks:[],nextPageToken:'',totalSize:0,pageSize:0}}};handler=new DefaultRequestHandler(card,store,executor);transport=new JsonRpcTransportHandler(handler);await writeFile(path.join(root,'agent-card.json'),JSON.stringify(card,null,2));
  }
  const info={candidate,origin,caFile:tls.certFile,pid:process.pid,backendOrigin,peerPid:peer?.child.pid??null,scope:'experimental application-command wire only; production Bridge/model/file transports retained'};await writeFile(path.join(root,'relay-ready.json'),JSON.stringify(info,null,2));
  return{...info,getAnpContext(){return{home,peer}},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(peer)await peer.close();if(home)await home.close();}};
}
