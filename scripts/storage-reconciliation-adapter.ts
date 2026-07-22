import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  S3ObjectReconciliationStorage,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  isCanonicalArtifactObjectKey,
} from '@geneway/storage';

const port = Number(process.env.GENEWAY_RECONCILIATION_ADAPTER_PORT ?? 57072);
const host = process.env.GENEWAY_RECONCILIATION_ADAPTER_HOST ?? '127.0.0.1';
const token = process.env.GENEWAY_RECONCILIATION_ADAPTER_TOKEN;
const endpoint = process.env.GENEWAY_S3_ENDPOINT;
const bucket = process.env.GENEWAY_S3_BUCKET;
const accessKeyId = process.env.GENEWAY_S3_RECONCILER_ACCESS_KEY_ID;
const secretAccessKey = process.env.GENEWAY_S3_RECONCILER_SECRET_ACCESS_KEY;
const allowedPrefix = process.env.GENEWAY_STORAGE_ALLOWED_PREFIX;

if (!Number.isInteger(port) || port < 1 || port > 65_535 || !['127.0.0.1', '0.0.0.0'].includes(host)
  || token === undefined || token.length < 24 || endpoint === undefined || bucket === undefined
  || accessKeyId === undefined || secretAccessKey === undefined || allowedPrefix === undefined) {
  throw new Error('Storage reconciliation adapter environment is incomplete');
}
const authorizationToken: string = token;

const storage = new S3ObjectReconciliationStorage({
  endpoint,
  region: process.env.GENEWAY_S3_REGION ?? 'us-east-1',
  bucket,
  accessKeyId,
  secretAccessKey,
  allowedPrefix,
});
const objectKeySchema = z.string().min(1).max(512).refine(
  (value) => isCanonicalArtifactObjectKey(value, allowedPrefix),
  'Key is outside the allowed prefix',
);
const keyRequestSchema = z.object({ key: objectKeySchema }).strict();
const getSchema = keyRequestSchema.extend({ maximumBytes: z.number().int().nonnegative().max(1_048_576) }).strict();
const listSchema = z.object({ prefix: z.literal(allowedPrefix) }).strict();

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
    if (length > 16_384) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(bytes.byteLength),
    'cache-control': 'no-store',
  });
  response.end(bytes);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET' && request.url === '/health') {
    send(response, 200, { ok: true, service: 'geneway-storage-reconciliation-adapter' });
    return;
  }
  if (request.method !== 'POST' || !authorized(request) || request.headers.origin !== undefined) {
    send(response, 404, { error: { code: 'NOT_FOUND', message: 'Route was not found' } });
    return;
  }
  try {
    const body = await readJson(request);
    if (request.url === '/v1/reconciliation/head') {
      const input = keyRequestSchema.parse(body);
      send(response, 200, await storage.head(input.key));
      return;
    }
    if (request.url === '/v1/reconciliation/get') {
      const input = getSchema.parse(body);
      const bytes = await storage.getBytes(input.key, input.maximumBytes);
      send(response, 200, { bytesBase64: Buffer.from(bytes).toString('base64') });
      return;
    }
    if (request.url === '/v1/reconciliation/list') {
      const input = listSchema.parse(body);
      send(response, 200, { items: await storage.listPrefix(input.prefix) });
      return;
    }
    if (request.url === '/v1/reconciliation/delete') {
      const input = keyRequestSchema.parse(body);
      await storage.delete(input.key);
      send(response, 200, { deleted: true });
      return;
    }
    send(response, 404, { error: { code: 'NOT_FOUND', message: 'Route was not found' } });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      send(response, 404, { error: { code: 'STORAGE_OBJECT_NOT_FOUND', message: 'Object was not found' } });
      return;
    }
    if (error instanceof StorageObjectTooLargeError) {
      send(response, 413, { error: { code: 'STORAGE_OBJECT_TOO_LARGE', message: 'Object exceeds the read limit' } });
      return;
    }
    if (error instanceof z.ZodError) {
      send(response, 403, { error: { code: 'STORAGE_SCOPE_DENIED', message: 'Storage scope is denied' } });
      return;
    }
    send(response, 502, { error: { code: 'STORAGE_UPSTREAM_FAILED', message: 'Storage operation failed' } });
  }
}

const server = createServer((request, response) => { void handle(request, response); });
server.listen(port, host);
