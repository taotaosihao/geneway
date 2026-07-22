import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { HttpObjectReconciliationStorage, StorageObjectNotFoundError } from '@geneway/storage';

const baseUrl = process.env.GENEWAY_RECONCILIATION_ADAPTER_URL;
const token = process.env.GENEWAY_RECONCILIATION_ADAPTER_TOKEN;
const endpoint = process.env.GENEWAY_S3_ENDPOINT;
const bucket = process.env.GENEWAY_S3_BUCKET;
const oracleAccessKeyId = process.env.GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID;
const oracleSecretAccessKey = process.env.GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY;
const allowedPrefix = process.env.GENEWAY_STORAGE_ALLOWED_PREFIX;
if (baseUrl === undefined || token === undefined || endpoint === undefined || bucket === undefined
  || oracleAccessKeyId === undefined || oracleSecretAccessKey === undefined || allowedPrefix === undefined) {
  throw new Error('Reconciliation adapter verification environment is incomplete');
}

const region = process.env.GENEWAY_S3_REGION ?? 'us-east-1';
const oracle = new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId: oracleAccessKeyId, secretAccessKey: oracleSecretAccessKey },
});
const storage = new HttpObjectReconciliationStorage({ baseUrl, token, bucket, allowedPrefix });
const key = `${allowedPrefix}adapter-conformance-${randomUUID()}/source.txt`;
const bytes = new TextEncoder().encode('reconciliation-adapter-conformance');
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

await withStartupRetry('oracle object put', () => oracle.send(new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  Body: bytes,
  ContentType: 'text/plain',
  Metadata: { 'content-sha256': contentSha256 },
})));

const inventory = await withStartupRetry('reconciliation inventory', () => storage.listPrefix(allowedPrefix));
if (!inventory.some((item) => item.key === key)) throw new Error('Reconciliation adapter omitted an in-scope object');
const head = await withStartupRetry('reconciliation object head', () => storage.head(key));
const observed = await withStartupRetry('reconciliation object get', () => storage.getBytes(key, 1_024));
if (head.sizeBytes !== bytes.byteLength || head.contentSha256 !== contentSha256
  || createHash('sha256').update(observed).digest('hex') !== contentSha256
  || Buffer.compare(Buffer.from(observed), Buffer.from(bytes)) !== 0) {
  throw new Error('Reconciliation adapter changed object identity');
}

const crossPrefix = await fetch(`${baseUrl}/v1/reconciliation/list`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ prefix: 'tenants/tenant_other/artifacts/' }),
});
if (crossPrefix.status !== 403) throw new Error(`Reconciliation adapter cross-prefix request was not denied: ${String(crossPrefix.status)}`);

for (const route of ['head', 'get', 'delete']) {
  const response = await fetch(`${baseUrl}/v1/reconciliation/${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(route === 'get'
      ? { key: 'tenants/tenant_other/artifacts/secret', maximumBytes: 128 }
      : { key: 'tenants/tenant_other/artifacts/secret' }),
  });
  if (response.status !== 403) throw new Error(`Reconciliation adapter cross-prefix ${route} was not denied: ${String(response.status)}`);
}

const wrongToken = await fetch(`${baseUrl}/v1/reconciliation/list`, {
  method: 'POST',
  headers: { authorization: 'Bearer invalid-token-value-that-is-long-enough', 'content-type': 'application/json' },
  body: JSON.stringify({ prefix: allowedPrefix }),
});
if (wrongToken.status !== 404) throw new Error(`Reconciliation adapter exposed an authentication oracle: ${String(wrongToken.status)}`);

await withStartupRetry('reconciliation object delete', () => storage.delete(key));
let deleteConfirmed = false;
for (let attempt = 1; attempt <= 50 && !deleteConfirmed; attempt += 1) {
  try {
    await storage.head(key);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) deleteConfirmed = true;
    else if (error instanceof Error && /STORAGE_UPSTREAM_FAILED|fetch failed/u.test(error.message)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else throw error;
  }
}
if (!deleteConfirmed) throw new Error('Reconciliation adapter delete was not effective');
