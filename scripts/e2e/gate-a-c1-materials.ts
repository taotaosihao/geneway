import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export type GateADocumentFixtureName =
  | 'chrome-production.pdf.gz.b64'
  | 'pandoc-production.docx.gz.b64';

export async function loadGateADocumentFixture(name: GateADocumentFixtureName): Promise<Buffer> {
  const encoded = await readFile(new URL(`../fixtures/gate-a-documents/${name}`, import.meta.url), 'utf8');
  return gunzipSync(Buffer.from(encoded.replaceAll(/\s/gu, ''), 'base64'));
}

export const gateACancelMaterialBytes = (): Buffer => Buffer.from(
  ('生产工单追溯字段：工单号、开始时间、完成时间、检验批次、状态。\n').repeat(2_000),
  'utf8',
);

export const gateANegativeMaterialBytes = (): Buffer => Buffer.from(
  '事实：本材料仅用于验证 auto live route。\n未知项：未提供产能数据。',
  'utf8',
);

export const gateAReauthorizationMaterialBytes = (): Buffer => Buffer.from(
  '事实：方案审批需要在执行前复核当前不可变 authority。\n未知项：尚未提供量产节拍。',
  'utf8',
);

export const gateARevokedSourceMaterialBytes = (): Buffer => Buffer.from(
  ('事实：此材料用于验证执行开始后的来源撤销必须安全终止。\n').repeat(256),
  'utf8',
);

export async function gateAC1MaterialCorpus(): Promise<readonly Buffer[]> {
  return [
    await loadGateADocumentFixture('chrome-production.pdf.gz.b64'),
    await loadGateADocumentFixture('pandoc-production.docx.gz.b64'),
    gateACancelMaterialBytes(),
    gateANegativeMaterialBytes(),
    gateAReauthorizationMaterialBytes(),
    gateARevokedSourceMaterialBytes(),
  ];
}
