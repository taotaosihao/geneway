import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webPort = Number(process.env.GENEWAY_WEB_PORT ?? 3200);
const controlPlanePort = Number(process.env.GENEWAY_CONTROL_PLANE_PORT ?? 3100);
if (!Number.isInteger(webPort) || !Number.isInteger(controlPlanePort)) throw new Error('GENEWAY ports must be integers');

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${String(controlPlanePort)}`, '/health': `http://127.0.0.1:${String(controlPlanePort)}` },
  },
});
