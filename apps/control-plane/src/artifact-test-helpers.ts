import { randomUUID } from 'node:crypto';

export type MultipartPart = Readonly<{
  fieldName: string;
  fileName?: string;
  mediaType?: string;
  bytes: Uint8Array;
}>;

export function multipartPayload(parts: readonly MultipartPart[], boundary = `geneway-${randomUUID()}`): Readonly<{ boundary: string; body: Buffer }> {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if (part.fileName === undefined) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.fieldName}"\r\n\r\n`, 'utf8'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.fieldName}"; filename="${part.fileName}"\r\n`, 'utf8'));
      chunks.push(Buffer.from(`Content-Type: ${part.mediaType ?? 'application/octet-stream'}\r\n\r\n`, 'utf8'));
    }
    chunks.push(Buffer.from(part.bytes));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}
