import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createNodeServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createKnowledgeService } from '../src/knowledge-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { readGearJobWorkOrder } from '../plugins/gearjob-work-order.mjs'

const browserAcceptanceExpected=Object.freeze({ownerPrivateStatus:200,ownerPrivateUiResult:true,peerSharedStatus:200,peerSharedUiResult:'visible',unauthorizedEmployeeStatus:404,unauthorizedEmployeeUiResult:'option-absent',peerSearchStatus:200,peerSearchCount:0,peerRootStatus:404,peerMaterialStatus:404,revokedUiResult:'redacted',w1Status:'cancelled',w2Status:'completed',lateResultOverwrote:false})
const root = dirname(dirname(fileURLToPath(import.meta.url)))
let formalDeadlineAt
const candidate = await git(['rev-parse', 'HEAD'])
const shortCandidate = candidate.slice(0, 7)
const recordIndex = process.argv.indexOf('--record')
const recordPath = recordIndex >= 0 ? resolve(process.argv[recordIndex + 1] ?? '') : undefined
const attemptIndex = process.argv.indexOf('--attempt')
const attemptId = attemptIndex >= 0 ? process.argv[attemptIndex + 1] : undefined
const supersedesIndex = process.argv.indexOf('--supersedes')
const supersedes = supersedesIndex >= 0 ? process.argv[supersedesIndex + 1] : undefined
const preflightOnly = process.argv.includes('--preflight')
const realOnly = process.argv.includes('--real-only')
const uiOnly = process.argv.includes('--ui-only')
const harnessCheck = process.argv.includes('--harness-check')
const noRecord = process.argv.includes('--no-record') || preflightOnly
formalDeadlineAt = recordPath ? Date.now() + 45 * 60_000 : undefined
if (recordIndex >= 0 && (!recordPath?.endsWith('.mp4') || process.argv[recordIndex + 1]?.startsWith('-'))) throw new Error('--record requires an MP4 output path')
if (recordPath && basename(recordPath) !== `p3-${shortCandidate}-final.mp4`) throw new Error(`formal record must be named p3-${shortCandidate}-final.mp4`)
if (!noRecord && !recordPath) throw new Error('formal P3 acceptance requires --record <path>; use --no-record only for a dry acceptance run')
if (recordPath && (!attemptId || !/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(attemptId))) throw new Error('formal P3 acceptance requires --attempt <stable-id>')

const scratch = await mkdtemp(join(tmpdir(), 'geneway-p3-accept-'))
const statePath = join(scratch, 'state.json')
const secretRoot = join(scratch, 'secrets')
const dshHome = join(scratch, 'dsh')
const backupPath = join(scratch, 'backup')
const restorePath = join(scratch, 'restored')
const display = process.env.GENEWAY_ACCEPT_DISPLAY ?? ':97'
const workOrderId = process.env.GENEWAY_ACCEPT_WORK_ORDER_ID ?? 'WO-26-00096'
const gearJobUrl = process.env.GENEWAY_ACCEPT_GEARJOB_URL ?? 'http://127.0.0.1:8100'
const gearJobHost = process.env.GENEWAY_ACCEPT_GEARJOB_HOST ?? 'dev.localhost'
const gearJobCredential = resolve(process.env.GENEWAY_ACCEPT_GEARJOB_CREDENTIAL ?? '/home/gewu/work/gearjob/development/frappe-bench/sites/dev.localhost/private/geneway-p1/service-credential.json')
const artifactsDir = recordPath ? dirname(recordPath) : join(scratch, 'artifacts')
const receiptPath = recordPath?.replace(/\.mp4$/i, '.receipt.json')
const coverPath = recordPath?.replace(/\.mp4$/i, '.png')
const framesDir = recordPath ? join(artifactsDir, `${basename(recordPath, '.mp4')}-frames`) : join(scratch, 'frames')
const tempUiScript = join(root, 'scripts', `.accept-p3-ui-${process.pid}.mjs`)
const commands = []
const runtimeSecrets = []
let runner, service, xvfb, recorder
const externalTemps = []
let lastBrowserExport
let lastBrowserSteps = []
let recordingStartedAt
let lastCanaries = []

try {
  await assertCandidate()
  if (!realOnly && !uiOnly && !harnessCheck) {
    await gate('pnpm install --frozen-lockfile --ignore-scripts', 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])
    for (const name of ['test:unit', 'test:service', 'test:controlled', 'test:p2', 'test:p3']) await gate(`pnpm ${name}`, 'pnpm', [name])
    await gate('GENEWAY_P1_PROBE_MODEL=true pnpm probe:p1-runtime', 'pnpm', ['probe:p1-runtime'], { env: { ...process.env, GENEWAY_P1_PROBE_MODEL: 'true' } })
    await gate('GENEWAY_P3_PROBE_MODEL=true pnpm probe:p3-delegation', 'pnpm', ['probe:p3-delegation'], { env: { ...process.env, GENEWAY_P3_PROBE_MODEL: 'true' } })
    await gate('git diff --check', 'git', ['diff', '--check'])
  }
  if (harnessCheck) { await browserJourney(); console.log(JSON.stringify({ ok: true, candidate, mode: 'harness-check' })) }
  else if (uiOnly) { const browser = await browserJourney(); console.log(JSON.stringify({ ok: true, candidate, browser }, null, 2)) }
  else if (preflightOnly) { console.log(JSON.stringify({ ok: true, candidate, mode: 'preflight', commands }, null, 2)); process.exitCode = 0 }
  else {
    await mkdir(secretRoot, { recursive: true, mode: 0o700 })
    await copyFile(gearJobCredential, join(secretRoot, 'gearjob.json'))
    await chmod(join(secretRoot, 'gearjob.json'), 0o600)
    const browser = await browserJourney()
    const real = await realEvidenceFromBrowser(lastBrowserExport)
    if (realOnly) console.log(JSON.stringify({ ok: true, candidate, real }, null, 2))
    else {
    const restore = await backupRestore(real, join(lastBrowserExport.temp, 'state.json'))
    await stop(recorder, 'SIGINT'); recorder = undefined
    await stop(xvfb, 'SIGTERM'); xvfb = undefined
    const artifacts = recordPath ? await finishMedia() : { video: null, cover: null, frames: [] }
    const scanTargets = [join(lastBrowserExport.temp, 'state.json'), dshHome, backupPath, restorePath, artifactsDir],attestationPath=recordPath.replace(/\.mp4$/i,'.final-scan.json'),attestationId=sha256(`${candidate}|${attemptId}|geneway-p3-final-scan-v1`)
    const receipt = {
      format: 'geneway-p3-acceptance-receipt', version: 1, candidate, shortCandidate, createdAt: new Date().toISOString(), attemptId, supersedes: supersedes ?? null,
      entrypoint: { argv: process.argv.slice(1).map(value => /(?:password|token|secret|key)=/i.test(value) ? '[redacted]' : value), script: 'scripts/accept-p3.mjs', scriptSha256: sha256(await readFile(join(root, 'scripts', 'accept-p3.mjs'))), harnessCommit: candidate },
      worktree: { trackedClean: true, allowedUntracked: ['five pre-existing ui-sketch paths', 'artifacts/p3-acceptance/'] }, commands,
      fixtures: { workOrderId, provisioned: false, accounts: ['admin', 'owner', 'peer'], dataMode: real.source.dataMode },
      journey: browser.steps, model: real.model, source: real.source, authorization:browser.authorization, knowledge: real.knowledge,
      collaboration: real.collaboration, cancel: browser.cancel, restore, browser: browser.browser,
      artifacts:{...artifacts,manual:{file:'index.html'},finalScanAttestation:{file:basename(attestationPath),format:'geneway-p3-final-scan-attestation',version:1,id:attestationId}},secretScan:{status:'deferred-to-attestation',attestationFile:basename(attestationPath),attestationId},
    }
    if (receiptPath) {
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
      const receiptArtifact = { file: basename(receiptPath), sha256: sha256(await readFile(receiptPath)), bytes: (await stat(receiptPath)).size }
      const manual=await writeManual({ ...receipt, artifacts: { ...receipt.artifacts, receipt: receiptArtifact } })
      receipt.artifacts.receipt = receiptArtifact
      const finalSecretScan = await scanSecrets(scanTargets.filter(path=>path!==attestationPath))
      assert.equal(finalSecretScan.matches,0)
      const attestation={format:'geneway-p3-final-scan-attestation',version:1,id:attestationId,candidate,attemptId,createdAt:new Date().toISOString(),receipt:receiptArtifact,manual,scan:finalSecretScan,canaryCatalog:real.knowledge.canaryCatalog,alternateVisualDomScan:artifacts.alternateVisualDomScan,pixelOcr:artifacts.pixelOcr,offlineVerification:{status:'pending'},visualReview:{requiredReviewers:2,status:'pending-independent-review'}}
      await writeFile(attestationPath,JSON.stringify(attestation,null,2)+'\n',{mode:0o600})
      let attestationSelfCheck=await scanSecrets([attestationPath]);assert.equal(attestationSelfCheck.matches,0)
      attestation.offlineVerification=await verifyOfflineBundle(receipt,manual,attestationPath)
      await writeFile(attestationPath,JSON.stringify(attestation,null,2)+'\n',{mode:0o600})
      attestationSelfCheck=await scanSecrets([attestationPath]);assert.equal(attestationSelfCheck.matches,0);assert.equal(attestation.offlineVerification.status,'passed');const finalOfflineVerification=await verifyOfflineBundle(receipt,manual,attestationPath);assert.equal(finalOfflineVerification.status,'passed');assert.equal(finalOfflineVerification.bundleSha256,attestation.offlineVerification.bundleSha256)
      receipt.artifacts.finalScanAttestation={...receipt.artifacts.finalScanAttestation,sha256:sha256(await readFile(attestationPath)),bytes:(await stat(attestationPath)).size}
    }
    console.log(JSON.stringify({ ok: true, candidate, receipt: receiptPath, artifacts: receipt.artifacts }, null, 2))
    }
  }
} finally {
  await stop(recorder, 'SIGINT')
  await stop(xvfb, 'SIGTERM')
  await service?.close().catch(() => undefined)
  await runner?.close().catch(() => undefined)
  await rm(tempUiScript, { force: true })
  await Promise.all(externalTemps.map(path => rm(path, { recursive: true, force: true })))
  await rm(scratch, { recursive: true, force: true })
}

