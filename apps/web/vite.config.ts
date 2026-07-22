import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webPort = Number(process.env.GENEWAY_WEB_PORT ?? 3200);
const controlPlanePort = Number(process.env.GENEWAY_CONTROL_PLANE_PORT ?? 3100);
const webHost = process.env.GENEWAY_WEB_HOST ?? '127.0.0.1';
if (!Number.isInteger(webPort) || !Number.isInteger(controlPlanePort)) throw new Error('GENEWAY ports must be integers');
if (webHost.length === 0 || /[\s/]/u.test(webHost)) throw new Error('GENEWAY_WEB_HOST must be a non-empty host');

export default defineConfig({
  plugins: [react()],
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${String(controlPlanePort)}`, '/health': `http://127.0.0.1:${String(controlPlanePort)}` },
  },
});
