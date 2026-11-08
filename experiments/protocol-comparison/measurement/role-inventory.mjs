import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const experiment = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sources = '/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-comparison-sources'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
async function texts(root) {
  const found = []
  async function walk(path, depth) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (['node_modules', '.git', '.venv'].includes(entry.name)) continue
      const file = join(path, entry.name)
      if (entry.isFile() && /^(licen[sc]e|notice|copying)([.\-_]|$)/i.test(entry.name)) found.push({ path: file, sha256: hash(await readFile(file)) })
      else if (entry.isDirectory() && depth < 2) await walk(file, depth + 1)
    }
  }
  await walk(root, 0); return found
}
async function locate(name, parent = experiment) {
  let directory = parent
  while (true) {
    const path = join(directory, 'node_modules', name)
    try { await readFile(join(path, 'package.json')); return realpath(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (dirname(directory) === directory) throw Error(`Unresolved declared dependency ${name} from ${parent}`)
    directory = dirname(directory)
  }
}
export async function inventoryRoles() {
  const lockBytes = await readFile(join(experiment, 'package-lock.json')), lock = JSON.parse(lockBytes)
  const manifest = await json(join(sources, 'installed-source-manifest.json'))
  const packages = new Map(), roles = {}
  async function closure(names) {
    const seen = new Set(), optional = []
    async function visit(name, parent) {
      const path = await locate(name, parent)
      if (seen.has(path)) return
      seen.add(path)
      const meta = await json(join(path, 'package.json')), lockPath = relative(experiment, path), locked = lock.packages[lockPath]
      assert.equal(meta.version, locked.version)
      if (!packages.has(path)) packages.set(path, { path, name: meta.name, version: meta.version, lockPath,
        metadataPath: join(path, 'package.json'), metadataSha256: hash(await readFile(join(path, 'package.json'))), integrity: locked.integrity ?? null, declaredLicense: meta.license ?? null, os: meta.os ?? null, cpu: meta.cpu ?? null,
        licenseTexts: await texts(path), resolved: true, loaded: { status: 'not-run', reason: 'No role-specific module execution trace collected' } })
      for (const [child, range] of Object.entries(meta.optionalDependencies ?? {})) optional.push({ parent: path, name: child, range, classification: 'platform/optional declaration; not counted as unconditional runtime' })
      for (const child of Object.keys(meta.dependencies ?? {})) if (!(child in (meta.optionalDependencies ?? {}))) await visit(child, path)
    }
    for (const name of names) await visit(name, experiment)
    return { runtimePaths: [...seen].sort(), optionalDeclarations: optional }
  }
  roles.a2aSdk = await closure(['@a2a-js/sdk'])
  roles.a2aIndependentExpressPeer = await closure(['@a2a-js/sdk', 'express'])
  roles.anpHome = await closure(['@awiki/anp-typescript-sdk', 'bs58'])
  const historicalComparison = []
  for (const old of manifest.dependencies) {
    const current = lock.packages[old.path], installed = await json(join(experiment, old.path, 'package.json'))
    for (const field of ['version', 'integrity', 'license']) assert.deepEqual(current[field] ?? null, old[field] ?? null, `${old.path}:${field}`)
    assert.equal(installed.name, old.name); assert.equal(installed.version, old.version)
    historicalComparison.push({ path: old.path, currentLockAndInstalledIdentityMatch: true })
  }
  const python = execFileSync(join(sources, 'awiki-open-server/.venv/bin/python'), ['-c', String.raw`
import importlib.metadata as m, json, hashlib, pathlib, tomllib
from packaging.requirements import Requirement
from packaging.markers import default_environment
root=pathlib.Path(${JSON.stringify(join(sources, 'awiki-open-server'))})
def norm(n): return n.lower().replace('_','-').replace('.','-')
ds={norm(d.metadata['Name']):d for d in m.distributions()}
project=tomllib.loads((root/'pyproject.toml').read_text())
lock=tomllib.loads((root/'uv.lock').read_text())
def closure(initial):
 seen=set(); edges=[]; excluded=[]; queue=[(s,[]) for s in initial]
 while queue:
  text,extras=queue.pop(); r=Requirement(text); env=default_environment()
  allowed=not r.marker or any(r.marker.evaluate(dict(env,extra=e)) for e in (extras or ['']))
  if not allowed: excluded.append(text); continue
  n=norm(r.name); d=ds[n]; edges.append({'requirement':text,'name':n,'extras':sorted(r.extras)})
  key=(n,tuple(sorted(r.extras)))
  if key in seen: continue
  seen.add(key)
  for child in d.requires or []: queue.append((child,list(r.extras)))
 return sorted(set(n for n,e in seen)),edges,excluded
runtime,edges,excluded=closure(['awiki-open-server'])
devdecl=project.get('dependency-groups',{}).get('dev',[])
dev,_,devexcluded=closure([x for x in devdecl if isinstance(x,str)])
rows=[]
for n,d in sorted(ds.items()):
 files=[]
 for f in d.files or []:
  if any(part.lower().startswith(('license','notice','copying')) for part in f.parts):
   p=d.locate_file(f)
   if p.is_file(): files.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
 rows.append({'name':n,'version':d.version,'metadataPath':str(d._path/'METADATA'),'metadataSha256':hashlib.sha256((d._path/'METADATA').read_bytes()).hexdigest(),'licenseTextStatus':'located' if files else 'unknown-not-located-in-installed-distribution','declaredLicense':d.metadata.get('License-Expression') or d.metadata.get('License'),'licenseTexts':files,'runtime':n in runtime,'devOnly':n in dev and n not in runtime,'loaded':{'status':'not-run'},'lockRecords':[p for p in lock['package'] if norm(p['name'])==n]})
print(json.dumps({'environment':default_environment(),'runtime':runtime,'devOnly':sorted(set(dev)-set(runtime)),'runtimeEdges':edges,'excludedMarkers':excluded,'devDeclarations':devdecl,'distributions':rows,'uvLockSha256':hashlib.sha256((root/'uv.lock').read_bytes()).hexdigest()}))
`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const pythonInventory = JSON.parse(python)
  const fixedSources = []
  for (const source of manifest.sources) fixedSources.push({ ...source, currentLicenseTexts: await texts(source.path) })
  fixedSources.push({ name: 'awiki-open-server', path: join(sources, 'awiki-open-server'), licenseTexts: await texts(join(sources, 'awiki-open-server')) })
  return { observedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
    lock: { currentSha256: hash(lockBytes), historicalSha256: manifest.lockSha256, historicalComparison },
    entryScope: {
      minimalDeclarations: 'roles are minimum declared runtime closures, not actual loaded process closures',
      mixedHarness: ['adapters/normal-relay.mjs statically imports both SDKs', 'common/protocol-client.mjs and common/wire.mjs statically import A2A SDK', 'common/business-child.mjs and driver paths include both candidate entries'],
      peerAccounting: 'Express belongs to actual independent A2A peer, not each edge',
      baseline: 'Official DSH Host is an external shared baseline prerequisite; root dependency tree is not assigned to either candidate',
      actualLoaded: { status: 'not-run', reason: 'No new entry execution or module trace authorized in inventory phase' }
    },
    roles, javascriptPackages: [...packages.values()].map(row => ({ ...row, sharedByRoles: Object.entries(roles).filter(([, role]) => role.runtimePaths.includes(row.path)).map(([name]) => name) })),
    python: pythonInventory, fixedSources, provenance: await json(join(sources, 'awiki-installation-provenance.json')),
    boundaries: ['Declaration closure and installed resolution are distinct from loaded trace; all role traces not-run', 'Optional/platform declarations and Python dev/extras/marker edges are separate', 'License metadata and located text are facts only; missing jcs text remains unknown; no legal judgment', 'No installation, producer, service, resource measurement, size attribution or winner'] }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2]); await mkdir(output, { recursive: true })
  const result = await inventoryRoles(); await writeFile(join(output, 'role-inventory.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ output, javascriptLocations: result.lock.historicalComparison.length, roles: Object.fromEntries(Object.entries(result.roles).map(([k,v]) => [k,v.runtimePaths.length])), pythonRuntime: result.python.runtime.length, pythonDevOnly: result.python.devOnly.length, pythonInstalled: result.python.distributions.length, loadedTrace: 'not-run' }, null, 2))
}
