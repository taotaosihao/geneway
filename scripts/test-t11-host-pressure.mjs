import assert from 'node:assert/strict'
import { mkdtemp,writeFile,readFile,readdir,mkdir } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { runPressureComponents } from './fixtures/multisite/t11-pressure-components.mjs'
import { runNativePressure } from './fixtures/multisite/t11-pressure-native.mjs'

const directory=await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/t11-host-pressure-')
const save=(name,value)=>writeFile(join(directory,name),JSON.stringify(value,null,2))
const resumeIndex=process.argv.indexOf('--resume-pressure'),resumeRoot=resumeIndex>=0?resolve(process.argv[resumeIndex+1]):undefined
const mode=process.argv.includes('--component')?'component':process.argv.includes('--enospc')?'enospc':resumeRoot?'resume-pressure':'pressure'
const paths=['scripts/test-t11-host-pressure.mjs','scripts/fixtures/multisite/bridge-service.mjs','scripts/fixtures/multisite/delegation.mjs','scripts/fixtures/multisite/supervision-process-lifecycle.mjs','packages/agent-host/host.mjs','packages/agent-host/remote.mjs','packages/agent-host/remote-client.mjs','packages/agent-host/journal.mjs','packages/agent-host/diagnostics.mjs','packages/agent-host/process-runtime.mjs','packages/agent-host/runtime-worker.mjs','src/node-bridge.mjs','src/server.mjs','src/work-service.mjs','src/model-gateway.mjs','src/store/file-store.mjs','packages/agent-orchestration/service.mjs','packages/agent-orchestration/commands.mjs','packages/agent-contracts/index.mjs','packages/agent-contracts/command-bytes.mjs','package.json','pnpm-lock.yaml',...(await readdir('scripts/fixtures/multisite')).filter(name=>name.startsWith('t11-pressure-')).map(name=>'scripts/fixtures/multisite/'+name)].sort()
async function sources(phase){await mkdir(join(directory,'source-'+phase));const entries=[];for(const path of paths){const bytes=await readFile(path);await writeFile(join(directory,'source-'+phase,path.replaceAll('/','__')),bytes);entries.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length})}await save('source-'+phase+'.json',{at:new Date().toISOString(),pid:process.pid,execPath:process.execPath,node:process.version,argv:process.argv,entries});return entries}
const start=await sources('start')
console.log(JSON.stringify({stage:'source-start',directory,dataRoot:resumeRoot??directory,pid:process.pid,mode,argv:process.argv}))
try{
  if(mode==='component'){const cases=await runPressureComponents({directory,save});console.log(JSON.stringify({result:'passed',mode,directory,cases:cases.length}))}
  else await runNativePressure({directory,save,mode:mode==='resume-pressure'?'pressure':mode,resumeRoot})
}catch(cause){await save('failure.json',{name:cause.name,message:cause.message,code:cause.code,stack:cause.stack});console.error(directory);process.exitCode=1}
finally{const end=await sources('end'),sourceChanged=JSON.stringify(start)!==JSON.stringify(end);await save('source-comparison.json',{sourceChanged});if(sourceChanged)process.exitCode=1;console.log(JSON.stringify({stage:'closed',mode,directory,pid:process.pid,sourceChanged,exitCode:process.exitCode??0}))}
