import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const dshHome = mkdtempSync(join(tmpdir(), 'geneway-dsh-p1-'))
const client = new HarnessClient({
  dshBin,
  profile: 'sdk',
  dshHome,
  processCwd: root,
  initializeTimeoutMs: 10_000,
  env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' },
})

try {
  client.start()
  const initialized = await client.initialize({
    cwd: root,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  console.log(JSON.stringify({ initialized }, null, 2))
} finally {
  await client.close().catch(() => undefined)
  rmSync(dshHome, { recursive: true, force: true })
}
