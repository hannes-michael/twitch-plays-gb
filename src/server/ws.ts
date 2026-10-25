import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { Logger } from './logger';
import type { ServerState } from './state';

const WS_PATH = '/ws';

export function createWebSocketServer(
  httpServer: HttpServer,
  state: ServerState,
  logger: Logger,
): WebSocketServer {
  // Use noServer so this server only claims its own upgrade path. Vite attaches
  // its HMR upgrade listener to the same HTTP server; a path-scoped
  // `new WebSocketServer({ server, path })` would abort Vite's upgrades.
  const wss = new WebSocketServer({ noServer: true });

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return;
    }

    if (pathname !== WS_PATH) return;

    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit('connection', webSocket, request);
    });
  };

  httpServer.on('upgrade', handleUpgrade);
  wss.on('close', () => {
    httpServer.off('upgrade', handleUpgrade);
  });

  wss.on('connection', (socket) => {
    state.clients += 1;
    logger.debug(`websocket client connected (${state.clients} total)`);

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
