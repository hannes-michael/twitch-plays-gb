import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import { ChatService } from '../../../src/server/chat/service';
import { selectChatSource } from '../../../src/server/chat/policy';
import type { ChatSource } from '../../../src/server/chat/types';
import { isTwitchBot } from '../../../src/server/chat/twitch-source';
import type { Logger } from '../../../src/server/logger';
import { expect, startServer, test } from '../../fixtures/server';

const romDir = fileURLToPath(new URL('../../fixtures/roms/', import.meta.url));

const INPUT_STALE_MS = 1_500;

const inputTimings: NodeJS.ProcessEnv = {
  TPG_INPUT_COOLDOWN_MS: '300',
  TPG_INPUT_MAX_QUEUE: '2',
  TPG_INPUT_MAX_PER_SECOND: '2',
  TPG_INPUT_STALE_MS: String(INPUT_STALE_MS),
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

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

class ControlledTwitchSource implements ChatSource {
  readonly kind = 'twitch' as const;
  connected = false;
  started = false;
  stopped = false;

  constructor(readonly channel: string) {}

  async start(): Promise<void> {
    this.started = true;
    this.connected = true;
    // Yield once so an overlapping transition can supersede this start before
    // the operation checks its generation again.
    await Promise.resolve();
  }

  stop(): void {
    this.connected = false;
    this.stopped = true;
  }
}

test.describe('chat source safeguards', () => {
  test('selects real Twitch chat in development when a channel is configured', () => {
    expect(
      selectChatSource({ dev: true, test: false, preference: 'auto', channel: 'example' }),
    ).toBe('twitch');
    expect(
      selectChatSource({ dev: true, test: false, preference: 'twitch', channel: 'example' }),
    ).toBe('twitch');
    expect(selectChatSource({ dev: true, test: false, preference: 'auto', channel: null })).toBe(
      'fake',
    );
    expect(
      selectChatSource({ dev: true, test: false, preference: 'fake', channel: 'example' }),
    ).toBe('fake');
    expect(
      selectChatSource({ dev: false, test: false, preference: 'auto', channel: 'example' }),
    ).toBe('twitch');
    expect(selectChatSource({ dev: false, test: false, preference: 'auto', channel: null })).toBe(
      'none',
    );
    expect(
      selectChatSource({ dev: false, test: false, preference: 'fake', channel: 'example' }),
    ).toBe('none');
    expect(
      selectChatSource({ dev: true, test: true, preference: 'auto', channel: 'example' }),
    ).toBe('fake');
  });

  test('maps Twitch bot badges and known bot usernames', () => {
    expect(isTwitchBot('viewer', new Map([['bot-badge', '1']]))).toBe(true);
    expect(isTwitchBot('viewer', new Map([['twitchbot', '1']]))).toBe(true);
    expect(isTwitchBot('nightbot', new Map([['subscriber', '12']]))).toBe(true);
    expect(isTwitchBot('viewer', new Map([['subscriber', '12']]))).toBe(false);
    expect(isTwitchBot('viewer', new Map(), 'bot')).toBe(true);
  });

  test('serializes overlapping Twitch source transitions', async () => {
    const immediateSources: ControlledTwitchSource[] = [];
    const immediate = new ChatService(noopLogger, {
      createTwitchSource: (channel) => {
        const source = new ControlledTwitchSource(channel);
        immediateSources.push(source);
        return source;
      },
    });

    try {
      // Both calls overlap before the first transition can assign a source.
      const first = immediate.startTwitch('first');
      const second = immediate.startTwitch('second');
      await Promise.all([first, second]);

      expect(immediateSources.filter((source) => source.connected)).toHaveLength(1);
      expect(immediateSources.at(-1)?.channel).toBe('second');
      expect(immediateSources.slice(0, -1).every((source) => source.stopped)).toBe(true);
    } finally {
      await immediate.close();
    }

    const sources: ControlledTwitchSource[] = [];
    let firstCreated!: () => void;
    const firstSourceCreated = new Promise<void>((resolve) => {
      firstCreated = resolve;
    });

    const chat = new ChatService(noopLogger, {
      createTwitchSource: (channel) => {
        const source = new ControlledTwitchSource(channel);
        sources.push(source);
        if (channel === 'first') firstCreated();
        return source;
      },
    });

    try {
      // The second call lands while the first source is still starting.
      const first = chat.startTwitch('first');
      await firstSourceCreated;
      const second = chat.startTwitch('second');
      await Promise.all([first, second]);

      expect(sources).toHaveLength(2);
      expect(sources[0]).toMatchObject({ channel: 'first', connected: false, stopped: true });
      expect(sources[1]).toMatchObject({ channel: 'second', connected: true, stopped: false });
      expect(chat.getStatus()).toMatchObject({
        source: 'twitch',
        connected: true,
        channel: 'second',
      });
      expect(sources.filter((source) => source.connected)).toHaveLength(1);
    } finally {
      await chat.close();
    }

    expect(sources[1].stopped).toBe(true);
  });

  test('coalesces bursty input-state broadcasts to at most 10 Hz', async () => {
    const server = await startServer({
      env: {
        TPG_INPUT_COOLDOWN_MS: '0',
        TPG_INPUT_MAX_QUEUE: '2',
        TPG_INPUT_MAX_PER_SECOND: '100',
      },
    });
    const socket = new WebSocket(`${server.baseURL.replace(/^http/, 'ws')}/ws`);
    const states: InputSnapshot[] = [];
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string; input?: InputSnapshot };
        if (message.type === 'input-state' && message.input) states.push(message.input);
      } catch {
        // Ignore non-JSON frames; this scenario counts only input-state messages.
      }
    });

    try {
      await once(socket, 'open');
      await expect.poll(() => states.length).toBeGreaterThan(0);
      states.length = 0;

      const startedAt = Date.now();
      for (let index = 0; index < 20; index += 1) {
        const response = await fetch(`${server.baseURL}/api/test/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: `spam-${index}`, text: '!up' }),
        });
        expect(response.status, await response.text()).toBe(201);
      }

      await expect
        .poll(() => states.at(-1)?.stats.queueFullDrops ?? 0, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(18);
      const elapsedMs = Date.now() - startedAt;
      const final = states.at(-1);
      expect(final?.queue).toHaveLength(2);
      expect(final?.stats).toMatchObject({ accepted: 2, queueFullDrops: 18 });
      expect(states.length).toBeLessThanOrEqual(Math.ceil(elapsedMs / 100) + 2);
    } finally {
      socket.close();
      await server.stop();
    }
  });
});

test.describe('chat input', () => {
  test('executes anarchy input, drops cooldown, rate, and overflow, then drains the queue', async ({
    app,
  }) => {
    const pageErrors: string[] = [];
    app.page.on('pageerror', (error) => pageErrors.push(error.message));

    const response = await app.page.goto(`${app.baseURL}/overlay?client=preview`, {
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

    // Stale: a queued input that sits past the stale limit while stopped is
    // dropped at execution instead of being pressed late.
    await waitForRateWindow(app.request, app.baseURL);
    const beforeStale = await readInput(app.request, app.baseURL);
    const staleStop = await app.request.post(`${app.baseURL}/api/emulator/stop`);
    expect(staleStop.status(), await staleStop.text()).toBe(200);
    await expect
      .poll(
        async () =>
          (await getJson<EmulatorSnapshot>(app.request, `${app.baseURL}/api/emulator/status`))
            .status,
        { timeout: 20_000 },
      )
      .toBe('stopped');

    await injectChat(app.request, app.baseURL, 'grace', '!select');
    await expect
      .poll(
        async () => {
          const state = await readInput(app.request, app.baseURL);
          const event = state.queue.find((entry) => entry.user === 'grace');
          return event ? Date.now() - Date.parse(event.queuedAt) : 0;
        },
        { timeout: 5_000, intervals: [50] },
      )
      .toBeGreaterThan(INPUT_STALE_MS);

    const staleStart = await app.request.post(`${app.baseURL}/api/emulator/start`);
    expect(staleStart.status(), await staleStart.text()).toBe(200);
    await expect
      .poll(
        async () =>
          (await getJson<EmulatorSnapshot>(app.request, `${app.baseURL}/api/emulator/status`))
            .status,
        { timeout: 20_000 },
      )
      .toBe('running');
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).stats.staleDrops)
      .toBeGreaterThan(beforeStale.stats.staleDrops);
    await expect
      .poll(async () => (await readInput(app.request, app.baseURL)).lastDrop?.reason)
      .toBe('stale');

    const afterStale = await readInput(app.request, app.baseURL);
    expect(afterStale.stats.executed).toBe(beforeStale.stats.executed);
    expect(afterStale.lastExecuted).toEqual(beforeStale.lastExecuted);
    expect(afterStale.queue).toHaveLength(0);
    expect(afterStale.recent.at(-1)).toMatchObject({
      user: 'grace',
      button: 'SELECT',
      status: 'dropped',
      dropReason: 'stale',
    });

    expect(pageErrors, 'page errors').toEqual([]);
  });

  test('ignores bots, self, bare, invalid, and meta messages and survives a chat outage', async ({
    app,
  }) => {
    const pageErrors: string[] = [];
    app.page.on('pageerror', (error) => pageErrors.push(error.message));

    const response = await app.page.goto(`${app.baseURL}/overlay?client=preview`, {
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
