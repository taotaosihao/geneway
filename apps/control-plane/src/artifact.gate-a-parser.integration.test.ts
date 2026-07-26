import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  digestGateAParserManifest,
  gateAParserManifestSchema,
} from '@geneway/contracts';
import {
  validateTextUpload,
  type GateAParsedCanonicalText,
} from '@geneway/ingestion';
import {
  StorageObjectAlreadyExistsError,
  StorageObjectNotFoundError,
  type ObjectStorage,
} from '@geneway/storage';
import { ArtifactRepository } from './artifact-repository.js';
import {
  ArtifactService,
  GATE_A_APPROVED_C1_TEST_MATERIAL_SHA256,
  GATE_A_APPROVED_C1_TEST_MATERIAL_UTF8,
} from './artifact-service.js';
import { ControlPlaneRepository } from './repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for Gate A artifact parser integration tests');
const control = new ControlPlaneRepository(databaseUrl, 'gate-a-artifact-test-cursor-secret-at-least-32-bytes');
const repository = new ArtifactRepository(control.pool);
const principal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' } as const;
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

class MemoryStorage implements ObjectStorage {
  readonly bucket = 'gate-a-artifact-test';
  private readonly objects = new Map<string, Readonly<{
    bytes: Uint8Array;
    contentType: string;
    contentSha256: string;
  }>>();

  putCreateOnly(input: Readonly<{
    key: string;
    bytes: Uint8Array;
    contentType: string;
    contentSha256: string;
  }>): Promise<Readonly<{ eTag: string; versionId: null }>> {
    if (this.objects.has(input.key)) throw new StorageObjectAlreadyExistsError(input.key);
    this.objects.set(input.key, {
      bytes: Uint8Array.from(input.bytes),
      contentType: input.contentType,
      contentSha256: input.contentSha256,
    });
    return Promise.resolve({ eTag: '"memory-etag"', versionId: null });
  }

  head(key: string) {
    const object = this.objects.get(key);
    if (object === undefined) throw new StorageObjectNotFoundError(key);
    return Promise.resolve({
      sizeBytes: object.bytes.byteLength,
      contentType: object.contentType,
      contentSha256: object.contentSha256,
      eTag: '"memory-etag"',
      versionId: null,
    });
  }

  getBytes(key: string, maximumBytes: number): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (object === undefined) throw new StorageObjectNotFoundError(key);
    if (object.bytes.byteLength > maximumBytes) throw new Error('test object too large');
    return Promise.resolve(Uint8Array.from(object.bytes));
  }
}