async function browserJourney() {
  const passwords = { admin: randomBytes(24).toString('base64url'), owner: randomBytes(24).toString('base64url'), peer: randomBytes(24).toString('base64url') }
  const canaries={r1:`P3-R1-${randomBytes(10).toString('hex')}`,r2:`P3-R2-${randomBytes(10).toString('hex')}`,r3:`P3-R3-${randomBytes(10).toString('hex')}`,revoked:`P3-REVOKED-${randomBytes(10).toString('hex')}`};lastCanaries=Object.entries(canaries).map(([label,value])=>({label,value,sha256:sha256(value) }));
  runtimeSecrets.push(...Object.values(passwords))
  const source = (await readFile(join(root, 'scripts', 'test-p3-http-ui.mjs'), 'utf8'))
    .replaceAll('admin password', passwords.admin).replaceAll('owner password', passwords.owner).replaceAll('peer password', passwords.peer)
    .replace(/  const owner = await login\('owner',[\s\S]+?  const browserResult = await browserJourney/, `  const owner=await login('owner',${JSON.stringify(passwords.owner)})\n  await login('peer',${JSON.stringify(passwords.peer)})\n  await login('admin',${JSON.stringify(passwords.admin)})\n  const browserResult = await browserJourney`)
  const visible = source
    .replace("const temp = await mkdtemp(join(tmpdir(), 'geneway-p3-http-ui-'))", "const temp = await mkdtemp(join(tmpdir(), 'geneway-p3-http-ui-'));console.log('P3_ACCEPT_TEMP:'+temp)")
    .replace('let server, browser, service', 'let server, browser, service, collaborationRunner, knowledge, auth, index')
    .replace('明确区分工单事实、用户条件和建议。', `明确区分工单事实、用户条件和建议。${canaries.r1}`)
    .replace('浏览器当前依据 revision 3，不含旧内容。', `浏览器当前依据 revision 3，不含旧内容。${canaries.r2}`)
    .replace('浏览器当前依据 revision 4，移动端更正。', `浏览器当前依据 revision 4，移动端更正。${canaries.r3}`)
    .replace('插件停用期间仍可维护，revision 5。', `插件停用期间仍可维护，revision 5。${canaries.revoked}`)
    .replace("import { randomUUID } from 'node:crypto'", "import { createHash, randomUUID } from 'node:crypto'")
    .replace("import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'", "import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'")
    .replace('const capture = await startCapture()', 'const capture = startRuntimeControl(store)')
    .replace(/const connection = \{[^\n]+\}/, `const connection = ${JSON.stringify({ id: 'connection-gear', name: 'GearJob 外部测试 A', kind: 'gearjob-rest', targetIdentity: 'gearjob-dev-a', baseUrl: gearJobUrl, hostHeader: gearJobHost, credentialRef: 'gearjob.json', allowedObjectIds: [workOrderId], sourceSystem: 'GearJob', sourceInstance: 'dev.localhost', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest', enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 })}`)
    .replace("await writeFile(join(temp, 'secrets', 'gearjob.json'), 'local-test-only', { mode: 0o600 })", `await copyFile(${JSON.stringify(gearJobCredential)},join(temp,'secrets','gearjob.json'));await (await import('node:fs/promises')).chmod(join(temp,'secrets','gearjob.json'),0o600)`)
    .replace('const auth = createAuthRuntime', 'auth = createAuthRuntime')
    .replace(/const collaborationRunner = createCollaborationRunner\([^\n]+\)/, "collaborationRunner = createCollaborationRunner({store,root:process.cwd(),dshHome:join(temp,'dsh'),secretRoot:join(temp,'secrets'),testHooks:{beforeAgentRequest:event=>capture.beforeAgentRequest(event)},onError:error=>runtimeErrors.push(error)})")
    .replace('const knowledge = collaborationRunner.getKnowledgeService()', 'knowledge = collaborationRunner.getKnowledgeService()')
    .replace('const index = await readFile', 'index = await readFile')
    .replace("document.querySelector('#collab-seconds').value='3600';document.querySelector('#collab-knowledge-query').value='浏览器当前依据'", "document.querySelector('#collab-seconds').value='';document.querySelector('#collab-knowledge-query').value='浏览器当前依据'")
    .replace("runtimeCapture.release('read-order');await runtimeCapture.waitForPending('check-cycle')\n  await waitEval(evaluate, `document.body.innerText.includes('此项已开始，草稿不会提交或丢失')`)", `runtimeCapture.release('read-order');await waitHttpWork(workId,apiOwner,work=>work.collaboration?.status==='waiting_input');console.log('P3_ACCEPT_EVENT:waiting-input:owner:passed:'+Date.now());await logoutUi();await new Promise(resolve=>server.close(resolve));await service.close();collaborationRunner=createCollaborationRunner({store,root:process.cwd(),dshHome:join(temp,'dsh'),secretRoot:join(temp,'secrets'),testHooks:{beforeAgentRequest:event=>capture.beforeAgentRequest(event)},onError:error=>runtimeErrors.push(error)});runtime=collaborationRunner;service=createWorkService({store,collaborationRunner,connectionCatalog:[connection],runner:{async close(){}}});knowledge=collaborationRunner.getKnowledgeService();server=createGenewayServer({service,knowledge,collaborationRunner,store,auth,index,trustedOrigin:origin});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(new URL(origin).port,'127.0.0.1',resolve)});await send('Page.reload',{ignoreCache:true});await waitEval(evaluate,\`Boolean(document.querySelector('#login-name'))\`);await loginUi('owner',${JSON.stringify(passwords.owner)});apiOwner=await login('owner',${JSON.stringify(passwords.owner)});await waitEval(evaluate,\`state.currentWork?.id===\${JSON.stringify(workId)}&&state.currentWork.collaboration?.status==='waiting_input'\`);console.log('P3_ACCEPT_EVENT:restart-relogin:owner:passed:'+Date.now());await evaluate(\`(()=>{const input=document.querySelector('[data-plan-goal="check-cycle"]');input.focus();input.value='运行后仍保留的草稿';input.dispatchEvent(new Event('input'))})()\`);await evaluate(\`document.querySelector('[data-supplement-name="availableSeconds"]').value='3600';document.querySelector('#collaboration-continue-form').requestSubmit()\`);await runtimeCapture.waitForPending('check-cycle');await waitEval(evaluate,\`document.body.innerText.includes('此项已开始，草稿不会提交或丢失')\`);assert.equal(await evaluate(\`document.querySelector('[data-plan-goal="check-cycle"]').value==='运行后仍保留的草稿'&&document.querySelector('[data-plan-goal="check-cycle"]').readOnly&&document.activeElement.id==='plan-goal-check-cycle'\`),true);console.log('P3_ACCEPT_INJECTION:restart-dirty-draft-verified');console.log('P3_ACCEPT_EVENT:waiting-continue:owner:passed:'+Date.now())`)
    .replace("await evaluate(`document.querySelector('[data-supplement-name=\"availableSeconds\"]').value='3600';document.querySelector('#collaboration-continue-form').requestSubmit()`)", "const restartDraftBefore=await evaluate(`(()=>{const input=document.querySelector('[data-plan-goal=\"check-cycle\"]');return{value:input.value,readOnly:input.readOnly,disabled:input.disabled,activeElementId:document.activeElement?.id??null}})()`);acceptanceFacts.restartDraftBefore=restartDraftBefore;assert.equal(restartDraftBefore.value,'运行后仍保留的草稿');assert.equal(restartDraftBefore.readOnly,false);assert.equal(restartDraftBefore.disabled,false);assert.equal(restartDraftBefore.activeElementId,'plan-goal-check-cycle');await evaluate(`document.querySelector('[data-supplement-name=\"availableSeconds\"]').value='3600';document.querySelector('#collaboration-continue-form').requestSubmit()`)")
    .replace("assert.equal(await evaluate(`document.querySelector('[data-plan-goal=\"check-cycle\"]').value==='运行后仍保留的草稿'&&document.querySelector('[data-plan-goal=\"check-cycle\"]').readOnly&&document.activeElement.id==='plan-goal-check-cycle'`),true);console.log('P3_ACCEPT_INJECTION:restart-dirty-draft-verified')", "const restartDraftAfterDom=await evaluate(`(()=>{const input=document.querySelector('[data-plan-goal=\"check-cycle\"]'),active=document.activeElement,tag=active?.tagName??null,nativeFocusable=['INPUT','SELECT','TEXTAREA','BUTTON'].includes(tag)||(tag==='A'&&active.hasAttribute('href'))||Boolean(active?.isContentEditable),labelledBy=(active?.getAttribute?.('aria-labelledby')||'').split(/\\s+/).filter(Boolean).map(id=>document.getElementById(id)?.innerText?.trim()||'').filter(Boolean).join(' '),domName=active?.labels?.[0]?.innerText?.trim()||active?.getAttribute?.('aria-label')?.trim()||labelledBy||(['BUTTON','A'].includes(tag)?active?.innerText?.trim():'')||'';let hidden=false;for(let node=active;node&&node.nodeType===1;node=node.parentElement){const style=getComputedStyle(node);if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'){hidden=true;break}}return{value:input.value,readOnly:input.readOnly,bannerVisible:document.body.innerText.includes('此项已开始，草稿不会提交或丢失'),activeElementId:active?.id??null,activeTag:tag,activeDisabled:Boolean(active?.disabled),activeTabIndex:active?.tabIndex??null,activeNativeFocusable:nativeFocusable,activeDomAccessibleName:domName,activeHidden:hidden}})()`),restartDraftActiveRemote=await send('Runtime.evaluate',{expression:'document.activeElement',objectGroup:'p3-restart-draft',returnByValue:false}),restartDraftActiveObjectId=restartDraftActiveRemote.result?.objectId;assert.ok(restartDraftActiveObjectId);const restartDraftDomNode=await send('DOM.describeNode',{objectId:restartDraftActiveObjectId}),domBackendNodeId=restartDraftDomNode.node?.backendNodeId;assert.ok(Number.isInteger(domBackendNodeId));const restartDraftAxTree=await send('Accessibility.getPartialAXTree',{backendNodeId:domBackendNodeId,fetchRelatives:false}),restartDraftAxNode=restartDraftAxTree.nodes?.find(node=>node.backendDOMNodeId===domBackendNodeId);await send('Runtime.releaseObjectGroup',{objectGroup:'p3-restart-draft'});const restartDraftAfter={...restartDraftAfterDom,domBackendNodeId,axBackendNodeId:restartDraftAxNode?.backendDOMNodeId??null,bound:Boolean(restartDraftAxNode&&restartDraftAxNode.backendDOMNodeId===domBackendNodeId),activeAccessibleName:restartDraftAxNode?.name?.value??null,axRole:restartDraftAxNode?.role?.value??null,axName:restartDraftAxNode?.name?.value??null,axIgnored:restartDraftAxNode?.ignored??null};acceptanceFacts.restartDraftAfter=restartDraftAfter;assert.equal(restartDraftAfter.value,'运行后仍保留的草稿');assert.equal(restartDraftAfter.readOnly,true);assert.equal(restartDraftAfter.bannerVisible,true);assert.equal(['BODY','HTML'].includes(restartDraftAfter.activeTag),false);assert.equal(restartDraftAfter.activeDisabled,false);assert.equal(restartDraftAfter.activeTabIndex<0&&!restartDraftAfter.activeNativeFocusable,false);assert.equal(restartDraftAfter.activeHidden,false);assert.equal(restartDraftAfter.bound,true);assert.equal(restartDraftAfter.axBackendNodeId,restartDraftAfter.domBackendNodeId);assert.equal(restartDraftAfter.axIgnored,false);assert.ok(restartDraftAfter.axRole);assert.ok(restartDraftAfter.axName);assert.ok(restartDraftAfter.activeAccessibleName);console.log('P3_ACCEPT_INJECTION:restart-dirty-draft-verified')")
    .replace("acceptanceFacts.restartDraftAfter=restartDraftAfter;", "acceptanceFacts.restartDraftAfter=restartDraftAfter;const restartDraftAfterMessage='restartDraftAfter '+JSON.stringify({valueMatches:restartDraftAfter.value==='运行后仍保留的草稿',readOnly:restartDraftAfter.readOnly,bannerVisible:restartDraftAfter.bannerVisible,activeElementId:restartDraftAfter.activeElementId,activeTag:restartDraftAfter.activeTag,activeDisabled:restartDraftAfter.activeDisabled,activeTabIndex:restartDraftAfter.activeTabIndex,activeNativeFocusable:restartDraftAfter.activeNativeFocusable,activeHidden:restartDraftAfter.activeHidden,domBackendNodeId:restartDraftAfter.domBackendNodeId,axBackendNodeId:restartDraftAfter.axBackendNodeId,bound:restartDraftAfter.bound,axIgnored:restartDraftAfter.axIgnored,axRole:restartDraftAfter.axRole,axName:restartDraftAfter.axName});console.error('P3_ACCEPT_DIAGNOSTIC:'+restartDraftAfterMessage);")
    .replace("assert.equal(restartDraftAfter.value,'运行后仍保留的草稿')", "assert.equal(restartDraftAfter.value,'运行后仍保留的草稿',restartDraftAfterMessage)")
    .replace('assert.equal(restartDraftAfter.readOnly,true)', 'assert.equal(restartDraftAfter.readOnly,true,restartDraftAfterMessage)')
    .replace('assert.equal(restartDraftAfter.bannerVisible,true)', 'assert.equal(restartDraftAfter.bannerVisible,true,restartDraftAfterMessage)')
    .replace("assert.equal(['BODY','HTML'].includes(restartDraftAfter.activeTag),false)", "assert.equal(['BODY','HTML'].includes(restartDraftAfter.activeTag),false,restartDraftAfterMessage)")
    .replace('assert.equal(restartDraftAfter.activeDisabled,false)', 'assert.equal(restartDraftAfter.activeDisabled,false,restartDraftAfterMessage)')
    .replace('assert.equal(restartDraftAfter.activeTabIndex<0&&!restartDraftAfter.activeNativeFocusable,false)', 'assert.equal(restartDraftAfter.activeTabIndex<0&&!restartDraftAfter.activeNativeFocusable,false,restartDraftAfterMessage)')
    .replace('assert.equal(restartDraftAfter.activeHidden,false)', 'assert.equal(restartDraftAfter.activeHidden,false,restartDraftAfterMessage)')
    .replace('assert.equal(restartDraftAfter.bound,true)', 'assert.equal(restartDraftAfter.bound,true,restartDraftAfterMessage)')
    .replace('assert.equal(restartDraftAfter.axBackendNodeId,restartDraftAfter.domBackendNodeId)', 'assert.equal(restartDraftAfter.axBackendNodeId,restartDraftAfter.domBackendNodeId,restartDraftAfterMessage)')
    .replace('assert.equal(restartDraftAfter.axIgnored,false)', 'assert.equal(restartDraftAfter.axIgnored,false,restartDraftAfterMessage)')
    .replace('assert.ok(restartDraftAfter.axRole)', 'assert.ok(restartDraftAfter.axRole,restartDraftAfterMessage)')
    .replace('assert.ok(restartDraftAfter.axName)', 'assert.ok(restartDraftAfter.axName,restartDraftAfterMessage)')
    .replace('assert.ok(restartDraftAfter.activeAccessibleName)', 'assert.ok(restartDraftAfter.activeAccessibleName,restartDraftAfterMessage)')
    .replace("assert.equal(await evaluate(`document.querySelector('[data-plan-goal=\"check-cycle\"]').value==='运行后仍保留的草稿'&&document.querySelector('[data-plan-goal=\"check-cycle\"]').readOnly&&document.activeElement.id==='plan-goal-check-cycle'`), true)", "assert.equal(restartDraftAfter.value,'运行后仍保留的草稿');assert.equal(restartDraftAfter.readOnly,true)")
    .replace("console.log('P3 HTTP/UI checks passed', JSON.stringify(browserResult.viewports))", "await writeFile(process.env.GENEWAY_P3_ACCEPT_EXPORT,JSON.stringify({temp,state:await store.read(),browserResult},null,2),{mode:0o600});console.log('P3 HTTP/UI checks passed', JSON.stringify(browserResult.viewports))")
    .replace("await rm(temp, { recursive: true, force: true })", "if(!process.env.GENEWAY_P3_ACCEPT_EXPORT)await rm(temp,{recursive:true,force:true})")
    .replace('\nasync function startCapture() {', `\nfunction startRuntimeControl(store){const holds=new Set(),pending=new Map(),seen=new Set();return{address:'unused',setKnowledge(){},hold(id){holds.add(id)},release(id){holds.delete(id);for(const done of pending.get(id)??[])done();pending.delete(id)},async waitForPending(id){const until=Date.now()+120000;while(!pending.has(id)){if(Date.now()>until)throw new Error('runtime pending timeout '+id);await new Promise(r=>setTimeout(r,25))}},async waitFor(id){const until=Date.now()+120000;while(!seen.has(id)){if(Date.now()>until)throw new Error('runtime seen timeout '+id);await new Promise(r=>setTimeout(r,25))}},async beforeAgentRequest({binding}){if(binding?.kind!=='child')return;const state=await store.read(),item=state.works.find(work=>work.id===binding.workId)?.planItemId;if(!item)return;seen.add(item);if(!holds.has(item))return;await new Promise(resolve=>{const list=pending.get(item)??[];list.push(resolve);pending.set(item,list)})},async close(){for(const list of pending.values())for(const done of list)done();pending.clear()}}}\nasync function startCapture() {`)
    .replace(`await loginUi('owner','${passwords.owner}')`, `await loginUi('admin','${passwords.admin}');await keyboardActivate('[data-view="admin"]');for(const tab of ['members','employees','connections','skills','modelRoutes']){await evaluate(\`document.querySelector('[data-config="\${tab}"]').click()\`);await new Promise(resolve=>setTimeout(resolve,500))}console.log('P3_ACCEPT_EVENT:admin-config:admin:passed:'+Date.now());await logoutUi();await loginUi('owner','${passwords.owner}')`)
    .replace("await waitEval(evaluate, `document.querySelector('#knowledge-message').innerText==='知识已导入，可供所选员工使用'&&document.body.innerText.includes('浏览器知识')`)", "await waitEval(evaluate, `document.querySelector('#knowledge-message').innerText==='知识已导入，可供所选员工使用'&&document.body.innerText.includes('浏览器知识')`);console.log('P3_ACCEPT_EVENT:owner-import:owner:passed:'+Date.now())")
    .replace("const knowledgeId = await evaluate(`state.knowledge.find(item=>item.title==='浏览器知识').id`)", "const knowledgeId = await evaluate(`state.knowledge.find(item=>item.title==='浏览器知识').id`);const ownerPrivateRead=await request('/api/knowledge/'+knowledgeId+'?employeeId=employee-b',{cookie:apiOwner.cookie});acceptanceFacts.ownerPrivateStatus=ownerPrivateRead.status;acceptanceFacts.ownerPrivateUiResult=await evaluate(`document.body.innerText.includes('浏览器知识')`)")
    .replace("await waitEval(evaluate, `document.querySelector('#knowledge-message').innerText.includes('共享范围已更新')`)", `await waitEval(evaluate, \`document.querySelector('#knowledge-message').innerText.includes('共享范围已更新')\`);const peerProbe=await login('peer',${JSON.stringify(passwords.peer)}),peerSharedRead=await request('/api/knowledge/'+knowledgeId+'?employeeId=employee-b',{cookie:peerProbe.cookie}),peerUnauthorizedRead=await request('/api/knowledge/'+knowledgeId+'?employeeId=employee-a',{cookie:peerProbe.cookie});acceptanceFacts.peerSharedStatus=peerSharedRead.status;acceptanceFacts.unauthorizedEmployeeStatus=peerUnauthorizedRead.status;console.log('P3_ACCEPT_EVENT:owner-share:owner:passed:'+Date.now())`)
    .replace('let apiOwner = ownerSession', 'let apiOwner = ownerSession;const acceptanceFacts={}')
    .replace("await waitEval(evaluate, `document.body.innerText.includes('明确区分工单事实')`)\n  await logoutUi()", "await waitEval(evaluate, `document.body.innerText.includes('明确区分工单事实')`);const peerNegative=await evaluate(`![...document.querySelectorAll('#knowledge-search-employee option')].some(option=>option.value==='employee-a')`);assert.equal(peerNegative,true);acceptanceFacts.peerSharedUiResult='visible';acceptanceFacts.unauthorizedEmployeeUiResult='option-absent';console.log('P3_ACCEPT_EVENT:peer-positive-negative:peer:passed:'+Date.now())\n  await logoutUi()")
    .replace("assert.equal(await evaluate(`document.body.innerText.includes('服务端最新目标')`), true)", "assert.equal(await evaluate(`document.body.innerText.includes('服务端最新目标')`), true);console.log('P3_ACCEPT_EVENT:plan-edit-conflict:owner:passed:'+Date.now())")
    .replace("const completedWork=await waitHttpWork(workId,apiOwner,work=>['completed','failed'].includes(work.status));assert.equal(completedWork.status,'completed',JSON.stringify({completedWork,runtimeErrors:runtimeErrors.map(error=>error.stack)}))", "const completedWork=await waitHttpWork(workId,apiOwner,work=>['completed','failed'].includes(work.status));assert.equal(completedWork.status,'completed',JSON.stringify({completedWork,runtimeErrors:runtimeErrors.map(error=>error.stack)}));console.log('P3_ACCEPT_EVENT:root-completed:owner:passed:'+Date.now())")
    .replace("await waitEval(evaluate, `document.body.innerText.includes('明确区分工单事实')`)\n  await logoutUi();await evaluate", "await waitEval(evaluate, `document.body.innerText.includes('明确区分工单事实')`);console.log('P3_ACCEPT_EVENT:source-reference:owner:passed:'+Date.now())\n  await logoutUi();await evaluate")
    .replace("const staleCanaryLines=", "console.log('P3_ACCEPT_EVENT:update-stale:owner:passed:'+Date.now());const staleCanaryLines=")
    .replace("await waitEval(evaluate, `state.currentWork?.status==='completed'&&state.currentWork?.collaboration?.generation===2`)", "await waitEval(evaluate, `state.currentWork?.status==='completed'&&state.currentWork?.collaboration?.generation===3`)")
    .replace("item.status==='current'&&item.generation===2", "item.status==='current'&&item.generation===3")
    .replace("assert.equal(rechecked.body.results.at(-1).generation, 2)", "assert.equal(rechecked.body.results.at(-1).generation, 3);console.log('P3_ACCEPT_EVENT:recheck:owner:passed:'+Date.now())")
    .replace("await send('Emulation.setDeviceMetricsOverride', { width: 390", "console.log('P3_ACCEPT_EVENT:mobile-actions:owner:started:'+Date.now());await send('Emulation.setDeviceMetricsOverride', { width: 390")
    .replace("const w1Body = collaborationBody()", "console.log('P3_ACCEPT_EVENT:mobile-actions:owner:passed:'+Date.now());const w1Body = collaborationBody()")
    .replace("runtimeCapture.release('cancel-item')", "runtimeCapture.release('cancel-item');console.log('P3_ACCEPT_EVENT:w1-w2:owner:passed:'+Date.now())")
    .replace("await runtime.disableKnowledge()", "await runtime.disableKnowledge();console.log('P3_ACCEPT_EVENT:plugin-disable-maintenance:owner:started:'+Date.now())")
    .replace("await runtime.enableKnowledge()", "console.log('P3_ACCEPT_EVENT:plugin-disable-maintenance:owner:passed:'+Date.now());await runtime.enableKnowledge();const finalW1Readback=await request('/api/works/'+w1.body.id,{cookie:apiOwner.cookie}),finalW2Readback=await request('/api/works/'+w2.body.id,{cookie:apiOwner.cookie});assert.equal(finalW1Readback.status,200);assert.equal(finalW2Readback.status,200);const finalW1W2={w1Status:finalW1Readback.body.status,w2Status:finalW2Readback.body.status,lateResultOverwrote:finalW1Readback.body.status!=='cancelled'}")
    .replace("assert.equal(peerMaterial.status,404)", "assert.equal(peerMaterial.status,404);console.log('P3_ACCEPT_EVENT:revoke-peer-no-leak:peer:passed:'+Date.now())")
    .replace(";const peerSearch=await request('/api/knowledge/search'", ";acceptanceFacts.revokedUiResult='redacted';const peerSearch=await request('/api/knowledge/search'")
    .replace("['--headless=new', '--no-sandbox'", "['--no-sandbox', '--test-type', '--ozone-platform=x11', '--no-first-run', '--new-window', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-infobars', '--hide-crash-restore-bubble', '--disable-save-password-bubble', '--password-store=basic', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints,ChromeWhatsNewUI,SidePanelPinning,SidePanelJourneys'")
    .replace("const debuggingPort = await freePort(), userData = join(temp, 'chrome')", "const debuggingPort = await freePort(), userData = join(temp, 'chrome');await mkdir(join(userData,'Default'),{recursive:true,mode:0o700});await writeFile(join(userData,'Default','Preferences'),JSON.stringify({credentials_enable_service:false,profile:{password_manager_enabled:false},translate:{enabled:false}}),{mode:0o600})")
    .replace("{ stdio: 'ignore' })", "{ stdio: 'inherit' })")
    .replace("targets.find(item => item.type === 'page' && item.url.startsWith(expectedOrigin))", "targets.find(item => item.type === 'page')")
    .replace("await send('Emulation.setDeviceMetricsOverride'", "await send('Page.navigate',{url:origin});await send('Emulation.setDeviceMetricsOverride'")
    .replace("const evaluate = async expression => { const result = await send('Runtime.evaluate'", "const evaluate = async expression => { await new Promise(resolve=>setTimeout(resolve,120)); const result = await send('Runtime.evaluate'")
    .replace('let sequence = 0', 'let sequence = 0, networkHeaderSecretHits = 0, networkHeaderSamples = [], activeNetworkRequests = new Set(), networkActivityAt = Date.now()')
    .replace("if(message.method==='Network.requestWillBeSent')requests.set", "if(message.method==='Network.requestWillBeSent'){activeNetworkRequests.add(message.params.requestId);networkActivityAt=Date.now();const headerText=JSON.stringify(message.params.request.headers??{});networkHeaderSamples.push(headerText);networkHeaderSecretHits+=acceptanceNeedles.filter(value=>headerText.includes(value)).length;requests.set")
    .replace("{url:message.params.request.url,method:message.params.request.method});if(message.method==='Network.responseReceived')", "{url:message.params.request.url,method:message.params.request.method})}if(message.method==='Network.responseReceived')")
    .replace("if (message.method === 'Network.loadingFailed' &&", "if(message.method==='Network.loadingFinished'||message.method==='Network.loadingFailed'){activeNetworkRequests.delete(message.params.requestId);networkActivityAt=Date.now()} if (message.method === 'Network.loadingFailed' &&")
    .replace("const logoutUi = async () => { await evaluate(`document.querySelector('#logout').click()`);await waitEval(evaluate, `!document.querySelector('#login-shell').classList.contains('hidden')`) }", `${waitForStableNetworkIdle.toString()}\n  const logoutUi = async () => { await evaluate(\`stopPolling()\`);networkActivityAt=Date.now();await waitForStableNetworkIdle({activeRequests:activeNetworkRequests,lastActivity:()=>networkActivityAt});await evaluate(\`document.querySelector('#logout').click()\`);await waitEval(evaluate, \`!document.querySelector('#login-shell').classList.contains('hidden')\`) }`)
    .replace('\n  socket.close()\n', '\n')
    .replace('const keyboardActivate=async selector=>', 'let keyboardActivate=async selector=>')
    .replace("await send('Runtime.enable');await send('Network.enable')", `const visualScans=[],acceptanceNeedles=${JSON.stringify(Object.values(passwords))};const surface=async label=>{const dom=await evaluate(\`(()=>{const values=[...document.querySelectorAll('input,textarea,select')].map(node=>({name:node.name||node.id,type:node.type,value:node.type==='password'?'[password-field]':node.value}));const shadow=[];const walk=node=>{if(node.shadowRoot){shadow.push(node.shadowRoot.innerText||'');node.shadowRoot.querySelectorAll('*').forEach(walk)}};document.querySelectorAll('*').forEach(walk);return {text:document.body.innerText,values,shadow}})()\`);const ax=await send('Accessibility.getFullAXTree');const raw=JSON.stringify({dom,ax});const hits=acceptanceNeedles.filter(value=>raw.includes(value));if(hits.length)throw new Error('visible surface contains acceptance secret');visualScans.push({label,sha256:createHash('sha256').update(raw).digest('hex'),bytes:Buffer.byteLength(raw),axNodes:ax.nodes?.length??0,secretHits:0})};const baseKeyboardActivate=keyboardActivate;keyboardActivate=async selector=>{await surface('before:'+selector);await baseKeyboardActivate(selector);await surface('after:'+selector)};await send('Runtime.enable');await send('Network.enable');let surfaceBusy=false;const visualTimer=setInterval(async()=>{if(surfaceBusy)return;surfaceBusy=true;try{await surface('poll:'+Date.now())}finally{surfaceBusy=false}},500)`)
    .replace('return { desktopOverflow, mobileOverflow, text,', "clearInterval(visualTimer);while(surfaceBusy)await new Promise(resolve=>setTimeout(resolve,10));await surface('final');const browserCookieResult=await send('Network.getCookies',{urls:[origin]}),browserCsrf=await evaluate(`state.csrf`),browserSessionSecrets=[...new Set([...(browserCookieResult.cookies??[]).map(cookie=>cookie.value),browserCsrf].filter(value=>typeof value==='string'&&value.length))],browserNetworkHeaderSecretHits=browserSessionSecrets.reduce((sum,value)=>sum+networkHeaderSamples.filter(sample=>sample.includes(value)).length,0);socket.close();return { acceptanceSecretValues:[apiOwner?.cookie,apiOwner?.body?.csrfToken,...browserSessionSecrets].filter(Boolean), acceptance:{...acceptanceFacts,peerSearchStatus:peerSearch.status,peerSearchCount:peerSearch.body.length,peerRootStatus:peerRoot.status,peerMaterialStatus:peerMaterial.status,w1Id:w1.body.id,w1Status:finalW1W2.w1Status,w2Id:w2.body.id,w2Status:finalW1W2.w2Status,lateResultOverwrote:finalW1W2.lateResultOverwrote}, visualScans, networkHeaderSecretHits:networkHeaderSecretHits+browserNetworkHeaderSecretHits, networkHeaderSamples:networkHeaderSamples.length, desktopOverflow, mobileOverflow, text,")
    .replace('for (let i = 0; i < 100; i += 1)', 'for (let i = 0; i < 400; i += 1)')
    .replaceAll('i < 800', 'i < 16000')
    .replaceAll('Date.now()+20_000', 'Date.now()+360_000')
  const requiredGeneratedMarkers=['admin-config','owner-import','owner-share','peer-positive-negative','plan-edit-conflict','waiting-input','restart-relogin','waiting-continue','root-completed','source-reference','update-stale','recheck','mobile-actions','w1-w2','plugin-disable-maintenance','revoke-peer-no-leak']
  for(const marker of requiredGeneratedMarkers)if(!visible.includes(`P3_ACCEPT_EVENT:${marker}:`))throw new Error(`required generated event injection missed: ${marker}`)
  for(const fact of ['ownerPrivateStatus','peerSharedStatus','unauthorizedEmployeeStatus','peerSharedUiResult','unauthorizedEmployeeUiResult','revokedUiResult','restartDraftBefore','restartDraftAfter'])if(!visible.includes(`acceptanceFacts.${fact}`))throw new Error(`required measured browser fact injection missed: ${fact}`)
  for(const marker of ['P3_ACCEPT_TEMP:','P3_ACCEPT_INJECTION:restart-dirty-draft-verified'])if(!visible.includes(marker))throw new Error(`required harness injection marker missed: ${marker}`)
  for(const snippet of ["assert.equal(restartDraftBefore.disabled,false)","assert.equal(restartDraftBefore.activeElementId,'plan-goal-check-cycle')","console.error('P3_ACCEPT_DIAGNOSTIC:'",'assert.equal(restartDraftAfter.bannerVisible,true,restartDraftAfterMessage)',"assert.equal(['BODY','HTML'].includes(restartDraftAfter.activeTag),false,restartDraftAfterMessage)",'assert.equal(restartDraftAfter.activeDisabled,false,restartDraftAfterMessage)','assert.equal(restartDraftAfter.activeTabIndex<0&&!restartDraftAfter.activeNativeFocusable,false,restartDraftAfterMessage)','assert.equal(restartDraftAfter.activeHidden,false,restartDraftAfterMessage)',"send('DOM.describeNode',{objectId:restartDraftActiveObjectId})","send('Accessibility.getPartialAXTree',{backendNodeId:domBackendNodeId,fetchRelatives:false})",'assert.equal(restartDraftAfter.bound,true,restartDraftAfterMessage)','assert.equal(restartDraftAfter.axBackendNodeId,restartDraftAfter.domBackendNodeId,restartDraftAfterMessage)','assert.equal(restartDraftAfter.axIgnored,false,restartDraftAfterMessage)','assert.ok(restartDraftAfter.axRole,restartDraftAfterMessage)','assert.ok(restartDraftAfter.axName,restartDraftAfterMessage)','assert.ok(restartDraftAfter.activeAccessibleName,restartDraftAfterMessage)'])if(!visible.includes(snippet))throw new Error(`required restart draft assertion injection missed: ${snippet}`)
  for(const forbidden of ['active?.name||active?.id',"active?.name||active?.id||''"])if(visible.includes(forbidden))throw new Error('restart draft accessible name must not fall back to DOM name/id')
  for(const forbidden of ["restartDraftAxTree=await send('Accessibility.getFullAXTree')",'restartDraftFocusedAx'])if(visible.includes(forbidden))throw new Error('restart draft AX evidence must bind through the active DOM backend node')
  for(const snippet of ["state.currentWork?.collaboration?.generation===3","item.status==='current'&&item.generation===3","assert.equal(rechecked.body.results.at(-1).generation, 3)","state.currentWork?.id===${JSON.stringify(mobileWorkId)}","state.currentWork?.collaboration?.generation===2"])if(!visible.includes(snippet))throw new Error(`required generation assertion injection missed: ${snippet}`)
  if(visible.includes("assert.equal(rechecked.body.results.at(-1).generation, 2)"))throw new Error('restarted root recheck must assert generation 3')
  if(visible.includes("readOnly&&document.activeElement.id==='plan-goal-check-cycle'"))throw new Error('post-submit focus must not require the plan input')
  const logoutUiIndex=visible.indexOf('const logoutUi = async'),stopPollingIndex=visible.indexOf('await evaluate(`stopPolling()`)',logoutUiIndex),networkIdleIndex=visible.indexOf('await waitForStableNetworkIdle(',logoutUiIndex),logoutClickIndex=visible.indexOf("document.querySelector('#logout').click()",logoutUiIndex)
  if(logoutUiIndex<0||stopPollingIndex<0||networkIdleIndex<0||logoutClickIndex<0||!(logoutUiIndex<stopPollingIndex&&stopPollingIndex<networkIdleIndex&&networkIdleIndex<logoutClickIndex))throw new Error('generated logout must stop polling and drain network before activation')
  for(const snippet of ['activeNetworkRequests.add(message.params.requestId)',"message.method==='Network.loadingFinished'||message.method==='Network.loadingFailed'",'activeNetworkRequests.delete(message.params.requestId)','networkActivityAt=Date.now()','assert.deepEqual(unexpectedResponses,[])'])if(!visible.includes(snippet))throw new Error(`generated pre-logout network drain is missing: ${snippet}`)
  const finalSurfaceBusyIndex=visible.indexOf('while(surfaceBusy)'),finalSurfaceIndex=visible.indexOf("await surface('final')"),socketCloseIndex=visible.indexOf('socket.close()')
  if(finalSurfaceBusyIndex<0||finalSurfaceIndex<0||socketCloseIndex<0||!(finalSurfaceBusyIndex<finalSurfaceIndex&&finalSurfaceIndex<socketCloseIndex)||visible.indexOf('socket.close()',socketCloseIndex+1)>=0)throw new Error('generated final surface capture must finish before the single CDP socket close')
  const browserCookiesIndex=visible.indexOf("send('Network.getCookies',{urls:[origin]})"),browserCsrfIndex=visible.indexOf('browserCsrf=await evaluate(`state.csrf`)'),browserHeaderScanIndex=visible.indexOf('browserNetworkHeaderSecretHits=browserSessionSecrets.reduce')
  if(browserCookiesIndex<0||browserCsrfIndex<0||browserHeaderScanIndex<0||!(finalSurfaceIndex<browserCookiesIndex&&browserCookiesIndex<browserCsrfIndex&&browserCsrfIndex<browserHeaderScanIndex&&browserHeaderScanIndex<socketCloseIndex))throw new Error('browser session header-secret scan must finish before the CDP socket closes')
  for(const snippet of ['acceptanceSecretValues:[apiOwner?.cookie,apiOwner?.body?.csrfToken,...browserSessionSecrets]','networkHeaderSecretHits:networkHeaderSecretHits+browserNetworkHeaderSecretHits'])if(!visible.includes(snippet))throw new Error(`generated browser secret evidence is missing: ${snippet}`)
  for(const forbidden of ['console.log(browserSessionSecrets','console.error(browserSessionSecrets','JSON.stringify(browserSessionSecrets)'])if(visible.includes(forbidden))throw new Error('generated browser session secrets must never be printed or serialized directly')
  const finalW1W2ReadbackIndex=visible.indexOf('const finalW1Readback='),finalPeerIndex=visible.indexOf('const peerAfterRevoke='),finalOwnerLogoutIndex=visible.lastIndexOf('await logoutUi();',finalPeerIndex),browserReturnIndex=visible.indexOf('return { acceptanceSecretValues:')
  if(finalW1W2ReadbackIndex<0||finalOwnerLogoutIndex<0||finalPeerIndex<0||browserReturnIndex<0||!(finalW1W2ReadbackIndex<finalOwnerLogoutIndex&&finalOwnerLogoutIndex<finalPeerIndex&&finalPeerIndex<browserReturnIndex))throw new Error('generated W1/W2 readback must precede the final owner logout and peer boundary')
  const postOwnerLogout=visible.slice(finalOwnerLogoutIndex);for(const staleRequest of ["request('/api/works/'+w1.body.id","request('/api/works/'+w2.body.id",'measuredW1','measuredW2'])if(postOwnerLogout.includes(staleRequest))throw new Error(`generated return must not use stale owner W1/W2 readback: ${staleRequest}`)
  for(const scalar of ['w1Status:finalW1W2.w1Status','w2Status:finalW1W2.w2Status','lateResultOverwrote:finalW1W2.lateResultOverwrote'])if(!visible.includes(scalar))throw new Error(`generated return is missing W1/W2 scalar evidence: ${scalar}`)
  const restartScope='let server, browser, service, collaborationRunner, knowledge, auth, index'
  if(!visible.includes(restartScope))throw new Error('generated restart scope declaration missing')
  for(const assignment of ['auth = createAuthRuntime','collaborationRunner = createCollaborationRunner','knowledge = collaborationRunner.getKnowledgeService()','index = await readFile','runtime=collaborationRunner','service=createWorkService','server=createGenewayServer'])if(!visible.includes(assignment))throw new Error(`generated restart assignment missing: ${assignment}`)
  for(const variable of ['collaborationRunner','knowledge','service','server'])if((visible.match(new RegExp(`\\b${variable}\\s*=`, 'g'))??[]).length<2)throw new Error(`generated restart reassignment missing: ${variable}`)
  for(const shadowed of ['const auth = createAuthRuntime','const collaborationRunner = createCollaborationRunner','let collaborationRunner = createCollaborationRunner','const knowledge = collaborationRunner.getKnowledgeService()','let knowledge = collaborationRunner.getKnowledgeService()','const index = await readFile'])if(visible.includes(shadowed))throw new Error(`generated restart binding is shadowed: ${shadowed}`)
  await writeFile(tempUiScript, visible)
  if (harnessCheck) { await run(process.execPath, ['--check', relative(root, tempUiScript)]);await watchdogSmoke();await networkIdleDrainSmoke();browserAcceptanceDiagnosticSmoke();browserDiagnosticsDiagnosticSmoke();gearEvidenceGateSmoke();workSessionRefSmoke();const harnessSource=await readFile(join(root,'scripts','accept-p3.mjs'),'utf8');assert.ok(harnessSource.includes('delete exported.browserResult.acceptanceSecretValues;await rm(exportPath,{force:true})'));assert.equal(/gear\??\.evidenceMode/.test(harnessSource),false);assert.ok(harnessSource.includes('evidenceMode: gear.payload.evidenceMode'));assert.ok(harnessSource.includes('stageSessions(collectWorkSessionRefs(state.works))'));assert.ok(harnessSource.includes('const sessionMappings = [rootWork, ...children]'));for(const snippet of ["spawn('/usr/bin/google-chrome'","mkdir(join(profile, 'Default')","credentials_enable_service: false","password_manager_enabled: false","translate: { enabled: false }","'--no-first-run'","'--new-window'","'--no-default-browser-check'","'--ozone-platform=x11'","'--disable-infobars'","'--hide-crash-restore-bubble'","'--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints,ChromeWhatsNewUI,SidePanelPinning,SidePanelJourneys'","browserTarget(port, chrome, origin)","item.type==='page'&&item.url.startsWith(origin)"])assert.ok(harnessSource.includes(snippet),`restored Chrome bootstrap missing: ${snippet}`);return { generatedSyntax: 'passed',watchdogCleanup:'passed',networkIdleDrain:'passed',safeBrowserDiagnostic:'passed',gearEvidenceProjection:'passed',fullSessionStaging:'passed',restoredChromeBootstrap:'passed' } }
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
  await pause(800)
  if (recordPath) {
    await mkdir(dirname(recordPath), { recursive: true })
    recorder = spawn('ffmpeg', ['-y', '-f', 'x11grab', '-framerate', '25', '-video_size', '1440x900', '-i', display, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', recordPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    recorder.stderr.resume()
    recordingStartedAt=Date.now()
    await pause(600)
  }
  const startedAt = Date.now()
  const exportPath = join(scratch, 'formal-ui-export.json')
  const progress=createJourneyProgress({videoPath:recordPath})
  const registerExternalTemp=createExternalTempRegistrar(externalTemps)
  const journeyOutput = await gate('P3 ordinary UI journey (Xvfb/CDP)', process.execPath, [relative(root, tempUiScript)], {
    env: { ...process.env, DISPLAY: display, GENEWAY_P3_ACCEPT_EXPORT: exportPath }, killGroup:true,
    onStdout(chunk){registerExternalTemp(chunk);progress.onStdout(chunk)},watchdog:progress.watchdog
  })
  const durationSeconds = (Date.now() - startedAt) / 1000
  if (!recordPath) { await stop(recorder, 'SIGINT'); recorder = undefined; await stop(xvfb, 'SIGTERM'); xvfb = undefined }
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));externalTemps.push(exported.temp);runtimeSecrets.push(...(exported.browserResult.acceptanceSecretValues??[]));delete exported.browserResult.acceptanceSecretValues;await rm(exportPath,{force:true});lastBrowserExport=exported
  const timelineOrigin=recordingStartedAt??startedAt,events = [...journeyOutput.matchAll(/P3_ACCEPT_EVENT:([a-z0-9-]+):(admin|owner|peer):(started|passed):(\d+)/g)].map(match => ({ name:match[1],actor:match[2],result:match[3],timestampSeconds:Number(((Number(match[4])-timelineOrigin)/1000).toFixed(3)) }))
  const requiredEvents=[['admin-config','admin'],['owner-import','owner'],['owner-share','owner'],['peer-positive-negative','peer'],['plan-edit-conflict','owner'],['waiting-input','owner'],['restart-relogin','owner'],['waiting-continue','owner'],['root-completed','owner'],['source-reference','owner'],['update-stale','owner'],['recheck','owner'],['mobile-actions','owner'],['w1-w2','owner'],['plugin-disable-maintenance','owner'],['revoke-peer-no-leak','peer']]
  let previousEnd=0;const steps=requiredEvents.map(([name,actor],index)=>{const matches=events.filter(event=>event.name===name);if(!matches.length||matches.some(event=>event.actor!==actor)||matches.at(-1).result!=='passed')throw new Error(`required measured event missing or contradictory: ${name}`);const start=matches.find(event=>event.result==='started')?.timestampSeconds??previousEnd,end=matches.at(-1).timestampSeconds;if(end<start||start<previousEnd)throw new Error(`required measured event order invalid: ${name}`);previousEnd=end;return{id:index+1,actor,action:name,expected:'通过同一真实 GearJob/ZenMux 普通 UI 旅程完成',startSeconds:start,endSeconds:end,result:'passed',dataMode:'live GearJob REST + live ZenMux DeepSeek'}})
  lastBrowserSteps = steps
  const measured=exported.browserResult,acceptance=measured.acceptance
  assertBrowserAcceptanceFacts(acceptance)
  if(acceptance.restartDraftBefore?.value!=='运行后仍保留的草稿'||acceptance.restartDraftBefore.readOnly!==false||acceptance.restartDraftBefore.disabled!==false||acceptance.restartDraftBefore.activeElementId!=='plan-goal-check-cycle'||acceptance.restartDraftAfter?.value!=='运行后仍保留的草稿'||acceptance.restartDraftAfter.readOnly!==true||acceptance.restartDraftAfter.bannerVisible!==true||['BODY','HTML'].includes(acceptance.restartDraftAfter.activeTag)||acceptance.restartDraftAfter.activeDisabled!==false||(acceptance.restartDraftAfter.activeTabIndex<0&&!acceptance.restartDraftAfter.activeNativeFocusable)||acceptance.restartDraftAfter.activeHidden!==false||!Number.isInteger(acceptance.restartDraftAfter.domBackendNodeId)||acceptance.restartDraftAfter.bound!==true||acceptance.restartDraftAfter.axBackendNodeId!==acceptance.restartDraftAfter.domBackendNodeId||acceptance.restartDraftAfter.axIgnored!==false||!acceptance.restartDraftAfter.axRole||!acceptance.restartDraftAfter.axName||acceptance.restartDraftAfter.activeAccessibleName!==acceptance.restartDraftAfter.axName)throw new Error('restart draft browser facts missing or contradictory')
  assertBrowserDiagnostics(measured)
  return {
    steps,
    authorization: { ownerPrivate:{status:acceptance.ownerPrivateStatus,uiResult:acceptance.ownerPrivateUiResult},peerShared:{status:acceptance.peerSharedStatus,uiResult:acceptance.peerSharedUiResult},unauthorizedEmployee:{status:acceptance.unauthorizedEmployeeStatus,uiResult:acceptance.unauthorizedEmployeeUiResult},revoked:{searchStatus:acceptance.peerSearchStatus,searchCount:acceptance.peerSearchCount,rootStatus:acceptance.peerRootStatus,materialStatus:acceptance.peerMaterialStatus,uiResult:acceptance.revokedUiResult} },
    cancel: { w1Id:acceptance.w1Id,w1:acceptance.w1Status,w2Id:acceptance.w2Id,w2:acceptance.w2Status,lateResultOverwrote:acceptance.lateResultOverwrote },
    browser: { viewports:measured.viewports,execution:{mode:'visible-chrome-xvfb-cdp',domCaptureCount:measured.visualScans.length,axNodeCount:measured.visualScans.reduce((sum,item)=>sum+item.axNodes,0),sessionBound:true},restartDraft:{before:acceptance.restartDraftBefore,after:acceptance.restartDraftAfter},consoleUnexpected:measured.consoleErrors.length,networkFailed:measured.failedRequests.length,unexpectedResponses:measured.unexpectedResponses.length,horizontalOverflow:measured.desktopOverflow||measured.mobileOverflow,networkHeaderSamples:measured.networkHeaderSamples,networkHeaderSecretHits:measured.networkHeaderSecretHits,durationSeconds },
    evidence: { stateVersion: exported.state.version, workCount: exported.state.works.length, knowledgeCount: exported.state.knowledgeMaterials.length },
  }
}

async function realEvidenceFromBrowser(exported) {
  const state = exported.state, rootWork = state.works.find(work => work.workType === 'collaboration' && work.goal === '浏览器协作核对')
  if (!rootWork || !['completed', 'stale'].includes(rootWork.collaboration?.status)) throw new Error('formal browser root is not complete')
  const children = state.works.filter(work => work.rootWorkId === rootWork.id)
  const gear = children.find(work => work.capabilityId === 'gearjob-work-order-read')?.results.at(-1)
  const cycle = children.find(work => work.capabilityId === 'cycle-time-calculate')?.results.at(-1)
  assertRealGearEvidence(gear,workOrderId)
  if (cycle?.payload?.quantity !== gear.payload.plannedQuantity - gear.payload.completedQuantity || cycle.payload.availableSeconds !== 3600) throw new Error('formal browser derived cycle evidence is inconsistent')
  const sessions = await stageSessions(collectWorkSessionRefs(state.works))
  const sessionById = new Map(sessions.map(item => [item.sessionRef, item]))
  const sessionMappings = [rootWork, ...children].flatMap(work => work.executions.filter(item => item.dshSessionRef).map(execution => { const result=work.results.find(item=>item.id===execution.resultId),session=sessionById.get(execution.dshSessionRef);return { sessionRef:execution.dshSessionRef,workId:work.id,executionId:execution.id,employeeId:execution.employeeId,resultId:execution.resultId??null,resultKind:result?.kind??null,generation:execution.generation??null,status:execution.status,usage:execution.usage??null,sessionSha256:session?.sha256,sessionBytes:session?.bytes,requestEvents:session?.requestEvents??null,tools:session?.tools??[],structured:session?.structured??null,canaryHits:session?.canaryHits??{} } }))
  const usageValues = [rootWork, ...children].flatMap(work => work.executions.map(item => item.usage))
  const serializedState=JSON.stringify(state),canaryCatalog=lastCanaries.map(item=>({label:item.label,sha256:item.sha256,scope:item.label==='r1'?'superseded knowledge revision':'current or revoked knowledge revision',status:item.label==='r1'?'forbidden-in-successor':'classified',measuredStateHits:serializedState.split(item.value).length-1,measuredCurrentSessionHits:sessionMappings.filter(session=>session.generation===rootWork.collaboration.generation).reduce((sum,session)=>sum+(session.canaryHits?.[item.label]??0),0)}))
  return {
    source: { workOrderId: gear.payload.workOrderId, status: gear.payload.status, plannedQuantity: gear.payload.plannedQuantity, completedQuantity: gear.payload.completedQuantity, unit: gear.payload.unit, sourceTime: gear.payload.sourceTime, sourceRevision: gear.payload.sourceRevision, sourceSystem: gear.payload.sourceSystem, sourceInstance: gear.payload.sourceInstance, sourceEnvironment: gear.payload.sourceEnvironment, dataMode: gear.payload.dataMode, evidenceMode: gear.payload.evidenceMode, remainingQuantity: cycle.payload.quantity, provisioned: false },
    model: { provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', rootAndChildren: true, recheck: rootWork.collaboration.generation > 1, usage: usageValues.some(value => !value) ? null : usageValues.reduce((sum, value) => sum + (value.totalTokens ?? 0), 0) },
    knowledge: { revisions: exported.state.knowledgeMaterials.map(item => item.revision), statuses: exported.state.knowledgeMaterials.map(item => item.status), canaryCatalog, r1CurrentSessionHits:canaryCatalog.find(item=>item.label==='r1')?.measuredCurrentSessionHits??null },
    collaboration: { rootWorkId: rootWork.id, childWorkIds: children.map(item => item.id), generation: rootWork.collaboration.generation, planRevision: rootWork.plan.revision, handoffs: rootWork.handoffs.map(item => ({ generation: item.generation, status: item.status, resultCount: item.resultRefs.length, knowledgeRefCount: item.knowledgeRefs.length })), sessions: sessionMappings, expectedSecondsPerUnit: 3600 / cycle.payload.quantity, status: rootWork.collaboration.status },
  }
}

async function backupRestore(real, sourceStatePath = statePath) {
  await service?.close(); service = undefined; runner = undefined
  const backup = JSON.parse(await run('node', ['scripts/state-transfer.mjs', 'backup', '--output', backupPath], { env: { ...process.env, GENEWAY_STATE: sourceStatePath, GENEWAY_DSH_HOME: dshHome, GENEWAY_CANDIDATE: candidate } }))
  const restored = JSON.parse(await run('node', ['scripts/state-transfer.mjs', 'restore', '--input', backupPath, '--data-root', restorePath]))
  const restoredState = JSON.parse(await readFile(join(restorePath, 'state.json'), 'utf8'))
  const sourceState = JSON.parse(await readFile(sourceStatePath, 'utf8')), graphKeys=['members','modelRoutes','employees','connections','skills','confirmations','works','reservations','knowledgeMaterials']
  for(const key of graphKeys)assert.deepEqual(restoredState[key],sourceState[key],`restore changed ${key}`)
  const rootWork = restoredState.works.find(item => item.id === real.collaboration.rootWorkId)
  assert.equal(rootWork?.collaboration?.generation, real.collaboration.generation)
  assert.equal(rootWork?.collaboration?.status, real.collaboration.status)
  const manifest = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8'))
  const entries = []
  for (const entry of manifest.entries) { const path = join(backupPath, ...entry.path.split('/')), content = await readFile(path); assert.equal(content.length, entry.bytes); assert.equal(sha256(content), entry.sha256); assert.equal((await stat(path)).mode & 0o777, 0o600); entries.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256, mode: '0600' }) }
  const restoredAuth = join(scratch, 'restored-auth.json'), restoredPassword = randomBytes(24).toString('base64url'),restoredPeerPassword=randomBytes(24).toString('base64url'),restoredAdminPassword=randomBytes(24).toString('base64url');runtimeSecrets.push(restoredPassword,restoredPeerPassword,restoredAdminPassword)
  await initializeAuthFile(restoredAuth, { 'member-admin': restoredAdminPassword, 'member-owner': restoredPassword, 'member-peer': restoredPeerPassword }, { mode: 'create', allowedMemberIds: ['member-admin', 'member-owner', 'member-peer'] })
  const restoredStore = createFileStore(join(restorePath, 'state.json')), knowledge = createKnowledgeService({ store: restoredStore });let replayDispatchCount = 0
  const collaboration = { async run() { replayDispatchCount += 1 }, async cancel() {}, async close() {}, getKnowledgeService() { return knowledge } }
  const restoredService = createWorkService({ store: restoredStore, collaborationRunner: collaboration, connectionCatalog: restoredState.connections, runner: { async close() {} } })
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, auth = createAuthRuntime({ filePath: restoredAuth }), index = await readFile(join(root, 'web', 'index.html'), 'utf8')
  const restoredServer = createGenewayServer({ service: restoredService, knowledge, collaborationRunner: collaboration, store: restoredStore, auth, index, trustedOrigin: origin })
  await new Promise((resolveListen, reject) => { restoredServer.once('error', reject); restoredServer.listen(port, '127.0.0.1', resolveListen) })
  try {
    const login = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: restoredPassword }) }), loginBody = await login.json(), cookie = login.headers.get('set-cookie').split(';', 1)[0]
    assert.equal(login.status, 200); const readback = await fetch(`${origin}/api/works/${rootWork.id}`, { headers: { cookie } }); assert.equal(readback.status, 200)
    const peerLogin=await fetch(`${origin}/api/session`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({loginName:'peer',password:restoredPeerPassword})}),peerCookie=peerLogin.headers.get('set-cookie').split(';',1)[0];assert.equal(peerLogin.status,200);assert.equal((await fetch(`${origin}/api/works/${rootWork.id}`,{headers:{cookie:peerCookie}})).status,404)
    const ownerKnowledge=await fetch(`${origin}/api/knowledge`,{headers:{cookie}}),peerKnowledge=await fetch(`${origin}/api/knowledge`,{headers:{cookie:peerCookie}}),ownerMaterials=await ownerKnowledge.json(),peerMaterials=await peerKnowledge.json();assert.equal(ownerMaterials.some(item=>item.status==='deleted'),true);assert.equal(peerMaterials.some(item=>item.status==='deleted'),false)
    if (recordPath) { const startSeconds=(Date.now()-recordingStartedAt)/1000;await showRestoredReadback(origin, restoredPassword, rootWork.id);lastBrowserSteps.push({id:lastBrowserSteps.length+1,actor:'owner',action:'isolated-restore-readback',expected:'隔离恢复态普通UI回读且无自动派发',startSeconds:Number(startSeconds.toFixed(3)),endSeconds:Number(((Date.now()-recordingStartedAt)/1000).toFixed(3)),dataMode:'restored v5 state; external secrets excluded'}) }
    assert.equal(replayDispatchCount, 0)
    const connection = restoredState.connections.find(item => item.kind === 'gearjob-rest')
    await assert.rejects(() => readGearJobWorkOrder({ workOrderId, connection, secretRoot: join(scratch, 'missing-secrets') }), error => error?.code === 'SOURCE_NOT_CONFIGURED')
    return { entries: entries.length, entryManifest: entries, sessionRefs: backup.sessionRefs, restoredEntries: restored.entries, graphKeysVerified:graphKeys,rootWorkId: rootWork.id, generation: rootWork.collaboration.generation, status: rootWork.collaboration.status, replayDispatchCount, ownerReadback: true, peerRootStatus:404,peerTombstoneVisible:false,authRekey: true, tombstoneCount: restoredState.knowledgeMaterials.filter(item => item.status === 'deleted').length, missingCredentialNewRead: 'SOURCE_NOT_CONFIGURED', externalEffects: null }
  } finally { await new Promise(resolveClose => restoredServer.close(resolveClose)); await restoredService.close() }
}

