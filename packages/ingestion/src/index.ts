import { createHash } from 'node:crypto';
import { GenewayError } from '@geneway/contracts';

export { parseSingleMultipartUpload, type SingleMultipartUpload } from './multipart.js';
export {
  GateAPlainTextParserSandbox,
  type GateAParsedCanonicalText,
  type GateAParserCommandRunner,
  type GateAParserProcessReceipt,
} from './gate-a-parser-sandbox.js';
export {
  GateADocumentParserSandboxCandidate,
  inspectGateADocumentParserAuthority,
  gateADocumentFormats,
  type GateACanonicalPageCandidate,
  type GateACanonicalPageIndexCandidate,
  type GateADocumentExtension,
  type GateADocumentExtractionVersion,
  type GateADocumentMediaType,
  type GateADocumentParserCommandRunner,
  type GateADocumentParserApprovalCandidate,
  type GateADocumentParserApprovalMetadata,
  type GateADocumentParserAuthorityInspection,
  type GateADocumentParserManifestCandidate,
  type GateAParsedDocumentCandidate,
  type GateAParserStartupApproval,
} from './gate-a-document-parser-sandbox.js';

export const MAX_RAW_UPLOAD_BYTES = 1_048_576;
export const MAX_MULTIPART_ENVELOPE_BYTES = 1_114_112;
export const PROFILE_REGISTRY_VERSION = 'gate0.2a-profile-registry/1' as const;
export const SOLUTION_ANALYSIS_PROFILE = 'solution-analysis-demo/v2' as const;
export const SOLUTION_ANALYSIS_DEMO_SHA256 = '3b5ee113e79ab2afb504898cf962da10f7d31e62ddb89370e645c2d32f48ca06' as const;

export type SupportedMediaType = 'text/plain' | 'text/markdown';
export type SupportedExtension = 'txt' | 'md';

export type ValidatedTextUpload = Readonly<{
  bytes: Uint8Array;
  displayName: string;
  mediaType: SupportedMediaType;
  extension: SupportedExtension;
  sizeBytes: number;
  contentSha256: string;
  text: string;
  simulationProfile: typeof SOLUTION_ANALYSIS_PROFILE | null;
  profileRegistryVersion: typeof PROFILE_REGISTRY_VERSION;
}>;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const absoluteWindowsPath = /^(?:[a-zA-Z]:[\\/]|\\\\)/u;

const codePoints = (value: string): number[] => [...value].map((character) => character.codePointAt(0) ?? 0);
const hasForbiddenFilenameCharacter = (value: string): boolean => codePoints(value).some((point) =>
  point <= 0x1f || (point >= 0x7f && point <= 0x9f) || point === 0x061c || point === 0x200e || point === 0x200f
  || (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069));
const hasForbiddenTextControl = (value: string): boolean => codePoints(value).some((point) =>
  (point <= 0x1f && point !== 0x09 && point !== 0x0a && point !== 0x0d) || (point >= 0x7f && point <= 0x9f));

const binaryMagic: readonly Uint8Array[] = [
  Uint8Array.of(0x25, 0x50, 0x44, 0x46),
  Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
  Uint8Array.of(0xff, 0xd8, 0xff),
  Uint8Array.of(0x47, 0x49, 0x46, 0x38),
  Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
  Uint8Array.of(0x7f, 0x45, 0x4c, 0x46),
  Uint8Array.of(0x4d, 0x5a),
  Uint8Array.of(0x1f, 0x8b),
];

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function validateFileName(input: string): Readonly<{ displayName: string; extension: SupportedExtension }> {
  const displayName = input.normalize('NFC');
  const scalarLength = [...displayName].length;
  if (scalarLength === 0 || scalarLength > 120) {
    throw new GenewayError('INVALID_FILE_NAME', 'File name must contain between 1 and 120 Unicode characters', 400);
  }
  if (hasForbiddenFilenameCharacter(displayName) || displayName.includes('/') || displayName.includes('\\') || displayName.includes('..')
    || displayName.startsWith('.') || displayName.startsWith('/') || absoluteWindowsPath.test(displayName)) {
    throw new GenewayError('INVALID_FILE_NAME', 'File name contains a path or unsafe control characters', 400);
  }
  const lower = displayName.toLowerCase();
  if (lower.endsWith('.txt')) return { displayName, extension: 'txt' };
  if (lower.endsWith('.md')) return { displayName, extension: 'md' };
  throw new GenewayError('UNSUPPORTED_FILE_TYPE', 'Only .txt and .md files are supported', 415);
}

function validateMediaType(extension: SupportedExtension, input: string): SupportedMediaType {
  if (extension === 'txt' && input === 'text/plain') return input;
  if (extension === 'md' && input === 'text/markdown') return input;
  throw new GenewayError('FILE_TYPE_MISMATCH', 'File extension and media type must match exactly', 415);
}

export function validateTextUpload(input: Readonly<{ fileName: string; mediaType: string; bytes: Uint8Array }>): ValidatedTextUpload {
  const sizeBytes = input.bytes.byteLength;
  if (sizeBytes === 0) throw new GenewayError('EMPTY_UPLOAD', 'Uploaded text file must not be empty', 400);
  if (sizeBytes > MAX_RAW_UPLOAD_BYTES) throw new GenewayError('UPLOAD_TOO_LARGE', 'Uploaded file exceeds 1 MiB', 413);
  const { displayName, extension } = validateFileName(input.fileName);
  const mediaType = validateMediaType(extension, input.mediaType);
  if (input.bytes[0] === 0xef && input.bytes[1] === 0xbb && input.bytes[2] === 0xbf) {
    throw new GenewayError('UTF8_BOM_NOT_ALLOWED', 'UTF-8 BOM is not allowed', 400);
  }
  if (input.bytes.some((value) => value === 0) || binaryMagic.some((magic) => startsWith(input.bytes, magic))) {
    throw new GenewayError('BINARY_CONTENT_NOT_ALLOWED', 'Uploaded content is not plain UTF-8 text', 415);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    throw new GenewayError('INVALID_UTF8', 'Uploaded content must be valid UTF-8', 400);
  }
  if (hasForbiddenTextControl(text)) {
    throw new GenewayError('CONTROL_CHARACTER_NOT_ALLOWED', 'Uploaded text contains unsupported control characters', 400);
  }
  const contentSha256 = sha256(input.bytes);
  return {
    bytes: input.bytes,
    displayName,
    mediaType,
    extension,
    sizeBytes,
    contentSha256,
    text,
    simulationProfile: contentSha256 === SOLUTION_ANALYSIS_DEMO_SHA256 ? SOLUTION_ANALYSIS_PROFILE : null,
    profileRegistryVersion: PROFILE_REGISTRY_VERSION,
  };
}
