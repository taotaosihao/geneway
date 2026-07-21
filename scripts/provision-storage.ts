import { CreateBucketCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';

const endpoint = process.env.GENEWAY_S3_ENDPOINT;
const bucket = process.env.GENEWAY_S3_BUCKET;
const accessKeyId = process.env.GENEWAY_S3_ADMIN_ACCESS_KEY_ID;
const secretAccessKey = process.env.GENEWAY_S3_ADMIN_SECRET_ACCESS_KEY;
const appAccessKeyId = process.env.GENEWAY_S3_APP_ACCESS_KEY_ID;
const tamperAccessKeyId = process.env.GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID;
if (endpoint === undefined || bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined
  || appAccessKeyId === undefined || tamperAccessKeyId === undefined) {
  throw new Error('GENEWAY S3 provisioning environment is incomplete');
}

const client = new S3Client({
  endpoint,
  region: process.env.GENEWAY_S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 5,
});

try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
} catch (error) {
  const candidate = error as Error & Readonly<{ name?: string; $metadata?: Readonly<{ httpStatusCode?: number }> }>;
  if (candidate.name !== 'BucketAlreadyOwnedByYou' && candidate.name !== 'BucketAlreadyExists' && candidate.$metadata?.httpStatusCode !== 409) throw error;
}

await client.send(new PutBucketPolicyCommand({
  Bucket: bucket,
  Policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'GenewayOnlineArtifactObjectAccess',
        Effect: 'Allow',
        Principal: { AWS: appAccessKeyId },
        Action: ['s3:PutObject', 's3:GetObject'],
        Resource: `arn:aws:s3:::${bucket}/tenants/tenant_local/artifacts/*`,
      },
      {
        Sid: 'GenewayTestOracleArtifactAccess',
        Effect: 'Allow',
        Principal: { AWS: tamperAccessKeyId },
        Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        Resource: `arn:aws:s3:::${bucket}/tenants/tenant_local/artifacts/*`,
      },
    ],
  }),
}));
