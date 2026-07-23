import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { canonicalize } from 'json-canonicalize';
import {
  BusinessExceptionRepository,
  type BusinessExceptionFixture,
} from '../apps/control-plane/src/business-exception-repository.js';

const { Pool } = pg;

const fixedFixtures = [
  {
    file: new URL('./fixtures/gate0.2b/capacity-progress-lag.v1.json', import.meta.url),
    sha256: '0aaf071f5cb062251011970b382e239d3ae5fdcdc4f977b96f325825723b2ed6',
  },
  {
    file: new URL('./fixtures/gate0.2b/equipment-alarm.v1.json', import.meta.url),
    sha256: 'c8de7202aa3d5a395bbc96df13776fbdc68591687d6e0fbd144d1c9a1e5ea593',
  },
] as const;

function requiredEnvironment(name: 'DATABASE_URL' | 'GENEWAY_TENANT_ID'): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function loopbackDatabaseHost(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Gate 0.2B fixture seed requires a loopback PostgreSQL host');
  }
  return parsed.hostname;
}

async function readFixedFixtures(): Promise<readonly BusinessExceptionFixture[]> {
  return Promise.all(fixedFixtures.map(async ({ file, sha256 }) => {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    const canonicalBytes = canonicalize(parsed);
    const actualSha256 = createHash('sha256').update(canonicalBytes, 'utf8').digest('hex');
    if (actualSha256 !== sha256) {
      throw new Error(`Gate 0.2B fixture hash mismatch: ${file.pathname}`);
    }
    return { canonicalBytes, expectedSha256: sha256 };
  }));
}

const databaseUrl = requiredEnvironment('DATABASE_URL');
const tenantId = requiredEnvironment('GENEWAY_TENANT_ID');
const databaseHost = loopbackDatabaseHost(databaseUrl);
const fixtures = await readFixedFixtures();
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const repository = new BusinessExceptionRepository(pool, randomBytes(32).toString('hex'));

try {
  const seeded = await repository.seedFixedFixtures({
    nodeEnvironment: process.env.NODE_ENV,
    controlPlaneHost: databaseHost,
    tenantId,
    fixtures,
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'geneway-gate0.2b-seed-result/1',
    tenantId,
    fixtures: seeded,
  })}\n`);
} finally {
  await pool.end();
}
