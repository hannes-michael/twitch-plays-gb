import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../shared/config';
import type { DebugSnapshot } from '../shared/debug';
import type { RomImportResponse, RomListResponse, RomResponse } from '../shared/roms';
import { normalizeTwitchChannel, type EmulatorOperationResponse } from '../shared/settings';
import type { Logger } from './logger';
import type { ServerState } from './state';
import type { EmulatorService, EmulatorStartOptions } from './emulator/service';
import { ChatInputError, ChatUnavailableError, type ChatService } from './chat/service';
import type { RomStore } from './roms/store';
import { RomImportError } from './roms/store';
import { SettingsValidationError, type SettingsStore } from './settings';
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

function bodyObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function createApp(
  config: AppConfig,
  state: ServerState,
  logger: Logger,
  httpServer: HttpServer,
  emulator: EmulatorService,
  roms: RomStore,
  settings: SettingsStore,
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
  const jsonBody = express.json({ limit: '8kb' });

  const resolveRomStart = (
    romId: string | undefined,
  ): { options: EmulatorStartOptions } | { status: number; error: string } => {
    if (!romId) return { status: 400, error: 'No ROM selected' };

    const rom = roms.get(romId);
    const romPath = roms.getPath(romId);
    if (!rom || !romPath) return { status: 404, error: 'Unknown ROM' };

    return {
      options: {
        romPath,
        romId,
        batterySavePath: join(config.dataDir, 'saves', `${romId}.sav`),
      },
    };
  };

  apiRouter.get('/emulator/status', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(emulator.status());
  });

  apiRouter.get('/settings', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(settings.get());
  });

  apiRouter.post('/settings', jsonBody, async (request, response, next) => {
    try {
      const body = bodyObject(request.body);
      const channelValue = body.channel;
      const romIdValue = body.romId;

      if (typeof channelValue !== 'string') {
        response.status(400).json({ error: 'Invalid Twitch channel' });
        return;
      }

      const channel = normalizeTwitchChannel(channelValue);
      if (!channel) {
        response.status(400).json({ error: 'Invalid Twitch channel' });
        return;
      }

      if (typeof romIdValue !== 'string') {
        response.status(400).json({ error: 'ROM is required' });
        return;
      }

      if (!roms.get(romIdValue)) {
        response.status(404).json({ error: 'Unknown ROM' });
        return;
      }

      response.json(await settings.save(channel, romIdValue));
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  apiRouter.get('/roms', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    const body: RomListResponse = { roms: roms.list() };
    response.json(body);
  });

  apiRouter.get('/roms/:id', (request, response) => {
    const rom = roms.get(request.params.id);
    if (!rom) {
      response.status(404).json({ error: 'Unknown ROM' });
      return;
    }

    response.set('Cache-Control', 'no-store');
    const body: RomResponse = { rom };
    response.json(body);
  });

  apiRouter.post(
    '/roms',
    express.raw({ type: 'application/octet-stream', limit: '32mb' }),
    async (request, response, next) => {
      try {
        const filename = request.get('x-filename');
        if (!filename) {
          response.status(400).json({ error: 'Missing x-filename header' });
          return;
        }

        if (!Buffer.isBuffer(request.body)) {
          response.status(400).json({ error: 'Send ROM bytes as application/octet-stream' });
          return;
        }

        const result = await roms.importRom(request.body, filename);
        const body: RomImportResponse = result;
        response.status(result.created ? 201 : 200).json(body);
      } catch (error) {
        if (error instanceof RomImportError) {
          response.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
      }
    },
  );

  apiRouter.post('/emulator/start', jsonBody, async (request, response, next) => {
    try {
      const body = bodyObject(request.body);
      if (body.romId !== undefined && typeof body.romId !== 'string') {
        response.status(400).json({ error: 'Invalid ROM id' });
        return;
      }

      const romId =
        (typeof body.romId === 'string' ? body.romId : undefined) ??
        settings.getRomId() ??
        undefined;
      const resolved = resolveRomStart(romId);
      if ('error' in resolved) {
        response.status(resolved.status).json({ error: resolved.error });
        return;
      }

      await emulator.start(resolved.options);
      // A failed boot is a status, not a transport failure: the UI needs the
      // error text and the server must stay up so the user can pick another ROM.
      const payload: EmulatorOperationResponse = { status: emulator.status() };
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  apiRouter.post('/emulator/stop', async (_request, response, next) => {
    try {
      await emulator.stop();
      const payload: EmulatorOperationResponse = { status: emulator.status() };
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  apiRouter.post('/emulator/restart', jsonBody, async (request, response, next) => {
    try {
      const body = bodyObject(request.body);
      if (body.romId !== undefined && typeof body.romId !== 'string') {
        response.status(400).json({ error: 'Invalid ROM id' });
        return;
      }

      const romId =
        (typeof body.romId === 'string' ? body.romId : undefined) ??
        emulator.status().romId ??
        settings.getRomId() ??
        undefined;
      const resolved = resolveRomStart(romId);
      if ('error' in resolved) {
        response.status(resolved.status).json({ error: resolved.error });
        return;
      }

      await emulator.restart(resolved.options);
      const payload: EmulatorOperationResponse = { status: emulator.status() };
      response.json(payload);
    } catch (error) {
      next(error);
    }
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
