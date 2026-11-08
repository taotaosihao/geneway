import { binding,digest,sameBinding } from '../../../packages/agent-contracts/index.mjs'
import { messageId } from '../../../packages/agent-host/delivery.mjs'

// A completed predecessor never proves that a newly consumed Input ran a model.
export function commandModelObservation({command,models,providerBodies,sessions}){
  const execution={...binding(command),session_id:command.session_id??`geneway-${command.launch_id}`}
  const expected={binding:execution,instructionRevision:command.instruction_revision,inputMessageId:messageId(command.input_id,command.attempt_id,execution.session_id)}
  const requests=models.filter(row=>row.work_id===command.work_id&&sameBinding(row,execution)&&row.instructionRevision===expected.instructionRevision&&row.inputMessageId===expected.inputMessageId)
  if(!requests.length||requests.some(row=>row.outcome!=='completed'||!Number.isFinite(Date.parse(row.completedAt))))return null
  const used=new Set(),provider=[]
  for(const request of requests){
    const index=providerBodies.findIndex((row,index)=>!used.has(index)&&digest(row.body)===request.bodyDigest&&Date.parse(row.at)>=Date.parse(request.reservedAt)&&Date.parse(row.at)<=Date.parse(request.completedAt))
    if(index<0)return null
    used.add(index);provider.push({requestId:request.id,bodyIndex:index,bodyDigest:request.bodyDigest,observedAt:providerBodies[index].at})
  }
  const matching=sessions.filter(row=>row.path.includes('/'+execution.session_id+'/'))
  if(matching.length!==1)return null
  const session=matching[0],users=session.events.filter(row=>row.type==='user/message'&&row.data.id===expected.inputMessageId)
  if(users.length!==1)return null
  const user=users[0],start=session.events.findLast(row=>row.type==='turn/start'&&row.seq<user.seq)
  if(!start)return null
  const outputs=session.events.filter(row=>row.type==='assistant/message'&&row.seq>user.seq&&row.data.turn===start.data.turn&&row.data.message?.source?.kind==='model'&&row.data.message.content?.length)
  const end=outputs.length&&session.events.find(row=>row.type==='turn/end'&&row.data.turn===start.data.turn&&row.seq>outputs.at(-1).seq)
  if(!outputs.length||!end)return null
  return{expected,requests,provider,sessionPath:session.path,userMessage:user,assistantOutputs:outputs,turnEnd:end}
}
