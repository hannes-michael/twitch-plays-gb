import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const serverUrl = process.env.TPG_SERVER_URL ?? 'http://127.0.0.1:3000';
const wsUrl = serverUrl.replace(/^http/, 'ws');

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fromRoot('./src/shared'),
      '@web': fromRoot('./web'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': serverUrl,
      '/health': serverUrl,
      '/ws': { target: wsUrl, ws: true },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
});
