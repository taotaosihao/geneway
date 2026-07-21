import { describe, expect, it } from 'vitest';
import { GenewayError } from '@geneway/contracts';
import { MAX_RAW_UPLOAD_BYTES, SOLUTION_ANALYSIS_DEMO_SHA256, validateTextUpload } from './index.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const errorCode = (operation: () => unknown): string => {
  try {
    operation();
  } catch (error) {
    if (error instanceof GenewayError) return error.code;
    throw error;
  }
  throw new Error('Expected operation to fail');
};

describe('text upload validation', () => {
  it('accepts the exact gate fixture and recognizes its simulation profile', () => {
    const result = validateTextUpload({
      fileName: '制造执行方案.txt',
      mediaType: 'text/plain',
      bytes: encode('客户需要建设制造执行方案。\n系统需支持生产工单全过程跟踪，并对质量检验批次提供可追溯记录。\n本演示材料不要求直接控制设备。\n'),
    });
    expect(result).toMatchObject({
      sizeBytes: 180,
      contentSha256: SOLUTION_ANALYSIS_DEMO_SHA256,
      simulationProfile: 'solution-analysis-demo/v2',
      profileRegistryVersion: 'gate0.2a-profile-registry/1',
    });
  });

  it('enforces the exact extension and media type pair', () => {
    expect(errorCode(() => validateTextUpload({ fileName: 'a.md', mediaType: 'text/plain', bytes: encode('hello') })))
      .toBe('FILE_TYPE_MISMATCH');
  });

  it.each([
    ['../escape.txt', encode('hello')],
    ['a\u061cb.txt', encode('hello')],
    ['a\u200eb.txt', encode('hello')],
    ['a\u200fb.txt', encode('hello')],
    ['a\u202eb.txt', encode('hello')],
    ['safe.txt', Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d)],
    ['safe.txt', Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)],
    ['safe.txt', Uint8Array.of(0xc3, 0x28)],
  ])('rejects unsafe input %s', (fileName, bytes) => {
    expect(() => validateTextUpload({ fileName, mediaType: 'text/plain', bytes })).toThrow();
  });

  it('accepts exactly 1 MiB and rejects one byte more', () => {
    expect(validateTextUpload({ fileName: 'max.txt', mediaType: 'text/plain', bytes: new Uint8Array(MAX_RAW_UPLOAD_BYTES).fill(0x61) }).sizeBytes)
      .toBe(MAX_RAW_UPLOAD_BYTES);
    expect(errorCode(() => validateTextUpload({ fileName: 'too-large.txt', mediaType: 'text/plain', bytes: new Uint8Array(MAX_RAW_UPLOAD_BYTES + 1).fill(0x61) })))
      .toBe('UPLOAD_TOO_LARGE');
  });
});
