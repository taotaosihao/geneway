import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize } from 'json-canonicalize';
import {
  canonicalizeGateAProjection,
  liveEvidenceLocatorSchema,
} from '@geneway/contracts';
import { verifyLiveEvidenceAuthority } from './gate-a-live-repository.js';

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
type VerifyInput = Parameters<typeof verifyLiveEvidenceAuthority>[0];

function expectAuthorityError(callback: () => unknown, code: string): void {
  try {
    callback();
  } catch (error: unknown) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

function plainAuthority(canonical: Buffer, storedExcerpt = canonical, startByte = 0): VerifyInput {
  const canonicalSha256 = sha256(canonical);
  const endByteExclusive = startByte + storedExcerpt.byteLength;
  const locator = liveEvidenceLocatorSchema.parse({
    schemaVersion: 'evidence-locator.live/1', kind: 'canonical_text_span',
    sourceArtifactId: 'artifact_live', sourceArtifactSha256: 'a'.repeat(64),
    documentSnapshotId: 'snapshot_live', canonicalTextSha256: canonicalSha256,
    parserManifestId: 'parser_live', parserDigest: 'b'.repeat(64),
    extractionVersion: 'canonical-text/plain-utf8/1', excerptSha256: sha256(storedExcerpt),
    excerptByteLength: storedExcerpt.byteLength, startByte, endByteExclusive,
  });
  return {
    locator, storedExcerpt, storedExcerptSha256: sha256(storedExcerpt), canonicalBytes: canonical,
    canonicalPageIndex: null, canonicalPageIndexSha256: null,
    inputRef: {
      artifactId: 'artifact_live', artifactSha256: 'a'.repeat(64), documentSnapshotId: 'snapshot_live',
      canonicalTextSha256: canonicalSha256, canonicalPageIndexSha256: null, parserManifestId: 'parser_live',
      parserDigest: 'b'.repeat(64), extractionVersion: 'canonical-text/plain-utf8/1',
      resourceScope: 'document-snapshot:snapshot_live', dataClass: 'C1', audience: 'conversation:conversation_live',
    } as VerifyInput['inputRef'],
    resourceScope: 'document-snapshot:snapshot_live', dataClass: 'C1', audience: 'conversation:conversation_live',
  };
}

function pageAuthority(): VerifyInput {
  const firstPage = Buffer.from('第一页😀\n', 'utf8');
  const secondPage = Buffer.from('第二页\r\n', 'utf8');
  const canonical = Buffer.concat([firstPage, secondPage]);
  const canonicalSha256 = sha256(canonical);
  const pageIndex = {
    schemaVersion: 'canonical-page-index/1' as const,
    format: 'pdf' as const,
    mediaType: 'application/pdf' as const,
    extractionVersion: 'canonical-text/pdf-pages-utf8/1' as const,
    canonicalTextSha256: canonicalSha256,
    canonicalByteLength: canonical.byteLength,
    pageCount: 2,
    pages: [
      { pageIndex: 0, canonicalStartByte: 0, canonicalEndByteExclusive: firstPage.byteLength,
        canonicalPageSha256: sha256(firstPage) },
      { pageIndex: 1, canonicalStartByte: firstPage.byteLength, canonicalEndByteExclusive: canonical.byteLength,
        canonicalPageSha256: sha256(secondPage) },
    ],
  };
  const pageIndexSha256 = sha256(Buffer.from(canonicalizeGateAProjection(pageIndex), 'utf8'));
  const excerpt = Buffer.from('第一页😀', 'utf8');
  const locator = liveEvidenceLocatorSchema.parse({
    schemaVersion: 'evidence-locator.live/1', kind: 'canonical_page_span', pageIndex: 0,
    sourceArtifactId: 'artifact_pdf', sourceArtifactSha256: 'c'.repeat(64),
    documentSnapshotId: 'snapshot_pdf', canonicalTextSha256: canonicalSha256,
    parserManifestId: 'parser_pdf', parserDigest: 'd'.repeat(64),
    extractionVersion: 'canonical-text/pdf-pages-utf8/1', excerptSha256: sha256(excerpt),
    excerptByteLength: excerpt.byteLength, startByte: 0, endByteExclusive: excerpt.byteLength,
  });
  return {
    locator, storedExcerpt: excerpt, storedExcerptSha256: sha256(excerpt), canonicalBytes: canonical,
    canonicalPageIndex: pageIndex, canonicalPageIndexSha256: pageIndexSha256,
    inputRef: {
      artifactId: 'artifact_pdf', artifactSha256: 'c'.repeat(64), documentSnapshotId: 'snapshot_pdf',
      canonicalTextSha256: canonicalSha256, canonicalPageIndexSha256: pageIndexSha256,
      parserManifestId: 'parser_pdf', parserDigest: 'd'.repeat(64),
      extractionVersion: 'canonical-text/pdf-pages-utf8/1', resourceScope: 'document-snapshot:snapshot_pdf',
      dataClass: 'C1', audience: 'conversation:conversation_pdf',
    } as VerifyInput['inputRef'],
    resourceScope: 'document-snapshot:snapshot_pdf', dataClass: 'C1', audience: 'conversation:conversation_pdf',
  };
}

describe('Gate A live Evidence read-time authority', () => {
  it('accepts an exact 16 KiB UTF-8 canonical span and rejects one byte more at the schema boundary', () => {
    const exact = plainAuthority(Buffer.alloc(16 * 1_024, 0x61));
    expect(verifyLiveEvidenceAuthority(exact)).toEqual(exact.storedExcerpt);
    expect(() => liveEvidenceLocatorSchema.parse({
      ...exact.locator, excerptByteLength: 16 * 1_024 + 1, endByteExclusive: 16 * 1_024 + 1,
    })).toThrow();
  });

  it.each([
    ['NFC/NFD', Buffer.from('e\u0301', 'utf8'), Buffer.from('é', 'utf8')],
    ['CRLF/LF', Buffer.from('a\r\nb', 'utf8'), Buffer.from('a\nb', 'utf8')],
  ])('rejects normalized %s bytes instead of rewriting the immutable excerpt', (_name, canonical, normalized) => {
    expectAuthorityError(
      () => verifyLiveEvidenceAuthority(plainAuthority(canonical, normalized)),
      'EVIDENCE_INTEGRITY_FAILED',
    );
  });

  it('rejects a locator whose exact byte span begins and ends inside a multibyte character', () => {
    const canonical = Buffer.from('😀', 'utf8');
    const partial = canonical.subarray(1, 3);
    expectAuthorityError(
      () => verifyLiveEvidenceAuthority(plainAuthority(canonical, partial, 1)),
      'EVIDENCE_INTEGRITY_FAILED',
    );
  });

  it('accepts an exact page-relative span and rejects cross-page or reordered page authority', () => {
    const valid = pageAuthority();
    expect(verifyLiveEvidenceAuthority(valid)).toEqual(valid.storedExcerpt);
    expectAuthorityError(() => verifyLiveEvidenceAuthority({
      ...valid,
      locator: { ...valid.locator, endByteExclusive: 1_000, excerptByteLength: 1_000 },
    }), 'EVIDENCE_AUTHORITY_INVALID');

    const pageIndex = structuredClone(valid.canonicalPageIndex) as { pages: unknown[] };
    pageIndex.pages.reverse();
    const pageIndexSha256 = sha256(Buffer.from(canonicalize(pageIndex), 'utf8'));
    expectAuthorityError(() => verifyLiveEvidenceAuthority({
      ...valid, canonicalPageIndex: pageIndex, canonicalPageIndexSha256: pageIndexSha256,
      inputRef: { ...valid.inputRef, canonicalPageIndexSha256: pageIndexSha256 },
    }), 'EVIDENCE_AUTHORITY_INVALID');
  });

  it.each([
    ['resource scope', { resourceScope: 'document-snapshot:adjacent' }],
    ['data class', { dataClass: 'C2' }],
    ['audience', { audience: 'conversation:adjacent' }],
  ])('rejects %s drift without returning excerpt bytes', (_name, drift) => {
    expectAuthorityError(
      () => verifyLiveEvidenceAuthority({ ...plainAuthority(Buffer.from('bounded excerpt')), ...drift }),
      'EVIDENCE_AUTHORITY_INVALID',
    );
  });

  it.each([
    ['artifact', (value: VerifyInput) => ({ ...value,
      locator: { ...value.locator, sourceArtifactId: 'artifact_adjacent' } })],
    ['snapshot', (value: VerifyInput) => ({ ...value,
      locator: { ...value.locator, documentSnapshotId: 'snapshot_adjacent' } })],
    ['parser', (value: VerifyInput) => ({ ...value,
      locator: { ...value.locator, parserDigest: 'f'.repeat(64) } })],
    ['canonical hash', (value: VerifyInput) => ({ ...value,
      locator: { ...value.locator, canonicalTextSha256: 'f'.repeat(64) } })],
  ])('rejects a locator with a different %s identity', (_name, mutate) => {
    expectAuthorityError(
      () => verifyLiveEvidenceAuthority(mutate(plainAuthority(Buffer.from('bounded excerpt')))),
      'EVIDENCE_AUTHORITY_INVALID',
    );
  });

  it('rejects stored excerpt, excerpt hash, and canonical byte integrity drift independently', () => {
    const valid = plainAuthority(Buffer.from('bounded excerpt'));
    for (const drift of [
      { storedExcerpt: Buffer.from('adjacent excerpt') },
      { storedExcerptSha256: 'f'.repeat(64) },
      { canonicalBytes: Buffer.from('different canonical bytes') },
      { locator: { ...valid.locator, excerptSha256: 'f'.repeat(64) } as VerifyInput['locator'] },
    ]) {
      expectAuthorityError(() => verifyLiveEvidenceAuthority({ ...valid, ...drift }), 'EVIDENCE_INTEGRITY_FAILED');
    }
  });
});
