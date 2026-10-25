import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { loadConfig, HelpRequested } from '../shared/config';
import { createApp } from './app';
import { ChatService } from './chat/service';
import { ensureDataLayout, type DataLayout } from './data-dirs';
import { EmulatorService } from './emulator/service';
import { createLogger } from './logger';
import { RomStore } from './roms/store';
import { SettingsStore } from './settings';
import { createServerState } from './state';
import { VITE_HMR_PATH } from './upgrade-paths';
import { createWebSocketServer } from './ws';

const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  let config;

  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(`${error.message}\n`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Configuration error: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({
    level: config.logLevel,
    pretty: config.dev || config.test,
  });

  try {
    mkdirSync(config.dataDir, { recursive: true });
  } catch (error) {
    logger.error(`Could not create data directory ${config.dataDir}: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let layout: DataLayout;
  try {
    layout = ensureDataLayout(config.dataDir);
  } catch (error) {
    logger.error(`Could not create data subdirectories: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const roms = new RomStore(config.dataDir);
  const settings = new SettingsStore(config.dataDir, logger);
  try {
    await roms.init();
    await settings.init();
  } catch (error) {
    logger.error(`Could not load persisted data: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  logger.debug(
    `configuration: host=${config.host} port=${config.port} dataDir=${config.dataDir} ` +
      `dev=${config.dev} test=${config.test} logLevel=${config.logLevel}`,
  );
  logger.info(`data directory: ${config.dataDir}`);

  const state = createServerState();
  const emulator = new EmulatorService(logger);
  emulator.onStatusChange((emulatorStatus) => {
    state.emulator = emulatorStatus.status;
  });

  const chat = new ChatService(logger);
  if (config.dev || config.test) {
    await chat.startFake();
    logger.info('fake chat source started (development/test mode)');
  }

  const httpServer = createServer();
  let appContext;

  try {
    appContext = await createApp(config, state, logger, httpServer, emulator, roms, settings, chat);
  } catch (error) {
    logger.error(`Failed to initialize server: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const { app, close: closeApp } = appContext;
  httpServer.on('request', app);
  const wss = createWebSocketServer(httpServer, state, logger, {
    passThroughPaths: config.dev || config.test ? [VITE_HMR_PATH] : [],
    emulator,
    chat,
  });

  httpServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(
        `Port ${config.port} on ${config.host} is already in use. ` +
          'Stop the other process or choose another port with --port <port>.',
      );
    } else if (error.code === 'EACCES') {
      logger.error(
        `Permission denied while binding ${config.host}:${config.port}. ` +
          'Choose a port above 1024 or run with sufficient privileges.',
      );
    } else {
      logger.error(`Server error: ${error.message}`);
    }

    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void emulator
      .close()
      .catch((closeError: unknown) => {
        logger.error(
          `Failed to close emulator after startup error: ${(closeError as Error).message}`,
        );
      })
      .then(() => closeApp())
      .catch((closeError: unknown) => {
        logger.error(`Failed to close app after startup error: ${(closeError as Error).message}`);
      })
      .finally(() => {
        clearTimeout(forceExit);
        process.exit(1);
      });
  });

  const startSelectedRom = async (): Promise<void> => {
    // Explicit --rom configuration always wins over the persisted choice.
    if (config.rom) {
      await emulator.start({ romPath: config.rom, romId: null });
      return;
    }

    const romId = settings.getRomId();
    if (!romId) return;

    const romPath = roms.getPath(romId);
    if (!romPath) {
      logger.warn('saved ROM is not in the ROM library; emulator not started');
      return;
    }

    await emulator.start({
      romPath,
      romId,
      batterySavePath: join(layout.savesDir, `${romId}.sav`),
    });
  };

  httpServer.listen(config.port, config.host, () => {
    const address = httpServer.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : config.port;
    const url = `http://${config.host}:${actualPort}`;
    logger.info(`server listening on ${url}`);
    process.stdout.write(`TPG_URL=${url}\n`);

    // Start after listening so /health is available while the ROM boots. A
    // failed boot is reported through status/state instead of crashing.
    void startSelectedRom().catch((error: unknown) => {
      logger.error(`Failed to start configured ROM: ${(error as Error).message}`);
    });
  });

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);

    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    for (const client of wss.clients) {
      client.terminate();
    }

    wss.close(() => {
      void (async () => {
        // Close the emulator worker before Vite and HTTP so no native worker
        // outlives the server. Vite's HMR clients share this HTTP server, so
        // close Vite (and terminate its sockets) before waiting for HTTP.
        let appCloseFailed = false;
        try {
          await emulator.close();
        } catch (closeError: unknown) {
          appCloseFailed = true;
          logger.error(`Failed to close emulator: ${(closeError as Error).message}`);
        }

        try {
          await chat.close();
        } catch (closeError: unknown) {
          appCloseFailed = true;
          logger.error(`Failed to close chat: ${(closeError as Error).message}`);
        }

        try {
          await closeApp();
        } catch (closeError: unknown) {
          appCloseFailed = true;
          logger.error(`Failed to close app: ${(closeError as Error).message}`);
        }

        httpServer.close((error) => {
          if (error) logger.error(`HTTP server close error: ${error.message}`);
          httpServer.closeIdleConnections();
          clearTimeout(forceExit);
          process.exit(error || appCloseFailed ? 1 : 0);
        });

        httpServer.closeIdleConnections();
      })();
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
