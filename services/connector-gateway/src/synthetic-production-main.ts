import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createSyntheticProductionGateway } from './synthetic-production-gateway.js';

const tokenFile = process.env.GENEWAY_SYNTHETIC_PRODUCTION_SERVICE_TOKEN_FILE;
if (tokenFile === undefined || !isAbsolute(tokenFile)) throw new Error('Synthetic production service token file is required');
const stat = await lstat(tokenFile);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
  || (stat.mode & 0o777) !== 0o600 || stat.size < 32 || stat.size > 4_096) {
  throw new Error('Synthetic production service token must be an owned regular 0600 file');
}
const handle = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
let serviceToken: string;
try { serviceToken = (await handle.readFile('utf8')).trim(); } finally { await handle.close(); }
const port = Number(process.env.PORT ?? 3165);
if (!Number.isInteger(port) || port !== 3165) throw new Error('Synthetic production gateway port must be 3165');
const app = createSyntheticProductionGateway({ serviceToken, logger: true });
await app.listen({ host: '127.0.0.1', port });
const shutdown = async () => app.close();
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
