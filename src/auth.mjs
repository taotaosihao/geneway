import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const AUTH_VERSION = 1
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000

export function createAuthRuntime({ filePath, clock = Date.now, sessionTtlMs = DEFAULT_SESSION_TTL_MS }) {
  if (!filePath) throw new Error('auth file path is required')
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) throw new Error('session TTL is invalid')

  return {
    async verifyPassword(memberId, password) {
      const auth = await readAuthFile(filePath)
      const record = auth.passwords[requiredId(memberId)]
      const candidate = record ?? Object.values(auth.passwords)[0]
      const supplied = typeof password === 'string' && password.length <= 4096 ? password : ''
      const valid = await verifyPasswordRecord(supplied, candidate)
      return Boolean(record && typeof password === 'string' && password.length <= 4096 && valid)
    },

    async issueSession(member) {
      const memberId = requiredId(member?.id)
      const sessionVersion = requiredSessionVersion(member?.sessionVersion)
      const auth = await readAuthFile(filePath)
      const issuedAt = Number(clock())
      const expiresAt = issuedAt + sessionTtlMs
      const payload = { memberId, sessionVersion, issuedAt, expiresAt, nonce: randomBytes(16).toString('base64url') }
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
      const token = `${encoded}.${sign(encoded, auth.sessionSecret)}`
      return { token, csrfToken: csrf(token, auth.sessionSecret), expiresAt }
    },

    async verifySession(token) {
      const auth = await readAuthFile(filePath)
      return verifySessionToken(token, auth.sessionSecret, Number(clock()))
    },

    async verifyCsrf(token, candidate) {
      if (typeof token !== 'string' || typeof candidate !== 'string') return false
      const auth = await readAuthFile(filePath)
      return safeEqual(candidate, csrf(token, auth.sessionSecret))
    },
  }
}

export function isSessionCurrent(session, member) {
  return Boolean(session && member?.enabled === true && session.memberId === member?.id && session.sessionVersion === member?.sessionVersion)
}

export async function initializeAuthFile(filePath, passwords, { mode = 'create', allowedMemberIds } = {}) {
  if (!filePath) throw new Error('auth file path is required')
  const entries = Object.entries(passwords ?? {})
  if (!entries.length) throw new Error('at least one member password is required')
  if (!['create', 'rekey'].includes(mode)) throw new Error('auth initialization mode is invalid')
  const allowed = allowedMemberIds === undefined ? undefined : new Set(allowedMemberIds.map(requiredId))
  if (allowed && entries.some(([memberId]) => !allowed.has(requiredId(memberId)))) throw new Error('auth password member is not present in product facts')

  let existing
  try {
    existing = await readAuthFile(filePath)
    if (mode === 'create') throw new Error('auth file already exists; use rekey mode explicitly')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    existing = { passwords: {} }
  }
  const records = { ...existing.passwords }
  for (const [memberId, password] of entries) records[requiredId(memberId)] = await createPasswordRecord(password)
  const value = { version: AUTH_VERSION, sessionSecret: randomBytes(32).toString('base64url'), passwords: records }
  await atomicWrite(filePath, value)
}

async function createPasswordRecord(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 4096) throw new Error('password must contain 8 to 4096 characters')
  const salt = randomBytes(16)
  const verifier = await scrypt(password, salt, 64)
  return { algorithm: 'scrypt', salt: salt.toString('base64url'), verifier: verifier.toString('base64url') }
}

async function verifyPasswordRecord(password, record) {
  try {
    if (record?.algorithm !== 'scrypt') return false
    const expected = Buffer.from(record.verifier, 'base64url')
    const actual = await scrypt(password, Buffer.from(record.salt, 'base64url'), expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

async function readAuthFile(filePath) {
  const metadata = await stat(filePath)
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new Error('auth file must be a regular 0600 file')
  const value = JSON.parse(await readFile(filePath, 'utf8'))
  if (value?.version !== AUTH_VERSION || decode(value?.sessionSecret, 32) === undefined || !value.passwords || typeof value.passwords !== 'object' || Array.isArray(value.passwords)) throw new Error('auth file is invalid')
  for (const [memberId, record] of Object.entries(value.passwords)) {
    requiredId(memberId)
    if (record?.algorithm !== 'scrypt' || decode(record.salt, 16) === undefined || decode(record.verifier, 64) === undefined) throw new Error('auth file is invalid')
  }
  return value
}

function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === length && decoded.toString('base64url') === value ? decoded : undefined
}

function verifySessionToken(token, secret, now) {
  if (typeof token !== 'string' || token.length > 4096) return undefined
  const [encoded, signature, extra] = token.split('.')
  if (!encoded || !signature || extra || !safeEqual(signature, sign(encoded, secret))) return undefined
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (requiredId(payload.memberId) !== payload.memberId) return undefined
    requiredSessionVersion(payload.sessionVersion)
    if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) || payload.issuedAt > now || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt || typeof payload.nonce !== 'string' || !payload.nonce) return undefined
    return payload
  } catch {
    return undefined
  }
}

function sign(value, secret) {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(value).digest('base64url')
}

function csrf(token, secret) {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update('csrf\0').update(token).digest('base64url')
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length > 4096 || right.length > 4096) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function requiredId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value)) throw new Error('member id is invalid')
  return value
}

function requiredSessionVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('session version is invalid')
  return value
}

async function atomicWrite(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = join(dirname(filePath), `.${filePath.split('/').pop()}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(tempPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(tempPath, filePath)
}