async function showRestoredReadback(origin, password, rootWorkId) {
  const port = await freePort(), profile = join(scratch, 'restore-chrome'); await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 });await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false }, translate: { enabled: false } }), { mode: 0o600 })
  const chrome = spawn('/usr/bin/google-chrome', ['--no-sandbox','--test-type','--no-first-run','--new-window','--no-default-browser-check','--ozone-platform=x11','--disable-gpu','--disable-background-networking','--disable-component-update','--disable-infobars','--hide-crash-restore-bubble','--disable-save-password-bubble','--password-store=basic','--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints,ChromeWhatsNewUI,SidePanelPinning,SidePanelJourneys',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1','--window-size=1440,900','--window-position=0,0',origin], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' })
  let socket
  try {
    const target = await browserTarget(port, chrome, origin), ws = new WebSocket(target.webSocketDebuggerUrl);socket = ws;await new Promise((resolveOpen, reject) => { ws.addEventListener('open', resolveOpen, { once: true }); ws.addEventListener('error', reject, { once: true }) })
    let sequence=0;const pending=new Map();ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(!message.id)return;const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result)});const send=(method,params={})=>new Promise((resolveSend,reject)=>{const id=++sequence;pending.set(id,{resolve:resolveSend,reject});ws.send(JSON.stringify({id,method,params}))});const evaluate=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true})).result.value
    await send('Runtime.enable');for(let i=0;i<200;i+=1){if(await evaluate(`Boolean(document.querySelector('#login-name'))`))break;await pause(50)}
    await evaluate(`document.querySelector('#login-name').value='owner';document.querySelector('#login-password').value=${JSON.stringify(password)};document.querySelector('#login-form').requestSubmit()`);for(let i=0;i<400;i+=1){if(await evaluate(`state.session?.loginName==='owner'`))break;await pause(50)}
    await evaluate(`openWork(${JSON.stringify(rootWorkId)})`);for(let i=0;i<400;i+=1){if(await evaluate(`state.currentWork?.id===${JSON.stringify(rootWorkId)}`))break;await pause(50)}
    assert.equal(await evaluate(`state.currentWork?.id===${JSON.stringify(rootWorkId)}&&document.body.innerText.includes('工作详情')`),true);await pause(3000)
  } finally { socket?.close();await stop(chrome,'SIGTERM') }
}

