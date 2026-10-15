import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dshBin = join(root, 'node_modules', '.bin', 'dsh')

try {
  accessSync(dshBin, constants.X_OK)
} catch {
  console.error(`DSH binary is not installed: ${dshBin}`)
  process.exit(2)
}

const dshHome = mkdtempSync(join(tmpdir(), 'geneway-dsh-config-'))

function run(args) {
  const result = spawnSync(dshBin, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'DISABLED',
    },
    timeout: 30_000,
  })
  return {
    args,
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error?.message,
  }
}

try {
  const version = run(['-V'])
  const config = run(['--profile', 'sdk', '--dump-default-config'])
  if (version.status !== 0 || config.status !== 0) {
    console.error(JSON.stringify({ version, config }, null, 2))
    process.exitCode = 1
  } else {
    console.log(JSON.stringify({ dshBin, version, config: { ...config, stdoutBytes: Buffer.byteLength(config.stdout) } }, null, 2))
  }
} finally {
  rmSync(dshHome, { recursive: true, force: true })
}
