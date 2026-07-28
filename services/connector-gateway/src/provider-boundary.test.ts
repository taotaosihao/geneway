import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const credentialReference = /GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE|gearJobCredential/u;
const credentialPathForwarders = new Set([
  'scripts/dev-up.mjs',
  'scripts/playwright.config.ts',
  'scripts/run-e2e.mjs',
]);

async function sourceFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isDirectory() && ['node_modules', 'dist', 'doc', '.git'].includes(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(root, path));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

describe('Connector Gateway credential and GearJob provider boundary', () => {
  it('keeps the GearJob service credential inside Connector Gateway', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const violations: string[] = [];
    for (const file of await sourceFiles(root)) {
      const repositoryPath = relative(root, file).replaceAll('\\', '/');
      if (repositoryPath.startsWith('services/connector-gateway/')) continue;
      // The bounded launchers may forward the owned 0600 file path into the
      // Connector Gateway process; they must never read or parse its contents.
      if (credentialPathForwarders.has(repositoryPath)) continue;
      if (credentialReference.test(await readFile(file, 'utf8'))) violations.push(repositoryPath);
    }
    expect(violations).toEqual([]);

    for (const repositoryPath of credentialPathForwarders) {
      const launcher = await readFile(join(root, repositoryPath), 'utf8');
      expect(launcher).toContain('GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE');
      expect(launcher).not.toMatch(/read(?:File|OwnedRegularFile)[^(]*\([^\n]*(?:gearJobServiceCredentialFile|GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE)/u);
      expect(launcher).not.toMatch(/JSON\.parse\([^\n]*(?:gearJobServiceCredentialFile|GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE)/u);
    }
  });

  it('does not expose test authorization or fetch injection from the production entrypoint', async () => {
    const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8');
    expect(source).not.toContain('authorizeInvocationForTest');
    expect(source).not.toContain('fetchImpl');
    expect(source).not.toContain('gearJobRequestForTest');
  });
});