async function parsedAuthority(bytes: Uint8Array): Promise<GateAParsedCanonicalText> {
  const unsigned = {
    schemaVersion: 'parser-manifest.gate-a/1' as const,
    id: 'parser_plain_text_artifact_integration_1',
    mediaType: 'text/plain' as const,
    parser: {
      name: 'geneway-plain-text-parser' as const,
      version: '1.0.0' as const,
      registrySource: 'geneway-workspace' as const,
      upstreamSource: 'geneway://packages/ingestion/plain-text-parser' as const,
      lockResolution: 'docker-image:sha256:' + 'a'.repeat(64),
      lockIntegrity: 'a'.repeat(64),
      executableDigest: 'b'.repeat(64),
      packageDigest: 'c'.repeat(64),
      license: 'UNLICENSED-internal' as const,
    },
    dependencies: [],
    conversionConfig: {
      inputEncoding: 'UTF-8' as const,
      outputEncoding: 'UTF-8' as const,
      unicodeNormalization: 'none' as const,
      newlineNormalization: 'none' as const,
      stripByteOrderMark: false as const,
      maxInputBytes: 1_048_576 as const,
      maxOutputBytes: 1_048_576 as const,
    },
    resourceLimitsVersion: 'gate-a-parser-limits/1' as const,
    approvedBy: 'user_local',
    approvedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const manifestDigest = await digestGateAParserManifest(unsigned);
  const parserManifest = gateAParserManifestSchema.parse({ ...unsigned, manifestDigest });
  return {
    canonicalBytes: Uint8Array.from(bytes),
    canonicalTextSha256: sha256(bytes),
    parserManifest,
    parserDigest: manifestDigest,
    processReceipt: {
      schemaVersion: 'gate-a-parser-process-receipt/1',
      imageId: 'sha256:' + 'd'.repeat(64),
      networkMode: 'none',
      readOnlyRootFilesystem: true,
      uid: 65_534,
      gid: 65_534,
      capabilities: [],
      noNewPrivileges: true,
      pidsLimit: 16,
      memoryLimitBytes: 67_108_864,
      cpuLimit: 0.5,
      inputMountCount: 1,
      outputMountCount: 1,
    },
  };
}

async function createConversation(id: string): Promise<void> {
  await control.pool.query(
    'INSERT INTO conversations(tenant_id,id,user_id) VALUES ($1,$2,$3)',
    [principal.tenantId, id, principal.userId],
  );
}

describe('Gate A text/plain artifact parser authority', () => {
  beforeEach(async () => {
    await control.resetForTest();
  });
  afterAll(async () => {
    await control.close();
  });

  it('persists exact canonical bytes and immutable manifest in the finalize transaction', async () => {
    const conversationId = 'conversation-artifact-parser-valid';
    await createConversation(conversationId);
    const bytes = new TextEncoder().encode('真实材料：保持 UTF-8 原始字节。\r\n');
    const service = new ArtifactService(repository, new MemoryStorage(), {
      parserSandbox: { parse: parsedAuthority },
      authorizeLiveC1Upload: ({ contentSha256 }) => contentSha256 === sha256(bytes),
    });
    const result = await service.ingest({
      principal,
      conversationId,
      idempotencyKey: 'artifact-parser-valid-0001',
      upload: validateTextUpload({ fileName: 'live.txt', mediaType: 'text/plain', bytes }),
    });

    const authority = await control.pool.query<{
      parser_manifest_id: string;
      parser_digest: string;
      canonical_bytes: Buffer;
      canonical_text_sha256: string;
      audit_receipt: unknown;
    }>(`SELECT canonical.parser_manifest_id,canonical.parser_digest,canonical.canonical_bytes,
      canonical.canonical_text_sha256,audit.details->'parserProcessReceipt' audit_receipt
      FROM document_snapshot_canonical_representations canonical
      JOIN parser_manifests parser ON parser.tenant_id=canonical.tenant_id
        AND parser.id=canonical.parser_manifest_id AND parser.manifest_digest=canonical.parser_digest
      JOIN audit_events audit ON audit.tenant_id=canonical.tenant_id
        AND audit.resource_id=$2 AND audit.event_type='artifact.upload.completed'
      WHERE canonical.tenant_id=$1 AND canonical.document_snapshot_id=$3`, [
      principal.tenantId, result.artifact.id, result.documentSnapshot.id,
    ]);
    expect(authority.rows).toHaveLength(1);
    expect(authority.rows[0]?.canonical_bytes).toEqual(Buffer.from(bytes));
    expect(authority.rows[0]?.canonical_text_sha256).toBe(sha256(bytes));
    expect(authority.rows[0]?.audit_receipt).toMatchObject({ networkMode: 'none', capabilities: [] });

    const [record] = await repository.listSnapshotRecords(principal, conversationId);
    expect(record?.liveCanonicalAuthority).toMatchObject({
      eligible: true,
      parserManifestId: authority.rows[0]?.parser_manifest_id,
      parserDigest: authority.rows[0]?.parser_digest,
      extractionVersion: 'canonical-text/plain-utf8/1',
      canonicalTextSha256: sha256(bytes),
    });
  });

  it('does not create artifact or canonical authority when parser execution fails', async () => {
    const conversationId = 'conversation-artifact-parser-fail';
    await createConversation(conversationId);
    const bytes = new TextEncoder().encode('parser failure must roll back final authority');
    const service = new ArtifactService(repository, new MemoryStorage(), {
      parserSandbox: { parse: () => Promise.reject(new Error('sandbox crash')) },
      authorizeLiveC1Upload: ({ contentSha256 }) => contentSha256 === sha256(bytes),
    });
    await expect(service.ingest({
      principal,
      conversationId,
      idempotencyKey: 'artifact-parser-fail-0001',
      upload: validateTextUpload({ fileName: 'live.txt', mediaType: 'text/plain', bytes }),
    })).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_FAILED' });
    const counts = await control.pool.query<{ artifacts: number; snapshots: number; canonical: number }>(`SELECT
      (SELECT count(*)::int FROM artifacts) artifacts,
      (SELECT count(*)::int FROM document_snapshots) snapshots,
      (SELECT count(*)::int FROM document_snapshot_canonical_representations) canonical`);
    expect(counts.rows[0]).toEqual({ artifacts: 0, snapshots: 0, canonical: 0 });
  });

  it('fails closed for non-demo text/plain when no parser sandbox is configured', async () => {
    const conversationId = 'conversation-artifact-parser-unconfigured';
    await createConversation(conversationId);
    const bytes = new TextEncoder().encode('stored but not live eligible');
    const service = new ArtifactService(repository, new MemoryStorage(), { liveCanonicalIngest: true });
    await expect(service.ingest({
      principal,
      conversationId,
      idempotencyKey: 'artifact-parser-unconfigured-0001',
      upload: validateTextUpload({ fileName: 'live.txt', mediaType: 'text/plain', bytes }),
    })).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_NOT_CONFIGURED' });
    const records = await repository.listSnapshotRecords(principal, conversationId);
    expect(records).toHaveLength(0);
    expect((await control.pool.query('SELECT 1 FROM document_snapshot_canonical_representations')).rowCount).toBe(0);
  });

  it('does not invoke the live parser for the historical simulation fixture', async () => {
    const conversationId = 'conversation-artifact-parser-demo';
    await createConversation(conversationId);
    const fixture = await readFile(new URL(
      '../../../scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt',
      import.meta.url,
    ));
    let calls = 0;
    const service = new ArtifactService(repository, new MemoryStorage(), {
      parserSandbox: { parse: async (bytes) => { calls += 1; return parsedAuthority(bytes); } },
    });
    await service.ingest({
      principal,
      conversationId,
      idempotencyKey: 'artifact-parser-demo-0001',
      upload: validateTextUpload({
        fileName: 'solution-analysis-demo-v2.txt',
        mediaType: 'text/plain',
        bytes: fixture,
      }),
    });
    expect(calls).toBe(0);
    expect((await control.pool.query('SELECT 1 FROM document_snapshot_canonical_representations')).rowCount).toBe(0);
  });

  it('accepts only the checked-in server-approved C1 bytes before storage PUT', async () => {
    const conversationId = 'conversation-artifact-approved-c1';
    await createConversation(conversationId);
    const bytes = new TextEncoder().encode(GATE_A_APPROVED_C1_TEST_MATERIAL_UTF8);
    expect(sha256(bytes)).toBe(GATE_A_APPROVED_C1_TEST_MATERIAL_SHA256);
    let puts = 0;
    const storage = new MemoryStorage();
    const service = new ArtifactService(repository, {
      ...storage,
      bucket: storage.bucket,
      putCreateOnly: (input) => { puts += 1; return storage.putCreateOnly(input); },
      head: (key) => storage.head(key),
      getBytes: (key, maximumBytes) => storage.getBytes(key, maximumBytes),
    }, {
      parserSandbox: { parse: parsedAuthority },
      authorizeLiveC1Upload: ({ contentSha256 }) => contentSha256 === GATE_A_APPROVED_C1_TEST_MATERIAL_SHA256,
    });
    await service.ingest({ principal, conversationId, idempotencyKey: 'artifact-approved-c1-0001',
      upload: validateTextUpload({ fileName: 'gate-a1-c1-material.txt', mediaType: 'text/plain', bytes }) });
    expect(puts).toBe(1);
  });

  it('rejects non-allowlisted and forged live C1 declarations before storage PUT', async () => {
    const conversationId = 'conversation-artifact-c1-denied';
    await createConversation(conversationId);
    let puts = 0;
    const storage = new MemoryStorage();
    const service = new ArtifactService(repository, {
      ...storage,
      bucket: storage.bucket,
      putCreateOnly: (input) => { puts += 1; return storage.putCreateOnly(input); },
      head: (key) => storage.head(key),
      getBytes: (key, maximumBytes) => storage.getBytes(key, maximumBytes),
    }, {
      parserSandbox: { parse: parsedAuthority },
      authorizeLiveC1Upload: ({ contentSha256 }) => contentSha256 === GATE_A_APPROVED_C1_TEST_MATERIAL_SHA256,
    });
    const c2LikeBytes = new TextEncoder().encode('客户身份证号：110101199001011234；不得自动归类为 C1。');
    const c2LikeUpload = validateTextUpload({ fileName: 'customer-sensitive.txt', mediaType: 'text/plain', bytes: c2LikeBytes });
    await expect(service.ingest({ principal, conversationId, idempotencyKey: 'artifact-c1-denied-0001',
      upload: c2LikeUpload })).rejects.toMatchObject({ code: 'DATA_ROUTE_NOT_ALLOWED' });
    const approvedBytes = new TextEncoder().encode(GATE_A_APPROVED_C1_TEST_MATERIAL_UTF8);
    const forged = { ...validateTextUpload({ fileName: 'forged.txt', mediaType: 'text/plain', bytes: approvedBytes }),
      bytes: c2LikeBytes };
    await expect(service.ingest({ principal, conversationId, idempotencyKey: 'artifact-c1-forged-0001',
      upload: forged })).rejects.toMatchObject({ code: 'DATA_ROUTE_NOT_ALLOWED' });
    expect(puts).toBe(0);
    expect((await control.pool.query('SELECT 1 FROM artifact_ingest_intents')).rowCount).toBe(0);
  });
});
