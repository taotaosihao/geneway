import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { exact, text } from '../packages/agent-contracts/index.mjs'

async function privateBytes(path) {
  if(!isAbsolute(path??''))throw new Error('A2A 配置必须使用绝对路径')
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600)throw new Error('A2A 配置须为当前用户的私有普通文件');return await file.readFile('utf8')}
  finally{await file.close()}
}
export async function readA2aConfig(path) {
  if(!path)return undefined
  const value=JSON.parse(await privateBytes(path));exact(value,['version','nodeCommands','workGroups','receiver'])
  if(value.version!==1||typeof value.nodeCommands!=='boolean'||typeof value.workGroups!=='boolean')throw new Error('A2A 配置无效')
  let receiver
  if(value.receiver!==undefined){
    exact(value.receiver,['receiverId','workspaceId','memberId','principalId','credentialFile'])
    const {credentialFile,...scope}=value.receiver
    for(const name of ['receiverId','workspaceId','memberId','principalId'])text(scope[name],name)
    const token=(await privateBytes(credentialFile)).trim()
    if(!/^[A-Za-z0-9_-]{43,128}$/.test(token))throw new Error('A2A 接收方凭据无效')
    receiver={...scope,token}
  }
  if(value.workGroups&&!value.nodeCommands)throw new Error('A2A 群需要已配对 Node 入口')
  if(!receiver&&!value.nodeCommands)throw new Error('A2A 未配置可用角色')
  return {version:1,nodeCommands:value.nodeCommands,workGroups:value.workGroups,receiver}
}
