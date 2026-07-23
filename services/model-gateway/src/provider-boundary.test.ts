import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const providerImport = /(?:from\s*|import\s*\()\s*['"](?:@openai(?:\/|-)[^'"]*|@ai-sdk\/openai|ai)['"]/u;

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

describe('Model Gateway dependency and provider egress boundary', () => {
  it('keeps OpenAI, OAuth and AI SDK provider imports inside the Model Gateway service', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const violations: string[] = [];
    for (const file of await sourceFiles(root)) {
      const repositoryPath = relative(root, file).replaceAll('\\', '/');
      if (repositoryPath.startsWith('services/model-gateway/')) continue;
      if (providerImport.test(await readFile(file, 'utf8'))) violations.push(repositoryPath);
    }
    expect(violations).toEqual([]);
  });

  it('does not expose test provider injection through production or E2E configuration', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const productionEntrypoints = [
      'services/model-gateway/src/main.ts',
      'scripts/playwright.config.ts',
      'scripts/run-e2e.mjs',
      'scripts/dev-up.mjs',
    ];
    for (const repositoryPath of productionEntrypoints) {
      const source = await readFile(join(root, repositoryPath), 'utf8');
      expect(source, repositoryPath).not.toContain('providerCallForTest');
      expect(source, repositoryPath).not.toContain('authorizeInvocationForTest');
    }
  });
});
