import { createControlPlane } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');

const { app } = await createControlPlane({ databaseUrl, logger: true });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3100) });
