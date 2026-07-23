import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createModelGateway } from './index.js';

async function readSecret(filePath: string | undefined, name: string): Promise<string> {
  if (filePath === undefined || !isAbsolute(filePath)) throw new Error(`${name} file path is required and must be absolute`);
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size < 32 || stat.size > 4_096) {
    throw new Error(`${name} file must be an owned regular 0600 file`);
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = (await handle.readFile('utf8')).trim();
    if (value.length < 32 || /\s/u.test(value)) throw new Error(`${name} is malformed`);
    return value;
  } finally {
    await handle.close();
  }
}

const app = await createModelGateway({
  serviceToken: await readSecret(process.env.GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE, 'Model Gateway service token'),
  invocationSecret: await readSecret(process.env.GENEWAY_MODEL_GATEWAY_INVOCATION_SECRET_FILE, 'Model Gateway invocation secret'),
  controlPlaneUrl: process.env.GENEWAY_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3100',
  ...(process.env.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE === undefined ? {} : {
    authFilePath: process.env.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE,
  }),
  ...(process.env.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE === undefined ? {} : {
    conformanceFilePath: process.env.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE,
  }),
  logger: true,
});

await app.listen({ host: '127.0.0.1', port: Number(process.env.GENEWAY_MODEL_GATEWAY_PORT ?? 3150) });

const shutdown = (): void => { void app.close(); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
