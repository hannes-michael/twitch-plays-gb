import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { AppConfig } from '../shared/config';
import type { Logger } from './logger';
import type { ServerState } from './state';
import { readPackageVersion } from './version';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const webRoot = join(projectRoot, 'web');
const distWebRoot = join(projectRoot, 'dist', 'web');
const viteConfigPath = join(projectRoot, 'vite.config.ts');

export interface AppContext {
  app: Express;
  close(): Promise<void>;
}

export async function createApp(
  config: AppConfig,
  state: ServerState,
  logger: Logger,
): Promise<AppContext> {
  const app = express();
  app.disable('x-powered-by');

  const version = readPackageVersion();
  const startedAt = Date.now();

  app.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      version,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      emulator: state.emulator,
      clients: { total: state.clients },
    });
  });

  if (config.dev || config.test) {
    logger.info('mounting Vite middleware (development/test mode)');
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: viteConfigPath,
      root: webRoot,
      appType: 'spa',
      server: {
        middlewareMode: true,
        hmr: config.dev ? { host: config.host } : false,
      },
    });
    app.use(vite.middlewares);

    return {
      app,
      close: async () => {
        await vite.close();
      },
    };
  }

  logger.info('serving production web assets');
  if (!existsSync(join(distWebRoot, 'index.html'))) {
    throw new Error(
      `Web build not found at ${distWebRoot}. Run "npm run build:web" before starting the server.`,
    );
  }

  app.use(express.static(distWebRoot));
  app.use((request, response, next) => {
    if (request.method !== 'GET' || !request.accepts('html')) {
      next();
      return;
    }
    response.sendFile(join(distWebRoot, 'index.html'), (error) => {
      if (error) next(error);
    });
  });

  return {
    app,
    close: async () => {},
  };
}
