import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ mode }) => {
  // The server passes mode "embedded" when it mounts Vite as middleware. In
  // that mode the standalone dev-web proxy must be absent: its fixed port
  // would otherwise receive API and health traffic from the random-port server.
  const embedded = mode === 'embedded';
  const serverUrl = process.env.TPG_SERVER_URL ?? 'http://127.0.0.1:3000';
  const wsUrl = serverUrl.replace(/^http/, 'ws');

  return {
    root: 'web',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': fromRoot('./src/shared'),
        '@web': fromRoot('./web'),
      },
    },
    ...(embedded
      ? {}
      : {
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
        }),
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      sourcemap: true,
    },
  };
});