async function browserTarget(port, chrome, origin) { for(let i=0;i<200;i+=1){if(chrome.exitCode!==null||chrome.signalCode!==null)throw new Error(`restored Chrome exited before CDP startup (${chrome.exitCode!==null?'exit':'signal'})`);try{const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),target=targets.find(item=>item.type==='page'&&item.url.startsWith(origin));if(target)return target}catch{}await pause(50)}throw new Error('restored Chrome CDP startup timed out') }
async function freePort() { const server=createNodeServer();await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen)});const port=server.address().port;await new Promise(resolveClose=>server.close(resolveClose));return port }

async function finishMedia() {
  await run('ffmpeg', ['-v', 'error', '-i', recordPath, '-f', 'null', '-'])
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate:format=duration', '-of', 'json', recordPath]))
  const stream = probe.streams[0], duration = Number(probe.format.duration)
  assert.deepEqual({ codec: stream.codec_name, pix: stream.pix_fmt, width: stream.width, height: stream.height, fps: stream.r_frame_rate }, { codec: 'h264', pix: 'yuv420p', width: 1440, height: 900, fps: '25/1' })
  await mkdir(framesDir, { recursive: true })
  const timestamps = [...new Set([0, ...Array.from({ length: Math.floor(duration) + 1 }, (_, index) => index), ...lastBrowserSteps.flatMap(step => [step.startSeconds, (step.startSeconds + step.endSeconds) / 2, step.endSeconds]), Math.max(0, duration - 0.04)].map(value => Number(Math.max(0, Math.min(duration - 0.001, value)).toFixed(3))))].sort((left, right) => left - right)
  const frames = []
  for (const [index, timestampSeconds] of timestamps.entries()) {
    const path = join(framesDir, `frame-${String(index + 1).padStart(4, '0')}.png`)
    await run('ffmpeg', ['-v', 'error', '-ss', String(timestampSeconds), '-i', recordPath, '-frames:v', '1', '-y', path])
    const content = await readFile(path)
    frames.push({ file: relative(artifactsDir, path), timestampSeconds, sha256: sha256(content), bytes: content.length, width: content.readUInt32BE(16), height: content.readUInt32BE(20), sources: [Number.isInteger(timestampSeconds) ? 'one-second' : 'event-boundary'] })
  }
  const cover = frames[Math.floor(frames.length / 2)]
  await copyFile(join(artifactsDir, cover.file), coverPath)
  let ocr = { status: 'cannot_verify', reason: 'tesseract unavailable' }
  if (await executable('tesseract')) {
    const texts = []
    for (const frame of frames) texts.push(await run('tesseract', [join(artifactsDir, frame.file), 'stdout', '-l', 'chi_sim+eng']).catch(() => ''))
    ocr = { status: 'checked', nonEmptyFrames: texts.filter(text => text.trim()).length }
  }
  const visualScans = lastBrowserExport?.browserResult?.visualScans ?? []
  return { video: { file: basename(recordPath), sha256: sha256(await readFile(recordPath)), bytes: (await stat(recordPath)).size, durationSeconds: duration, width: 1440, height: 900, codec: 'h264', pixelFormat: 'yuv420p', fps: 25, fullDecode: true }, cover: { file: basename(coverPath), sha256: sha256(await readFile(coverPath)) }, frames, frameManifest: { count: frames.length, oneSecondCoverage: true, firstAndLast: true, eventBoundaries: lastBrowserSteps.length, sha256: sha256(JSON.stringify(frames)) }, pixelOcr: ocr, alternateVisualDomScan: { status: visualScans.length ? 'passed' : 'failed', captures: visualScans.length, sha256: sha256(JSON.stringify(visualScans)), axNodes: visualScans.reduce((sum, item) => sum + item.axNodes, 0), secretHits: visualScans.reduce((sum, item) => sum + item.secretHits, 0) } }
}

