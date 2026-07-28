import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { GATE_A3_GEARJOB_BASE_URL } from '@geneway/contracts';
import { createConnectorGateway } from './index.js';

async function readSecret(filePath: string | undefined, name: string): Promise<string> {
  if (filePath === undefined || !isAbsolute(filePath)) throw new Error(`${name} file path is required and must be absolute`);
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o600 || stat.size < 32 || stat.size > 4_096) {
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

async function readGearJobCredential(filePath: string | undefined): Promise<string> {
  const encoded = await readSecret(filePath, 'GearJob service credential');
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error('GearJob service credential must use the approved JSON file format');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'apiKey,apiSecret') {
    throw new Error('GearJob service credential shape is invalid');
  }
  const credential = value as Readonly<Record<string, unknown>>;
  if (typeof credential.apiKey !== 'string' || typeof credential.apiSecret !== 'string'
    || !/^[^:\s]{16,256}$/u.test(credential.apiKey) || !/^[^:\s]{16,256}$/u.test(credential.apiSecret)) {
    throw new Error('GearJob service credential values are invalid');
  }
  return `${credential.apiKey}:${credential.apiSecret}`;
}

const app = createConnectorGateway({
  serviceToken: await readSecret(process.env.GENEWAY_CONNECTOR_GATEWAY_SERVICE_TOKEN_FILE, 'Connector Gateway service token'),
  invocationSecret: await readSecret(process.env.GENEWAY_CONNECTOR_GATEWAY_INVOCATION_SECRET_FILE, 'Connector invocation secret'),
  receiptSecret: await readSecret(process.env.GENEWAY_CONNECTOR_GATEWAY_RECEIPT_SECRET_FILE, 'Connector receipt secret'),
  gearJobCredential: await readGearJobCredential(process.env.GENEWAY_GEARJOB_SERVICE_CREDENTIAL_FILE),
  controlPlaneUrl: process.env.GENEWAY_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3100',
  facadeBaseUrl: process.env.GENEWAY_GEARJOB_FACADE_URL ?? GATE_A3_GEARJOB_BASE_URL,
  logger: true,
});

await app.listen({ host: '127.0.0.1', port: Number(process.env.GENEWAY_CONNECTOR_GATEWAY_PORT ?? 3155) });

const shutdown = (): void => { void app.close(); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
