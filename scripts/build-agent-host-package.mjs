import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile, lstat, readlink, realpath, copyFile, symlink, chmod, cp, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { packageIdentity } from '../packages/agent-host/offline-update.mjs'
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..'), output = resolve(process.argv[2] ?? '')
assert(process.argv[2] && !output.startsWith(source + sep), 'Use a new external output directory')
await mkdir(output, { recursive: false })
const packageRoot = join(output, 'geneway-agent-host'); await mkdir(packageRoot)
const baseline = process.argv[3] ? resolve(process.argv[3]) : null
let paired
if (baseline) { paired = await packageIdentity(baseline); await cp(baseline, packageRoot, { recursive: true, verbatimSymlinks: true }); await rm(join(packageRoot, 'build-manifest.json')) }
const excludedWorkspaceLinks = [], files = new Set(), sources = new Set(), dependencies = new Set(), copied = new Set()
async function copy(path) {
  path = resolve(path); if(copied.has(path)) return; copied.add(path)
  assert(path.startsWith(source + sep)); const destination = join(packageRoot, relative(source, path)), stat = await lstat(path)
  await mkdir(dirname(destination), { recursive: true })
  if(stat.isSymbolicLink()) { const target = await realpath(path); if(!target.startsWith(join(source,'node_modules')+sep)){assert(path.startsWith(join(source,'node_modules/.pnpm/node_modules/@geneway')+sep));excludedWorkspaceLinks.push(relative(source,path));return} const rel = relative(dirname(destination), join(packageRoot,relative(source,target))); await symlink(rel,destination); await copy(target); if(target.includes('/node_modules/.pnpm/')) { const bucket=target.slice(0,target.indexOf('/node_modules/',source.length+'/node_modules/.pnpm/'.length)); if(bucket.length>source.length) await copy(bucket) } }
  else if(stat.isDirectory()) { await mkdir(destination,{recursive:true}); for(const entry of await readdir(path)) await copy(join(path,entry)) }
  else if(stat.isFile()) { await copyFile(path,destination); files.add(relative(source,path)) }
}
async function sourceFile(path) {
  path=resolve(path);if(sources.has(path))return;sources.add(path);await copy(path)
  if(!/\.[cm]?js$/.test(path))return
  const text=await readFile(path,'utf8')
  for(const match of text.matchAll(/(?:from\s*|import\s*\(|import\s*)['"]([^'"]+)['"]/g)) {
    const name=match[1];if(!/^[a-zA-Z@.][a-zA-Z0-9@_./+-]*$/.test(name)||name.startsWith('node:'))continue
    if(name.startsWith('.')) { const target=resolve(dirname(path),name);if(target.endsWith('.mjs')||target.endsWith('.js'))await sourceFile(target) }
    else dependencies.add(name.startsWith('@')?name.split('/').slice(0,2).join('/'):name.split('/')[0])
  }
}
const rootPackage=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
if (!baseline) {
for(const folder of ['packages/agent-host','packages/agent-contracts']) for(const entry of await readdir(join(source,folder))) if(entry.endsWith('.mjs'))await sourceFile(join(source,folder,entry))
await sourceFile(join(source,'src/dsh-host.mjs'));await copy(join(source,'config/multisite-runtime.patch.yml'));for(const name of ['incident-register-v1.json','incident-collaboration-v1.json','incident-register-v1.xlsx','incident-collaboration-v1.xlsx'])await copy(join(source,'templates',name))

for(const dependency of dependencies)await copy(join(source,'node_modules',dependency))
// pnpm's installed hoisted fallback is used by official DSH runtime plugin resolution.
await copy(join(source,'node_modules/.pnpm/node_modules'))
}
if (baseline) {
  const previous = JSON.parse(await readFile(join(baseline, 'build-manifest.json'), 'utf8'))
  for (const name of previous.sourceFiles) sources.add(join(source, name))
  for (const name of ['distribution.mjs', 'offline-update.mjs']) { await copyFile(join(source, 'packages/agent-host', name), join(packageRoot, 'packages/agent-host', name)); sources.add(join(source, 'packages/agent-host', name)) }
  for (const name of Object.keys(previous.dependencies)) dependencies.add(name)
}
await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'geneway-agent-host-internal',private:true,type:'module',engines:{node:'>=24'}},null,2))
await mkdir(join(packageRoot,'bin'),{recursive:true});for(const name of ['host','diagnostics','update']){await copyFile(join(source,'packages/agent-host/distribution',name),join(packageRoot,'bin',name));await chmod(join(packageRoot,'bin',name),0o755)}
await copyFile(join(source,'packages/agent-host/distribution/README.md'),join(packageRoot,'README.md'))
const inventory=[],transitivePackages=[]
async function inspect(path){for(const entry of await readdir(path)){const target=join(path,entry),stat=await lstat(target),name=relative(packageRoot,target);if(stat.isSymbolicLink()){const resolved=await realpath(target);assert(resolved.startsWith(packageRoot+sep),'External package symlink');inventory.push({path:name,symlink:await readlink(target)})}else if(stat.isDirectory())await inspect(target);else {inventory.push({path:name,bytes:stat.size});if(name.startsWith('node_modules/')&&entry==='package.json'){try{const pkg=JSON.parse(await readFile(target,'utf8'));if(pkg.name&&pkg.version)transitivePackages.push({name:pkg.name,version:pkg.version,path:name})}catch{}}}}}
await inspect(packageRoot)
const manifest={schema:'geneway.host-package/1',version:'internal-linux-x64-1',platform:'linux',arch:'x64',nodeMajor:24,profile:'g-office-disabled',dependencies:Object.fromEntries([...dependencies].sort().map(name=>[name,rootPackage.dependencies[name]??'transitive'])),transitivePackages,excludedWorkspaceLinks,sourceFiles:[...sources].map(path=>relative(source,path)).sort(),files:inventory}
if (baseline) { manifest.dependencies = paired.manifest.dependencies; manifest.transitivePackages = paired.manifest.transitivePackages; manifest.offlineUpdate = { pairedBuildId: paired.buildId, node: '26.5.0', journalVersion: 3, sessionFormat: 'paired-current-dsh-0.2.0-rc.2', acceptedArchiveSha256: 'aa4f13cb8e2000254904bb69e4d1648e25f1d6dfc778204ce475f3a72f0d2f08' } }
await writeFile(join(packageRoot,'build-manifest.json'),JSON.stringify(manifest,null,2))
manifest.buildId = (await packageIdentity(packageRoot)).buildId
await writeFile(join(packageRoot,'build-manifest.json'),JSON.stringify(manifest,null,2))
if (baseline && (await packageIdentity(packageRoot)).compatibility !== paired.compatibility) throw new Error('Baseline runtime contents changed')
const archive=join(output,'geneway-agent-host-linux-x64.tar.gz');execFileSync('tar',['-czf',archive,'-C',output,'geneway-agent-host'])
console.log(JSON.stringify({packageRoot,archive,files:inventory.length,dependencies:manifest.dependencies}))
