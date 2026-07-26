import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  S3ObjectStorage,
  StorageObjectAlreadyExistsError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  isCanonicalArtifactObjectKey,
} from '@geneway/storage';

const port = Number(process.env.GENEWAY_STORAGE_ADAPTER_PORT ?? 57071);
const host = process.env.GENEWAY_STORAGE_ADAPTER_HOST ?? '127.0.0.1';
const token = process.env.GENEWAY_STORAGE_ADAPTER_TOKEN;
const endpoint = process.env.GENEWAY_S3_ENDPOINT;
const bucket = process.env.GENEWAY_S3_BUCKET;
const accessKeyId = process.env.GENEWAY_S3_APP_ACCESS_KEY_ID;
const secretAccessKey = process.env.GENEWAY_S3_APP_SECRET_ACCESS_KEY;
const allowedPrefix = process.env.GENEWAY_STORAGE_ALLOWED_PREFIX ?? 'tenants/tenant_local/artifacts/';
if (!Number.isInteger(port) || port < 1 || port > 65_535 || !['127.0.0.1', '0.0.0.0'].includes(host)
  || token === undefined || token.length < 24
  || endpoint === undefined || bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
  throw new Error('Storage adapter environment is incomplete');
}
const authorizationToken: string = token;

const storage = new S3ObjectStorage({ endpoint, bucket, accessKeyId, secretAccessKey, region: process.env.GENEWAY_S3_REGION ?? 'us-east-1' });
const keySchema = z.string().min(1).max(512).refine(
  (value) => isCanonicalArtifactObjectKey(value, allowedPrefix), 'Key is outside the allowed prefix',
);
const putSchema = z.object({
  key: keySchema,
  bytesBase64: z.string().max(1_500_000),
  contentType: z.enum([
    'text/plain',
    'text/markdown',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const keyRequestSchema = z.object({ key: keySchema }).strict();
const getSchema = keyRequestSchema.extend({ maximumBytes: z.number().int().nonnegative().max(1_048_576) }).strict();

function authorized(request: IncomingMessage): boolean {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const actual = Buffer.from(value.slice(7));
  const expected = Buffer.from(authorizationToken);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk)
      : chunk instanceof Uint8Array ? new Uint8Array(chunk) : null;
    if (bytes === null) throw new Error('INVALID_REQUEST_BODY');
    length += bytes.byteLength;
    if (length > 1_600_000) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(combined)) as unknown;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.byteLength), 'cache-control': 'no-store' });
  response.end(bytes);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET' && request.url === '/health') {
    send(response, 200, { ok: true, service: 'geneway-storage-adapter' });
    return;
  }
  if (request.method !== 'POST' || !authorized(request) || request.headers.origin !== undefined) {
    send(response, 404, { error: { code: 'NOT_FOUND', message: 'Route was not found' } });
    return;
  }
  try {
    const body = await readJson(request);
    if (request.url === '/v1/objects/put-create-only') {
      const input = putSchema.parse(body);
      const bytes = new Uint8Array(Buffer.from(input.bytesBase64, 'base64'));
      if (bytes.byteLength > 1_048_576 || Buffer.from(bytes).toString('base64') !== input.bytesBase64
        || createHash('sha256').update(bytes).digest('hex') !== input.contentSha256) {
        throw new Error('INVALID_OBJECT_IDENTITY');
      }
      send(response, 200, await storage.putCreateOnly({ key: input.key, bytes, contentType: input.contentType, contentSha256: input.contentSha256 }));
      return;
    }
    if (request.url === '/v1/objects/head') {
      const input = keyRequestSchema.parse(body);
      send(response, 200, await storage.head(input.key));
      return;
    }
    if (request.url === '/v1/objects/get') {
      const input = getSchema.parse(body);
      const bytes = await storage.getBytes(input.key, input.maximumBytes);
      send(response, 200, { bytesBase64: Buffer.from(bytes).toString('base64') });
      return;
    }
    send(response, 404, { error: { code: 'NOT_FOUND', message: 'Route was not found' } });
  } catch (error) {
    if (error instanceof StorageObjectAlreadyExistsError) {
      send(response, 409, { error: { code: 'STORAGE_OBJECT_ALREADY_EXISTS', message: 'Object already exists' } });
      return;
    }
    if (error instanceof StorageObjectNotFoundError) {
      send(response, 404, { error: { code: 'STORAGE_OBJECT_NOT_FOUND', message: 'Object was not found' } });
      return;
    }
    if (error instanceof StorageObjectTooLargeError) {
      send(response, 413, { error: { code: 'STORAGE_OBJECT_TOO_LARGE', message: 'Object exceeds the read limit' } });
      return;
    }
    if (error instanceof z.ZodError || (error instanceof Error
      && ['REQUEST_TOO_LARGE', 'INVALID_OBJECT_IDENTITY'].includes(error.message))) {
      send(response, 400, { error: { code: 'INVALID_STORAGE_REQUEST', message: 'Storage request is invalid' } });
      return;
    }
    send(response, 502, { error: { code: 'STORAGE_UPSTREAM_FAILED', message: 'Storage operation failed' } });
  }
}

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(port, host);
