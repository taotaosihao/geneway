import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const parserDirectory = join(repositoryRoot, 'packages/ingestion/parser');
const dockerfile = readFileSync(join(parserDirectory, 'Dockerfile'));
const parserPackage = readFileSync(join(parserDirectory, 'plain-text-parser.mjs'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packageDigest = sha256(parserPackage);
const imageSourceDigest = createHash('sha256')
  .update(dockerfile)
  .update(Buffer.from([0]))
  .update(parserPackage)
  .digest('hex');
const image = `geneway-plain-text-parser:${imageSourceDigest.slice(0, 16)}`;

if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== '--print-tag')) {
  throw new Error('usage: node scripts/build-gate-a-parser-image.mjs [--print-tag]');
}

if (process.argv[2] === '--print-tag') {
  process.stdout.write(`${image}\n`);
  process.exit(0);
}

const built = spawnSync('docker', [
  'build',
  '--network', 'none',
  '--build-arg', `GENEWAY_PARSER_PACKAGE_DIGEST=${packageDigest}`,
  '--tag', image,
  parserDirectory,
], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'inherit', 'inherit'],
});
if (built.error !== undefined) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);

const inspected = spawnSync('docker', [
  'image', 'inspect',
  '--format', '{{json .Config.Labels}}',
  image,
], { cwd: repositoryRoot, encoding: 'utf8' });
if (inspected.error !== undefined) throw inspected.error;
if (inspected.status !== 0) throw new Error('Gate A parser image inspection failed after build');
const labels = JSON.parse(inspected.stdout);
if (labels?.['org.geneway.parser.package-digest'] !== packageDigest) {
  throw new Error('Gate A parser image package digest label does not match the source bytes');
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 'gate-a-parser-image-build/1',
  image,
  imageSourceDigest,
  packageDigest,
})}\n`);
