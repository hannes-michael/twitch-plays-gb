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
  lastFrameIndex: number;
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
  queue: Array<{ user: string; status: string }>;
  recent: Array<{ user: string; status: string }>;
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

function readInput(server: TestServer): Promise<InputSnapshot> {
  return getJson<InputSnapshot>(`${server.baseURL}/api/input/state`);
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

async function saveNow(server: TestServer): Promise<SaveResponse> {
  const response = await fetch(`${server.baseURL}/api/emulator/save`, { method: 'POST' });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as SaveResponse;
}

function assertNoPathLeak(payload: unknown, dataDir: string): void {
  expect(JSON.stringify(payload)).not.toContain(dataDir);
}

function stateKeyFromFiles(files: string[]): string {
  const keys = new Set(files.map((name) => name.replace(/\.state(\.prev)?$/, '')));
  expect(keys.size).toBe(1);
  return [...keys][0];
}

test.describe('saves and restore', () => {
  let dataDir: string;

  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tpg-saves-'));
  });

  test.afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test('autosaves two generations, restores the frame, and falls back after corruption', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const autosaveEnv: NodeJS.ProcessEnv = {
      TPG_AUTOSAVE_INTERVAL_MS: '250',
      TPG_HOLD_FRAMES: '2',
      TPG_RELEASE_FRAMES: '1',
    };
    // Later phases use a long interval so only the explicit saves under test
    // can rotate the generations.
    const slowSaveEnv: NodeJS.ProcessEnv = {
      TPG_AUTOSAVE_INTERVAL_MS: '3600000',
      TPG_HOLD_FRAMES: '2',
      TPG_RELEASE_FRAMES: '1',
    };
    const start = (env: NodeJS.ProcessEnv) => startServer({ dataDir, cleanupDataDir: false, env });

    let server = await start(autosaveEnv);
    let savedFrameIndex: number | undefined;
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

      // Let the emulated frame counter advance, then save a known frame and
      // verify the restart restores that frame rather than a fresh session.
      await expect
        .poll(async () => (await readStatus(server)).lastFrameIndex, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(180);
      savedFrameIndex = (await readStatus(server)).lastFrameIndex;
      const manualSave = await saveNow(server);
      expect(manualSave.saved).toBe(true);

      assertNoPathLeak(firstRunStatus, dataDir);
      assertNoPathLeak(await getJson(`${server.baseURL}/api/settings`), dataDir);
      assertNoPathLeak(await getJson(`${server.baseURL}/api/debug`), dataDir);
    } finally {
      await server.stop();
    }

    // A normal restart restores the newest generation and its frame position.
    server = await start(slowSaveEnv);
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
      expect(restored.lastFrameIndex).toBeGreaterThanOrEqual(savedFrameIndex ?? 0);
      expect(restored.lastFrameIndex).toBeGreaterThan(60);

      await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('emulator-status')).toHaveText('running');
      await expect(page.getByTestId('restored-from')).toHaveText('current');

      assertNoPathLeak(restored, dataDir);
      assertNoPathLeak(await getJson(`${server.baseURL}/api/debug`), dataDir);
    } finally {
      await server.stop();
    }

    // Stop writes a fresh current state, so corrupt it after the process exits.
    const afterNormalRestart = await readdir(join(dataDir, 'states'));
    const key = stateKeyFromFiles(afterNormalRestart);
    await writeFile(join(dataDir, 'states', `${key}.state`), 'not a save state', 'utf8');

    server = await start(slowSaveEnv);
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
      expect(restored.lastFrameIndex).toBeGreaterThan(0);

      await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('emulator-status')).toHaveText('running');
      await expect(page.getByTestId('restored-from')).toHaveText('previous');

      // Saving after a fallback must keep the valid previous generation and
      // discard the corrupt current instead of promoting it.
      const beforeResave = restored.saveCount;
      const resave = await saveNow(server);
      expect(resave.saved).toBe(true);
      expect(resave.status.saveCount).toBeGreaterThan(beforeResave);

      // Simulate a crash after that save so no quit-save can repair the
      // rotation. Then corrupt the installed current and leave an orphan temp.
      await server.crash();
      const statePath = join(dataDir, 'states', `${key}.state`);
      const orphanedTemp = join(dataDir, 'states', `${key}.state.123.abcdef.tmp`);
      await writeFile(statePath, 'not a save state', 'utf8');
      await writeFile(orphanedTemp, 'stale temp', 'utf8');

      server = await start(slowSaveEnv);
      await expect
        .poll(
          async () => {
            const status = await readStatus(server);
            return { running: status.status === 'running', restored: status.restoredFrom };
          },
          { timeout: 30_000 },
        )
        .toEqual({ running: true, restored: 'previous' });

      expect(await exists(orphanedTemp)).toBe(false);
      const leftovers = (await readdir(join(dataDir, 'states'))).filter((name) =>
        name.endsWith('.tmp'),
      );
      expect(leftovers).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test('saves manually, from moderator chat, on stop, and in a quit save', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    const env: NodeJS.ProcessEnv = { TPG_AUTOSAVE_INTERVAL_MS: '3600000' };
    const server = await startServer({ dataDir, cleanupDataDir: false, env });
    let stopped = false;

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
      const stopBody = JSON.parse(stopText) as StopResponse;
      expect(stopBody.saved).toBe(true);
      expect(stopBody.status.status).toBe('stopped');
      expect(stopBody.status.saveCount).toBeGreaterThan(beforeStop);
      await expect(page.getByTestId('save-emulator')).toBeDisabled();

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

      // The long autosave interval rules out an autosave: a fresh state file
      // can only come from the SIGTERM quit path.
      const key = stateKeyFromFiles(await readdir(join(dataDir, 'states')));
      const statePath = join(dataDir, 'states', `${key}.state`);
      const beforeQuitMtime = (await stat(statePath)).mtimeMs;
      expect(server.getLogs()).not.toContain('emulator state saved (quit)');

      await server.stop();
      stopped = true;
      expect(server.exitCode).toBe(0);
      expect(server.getLogs()).toContain('emulator state saved (quit)');
      expect((await stat(statePath)).mtimeMs).not.toBe(beforeQuitMtime);
    } finally {
      if (!stopped) await server.stop();
    }
  });

  test('cancels a long input press so shutdown still saves within the timeout', async () => {
    test.setTimeout(120_000);

    const env: NodeJS.ProcessEnv = {
      TPG_AUTOSAVE_INTERVAL_MS: '3600000',
      TPG_HOLD_FRAMES: '600',
      TPG_RELEASE_FRAMES: '600',
      TPG_INPUT_COOLDOWN_MS: '0',
      TPG_INPUT_MAX_PER_SECOND: '100',
      TPG_INPUT_STALE_MS: '0',
    };
    const server = await startServer({ dataDir, cleanupDataDir: false, env });
    let stopped = false;

    try {
      const rom = await importRomAndStart(server);
      const response = await fetch(`${server.baseURL}/api/test/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: 'longpress', text: '!a' }),
      });
      expect(response.status, await response.text()).toBe(201);

      await expect
        .poll(
          async () =>
            (await readInput(server)).recent.find((event) => event.user === 'longpress')?.status,
          { timeout: 10_000 },
        )
        .toBe('executing');

      await server.stop();
      stopped = true;
      expect(server.exitCode).toBe(0);
      const logs = server.getLogs();
      expect(logs).toContain('cancelled active input press');
      expect(logs).toContain('emulator state saved (quit)');
      expect(logs).not.toContain('forcing exit');

      const statePath = join(dataDir, 'states', `${rom.id}.state`);
      expect((await stat(statePath)).size).toBeGreaterThan(0);
      const leftovers = (await readdir(join(dataDir, 'states'))).filter((name) =>
        name.endsWith('.tmp'),
      );
      expect(leftovers).toEqual([]);
    } finally {
      if (!stopped) await server.stop();
    }
  });

  test('sanitizes save failures and shows them in the dashboard', async ({ page }) => {
    test.setTimeout(120_000);

    const server = await startServer({
      dataDir,
      cleanupDataDir: false,
      env: { TPG_AUTOSAVE_INTERVAL_MS: '3600000' },
    });

    try {
      await importRomAndStart(server);
      await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('emulator-status')).toHaveText('running');

      // Force a save failure by replacing the states directory with a file.
      const statesDir = join(dataDir, 'states');
      await rm(statesDir, { recursive: true, force: true });
      await writeFile(statesDir, 'not a directory', 'utf8');

      const beforeFailure = (await readStatus(server)).saveCount;
      await page.getByTestId('save-emulator').click();

      await expect
        .poll(async () => (await readStatus(server)).lastSaveError, { timeout: 20_000 })
        .not.toBeNull();
      const failed = await readStatus(server);
      expect(failed.saveCount).toBe(beforeFailure);
      expect(failed.lastSaveError).not.toContain(dataDir);
      expect(failed.lastSaveError).not.toContain('/tmp/');

      const debug = await getJson(`${server.baseURL}/api/debug`);
      assertNoPathLeak(debug, dataDir);
      expect(JSON.stringify(debug)).not.toContain('/tmp/');

      await expect(page.getByTestId('save-error')).toBeVisible();
      await expect(page.getByTestId('save-error')).toContainText('Save failed');
      await expect(page.getByTestId('save-error')).not.toContainText(dataDir);
      await expect(page.getByTestId('dashboard-notice')).not.toContainText('No running emulator');
      await expect(page.getByTestId('save-emulator')).toBeEnabled();
    } finally {
      await server.stop();
    }
  });
});
