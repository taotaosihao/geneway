import {registerHooks} from 'node:module';
import {appendFileSync} from 'node:fs';
const file=process.env.GENEWAY_ROLE_LOAD_TRACE;
if(file)registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);appendFileSync(file,JSON.stringify({at:new Date().toISOString(),pid:process.pid,url,format:result.format})+'\n');return result;}});
