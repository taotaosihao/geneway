import { open } from 'node:fs/promises'
import { basename,dirname } from 'node:path'
import { createHostJournal as productionJournal } from '../../../packages/agent-host/journal.mjs'
import { journalFault } from './t11-pressure-control.mjs'

export function createHostJournal(path,operations={}){
  return productionJournal(path,{...operations,async open(target,flags,mode){
    const handle=await(operations.open??open)(target,flags,mode)
    if(flags!=='w'||dirname(target)!==dirname(path)||!basename(target).startsWith('.'+basename(path)+'.'))return handle
    return new Proxy(handle,{get(value,field){
      if(field==='writeFile')return async data=>{
        if(journalFault.mode==='enospc'){
          const next=JSON.parse(data),row=next.inbox.find(row=>row.command.command_id===journalFault.commandId)
          if(row){journalFault.hits++;process.send?.({kind:'temp-write-enospc',command:row.command,path,tempPath:target,hit:journalFault.hits,at:new Date().toISOString()});throw Object.assign(Error('Test-only target Journal temp write ENOSPC'),{code:'ENOSPC'})}
        }
        return value.writeFile(data)
      }
      const property=Reflect.get(value,field);return typeof property==='function'?property.bind(value):property
    }})
  }})
}
