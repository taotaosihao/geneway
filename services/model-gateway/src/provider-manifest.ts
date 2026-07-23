import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const packageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  registry: z.literal('https://registry.npmjs.org'),
  integrity: z.string().startsWith('sha512-'),
  repository: z.string().startsWith('https://github.com/'),
  reviewedProvenance: z.object({
    upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/),
    assurance: z.literal('reviewed-not-machine-attested-from-package-bytes'),
  }).strict(),
  license: z.enum(['MIT', 'Apache-2.0']),
  packageBytesSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const providerManifestSchema = z.object({
  schemaVersion: z.literal('geneway-provider-manifest/1'),
  profile: z.literal('codex_subscription_dev'),
  logicalModelPolicy: z.literal('general.chat.standard'),
  providerModel: z.literal('gpt-5.4-mini'),
  transport: z.literal('ai-sdk-openai-oauth'),
  approval: z.object({
    actor: z.literal('user@source-thread:019f880e-bac8-7412-a129-68db9bf6506a'),
    authorizationRef: z.literal('source-thread:019f880e-bac8-7412-a129-68db9bf6506a'),
    recordedAt: z.string().datetime(),
    scope: z.literal('trusted-local development only'),
  }).strict(),
  lifecyclePolicy: z.object({
    installScriptsAllowed: z.literal(false),
    runtimeNetworkInstallAllowed: z.literal(false),
    credentialRefreshOwner: z.literal('named local provider process only'),
  }).strict(),
  credentialBoundary: z.object({
    policy: z.literal('owner-private-default-with-explicit-trusted-local-override'),
    defaultParentMode: z.literal('0700'),
    fileMode: z.literal('0600'),
    authorizedOverride: z.object({
      authFilePath: z.literal('/home/gewu/.codex/auth.json'),
      parentDirectory: z.literal('/home/gewu/.codex'),
      parentMode: z.literal('0775'),
      owner: z.literal('current-process-uid'),
      symlinksAllowed: z.literal(false),
      scope: z.literal('trusted-local development only'),
      decision: z.object({
        actor: z.literal('user@thread:019f8b7f-06b3-73e0-9b15-2bab812db6a7'),
        authorizationRef: z.literal('thread:019f8b7f-06b3-73e0-9b15-2bab812db6a7'),
        recordedAt: z.string().datetime(),
      }).strict(),
    }).strict(),
  }).strict(),
  packages: z.array(packageSchema).length(7),
}).strict();

export type ProviderManifest = z.infer<typeof providerManifestSchema>;

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(moduleDirectory, '..');
const repositoryRoot = resolve(serviceRoot, '../..');
const require = createRequire(import.meta.url);

async function findPackageRoot(name: string): Promise<string> {
  let current = dirname(require.resolve(name));
  while (current !== dirname(current)) {
    try {
      const parsed = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as { name?: unknown };
      if (parsed.name === name) return current;
    } catch {
      // Continue toward the package root without exposing package contents.
    }
    current = dirname(current);
  }
  throw new Error(`Unable to locate installed package root: ${name}`);
}

async function listPackageFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'node_modules') continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) output.push(...await listPackageFiles(root, path));
    else if (entry.isFile()) output.push(path);
    else throw new Error(`Package contains a non-regular entry: ${relative(root, path)}`);
  }
  return output;
}

