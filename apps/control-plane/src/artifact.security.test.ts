import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifactIngestResponseSchema, GenewayError, type Principal } from '@geneway/contracts';
import { MAX_MULTIPART_ENVELOPE_BYTES, MAX_RAW_UPLOAD_BYTES } from '@geneway/ingestion';
import { createControlPlane, type ControlPlane } from './index.js';
import { multipartPayload, type MultipartPart } from './artifact-test-helpers.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for artifact security tests');

const localPrincipal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' } as const;
const peerPrincipal = { tenantId: 'tenant_local', userId: 'user_peer', trust: 'trusted-local' } as const;
const otherPrincipal = { tenantId: 'tenant_other', userId: 'user_other', trust: 'trusted-local' } as const;

function resolvePrincipal(authorization: string | undefined): Principal {
  if (authorization === undefined) return localPrincipal;
  if (authorization === 'Bearer same-tenant-peer') return peerPrincipal;
  if (authorization === 'Bearer other-user') return otherPrincipal;
  throw new GenewayError('AUTHENTICATION_REQUIRED', 'A valid server-side session is required', 401);
}

describe('Gate 0.2A.1 artifact security boundaries over real HTTP and S3', () => {
  let controlPlane: ControlPlane;
  let baseUrl: string;
  let fixture: Buffer;

  beforeAll(async () => {
    fixture = await readFile(path.resolve(process.cwd(), 'scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt'));
    controlPlane = await createControlPlane({
      databaseUrl,
      principalResolver: (request) => resolvePrincipal(request.headers.authorization),
    });
    if (controlPlane.artifactService === null) throw new Error('Artifact security test requires GENEWAY S3 configuration');
    await controlPlane.app.listen({ host: '127.0.0.1', port: 0 });
    const address = controlPlane.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Control Plane did not expose a TCP port');
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => controlPlane.app.close());

  beforeEach(async () => {
    await controlPlane.repository.resetForTest();
    await controlPlane.repository.pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ('tenant_local','user_peer','同租户隔离测试用户')");
    await controlPlane.repository.pool.query("INSERT INTO tenants (id,name) VALUES ('tenant_other','隔离测试租户')");
    await controlPlane.repository.pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ('tenant_other','user_other','隔离测试用户')");
  });

  async function createConversation(token?: string): Promise<string> {
    const response = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'idempotency-key': `conversation-${crypto.randomUUID()}`, ...(token === undefined ? {} : { authorization: token }) },
    });
    expect(response.status).toBe(201);
    return (await response.json() as { id: string }).id;
  }

  async function upload(conversationId: string, parts: readonly MultipartPart[], key = `upload-${crypto.randomUUID()}`, token?: string) {
    const multipart = multipartPayload(parts);
    return fetch(`${baseUrl}/api/conversations/${conversationId}/uploads`, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
        'idempotency-key': key,
        ...(token === undefined ? {} : { authorization: token }),
      },
      body: multipart.body,
    });
  }

  async function uploadFixture(conversationId: string) {
    const response = await upload(conversationId, [{ fieldName: 'file', fileName: 'solution-analysis-demo-v2.txt', mediaType: 'text/plain', bytes: fixture }]);
    expect(response.status).toBe(201);
    return artifactIngestResponseSchema.parse(await response.json());
  }

  it('denies a different principal and tenant before storage access without poisoning integrity state', async () => {
    const conversationId = await createConversation();
    const result = await uploadFixture(conversationId);
    const forbidden = await fetch(`${baseUrl}${result.artifact.downloadUrl}`, { headers: { authorization: 'Bearer other-user' } });
    expect(forbidden.status).toBe(404);
    await expect(forbidden.json()).resolves.toMatchObject({ error: { code: 'ARTIFACT_NOT_FOUND' } });
    const state = await controlPlane.repository.pool.query<{ availability: string; integrity: string; failure_code: string | null }>(
      'SELECT availability,integrity,failure_code FROM artifact_states WHERE tenant_id=$1 AND artifact_id=$2', ['tenant_local', result.artifact.id]);
    expect(state.rows).toEqual([{ availability: 'active', integrity: 'verified', failure_code: null }]);
    const deniedAudit = await controlPlane.repository.pool.query<{ reason_code: string }>("SELECT reason_code FROM audit_events WHERE tenant_id='tenant_other' AND outcome='denied'");
    expect(deniedAudit.rows).toEqual([{ reason_code: 'ARTIFACT_NOT_FOUND_OR_FORBIDDEN' }]);

    const otherUpload = await upload(conversationId, [{ fieldName: 'file', fileName: 'other.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('other') }], 'other-user-cross-tenant', 'Bearer other-user');
    expect(otherUpload.status).toBe(404);

    const peerDownload = await fetch(`${baseUrl}${result.artifact.downloadUrl}`, { headers: { authorization: 'Bearer same-tenant-peer' } });
    expect(peerDownload.status).toBe(404);
    const peerUpload = await upload(conversationId, [{ fieldName: 'file', fileName: 'peer.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('peer') }], 'same-tenant-peer-upload', 'Bearer same-tenant-peer');
    expect(peerUpload.status).toBe(404);

    const unknown = await fetch(`${baseUrl}${result.artifact.downloadUrl}`, { headers: { authorization: 'Bearer unknown' } });
    expect(unknown.status).toBe(401);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
  });

  it.each([
    ['extra form field', [
      { fieldName: 'file', fileName: 'ok.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('ok') },
      { fieldName: 'note', bytes: new TextEncoder().encode('forbidden') },
    ]],
    ['two files', [
      { fieldName: 'file', fileName: 'a.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('a') },
      { fieldName: 'file', fileName: 'b.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('b') },
    ]],
    ['wrong field name', [{ fieldName: 'document', fileName: 'a.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('a') }]],
    ['extension mismatch', [{ fieldName: 'file', fileName: 'a.md', mediaType: 'text/plain', bytes: new TextEncoder().encode('a') }]],
    ['path traversal', [{ fieldName: 'file', fileName: '../a.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('a') }]],
    ['binary magic', [{ fieldName: 'file', fileName: 'a.txt', mediaType: 'text/plain', bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46) }]],
    ['UTF-8 BOM', [{ fieldName: 'file', fileName: 'a.txt', mediaType: 'text/plain', bytes: Uint8Array.of(0xef, 0xbb, 0xbf, 0x61) }]],
    ['invalid UTF-8', [{ fieldName: 'file', fileName: 'a.txt', mediaType: 'text/plain', bytes: Uint8Array.of(0xc3, 0x28) }]],
  ] satisfies readonly (readonly [string, readonly MultipartPart[]])[])('rejects %s before creating authority rows', async (_name, parts) => {
    const conversationId = await createConversation();
    const response = await upload(conversationId, parts);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const counts = await controlPlane.repository.pool.query<{ intents: string; artifacts: string }>(`SELECT
      (SELECT count(*)::text FROM artifact_ingest_intents) intents,
      (SELECT count(*)::text FROM artifacts) artifacts`);
    expect(counts.rows[0]).toEqual({ intents: '0', artifacts: '0' });
    const audit = await controlPlane.repository.pool.query<{ details: unknown; reason_code: string }>(
      "SELECT details,reason_code FROM audit_events WHERE event_type='artifact.upload.denied'",
    );
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows[0]?.details)).not.toContain('forbidden');
    expect(JSON.stringify(audit.rows[0]?.details)).not.toContain('../a.txt');
  });

  it('enforces the 1 MiB raw limit over a truly chunked HTTP request', async () => {
    const conversationId = await createConversation();
    const multipart = multipartPayload([{ fieldName: 'file', fileName: 'large.txt', mediaType: 'text/plain', bytes: new Uint8Array(MAX_RAW_UPLOAD_BYTES + 1).fill(0x61) }]);
    const response = await new Promise<Readonly<{ status: number; body: string }>>((resolve, reject) => {
      const target = new URL(`/api/conversations/${conversationId}/uploads`, baseUrl);
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
          'idempotency-key': 'chunked-over-limit-001',
          'transfer-encoding': 'chunked',
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      for (let offset = 0; offset < multipart.body.length; offset += 8191) request.write(multipart.body.subarray(offset, Math.min(offset + 8191, multipart.body.length)));
      request.end();
    });
    expect(response.status, response.body).toBe(413);
    expect(JSON.parse(response.body) as unknown).toMatchObject({ error: { code: 'UPLOAD_TOO_LARGE' } });
    const intents = await controlPlane.repository.pool.query('SELECT 1 FROM artifact_ingest_intents');
    expect(intents.rowCount).toBe(0);
    const audit = await controlPlane.repository.pool.query<{ reason_code: string }>("SELECT reason_code FROM audit_events WHERE event_type='artifact.upload.denied'");
    expect(audit.rows).toEqual([{ reason_code: 'UPLOAD_TOO_LARGE' }]);
  });

  it('enforces the total multipart envelope for a chunked request with a valid-sized file', async () => {
    const conversationId = await createConversation();
    const multipart = multipartPayload([{ fieldName: 'file', fileName: 'max.txt', mediaType: 'text/plain', bytes: new Uint8Array(MAX_RAW_UPLOAD_BYTES).fill(0x61) }]);
    const oversizedEnvelope = Buffer.concat([
      multipart.body,
      Buffer.alloc(MAX_MULTIPART_ENVELOPE_BYTES - multipart.body.byteLength + 1, 0x20),
    ]);
    const response = await new Promise<Readonly<{ status: number; body: string }>>((resolve, reject) => {
      const target = new URL(`/api/conversations/${conversationId}/uploads`, baseUrl);
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
          'idempotency-key': 'chunked-envelope-over-limit-001',
          'transfer-encoding': 'chunked',
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      for (let offset = 0; offset < oversizedEnvelope.length; offset += 8191) {
        request.write(oversizedEnvelope.subarray(offset, Math.min(offset + 8191, oversizedEnvelope.length)));
      }
      request.end();
    });
    expect(response.status, response.body).toBe(413);
    expect(JSON.parse(response.body) as unknown).toMatchObject({ error: { code: 'UPLOAD_ENVELOPE_TOO_LARGE' } });
    const intents = await controlPlane.repository.pool.query('SELECT 1 FROM artifact_ingest_intents');
    expect(intents.rowCount).toBe(0);
    const audit = await controlPlane.repository.pool.query<{ reason_code: string }>("SELECT reason_code FROM audit_events WHERE event_type='artifact.upload.denied'");
    expect(audit.rows).toEqual([{ reason_code: 'UPLOAD_ENVELOPE_TOO_LARGE' }]);
  });

  it('detects a missing or overwritten S3 object before sending a download body', async () => {
    const endpoint = process.env.GENEWAY_E2E_S3_ENDPOINT;
    const bucket = process.env.GENEWAY_E2E_S3_BUCKET;
    const accessKeyId = process.env.GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID;
    const secretAccessKey = process.env.GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY;
    if (endpoint === undefined || bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) throw new Error('S3 test environment is incomplete');
    const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });

    const firstConversation = await createConversation();
    const missing = await uploadFixture(firstConversation);
    const missingManifest = await controlPlane.repository.pool.query<{ storage_key: string }>('SELECT storage_key FROM artifact_manifests WHERE tenant_id=$1 AND artifact_id=$2', ['tenant_local', missing.artifact.id]);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: missingManifest.rows[0]?.storage_key }));
    const missingDownload = await fetch(`${baseUrl}${missing.artifact.downloadUrl}`);
    expect(missingDownload.status).toBe(409);
    await expect(missingDownload.json()).resolves.toMatchObject({ error: { code: 'ARTIFACT_OBJECT_MISSING' } });

    const secondConversation = await createConversation();
    const overwritten = await uploadFixture(secondConversation);
    const overwrittenManifest = await controlPlane.repository.pool.query<{ storage_key: string }>('SELECT storage_key FROM artifact_manifests WHERE tenant_id=$1 AND artifact_id=$2', ['tenant_local', overwritten.artifact.id]);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: overwrittenManifest.rows[0]?.storage_key, Body: 'tampered', ContentType: 'text/plain', Metadata: { 'content-sha256': '0'.repeat(64) } }));
    const overwrittenDownload = await fetch(`${baseUrl}${overwritten.artifact.downloadUrl}`);
    expect(overwrittenDownload.status).toBe(409);
    await expect(overwrittenDownload.json()).resolves.toMatchObject({ error: { code: 'ARTIFACT_INTEGRITY_FAILED' } });
  });
});
