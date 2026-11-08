import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import './role-loaded.mjs';
const target=new URL('../../../packages/agent-host/remote-client.mjs',import.meta.url).href,wrapper=new URL('../common/protocol-client.mjs',import.meta.url).href;
if(process.env.GENEWAY_PROTOCOL_COMPARISON_CANDIDATE!=='baseline')registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);if(url!==target)return result;const source=String(result.source),seam='  const base = new URL(origin)';if(!source.includes(seam))throw Error('Original remote client seam changed');const updated='import {protocolFetch} from '+JSON.stringify(wrapper)+'\n'+source.replace(seam,'  const originalFetch=fetchImpl;fetchImpl=(input,options)=>protocolFetch(input,options,originalFetch)\n'+seam);writeFileSync(path.join(process.env.GENEWAY_ROLE_EDGE_ROOT,'remote-client-derived.mjs'),updated);return{...result,source:updated};}});
