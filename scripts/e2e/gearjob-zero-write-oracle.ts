import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const mariaContainer = 'gearjob_dev-mariadb-1';
const redisContainers = ['gearjob_dev-redis-cache-1', 'gearjob_dev-redis-queue-1'] as const;
const oracleRedisCommands = new Set(['dump', 'info', 'keys']);
const sha256Pattern = /^[a-f0-9]{64}$/u;

type RedisCommandSnapshot = Readonly<Record<string, Readonly<Record<string, number>>>>;
type RedisStateSnapshot = Readonly<Record<string, string>>;

export type GearJobZeroWriteOracle = Readonly<{
  originalGeneralLog: boolean;
  since: string;
  mariaStateSha256: string;
  mariaSchemaCount: number;
  redisCommands: RedisCommandSnapshot;
  redisStateSha256: RedisStateSnapshot;
}>;

export type GearJobZeroWriteResult = Readonly<{
  mariaMutatingStatementCount: number;
  mariaSchemaCount: number;
  mariaStateBeforeSha256: string;
  mariaStateAfterSha256: string;
  mariaStateUnchanged: boolean;
  redisMutatingCommandCount: number;
  redisMutationDelta: Readonly<Record<string, Readonly<Record<string, number>>>>;
  redisStateBeforeSha256: RedisStateSnapshot;
  redisStateAfterSha256: RedisStateSnapshot;
  redisStateUnchanged: boolean;
}>;

function dockerText(arguments_: readonly string[]): string {
  return execFileSync('docker', [...arguments_], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  }).trim();
}

function dockerBytes(arguments_: readonly string[]): Buffer {
  return execFileSync('docker', [...arguments_], {
    encoding: 'buffer', maxBuffer: 512 * 1024 * 1024,
  });
}

function mariaQuery(sql: string): string {
  return dockerText(['exec', '-e', `GENEWAY_ORACLE_SQL=${sql}`, mariaContainer, 'sh', '-lc',
    'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" -Nse "$GENEWAY_ORACLE_SQL"']);
}