async function writeManual(receipt) {
  const rows = receipt.journey.map(step => { const midpoint = (step.startSeconds + step.endSeconds) / 2, frame = receipt.artifacts.frames.reduce((best, item) => Math.abs(item.timestampSeconds - midpoint) < Math.abs(best.timestampSeconds - midpoint) ? item : best, receipt.artifacts.frames[0]); return `<section><h2>${step.id}. ${esc(step.action)}</h2><dl><dt>操作者</dt><dd>${esc(step.actor)}</dd><dt>预期</dt><dd>${esc(step.expected)}</dd><dt>实际时间段</dt><dd>${step.startSeconds}s–${step.endSeconds}s</dd><dt>数据边界</dt><dd>${esc(step.dataMode)}</dd></dl>${frame ? `<img src="${esc(frame.file)}" alt="步骤 ${step.id} 同次录屏验收画面"><p>抽帧时间：${frame.timestampSeconds}s；SHA-256：<code>${frame.sha256}</code></p>` : ''}</section>` }).join('')
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Geneway P3 验收手册</title><style>body{font:16px/1.6 system-ui;margin:auto;max-width:960px;padding:32px;color:#17352c}section{border:1px solid #c8d8d1;border-radius:12px;padding:20px;margin:20px 0}img{max-width:100%;border-radius:8px}dt{font-weight:700}dd{margin-bottom:8px}code{overflow-wrap:anywhere}</style><h1>Geneway P3 操作验收手册</h1><p>候选：<code>${candidate}</code></p><p>本手册与视频来自同一路普通 UI 验收：真实 GearJob REST 工单、真实 ZenMux DeepSeek root/A/B/recheck、同一 root/knowledge/Session，并延续到隔离恢复态回读。受控时序检查只作为附加门禁，不替代本旅程。</p><p>工单：<code>${esc(receipt.source.workOrderId)}</code>；数据模式：${esc(receipt.source.sourceEnvironment)} / ${esc(receipt.source.dataMode)} / 非生产验收。</p><p><a href="${basename(recordPath)}">打开同次验收视频</a></p><p>视频 SHA-256：<code>${receipt.artifacts.video.sha256}</code><br>Receipt：<a href="${basename(receiptPath)}">${basename(receiptPath)}</a><br>Receipt SHA-256：<code>${receipt.artifacts.receipt.sha256}</code><br>最终扫描证明：<a href="${esc(receipt.artifacts.finalScanAttestation.file)}" data-attestation-id="${esc(receipt.artifacts.finalScanAttestation.id)}">${esc(receipt.artifacts.finalScanAttestation.file)}</a></p>${rows}</html>`
  const manualPath=join(artifactsDir,'index.html');await writeFile(manualPath, html)
  return{file:'index.html',sha256:sha256(await readFile(manualPath)),bytes:(await stat(manualPath)).size,attestationFile:receipt.artifacts.finalScanAttestation.file,attestationId:receipt.artifacts.finalScanAttestation.id}
}

async function verifyOfflineBundle(receipt,manual,attestationPath){
  const copyRoot=await mkdtemp(join(tmpdir(),'geneway-p3-offline-'))
  try{const html=await readFile(join(artifactsDir,manual.file),'utf8'),links=[...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match=>match[1]);if(links.some(link=>/^[a-z]+:|^\/\//i.test(link))||/https?:\/\//i.test(html))throw new Error('offline manual contains a remote reference');const attestationFile=basename(attestationPath),bundleFiles=[...new Set([manual.file,basename(receiptPath),basename(recordPath),receipt.artifacts.cover.file,...receipt.artifacts.frames.map(frame=>frame.file),attestationFile])],copied=[];for(const file of bundleFiles){const source=resolve(artifactsDir,file);if(relative(artifactsDir,source).startsWith('..')||!(await pathExists(source)))throw new Error(`offline bundle file is unavailable: ${file}`);const target=join(copyRoot,file);await mkdir(dirname(target),{recursive:true});await copyFile(source,target);const [left,right]=await Promise.all([readFile(source),readFile(target)]);assert.equal(sha256(left),sha256(right));copied.push(file===attestationFile?{file,identityOnly:true,attestationId:manual.attestationId}:{file,sha256:sha256(right),bytes:right.length})}for(const link of links)assert.equal(await pathExists(join(copyRoot,link)),true);const copiedReceipt=JSON.parse(await readFile(join(copyRoot,basename(receiptPath)),'utf8')),copiedAttestation=JSON.parse(await readFile(join(copyRoot,attestationFile),'utf8'));assert.equal(copiedReceipt.artifacts.finalScanAttestation.file,attestationFile);assert.equal(copiedReceipt.artifacts.finalScanAttestation.id,copiedAttestation.id);assert.equal(copiedAttestation.id,manual.attestationId);assert.equal(copiedAttestation.candidate,candidate);assert.equal(copiedAttestation.receipt.sha256,sha256(await readFile(join(copyRoot,basename(receiptPath)))));assert.equal(copiedAttestation.manual.sha256,sha256(await readFile(join(copyRoot,manual.file))));const videoProbe=JSON.parse(await run('ffprobe',['-v','error','-show_entries','format=duration','-of','json',join(copyRoot,basename(recordPath))]));assert.ok(Number(videoProbe.format?.duration)>0);return{status:'passed',files:copied.length,parsedLocalLinks:links.length,completeFrameCount:receipt.artifacts.frames.length,networkReferences:0,videoDurationSeconds:Number(videoProbe.format.duration),bundleSha256:sha256(JSON.stringify(copied)),filesEvidence:copied}}finally{await rm(copyRoot,{recursive:true,force:true})}
}

async function scanSecrets(paths) {
  const settingsPath = process.env.GENEWAY_ZENMUX_SETTINGS_FILE ?? join(process.env.HOME ?? dirname(root), '.claude', 'settings.json')
  const needles = [randomBytes(32).toString('hex'), ...runtimeSecrets]
  for (const path of [gearJobCredential, settingsPath]) { try { needles.push(...strings(JSON.parse(await readFile(path, 'utf8')))) } catch {} }
  for (const [key, value] of Object.entries(process.env)) if (/(?:LARK|FEISHU).*(?:TOKEN|SECRET|KEY)|(?:TOKEN|SECRET|KEY).*(?:LARK|FEISHU)/i.test(key)) needles.push(value)
  for (const path of [join(process.env.HOME ?? '', '.config', 'lark-cli', 'config.json'), join(process.env.HOME ?? '', '.lark-cli', 'config.json')]) { try { needles.push(...strings(JSON.parse(await readFile(path, 'utf8')))) } catch {} }
  const unique = [...new Set(needles.filter(value => typeof value === 'string' && value.length >= 8))]
  const files = []
  for (const path of paths) await collectFiles(path, files)
  let matches = 0
  const perTarget=[]
  for (const path of files) { const content = await readFile(path);let needleMatches=0;for (const needle of unique) if (content.includes(Buffer.from(needle)))needleMatches+=1;matches+=needleMatches;perTarget.push({identity:sha256(path),file:path.startsWith(artifactsDir)?relative(artifactsDir,path):basename(path),bytes:content.length,sha256:sha256(content),needleMatches,canaryHits:Object.fromEntries(lastCanaries.map(item=>[item.label,content.includes(Buffer.from(item.value))?1:0]))}) }
  assert.equal(matches, 0, 'acceptance artifacts contain a known secret marker')
  const keyReview = await sensitiveKeyReview(files)
  return { files: files.length, knownNeedles: unique.length, matches, perTarget, sensitiveKeyPatterns: keyReview, canarySummary:Object.fromEntries(lastCanaries.map(item=>[item.label,{sha256:item.sha256,hits:perTarget.reduce((sum,target)=>sum+(target.canaryHits[item.label]??0),0)}])) }
}

function collectWorkSessionRefs(works) {
  const refs=new Set(),visit=(value,key='')=>{if((key==='dshSessionRef'||key==='continuedFromDshSessionRef')&&typeof value==='string'&&value.trim())refs.add(value);if(Array.isArray(value))for(const item of value)visit(item);else if(value&&typeof value==='object')for(const [childKey,child] of Object.entries(value))visit(child,childKey)};visit(works??[]);return[...refs].sort()
}

async function stageSessions(ids) {
  const sourceRoot = join(process.env.HOME ?? '/home/gewu', '.dsh', 'sessions'), sourceFiles = []
  await collectFiles(sourceRoot, sourceFiles)
  const evidence = []
  for (const id of [...new Set(ids)]) {
    const source = sourceFiles.find(path => basename(dirname(path)) === id && /session\.v\d+\.jsonl(?:\.(?:gz|zstd))?$/.test(basename(path)))
    if (!source) throw new Error(`associated DSH Session file is unavailable (${sha256(id)})`)
    const namespace = basename(dirname(dirname(source))), target = join(dshHome, 'sessions', namespace, id, basename(source))
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(source, target); await chmod(target, 0o600)
    const content = await readFile(target),text=target.endsWith('.zstd')?await run('zstd',['-dc',target]):target.endsWith('.gz')?await run('gzip',['-dc',target]):content.toString('utf8')
    const tools=[...new Set([...text.matchAll(/geneway_(?:gearjob_read_work_order|calculate_cycle_time|knowledge_search|knowledge_submit_references|collaboration_submit_summary)/g)].map(match=>match[0]))].sort()
    evidence.push({ sessionRef:id,sha256:sha256(content),bytes:content.length,requestEvents:(text.match(/agent\/request|"type":"request"/g)??[]).length,tools,structured:/"structured"\s*:|structured_output/.test(text),canaryHits:Object.fromEntries(lastCanaries.map(item=>[item.label,text.split(item.value).length-1])) })
  }
  return evidence
}

async function assertCandidate() {
  const status = (await git(['status', '--porcelain=v1'])).split('\n').filter(Boolean)
  const allowed = ['doc/plans/2026-09-18-geneway-dsh-greenfield/ui-sketches-workbuddy.check.mjs', 'doc/plans/2026-09-18-geneway-dsh-greenfield/ui-sketches-workbuddy.html', 'doc/plans/2026-09-18-geneway-dsh-greenfield/ui-sketches-workbuddy/', 'doc/plans/2026-09-18-geneway-dsh-greenfield/ui-sketches.html', 'doc/plans/2026-09-18-geneway-dsh-greenfield/ui-sketches/']
  const pathOf = line => line.replace(/^(?:\?\?|[ MADRCU?!]{1,2})\s+/, '')
  const formal = Boolean(recordPath)
  const unexpected = status.filter(line => (!formal && ["package.json", "scripts/accept-p3.mjs"].includes(pathOf(line))) ? false : !allowed.some(path => pathOf(line).startsWith(path)))
  if (unexpected.length) throw new Error(`candidate has unexpected worktree changes: ${unexpected.join(', ')}`)
  if (formal) {
    await git(['ls-files', '--error-unmatch', 'package.json', 'scripts/accept-p3.mjs'])
    const existingReceipt = recordPath.replace(/\.mp4$/i, '.receipt.json')
    if (await pathExists(existingReceipt)) {
      const existingHash = sha256(await readFile(existingReceipt))
      if (supersedes !== existingHash) throw new Error(`existing formal receipt requires --supersedes ${existingHash}`)
    } else if (supersedes) throw new Error('--supersedes was supplied but no existing receipt exists')
  }
}
function browserAcceptanceDiagnostic(acceptance={}) {
  const integer=value=>Number.isInteger(value)?value:null,bool=value=>typeof value==='boolean'?value:null,choice=(value,allowed)=>allowed.includes(value)?value:value==null?null:'unexpected'
  const actual={ownerPrivateStatus:integer(acceptance.ownerPrivateStatus),ownerPrivateUiResult:bool(acceptance.ownerPrivateUiResult),peerSharedStatus:integer(acceptance.peerSharedStatus),peerSharedUiResult:choice(acceptance.peerSharedUiResult,['visible']),unauthorizedEmployeeStatus:integer(acceptance.unauthorizedEmployeeStatus),unauthorizedEmployeeUiResult:choice(acceptance.unauthorizedEmployeeUiResult,['option-absent']),peerSearchStatus:integer(acceptance.peerSearchStatus),peerSearchCount:integer(acceptance.peerSearchCount),peerRootStatus:integer(acceptance.peerRootStatus),peerMaterialStatus:integer(acceptance.peerMaterialStatus),revokedUiResult:choice(acceptance.revokedUiResult,['redacted']),w1Status:choice(acceptance.w1Status,['cancelled']),w2Status:choice(acceptance.w2Status,['completed']),lateResultOverwrote:bool(acceptance.lateResultOverwrote)}
  return{actual,mismatches:Object.keys(browserAcceptanceExpected).filter(key=>actual[key]!==browserAcceptanceExpected[key])}
}
function assertBrowserAcceptanceFacts(acceptance) { const diagnostic=browserAcceptanceDiagnostic(acceptance);if(diagnostic.mismatches.length)throw new Error(`browser acceptance facts missing or contradictory: ${JSON.stringify(diagnostic)}`) }
function browserAcceptanceDiagnosticSmoke() {
  const marker='DO_NOT_ECHO_BROWSER_SECRET',diagnostic=browserAcceptanceDiagnostic({...browserAcceptanceExpected,peerSharedUiResult:marker,w1Id:marker,cookie:marker,csrf:marker,credential:marker,body:marker,rawExport:marker})
  assert.deepEqual(Object.keys(diagnostic.actual),Object.keys(browserAcceptanceExpected));assert.deepEqual(diagnostic.mismatches,['peerSharedUiResult']);const encoded=JSON.stringify(diagnostic);assert.equal(encoded.includes(marker),false);for(const forbidden of ['w1Id','cookie','csrf','credential','body','rawExport'])assert.equal(encoded.includes(forbidden),false)
}
function browserDiagnosticsDiagnostic(measured={}) {
  const bool=value=>typeof value==='boolean'?value:null,count=value=>Array.isArray(value)?value.length:null,integer=value=>Number.isInteger(value)?value:null
  const actual={desktopOverflow:bool(measured.desktopOverflow),mobileOverflow:bool(measured.mobileOverflow),consoleErrorsCount:count(measured.consoleErrors),failedRequestsCount:count(measured.failedRequests),unexpectedResponsesCount:count(measured.unexpectedResponses),networkHeaderSecretHits:integer(measured.networkHeaderSecretHits),visualScansCount:count(measured.visualScans)}
  const mismatches=[];if(actual.desktopOverflow!==false)mismatches.push('desktopOverflow');if(actual.mobileOverflow!==false)mismatches.push('mobileOverflow');if(actual.consoleErrorsCount!==0)mismatches.push('consoleErrorsCount');if(actual.failedRequestsCount!==0)mismatches.push('failedRequestsCount');if(actual.unexpectedResponsesCount!==0)mismatches.push('unexpectedResponsesCount');if(!(actual.networkHeaderSecretHits>=1))mismatches.push('networkHeaderSecretHits');if(!(actual.visualScansCount>=1))mismatches.push('visualScansCount');return{actual,mismatches}
}
function assertBrowserDiagnostics(measured) { const diagnostic=browserDiagnosticsDiagnostic(measured);if(diagnostic.mismatches.length)throw new Error(`browser diagnostics missing or contradictory: ${JSON.stringify(diagnostic)}`) }
function browserDiagnosticsDiagnosticSmoke() {
  const marker='DO_NOT_ECHO_BROWSER_DIAGNOSTIC_SECRET',diagnostic=browserDiagnosticsDiagnostic({desktopOverflow:false,mobileOverflow:false,consoleErrors:[marker],failedRequests:[{url:marker}],unexpectedResponses:[{body:marker}],networkHeaderSecretHits:0,visualScans:[{raw:marker}],cookie:marker,csrf:marker,rawExport:marker})
  assert.deepEqual(Object.keys(diagnostic.actual),['desktopOverflow','mobileOverflow','consoleErrorsCount','failedRequestsCount','unexpectedResponsesCount','networkHeaderSecretHits','visualScansCount']);assert.deepEqual(diagnostic.mismatches,['consoleErrorsCount','failedRequestsCount','unexpectedResponsesCount','networkHeaderSecretHits']);const encoded=JSON.stringify(diagnostic);assert.equal(encoded.includes(marker),false);for(const forbidden of ['url','body','raw','cookie','csrf','rawExport'])assert.equal(encoded.includes(forbidden),false)
}
function assertRealGearEvidence(gear,expectedWorkOrderId) {
  const diagnostic={evidenceModeMatches:gear?.payload?.evidenceMode==='real-frappe-rest',workOrderIdMatches:gear?.payload?.workOrderId===expectedWorkOrderId};if(!diagnostic.evidenceModeMatches||!diagnostic.workOrderIdMatches)throw new Error(`formal browser GearJob evidence is not real REST data: ${JSON.stringify(diagnostic)}`)
}
function gearEvidenceGateSmoke() {
  const gear={evidenceMode:'incorrect-top-level',payload:{workOrderId:'WO-SMOKE',evidenceMode:'real-frappe-rest'}};assert.doesNotThrow(()=>assertRealGearEvidence(gear,'WO-SMOKE'));assert.throws(()=>assertRealGearEvidence({payload:{workOrderId:'WO-SMOKE'}},'WO-SMOKE'),/"evidenceModeMatches":false,"workOrderIdMatches":true/)
}
function workSessionRefSmoke() {
  const selected={id:'selected',executions:[{dshSessionRef:'selected-ref'}],results:[]},unrelated={id:'unrelated',executions:[{dshSessionRef:'unrelated-ref'}],results:[{payload:{continuedFromDshSessionRef:'continued-ref'}}]},staged=collectWorkSessionRefs([selected,unrelated]),selectedMappings=selected.executions.filter(item=>item.dshSessionRef).map(item=>item.dshSessionRef);assert.deepEqual(staged,['continued-ref','selected-ref','unrelated-ref']);assert.deepEqual(selectedMappings,['selected-ref']);assert.equal(selectedMappings.includes('unrelated-ref')||selectedMappings.includes('continued-ref'),false)
}
function createJourneyProgress({videoPath,clock=Date.now,readVideoBytes=async path=>(await stat(path)).size,eventStaleMs=600_000,videoStaleMs=120_000,report=message=>console.error(message)}) {
  let eventProgressAt=clock(),videoProgressAt=clock(),videoBytes=0,lastVideoReportAt=0,progressBuffer=''
  return {
    onStdout(chunk){let parsed=0;progressBuffer=(progressBuffer+chunk).slice(-24000);for(const match of progressBuffer.matchAll(/P3_ACCEPT_EVENT:([a-z0-9-]+):(admin|owner|peer):(started|passed):(\d+)/g)){const timestamp=Number(match[4]);if(!Number.isFinite(timestamp)||timestamp<=eventProgressAt)continue;eventProgressAt=timestamp;parsed+=1;report(`[accept:p3] event ${match[1]} ${match[2]} ${match[3]}`)}return parsed},
    async watchdog(){const now=clock();if(videoPath){const bytes=await readVideoBytes(videoPath);if(bytes>videoBytes){videoBytes=bytes;videoProgressAt=now;if(now-lastVideoReportAt>=60_000){lastVideoReportAt=now;report(`[accept:p3] video ${bytes} bytes`)}}if(now-videoProgressAt>videoStaleMs)return `formal video made no progress for ${videoStaleMs/1000} seconds`}if(now-eventProgressAt>eventStaleMs)return `formal UI emitted no acceptance event for ${eventStaleMs/1000} seconds`}
  }
}
function createExternalTempRegistrar(target) {
  let output=''
  return chunk=>{output=(output+chunk).slice(-4096);for(const match of output.matchAll(/P3_ACCEPT_TEMP:([^\r\n]+)/g)){const path=resolve(match[1]);if(dirname(path)!==resolve(tmpdir())||!basename(path).startsWith('geneway-p3-http-ui-'))throw new Error('generated UI reported an invalid temporary path');if(!target.includes(path))target.push(path)}}
}
async function waitForStableNetworkIdle({activeRequests,lastActivity,timeoutMs=30_000,stableMs=750,pollMs=25,clock=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  const deadline=clock()+timeoutMs
  while(clock()<deadline){const idleSince=lastActivity();if(activeRequests.size===0&&clock()-idleSince>=stableMs){await sleep(pollMs);if(activeRequests.size===0&&lastActivity()===idleSince)return}else await sleep(pollMs)}
  throw new Error('pre-logout network drain timed out')
}
async function networkIdleDrainSmoke() {
  let now=0,lastActivityAt=0;const activeRequests=new Set(),sleep=async ms=>{now+=ms;if(now===30){activeRequests.add('sequential');lastActivityAt=now}if(now===40){activeRequests.delete('sequential');lastActivityAt=now}}
  await waitForStableNetworkIdle({activeRequests,lastActivity:()=>lastActivityAt,timeoutMs:100,stableMs:20,pollMs:10,clock:()=>now,sleep});assert.equal(now,70)
  now=0;lastActivityAt=0;activeRequests.add('stuck');await assert.rejects(waitForStableNetworkIdle({activeRequests,lastActivity:()=>lastActivityAt,timeoutMs:30,stableMs:20,pollMs:10,clock:()=>now,sleep:async ms=>{now+=ms}}),/pre-logout network drain timed out/)
  now=0;lastActivityAt=0;activeRequests.clear();await waitForStableNetworkIdle({activeRequests,lastActivity:()=>lastActivityAt,timeoutMs:40,stableMs:20,pollMs:10,clock:()=>now,sleep:async ms=>{now+=ms}});assert.equal(now,30)
}
async function watchdogSmoke() {
  let now=1_000,bytes=1
  const progress=createJourneyProgress({videoPath:'smoke.mp4',clock:()=>now,readVideoBytes:async()=>bytes,eventStaleMs:100,videoStaleMs:50,report:()=>{}})
  assert.equal(progress.onStdout('P3_ACCEPT_EVENT:smoke:owner:passed:1001\n'),1)
  assert.equal(progress.onStdout(`P3_ACCEPT_EVENT:smoke:owner:passed:${'9'.repeat(400)}\n`),0)
  now=1_102;bytes=2
  assert.match(await progress.watchdog(),/no acceptance event/)
  const registered=[]
  createExternalTempRegistrar(registered)(`P3_ACCEPT_TEMP:${join(tmpdir(),'geneway-p3-http-ui-smoke')}\n`)
  assert.deepEqual(registered,[resolve(tmpdir(),'geneway-p3-http-ui-smoke')])
  let pids,pidOutput=''
  const leader=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")}],{stdio:'ignore'});console.log(process.pid+':'+child.pid);setInterval(()=>{},1000)`
  await assert.rejects(run(process.execPath,['-e',leader],{killGroup:true,watchdogIntervalMs:50,onStdout:chunk=>{pidOutput+=chunk;const match=pidOutput.match(/(\d+):(\d+)/);if(match)pids=match.slice(1).map(Number)},watchdog:async()=>pids?'harness watchdog descendant smoke':undefined}),/harness watchdog descendant smoke/)
  assert.ok(pids?.length===2)
  for(const pid of pids)assert.equal(processAlive(pid),false,`watchdog left process ${pid}`)
}
async function gate(label, command, args, options = {}) { console.error(`[accept:p3] start ${label}`);const startedAt=new Date().toISOString(),started=performance.now(),output=await run(command,args,options),endedAt=new Date().toISOString();commands.push({command:label,argv:[command,...args].map(value=>/(?:password|token|secret|key)=/i.test(value)?'[redacted]':value),startedAt,endedAt,durationMs:Math.round(performance.now()-started),exitCode:0,result:'pass',logSha256:sha256(output)});console.error(`[accept:p3] pass ${label}`);return output }
async function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child=spawn(command,args,{cwd:root,env:options.env??process.env,stdio:['ignore','pipe','pipe'],detached:Boolean(options.killGroup)})
    let out='',err='',failure,watchBusy=false,exited=false
    const monitors=[]
    const clearMonitors=()=>{for(const timer of monitors){clearTimeout(timer);clearInterval(timer)}}
    const terminate=signal=>{try{options.killGroup?process.kill(-child.pid,signal):child.kill(signal)}catch{}}
    const groupAlive=()=>options.killGroup&&processAlive(-child.pid)
    const waitUntil=async predicate=>{const until=Date.now()+5_000;while(predicate()&&Date.now()<until)await pause(25);return !predicate()}
    const fail=async message=>{if(failure)return;failure=new Error(message);clearMonitors();terminate('SIGTERM');const stopped=options.killGroup?await waitUntil(groupAlive):await waitUntil(()=>!exited);if(!stopped){terminate('SIGKILL');const killed=options.killGroup?await waitUntil(groupAlive):await waitUntil(()=>!exited);if(!killed)failure=new Error(`${message}; process cleanup did not complete`)}reject(failure)}
    child.stdout.on('data',chunk=>{out+=chunk;try{options.onStdout?.(chunk.toString())}catch(error){void fail(`child output validation failed: ${error.message}`)}if(options.stream)process.stdout.write(chunk)})
    child.stderr.on('data',chunk=>{err=(err+chunk).slice(-12000);if(options.stream)process.stderr.write(chunk)})
    child.once('exit',code=>{exited=true;if(failure)return;clearMonitors();code===0?resolveRun(out.trim()):reject(new Error(`${command} exited ${code}: ${err}`))})
    if(formalDeadlineAt){const remaining=formalDeadlineAt-Date.now();if(remaining<=0)void fail('formal acceptance exceeded 45 minute total limit');else monitors.push(setTimeout(()=>void fail('formal acceptance exceeded 45 minute total limit'),remaining))}
    if(options.watchdog)monitors.push(setInterval(async()=>{if(watchBusy||failure)return;watchBusy=true;try{const message=await options.watchdog();if(message)void fail(message)}catch(error){void fail(`formal watchdog failed: ${error.message}`)}finally{watchBusy=false}},options.watchdogIntervalMs??10_000))
  })
}
async function git(args) { return run('git', args) }
async function stop(child, signal) { if (!child || child.exitCode !== null) return; child.kill(signal); await Promise.race([new Promise(resolveStop => child.once('exit', resolveStop)), pause(5000)]); if (child.exitCode === null) child.kill('SIGKILL') }
async function executable(name) { try { await run('sh', ['-c', `command -v ${name}`]); return true } catch { return false } }
async function pathExists(path) { try { await stat(path); return true } catch { return false } }
async function collectFiles(path, target) { try { const value = await stat(path); if (value.isFile()) target.push(path); else if (value.isDirectory()) for (const name of await readdir(path)) await collectFiles(join(path, name), target) } catch {} }
async function sensitiveKeyReview(files) {
  const pattern = /"([^"\n]*(?:password|cookie|csrf|authorization|api[_-]?key|secret|token|credential|grant)[^"\n]*)"\s*:/gi
  const allow = new Set(['authRef','credentialRef','authorizationBasis','secretScan','knownNeedles','networkHeaderSecretHits','secretHits'])
  const seen = new Map()
  for (const path of files.filter(path => /\.(?:json|jsonl|html|txt|log)$/i.test(path))) { const text = await readFile(path, 'utf8').catch(() => ''); for (const match of text.matchAll(pattern)) { const key=match[1],value=seen.get(key)??{count:0,files:new Set()};value.count+=1;value.files.add(relative(root,path));seen.set(key,value) } }
  const unknown=[...seen.keys()].filter(key=>!allow.has(key));if(unknown.length)throw new Error(`unreviewed sensitive key names: ${unknown.join(', ')}`)
  return { reviewed: [...seen.values()].reduce((sum,item)=>sum+item.count,0), allowlist: [...allow].filter(key=>seen.has(key)), keys: Object.fromEntries([...seen].map(([key,value])=>[key,{count:value.count,files:[...value.files]}])), unknown: [] }
}
function strings(value) { if (typeof value === 'string') return [value]; if (Array.isArray(value)) return value.flatMap(strings); return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [] }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function esc(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
function processAlive(pid) { try { process.kill(pid,0);return true } catch(error) { return error.code!=='ESRCH' } }
function pause(ms) { return new Promise(resolvePause => setTimeout(resolvePause, ms)) }
