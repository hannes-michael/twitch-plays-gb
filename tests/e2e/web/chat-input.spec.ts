import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '../../fixtures/server';

const romDir = fileURLToPath(new URL('../../fixtures/roms/', import.meta.url));

const inputTimings: NodeJS.ProcessEnv = {
  TPG_INPUT_COOLDOWN_MS: '100',
  TPG_INPUT_MAX_QUEUE: '2',
  TPG_INPUT_MAX_PER_SECOND: '2',
  TPG_INPUT_STALE_MS: '500',
  TPG_HOLD_FRAMES: '2',
  TPG_RELEASE_FRAMES: '1',
};

test.use({ emulatorRom: join(romDir, 'test_gb.gb'), serverEnv: inputTimings });

interface InputEvent {
  id: string;
  user: string;
  button: string;
  status: string;
  dropReason?: string;
  queuedAt: string;
  executedAt?: string;
}

interface InputSnapshot {
  mode: string;
  paused: boolean;
  queue: InputEvent[];
  recent: InputEvent[];
  stats: {
    accepted: number;
    executed: number;
    dropped: number;
    cooldownDrops: number;
    rateLimitDrops: number;
    queueFullDrops: number;
    staleDrops: number;
  };
  lastExecuted: { button: string; user: string; at: string } | null;
  lastDrop: { reason: string; user: string; at: string } | null;
}

interface EmulatorSnapshot {
  status: string;
  videoFrames: number;
  audioChunks: number;
}

interface ChatSnapshot {
  source: string;
  connected: boolean;
  messages: number;
  channel?: string;
  lastError?: string;
  recent?: Array<{ user: string; text: string }>;
}

interface DebugSnapshot {
  chat: ChatSnapshot;
  input: InputSnapshot;
  queue: { length: number; votes: number };
}

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  const text = await response.text();
  expect(response.status(), text).toBe(200);
  return JSON.parse(text) as T;
}

function readInput(request: APIRequestContext, baseURL: string): Promise<InputSnapshot> {
  return getJson<InputSnapshot>(request, `${baseURL}/api/input/state`);
}

async function injectChat(
  request: APIRequestContext,
  baseURL: string,
  user: string,
  text: string,
  roles?: Record<string, boolean>,
): Promise<void> {
  const response = await request.post(`${baseURL}/api/test/chat`, {
    data: { user, text, ...(roles ? { roles } : {}) },
  });
  expect(response.status(), await response.text()).toBe(201);
}

/**
 * Waits for the server's one-second sliding rate window to expire. This is a
 * real state boundary, not a fixed sleep: the window only contains accepted
 * attempts that are still recent.
 */
async function waitForRateWindow(request: APIRequestContext, baseURL: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await readInput(request, baseURL);
        const accepted = state.recent.filter((event) => event.status !== 'dropped');
        if (state.queue.length > 0 || accepted.length === 0) return false;
        const newest = Math.max(...accepted.map((event) => Date.parse(event.queuedAt)));
        return Date.now() - newest >= 1_100;
      },
      { timeout: 5_000, intervals: [50] },
    )
    .toBe(true);
}

