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

function safeDecodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function isPathWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
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

  // Future API routes belong on this router, before the 404 fallback, so they
  // cannot be shadowed by it. The router is mounted before Vite/static so the
  // embedded Vite middleware never proxies API traffic.
  const apiRouter = express.Router();
  apiRouter.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });
  app.use('/api', apiRouter);

  // Express router mounts do not match encoded slashes (e.g. /api%2Fnope), so
  // normalize for the API guard as well.
  app.use((request, response, next) => {
    if (isPathWithin(safeDecodePath(request.path), '/api')) {
      response.status(404).json({ error: 'Not found' });
      return;
    }
    next();
  });

  if (config.dev || config.test) {
    logger.info('mounting Vite middleware (development/test mode)');

    // Built asset paths are reserved for production. In embedded mode they do
    // not exist unless a public asset is present, and Vite would otherwise
    // serve its SPA fallback for a missing asset request.
    app.use((request, response, next) => {
      const decodedPath = safeDecodePath(request.path);
      if (!isPathWithin(decodedPath, '/assets')) {
        next();
        return;
      }
      if (existsSync(join(webRoot, 'public', decodedPath))) {
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
        // Vite's HMR socket stays on its own loopback port so it cannot clash
        // with the app's /ws endpoint on the main HTTP server. Keep it enabled
        // in test mode too: Vite always injects its client, and disabling only
        // the socket would surface as an unhandled renderer error.
        ws: { host: config.host },
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

  // Static lets real assets through; anything left under /assets is missing,
  // including encoded variants such as /assets%2Fmissing.
  app.use((request, response, next) => {
    if (isPathWithin(safeDecodePath(request.path), '/assets')) {
      response.status(404).json({ error: 'Not found' });
      return;
    }
    next();
  });

  app.use((request, response, next) => {
    const accept = request.get('accept') ?? '';
    const methodAllowsBody = request.method === 'GET' || request.method === 'HEAD';
    const isRoot = request.path === '/';
    const isNavigation = methodAllowsBody && (isRoot || accept.includes('text/html'));
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