function mariaStateSnapshot(): Readonly<{ sha256: string; schemaCount: number }> {
  const schemas = mariaQuery(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
    WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY SCHEMA_NAME`)
    .split('\n').map((value) => value.trim()).filter(Boolean);
  if (schemas.length === 0 || schemas.some((value) => !/^[A-Za-z0-9_$-]+$/u.test(value))) {
    throw new Error('GearJob MariaDB business schema inventory is empty or unsafe');
  }
  const dump = dockerBytes(['exec', mariaContainer, 'sh', '-lc',
    'exec mariadb-dump -uroot -p"$MYSQL_ROOT_PASSWORD" --skip-comments --skip-dump-date '
      + '--skip-lock-tables --single-transaction --hex-blob --order-by-primary --routines --events --triggers '
      + '--databases "$@"', 'geneway-zero-write-oracle', ...schemas]);
  if (dump.length === 0) throw new Error('GearJob MariaDB state snapshot is empty');
  return { sha256: createHash('sha256').update(dump).digest('hex'), schemaCount: schemas.length };
}

function redisCommandCalls(info: string): Readonly<Record<string, number>> {
  const calls: Record<string, number> = {};
  for (const line of info.split('\n')) {
    const match = line.trim().match(/^cmdstat_([^:]+):calls=(\d+)/u);
    if (match?.[1] !== undefined && match[2] !== undefined) calls[match[1]] = Number(match[2]);
  }
  return calls;
}

function redisCommandSnapshot(): RedisCommandSnapshot {
  return Object.fromEntries(redisContainers.map((container) => [container,
    redisCommandCalls(dockerText(['exec', container, 'redis-cli', 'INFO', 'commandstats']))]));
}

function isRedisKeyArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((key: unknown) => typeof key === 'string' && !key.includes('\0'));
}

function redisStateSnapshot(): RedisStateSnapshot {
  return Object.fromEntries(redisContainers.map((container) => {
    const rawKeys = dockerText(['exec', container, 'redis-cli', '--json', 'KEYS', '*']);
    const parsed: unknown = JSON.parse(rawKeys);
    if (!isRedisKeyArray(parsed)) {
      throw new Error(`GearJob Redis key inventory is invalid for ${container}`);
    }
    const keys = [...parsed].sort();
    const hash = createHash('sha256');
    hash.update(`${container}\0${String(keys.length)}\0`, 'utf8');
    for (const key of keys) {
      const dump = dockerBytes(['exec', container, 'redis-cli', '--raw', 'DUMP', key]);
      hash.update(`${Buffer.byteLength(key, 'utf8')}:`, 'utf8').update(key, 'utf8');
      hash.update(`${dump.length}:`, 'utf8').update(dump);
    }
    return [container, hash.digest('hex')];
  }));
}

function nestedStrings(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value.toLowerCase()];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => nestedStrings(entry));
}

function redisCommandIsNonMutating(container: string, command: string): boolean {
  const baseCommand = command.split('|')[0];
  if (baseCommand === undefined || baseCommand.length === 0) return false;
  const raw = dockerText(['exec', container, 'redis-cli', '--json', 'COMMAND', 'INFO', baseCommand]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null) return false;
  const metadata = new Set(nestedStrings(parsed[0]));
  const writes = ['write', '@write', 'rw', 'ow', 'rm', 'update', 'insert', 'delete'];
  const reads = metadata.has('readonly') || metadata.has('@read') || metadata.has('ro');
  const connectionOnly = metadata.has('@connection');
  return (reads || connectionOnly) && !writes.some((flag) => metadata.has(flag));
}

function redisMutationDelta(
  before: RedisCommandSnapshot,
  after: RedisCommandSnapshot,
): Readonly<Record<string, Readonly<Record<string, number>>>> {
  return Object.fromEntries(Object.entries(after).flatMap(([container, calls]) => {
    const previous = before[container] ?? {};
    const mutations = Object.fromEntries(Object.entries(calls).flatMap(([command, count]) => {
      const difference = Math.max(0, count - (previous[command] ?? 0));
      if (difference === 0 || oracleRedisCommands.has(command) || redisCommandIsNonMutating(container, command)) return [];
      return [[command, difference]];
    }));
    return Object.keys(mutations).length === 0 ? [] : [[container, mutations]];
  }));
}

export function startZeroWriteOracle(): Promise<GearJobZeroWriteOracle> {
  return Promise.resolve().then(() => {
    const originalGeneralLog = mariaQuery('SELECT @@global.general_log') === '1';
    const since = mariaQuery('SET GLOBAL general_log=ON; SELECT UTC_TIMESTAMP(6)');
    try {
      const redisCommands = redisCommandSnapshot();
      const mariaState = mariaStateSnapshot();
      const redisStateSha256 = redisStateSnapshot();
      return {
        originalGeneralLog, since, redisCommands, redisStateSha256,
        mariaStateSha256: mariaState.sha256, mariaSchemaCount: mariaState.schemaCount,
      };
    } catch (error) {
      if (!originalGeneralLog) {
        try { mariaQuery('SET GLOBAL general_log=OFF'); } catch { /* best-effort restoration */ }
      }
      throw error;
    }
  });
}

export function finishZeroWriteOracle(oracle: GearJobZeroWriteOracle): Promise<GearJobZeroWriteResult> {
  return Promise.resolve().then(() => {
    try {
      if (!sha256Pattern.test(oracle.mariaStateSha256)
        || Object.values(oracle.redisStateSha256).some((digest) => !sha256Pattern.test(digest))) {
        throw new Error('GearJob zero-write baseline digest is invalid');
      }
      const mariaState = mariaStateSnapshot();
      const redisStateAfterSha256 = redisStateSnapshot();
      const sql = `SELECT COUNT(*) FROM mysql.general_log WHERE event_time>='${oracle.since}'
        AND command_type IN ('Query','Execute') AND argument NOT LIKE '%mysql.general_log%'
        AND NOT (UPPER(TRIM(argument)) REGEXP
          '^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|SET|START[[:space:]]+TRANSACTION|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE[[:space:]]+SAVEPOINT|USE)([[:space:]]|$)')`;
      const mariaMutatingStatementCount = Number(mariaQuery(sql));
      if (!Number.isSafeInteger(mariaMutatingStatementCount) || mariaMutatingStatementCount < 0) {
        throw new Error('GearJob MariaDB mutation count is invalid');
      }
      const redisAfter = redisCommandSnapshot();
      const redisMutation = redisMutationDelta(oracle.redisCommands, redisAfter);
      const redisMutatingCommandCount = Object.values(redisMutation).reduce((total, commands) =>
        total + Object.values(commands).reduce((subtotal, count) => subtotal + count, 0), 0);
      const mariaStateUnchanged = mariaState.sha256 === oracle.mariaStateSha256
        && mariaState.schemaCount === oracle.mariaSchemaCount;
      const redisStateUnchanged = JSON.stringify(redisStateAfterSha256) === JSON.stringify(oracle.redisStateSha256);
      return {
        mariaMutatingStatementCount,
        mariaSchemaCount: mariaState.schemaCount,
        mariaStateBeforeSha256: oracle.mariaStateSha256,
        mariaStateAfterSha256: mariaState.sha256,
        mariaStateUnchanged,
        redisMutatingCommandCount,
        redisMutationDelta: redisMutation,
        redisStateBeforeSha256: oracle.redisStateSha256,
        redisStateAfterSha256,
        redisStateUnchanged,
      };
    } finally {
      if (!oracle.originalGeneralLog) {
        try { mariaQuery('SET GLOBAL general_log=OFF'); } catch { /* best-effort restoration */ }
      }
    }
  });
}
