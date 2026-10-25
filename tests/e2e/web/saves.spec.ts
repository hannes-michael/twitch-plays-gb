import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, startServer, test, type TestServer } from '../../fixtures/server';

const romDir = fileURLToPath(new URL('../../fixtures/roms/', import.meta.url));
const gbRomPath = join(romDir, 'test_gb.gb');

interface EmulatorStatus {
  status: string;
  romId: string | null;
  saveCount: number;
  lastSavedAt: string | null;
  restoredFrom: 'current' | 'previous' | null;
  lastSaveError: string | null;
  autosaveIntervalMs: number;
}

interface RomMetadata {
  id: string;
}

interface SaveResponse {
  saved: boolean;
  status: EmulatorStatus;
}

interface StopResponse {
  saved: boolean;
  status: EmulatorStatus;
}

interface InputSnapshot {
  lastMeta: { command: string; user: string; allowed: boolean; at: string } | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as T;
}

function readStatus(server: TestServer): Promise<EmulatorStatus> {
  return getJson<EmulatorStatus>(`${server.baseURL}/api/emulator/status`);
}

async function importRomAndStart(server: TestServer): Promise<RomMetadata> {
  const romBytes = await readFile(gbRomPath);
  const importResponse = await fetch(`${server.baseURL}/api/roms`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': 'test_gb.gb' },
    body: romBytes,
  });
  const importText = await importResponse.text();
  expect(importResponse.status, importText).toBe(201);
  const imported = JSON.parse(importText) as { rom: RomMetadata };

  const settingsResponse = await fetch(`${server.baseURL}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ channel: 'example_channel', romId: imported.rom.id }),
  });
  const settingsText = await settingsResponse.text();
  expect(settingsResponse.status, settingsText).toBe(200);
  expect(JSON.parse(settingsText)).toMatchObject({
    channel: 'example_channel',
    romId: imported.rom.id,
    firstRun: false,
  });

  const startResponse = await fetch(`${server.baseURL}/api/emulator/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ romId: imported.rom.id }),
  });
  expect(startResponse.status, await startResponse.text()).toBe(200);
  await expect
    .poll(async () => (await readStatus(server)).status, { timeout: 30_000 })
    .toBe('running');

  return imported.rom;
}

function assertNoPathLeak(payload: unknown, dataDir: string): void {
  expect(JSON.stringify(payload)).not.toContain(dataDir);
}