test.describe('chat input', () => {
  test('executes anarchy input, drops cooldown, rate, and overflow, then drains the queue', async ({
    app,
  }) => {
    const pageErrors: string[] = [];
    app.page.on('pageerror', (error) => pageErrors.push(error.message));

    const response = await app.page.goto(`${app.baseURL}/overlay?client=obs`, {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.ok()).toBe(true);
    await expect(app.page.getByTestId('overlay-input-mode')).toHaveText('Anarchy');
    await expect(app.page.getByTestId('overlay-queue-count')).toHaveText('0');

    await expect
      .poll(
        async () =>
          (await getJson<EmulatorSnapshot>(app.request, `${app.baseURL}/api/emulator/status`))
            .status,
        { timeout: 20_000 },
      )
      .toBe('running');

    // Cooldown: the first command executes; the same user's immediate repeat is dropped.
    await injectChat(app.request, app.baseURL, 'alice', '!right');
    await injectChat(app.request, app.baseURL, 'alice', '!left');
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).stats.cooldownDrops)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).lastExecuted?.button)
      .toBe('RIGHT');
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).lastExecuted?.user)
      .toBe('alice');
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).stats.executed)
      .toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await readInput(app.request, app.baseURL)).queue.length).toBe(0);

    await waitForRateWindow(app.request, app.baseURL);

    // Seed one recent acceptance so the sliding window is deterministically
    // non-empty before the rate-cap attempt.
    await injectChat(app.request, app.baseURL, 'seed', '!b');
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).lastExecuted?.button)
      .toBe('B');
    await expect.poll(async () => (await readInput(app.request, app.baseURL)).queue.length).toBe(0);

    // Global rate cap: the seed plus one accepted command fill the window; the
    // next user is rejected.
    const beforeRateLimit = (await readInput(app.request, app.baseURL)).stats.rateLimitDrops;
    await injectChat(app.request, app.baseURL, 'bob', '!up');
    await injectChat(app.request, app.baseURL, 'carol', '!right');
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).stats.rateLimitDrops)
      .toBeGreaterThan(beforeRateLimit);
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).lastDrop?.reason)
      .toBe('rate-limit');
    await expect.poll(async () => (await readInput(app.request, app.baseURL)).queue.length).toBe(0);
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).stats.executed)
      .toBeGreaterThanOrEqual(3);

    await waitForRateWindow(app.request, app.baseURL);

    // Overflow: while stopped, two commands queue and the third is rejected.
    const stop = await app.request.post(`${app.baseURL}/api/emulator/stop`);
    expect(stop.status(), await stop.text()).toBe(200);
    await expect
      .poll(
        async () =>
          (await getJson<EmulatorSnapshot>(app.request, `${app.baseURL}/api/emulator/status`))
            .status,
        { timeout: 20_000 },
      )
      .toBe('stopped');

    const beforeQueueFull = (await readInput(app.request, app.baseURL)).stats.queueFullDrops;
    await injectChat(app.request, app.baseURL, 'dave', '!up');
    await injectChat(app.request, app.baseURL, 'erin', '!down');
    await injectChat(app.request, app.baseURL, 'frank', '!a');
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).stats.queueFullDrops)
      .toBeGreaterThan(beforeQueueFull);
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).lastDrop?.reason)
      .toBe('queue-full');

    const queued = await readInput(app.request, app.baseURL);
    expect(queued.queue.map((event) => event.button)).toEqual(['UP', 'DOWN']);
    expect(queued.queue.every((event) => event.status === 'queued')).toBe(true);
    await expect(app.page.getByTestId('overlay-queue-count')).toHaveText('2');

    const beforeDrain = queued.stats.executed;
    const start = await app.request.post(`${app.baseURL}/api/emulator/start`);
    expect(start.status(), await start.text()).toBe(200);
    await expect
      .poll(
        async () =>
          (await getJson<EmulatorSnapshot>(app.request, `${app.baseURL}/api/emulator/status`))
            .status,
        { timeout: 20_000 },
      )
      .toBe('running');
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).stats.executed, {
        timeout: 20_000,
      })
      .toBe(beforeDrain + 2);
    await expect.poll(async () => (await readInput(app.request, app.baseURL)).queue.length).toBe(0);
    await expect(app.page.getByTestId('overlay-queue-count')).toHaveText('0');

    const drained = await readInput(app.request, app.baseURL);
    expect(drained.stats).toMatchObject({
      accepted: 5,
      executed: 5,
      cooldownDrops: 1,
      rateLimitDrops: 1,
      queueFullDrops: 1,
    });
    expect(drained.recent).toHaveLength(8);
    expect(drained.recent.at(-1)).toMatchObject({
      user: 'frank',
      button: 'A',
      status: 'dropped',
      dropReason: 'queue-full',
    });

    const debug = await getJson<DebugSnapshot>(app.request, `${app.baseURL}/api/debug`);
    expect(debug.input).toMatchObject({ mode: 'anarchy', paused: false });
    expect(debug.input.stats.executed).toBe(5);
    expect(debug.queue).toMatchObject({ length: 0, votes: 0 });
    expect(debug.chat).toMatchObject({ source: 'fake', connected: true });

    await expect(app.page.getByTestId('overlay-recent-inputs')).toContainText('alice');
    await expect(app.page.getByTestId('overlay-recent-inputs')).toContainText('RIGHT');
    await expect(app.page.getByTestId('overlay-recent-inputs')).toContainText('queue-full');

    expect(pageErrors, 'page errors').toEqual([]);
  });

  test('ignores bots, self, bare, invalid, and meta messages and survives a chat outage', async ({
    app,
  }) => {
    const pageErrors: string[] = [];
    app.page.on('pageerror', (error) => pageErrors.push(error.message));

    const response = await app.page.goto(`${app.baseURL}/overlay?client=obs`, {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.ok()).toBe(true);
    await expect(app.page.getByTestId('emulator-status')).toHaveText('running');

    await injectChat(app.request, app.baseURL, 'nightbot', '!right', { bot: true });
    await injectChat(app.request, app.baseURL, 'streamer', '!right', { self: true });
    await injectChat(app.request, app.baseURL, 'viewer', 'right');
    await injectChat(app.request, app.baseURL, 'viewer', '!mode democracy', { mod: true });
    await injectChat(app.request, app.baseURL, 'viewer', '!not-a-button');

    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).stats.accepted)
      .toBe(0);
    const filtered = await readInput(app.request, app.baseURL);
    expect(filtered.recent).toEqual([]);
    expect(filtered.queue).toEqual([]);

    const beforeOutage = await getJson<ChatSnapshot>(app.request, `${app.baseURL}/api/chat`);
    expect(beforeOutage).toMatchObject({ source: 'fake', connected: true, messages: 5 });
    const debugBefore = await getJson<DebugSnapshot>(app.request, `${app.baseURL}/api/debug`);
    expect(debugBefore.chat.messages).toBe(5);
    expect(debugBefore.chat.recent?.map((message) => message.user)).toEqual([
      'nightbot',
      'streamer',
      'viewer',
      'viewer',
      'viewer',
    ]);

    const outage = await app.request.post(`${app.baseURL}/api/test/chat/outage`, {
      data: { outage: true },
    });
    const outageText = await outage.text();
    expect(outage.status(), outageText).toBe(200);
    const outageBody = JSON.parse(outageText) as { ok: boolean; chat: ChatSnapshot };
    expect(outageBody).toMatchObject({ ok: true, chat: { connected: false } });

    await expect
      .poll(
        async () => (await getJson<ChatSnapshot>(app.request, `${app.baseURL}/api/chat`)).connected,
      )
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await getJson<DebugSnapshot>(app.request, `${app.baseURL}/api/debug`)).chat.connected,
      )
      .toBe(false);

    const statusBefore = await getJson<EmulatorSnapshot>(
      app.request,
      `${app.baseURL}/api/emulator/status`,
    );
    expect(statusBefore.status).toBe('running');
    await expect
      .poll(
        async () =>
          (await getJson<EmulatorSnapshot>(app.request, `${app.baseURL}/api/emulator/status`))
            .videoFrames,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(statusBefore.videoFrames);
    await expect
      .poll(
        async () =>
          (await getJson<EmulatorSnapshot>(app.request, `${app.baseURL}/api/emulator/status`))
            .audioChunks,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(statusBefore.audioChunks);
    expect(
      (await getJson<EmulatorSnapshot>(app.request, `${app.baseURL}/api/emulator/status`)).status,
    ).toBe('running');

    // Injection is unavailable while the fake source is disconnected.
    const offlineInject = await app.request.post(`${app.baseURL}/api/test/chat`, {
      data: { user: 'viewer', text: '!right' },
    });
    expect(offlineInject.status()).toBe(503);

    const reconnect = await app.request.post(`${app.baseURL}/api/test/chat/outage`, {
      data: { outage: false },
    });
    expect(reconnect.status(), await reconnect.text()).toBe(200);
    await expect
      .poll(
        async () => (await getJson<ChatSnapshot>(app.request, `${app.baseURL}/api/chat`)).connected,
      )
      .toBe(true);

    await injectChat(app.request, app.baseURL, 'returning-viewer', '!right');
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).stats.executed)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).lastExecuted?.button)
      .toBe('RIGHT');

    expect(pageErrors, 'page errors').toEqual([]);
  });
});
