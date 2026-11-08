import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { generateCollaborationSpreadsheet } from '../src/spreadsheet-collaboration-generation.mjs'
import { verifyCollaborationSpreadsheet } from '../src/spreadsheet-collaboration-verification.mjs'
import { validateEvidenceBytes } from '../packages/agent-contracts/evidence.mjs'
import { analysisResult } from '../packages/agent-contracts/delegation.mjs'
import { canonical, digest } from '../packages/agent-contracts/index.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-unicode-'), before = process.argv.includes('--expect-before'), source = '/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-collaboration-HtB6qH/desktop-office/host.json', local = JSON.parse(await readFile(source)), input = structuredClone(local.jobs[0].input)
const site = input.sources.find(row => row.payload.format === 'geneway.site-snapshot'), event = { sourceEventId: 'event-1', sourceTimestamp: null, code: 'C', severity: 'info', message: '' }, prefix = JSON.stringify(event).indexOf('"message":"') + '"message":"'.length
// This is a formatter-only copy: no new cloud Evidence, Receipt, Job or provenance fact is admitted.
event.message = 'x'.repeat(999-prefix) + '😀tail'; site.payload.events = [event, ...Array.from({length:19},(_,index)=>({sourceEventId:'id-'+index+'-'.repeat(90)+'😀',sourceTimestamp:null,code:'C',severity:'info',message:'模拟事件'}))]
validateEvidenceBytes(Buffer.from(JSON.stringify(site.payload)), 'site_snapshot')
for(let count=0;count<20;count++){const ids=['event-1',...Array.from({length:count},(_,index)=>'x'.repeat(100)+index),''];input.analysis.findings[1].basis[0].sourceEventIds=ids;const text=JSON.stringify(input.analysis.findings[1].basis),start=text.lastIndexOf('""')+1,pad=(999-start%1000+1000)%1000;if(pad<=125){ids[ids.length-1]='z'.repeat(pad)+'😀';site.payload.events=[event,...ids.slice(1).map(id=>({sourceEventId:id,sourceTimestamp:null,code:'C',severity:'info',message:'模拟事件'}))];break}}
validateEvidenceBytes(Buffer.from(JSON.stringify(site.payload)),'site_snapshot');analysisResult(input.analysis)
const manifestTextBefore = JSON.stringify(canonical(input.sourceManifest)), marker='"node_id":"', at=manifestTextBefore.indexOf(marker,manifestTextBefore.indexOf('\"outputBinding\":'))+marker.length, padding=(999-at%1000+1000)%1000
input.sourceManifest.outputBinding.node_id='n'.repeat(padding)+'😀tail'; input.sourceManifestDigest=digest(input.sourceManifest)
const bytes=await generateCollaborationSpreadsheet(input),book=new ExcelJS.Workbook();await book.xlsx.load(bytes)
const actualSite=book.worksheets[1].getRows(2,book.worksheets[1].rowCount-1).filter(row=>row.getCell(2).value==='event:event-1').map(row=>row.getCell(3).value).join(''), actualBasis=book.worksheets[2].getRows(2,book.worksheets[2].rowCount-1).map(row=>row.getCell(4).value??'').join(''),actualManifest=book.worksheets[3].getColumn(2).values.slice(2).join('')
const expectedSite=JSON.stringify(event),expectedBasis=input.analysis.findings.map(row=>JSON.stringify(row.basis)).join(''),expectedManifest=JSON.stringify(canonical(input.sourceManifest)), checks={siteExact:actualSite===expectedSite,basisExact:actualBasis===expectedBasis,manifestExact:actualManifest===expectedManifest,noReplacementCharacters:![actualSite,actualBasis,actualManifest].some(row=>row.includes('\ufffd'))}
await writeFile(join(directory,'roundtrip-checks.json'),JSON.stringify(checks,null,2));
if(before){assert.equal(checks.siteExact,false);assert.equal(checks.noReplacementCharacters,false);await assert.rejects(verifyCollaborationSpreadsheet(bytes,input),{code:'SPREADSHEET_VERIFICATION_FAILED'})}
else{assert.deepEqual(checks,{siteExact:true,basisExact:true,manifestExact:true,noReplacementCharacters:true});await verifyCollaborationSpreadsheet(bytes,input)}
await writeFile(join(directory,'workbook.xlsx'),bytes);await writeFile(join(directory,'oracle.json'),JSON.stringify({expectedSite,actualSite,expectedBasis,actualBasis,expectedManifest,actualManifest},null,2));const result={result:before?'reproduced':'passed',directory,boundary:'actual ExcelJS generator/write/load/verifier formatter component on a copy of real prepared input; legal site and analysis DTO validation; no cloud provenance or business completion claim',before,checks};await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
