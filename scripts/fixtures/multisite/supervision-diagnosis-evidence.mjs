import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

export async function readDiagnosisSessions(root) {
  const paths = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    const logs = entries.filter(entry => entry.isFile() && ['session.v4.jsonl', 'session.v4.jsonl.zstd'].includes(entry.name))
    if (logs.length) {
      // This SDK appends complete zstd frames to one compressed file. Its
      // backend rejects an opposite encoding; two copies are never tail pieces.
      assert.equal(logs.length, 1, 'Ambiguous Session encodings: ' + directory)
      assert(!entries.some(entry => entry.isFile() && (entry.name === 'tail.jsonl' || entry.name.includes('.tail.'))), 'Unsupported separate Session tail: ' + directory)
      paths.push(join(directory, logs[0].name))
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(root)
  const sessions = []
  for (const path of paths) {
    const compressed = path.endsWith('.zstd')
    const bytes = compressed ? (await promisify(execFile)('zstd', ['-dc', '--', path], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 })).stdout : await readFile(path)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    assert(text.endsWith('\n'), 'Incomplete Session JSONL record: ' + path)
    const events = text.slice(0, -1).split('\n').map(JSON.parse)
    assert(events[0]?.type === 'session' && events[0].version === 4 && typeof events[0].id === 'string' && events[0].id, 'Missing native Session header: ' + path)
    for (let index = 1; index < events.length; index++) {
      assert(events[index].type !== 'session' && events[index].seq === index - 1, 'Duplicate or missing Session sequence at record ' + index + ': ' + path)
    }
    sessions.push({ path, encoding: compressed ? 'zstd' : 'none', decodedBytes: bytes.length, sessionId: events[0].id, events })
  }
  return sessions
}

export async function readOptionalJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw cause }
}
