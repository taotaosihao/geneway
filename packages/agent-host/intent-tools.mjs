import {defineTool} from '@deepseek-ai/dsh-tools'
const output={schema:{type:'object',additionalProperties:false,properties:{result:{type:'object',additionalProperties:true,required:true}}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value.result)}]}
export function createIntentTools(call,park){
 const execute=operation=>async parameters=>{const result=await call(operation,parameters);if(operation!=='split_intent'&&['accepted','handed_back','waiting_intent','clarify'].includes(result.status))park();return{result}}
 const common={clientRequestId:{type:'string',required:true}}
 return[
  defineTool({name:'geneway_intent_context',description:'Read only the server-attached current intent and its bounded Work context. This phase does not accept a business requirement or grant business tools.',parameters:{...common,intentId:{type:'string'}},output,execute:execute('intent_context')}),
  defineTool({name:'geneway_accept_intent',description:'Accept this exact attached intent as a new formal Work input. Use the current Work revision from intent context. The old review credential ends; wait for actual new input consumption before business actions.',parameters:{...common,expectedInstructionRevision:{type:'integer',required:true}},output,execute:execute('accept_intent')}),
  defineTool({name:'geneway_handback_intent',description:'Hand back only the current intent when outside your responsibility. Preserve all other Work inputs and actions. At most two handbacks, then ask for clarification.',parameters:{...common,reason:{type:'string',required:true},suggestedWorkId:{type:'string'}},output,execute:execute('handback_intent')}),
  defineTool({name:'geneway_ask_intent',description:'Ask the user a precise question about this intent. Uses an independent intent question and never overwrites a spreadsheet question.',parameters:{...common,text:{type:'string',required:true}},output,execute:execute('ask_intent')}),
  defineTool({name:'geneway_split_intent',description:'Split an independently routed matter from your already accepted and actually consumed Input. Preserve the original Input and its effects; the separate intent waits for explicit clarification.',parameters:{...common,intentId:{type:'string',required:true},inputId:{type:'string',required:true},reason:{type:'string',required:true}},output,execute:execute('split_intent')}),
  defineTool({name:'geneway_reply_intent',description:'Queue a response for this intent. The server rechecks your responsibility and exact revision at actual delivery; context subscribers cannot reply.',parameters:{...common,intentId:{type:'string'},text:{type:'string',required:true}},output,execute:execute('reply_intent')}),
 ]
}
