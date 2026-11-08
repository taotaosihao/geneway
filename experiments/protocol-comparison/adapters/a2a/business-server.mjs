import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFile,writeFile,appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { AgentCard,TaskState } from '@a2a-js/sdk';
import { DefaultRequestHandler,JsonRpcTransportHandler,ServerCallContext,AgentEvent,validateVersion } from '@a2a-js/sdk/server';
import { TaskNotCancelableError } from '@a2a-js/sdk/errors';
import { createLocalCertificate } from '../../common/wire.mjs';
const states={'submitted':1,'working':2,'completed':3,'failed':4,'canceled':5,'input-required':6};
export async function startBusinessA2a({root,tasks,principal,openExisting=false,port=0,allowCancel=false}){
  const tokenFile=path.join(root,'peer-token'),tls=openExisting?{keyFile:path.join(root,'tls/server.key.pem'),certFile:path.join(root,'tls/server.cert.pem')}:await createLocalCertificate(path.join(root,'tls'));
  if(openExisting)assert(Number.isInteger(port)&&port>0,'Reopen requires original endpoint');
  const token=openExisting?await readFile(tokenFile,'utf8'):randomBytes(32).toString('base64url');if(!openExisting)await writeFile(tokenFile,token,{mode:0o600});
  const grant={principal,businessActorId:'owner',credentialSha256:(await import('node:crypto')).createHash('sha256').update(token).digest('hex'),scope:['create','input','query','download-own-task',...(allowCancel?['cancel-own-task']:[])],source:'Explicit isolated fixture owner prebinding; ROLE_USER is not authorization'};
  if(openExisting)assert.deepEqual(JSON.parse(await readFile(path.join(root,'principal-grant.json'))),grant,'Reopen cannot grant another principal');let origin,transport,card;
  const observed=new Map();
  async function projection(id,receipt){
    const task=await tasks.project(principal,id,{artifactUrl:localId=>origin+'/business/tasks/'+encodeURIComponent(id)+'/artifacts/'+encodeURIComponent(localId),businessReceipt:receipt});
    const projected={id:task.id,contextId:task.contextId,status:{state:states[task.state],timestamp:task.statusTimestamp},artifacts:task.artifacts.map(artifact=>({artifactId:artifact.artifactId,name:artifact.name,description:'Original ready artifact from the mapped Work',parts:[{content:{$case:'url',value:artifact.url},mediaType:artifact.mediaType,filename:artifact.name}],metadata:{globalRef:artifact.globalRef,sha256:artifact.sha256,sizeBytes:artifact.sizeBytes},extensions:[]})),history:[],metadata:task.metadata};
    const signature=JSON.stringify([projected.status,projected.metadata.geneway.projectionDigest]);if(!observed.has(id))observed.set(id,new Set());observed.get(id).add(signature);return projected;
  }
  const store={async load(id){try{return await projection(id);}catch(error){if(['NOT_FOUND','FORBIDDEN','UNAUTHORIZED'].includes(error.code))return undefined;throw error;}},async save(task){
    // SDK saves are only projection acknowledgements. They never update Work or
    // invent terminal state, including the fixed no-event-bus CancelTask path.
    const current=await projection(task.id),signature=JSON.stringify([task.status,task.metadata?.geneway?.projectionDigest]);
    if(!observed.get(task.id)?.has(signature))throw Error('Unproven protocol Task save');
    return undefined;
  },async list(){return{tasks:[],nextPageToken:'',pageSize:0,totalSize:0};}};
  const executor={async execute(context,bus){const task=await projection(context.taskId,context.context.state.get('businessReceipt'));bus.publish(AgentEvent.task(task));bus.finished();},async cancelTask(){throw new TaskNotCancelableError('Requires the original explicit business cancellation and stop confirmation');}};
  const server=createServer({key:await readFile(tls.keyFile),cert:await readFile(tls.certFile)},async(request,response)=>{
    let body='',rpc;const at=new Date().toISOString();
    const json=(status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
    try{
      if(request.method==='GET'&&request.url==='/.well-known/agent-card.json')return json(200,AgentCard.toJSON(card));
      const actual=Buffer.from(request.headers.authorization?.replace(/^Bearer /,'')??''),expected=Buffer.from(token);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return json(401,{error:{code:'UNAUTHORIZED'}});
      const download=/^\/business\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(request.url);
      if(request.method==='GET'&&download){const file=await tasks.download(principal,decodeURIComponent(download[1]),decodeURIComponent(download[2]));response.writeHead(200,{'content-type':file.mediaType,'content-length':file.bytes.length});response.end(file.bytes);await appendFile(path.join(root,'downloads.jsonl'),JSON.stringify({at,principal,taskId:download[1],artifactId:download[2],globalRef:file.artifact.globalRef,sha256:file.artifact.sha256,bytes:file.bytes.length})+'\n');return;}
      assert.equal(request.method,'POST');assert.equal(request.url,'/a2a');for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>1048576)throw Error('Too large');}rpc=JSON.parse(body);const originalRequest=structuredClone(rpc);validateVersion(request.headers['a2a-version']??'0.3',card,'JSONRPC');
      let receipt;
      if(rpc.method==='SendMessage'){
        const value=rpc.params?.message?.parts?.find(part=>part.data)?.data;assert.equal(value?.schema,'geneway.protocol-task/1');
        let row;if(value.operation==='create')row=await tasks.create(principal,value.clientRequestId,value.parameters);
        else if(value.operation==='input'){const id=rpc.params.message.taskId;receipt=await tasks.input(principal,id,rpc.params.message.contextId,value.clientRequestId,value.parameters);row=tasks.find(id,principal);}
        else throw Error('Unsupported business operation');
        rpc.params.message.taskId=row.protocolTaskId;rpc.params.message.contextId=row.contextId;receipt??=row.businessReceipt;
      }
      const context=new ServerCallContext({requestedVersion:request.headers['a2a-version'],user:{isAuthenticated:true,userName:principal},state:new Map([['headers',request.headers],['businessReceipt',receipt]])});
      const result=await transport.handle(rpc,context);assert(!result?.[Symbol.asyncIterator],'This business entry does not advertise streaming');json(200,result);
      await appendFile(path.join(root,'wire.jsonl'),JSON.stringify({at,principal,version:request.headers['a2a-version'],request:originalRequest,response:result,requestBytes:Buffer.byteLength(body),responseBytes:Buffer.byteLength(JSON.stringify(result))})+'\n');
    }catch(error){await appendFile(path.join(root,'errors.jsonl'),JSON.stringify({at,message:error.message,stack:error.stack,method:rpc?.method})+'\n');if(!response.headersSent)json(400,{error:{code:error.code??'INVALID_REQUEST',message:error.message}});else response.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});origin=`https://127.0.0.1:${server.address().port}`;
  card={name:'Geneway normal business Task experiment',description:'Actual current Work/root binding and original ready artifact; explicit isolated owner principal grant.',version:'1.0.0',supportedInterfaces:[{url:origin+'/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0',tenant:''}],capabilities:{streaming:false,pushNotifications:false},securitySchemes:{peerBearer:{scheme:{$case:'httpAuthSecurityScheme',value:{scheme:'Bearer',bearerFormat:'opaque'}}}},securityRequirements:[{schemes:{peerBearer:{list:[]}}}],defaultInputModes:['application/json'],defaultOutputModes:['application/json'],skills:[{id:'geneway-normal-business',name:'Create and query an authorized Work',description:'Same Task input and original ready file',tags:['experimental'],examples:[],inputModes:['application/json'],outputModes:['application/json']}],signatures:[]};
  const handler=new DefaultRequestHandler(card,store,executor);
  // The fixed SDK's no-event-bus branch forces CANCELED via TaskStore.save.
  // Replace the whole transport-facing cancel path: only the original Work stop
  // transaction and its committed state may determine terminal cancellation.
  handler.cancelTask=async(params)=>{if(!allowCancel)throw new TaskNotCancelableError('This original principal grant does not allow cancellation');const receipt=await tasks.cancel(principal,params.id);return projection(params.id,receipt);};
  transport=new JsonRpcTransportHandler(handler);
  if(!openExisting)await writeFile(path.join(root,'principal-grant.json'),JSON.stringify(grant,null,2));
  return{origin,tokenFile,caFile:tls.certFile,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
