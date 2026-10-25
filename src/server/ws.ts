import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { MEDIA_PROTOCOL_VERSION } from '../shared/media-protocol';
import type { ChatService } from './chat/service';
import type { EmulatorService } from './emulator/service';
import type { InputService } from './input/service';
import type { Logger } from './logger';
import type { ServerState } from './state';
import { APP_WS_PATH, upgradePathname } from './upgrade-paths';

export interface WebSocketServerOptions {
  /** Upgrade paths owned by another listener (Vite HMR in dev/test). */
  passThroughPaths?: readonly string[];
  /** Emulator status source and binary media hub. */
  emulator: EmulatorService;
  /** Chat status and text-message broadcast source. */
  chat: ChatService;
  /** Input queue state and broadcast source. */
  input: InputService;
}

function rejectUpgrade(socket: Duplex): void {
  const netSocket = socket as Socket;
  netSocket.on('error', () => {});

  const body = 'Bad Request';
  const response = [
    'HTTP/1.1 400 Bad Request',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${body.length}`,
    '',
    body,
  ].join('\r\n');

  try {
    netSocket.write(response);
    netSocket.destroySoon();
  } catch {
    netSocket.destroy();
  }
}

export function createWebSocketServer(
  httpServer: HttpServer,
  state: ServerState,
  logger: Logger,
  options: WebSocketServerOptions,
): WebSocketServer {
  // Use noServer so this server only claims its own upgrade path. Vite attaches
  // its HMR upgrade listener to the same HTTP server; a path-scoped
  // `new WebSocketServer({ server, path })` would abort Vite's upgrades.
  const wss = new WebSocketServer({ noServer: true });
  const passThroughPaths = new Set(options.passThroughPaths ?? []);

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = upgradePathname(request.url);

    if (pathname === APP_WS_PATH) {
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit('connection', webSocket, request);
      });
      return;
    }

    // Vite's listener owns its path and has already handled the upgrade.
    if (pathname !== undefined && passThroughPaths.has(pathname)) return;

    // Never leave unknown upgrades half-open: they would block graceful
    // shutdown until the forced-exit timeout.
    rejectUpgrade(socket);
  };

  const broadcast = (payload: unknown): void => {
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  const unsubscribeEmulator = options.emulator.onStatusChange((emulatorStatus) => {
    broadcast({ type: 'state', emulator: emulatorStatus });
  });
  const unsubscribeChat = options.chat.subscribe((message) => {
    broadcast({ type: 'chat', message });
  });
  const unsubscribeInput = options.input.subscribe((inputState) => {
    broadcast({ type: 'input-state', input: inputState });
  });

  httpServer.on('upgrade', handleUpgrade);
  wss.on('close', () => {
    unsubscribeEmulator();
    unsubscribeChat();
    unsubscribeInput();
    httpServer.off('upgrade', handleUpgrade);
  });

  wss.on('connection', (socket) => {
    state.clients += 1;
    logger.debug(`websocket client connected (${state.clients} total)`);

    socket.send(JSON.stringify({ type: 'hello', protocol: MEDIA_PROTOCOL_VERSION }));
    socket.send(JSON.stringify({ type: 'state', emulator: options.emulator.status() }));
    socket.send(JSON.stringify({ type: 'chat-status', chat: options.chat.getStatus() }));
    socket.send(JSON.stringify({ type: 'input-state', input: options.input.getState() }));
    options.emulator.attachClient(socket);

    socket.on('close', () => {
      state.clients = Math.max(0, state.clients - 1);
      logger.debug(`websocket client disconnected (${state.clients} total)`);
    });

    socket.on('error', (error) => {
      logger.warn(`websocket error: ${error.message}`);
    });

    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        logger.debug('ignoring non-JSON websocket message');
        return;
      }

      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: unknown }).type === 'ping'
      ) {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });
  });

  wss.on('error', (error: NodeJS.ErrnoException) => {
    // The HTTP server's error listener owns bind failures such as EADDRINUSE.
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') return;
    logger.error(`websocket server error: ${error.message}`);
  });

  return wss;
}
