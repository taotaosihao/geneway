import { inspectGateADocumentParserAuthority } from '../packages/ingestion/src/index.js';
import { gateAParserStartupApprovalSchema } from '@geneway/contracts';
import { z } from 'zod';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const buildSchema = z.object({
  schemaVersion: z.literal('gate-a-document-parser-image-build-candidate/2'),
  image: z.string().regex(/^geneway-document-parser:[a-f0-9]{16}$/u),
  imageSourceDigest: digestSchema,
  packageDigest: digestSchema,
  pdfjsInventoryDigest: digestSchema,
}).strict();

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const runId = required('GENEWAY_RUN_ID');
const approvedBy = required('GENEWAY_GATE_A_PARSER_APPROVED_BY');
if (approvedBy !== 'user_local') throw new Error('Gate A dev parser approval must use the authorized local user');
const build = buildSchema.parse(JSON.parse(required('GENEWAY_GATE_A_PARSER_BUILD_JSON')));
if (build.image !== `geneway-document-parser:${build.imageSourceDigest.slice(0, 16)}`) {
  throw new Error('Gate A document parser build tag is not source-derived');
}

const approvedAt = new Date();
const expiresAt = new Date(approvedAt.getTime() + 15 * 60_000);
const inspection = await inspectGateADocumentParserAuthority(build.image, {
  runId,
  approvedBy,
  approvedAt: approvedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
});
const pdfjs = inspection.manifests.pdf.dependencies.find((dependency) => dependency.name === 'pdfjs-dist');
if (inspection.image !== build.image
  || inspection.imageSourceDigest !== build.imageSourceDigest
  || inspection.packageDigest !== build.packageDigest
  || pdfjs?.packageDigest !== build.pdfjsInventoryDigest) {
  throw new Error('Gate A document parser inspection does not match the source-derived build');
}
const approval = gateAParserStartupApprovalSchema.parse(inspection.startupApprovalCandidate);
process.stdout.write(`${JSON.stringify(approval)}\n`);
