import { createControlPlane } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const webPort = Number(process.env.GENEWAY_WEB_PORT ?? 3200);
if (!Number.isInteger(webPort)) throw new Error('GENEWAY_WEB_PORT must be an integer');

const { app } = await createControlPlane({
  databaseUrl,
  logger: true,
  allowedOrigins: [`http://localhost:${String(webPort)}`, `http://127.0.0.1:${String(webPort)}`],
});
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3100) });
