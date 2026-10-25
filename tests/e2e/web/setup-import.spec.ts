import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/server';

const romDir = fileURLToPath(new URL('../../fixtures/roms/', import.meta.url));
const gbRomPath = join(romDir, 'test_gb.gb');

interface RomMetadata {
  id: string;
  name: string;
  title: string;
  model: string;
  platform: string;
  width: number;
  height: number;
  extension: string;
  size: number;
  importedAt: string;
}

interface SettingsResponse {
  channel: string | null;
  romId: string | null;
  firstRun: boolean;
}

interface EmulatorStatus {
  status: string;
  romId: string | null;
  rom: {
    title: string;
    model: string;
    platform: string;
    width: number;
    height: number;
  } | null;
  fps: number;
  videoFrames: number;
  audioChunks: number;
  audioSampleRate: number;
  lastError: string | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test.describe('first-run setup and ROM import', () => {
  test('imports a ROM, persists settings, and controls the emulator lifecycle', async ({ app }) => {
    test.setTimeout(120_000);

    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    app.page.on('pageerror', (error) => pageErrors.push(error.message));
    app.page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    const readSettings = async (): Promise<SettingsResponse> => {
      const response = await app.request.get(`${app.baseURL}/api/settings`);
      expect(response.status()).toBe(200);
      return (await response.json()) as SettingsResponse;
    };
    const readStatus = async (): Promise<EmulatorStatus> => {
      const response = await app.request.get(`${app.baseURL}/api/emulator/status`);
      expect(response.status()).toBe(200);
      return (await response.json()) as EmulatorStatus;
    };

    // Step 1: legal notice, channel, and no persisted configuration yet.
    await expect(app.page.getByRole('heading', { name: 'Twitch Plays GB' })).toBeVisible();
    await expect(app.page.getByTestId('setup-step')).toHaveAttribute('data-step', '1');
    await expect(app.page.getByRole('heading', { name: 'First-run setup' })).toBeVisible();
    await expect(app.page.getByText('Before you start')).toBeVisible();
    await expect(app.page.getByText(/legally obtained ROMs/)).toBeVisible();
    await expect(app.page.getByLabel('Twitch channel')).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(await readSettings()).toEqual({ channel: null, romId: null, firstRun: true });

    // Invalid uploads are rejected through the same API the UI uses.
    const gbBytes = await readFile(gbRomPath);
    const postRom = (filename: string | undefined, data: Buffer) =>
      app.request.post(`${app.baseURL}/api/roms`, {
        headers: {
          'content-type': 'application/octet-stream',
          ...(filename === undefined ? {} : { 'x-filename': filename }),
        },
        data,
      });

    const wrongExtension = await postRom('game.txt', gbBytes);
    expect(wrongExtension.status()).toBe(400);
    expect(((await wrongExtension.json()) as { error: string }).error).toMatch(/extension/i);

    const tooSmall = await postRom('tiny.gb', Buffer.from('not a ROM'));
    expect(tooSmall.status()).toBe(400);
    expect(((await tooSmall.json()) as { error: string }).error).toMatch(/ROM|header/i);

    const invalidHeader = await postRom('zeros.gb', Buffer.alloc(0x150));
    expect(invalidHeader.status()).toBe(400);
    expect(((await invalidHeader.json()) as { error: string }).error).toMatch(/ROM|header/i);

    const missingFilename = await postRom(undefined, gbBytes);
    expect(missingFilename.status()).toBe(400);
    expect(((await missingFilename.json()) as { error: string }).error).toMatch(/filename/i);

    // Continue must not persist settings before the review step finishes.
    await app.page.getByLabel('Twitch channel').fill('example_channel');
    await app.page.getByRole('button', { name: 'Continue' }).click();
    await expect(app.page.getByTestId('setup-step')).toHaveAttribute('data-step', '2');
    await expect(app.page.getByTestId('rom-file-input')).toBeVisible();
    expect(await readSettings()).toEqual({ channel: null, romId: null, firstRun: true });

    // Import the real DMG fixture through the browser file input.
    await app.page.getByTestId('rom-file-input').setInputFiles(gbRomPath);
    const romList = app.page.getByTestId('rom-list');
    await expect(romList.getByText(/mooneye-gb/)).toBeVisible();
    await expect(romList.getByTestId('rom-model').first()).toHaveText('DMG');
    expect(await readSettings()).toEqual({ channel: null, romId: null, firstRun: true });

    const listResponse = await app.request.get(`${app.baseURL}/api/roms`);
    expect(listResponse.status()).toBe(200);
    const listBody = (await listResponse.json()) as { roms: RomMetadata[] };
    expect(listBody.roms).toHaveLength(1);
    const rom = listBody.roms[0];
    expect(rom).toMatchObject({
      title: 'mooneye-gb',
      model: 'DMG',
      platform: 'GB/GBC',
      width: 160,
      height: 144,
      extension: '.gb',
      size: gbBytes.length,
    });
    expect(rom.id).toMatch(/^[a-f0-9]{64}$/);
    expect(rom.name).not.toMatch(/[/\\]/);
    expect(JSON.stringify(listBody)).not.toContain(app.dataDir);

    const romResponse = await app.request.get(`${app.baseURL}/api/roms/${rom.id}`);
    expect(romResponse.status()).toBe(200);
    const romBody = (await romResponse.json()) as { rom: RomMetadata };
    expect(romBody.rom.id).toBe(rom.id);
    expect(JSON.stringify(romBody)).not.toContain(app.dataDir);

    // Disk names are server-generated. A traversal-style client filename with
    // identical bytes deduplicates and must never create a path outside roms/.
    const traversal = await postRom('../../evil.gb', gbBytes);
    expect(traversal.status()).toBe(200);
    const traversalBody = (await traversal.json()) as {
      rom: RomMetadata;
      created: boolean;
    };
    expect(traversalBody).toMatchObject({ created: false, rom: { id: rom.id } });
    expect(traversalBody.rom.name).not.toMatch(/[/\\]/);
    expect(JSON.stringify(traversalBody)).not.toContain(app.dataDir);

    const romFiles = await readdir(join(app.dataDir, 'roms'));
    expect(romFiles).toEqual([`${rom.id}.gb`]);
    expect(await exists(join(app.dataDir, 'evil.gb'))).toBe(false);
    expect(await exists(join(app.dataDir, 'roms', 'evil.gb'))).toBe(false);

    // Review, then finish. Only Finish writes settings and starts the ROM.
    await app.page.getByRole('button', { name: 'Continue' }).click();
    await expect(app.page.getByTestId('setup-step')).toHaveAttribute('data-step', '3');
    await expect(app.page.getByTestId('review-channel')).toHaveText('example_channel');
    await expect(app.page.getByTestId('review-rom')).toContainText(/mooneye-gb/);
    expect(await readSettings()).toEqual({ channel: null, romId: null, firstRun: true });

    await app.page.getByTestId('setup-finish').click();
    await expect(app.page.getByTestId('emulator-status')).toHaveText('running', {
      timeout: 30_000,
    });

    const settings = await readSettings();
    expect(settings).toEqual({ channel: 'example_channel', romId: rom.id, firstRun: false });
    expect(JSON.stringify(settings)).not.toContain(app.dataDir);

    await expect.poll(async () => (await readStatus()).status, { timeout: 30_000 }).toBe('running');
    const running = await readStatus();
    expect(running).toMatchObject({
      romId: rom.id,
      rom: {
        title: 'mooneye-gb',
        model: 'DMG',
        platform: 'GB/GBC',
        width: 160,
        height: 144,
      },
      audioSampleRate: 48_000,
      lastError: null,
    });
    expect(JSON.stringify(running)).not.toContain(app.dataDir);
    await expect
      .poll(async () => (await readStatus()).videoFrames, { timeout: 20_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await readStatus()).audioChunks, { timeout: 20_000 })
      .toBeGreaterThan(0);

    const health = (await (await app.request.get(`${app.baseURL}/health`)).json()) as {
      emulator: string;
    };
    expect(health.emulator).toBe('running');

    const debugResponse = await app.request.get(`${app.baseURL}/api/debug`);
    expect(debugResponse.status()).toBe(200);
    expect(JSON.stringify(await debugResponse.json())).not.toContain(app.dataDir);

    await expect(app.page.getByTestId('open-overlay')).toHaveAttribute(
      'href',
      '/overlay?client=obs',
    );

    // Stop, start, and restart are serialized and reflected in UI and API.
    await app.page.getByTestId('stop-emulator').click();
    await expect(app.page.getByTestId('emulator-status')).toHaveText('stopped');
    await expect.poll(async () => (await readStatus()).status).toBe('stopped');

    await app.page.getByTestId('start-emulator').click();
    await expect(app.page.getByTestId('emulator-status')).toHaveText('running', {
      timeout: 30_000,
    });
    await expect.poll(async () => (await readStatus()).status, { timeout: 30_000 }).toBe('running');

    const beforeRestart = await readStatus();
    await expect
      .poll(async () => (await readStatus()).videoFrames, { timeout: 20_000 })
      .toBeGreaterThan(0);
    expect(beforeRestart.status).toBe('running');

    await app.page.getByTestId('restart-emulator').click();
    await expect(app.page.getByTestId('emulator-status')).toHaveText('running', {
      timeout: 30_000,
    });
    await expect
      .poll(async () => {
        const status = await readStatus();
        return {
          running: status.status === 'running',
          frames: status.videoFrames > 0,
          audio: status.audioChunks > 0,
          error: status.lastError,
          romId: status.romId,
          sampleRate: status.audioSampleRate,
        };
      })
      .toEqual({
        running: true,
        frames: true,
        audio: true,
        error: null,
        romId: rom.id,
        sampleRate: 48_000,
      });

    expect(pageErrors, 'page errors').toEqual([]);
    expect(consoleErrors, 'console errors').toEqual([]);
  });
});
