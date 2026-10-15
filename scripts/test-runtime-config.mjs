import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDshHome, readModelCredential, readRuntimeConfig, validateRuntimeConfig } from '../src/runtime-config.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-runtime-config-'))
try {
  const home = join(root, 'home'), secretRoot = join(root, 'secrets')
  const dshHome = join(root, 'dsh')
  assert.doesNotThrow(() => assertDshHome(dshHome, { DSH_HOME: dshHome }))
  assert.doesNotThrow(() => assertDshHome(dshHome, { DSH_HOME: join(dshHome, 'nested', '..') }))
  for (const env of [{}, { DSH_HOME: '' }, { DSH_HOME: 'relative' }, { DSH_HOME: join(root, 'other') }]) {
    assert.throws(() => assertDshHome(dshHome, env), error => error.code === 'RUNTIME_HOME_MISMATCH')
  }
  await mkdir(join(home, '.claude'), { recursive: true })
  const settingsPath = join(home, '.claude', 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'unrelated-product-secret' } }))
  const withoutReference = readRuntimeConfig({ HOME: home, GENEWAY_ZENMUX_SETTINGS_FILE: settingsPath }, root)
  assert.equal(withoutReference.model.configured, false)
  await assert.rejects(readModelCredential(withoutReference), error => error.code === 'MODEL_NOT_CONFIGURED')

  await mkdir(secretRoot, { mode: 0o700 })
  const keyPath = join(secretRoot, 'model.key')
  const config = readRuntimeConfig({ GENEWAY_SECRET_ROOT: secretRoot, GENEWAY_MODEL_CREDENTIAL_REF: 'model.key' }, root)
  assert.equal(config.model.provider, 'zenmux')
  assert.equal(config.model.model, 'deepseek/deepseek-v4.1-flash')
  assert.equal(config.model.baseUrl, 'https://zenmux.ai/api/v1')
  assert.equal(config.model.configured, true)
  assert.equal(JSON.stringify(config).includes('unrelated-product-secret'), false)
  await assert.rejects(readModelCredential(config), error => error.code === 'MODEL_NOT_CONFIGURED')
  await writeFile(keyPath, 'explicit-local-test-key\n', { mode: 0o600 })
  assert.equal(await readModelCredential(config), 'explicit-local-test-key')
  assert.equal(await validateRuntimeConfig(config), config)
  for (const ref of ['../model.key', '/model.key', '..']) {
    await assert.rejects(readModelCredential({ ...config, model: { ...config.model, credentialRef: ref } }), error => error.code === 'MODEL_NOT_CONFIGURED')
  }
  await symlink(keyPath, join(secretRoot, 'alias.key'))
  await assert.rejects(readModelCredential({ ...config, model: { ...config.model, credentialRef: 'alias.key' } }), error => error.code === 'MODEL_NOT_CONFIGURED')
  await chmod(keyPath, 0o644)
  await assert.rejects(readModelCredential(config), error => error.code === 'MODEL_NOT_CONFIGURED')
  await chmod(keyPath, 0o600)
  for (const content of ['', 'first\nsecond', 'key with spaces']) {
    await writeFile(keyPath, content)
    await assert.rejects(readModelCredential(config), error => error.code === 'MODEL_NOT_CONFIGURED' && !error.message.includes(content || 'test-key'))
  }
  console.log('Runtime model credentials require an explicit Geneway reference; path, mode and single-key checks passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
