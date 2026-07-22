import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const roots = [path.join(scriptsDir, 'playwright.config.ts')];

async function collectFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(resolved);
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) roots.push(resolved);
  }
}
await collectFiles(path.join(scriptsDir, 'e2e'));

const checked = new Set();
const queue = [...roots];
const forbidden = [
  [/\.\s*(?:route|routeFromHAR|setContent|addInitScript)\s*\(/, 'browser response interception or document substitution'],
  [/\.\s*fulfill\s*\(/, 'synthetic route fulfillment'],
  [/serviceWorker\s*\.\s*register\s*\(/i, 'service worker registration'],
  [/(?:globalThis|window)\s*\.\s*(?:fetch|XMLHttpRequest)\s*=/, 'browser transport replacement'],
  [/Object\.defineProperty\s*\([^,]+,\s*['"](?:fetch|XMLHttpRequest)['"]/, 'browser transport replacement'],
  [/\bdata:text\/html\b/i, 'inline success document'],
];

async function resolveLocalImport(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const nodeNextSourceCandidates = specifier.endsWith('.js')
    ? [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx']
    : [];
  for (const candidate of [...nodeNextSourceCandidates, base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    try { await access(candidate); return candidate; } catch { /* try the next local candidate */ }
  }
  throw new Error(`Cannot resolve local Playwright import ${specifier} from ${from}`);
}

while (queue.length > 0) {
  const file = queue.shift();
  if (file === undefined || checked.has(file)) continue;
  checked.add(file);
  const source = await readFile(file, 'utf8');
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) {
      console.error(`geneway served UI test is not authentic: ${label} in ${path.relative(process.cwd(), file)}`);
      process.exit(1);
    }
  }
  const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)];
  for (const match of imports) {
    const specifier = match[1];
    if (specifier !== undefined) queue.push(await resolveLocalImport(file, specifier));
  }
}

console.log(`geneway authenticity scan passed across ${checked.size} Playwright config/spec/helper files and their local import closure.`);
