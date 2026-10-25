import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../shared/config';
import type { DebugSnapshot } from '../shared/debug';
import type { Logger } from './logger';
import type { ServerState } from './state';
import type { EmulatorService } from './emulator/service';
import { ChatInputError, ChatUnavailableError, type ChatService } from './chat/service';
import { VITE_HMR_PATH } from './upgrade-paths';
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

const LOOPBACK_PEER_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function requireLoopbackPeer(request: Request, response: Response, next: NextFunction): void {
  if (LOOPBACK_PEER_ADDRESSES.has(request.socket.remoteAddress ?? '')) {
    next();
    return;
  }
  response.status(403).json({ error: 'Developer endpoints are loopback-only' });
}

export async function createApp(
  config: AppConfig,
  state: ServerState,
  logger: Logger,
  httpServer: HttpServer,
  emulator: EmulatorService,
  chat: ChatService,
): Promise<AppContext> {
  const app = express();
  app.disable('x-powered-by');

  const version = readPackageVersion();
  const startedAt = Date.now();

  const mode = config.test ? 'test' : config.dev ? 'dev' : 'production';

  app.get('/health', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({
      status: 'ok',
      version,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      mode,
      emulator: state.emulator,
      clients: { total: state.clients },
    });
  });

  // Future API routes belong on this router, before the 404 fallback, so they
  // cannot be shadowed by it. The router is mounted before Vite/static so the
  // embedded Vite middleware never proxies API traffic.
  const apiRouter = express.Router();
  apiRouter.get('/emulator/status', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(emulator.status());
  });

  // Developer endpoints exist only in dev/test. Production falls through to the
  // JSON 404 below, so neither debug state nor chat injection is reachable.
  if (config.dev || config.test) {
    apiRouter.get('/debug', requireLoopbackPeer, (_request, response) => {
      const emulatorStatus = emulator.status();
      const snapshot: DebugSnapshot = {
        mode,
        timings: config.timings,
        emulator: emulatorStatus,
        chat: { ...chat.getStatus(), recent: chat.getRecent() },
        clients: { total: state.clients },
        media: {
          videoFrames: emulatorStatus.videoFrames,
          audioChunks: emulatorStatus.audioChunks,
          fps: emulatorStatus.fps,
          audioSampleRate: emulatorStatus.audioSampleRate,
        },
        queue: { length: 0, votes: 0 },
      };
      response.set('Cache-Control', 'no-store');
      response.json(snapshot);
    });

    const jsonBody = express.json({ limit: '8kb' });
    apiRouter.post('/test/chat', requireLoopbackPeer, jsonBody, (request, response) => {
      try {
        const message = chat.injectFakeMessage(request.body);
        response.status(201).json({ ok: true, message });
      } catch (error) {
        if (error instanceof ChatInputError) {
          response.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof ChatUnavailableError) {
          response.status(503).json({ error: error.message });
          return;
        }
        throw error;
      }
    });
  }

  apiRouter.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const bodyError = error as { type?: string };
    if (bodyError.type === 'entity.parse.failed') {
      response.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    if (bodyError.type === 'entity.too.large') {
      response.status(413).json({ error: 'Request body too large' });
      return;
    }
    response.status(500).json({ error: 'Internal server error' });
  });

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
        // Attach Vite's HMR WebSocket to the main HTTP server on a dedicated
        // path. This keeps dev/test on a single server (and a single random
        // port) instead of a shared fixed 24678 listener that would collide
        // between concurrent servers.
        ws: { server: httpServer, path: VITE_HMR_PATH },
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
