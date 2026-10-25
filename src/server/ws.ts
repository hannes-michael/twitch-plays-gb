import type { Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Logger } from './logger';
import type { ServerState } from './state';

export function createWebSocketServer(
  httpServer: HttpServer,
  state: ServerState,
  logger: Logger,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

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
