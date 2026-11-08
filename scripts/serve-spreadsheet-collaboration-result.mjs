import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
const fixtures=[]
for(const argument of process.argv.slice(2)){
 const directory=resolve(argument),result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'))
 if(result.result!=='passed'||!result.workId)throw Error('需要已有完整验收对象')
 const fixture=await startBridgeService({directory:join(directory,'api'),index:await readFile('web/index.html','utf8')});fixtures.push(fixture)
 console.log(JSON.stringify({directory,origin:fixture.origin,pid:process.pid,workId:result.workId,artifactId:result.artifactId??null,mode:'existing-result-no-Host-or-provider'}))
}
let closing
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{closing??=Promise.all(fixtures.map(fixture=>fixture.close())).finally(()=>process.exit(0))})
