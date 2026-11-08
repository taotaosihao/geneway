import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const sourcePins = [
  { name: 'a2a-spec', repository: 'a2aproject/A2A', commit: '3303592588e388e62e0f69f701af531d2f4e3991' },
  { name: 'a2a-js', repository: 'a2aproject/a2a-js', commit: '29417a5bb4038f804f310ce4fffd267a9375aa90' },
  { name: 'anp-spec', repository: 'agent-network-protocol/AgentNetworkProtocol', commit: '26ff75c634fa032fcc42291b10188174d9d4b4b0' },
  { name: 'anp-sdk', repository: 'agent-network-protocol/anp', commit: 'bab0a0e63fb83035b37d304984f1671f3fd38a6b' },
];
const packagePins = [
  { name: '@a2a-js/sdk', version: '1.3.0', sha256: '9134ffc94fe2741170020db88d676734e00b87992b15d6d274027afbb318f3a3' },
  { name: '@awiki/anp-typescript-sdk', version: '0.9.5', sha256: '22bf28b9eb2dc41f917d80ece6268e1c7fc94f59feac9847fdb8afc73728c88f' },
];
const sha = value => createHash('sha256').update(value).digest('hex');
export async function preflight(root, { downloadSources = true } = {}) {
  assert.equal(process.version, 'v26.5.0', 'All three paths must use the same pinned Node runtime');
  await mkdir(root, { recursive: true });
  const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json')));
  const result = { observedAt: new Date().toISOString(), runtime: { node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch }, lockSha256: sha(await readFile(path.join(directory, 'package-lock.json'))), packages: [], dependencies: [], sources: [] };
  for (const pin of packagePins) {
    const installed = JSON.parse(await readFile(path.join(directory, 'node_modules', pin.name, 'package.json')));
    assert.equal(installed.version, pin.version);
    const metadata = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pin.name)}/${pin.version}`).then(r => { assert(r.ok); return r.json(); });
    const bytes = Buffer.from(await fetch(metadata.dist.tarball).then(r => { assert(r.ok); return r.arrayBuffer(); }));
    assert.equal(sha(bytes), pin.sha256);
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), metadata.dist.integrity);
    assert.equal(lock.packages[`node_modules/${pin.name}`].integrity, metadata.dist.integrity);
    const artifact = `${pin.name.replaceAll('/', '-').replace('@', '')}-${pin.version}.tgz`;
    await writeFile(path.join(root, artifact), bytes);
    result.packages.push({ ...pin, actualBytes: bytes.length, integrity: metadata.dist.integrity, registryGitHead: metadata.gitHead ?? null, installedPath: path.join(directory, 'node_modules', pin.name), artifact, license: installed.license });
  }
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative) continue;
    const installedPath = path.join(directory, relative, 'package.json');
    try {
      const installed = JSON.parse(await readFile(installedPath));
      result.dependencies.push({ path: relative, name: installed.name, version: installed.version, license: installed.license ?? null, integrity: entry.integrity ?? null });
    } catch (error) { if (error.code !== 'ENOENT') throw error; result.dependencies.push({ path: relative, installed: false, optional: entry.optional === true }); }
  }
  if (downloadSources) for (const pin of sourcePins) {
    const target = path.join(root, pin.name), archive = path.join(root, `${pin.name}-${pin.commit}.tar.gz`);
    let bytes;
    try { bytes = await readFile(archive); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetch(`https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`);
      assert(response.ok, `${pin.name} HTTP ${response.status}`); bytes = Buffer.from(await response.arrayBuffer()); await writeFile(archive, bytes);
    }
    await mkdir(target, { recursive: true });
    const extract = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target], { encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);
    const license = (await readdir(target)).find(name => /^licen[sc]e(?:\.|$)/i.test(name));
    assert(license, `${pin.name} license is required`);
    result.sources.push({ ...pin, archiveSha256: sha(bytes), archiveBytes: bytes.length, path: target, licenseFile: license, licenseSha256: sha(await readFile(path.join(target, license))) });
  }
  await writeFile(path.join(root, 'installed-source-manifest.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]; if (!root) throw Error('Usage: node preflight.mjs ABSOLUTE_EVIDENCE_ROOT');
  const result = await preflight(root); console.log(JSON.stringify({ result: 'passed', root, packages: result.packages.length, dependencies: result.dependencies.length, sources: result.sources.length, node: process.version }));
}
