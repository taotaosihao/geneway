import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { MODEL_BASE_URL } from '../../../src/model-route.mjs'
import { digest } from '../../../packages/agent-contracts/index.mjs'

// Only this probe process substitutes the model provider; src/server.mjs is
// still the actual CLI entry and receives no runtime test hook.
const target=new URL(process.env.GENEWAY_A2A_PROBE_UPSTREAM)
assert.equal(target.protocol,'http:');assert.equal(target.hostname,'127.0.0.1')
assert(!target.username&&!target.password&&!target.search&&!target.hash)
const fetchOriginal=globalThis.fetch,source=new URL(MODEL_BASE_URL),mapLog=process.env.GENEWAY_A2A_PROBE_MAP_LOG
assert(mapLog,'Probe model mapping log is required')
globalThis.fetch=async(input,options={})=>{
  const url=typeof input==='string'||input instanceof URL?String(input):input.url
  if(new URL(url).origin!==source.origin)return fetchOriginal(input,options)
  assert.equal(url,MODEL_BASE_URL+'/chat/completions','Unexpected model destination is blocked by this fixture')
  assert.equal((options.method??input.method??'GET').toUpperCase(),'POST','Unexpected model method is blocked by this fixture')
  const body=options.body??(input instanceof Request?await input.clone().text():undefined)
  assert.equal(typeof body,'string')
  const destination=new URL(target);destination.pathname=destination.pathname.replace(/\/$/,'')+'/chat/completions'
  await appendFile(mapLog,JSON.stringify({at:new Date().toISOString(),pid:process.pid,logicalURL:url,actualMockURL:String(destination),method:'POST',bodyDigest:digest(JSON.parse(body))})+'\n',{mode:0o600})
  return fetchOriginal(input instanceof Request?new Request(destination,input):destination,options)
}
