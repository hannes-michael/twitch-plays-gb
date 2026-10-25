import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
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
    response.set('Cache-Control', 'no-store');
    response.json({
      status: 'ok',
      version,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      emulator: state.emulator,
      clients: { total: state.clients },
    });
  });

  // Unknown API routes are JSON 404s in every mode. Registering this before
  // Vite/static also stops the embedded Vite middleware from proxying /api to
  // the standalone dev-web server on port 3000.
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  if (config.dev || config.test) {
    logger.info('mounting Vite middleware (development/test mode)');

    // Built asset paths are reserved for production. In embedded mode they do
    // not exist unless a public asset is present, and Vite would otherwise
    // serve its SPA fallback for a missing asset request.
    app.use((request, response, next) => {
      if (request.path !== '/assets' && !request.path.startsWith('/assets/')) {
        next();
        return;
      }
      if (existsSync(join(webRoot, 'public', request.path))) {
        next();
        return;
      }
      response.status(404).json({ error: 'Not found' });
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: viteConfigPath,
      root: webRoot,
      mode: 'embedded',
      appType: 'spa',
      server: {
        middlewareMode: true,
        // Vite's HMR WebSocket uses its own port for now; attaching it to the
        // main HTTP server is a P0-07 follow-up.
        ws: config.dev ? { host: config.host } : false,
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

  app.use(express.static(distWebRoot, { index: false }));
  app.use((request, response, next) => {
    const accept = request.get('accept') ?? '';
    const isNavigation = request.method === 'GET' && accept.includes('text/html');
    if (!isNavigation || extname(request.path) !== '') {
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
