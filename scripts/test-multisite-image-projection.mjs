import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { bootDshHost } from '../src/dsh-host.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { seedMultisite } from './fixtures/multisite/runtime.mjs'
const temp = await mkdtemp(join(tmpdir(), 'geneway-image-projection-')), sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
let native
try {
  process.env.DSH_HOME = join(temp, 'dsh'); process.env.HOME = temp; process.env.GENEWAY_MODEL_GATEWAY = 'http://127.0.0.1:1'
  const values = { ...process.env, GENEWAY_EXECUTION_TOKEN: 'synthetic-attachment-test' }, environment = { get: name => values[name] === undefined ? undefined : { value: values[name], source: 'process' }, getFrom: (name, sources) => sources.includes('process') ? environment.get(name) : undefined }
  native = await bootDshHost({ environment, profile: 'sdk', patchFiles: [join(process.cwd(), 'config/multisite-runtime.patch.yml')], args: [] })
  const bytes = await sharp({ create: { width: 81, height: 53, channels: 3, background: '#cb4335' } }).png().toBuffer()
  const normalizedRef = await native.ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png' })
  const variant = await native.ctx.attachments.readImageRequest(normalizedRef, { width: 81, height: 53, maxBytes: 1024 * 1024 })
  assert.match(normalizedRef.attachmentId, /^sha256:[a-f0-9]{64}$/)
  assert.notEqual(variant.variantId, sha256(variant.data), 'variantId describes transforms; it is not byte hash')
  const store = createFileStore(join(temp, 'state.json')); await store.update(seedMultisite)
  const attachments = createArtifactService({ store, root: join(temp, 'attachments') }), owner = { id: 'owner' }
  const item = await attachments.init(owner, { clientRequestId: 'image', name: 'image.png', mediaType: 'image/png', sizeBytes: bytes.length, sha256: sha256(bytes) })
  await attachments.upload(owner, item.id, Readable.from([bytes]))
  const service = createMultisiteService({ store, attachments }); await service.apply(owner, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: 'producer图片引用', attachmentRefs: [item.ref], clientRequestId: 'work' })
  const attempt = (await store.read()).multisite.attempts[0], execution = { ...attempt, session_id: `geneway-${attempt.launch_id}` }
  const gateway = createModelGateway({ store, attachments, config: {} })
  await gateway.registerVariant(execution, { originalRef: item.ref, normalizedRef, variantId: variant.variantId, sha256: sha256(variant.data), mediaType: variant.mediaType, sizeBytes: variant.data.byteLength, width: variant.width, height: variant.height })
  const saved = (await store.read()).modelImageVariants[0]
  assert.equal(saved.originalRef.sha256, sha256(bytes)); assert.equal(saved.normalizedRef.attachmentId, normalizedRef.attachmentId); assert.equal(saved.variantId, variant.variantId); assert.equal(saved.sha256, sha256(variant.data))
  console.log('Image projection passed: official saveImage/readImageRequest producer → original ref, normalized sha256: identity, transform variantId and actual encoded-byte SHA persist as distinct facts; no provider/model call.')
} finally { await native?.shutdown.shutdown(0); await rm(temp, { recursive: true, force: true }) }