export async function hashInstalledPackage(name: string): Promise<string> {
  const root = await findPackageRoot(name);
  const hash = createHash('sha256');
  for (const path of await listPackageFiles(root)) {
    const pathName = relative(root, path).replaceAll('\\', '/');
    const bytes = await readFile(path);
    hash.update(`${pathName}\0${String(bytes.byteLength)}\0`, 'utf8');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function lockfileIntegrityForPackage(lockfile: string, name: string, version: string): string {
  const lines = lockfile.split('\n');
  const packagesStart = lines.indexOf('packages:');
  const snapshotsStart = lines.indexOf('snapshots:');
  if (packagesStart < 0 || snapshotsStart <= packagesStart) throw new Error('pnpm lockfile package sections are invalid');
  const packageKey = `${name}@${version}`;
  const headers = new Set([`  '${packageKey}':`, `  ${packageKey}:`]);
  const matches: number[] = [];
  for (let index = packagesStart + 1; index < snapshotsStart; index += 1) {
    if (headers.has(lines[index] ?? '')) matches.push(index);
  }
  if (matches.length !== 1) throw new Error(`pnpm lockfile package key is missing or ambiguous: ${packageKey}`);
  let integrity: string | undefined;
  for (let index = (matches[0] ?? 0) + 1; index < snapshotsStart; index += 1) {
    const line = lines[index] ?? '';
    if (/^\x20{2}\S/u.test(line)) break;
    const resolution = line.match(/^\x20{4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}$/u);
    if (resolution?.[1] !== undefined) {
      if (integrity !== undefined) throw new Error(`pnpm lockfile has duplicate resolution integrity: ${packageKey}`);
      integrity = resolution[1];
    }
  }
  if (integrity === undefined) throw new Error(`pnpm lockfile resolution integrity is missing: ${packageKey}`);
  return integrity;
}

export function assertLockfilePackageIntegrity(
  lockfile: string,
  input: Readonly<{ name: string; version: string; integrity: string }>,
): void {
  if (lockfileIntegrityForPackage(lockfile, input.name, input.version) !== input.integrity) {
    throw new Error(`Provider package lockfile integrity mismatch: ${input.name}`);
  }
}

function normalizeRepository(repository: unknown): string | undefined {
  const raw = typeof repository === 'string'
    ? repository
    : typeof repository === 'object' && repository !== null && 'url' in repository
      ? (repository as { url?: unknown }).url
      : undefined;
  if (typeof raw !== 'string') return undefined;
  return raw.replace(/^git\+/u, '').replace(/\.git$/u, '');
}

export async function verifyProviderManifest(): Promise<Readonly<{ manifest: ProviderManifest; digest: string }>> {
  const manifestBytes = await readFile(join(serviceRoot, 'provider-manifest.json'));
  const manifest = providerManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const lockfile = await readFile(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  for (const entry of manifest.packages) {
    const packageRoot = await findPackageRoot(entry.name);
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      name?: unknown; version?: unknown; license?: unknown; repository?: unknown;
    };
    if (packageJson.name !== entry.name || packageJson.version !== entry.version || packageJson.license !== entry.license
      || normalizeRepository(packageJson.repository) !== entry.repository) {
      throw new Error(`Provider package metadata mismatch: ${entry.name}`);
    }
    assertLockfilePackageIntegrity(lockfile, entry);
    if (await hashInstalledPackage(entry.name) !== entry.packageBytesSha256) {
      throw new Error(`Provider package bytes mismatch: ${entry.name}`);
    }
  }
  return { manifest, digest: createHash('sha256').update(manifestBytes).digest('hex') };
}

export async function verifyOwnedPrivateFile(filePath: string, label: string): Promise<void> {
  if (!filePath.startsWith('/')) throw new Error(`${label} path must be absolute`);
  const directoryPath = dirname(filePath);
  const [directoryStat, fileStat, resolvedDirectory, resolvedFile] = await Promise.all([
    lstat(directoryPath), lstat(filePath), realpath(directoryPath), realpath(filePath),
  ]);
  const uid = process.getuid?.();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || resolvedDirectory !== directoryPath
    || (directoryStat.mode & 0o777) !== 0o700 || (uid !== undefined && directoryStat.uid !== uid)) {
    throw new Error(`${label} parent directory must be owned, non-symlink, and 0700`);
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || resolvedFile !== filePath
    || (fileStat.mode & 0o777) !== 0o600 || (uid !== undefined && fileStat.uid !== uid)
    || fileStat.size === 0 || fileStat.size > 1_048_576) {
    throw new Error(`${label} must be an owned, non-symlink, bounded 0600 file`);
  }
}

export async function verifyProviderAuthFile(
  filePath: string,
  manifest: ProviderManifest,
  label = 'Provider auth file',
): Promise<void> {
  const override = manifest.credentialBoundary.authorizedOverride;
  if (filePath !== override.authFilePath) {
    await verifyOwnedPrivateFile(filePath, label);
    return;
  }
  if (dirname(filePath) !== override.parentDirectory) {
    throw new Error(`${label} authorized override path is invalid`);
  }
  const [directoryStat, fileStat, resolvedDirectory, resolvedFile] = await Promise.all([
    lstat(override.parentDirectory), lstat(filePath), realpath(override.parentDirectory), realpath(filePath),
  ]);
  const uid = process.getuid?.();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || resolvedDirectory !== override.parentDirectory
    || (directoryStat.mode & 0o777) !== Number.parseInt(override.parentMode, 8)
    || (uid !== undefined && directoryStat.uid !== uid)) {
    throw new Error(`${label} authorized parent directory must be owned, non-symlink, and ${override.parentMode}`);
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || resolvedFile !== filePath
    || (fileStat.mode & 0o777) !== Number.parseInt(manifest.credentialBoundary.fileMode, 8)
    || (uid !== undefined && fileStat.uid !== uid)
    || fileStat.size === 0 || fileStat.size > 1_048_576) {
    throw new Error(`${label} must be an owned, non-symlink, bounded ${manifest.credentialBoundary.fileMode} file`);
  }
}
