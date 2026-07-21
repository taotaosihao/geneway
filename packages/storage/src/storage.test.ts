import { describe, expect, it } from 'vitest';
import { createObjectStorageFromEnv, createS3ObjectStorageFromEnv } from './index.js';

describe('S3 storage configuration', () => {
  it('stays disabled when no storage variables are supplied', () => {
    expect(createS3ObjectStorageFromEnv({})).toBeNull();
  });

  it('fails closed on partial credentials', () => {
    expect(() => createS3ObjectStorageFromEnv({ GENEWAY_S3_ENDPOINT: 'http://127.0.0.1:7070' })).toThrow(/incomplete/u);
  });

  it('never lets the Control Plane fall back to direct S3 credentials', () => {
    expect(createObjectStorageFromEnv({})).toBeNull();
    expect(() => createObjectStorageFromEnv({
      GENEWAY_S3_ENDPOINT: 'http://127.0.0.1:7070',
      GENEWAY_S3_BUCKET: 'bucket',
      GENEWAY_S3_ACCESS_KEY_ID: 'online',
      GENEWAY_S3_SECRET_ACCESS_KEY: 'secret',
    })).toThrow(/forbidden/u);
  });
});
