import { registerHooks } from 'node:module';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const fixture=new URL('../../../scripts/probe-spreadsheet-collaboration.mjs',import.meta.url).href,client=new URL('../../../packages/agent-host/remote-client.mjs',import.meta.url).href;
const forkModule=new URL('./protocol-fork.mjs',import.meta.url).href,fetchModule=new URL('./protocol-client.mjs',import.meta.url).href;
registerHooks({load(url,context,nextLoad){
  const loaded=nextLoad(url,context);if(!process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT)return loaded;
  let source=typeof loaded.source==='string'?loaded.source:loaded.source&&Buffer.from(loaded.source).toString();if(!source)return loaded;
  if(url===fixture){
    const original="import { fork, execFile } from 'node:child_process'";if(!source.includes(original))throw Error('Fixed fixture fork seam changed');
    source=source.replace(original,"import { execFile } from 'node:child_process'\nimport { fork } from "+JSON.stringify(forkModule));
    if(process.env.GENEWAY_PROTOCOL_BUSINESS_ENTRY==='1'){
      const driverModule=new URL('./business-driver.mjs',import.meta.url).href;source="import { installBusinessDriver } from "+JSON.stringify(driverModule)+"\nlet protocolBusinessDriver;\n"+source;
      source=source.replace("await stage('five-native-parents-ready-phone-create');","protocolBusinessDriver=await installBusinessDriver({candidate:process.env.GENEWAY_PROTOCOL_COMPARISON_CANDIDATE,root:process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT+'/business-entry',apiRoot,origin,session,page,answerPage,businessDirectory:directory});await stage('five-native-parents-ready-phone-create');");
      source=source.replace("await writeFile(join(directory,'question-state.json'),JSON.stringify(questionState,null,2));","await writeFile(join(directory,'question-state.json'),JSON.stringify(questionState,null,2));await protocolBusinessDriver.observe('question-open');");
      source=source.replace("await stage('phone-download-oracle-passed')","await protocolBusinessDriver.observe('completed');await stage('phone-download-oracle-passed')");
      if(process.env.GENEWAY_PROTOCOL_CANCEL==='1'){const cancelSeam="await stage('busy-generator-ui-stop');await page.reload();await page.locator('#cancel-work').click();releaseGet();";if(!source.includes(cancelSeam))throw Error('Original busy-stop seam changed');source=source.replace(cancelSeam,"await stage('busy-generator-protocol-stop');await protocolBusinessDriver.cancelBusy({heldWorker,parents,releaseGet});");source=source.replace("await writeFile(join(directory,'stopped-state.json'),JSON.stringify({state:stoppedState,local},null,2));","await writeFile(join(directory,'stopped-state.json'),JSON.stringify({state:stoppedState,local},null,2));await protocolBusinessDriver.observe('stopped');");}

    }
    const prefix="'/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-collaboration-native-'";if(!source.includes(prefix))throw Error('Fixed fixture root seam changed');source=source.replace(prefix,"process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT+'/business-'");
  }else if(url===client){
    const seam='  const base = new URL(origin)';if(!source.includes(seam))throw Error('Fixed Node client seam changed');source="import { protocolFetch } from "+JSON.stringify(fetchModule)+"\n"+source.replace(seam,"  const originalFetch = fetchImpl; fetchImpl = (input, options) => protocolFetch(input, options, originalFetch)\n"+seam);
  }else return loaded;
  const root=path.join(process.env.GENEWAY_PROTOCOL_COMPARISON_ROOT,'runtime-source');mkdirSync(root,{recursive:true});writeFileSync(path.join(root,path.basename(fileURLToPath(url))),source);
  return{...loaded,source};
}});
