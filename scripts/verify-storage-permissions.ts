import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3ObjectStorage, StorageObjectAlreadyExistsError } from '@geneway/storage';

const endpoint = process.env.GENEWAY_S3_ENDPOINT;
const bucket = process.env.GENEWAY_S3_BUCKET;
const appAccessKeyId = process.env.GENEWAY_S3_APP_ACCESS_KEY_ID;
const appSecretAccessKey = process.env.GENEWAY_S3_APP_SECRET_ACCESS_KEY;
const oracleAccessKeyId = process.env.GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID;
const oracleSecretAccessKey = process.env.GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY;
if (endpoint === undefined || bucket === undefined || appAccessKeyId === undefined || appSecretAccessKey === undefined
  || oracleAccessKeyId === undefined || oracleSecretAccessKey === undefined) {
  throw new Error('Storage permission verification environment is incomplete');
}

const region = process.env.GENEWAY_S3_REGION ?? 'us-east-1';
const appClient = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId: appAccessKeyId, secretAccessKey: appSecretAccessKey } });
const oracleClient = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId: oracleAccessKeyId, secretAccessKey: oracleSecretAccessKey } });
const storage = new S3ObjectStorage({ endpoint, region, bucket, accessKeyId: appAccessKeyId, secretAccessKey: appSecretAccessKey });
const key = `tenants/tenant_local/artifacts/conformance-${randomUUID()}/source.txt`;
const bytes = new TextEncoder().encode('create-only-conformance');
const hash = '27522e0d93368bdb5d11d0ebc1997c8a85fa6047991caffb4de5f2759c2e46d3';

async function expectDenied(operation: () => Promise<unknown>, name: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const candidate = error as Error & Readonly<{ $metadata?: Readonly<{ httpStatusCode?: number }> }>;
    if (candidate.$metadata?.httpStatusCode === 403 || candidate.name === 'AccessDenied') return;
    throw error;
  }
  throw new Error(`${name} unexpectedly succeeded for the online storage identity`);
}

try {
  await storage.putCreateOnly({ key, bytes, contentType: 'text/plain', contentSha256: hash });
  const head = await storage.head(key);
  const read = await storage.getBytes(key, 1_024);
  if (head.contentSha256 !== hash || Buffer.compare(Buffer.from(read), Buffer.from(bytes)) !== 0) {
    throw new Error('Online storage identity did not preserve the conformance bytes');
  }
  try {
    await storage.putCreateOnly({ key, bytes: new TextEncoder().encode('replacement'), contentType: 'text/plain', contentSha256: '0'.repeat(64) });
    throw new Error('Second create-only put unexpectedly succeeded');
  } catch (error) {
    if (!(error instanceof StorageObjectAlreadyExistsError)) throw error;
  }
  await expectDenied(() => appClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })), 'delete');
  await expectDenied(() => appClient.send(new ListObjectsV2Command({ Bucket: bucket })), 'list');
  await expectDenied(() => appClient.send(new CreateBucketCommand({ Bucket: `${bucket}-forbidden` })), 'create bucket');
  await expectDenied(() => appClient.send(new PutObjectCommand({ Bucket: bucket, Key: `tenants/tenant_other/artifacts/${randomUUID()}/source.txt`, Body: 'forbidden' })), 'cross-prefix put');
} finally {
  await oracleClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
