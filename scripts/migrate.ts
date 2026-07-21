import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('geneway-schema-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const migrationDirectory = path.join(root, 'migrations');
    const filenames = (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
    for (const filename of filenames) {
      const sql = await readFile(path.join(migrationDirectory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = await client.query<{ checksum_sha256: string }>('SELECT checksum_sha256 FROM schema_migrations WHERE filename=$1', [filename]);
      const existing = applied.rows[0];
      if (existing !== undefined) {
        if (existing.checksum_sha256 !== checksum) throw new Error(`Applied migration checksum changed: ${filename}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename,checksum_sha256) VALUES ($1,$2)', [filename, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('geneway-schema-migrations'))").catch(() => undefined);
    client.release();
  }
} finally {
  await pool.end();
}
