import assert from 'node:assert/strict'
import {randomUUID,randomBytes} from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { mkdtemp, readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeTrustedOrigin } from '../src/trusted-origin.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createTlsProxy } from './fixtures/multisite/tls-proxy.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/trusted-origin-')
let proxy, fixture, browser
const assertions = [], observations = []
try {
  for (const [input, expected] of [['HTTPS://Example.COM:443/', 'https://example.com'], ['http://localhost:3471/', 'http://localhost:3471'], ['http://[::1]:3471','http://[::1]:3471'], ['https://localhost:8443','https://localhost:8443']]) assert.equal(normalizeTrustedOrigin(input), expected)
  for (const value of [undefined,null,42,'http://example.com','ftp://localhost','https://a/a','https://a/.','https://a?','https://a#','https://u:p@a','https://@a','https://a/?x',' https://a','https://a b','not a URL']) {
    assert.throws(() => normalizeTrustedOrigin(value)); assert.throws(() => createGenewayServer({ service:{},store:{},auth:{},trustedOrigin:value }))
  }
  assertions.push('origin normalization and factory rejection')
  proxy = await createTlsProxy(join(directory,'tls'))
  fixture = await startBridgeService({ directory:join(directory,'api'), index:await readFile('web/index.html','utf8'), trustedOrigin:proxy.origin })
  proxy.setTarget(fixture.origin)
  const ca = await readFile(proxy.ca)
  async function request(path, { method='GET', body, headers={}, trust=true, origin=proxy.origin }={}) {
    return new Promise((resolve,reject) => {
      const call=httpsRequest(new URL(path,origin),{method, family:4, ...(new URL(origin).hostname==='localhost'?{servername:'localhost'}:{}), ...(trust?{ca}:{}),headers:{...(body?{'content-type':'application/json','content-length':Buffer.byteLength(JSON.stringify(body))}:{}),...headers}},response=>{
        const chunks=[];response.on('data',bytes=>chunks.push(bytes));response.on('end',()=>{observations.push({path,method,status:response.statusCode,cookieAttributes:response.headers['set-cookie']?.map(value=>value.slice(value.indexOf(';')+1).trim())??[]});resolve({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString('utf8')})})
      });call.on('error',cause=>{observations.push({path,method,tlsError:cause.code});reject(cause)});call.end(body?JSON.stringify(body):undefined)
    })
  }
  await assert.rejects(request('/',{trust:false}), cause => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(cause.code))
  await assert.rejects(request('/',{origin:proxy.origin.replace('localhost','127.0.0.1')}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'})
  assertions.push('unknown CA and wrong hostname genuinely rejected')
  const loginBody={loginName:'owner',password:'synthetic owner password'}
  assert.equal((await request('/api/session',{method:'POST',body:loginBody})).status,403)
  assert.equal((await request('/api/session',{method:'POST',body:loginBody,headers:{origin:fixture.origin,forwarded:`proto=https;host=localhost`, 'x-forwarded-proto':'https','x-forwarded-host':new URL(proxy.origin).host}})).status,403)
  const login=await request('/api/session',{method:'POST',body:loginBody,headers:{origin:proxy.origin,host:'untrusted.invalid',forwarded:'proto=http;host=untrusted.invalid','x-forwarded-proto':'http'}})
  assert.equal(login.status,200,login.text)
  const setCookie=login.headers['set-cookie'][0];assert.match(setCookie,/; Secure;/);assert.match(setCookie,/Path=\/; HttpOnly; SameSite=Strict/)
  const session=JSON.parse(login.text),cookie=setCookie.split(';')[0]
  for(const [nodeId,allowedAgentIds] of [['cloud',['coordinator','analysis']],['pc-b',['desktop-office']]]) {
    const paired=await request('/api/admin/nodes/pairings',{method:'POST',headers:{origin:proxy.origin,cookie,'x-csrf-token':session.csrfToken},body:{clientRequestId:'pair-'+nodeId,nodeId,siteId:'site',platform:'linux',runtimeMode:'agent_node',allowedAgentIds,expiresAt:new Date(Date.now()+60000).toISOString()}});assert.equal(paired.status,200,paired.text)
    const pairing=JSON.parse(paired.text), redeemed=await request('/internal/nodes/pair',{method:'POST',body:{pairingId:pairing.pairingId,pairingCode:pairing.pairingCode,clientRequestId:randomUUID(),nodeInstanceId:randomUUID(),credential:randomBytes(32).toString('base64url')}});assert.equal(redeemed.status,200,redeemed.text)
  }
  const work={workType:'multisite',employeeId:'coordinator',goal:'HTTPS入口受控写',clientRequestId:'https-write'}
  for(const headers of [{origin:proxy.origin,cookie},{origin:'https://other.invalid',cookie,'x-csrf-token':session.csrfToken},{origin:proxy.origin,cookie,'x-csrf-token':'wrong'}]) assert.equal((await request('/api/works',{method:'POST',body:work,headers})).status,403)
  const created=await request('/api/works',{method:'POST',body:work,headers:{origin:proxy.origin,cookie,'x-csrf-token':session.csrfToken,host:'backend.internal'}});assert.equal(created.status,200,created.text)
  const logout=await request('/api/session',{method:'DELETE',body:{},headers:{origin:proxy.origin,cookie,'x-csrf-token':session.csrfToken}});assert.equal(logout.status,200,logout.text);assert.match(logout.headers['set-cookie'][0],/Secure; Max-Age=0/)
  assertions.push('HTTPS issue/clear Secure Cookie, exact Origin and CSRF, Host/Forwarded cannot grant authority')
  const httpLogin=await fetch(fixture.origin+'/api/session',{method:'POST',headers:{origin:proxy.origin,'content-type':'application/json'},body:JSON.stringify(loginBody)});assert.equal(httpLogin.status,200);assert.match(httpLogin.headers.get('set-cookie'),/Secure/)
  // The browser uses a dedicated NSS trust database, never an insecure certificate option.
  const {chromium}=await import('/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
  browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:[`--log-net-log=${directory}/chrome-netlog.json`],env:{...process.env,HOME:proxy.browserHome}})
  const context=await browser.newContext({viewport:{width:390,height:844}}), page=await context.newPage(), errors=[]
  page.on('pageerror',cause=>errors.push(cause.message))
  await page.goto(proxy.origin);await page.locator('#login-name').fill('owner');await page.locator('#login-password').fill('synthetic owner password');await page.locator('#login-form button').click();await page.locator('#work-mode').waitFor()
  const cookies=await context.cookies();assert(cookies.some(row=>row.name==='geneway_session'&&row.secure&&row.httpOnly&&row.sameSite==='Strict'))
  const browserSession=await page.evaluate(async()=>{const r=await fetch('/api/session');return{status:r.status,value:await r.json()}});assert.equal(browserSession.status,200)
  const browserWrite=await page.evaluate(async({csrfToken})=>{const r=await fetch('/api/works',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrfToken},body:JSON.stringify({workType:'multisite',employeeId:'desktop-office',goal:'浏览器HTTPS写',clientRequestId:'browser-write'})});return{status:r.status,body:await r.json()}},browserSession.value);assert.equal(browserWrite.status,200,JSON.stringify(browserWrite))
  await page.screenshot({path:join(directory,'https-mobile.png'),fullPage:true});assert.deepEqual(errors,[])
  assertions.push('real Chromium trusted TLS login, session cookie and CSRF business write')
  const cleared=page.waitForResponse(response=>response.url()===proxy.origin+'/api/session'&&response.request().method()==='DELETE')
  await page.locator('#mobile-more summary').click();await page.locator('#mobile-logout').click();const clearedResponse=await cleared;assert.equal(clearedResponse.status(),200);const clearHeader=(await clearedResponse.allHeaders())['set-cookie'];assert.match(clearHeader,/Secure; Max-Age=0/);await page.locator('#login-name').waitFor();const expired=await page.evaluate(async()=>({status:(await fetch('/api/session')).status}));assert.equal(expired.status,401);assert(!(await context.cookies()).some(row=>row.name==='geneway_session'))
  observations.push({case:'actual mobile browser logout',status:clearedResponse.status(),cookieAttributes:clearHeader.slice(clearHeader.indexOf(';')+1).trim(),subsequentSessionStatus:expired.status,cookieAbsent:true});assertions.push('real browser logout clears Secure cookie and session is unauthorized')
  await context.close();await browser.close();browser=null
  const result={result:'passed',directory,origin:proxy.origin,assertions,observations,browserErrors:errors,boundary:'real local CA/TLS streaming proxy and browser using isolated HOME/NSS; synthetic service, no public deployment'}
  await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}catch(cause){await writeFile(join(directory,'failure.json'),JSON.stringify({message:cause.message,stack:cause.stack,assertions},null,2));console.error('TLS evidence:',directory);throw cause}finally{await browser?.close();await fixture?.close();await proxy?.close()}
