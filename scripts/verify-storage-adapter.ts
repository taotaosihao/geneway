import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { HttpObjectStorage, StorageObjectNotFoundError } from '@geneway/storage';

const baseUrl = process.env.GENEWAY_STORAGE_ADAPTER_URL;
const token = process.env.GENEWAY_STORAGE_ADAPTER_TOKEN;
const endpoint = process.env.GENEWAY_S3_ENDPOINT;
const bucket = process.env.GENEWAY_S3_BUCKET;
const oracleAccessKeyId = process.env.GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID;
const oracleSecretAccessKey = process.env.GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY;
const allowedPrefix = process.env.GENEWAY_STORAGE_ALLOWED_PREFIX;
if (baseUrl === undefined || token === undefined || endpoint === undefined || bucket === undefined
  || oracleAccessKeyId === undefined || oracleSecretAccessKey === undefined || allowedPrefix === undefined) {
  throw new Error('Online storage adapter verification environment is incomplete');
}

const region = process.env.GENEWAY_S3_REGION ?? 'us-east-1';
const oracle = new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId: oracleAccessKeyId, secretAccessKey: oracleSecretAccessKey },
});
const storage = new HttpObjectStorage({ baseUrl, token, bucket });
const objectId = `adapter-conformance-${randomUUID()}`;
const validKey = `${allowedPrefix}${objectId}/source.txt`;
const invalidHashKey = `${allowedPrefix}${objectId}/invalid-hash.txt`;
const bytes = new TextEncoder().encode('online-storage-adapter-conformance');
const contentSha256 = createHash('sha256').update(bytes).digest('hex');

async function withStartupRetry<T>(operation: string, action: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const message = error instanceof Error ? error.message : String(error);
      if (![403, 404].includes(status ?? 0) && !/STORAGE_UPSTREAM_FAILED|fetch failed/u.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${operation} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function rawPut(key: string, suppliedSha256 = contentSha256): Promise<Response> {
  return fetch(`${baseUrl}/v1/objects/put-create-only`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      key,
      bytesBase64: Buffer.from(bytes).toString('base64'),
      contentType: 'text/plain',
      contentSha256: suppliedSha256,
    }),
  });
}

async function expectMissing(key: string): Promise<void> {
  try {
    await oracle.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return;
    throw error;
  }
  throw new Error(`Rejected storage adapter request created an object: ${key}`);
}

let verificationFailure: unknown;
try {
  await withStartupRetry('online create-only put', () => storage.putCreateOnly({ key: validKey, bytes, contentType: 'text/plain', contentSha256 }));
  const observed = await withStartupRetry('online object get', () => storage.getBytes(validKey, 1_024));
  if (createHash('sha256').update(observed).digest('hex') !== contentSha256) {
    throw new Error('Online storage adapter changed object bytes');
  }

  const invalidKeys = [
    allowedPrefix,
    `${allowedPrefix}${objectId}//source.txt`,
    `${allowedPrefix}${objectId}/../source.txt`,
    `${allowedPrefix}${objectId}\\source.txt`,
    `${allowedPrefix}${objectId}/nul\0source.txt`,
    `tenants/tenant_other/artifacts/${objectId}/source.txt`,
  ];
  for (const key of invalidKeys) {
    const response = await rawPut(key);
    if (response.status !== 400) throw new Error(`Invalid key was not rejected by online adapter (${String(response.status)}): ${JSON.stringify(key)}`);
  }

  const hashMismatch = await rawPut(invalidHashKey, '0'.repeat(64));
  if (hashMismatch.status !== 400) throw new Error(`Hash mismatch was not rejected: ${String(hashMismatch.status)}`);
  await expectMissing(invalidHashKey);

  const wrongToken = await fetch(`${baseUrl}/v1/objects/head`, {
    method: 'POST',
    headers: { authorization: 'Bearer invalid-token-value-that-is-long-enough', 'content-type': 'application/json' },
    body: JSON.stringify({ key: validKey }),
  });
  if (wrongToken.status !== 404) throw new Error(`Online storage adapter exposed an authentication oracle: ${String(wrongToken.status)}`);
} catch (error) {
  verificationFailure = error;
}
await withStartupRetry('oracle object delete', () => oracle.send(new DeleteObjectCommand({ Bucket: bucket, Key: validKey })));
let cleanupConfirmed = false;
for (let attempt = 1; attempt <= 50 && !cleanupConfirmed; attempt += 1) {
  try {
    await storage.head(validKey);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) cleanupConfirmed = true;
    else if (error instanceof Error && /STORAGE_UPSTREAM_FAILED|fetch failed/u.test(error.message)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else throw error;
  }
}
if (!cleanupConfirmed) throw new Error('Oracle cleanup did not remove the online adapter conformance object');
if (verificationFailure instanceof Error) throw verificationFailure;
if (verificationFailure !== undefined) throw new Error('Online storage adapter verification failed with a non-Error value');
