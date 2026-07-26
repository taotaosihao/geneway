#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { argv, stdout } from 'node:process';
import { TextDecoder } from 'node:util';

const INPUT_PATH = '/input/source';
const OUTPUT_PATH = '/output/canonical.bin';
const MAX_BYTES = 1_048_576;
const binaryMagic = [
  Uint8Array.of(0x25, 0x50, 0x44, 0x46),
  Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
  Uint8Array.of(0xff, 0xd8, 0xff),
  Uint8Array.of(0x47, 0x49, 0x46, 0x38),
  Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
  Uint8Array.of(0x7f, 0x45, 0x4c, 0x46),
  Uint8Array.of(0x4d, 0x5a),
  Uint8Array.of(0x1f, 0x8b),
];

/**
 * @param {Uint8Array} bytes
 * @param {Uint8Array} prefix
 * @returns {boolean}
 */
function startsWith(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasForbiddenControl(text) {
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if ((point <= 0x1f && point !== 0x09 && point !== 0x0a && point !== 0x0d)
      || (point >= 0x7f && point <= 0x9f)) return true;
  }
  return false;
}

async function main() {
  if (argv.length !== 2) throw new Error('plain-text parser accepts no runtime arguments');
  const metadata = await lstat(INPUT_PATH);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_BYTES) {
    throw new Error('parser input must be one bounded regular file');
  }
  const bytes = await readFile(INPUT_PATH);
  if (bytes.byteLength !== metadata.size || bytes.byteLength > MAX_BYTES
    || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    || bytes.includes(0) || binaryMagic.some((magic) => startsWith(bytes, magic))) {
    throw new Error('parser input violates the frozen text/plain byte policy');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('parser input is not valid UTF-8');
  }
  if (hasForbiddenControl(text)) throw new Error('parser input contains a forbidden control character');
  await writeFile(OUTPUT_PATH, bytes, { flag: 'wx', mode: 0o444 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  stdout.write(JSON.stringify({
    schemaVersion: 'geneway-plain-text-parser-result/1',
    inputBytes: bytes.byteLength,
    outputBytes: bytes.byteLength,
    canonicalTextSha256: sha256,
  }) + '\n');
}

await main();
