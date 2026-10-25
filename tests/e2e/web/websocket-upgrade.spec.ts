import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import type { Page } from '@playwright/test';
import WebSocket from 'ws';
import { expect, startServer, test } from '../../fixtures/server';

function openRawUpgrade(baseURL: string, path: string): Promise<Socket> {
  const target = new URL(path, baseURL);
  const socket = connect({ host: target.hostname, port: Number(target.port) });
  socket.on('error', () => {});

  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${target.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      );
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function readUntilClose(socket: Socket, timeoutMs = 3_000): Promise<string> {
  let received = '';

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`socket did not close within ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString();
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (received !== '') resolve(received);
      else reject(error);
    });
  });
}

test.describe('websocket upgrades', () => {
  test('rejects unknown upgrade paths with 400 and closes the socket', async ({ server }) => {
    const socket = await openRawUpgrade(server.baseURL, '/bogus');

    try {
      const response = await readUntilClose(socket);
      expect(response).toContain('HTTP/1.1 400 Bad Request');
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  test('keeps /ws and HMR alive and shuts down after an unknown upgrade attempt', async ({
    browser,
  }) => {
    const server = await startServer();
    let page: Page | undefined;
    let unknownSocket: Socket | undefined;
    let stopped = false;

    try {
      page = await browser.newPage();
      const errors: string[] = [];
      let hmrConnected = false;
      page.on('pageerror', (error) => {
        errors.push(`pageerror: ${error.message}`);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          errors.push(`console error: ${message.text()}`);
        }
        if (message.text().includes('[vite] connected.')) {
          hmrConnected = true;
        }
      });

      await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'First-run setup' })).toBeVisible();
      await expect.poll(() => hmrConnected).toBe(true);
      expect(errors).toEqual([]);

      const appSocket = new WebSocket(`${server.baseURL.replace(/^http/, 'ws')}/ws`);
      try {
        await once(appSocket, 'open');
        appSocket.send(JSON.stringify({ type: 'ping' }));

        // Skip the connect-time hello/state messages and wait for pong.
        for (;;) {
          const [data] = await once(appSocket, 'message');
          const message = JSON.parse(data.toString()) as { type?: string };
          if (message.type === 'pong') {
            expect(message).toEqual({ type: 'pong' });
            break;
          }
        }
      } finally {
        appSocket.close();
      }

      unknownSocket = await openRawUpgrade(server.baseURL, '/still-bogus?x=1');
      // Give the server time to process the upgrade headers. A leaked socket
      // would block http.Server.close() until the forced-exit timeout.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const startedAt = Date.now();
      await server.stop();
      stopped = true;
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      if (process.platform !== 'win32') {
        expect(server.exitCode).toBe(0);
      }
    } finally {
      unknownSocket?.destroy();
      await page?.close();
      if (!stopped) {
        await server.stop().catch(() => {});
      }
    }
  });
});
