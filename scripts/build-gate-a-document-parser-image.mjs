import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, 'packages/ingestion/parser');
const dockerfile = readFileSync(join(directory, 'Dockerfile.document'));
const source = readFileSync(join(directory, 'document-parser.mjs'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pdfjsRoot = join(root, 'packages/ingestion/node_modules/pdfjs-dist');
const inventorySources = ['LICENSE', 'package.json', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs', 'cmaps', 'standard_fonts', 'wasm'];
const inventory = [];
function collectInventory(absolute, relative) {
  if (statSync(absolute).isFile()) { inventory.push({ path: relative, sha256: sha256(readFileSync(absolute)) }); return; }
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() && !entry.isDirectory()) throw new Error('pdfjs inventory contains a non-regular entry');
    collectInventory(join(absolute, entry.name), join(relative, entry.name));
  }
}
for (const relative of inventorySources) collectInventory(join(pdfjsRoot, relative), relative);
inventory.sort((left, right) => left.path.localeCompare(right.path));
const pdfjsInventoryDigest = sha256(Buffer.from(JSON.stringify(inventory)));
const packageDigest = sha256(source);
const imageSourceDigest = createHash('sha256').update(dockerfile).update(Buffer.from([0])).update(source).update(Buffer.from([0])).update(pdfjsInventoryDigest).digest('hex');
const image = `geneway-document-parser:${imageSourceDigest.slice(0, 16)}`;
if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== '--print-tag')) throw new Error('usage: node scripts/build-gate-a-document-parser-image.mjs [--print-tag]');
if (process.argv[2] === '--print-tag') { process.stdout.write(`${image}\n`); process.exit(0); }
const context = mkdtempSync(join(tmpdir(), 'geneway-document-parser-build-'));
writeFileSync(join(context, 'Dockerfile.document'), dockerfile);
writeFileSync(join(context, 'document-parser.mjs'), source);
mkdirSync(join(context, 'pdfjs'), { recursive: true });
for (const relative of inventorySources) cpSync(join(pdfjsRoot, relative), join(context, 'pdfjs', relative), { recursive: true });
writeFileSync(join(context, 'pdfjs', 'inventory.json'), JSON.stringify({ schemaVersion: 'gate-a-pdfjs-inventory/1', files: inventory }));
const built = spawnSync('docker', ['build', '--network', 'none', '--file', join(context, 'Dockerfile.document'), '--build-arg', `GENEWAY_DOCUMENT_PARSER_PACKAGE_DIGEST=${packageDigest}`, '--build-arg', `GENEWAY_DOCUMENT_PARSER_IMAGE_SOURCE_DIGEST=${imageSourceDigest}`, '--build-arg', `GENEWAY_PDFJS_INVENTORY_DIGEST=${pdfjsInventoryDigest}`, '--tag', image, context], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
rmSync(context, { recursive: true, force: true });
if (built.error !== undefined) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
const inspect = spawnSync('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', image], { cwd: root, encoding: 'utf8' });
if (inspect.error !== undefined) throw inspect.error;
const labels = JSON.parse(inspect.stdout);
if (inspect.status !== 0 || labels?.['org.geneway.parser.package-digest'] !== packageDigest || labels?.['org.geneway.parser.image-source-digest'] !== imageSourceDigest || labels?.['org.geneway.parser.pdfjs-inventory-digest'] !== pdfjsInventoryDigest) throw new Error('document parser image label does not match source bytes');
process.stdout.write(`${JSON.stringify({ schemaVersion: 'gate-a-document-parser-image-build-candidate/2', image, imageSourceDigest, packageDigest, pdfjsInventoryDigest })}\n`);