test.describe('saves and restore', () => {
  let dataDir: string;

  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tpg-saves-'));
  });

  test.afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test('autosaves two generations, restores the newest state, and falls back after corruption', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const env: NodeJS.ProcessEnv = {
      TPG_AUTOSAVE_INTERVAL_MS: '250',
      TPG_HOLD_FRAMES: '2',
      TPG_RELEASE_FRAMES: '1',
    };
    const start = () => startServer({ dataDir, cleanupDataDir: false, env });

    let server = await start();
    try {
      const rom = await importRomAndStart(server);

      await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('dashboard-channel')).toHaveText('example_channel');
      await expect(page.getByTestId('emulator-status')).toHaveText('running');
      await expect(page.getByTestId('save-emulator')).toBeVisible();

      await expect
        .poll(async () => (await readStatus(server)).saveCount, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(2);

      const currentState = join(dataDir, 'states', `${rom.id}.state`);
      const previousState = join(dataDir, 'states', `${rom.id}.state.prev`);
      expect(await exists(currentState)).toBe(true);
      expect(await exists(previousState)).toBe(true);
      expect((await stat(currentState)).size).toBeGreaterThan(0);
      expect((await stat(previousState)).size).toBeGreaterThan(0);

      const firstRunStatus = await readStatus(server);
      expect(firstRunStatus).toMatchObject({
        status: 'running',
        romId: rom.id,
        autosaveIntervalMs: 250,
        restoredFrom: null,
        lastSaveError: null,
      });
      expect(firstRunStatus.lastSavedAt).not.toBeNull();

      assertNoPathLeak(firstRunStatus, dataDir);
      assertNoPathLeak(await getJson(`${server.baseURL}/api/settings`), dataDir);
      assertNoPathLeak(await getJson(`${server.baseURL}/api/debug`), dataDir);
    } finally {
      await server.stop();
    }

    // A normal restart restores the newest generation.
    server = await start();
    try {
      await expect
        .poll(
          async () => {
            const status = await readStatus(server);
            return { running: status.status === 'running', restored: status.restoredFrom };
          },
          { timeout: 30_000 },
        )
        .toEqual({ running: true, restored: 'current' });

      const restored = await readStatus(server);
      expect(restored.status).toBe('running');
      expect(restored.lastSavedAt).not.toBeNull();
      expect(restored.lastSaveError).toBeNull();

      await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('emulator-status')).toHaveText('running');
      await expect(page.getByTestId('restored-from')).toHaveText('current');

      assertNoPathLeak(restored, dataDir);
      assertNoPathLeak(await getJson(`${server.baseURL}/api/debug`), dataDir);
    } finally {
      await server.stop();
    }

    // Stop writes a fresh current state, so corrupt it after the process exits.
    const states = await readdir(join(dataDir, 'states'));
    const keys = new Set(states.map((name) => name.replace(/\.state(\.prev)?$/, '')));
    expect(keys.size).toBe(1);
    const key = [...keys][0];
    await writeFile(join(dataDir, 'states', `${key}.state`), 'not a save state', 'utf8');

    server = await start();
    try {
      await expect
        .poll(
          async () => {
            const status = await readStatus(server);
            return { running: status.status === 'running', restored: status.restoredFrom };
          },
          { timeout: 30_000 },
        )
        .toEqual({ running: true, restored: 'previous' });

      const restored = await readStatus(server);
      expect(restored.lastSavedAt).not.toBeNull();
      expect(restored.lastSaveError).toBeNull();

      await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('emulator-status')).toHaveText('running');
      await expect(page.getByTestId('restored-from')).toHaveText('previous');
    } finally {
      await server.stop();
    }
  });

  test('saves manually, from moderator chat, and on stop, but not from regular users', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    const env: NodeJS.ProcessEnv = { TPG_AUTOSAVE_INTERVAL_MS: '3600000' };
    const server = await startServer({ dataDir, cleanupDataDir: false, env });

    try {
      await importRomAndStart(server);

      await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('emulator-status')).toHaveText('running');

      // Dashboard Save now posts the same endpoint external callers use.
      const beforeManual = (await readStatus(server)).saveCount;
      await page.getByTestId('save-emulator').click();
      await expect
        .poll(async () => (await readStatus(server)).saveCount, { timeout: 20_000 })
        .toBeGreaterThan(beforeManual);
      const afterManual = await readStatus(server);
      expect(afterManual.lastSavedAt).not.toBeNull();
      await expect
        .poll(async () => Number(await page.getByTestId('save-count').textContent()))
        .toBeGreaterThanOrEqual(afterManual.saveCount);
      await expect(page.getByTestId('last-saved')).not.toHaveText('never');

      // A moderator may force a save through chat.
      const beforeMod = (await readStatus(server)).saveCount;
      const modResponse = await request.post(`${server.baseURL}/api/test/chat`, {
        data: { user: 'mod-user', text: '!save', roles: { mod: true } },
      });
      expect(modResponse.status(), await modResponse.text()).toBe(201);

      await expect
        .poll(
          async () => (await getJson<InputSnapshot>(`${server.baseURL}/api/input/state`)).lastMeta,
        )
        .toMatchObject({ command: 'save', user: 'mod-user', allowed: true });
      await expect
        .poll(async () => (await readStatus(server)).saveCount, { timeout: 20_000 })
        .toBeGreaterThan(beforeMod);

      // A regular viewer gets feedback but cannot save.
      const beforeRegular = (await readStatus(server)).saveCount;
      const viewerResponse = await request.post(`${server.baseURL}/api/test/chat`, {
        data: { user: 'viewer', text: '!save' },
      });
      expect(viewerResponse.status(), await viewerResponse.text()).toBe(201);
      await expect
        .poll(
          async () => (await getJson<InputSnapshot>(`${server.baseURL}/api/input/state`)).lastMeta,
        )
        .toMatchObject({ command: 'save', user: 'viewer', allowed: false });
      expect((await readStatus(server)).saveCount).toBe(beforeRegular);

      // Stop saves before closing, so the next start can restore.
      const beforeStop = (await readStatus(server)).saveCount;
      const stopResponse = await request.post(`${server.baseURL}/api/emulator/stop`);
      const stopText = await stopResponse.text();
      expect(stopResponse.status(), stopText).toBe(200);
      const stopped = JSON.parse(stopText) as StopResponse;
      expect(stopped.saved).toBe(true);
      expect(stopped.status.status).toBe('stopped');
      expect(stopped.status.saveCount).toBeGreaterThan(beforeStop);

      // Saving while stopped is a clear no-op, not a crash.
      const stoppedSaveResponse = await request.post(`${server.baseURL}/api/emulator/save`);
      const stoppedSaveText = await stoppedSaveResponse.text();
      expect(stoppedSaveResponse.status(), stoppedSaveText).toBe(200);
      const stoppedSave = JSON.parse(stoppedSaveText) as SaveResponse;
      expect(stoppedSave.saved).toBe(false);
      expect(stoppedSave.status.status).toBe('stopped');

      // Starting again restores the state saved during stop.
      const startResponse = await request.post(`${server.baseURL}/api/emulator/start`);
      expect(startResponse.status(), await startResponse.text()).toBe(200);
      await expect
        .poll(
          async () => {
            const status = await readStatus(server);
            return { running: status.status === 'running', restored: status.restoredFrom };
          },
          { timeout: 30_000 },
        )
        .toEqual({ running: true, restored: 'current' });

      // Restart saves the session but boots a fresh state, not a resume.
      const beforeRestart = (await readStatus(server)).saveCount;
      const restartResponse = await request.post(`${server.baseURL}/api/emulator/restart`);
      expect(restartResponse.status(), await restartResponse.text()).toBe(200);
      await expect
        .poll(
          async () => {
            const status = await readStatus(server);
            return {
              running: status.status === 'running',
              restored: status.restoredFrom,
              saved: status.saveCount > beforeRestart,
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({ running: true, restored: null, saved: true });
    } finally {
      await server.stop();
    }
  });
});
