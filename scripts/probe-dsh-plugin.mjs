import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dshBin = join(root, 'node_modules', '.bin', 'dsh')
const patch = join(root, 'config', 'p1-diagnostic.patch.yml')

try {
  accessSync(dshBin, constants.X_OK)
  accessSync(patch, constants.R_OK)
} catch {
  console.error('DSH diagnostic prerequisites are not installed')
  process.exit(2)
}

const child = spawn(dshBin, ['--profile', 'sdk', '--patch', patch], {
  cwd: root,
  env: { ...process.env, DSH_TELEMETRY_MODE: 'DISABLED' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })

const timeout = setTimeout(() => {
  child.kill('SIGTERM')
}, 10_000)

child.on('close', (code, signal) => {
  clearTimeout(timeout)
  const result = { code, signal, stdout, stderr }
  if (!stderr.includes('GENEWAY_P1_DSH_TOOL_RESULT')) {
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }
  console.log(JSON.stringify(result, null, 2))
})

// SDK startup treats stdin EOF as a clean shutdown; the diagnostic plugin runs
// during composition before that shutdown is observed.
child.stdin.end()
