import { Transform, type Readable } from 'node:stream';
import { Busboy, type BusboyFileStream, type BusboyHeaders } from '@fastify/busboy';
import { GenewayError } from '@geneway/contracts';

export type SingleMultipartUpload = Readonly<{
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}>;

const invalidMultipart = (): GenewayError => new GenewayError(
  'INVALID_MULTIPART_UPLOAD',
  'Upload must contain exactly one file part named file and no fields',
  400,
);

export async function parseSingleMultipartUpload(input: Readonly<{
  stream: Readable;
  headers: BusboyHeaders;
  maximumEnvelopeBytes: number;
  maximumFileBytes: number;
}>): Promise<SingleMultipartUpload> {
  const declaredLength = input.headers['content-length'];
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidMultipart();
    if (parsed > input.maximumEnvelopeBytes) {
      throw new GenewayError('UPLOAD_ENVELOPE_TOO_LARGE', 'Multipart request exceeds the maximum envelope size', 413);
    }
  }

  return new Promise<SingleMultipartUpload>((resolve, reject) => {
    let settled = false;
    let receivedEnvelopeBytes = 0;
    let fileSeen = false;
    let fileEnded = false;
    let fileName = '';
    let mediaType = '';
    let chunks: Uint8Array[] = [];
    let fileBytes = 0;
    const busboy = Busboy({
      headers: input.headers,
      preservePath: true,
      limits: {
        files: 1,
        fields: 0,
        parts: 1,
        fileSize: input.maximumFileBytes,
        fieldNameSize: 32,
        headerPairs: 32,
        headerSize: 8_192,
      },
    });
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedEnvelopeBytes += chunk.byteLength;
        if (receivedEnvelopeBytes > input.maximumEnvelopeBytes) {
          callback(new GenewayError('UPLOAD_ENVELOPE_TOO_LARGE', 'Multipart request exceeds the maximum envelope size', 413));
          return;
        }
        callback(null, chunk);
      },
    });

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      input.stream.unpipe(limiter);
      input.stream.resume();
      limiter.unpipe(busboy);
      limiter.destroy();
      busboy.destroy();
      reject(error instanceof Error ? error : invalidMultipart());
    };

    limiter.once('error', fail);
    busboy.once('error', fail);
    busboy.once('partsLimit', () => fail(invalidMultipart()));
    busboy.once('filesLimit', () => fail(invalidMultipart()));
    busboy.once('fieldsLimit', () => fail(invalidMultipart()));
    busboy.on('field', () => fail(invalidMultipart()));
    busboy.on('file', (fieldName: string, file: BusboyFileStream, incomingName: string, _encoding: string, incomingMediaType: string) => {
      if (settled) {
        file.resume();
        return;
      }
      if (fileSeen || fieldName !== 'file') {
        file.resume();
        fail(invalidMultipart());
        return;
      }
      fileSeen = true;
      fileName = incomingName;
      mediaType = incomingMediaType;
      file.once('limit', () => fail(new GenewayError('UPLOAD_TOO_LARGE', 'Uploaded file exceeds 1 MiB', 413)));
      file.on('data', (chunk: Buffer) => {
        const bytes = new Uint8Array(chunk);
        fileBytes += bytes.byteLength;
        if (fileBytes > input.maximumFileBytes) {
          fail(new GenewayError('UPLOAD_TOO_LARGE', 'Uploaded file exceeds 1 MiB', 413));
          return;
        }
        chunks.push(bytes);
      });
      file.once('end', () => {
        if (file.truncated) {
          fail(new GenewayError('UPLOAD_TOO_LARGE', 'Uploaded file exceeds 1 MiB', 413));
          return;
        }
        fileEnded = true;
      });
      file.once('error', fail);
    });
    busboy.once('finish', () => {
      if (settled) return;
      if (!fileSeen || !fileEnded) {
        fail(new GenewayError('FILE_REQUIRED', 'Upload must contain one file part named file', 400));
        return;
      }
      settled = true;
      const bytes = new Uint8Array(fileBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      chunks = [];
      resolve({ fileName, mediaType, bytes });
    });

    input.stream.pipe(limiter).pipe(busboy);
  });
}
