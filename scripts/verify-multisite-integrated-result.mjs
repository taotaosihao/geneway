import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { binding, digest } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'

assert.ok(process.argv[2], '用法: node scripts/verify-multisite-integrated-result.mjs <runroot>')
const directory = resolve(process.argv[2])
const sourceOnly = process.argv.includes('--source-only')
const resultFile = sourceOnly ? 'source-oracle.json' : 'author-oracle.json'
const json = async name => JSON.parse(await readFile(join(directory, name), 'utf8'))
const lines = async name => (await readFile(join(directory, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const hash = value => createHash('sha256').update(value).digest('hex')
const flatten = value => typeof value === 'string' ? value : (value ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
const refText = ref => `${ref.id ?? ref.attachmentId}@${ref.version}:${ref.sha256}`
let stage = '归档输入'
try {
  const old = await json('completed-state.json')
  const declared = await json('oracle.json'), d4 = await json('d4-capture.json'), all = await json('capture.json'), sessions = await json('sessions.json')
  assert.deepEqual(d4.errors, []); assert.deepEqual(all.errors, [])
  assert.equal(declared.history.length, 20); assert.equal(declared.site.events.length, 20)
  const artifacts = old.artifacts.filter(row => row.status === 'ready')
  assert.equal(artifacts.length, 1)
  const artifact = artifacts[0], work = old.works.find(row => row.id === artifact.workId), job = old.multisite.jobs.find(row => row.id === artifact.jobId)
  assert.ok(work && job); assert.equal(work.status, 'completed'); assert.equal(work.instructionRevision, 3)
  assert.equal(job.instructionRevision, 3); assert.ok(['completed', 'ready', 'candidate'].includes(job.state))
  const sourceAttempts = old.multisite.attempts.filter(row => row.work_id === work.id)
  assert.equal(sourceAttempts.length, 5); assert.equal(new Set(sourceAttempts.map(row => row.agent_id)).size, 5)
  const root = sourceAttempts.find(row => row.parent_delegation_id === null), office = sourceAttempts.find(row => row.agent_id === 'desktop-office')
  assert.ok(root && office)
  const inputs = old.multisite.inputs.filter(row => row.workId === work.id)
  assert.deepEqual(inputs.map(row => row.revision).sort(), [1, 2, 3])

  stage = '独立Excel/三份XLSX字节'
  const download = await readFile(join(directory, '下载多来源整改表.xlsx'))
  const cloud = await readFile(join(directory, 'api/artifacts', artifact.id))
  const worker = await readFile(join(directory, 'pc-b/spreadsheet-jobs', job.id, 'incident-register.xlsx'))
  for (const bytes of [download, cloud, worker]) { assert.equal(hash(bytes), artifact.sha256); assert.equal(bytes.length, artifact.sizeBytes) }
  const book = new ExcelJS.Workbook(); await book.xlsx.load(download)
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['整改明细', '现场快照', '分析结论', '来源依据'])
  const [historySheet, siteSheet, analysisSheet, manifestSheet] = book.worksheets
  const historySource = job.sourceManifest.sources.find(row => row.kind === 'history')
  const siteSource = job.sourceManifest.sources.find(row => row.kind === 'site_snapshot')
  assert.ok(historySource && siteSource)

  stage = '原来源/Host密封capture/云Evidence'
  const sourceHistoryBytes = await readFile(join(directory, 'pc-a/source/source.json'))
  const sourceSiteBytes = await readFile(join(directory, 'gateway/source/source.json'))
  assert.deepEqual(JSON.parse(sourceHistoryBytes).entries, declared.history)
  assert.deepEqual(JSON.parse(sourceSiteBytes).events, declared.site.events)
  const sealed = new Map()
  for (const [nodeId, source, rawBytes] of [['pc-a', historySource, sourceHistoryBytes], ['gateway', siteSource, sourceSiteBytes]]) {
    const journal = await json(`${nodeId}/host-journal.json`)
    const capture = journal.captures.find(row => row.evidenceRef?.id === source.ref.id)
    const evidence = old.evidence.find(row => row.id === source.ref.id)
    assert.ok(capture && evidence)
    assert.equal(capture.state, 'published'); assert.equal(capture.sourceSha256, hash(rawBytes))
    assert.deepEqual(capture.evidenceRef, source.ref)
    assert.deepEqual(capture.producerBinding, evidence.producerBinding)
    const localBytes = await readFile(join(directory, nodeId, 'evidence-captures', `evidence-${capture.id}`))
    const serverBytes = await readFile(join(directory, 'api/evidence', evidence.id))
    assert.equal(hash(localBytes), capture.snapshotSha256); assert.equal(hash(serverBytes), evidence.sha256)
    assert.equal(hash(localBytes), evidence.sha256); assert.equal(evidence.sha256, source.ref.sha256)
    assert.equal(localBytes.length, capture.sizeBytes); assert.equal(serverBytes.length, evidence.sizeBytes)
    assert.deepEqual(localBytes, serverBytes)
    const payload = JSON.parse(serverBytes)
    assert.ok(!Object.hasOwn(payload, 'privateMarker'))
    sealed.set(evidence.id, payload)
  }
  const sealedHistory = sealed.get(historySource.ref.id), sealedSite = sealed.get(siteSource.ref.id)
  assert.deepEqual(sealedHistory.entries, declared.history)
  assert.deepEqual(sealedSite.events, declared.site.events); assert.deepEqual(sealedSite.health, declared.site.health)
  for (let index = 0; index < 20; index++) {
    const entry = sealedHistory.entries[index], occurrences = sealedHistory.entries.filter(row => row.description === entry.description).length
    assert.deepEqual(Array.from({ length: 9 }, (_, column) => historySheet.getCell(index + 2, column + 1).value),
      [index + 1, entry.date, entry.description, entry.owner, '2026-11-25', occurrences, refText(historySource.ref), index, job.sourceManifest.photoRefs.map(refText).join('\n')])
  }
  assert.equal(historySheet.rowCount, 22)
  assert.deepEqual(Array.from({ length: 6 }, (_, column) => historySheet.getCell(22, column + 1).value), ['记录数', 20, '责任人数', 2, '异常种类', 19])
  const siteFields = new Map()
  for (let index = 2; index <= siteSheet.rowCount; index++) {
    assert.equal(siteSheet.getCell(index, 1).value, refText(siteSource.ref))
    const key = siteSheet.getCell(index, 2).value
    siteFields.set(key, (siteFields.get(key) ?? '') + siteSheet.getCell(index, 3).value)
  }
  for (const [field, value] of [['quality', 'unknown'], ['sourceTimestamp', 'unknown'], ['clockTrust', 'fixture'], ['dataMode', 'fixture']]) assert.equal(siteFields.get(field), value)
  assert.equal(siteFields.get('observedAt'), old.evidence.find(row => row.id === siteSource.ref.id).observedAt)
  assert.deepEqual(JSON.parse(siteFields.get('health')), sealedSite.health)
  assert.deepEqual(JSON.parse(siteFields.get('sections')), ['collector_health', 'recent_events'])
  assert.deepEqual([...siteFields].filter(([key]) => key.startsWith('event:')).map(([, value]) => JSON.parse(value)), sealedSite.events)
  assert.equal(siteSheet.rowCount, 28)

  stage = '原分析/actualmanifest'
  const expectedAnalysis = { summary: '原历史含重复护罩记录；模拟现场时钟未知，不判断当前健康', evidenceRefs: [historySource.ref, siteSource.ref], findings: [
    { category: 'history_match', certainty: 'supported', statement: '历史第0项和第2项均为护罩松动', basis: [{ evidenceRef: historySource.ref, entryIndexes: [0, 2] }] },
    { category: 'insufficient_evidence', certainty: 'unknown', statement: '模拟现场时钟未知，不能据此判断当前正常', basis: [{ evidenceRef: siteSource.ref, sourceEventIds: ['fixture-event-0'] }] },
  ], limitations: ['仅本地模拟来源', '未知时钟保持未知，不证明现场实际健康'] }
  const analysisResult = old.multisite.results.find(row => row.id === job.sourceManifest.analysis.resultId)
  assert.deepEqual(analysisResult.payload, expectedAnalysis)
  assert.equal(analysisSheet.getCell(2, 3).value, expectedAnalysis.summary)
  for (const [index, finding] of expectedAnalysis.findings.entries()) {
    assert.equal(analysisSheet.getCell(index + 3, 1).value, finding.category)
    assert.equal(analysisSheet.getCell(index + 3, 2).value, finding.certainty)
    assert.equal(analysisSheet.getCell(index + 3, 3).value, finding.statement)
    assert.deepEqual(JSON.parse(analysisSheet.getCell(index + 3, 4).value), finding.basis)
  }
  assert.deepEqual([analysisSheet.getCell(5, 5).value, analysisSheet.getCell(6, 5).value], expectedAnalysis.limitations)
  const manifest = JSON.parse(Array.from({ length: manifestSheet.rowCount - 1 }, (_, index) => {
    assert.equal(manifestSheet.getCell(index + 2, 1).value, index)
    return manifestSheet.getCell(index + 2, 2).value
  }).join(''))
  assert.deepEqual(manifest, job.sourceManifest); assert.equal(digest(manifest), artifact.manifestDigest)
  assert.equal(manifest.instructionRevision, 3); assert.equal(manifest.dueDate, '2026-11-25')
  assert.deepEqual(manifest.outputBinding, binding(office))
  assert.equal(manifest.analysis.payloadDigest, digest(expectedAnalysis)); assert.equal(manifest.analysis.producerRevision, 1)
  assert.ok(manifest.sources.every(row => row.producerRevision === 1))
  assert.equal(manifest.version, 2); assert.equal(job.inputEncodingVersion, 2)
  assert.equal(Object.hasOwn(manifest, 'rows'), false); assert.equal(Object.hasOwn(job, 'rows'), false)
  assert.deepEqual(manifest.rowMap, sealedHistory.entries.map((_, entryIndex) => ({ sourceIndex: manifest.sources.findIndex(row => row.kind === 'history'), entryIndex, photoIndices: manifest.photoRefs.map((_, index) => index) })))
  assert.ok(manifest.currentReceiptIds.every(id => old.evidenceAccessReceipts.some(row => row.id === id && row.receiverInstructionRevision === 3)))
  assert.ok(manifest.adoptionIds.every(id => old.sourceAdoptions.some(row => row.id === id && row.instructionRevision === 3)))

  stage = '旧五Session/原Input唯一摄入/旧账本'
  const files = await readdir(directory), frameFiles = files.filter(name => /-session-.*-allframes\.jsonl$/.test(name))
  assert.ok(frameFiles.length >= (sourceOnly ? 5 : 6), sourceOnly ? '必须有源五Session原始allframes' : '必须有旧五Session和新Root的原始allframes')
  const rawSessions = await Promise.all(frameFiles.map(async name => ({ name, frames: await lines(name) })))
  for (const attempt of sourceAttempts) {
    const events = sessions[attempt.agent_id]
    assert.ok(Array.isArray(events))
    assert.ok(events.some(row => row.type === 'session' && row.id === attempt.session_id))
    const raw = rawSessions.filter(row => row.frames.some(frame => frame.type === 'session' && frame.id === attempt.session_id))
    assert.equal(raw.length, 1)
    assert.deepEqual(raw[0].frames, events)
  }
  for (const input of inputs) for (const delivery of input.deliveries.filter(row => row.ingestedAt)) {
    const attempt = sourceAttempts.find(row => row.attempt_id === delivery.attemptId)
    assert.ok(attempt)
    const expectedId = messageId(input.id, attempt.attempt_id, attempt.session_id)
    assert.equal(sessions[attempt.agent_id].filter(frame => frame.type === 'user/message' && frame.data.id === expectedId).length, 1)
  }
  const sourceLedger = old.modelRequests.filter(row => row.work_id === work.id)
  assert.ok(sourceLedger.length)
  assert.ok(sourceLedger.every(row => row.outcome === 'completed'))
  assert.ok(d4.captures.every(row => row.workId === work.id))
  assert.deepEqual(d4.captures.map(row => digest(row.body)).sort(), sourceLedger.map(row => row.bodyDigest).sort())

  stage = 'C四表逐cell实际工具页进入provider'
  const candidatePages = new Map()
  for (const request of d4.captures.filter(row => row.agent === 'coordinator')) for (const message of request.body.messages.filter(row => row.role === 'tool')) {
    let value; try { value = JSON.parse(flatten(message.content)) } catch { continue }
    const page = value.result ?? value
    if (page.schema === 'geneway.spreadsheet-candidate-page/1') candidatePages.set(page.readReceiptId, page)
  }
  const candidateReads = old.spreadsheetReads.filter(row => row.work_id === work.id)
  assert.equal(candidatePages.size, candidateReads.length)
  for (const read of candidateReads) {
    assert.equal(digest(candidatePages.get(read.id)), read.pageDigest)
    assert.deepEqual(binding(read), binding(root)); assert.equal(read.instructionRevision, 3)
  }
  for (const [index, section] of ['history', 'site', 'analysis', 'manifest'].entries()) {
    const sheet = book.worksheets[index], expected = []
    for (let row = 1; row <= sheet.rowCount; row++) for (let column = 1; column <= sheet.columnCount; column++) {
      const value = sheet.getCell(row, column).value ?? '', points = typeof value === 'string' ? Array.from(value) : null
      const parts = points ? Math.max(1, Math.ceil(points.length / 1000)) : 1
      for (let part = 0; part < parts; part++) expected.push({ row, column, part, parts, value: points ? points.slice(part * 1000, (part + 1) * 1000).join('') : value })
    }
    const actual = [...candidatePages.values()].filter(page => page.section === section).sort((a, b) => a.startIndex - b.startIndex).flatMap(page => page.cells)
    assert.deepEqual(actual, expected)
  }

  stage = '源问题/真实busy typed修订与监督阶段'
  const questionState = await json('question-state.json'), busyBefore = await json('busy-before.json'), busyAfter = await json('busy-after-revision3-before-release.json')
  const questionWork = questionState.works.find(row => row.id === work.id)
  assert.ok(questionWork.pendingQuestion?.id)
  const answeredQuestion = old.userQuestions.find(row => row.id === questionWork.pendingQuestion.id)
  assert.ok(answeredQuestion); assert.equal(answeredQuestion.state, 'answered')
  assert.equal(answeredQuestion.answeredByInputId, inputs.find(row => row.revision === 2).id)
  assert.equal(inputs.find(row => row.revision === 3).revisionScope, 'due_date_only')
  assert.equal(busyBefore.cloud.works.find(row => row.id === work.id).instructionRevision, 2)
  assert.equal(busyAfter.state.works.find(row => row.id === work.id).instructionRevision, 3)
  assert.equal(busyBefore.heldWorker.instructionRevision, 2); assert.equal(busyBefore.heldWorker.state, 'running')
  assert.ok(Number.isSafeInteger(busyBefore.heldWorker.worker.pid))
  assert.equal(busyAfter.heldWorker.worker.pid, busyBefore.heldWorker.worker.pid)
  assert.equal(busyAfter.local.jobs.find(row => row.id === busyBefore.heldWorker.id).worker.pid, busyBefore.heldWorker.worker.pid)
  const stoppedWorker = await json('worker-os-stopped.json'), beforeRelease = busyAfter.workerBeforeRelease, releaseSignal = await json('worker-release-signal.json')
  assert.ok(beforeRelease)
  for (const observation of [stoppedWorker, beforeRelease]) {
    assert.equal(observation.jobId, busyBefore.heldWorker.id)
    assert.equal(observation.instructionRevision, 2)
    assert.equal(observation.pid, busyBefore.heldWorker.worker.pid)
    assert.ok(['T', 't'].includes(observation.osState))
    assert.ok(/^[0-9]+$/.test(String(observation.startTicks)))
    assert.ok(Number.isFinite(Date.parse(observation.observedAt)))
  }
  assert.equal(String(beforeRelease.startTicks), String(stoppedWorker.startTicks))
  assert.equal(beforeRelease.parentPid, stoppedWorker.parentPid)
  assert.equal(beforeRelease.processGroupId, stoppedWorker.processGroupId)
  assert.ok(Date.parse(beforeRelease.observedAt) >= Date.parse(stoppedWorker.observedAt))
  assert.equal(releaseSignal.jobId, stoppedWorker.jobId); assert.equal(releaseSignal.pid, stoppedWorker.pid)
  assert.equal(String(releaseSignal.startTicks), String(stoppedWorker.startTicks))
  assert.equal(releaseSignal.signal, 'SIGCONT')
  assert.ok(Date.parse(releaseSignal.signalSentAt) >= Date.parse(beforeRelease.observedAt))
  assert.equal(inputs.find(row => row.revision === 2).spreadsheetRequest.dueDate, '2026-11-20')
  assert.equal(inputs.find(row => row.revision === 3).spreadsheetRequest.dueDate, '2026-11-25')
  assert.deepEqual(old.evidence, questionState.evidence)
  const phases = await Promise.all(files.filter(name => /^watchdog-phase-.*\.json$/.test(name)).map(async name => ({ name, state: await json(name) })))
  const phase = name => { const value = phases.find(row => row.name === `watchdog-phase-${name}.json`); assert.ok(value, '缺真实监督阶段:' + name); assert.ok(value.state.lastSnapshot?.attempts); return value.state.lastSnapshot }
  assert.equal(phase('before-create').attempts.length, 0)
  assert.ok(phase('waiting-user-before-answer').attempts.some(row => row.binding.work_id === work.id && row.binding.agent_id === 'desktop-office' && row.waits.includes('WAITING_USER')))
  assert.ok(phase('input2-consumed').attempts.some(row => row.binding.work_id === work.id && row.binding.agent_id === 'desktop-office' && row.observedRevision === 2))
  assert.ok(phase('job2-actually-running').attempts.some(row => row.binding.work_id === work.id && row.jobs.some(item => item.id === busyBefore.heldWorker.id && item.state === 'running')))
  const sourceReady = phase('source-ready-root-settled').attempts.filter(row => row.binding.work_id === work.id)
  assert.equal(sourceReady.length, 5); assert.ok(sourceReady.every(row => row.status === 'completed'))
  assert.deepEqual(old.supervisionActions, [])
  const rawRequests = await lines('provider-requests.jsonl')
  if (sourceOnly) {
    assert.deepEqual(rawRequests.map(digest).sort(), sourceLedger.map(row => row.bodyDigest).sort())
    assert.deepEqual(all.captures.map(row => digest(row.body)).sort(), sourceLedger.map(row => row.bodyDigest).sort())
    const result = { result: 'passed', authority: 'author_source_oracle_only_not_continuation_or_release_gate', directory,
      sourceWorkId: work.id, originalHistoryRows: 20, originalGatewayEvents: 20, actualSourceProviderBodies: rawRequests.length,
      threeXlsxCopiesSameSha256: artifact.sha256, fourSheetsAgainstSealedSourceAndActualManifest: true,
      originalFiveSessionsAndAllframes: true, input2BusyWorkerAndTypedInput3: true, sameOsWorkerStoppedBeforeAndAfterInput3ThenContinued: { pid: stoppedWorker.pid, startTicks: stoppedWorker.startTicks }, watchdogObserveOnlySourcePhases: phases.map(row => row.name),
      boundary: 'source phase only: no context-final-state or continuation artifacts read; independent workbook/sealed bytes and actual native-session/provider/source snapshots; same actual pid/startTicks OS-T before and after revision3 and later SIGCONT proven by archived proc/signal observations; 20-entry fixture, not 200-entry/full integrated or release approval' }
    await writeFile(join(directory, resultFile), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  } else {
  const final = await json('context-final-state.json')
  stage = '续办后原业务事实不可变'
  assert.deepEqual(final.works.find(row => row.id === work.id), work)
  assert.deepEqual(final.multisite.inputs.filter(row => row.workId === work.id), inputs)
  assert.deepEqual(final.multisite.attempts.filter(row => row.work_id === work.id), sourceAttempts)
  for (const field of ['artifacts', 'evidence', 'evidenceAccessReceipts']) assert.deepEqual(final[field].slice(0, old[field].length), old[field])
  assert.deepEqual(final.artifacts.filter(row => row.workId === work.id), old.artifacts.filter(row => row.workId === work.id))
  assert.deepEqual(final.modelRequests.slice(0, old.modelRequests.length), old.modelRequests)
  assert.deepEqual(final.modelRequests.filter(row => row.work_id === work.id), sourceLedger)
  const links = final.workContinuations.filter(row => row.sourceWorkId === work.id)
  assert.equal(links.length, 1)
  const link = links[0], reader = final.multisite.attempts.find(row => row.work_id === link.workId && row.parent_delegation_id === null)
  assert.ok(reader); assert.notEqual(reader.session_id, root.session_id)
  assert.ok(rawSessions.some(row => row.frames.some(frame => frame.type === 'session' && frame.id === reader.session_id)))
  const readPages = final.contextReads.filter(row => row.receiverBinding.work_id === link.workId)
  assert.ok(readPages.length)
  for (const kind of ['continuation', 'work', 'artifact', 'job', 'result', 'evidence']) assert.ok(readPages.some(row => row.objectRef.kind === kind), `缺真实逐跳对象:${kind}`)

  stage = '新Root完整toolcall/result与ledger credit交叉'
  assert.deepEqual(rawRequests.map(digest).sort(), all.captures.map(row => digest(row.body)).sort())
  assert.deepEqual(all.captures.map(row => digest(row.body)).sort(), final.modelRequests.map(row => row.bodyDigest).sort())
  const contextRequests = all.captures.filter(row => row.workId === link.workId && row.agent === 'coordinator-context')
  assert.ok(contextRequests.length)
  const newLedger = final.modelRequests.filter(row => row.work_id === link.workId)
  const credits = new Map()
  for (const request of contextRequests) {
    const ledger = newLedger.find(row => row.bodyDigest === digest(request.body))
    assert.ok(ledger)
    const calls = new Map()
    for (const message of request.body.messages) {
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) if (call.type === 'function') calls.set(call.id, call.function)
      if (message.role !== 'tool' || calls.get(message.tool_call_id)?.name !== 'geneway_read_context') continue
      const result = JSON.parse(flatten(message.content)), page = result.result ?? result
      const read = readPages.find(row => row.id === page.readId)
      assert.ok(read)
      const args = JSON.parse(calls.get(message.tool_call_id).arguments)
      assert.equal(read.requestDigest, digest(args)); assert.equal(digest(page), read.pageDigest)
      assert.equal(Buffer.byteLength(JSON.stringify(page)), read.bytes); assert.ok(read.bytes <= 16384)
      assert.deepEqual(binding(ledger), read.receiverBinding)
      assert.equal(ledger.instructionRevision, read.instructionRevision)
      if (ledger.contextReadReceiptIds?.includes(read.id)) credits.set(read.id, { requestId: ledger.id, bodyDigest: ledger.bodyDigest })
    }
  }
  for (const read of readPages) assert.ok(credits.has(read.id), `资料页未进入完整providerbody且被原ledgercredit:${read.id}`)
  const historyRead = readPages.find(row => row.objectRef.id === historySource.ref.id && row.view === 'content' && row.fromIndex >= 16 && row.page.items.some(item => item.entryIndex === 19))
  assert.ok(historyRead, '必须是A第19项所在第二页，不是Goal/summary自报')
  assert.deepEqual(historyRead.page.items.find(item => item.entryIndex === 19), { entryIndex: 19, ...sealedHistory.entries[19] })
  const siteRead = readPages.find(row => row.objectRef.id === siteSource.ref.id && row.view === 'content' && row.page.items.some(item => item.eventIndex === 0))
  assert.ok(siteRead)
  assert.deepEqual(siteRead.page.items.find(item => item.eventIndex === 0), { eventIndex: 0, ...sealedSite.events[0] })
  const newWork = final.works.find(row => row.id === link.workId), newInputs = final.multisite.inputs.filter(row => row.workId === link.workId)
  for (const text of [newWork.goal, ...newInputs.map(row => row.text)]) {
    assert.equal(text.includes(sealedHistory.entries[19].description), false, 'A19不能预填在goal/Input代替实际读取')
    assert.equal(text.includes(sealedSite.events[0].message), false, 'G正文不能预填在goal/Input代替实际读取')
  }
  assert.equal(JSON.stringify(all).includes('PRIVATE_MARKER_NOT_EXPORTED'), false)
  assert.equal(JSON.stringify(all).includes('PRIVATE_SIBLING_NOT_MAPPED'), false)
  assert.equal(JSON.stringify(all).includes('\uFFFD'), false)

  stage = '全程watchdog只观察证据'
  const phaseFiles = files.filter(name => /^watchdog-phase-.*\.json$/.test(name))
  assert.ok(phaseFiles.length > 0, '缺真实watchdog阶段归档')
  const observations = await lines('watchdog-observations.jsonl')
  assert.ok(observations.length)
  assert.deepEqual(final.supervisionActions, [], '集成监督只观察，不能自动处置')
  for (const phase of phases) assert.ok(phase.state.lastSnapshot && Array.isArray(phase.state.lastSnapshot.attempts), '阶段文件必须有实际裁剪snapshot')
  assert.ok(phases.some(phase => phase.state.lastSnapshot.attempts.some(row => row.binding.work_id === work.id)))
  assert.ok(phases.some(phase => phase.state.lastSnapshot.attempts.some(row => row.binding.work_id === link.workId)))
  const result = { result: 'passed', authority: 'author_oracle_only_not_release_gate', directory,
    originalHistoryRows: 20, originalGatewayEvents: 20, sourceWorkId: work.id, continuationWorkId: link.workId,
    threeXlsxCopiesSameSha256: artifact.sha256, fourSheetsAgainstSealedSourceAndActualManifest: true,
    originalFiveSessionsAndAllframes: true, sameOsWorkerStoppedBeforeAndAfterInput3ThenContinued: { pid: stoppedWorker.pid, startTicks: stoppedWorker.startTicks }, oldSourceFactsAndLedgerPrefixUnchanged: true,
    actualNewRootContextPagesCredited: readPages.length, historyIndex19SecondPageReadId: historyRead.id,
    gatewayOriginalEventReadId: siteRead.id, providerBodies: rawRequests.length,
    watchdogPhaseFiles: phaseFiles, watchdogObservationCount: observations.length, watchdogObserveOnly: true,
    boundary: 'read-only independent ExcelJS/source/capture/worker/cloud bytes and actual provider/tool/ledger/session evidence; no generator/pagebuilder imports or new business/model calls; 20-entry source fixture, not 200-entry/onsite/full-goal acceptance' }
  await writeFile(join(directory, resultFile), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  }
} catch (cause) {
  const result = { result: 'failed', authority: sourceOnly ? 'author_source_oracle_only_not_continuation_or_release_gate' : 'author_oracle_only_not_release_gate', directory, stage, error: { code: cause.code ?? cause.name, message: cause.message } }
  await writeFile(join(directory, resultFile), JSON.stringify(result, null, 2)).catch(() => {})
  console.error(JSON.stringify(result, null, 2)); process.exitCode = 1
}
