import { constants } from 'node:fs';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createControlPlane } from './index.js';
import { createWorkerCommandApp } from './worker-command-server.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const webPort = Number(process.env.GENEWAY_WEB_PORT ?? 3200);
if (!Number.isInteger(webPort)) throw new Error('GENEWAY_WEB_PORT must be an integer');

const { app, repository, artifactService } = await createControlPlane({
  databaseUrl,
  logger: true,
  allowedOrigins: [`http://localhost:${String(webPort)}`, `http://127.0.0.1:${String(webPort)}`],
});
const workerSocketPath = process.env.GENEWAY_WORKER_SOCKET_PATH;
const workerTokenFile = process.env.GENEWAY_WORKER_TOKEN_FILE;
let workerApp: ReturnType<typeof createWorkerCommandApp> | null = null;
if ((workerSocketPath === undefined) !== (workerTokenFile === undefined)) {
  throw new Error('Worker socket path and token file must be configured together');
}
if (workerSocketPath !== undefined && workerTokenFile !== undefined) {
  if (artifactService === null) throw new Error('Worker command service requires configured artifact storage');
  if (!isAbsolute(workerSocketPath) || workerSocketPath.includes('\0') || Buffer.byteLength(workerSocketPath) > 100) {
    throw new Error('Worker socket path must be a short absolute Unix-domain socket path');
  }
  if (!isAbsolute(workerTokenFile)) throw new Error('Worker token file path must be absolute');
  const tokenStat = await lstat(workerTokenFile);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.uid !== process.getuid?.()
    || (tokenStat.mode & 0o777) !== 0o600 || tokenStat.size < 32 || tokenStat.size > 4_096) {
    throw new Error('Worker token file must be an owned regular 0600 file with a bounded secret');
  }
  const tokenHandle = await open(workerTokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let workerToken: string;
  try {
    workerToken = (await tokenHandle.readFile('utf8')).trim();
  } finally {
    await tokenHandle.close();
  }
  if (workerToken.length < 32 || /\s/u.test(workerToken)) throw new Error('Worker token must be a non-whitespace secret');
  workerApp = createWorkerCommandApp({ repository, storage: artifactService.storage, token: workerToken, logger: true });
  try {
    await unlink(workerSocketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await workerApp.listen({ path: workerSocketPath });
  await chmod(workerSocketPath, 0o600);
}
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3100) });

const shutdown = async (): Promise<void> => {
  if (workerApp !== null) await workerApp.close();
  await app.close();
  if (workerSocketPath !== undefined) {
    try {
      await unlink(workerSocketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
};

process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
