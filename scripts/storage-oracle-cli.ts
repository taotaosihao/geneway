import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const [action, key] = process.argv.slice(2);
const endpoint = process.env.GENEWAY_S3_ENDPOINT;
const bucket = process.env.GENEWAY_S3_BUCKET;
const accessKeyId = process.env.GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID;
const secretAccessKey = process.env.GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY;
if (endpoint === undefined || bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined || key === undefined) {
  throw new Error('Storage oracle command environment or key is incomplete');
}
const client = new S3Client({
  endpoint,
  region: process.env.GENEWAY_S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

if (action === 'get') {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (result.Body === undefined) throw new Error('Storage oracle received an object without a body');
  process.stdout.write(`${JSON.stringify({
    bytesBase64: Buffer.from(await result.Body.transformToByteArray()).toString('base64'),
    contentSha256: result.Metadata?.['content-sha256'] ?? null,
  })}\n`);
} else if (action === 'delete') {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  process.stdout.write(`${JSON.stringify({ deleted: true })}\n`);
} else {
  throw new Error(`Unsupported storage oracle action: ${String(action)}`);
}
