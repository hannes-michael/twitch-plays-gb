import { once } from 'node:events';
import WebSocket from 'ws';
import { test, expect } from '../../fixtures/server';

interface ChatEvent {
  type: 'chat';
  message: { id: string; user: string; text: string };
}

test.describe('developer panels', () => {
  test('shows debug metrics, fake chat status, and resolved timings', async ({ app }) => {
    const panel = app.page.getByTestId('developer-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Developer' })).toBeVisible();

    await expect(app.page.getByTestId('debug-mode')).toHaveText('test');
    await expect(app.page.getByTestId('debug-emulator-status')).toHaveText('stopped');
    await expect(app.page.getByTestId('debug-chat-source')).toHaveText('fake');
    await expect(app.page.getByTestId('debug-chat-status')).toHaveText('connected');
    await expect(app.page.getByTestId('debug-chat-count')).toHaveText('0');
    await expect(app.page.getByTestId('debug-video-frames')).toHaveText('0');
    await expect(app.page.getByTestId('debug-audio-chunks')).toHaveText('0');
    await expect(app.page.getByTestId('debug-fps')).toHaveText('0.0');
    await expect(app.page.getByTestId('debug-audio-rate')).toHaveText('48000');
    await expect(app.page.getByTestId('debug-queue-length')).toHaveText('0');
    await expect(app.page.getByTestId('debug-queue-votes')).toHaveText('0');
    await expect(app.page.getByTestId('debug-democracy-window')).toHaveText('15000');
    await expect(app.page.getByTestId('debug-hold-frames')).toHaveText('8');
    await expect(app.page.getByTestId('debug-release-frames')).toHaveText('4');

    // The panel reports the server's real WebSocket client count, not a mock.
    await expect(app.page.getByTestId('debug-clients')).toHaveText('0');
    const socket = new WebSocket(`${app.baseURL.replace(/^http/, 'ws')}/ws`);
    try {
      await once(socket, 'open');
      await expect.poll(() => app.page.getByTestId('debug-clients').textContent()).toBe('1');
    } finally {
      socket.close();
    }
  });

  test('injects fake chat through the test API and developer form with escaped text', async ({
    app,
  }) => {
    const log = app.page.getByTestId('test-chat-log');
    await expect(log).toBeVisible();

    const chatEvents: ChatEvent[] = [];
    const socket = new WebSocket(`${app.baseURL.replace(/^http/, 'ws')}/ws`);
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'chat') chatEvents.push(message as ChatEvent);
      } catch {
        // Ignore non-JSON frames; this scenario only expects text chat events.
      }
    });

    try {
      await once(socket, 'open');

      const apiText = 'api <b>bold</b> & <img src=x onerror=alert(1)>';
      const valid = await app.request.post(`${app.baseURL}/api/test/chat`, {
        data: { user: 'alice', text: apiText },
      });
      expect(valid.status()).toBe(201);
      const body = await valid.json();
      expect(body).toMatchObject({
        ok: true,
        message: { user: 'alice', text: apiText },
      });
      expect(body.message.id).toEqual(expect.any(String));

      await expect.poll(() => chatEvents.length).toBe(1);
      expect(chatEvents[0]).toMatchObject({
        type: 'chat',
        message: { user: 'alice', text: apiText },
      });

      const apiEntry = app.page.getByTestId('test-chat-message').filter({ hasText: 'alice' });
      await expect(apiEntry).toBeVisible();
      await expect(apiEntry.getByTestId('test-chat-user')).toHaveText('alice');
      await expect(apiEntry.getByTestId('test-chat-text')).toHaveText(apiText);
      await expect(log.locator('b, img, script')).toHaveCount(0);

      const invalid = await app.request.post(`${app.baseURL}/api/test/chat`, {
        data: { user: 'alice', text: '' },
      });
      expect(invalid.status()).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'Invalid chat message' });

      const uiText = 'ui <script>alert(1)</script>';
      await app.page.getByLabel('Chat user').fill('viewer');
      await app.page.getByLabel('Chat message').fill(uiText);
      await app.page.getByTestId('test-chat-send').click();

      const uiEntry = app.page.getByTestId('test-chat-message').filter({ hasText: 'viewer' });
      await expect(uiEntry).toBeVisible();
      await expect(uiEntry.getByTestId('test-chat-text')).toHaveText(uiText);
      await expect(log.locator('b, img, script')).toHaveCount(0);
      await expect(app.page.getByTestId('debug-chat-count')).toHaveText('2');
    } finally {
      socket.close();
    }
  });
});
