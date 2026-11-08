import { createHmac, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentCard, Task, TaskState } from '@a2a-js/sdk'
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server'
import { RequestMalformedError, TaskNotFoundError, TaskNotCancelableError, UnsupportedOperationError, PushNotificationNotSupportedError } from '@a2a-js/sdk/errors'
import { binding, digest, error, exact, key, text } from '../packages/agent-contracts/index.mjs'
import { assertNodeCaller } from '../packages/agent-contracts/nodes.mjs'
import { authorizeOwnedReadyArtifactRead } from './multisite-authorization.mjs'
import { ERROR_STATUS } from './work-service.mjs'
import { A2A_TASK_SCHEMA, A2A_NODE_SCHEMA, A2A_GROUP_SCHEMA, a2aTaskRow, projectA2aTask, requireA2aOwner } from './a2a-state.mjs'

const dataPart=value=>({content:{$case:'data',value},mediaType:'application/json',filename:'',metadata:{}})
const authToken=request=>/^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(request.headers.authorization??'')?.[1]
const sameSecret=(actual,expected)=>typeof actual==='string'&&Buffer.byteLength(actual)===Buffer.byteLength(expected)&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected))
const domainStatus=code=>ERROR_STATUS[code]??500

export function createA2aService({config,store,service,nodes,groups,spreadsheetArtifacts,origin}) {
  const {token,...ownerScope}=config.receiver??{},closed=new AbortController()
  const card={name:'Geneway managed A2A runtime',description:'Current Work authority, bound Node commands and opaque application Work groups',version:'1.0.0',supportedInterfaces:[{url:origin+'/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0',tenant:''}],capabilities:{streaming:false,pushNotifications:false,extendedAgentCard:false,extensions:[]},defaultInputModes:['application/json'],defaultOutputModes:['application/json'],securitySchemes:{managedBearer:{scheme:{$case:'httpAuthSecurityScheme',value:{scheme:'Bearer',bearerFormat:'opaque'}}}},securityRequirements:[{schemes:{managedBearer:{list:[]}}}],skills:[...(config.receiver?[{id:'geneway-work-task',name:'Authorized Work Task',description:'Managed principal Work create/input/query/cancel and original ready artifact',tags:['work'],examples:[],inputModes:['application/json'],outputModes:['application/json'],securityRequirements:[]}]:[]),...(config.nodeCommands?[{id:'geneway-node-command',name:'Bound Node command',description:'Original Node and full execution authorization',tags:['node'],examples:[]}]:[]),...(config.workGroups?[{id:'geneway-work-group',name:'Opaque Work group delivery',description:'Application group; locator ACK does not grant data permission',tags:['group'],examples:[]}]:[])],signatures:[]}
  const rpcError=(id,cause)=>({jsonrpc:'2.0',id:id??null,error:JsonRpcTransportHandler.mapToJSONRPCError(cause)})
  function translate(cause){if(cause.code==='NOT_FOUND'||cause.code==='FORBIDDEN'||cause.code==='UNAUTHORIZED')return new TaskNotFoundError('Task not found');if(cause.code==='TASK_NOT_CANCELABLE')return new TaskNotCancelableError();if(cause instanceof RequestMalformedError||cause instanceof TaskNotFoundError||cause instanceof TaskNotCancelableError||cause instanceof UnsupportedOperationError||cause instanceof PushNotificationNotSupportedError)return cause;return new RequestMalformedError(cause.message??'Invalid request')}
  async function ownerState(context,{cleanup=false}={}){if(context.user.userName!=='owner')throw new TaskNotFoundError();await service.ensureReady();const state=await store.read();requireA2aOwner(state,ownerScope);return state}
  const artifactUrl=(taskId,artifactId)=>origin+'/a2a/tasks/'+encodeURIComponent(taskId)+'/artifacts/'+encodeURIComponent(artifactId)
  function projection(state,id,options={}){return projectA2aTask(state,ownerScope,id,{artifactUrl:artifactId=>artifactUrl(id,artifactId),...options})}
  function message(request,value){return{messageId:'reply-'+request.messageId,contextId:request.contextId??'',taskId:'',role:2,parts:[dataPart(value)],metadata:{},extensions:[],referenceTaskIds:[]}}
  function unpack(params){const m=params.message;if(!m?.messageId||m.role!==1||m.parts?.length!==1||m.parts[0].content?.$case!=='data'||m.parts[0].mediaType!=='application/json'||m.extensions?.length)throw new RequestMalformedError('A single structured application/json message is required');return{m,value:m.parts[0].content.value}}
  async function nodeAuth(context,state){if(context.user.userName!=='node'||!nodes)throw error('FORBIDDEN');return nodes.authenticate(state,context.state.get('authorization'),context.state.get('nodeInstanceId'))}
  async function nodeCommand(params,context,m,value){
    if(!config.nodeCommands||context.user.userName!=='node')throw new UnsupportedOperationError('Node purpose is not authorized')
    exact(value,['schema','binding','operation','parameters','manualFence'])
    let frame
    try{const state=await store.read(),auth=await nodeAuth(context,state);assertNodeCaller(state,auth,value.binding);await service.ensureReady();const body=await service.multisite.agentCommand(value.binding,value.operation,value.parameters,{nodeAuth:auth,manualFence:value.manualFence});frame={status:200,body}}
    catch(cause){frame={status:domainStatus(cause.code),body:{error:{code:typeof cause.code==='string'?cause.code:'INVALID_REQUEST',message:'节点请求未获准或暂不可用',...(cause.code==='CAPACITY_EXCEEDED'&&cause.capacity?.domain==='cloud'&&cause.capacity.queue==='ordinary'?{capacity:{domain:'cloud',queue:'ordinary',reason:cause.capacity.reason}}:{})}}}}
    return message(m,frame)
  }
  const handler={
    async getAgentCard(){return card},
    async sendMessage(params,context){
      const {m,value}=unpack(params)
      if(value?.schema===A2A_NODE_SCHEMA)return nodeCommand(params,context,m,value)
      if(value?.schema===A2A_GROUP_SCHEMA){
        if(context.user.userName!=='node')throw new UnsupportedOperationError('Group purpose is not authorized')
        exact(value,['schema','operation','operationId','binding','locator','deliveryId','payloadDigest'])
        const state=await store.read(),auth=await nodeAuth(context,state),payload=Object.fromEntries(['operationId','locator','deliveryId','payloadDigest'].filter(name=>value[name]!==undefined).map(name=>[name,value[name]]))
        if(!groups||!state.a2aProtocol.tasks.some(row=>row.workId===value.binding?.work_id)){
          if(value.operation!=='receive')throw new UnsupportedOperationError('No managed group configured for this Work')
          assertNodeCaller(state,auth,value.binding)
          return message(m,{schema:A2A_GROUP_SCHEMA,operation:'receive',operationId:payload.operationId,groupId:null,contextId:null,deliveries:[]})
        }
        const reply=await groups.handle(auth,value.binding,value.operation,payload);context.state.set('groupReply',{auth,value,payload,reply});return message(m,reply)
      }
      if(value?.schema!==A2A_TASK_SCHEMA||context.user.userName!=='owner'||!config.receiver)throw new UnsupportedOperationError('Application purpose is not authorized')
      exact(value,['schema','receiverId','operation','clientRequestId','parameters','rootEmployeeId'])
      if(value.receiverId!==ownerScope.receiverId)throw new RequestMalformedError('Receiver must be explicit')
      if(value.operation==='create'&&(m.taskId||m.contextId))throw new RequestMalformedError('New Task creation must not claim an existing Task/context')
      const request={operation:value.operation,clientRequestId:value.clientRequestId,parameters:value.parameters??{},...(value.rootEmployeeId?{rootEmployeeId:value.rootEmployeeId}:{}),...(m.taskId?{taskId:m.taskId,contextId:m.contextId}:{})}
      let result;try{result=await service.applyA2aTask(ownerScope,request)}catch(cause){throw translate(cause)}
      const cleanup=value.operation==='cancel'
      let task=projection(await ownerState(context,{cleanup}),result.taskId,{cleanup})
      if(params.configuration?.returnImmediately!==true){
        while(![3,4,5,6,7].includes(task.status.state)&&!context.state.get('abortSignal').aborted&&!closed.signal.aborted){await new Promise(done=>setTimeout(done,50));task=projection(await ownerState(context,{cleanup}),result.taskId,{cleanup})}
      }
      return task
    },
    async getTask(params,context){try{return projection(await ownerState(context),text(params.id))}catch(cause){throw translate(cause)}},
    async listTasks(params,context){
      const state=await ownerState(context),pageSize=params.pageSize||50
      if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new RequestMalformedError('pageSize must be 1..100')
      if(!Object.values(TaskState).includes(params.status??0)||(params.status??0)<0)throw new RequestMalformedError('Invalid status filter')
      if(params.statusTimestampAfter&&!Number.isFinite(Date.parse(params.statusTimestampAfter)))throw new RequestMalformedError('Invalid timestamp filter')
      const filters={status:params.status||0,contextId:params.contextId??'',statusTimestampAfter:params.statusTimestampAfter??''},scopeDigest=digest({scope:ownerScope,filters}),sign=value=>createHmac('sha256',token).update(value).digest('base64url')
      let after
      if(params.pageToken){try{const [encoded,signature,...extra]=params.pageToken.split('.');if(extra.length||!sameSecret(signature,sign(encoded)))throw Error();const cursor=JSON.parse(Buffer.from(encoded,'base64url'));if(cursor.scopeDigest!==scopeDigest||typeof cursor.id!=='string'||!Number.isFinite(Date.parse(cursor.timestamp)))throw Error();after=cursor}catch{throw new RequestMalformedError('Invalid page cursor')}}
      const visible=[]
      for(const row of state.a2aProtocol.tasks){if(row.receiverId!==ownerScope.receiverId||row.principalId!==ownerScope.principalId)continue;try{const task=projection(state,row.id);if(filters.status&&task.status.state!==filters.status||filters.contextId&&task.contextId!==filters.contextId||filters.statusTimestampAfter&&Date.parse(task.status.timestamp)<=Date.parse(filters.statusTimestampAfter))continue;visible.push(task)}catch(cause){if(!['NOT_FOUND','FORBIDDEN'].includes(cause.code))throw cause}}
      const compare=(a,b)=>b.status.timestamp.localeCompare(a.status.timestamp)||a.id.localeCompare(b.id,'en');visible.sort(compare)
      const remaining=after?visible.filter(task=>compare(task,{id:after.id,status:{timestamp:after.timestamp}})>0):visible,tasks=remaining.slice(0,pageSize),last=tasks.at(-1)
      let nextPageToken='';if(remaining.length>tasks.length){const encoded=Buffer.from(JSON.stringify({scopeDigest,id:last.id,timestamp:last.status.timestamp})).toString('base64url');nextPageToken=encoded+'.'+sign(encoded)}
      return{tasks:tasks.map(task=>params.includeArtifacts?task:{...task,artifacts:[]}),nextPageToken,pageSize,totalSize:visible.length}
    },
    async cancelTask(params,context){
      try{const state=await ownerState(context,{cleanup:true}),current=projection(state,params.id,{cleanup:true});if(current.status.state===5)return current;if([3,4].includes(current.status.state))throw new TaskNotCancelableError();const row=a2aTaskRow(state,ownerScope,params.id,{cleanup:true}).row;await service.applyA2aTask(ownerScope,{operation:'cancel',clientRequestId:'cancel-'+key(params.id),taskId:params.id,contextId:row.contextId,parameters:{}});return projection(await ownerState(context,{cleanup:true}),params.id,{cleanup:true})}catch(cause){throw translate(cause)}
    },
    async sendMessageStream(){throw new UnsupportedOperationError('Streaming is not advertised')},async resubscribe(){throw new UnsupportedOperationError('Streaming is not advertised')},
    async getAuthenticatedExtendedAgentCard(){throw new UnsupportedOperationError('Extended Card is not advertised')},
    async createTaskPushNotificationConfig(){throw new PushNotificationNotSupportedError()},async getTaskPushNotificationConfig(){throw new PushNotificationNotSupportedError()},async listTaskPushNotificationConfigs(){throw new PushNotificationNotSupportedError()},async deleteTaskPushNotificationConfig(){throw new PushNotificationNotSupportedError()},
  }
  const transport=new JsonRpcTransportHandler(handler)
  async function body(request){let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>1024*1024)throw new RequestMalformedError('Request too large');chunks.push(chunk)}return JSON.parse(Buffer.concat(chunks))}
  return {card,handler,
    async validateSave(task,context){const current=await handler.getTask({id:task.id},context);if(!isDeepStrictEqual(Task.toJSON(task),Task.toJSON(current)))throw error('REVISION_CONFLICT','SDK 不得改写原工作投影')},
    async handle(request,response,url){
      if(!['/.well-known/agent-card.json','/a2a','/internal/a2a/group-body'].includes(url.pathname)&&!url.pathname.startsWith('/a2a/tasks/'))return false
      let rpc
      const json=(status,value)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(value))}
      try{
        if(url.search)throw new RequestMalformedError('Unexpected query')
        if(request.method==='GET'&&url.pathname==='/.well-known/agent-card.json'){json(200,AgentCard.toJSON(card));return true}
        const state=await store.read(),candidate=authToken(request);let purpose
        if(token&&sameSecret(candidate,token)){requireA2aOwner(state,ownerScope);purpose='owner'}else{if(!nodes||!config.nodeCommands)throw error('UNAUTHORIZED');nodes.authenticate(state,request.headers.authorization,request.headers['x-geneway-node-instance']);purpose='node'}
        const download=/^\/a2a\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname)
        if(download&&request.method==='GET'){
          if(purpose!=='owner'||!spreadsheetArtifacts)throw error('NOT_FOUND');const task=projection(state,decodeURIComponent(download[1])),artifact=task.artifacts.find(a=>a.artifactId===decodeURIComponent(download[2]));if(!artifact)throw error('NOT_FOUND')
          const file=await spreadsheetArtifacts.download({id:ownerScope.memberId},task.metadata.geneway.workId,artifact.metadata.globalRef.id),fresh=await store.read();a2aTaskRow(fresh,ownerScope,task.id);authorizeOwnedReadyArtifactRead(fresh,{id:ownerScope.memberId},task.metadata.geneway.workId,artifact.metadata.globalRef.id)
          response.writeHead(200,{'content-type':file.metadata.mediaType,'content-length':file.bytes.length,'cache-control':'no-store'});response.end(file.bytes);return true
        }
        if(request.method!=='POST')throw new RequestMalformedError('POST required')
        rpc=await body(request)
        if(url.pathname==='/internal/a2a/group-body'){
          if(purpose!=='node'||!groups)throw error('FORBIDDEN');exact(rpc,['binding','locator']);const fresh=await store.read(),auth=nodes.authenticate(fresh,request.headers.authorization,request.headers['x-geneway-node-instance']),reply=await groups.resolveBody(auth,rpc.binding,rpc.locator),encoded=JSON.stringify(reply)
          const final=await groups.resolveBody(auth,rpc.binding,rpc.locator);if(!isDeepStrictEqual(final,reply))throw error('FORBIDDEN');response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(encoded);return true
        }
        if(url.pathname!=='/a2a')throw new RequestMalformedError('Unknown endpoint')
        validateVersion(request.headers['a2a-version']??'0.3',card,'JSONRPC')
        if(['SendStreamingMessage','SubscribeToTask'].includes(rpc.method))throw new UnsupportedOperationError('Streaming is not advertised')
        const abort=new AbortController();response.once('close',()=>abort.abort());const context=new ServerCallContext({requestedVersion:request.headers['a2a-version'],user:{isAuthenticated:true,userName:purpose},state:new Map([['authorization',request.headers.authorization],['nodeInstanceId',request.headers['x-geneway-node-instance']],['abortSignal',abort.signal]])})
        const result=await transport.handle(rpc,context);if(result?.[Symbol.asyncIterator])throw new UnsupportedOperationError();const encoded=JSON.stringify(result)
        const group=context.state.get('groupReply');if(group)await groups.verifyReply(group.auth,group.value.binding,group.value.operation,group.payload,group.reply)
        // Node command/read services already close their own final I/O authority
        // gate. Encoding is synchronous; do not add a new await or a second,
        // ordinary-execution gate that breaks intent/accepted-receipt cleanup.
        response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(encoded);return true
      }catch(cause){if(response.headersSent){response.destroy();return true}if(cause.code==='UNAUTHORIZED'){json(401,{error:{code:'UNAUTHORIZED'}});return true}if(url.pathname==='/a2a'){json(200,rpcError(rpc?.id,cause instanceof Error?cause:new RequestMalformedError()));return true}json(domainStatus(cause.code),{error:{code:typeof cause.code==='string'?cause.code:'INVALID_REQUEST'}});return true}
    },
    close(){closed.abort()},
  }
}
