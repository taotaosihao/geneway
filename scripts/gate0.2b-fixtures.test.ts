import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalize } from 'json-canonicalize';
import { describe, expect, it } from 'vitest';

const fixtures = [
  {
    file: './fixtures/gate0.2b/capacity-progress-lag.v1.json',
    bytes: 513,
    sha256: '0aaf071f5cb062251011970b382e239d3ae5fdcdc4f977b96f325825723b2ed6',
  },
  {
    file: './fixtures/gate0.2b/equipment-alarm.v1.json',
    bytes: 509,
    sha256: 'c8de7202aa3d5a395bbc96df13776fbdc68591687d6e0fbd144d1c9a1e5ea593',
  },
] as const;

describe('Gate 0.2B controlled exception fixtures', () => {
  it.each(fixtures)('pins the RFC 8785/JCS bytes and hash for $file', async ({ file, bytes, sha256 }) => {
    const parsed = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8')) as unknown;
    const canonical = canonicalize(parsed);
    expect(Buffer.byteLength(canonical, 'utf8')).toBe(bytes);
    expect(createHash('sha256').update(canonical, 'utf8').digest('hex')).toBe(sha256);
    expect(canonicalize(JSON.parse(canonical) as unknown)).toBe(canonical);
  });
});
