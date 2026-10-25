import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { test, expect, startServer } from '../../fixtures/server';

test.describe('app launch', () => {
  test('shows the first-run setup screen and a healthy server', async ({ app }) => {
    const response = await app.request.get(`${app.baseURL}/health`);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');

    const health = await response.json();
    expect(health).toMatchObject({
      status: 'ok',
      emulator: 'stopped',
      clients: { total: expect.any(Number) },
    });
    expect(typeof health.version).toBe('string');
    expect(health.version.length).toBeGreaterThan(0);
    expect(typeof health.uptime).toBe('number');

    await expect(app.page.getByRole('heading', { name: 'Twitch Plays GB' })).toBeVisible();
    await expect(app.page.getByRole('heading', { name: 'First-run setup' })).toBeVisible();
    await expect(app.page.getByText('Before you start')).toBeVisible();
    await expect(
      app.page.getByText(/You must supply your own legally obtained ROMs/),
    ).toBeVisible();
    await expect(app.page.getByLabel('Twitch channel')).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(app.page.getByTestId('server-status-label')).toHaveText('online');
  });

  test('returns a JSON 404 for unknown API routes instead of proxying them', async ({ app }) => {
    const response = await app.request.get(`${app.baseURL}/api/nope`, {
      headers: { accept: '*/*' },
    });

    expect(response.status()).toBe(404);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Not found' });

    const encoded = await app.request.get(`${app.baseURL}/api%2Fnope`, {
      headers: { accept: 'text/html' },
    });
    expect(encoded.status()).toBe(404);
    expect(encoded.headers()['content-type']).toContain('application/json');
  });

  test('returns 404 for missing built asset paths in embedded Vite mode', async ({ app }) => {
    const response = await app.request.get(`${app.baseURL}/assets/missing.js`, {
      headers: { accept: '*/*' },
    });

    expect(response.status()).toBe(404);

    const htmlResponse = await app.request.get(`${app.baseURL}/assets/missing`, {
      headers: { accept: 'text/html' },
    });
    expect(htmlResponse.status()).toBe(404);

    const encoded = await app.request.get(`${app.baseURL}/assets%2Fmissing.js`, {
      headers: { accept: 'text/html' },
    });
    expect(encoded.status()).toBe(404);
  });

  test('advances to ROM import without persisting settings before Finish', async ({ app }) => {
    const before = await app.request.get(`${app.baseURL}/api/settings`);
    expect(before.status()).toBe(200);
    expect(await before.json()).toEqual({ channel: null, romId: null, firstRun: true });

    await app.page.getByLabel('Twitch channel').fill('example');
    await app.page.getByRole('button', { name: 'Continue' }).click();

    await expect(app.page.getByTestId('setup-step')).toHaveAttribute('data-step', '2');
    await expect(app.page.getByTestId('rom-file-input')).toBeVisible();
    await expect(app.page.getByRole('heading', { name: 'First-run setup' })).toBeVisible();

    const after = await app.request.get(`${app.baseURL}/api/settings`);
    expect(after.status()).toBe(200);
    expect(await after.json()).toEqual({ channel: null, romId: null, firstRun: true });
  });

  test('recovers from malformed persisted JSON instead of failing startup', async () => {
    const server = await startServer({
      prepareDataDir: async (dataDir) => {
        await writeFile(join(dataDir, 'settings.json'), '{"version":1,"channel":"truncated');
        await writeFile(join(dataDir, 'roms.json'), '{"version":1,"roms":[');
      },
    });

    try {
      const health = await fetch(`${server.baseURL}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok', emulator: 'stopped' });

      const settings = await fetch(`${server.baseURL}/api/settings`);
      expect(settings.status).toBe(200);
      expect(await settings.json()).toEqual({ channel: null, romId: null, firstRun: true });

      const roms = await fetch(`${server.baseURL}/api/roms`);
      expect(roms.status).toBe(200);
      expect(await roms.json()).toEqual({ roms: [] });

      const logs = server.getLogs();
      expect(logs).toMatch(/settings file is invalid/i);
      expect(logs).toMatch(/ROM index is invalid/i);
    } finally {
      await server.stop();
    }
  });

  test('answers ping on /ws without disturbing Vite HMR upgrades', async ({ server }) => {
    const socket = new WebSocket(`${server.baseURL.replace(/^http/, 'ws')}/ws`);

    try {
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'ping' }));

      // The server also sends hello/state messages on connect; wait for pong.
      for (;;) {
        const [data] = await once(socket, 'message');
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'pong') {
          expect(message).toEqual({ type: 'pong' });
          break;
        }
      }
    } finally {
      socket.close();
    }
  });
});
