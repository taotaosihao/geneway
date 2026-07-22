import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

const ARTIFACT_PREFIX_PATTERN = /^tenants\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/artifacts\/$/u;

export function isCanonicalArtifactPrefix(prefix: string): boolean {
  return ARTIFACT_PREFIX_PATTERN.test(prefix);
}

export function isCanonicalArtifactObjectKey(key: string, allowedPrefix: string): boolean {
  if (!isCanonicalArtifactPrefix(allowedPrefix) || key === allowedPrefix || !key.startsWith(allowedPrefix)
    || key.length > 512 || key.includes('..') || key.includes('\\') || key.includes('\0') || key.includes('//')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(key.slice(allowedPrefix.length));
}

export type StoredObjectHead = Readonly<{
  sizeBytes: number;
  contentType: string | null;
  contentSha256: string | null;
  eTag: string | null;
  versionId: string | null;
}>;

export type CreateObjectResult = Readonly<{ eTag: string | null; versionId: string | null }>;

export interface ObjectStorage {
  readonly bucket: string;
  putCreateOnly(input: Readonly<{ key: string; bytes: Uint8Array; contentType: string; contentSha256: string }>): Promise<CreateObjectResult>;
  head(key: string): Promise<StoredObjectHead>;
  getBytes(key: string, maximumBytes: number): Promise<Uint8Array>;
}

export type StoredObjectInventoryItem = Readonly<{
  key: string;
  sizeBytes: number;
  eTag: string | null;
}>;

/**
 * Administrative recovery authority. This port is intentionally separate from
 * ObjectStorage so the online Control Plane and Worker cannot list or delete.
 */
export interface ObjectReconciliationStorage {
  readonly bucket: string;
  head(key: string): Promise<StoredObjectHead>;
  getBytes(key: string, maximumBytes: number): Promise<Uint8Array>;
  listPrefix(prefix: string): Promise<readonly StoredObjectInventoryItem[]>;
  delete(key: string): Promise<void>;
}

export class StorageObjectAlreadyExistsError extends Error {
  constructor(readonly key: string) {
    super(`Storage object already exists: ${key}`);
    this.name = 'StorageObjectAlreadyExistsError';
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Storage object was not found: ${key}`);
    this.name = 'StorageObjectNotFoundError';
  }
}

export class StorageObjectTooLargeError extends Error {
  constructor(readonly key: string, readonly maximumBytes: number) {
    super(`Storage object exceeds the read limit: ${key}`);
    this.name = 'StorageObjectTooLargeError';
  }
}

type AwsLikeError = Error & Readonly<{ name: string; $metadata?: Readonly<{ httpStatusCode?: number }> }>;

function asAwsError(error: unknown): AwsLikeError | null {
  if (!(error instanceof Error)) return null;
  return error;
}

function isAlreadyExists(error: unknown): boolean {
  const aws = asAwsError(error);
  return aws?.name === 'PreconditionFailed' || aws?.name === 'ConditionalRequestConflict'
    || aws?.$metadata?.httpStatusCode === 412 || aws?.$metadata?.httpStatusCode === 409;
}

function isNotFound(error: unknown): boolean {
  const aws = asAwsError(error);
  return aws?.name === 'NoSuchKey' || aws?.name === 'NotFound' || aws?.$metadata?.httpStatusCode === 404;
}

export type S3ObjectStorageOptions = Readonly<{
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}>;

export type S3ObjectReconciliationStorageOptions = S3ObjectStorageOptions & Readonly<{ allowedPrefix: string }>;

export class S3ObjectStorage implements ObjectStorage {
  readonly bucket: string;
  readonly #client: S3Client;

  constructor(options: S3ObjectStorageOptions) {
    this.bucket = options.bucket;
    const config: S3ClientConfig = {
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      maxAttempts: 2,
    };
    this.#client = new S3Client(config);
  }

  async putCreateOnly(input: Readonly<{ key: string; bytes: Uint8Array; contentType: string; contentSha256: string }>): Promise<CreateObjectResult> {
    try {
      const response = await this.#client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: input.contentType,
        Metadata: { 'content-sha256': input.contentSha256 },
        IfNoneMatch: '*',
      }));
      return { eTag: response.ETag ?? null, versionId: response.VersionId ?? null };
    } catch (error) {
      if (isAlreadyExists(error)) throw new StorageObjectAlreadyExistsError(input.key);
      throw error;
    }
  }

  async head(key: string): Promise<StoredObjectHead> {
    try {
      const response = await this.#client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (response.ContentLength === undefined || !Number.isSafeInteger(response.ContentLength) || response.ContentLength < 0) {
        throw new Error(`Storage returned an invalid content length for ${key}`);
      }
      return {
        sizeBytes: response.ContentLength,
        contentType: response.ContentType ?? null,
        contentSha256: response.Metadata?.['content-sha256'] ?? null,
        eTag: response.ETag ?? null,
        versionId: response.VersionId ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) throw new StorageObjectNotFoundError(key);
      throw error;
    }
  }

  async getBytes(key: string, maximumBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new TypeError('maximumBytes must be a non-negative safe integer');
    try {
      const response = await this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = response.Body;
      if (body === undefined) throw new Error(`Storage returned an empty response body for ${key}`);
      const iterable = body as unknown as AsyncIterable<Uint8Array>;
      if (typeof iterable[Symbol.asyncIterator] !== 'function') throw new Error(`Storage returned a non-streaming response body for ${key}`);
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of iterable) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        length += bytes.byteLength;
        if (length > maximumBytes) throw new StorageObjectTooLargeError(key, maximumBytes);
        chunks.push(bytes);
      }
      const combined = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return combined;
    } catch (error) {
      if (isNotFound(error)) throw new StorageObjectNotFoundError(key);
      throw error;
    }
  }
}

export class S3ObjectReconciliationStorage implements ObjectReconciliationStorage {
  readonly bucket: string;
  readonly #readStorage: S3ObjectStorage;
  readonly #reconciliationClient: S3Client;
  readonly #allowedPrefix: string;

  constructor(options: S3ObjectReconciliationStorageOptions) {
    if (!isCanonicalArtifactPrefix(options.allowedPrefix)) {
      throw new TypeError('Reconciliation storage prefix is invalid');
    }
    this.bucket = options.bucket;
    this.#readStorage = new S3ObjectStorage(options);
    this.#allowedPrefix = options.allowedPrefix;
    this.#reconciliationClient = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      maxAttempts: 2,
    });
  }

  async head(key: string): Promise<StoredObjectHead> {
    this.#assertAllowedKey(key);
    return this.#readStorage.head(key);
  }

  async getBytes(key: string, maximumBytes: number): Promise<Uint8Array> {
    this.#assertAllowedKey(key);
    return this.#readStorage.getBytes(key, maximumBytes);
  }

  async listPrefix(prefix: string): Promise<readonly StoredObjectInventoryItem[]> {
    if (prefix !== this.#allowedPrefix) throw new TypeError('Reconciliation inventory must use the exact allowed prefix');
    const inventory: StoredObjectInventoryItem[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.#reconciliationClient.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      for (const item of page.Contents ?? []) {
        if (item.Key === undefined || item.Size === undefined || !Number.isSafeInteger(item.Size) || item.Size < 0) {
          throw new Error('Storage inventory returned an invalid object');
        }
        this.#assertAllowedKey(item.Key);
        inventory.push({ key: item.Key, sizeBytes: item.Size, eTag: item.ETag ?? null });
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      if (page.IsTruncated === true && continuationToken === undefined) {
        throw new Error('Storage inventory omitted its continuation token');
      }
    } while (continuationToken !== undefined);
    return inventory;
  }

  async delete(key: string): Promise<void> {
    this.#assertAllowedKey(key);
    await this.#reconciliationClient.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }


  #assertAllowedKey(key: string): void {
    if (!isCanonicalArtifactObjectKey(key, this.#allowedPrefix)) {
      throw new TypeError('Reconciliation key is outside the allowed prefix');
    }
  }
}

type AdapterErrorPayload = Readonly<{ error?: Readonly<{ code?: string; message?: string }> }>;

export class HttpObjectStorage implements ObjectStorage {
  readonly bucket: string;
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(options: Readonly<{ baseUrl: string; token: string; bucket: string }>) {
    this.#baseUrl = options.baseUrl.replace(/\/$/u, '');
    this.#token = options.token;
    this.bucket = options.bucket;
  }

  async putCreateOnly(input: Readonly<{ key: string; bytes: Uint8Array; contentType: string; contentSha256: string }>): Promise<CreateObjectResult> {
    return this.request<CreateObjectResult>('/v1/objects/put-create-only', {
      key: input.key,
      bytesBase64: Buffer.from(input.bytes).toString('base64'),
      contentType: input.contentType,
      contentSha256: input.contentSha256,
    }, input.key);
  }

  async head(key: string): Promise<StoredObjectHead> {
    return this.request<StoredObjectHead>('/v1/objects/head', { key }, key);
  }

  async getBytes(key: string, maximumBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new TypeError('maximumBytes must be a non-negative safe integer');
    const response = await this.request<Readonly<{ bytesBase64: string }>>('/v1/objects/get', { key, maximumBytes }, key);
    const bytes = new Uint8Array(Buffer.from(response.bytesBase64, 'base64'));
    if (bytes.byteLength > maximumBytes) throw new StorageObjectTooLargeError(key, maximumBytes);
    return bytes;
  }

  private async request<T>(path: string, body: Readonly<Record<string, unknown>>, key: string): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as T & AdapterErrorPayload;
    if (response.ok) return payload;
    const code = payload.error?.code;
    if (code === 'STORAGE_OBJECT_ALREADY_EXISTS') throw new StorageObjectAlreadyExistsError(key);
    if (code === 'STORAGE_OBJECT_NOT_FOUND') throw new StorageObjectNotFoundError(key);
    if (code === 'STORAGE_OBJECT_TOO_LARGE') throw new StorageObjectTooLargeError(key, Number(body.maximumBytes ?? 0));
    throw new Error(`Storage adapter request failed: ${code ?? String(response.status)}`);
  }
}

/** Client for the separately authenticated reconciliation adapter. Raw S3
 * reconciliation credentials remain inside that adapter process. */
export class HttpObjectReconciliationStorage implements ObjectReconciliationStorage {
  readonly bucket: string;
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #allowedPrefix: string;

  constructor(options: Readonly<{ baseUrl: string; token: string; bucket: string; allowedPrefix: string }>) {
    if (!isCanonicalArtifactPrefix(options.allowedPrefix)) {
      throw new TypeError('Reconciliation storage prefix is invalid');
    }
    this.#baseUrl = options.baseUrl.replace(/\/$/u, '');
    this.#token = options.token;
    this.bucket = options.bucket;
    this.#allowedPrefix = options.allowedPrefix;
  }

  async head(key: string): Promise<StoredObjectHead> {
    this.#assertKey(key);
    return this.#request<StoredObjectHead>('/v1/reconciliation/head', { key }, key);
  }

  async getBytes(key: string, maximumBytes: number): Promise<Uint8Array> {
    this.#assertKey(key);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new TypeError('maximumBytes must be a non-negative safe integer');
    const response = await this.#request<Readonly<{ bytesBase64: string }>>(
      '/v1/reconciliation/get', { key, maximumBytes }, key,
    );
    const bytes = new Uint8Array(Buffer.from(response.bytesBase64, 'base64'));
    if (bytes.byteLength > maximumBytes) throw new StorageObjectTooLargeError(key, maximumBytes);
    return bytes;
  }

  async listPrefix(prefix: string): Promise<readonly StoredObjectInventoryItem[]> {
    if (prefix !== this.#allowedPrefix) throw new TypeError('Reconciliation inventory must use the exact allowed prefix');
    const response = await this.#request<unknown>(
      '/v1/reconciliation/list', { prefix }, prefix,
    );
    if (typeof response !== 'object' || response === null || !('items' in response)
      || !Array.isArray(response.items)) {
      throw new Error('Storage reconciliation adapter returned an invalid inventory');
    }
    return (response.items as readonly unknown[]).map((candidate) => {
      if (typeof candidate !== 'object' || candidate === null
        || !('key' in candidate) || !('sizeBytes' in candidate) || !('eTag' in candidate)
        || typeof candidate.key !== 'string' || typeof candidate.sizeBytes !== 'number'
        || !Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes < 0
        || (candidate.eTag !== null && typeof candidate.eTag !== 'string')) {
        throw new Error('Storage reconciliation adapter returned an invalid inventory item');
      }
      this.#assertKey(candidate.key);
      return { key: candidate.key, sizeBytes: candidate.sizeBytes, eTag: candidate.eTag };
    });
  }

  async delete(key: string): Promise<void> {
    this.#assertKey(key);
    await this.#request<Readonly<{ deleted: true }>>('/v1/reconciliation/delete', { key }, key);
  }

  #assertKey(key: string): void {
    if (!isCanonicalArtifactObjectKey(key, this.#allowedPrefix)) {
      throw new TypeError('Reconciliation key is outside the allowed prefix');
    }
  }

  async #request<T>(path: string, body: Readonly<Record<string, unknown>>, key: string): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as T & AdapterErrorPayload;
    if (response.ok) return payload;
    const code = payload.error?.code;
    if (code === 'STORAGE_OBJECT_NOT_FOUND') throw new StorageObjectNotFoundError(key);
    if (code === 'STORAGE_OBJECT_TOO_LARGE') throw new StorageObjectTooLargeError(key, Number(body.maximumBytes ?? 0));
    throw new Error(`Storage reconciliation adapter request failed: ${code ?? String(response.status)}`);
  }
}

export function createS3ObjectStorageFromEnv(environment: NodeJS.ProcessEnv = process.env): S3ObjectStorage | null {
  const endpoint = environment.GENEWAY_S3_ENDPOINT;
  const bucket = environment.GENEWAY_S3_BUCKET;
  const accessKeyId = environment.GENEWAY_S3_ACCESS_KEY_ID;
  const secretAccessKey = environment.GENEWAY_S3_SECRET_ACCESS_KEY;
  if (endpoint === undefined && bucket === undefined && accessKeyId === undefined && secretAccessKey === undefined) return null;
  if (endpoint === undefined || bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error('GENEWAY S3 configuration is incomplete');
  }
  return new S3ObjectStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: environment.GENEWAY_S3_REGION ?? 'us-east-1',
    forcePathStyle: environment.GENEWAY_S3_FORCE_PATH_STYLE !== 'false',
  });
}

export function createObjectStorageFromEnv(environment: NodeJS.ProcessEnv = process.env): ObjectStorage | null {
  const adapterUrl = environment.GENEWAY_STORAGE_ADAPTER_URL;
  const adapterToken = environment.GENEWAY_STORAGE_ADAPTER_TOKEN;
  const bucket = environment.GENEWAY_S3_BUCKET;
  if (adapterUrl !== undefined || adapterToken !== undefined) {
    if (adapterUrl === undefined || adapterToken === undefined || bucket === undefined) {
      throw new Error('GENEWAY storage adapter configuration is incomplete');
    }
    return new HttpObjectStorage({ baseUrl: adapterUrl, token: adapterToken, bucket });
  }
  if (environment.GENEWAY_S3_ENDPOINT !== undefined || environment.GENEWAY_S3_ACCESS_KEY_ID !== undefined
    || environment.GENEWAY_S3_SECRET_ACCESS_KEY !== undefined) {
    throw new Error('Direct S3 credentials are forbidden in the Control Plane; configure the storage adapter');
  }
  return null;
}
