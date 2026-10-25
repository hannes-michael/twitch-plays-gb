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

interface InputSnapshot {
  lastExecuted: { button: string; user: string } | null;
  recent: Array<{ user: string; button: string; source: string; status: string }>;
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
  test('imports a ROM, persists settings, and controls the emulator lifecycle', async ({
    server,
    page,
  }) => {
    test.setTimeout(120_000);

    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    // Attach the renderer error listeners before the first navigation so
    // load-time failures are part of the assertion.
    const navResponse = await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
    expect(navResponse?.ok()).toBe(true);

    const readSettings = async (): Promise<SettingsResponse> => {
      const response = await server.request.get(`${server.baseURL}/api/settings`);
      expect(response.status()).toBe(200);
      return (await response.json()) as SettingsResponse;
    };
    const readStatus = async (): Promise<EmulatorStatus> => {
      const response = await server.request.get(`${server.baseURL}/api/emulator/status`);
      expect(response.status()).toBe(200);
      return (await response.json()) as EmulatorStatus;
    };
    const readInput = async (): Promise<InputSnapshot> => {
      const response = await server.request.get(`${server.baseURL}/api/input/state`);
      expect(response.status()).toBe(200);
      return (await response.json()) as InputSnapshot;
    };

    // Step 1: legal notice, channel, and no persisted configuration yet.
    await expect(page.getByRole('heading', { name: 'Twitch Plays GB' })).toBeVisible();
    await expect(page.getByTestId('setup-step')).toHaveAttribute('data-step', '1');
    await expect(page.getByRole('heading', { name: 'First-run setup' })).toBeVisible();
    await expect(page.getByText('Before you start')).toBeVisible();
    await expect(page.getByText(/legally obtained ROMs/)).toBeVisible();
    await expect(page.getByLabel('Twitch channel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(await readSettings()).toEqual({ channel: null, romId: null, firstRun: true });

    // Invalid uploads are rejected through the same API the UI uses.
    const gbBytes = await readFile(gbRomPath);
    const postRom = (filename: string | undefined, data: Buffer) =>
      server.request.post(`${server.baseURL}/api/roms`, {
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
    await page.getByLabel('Twitch channel').fill('example_channel');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('setup-step')).toHaveAttribute('data-step', '2');
    await expect(page.getByTestId('rom-file-input')).toBeVisible();
    expect(await readSettings()).toEqual({ channel: null, romId: null, firstRun: true });

    // Import the real DMG fixture through the browser file input.
    await page.getByTestId('rom-file-input').setInputFiles(gbRomPath);
    const romList = page.getByTestId('rom-list');
    await expect(romList.getByText(/mooneye-gb/)).toBeVisible();
    await expect(romList.getByTestId('rom-model').first()).toHaveText('DMG');
    expect(await readSettings()).toEqual({ channel: null, romId: null, firstRun: true });

    const listResponse = await server.request.get(`${server.baseURL}/api/roms`);
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
    expect(JSON.stringify(listBody)).not.toContain(server.dataDir);

    const romResponse = await server.request.get(`${server.baseURL}/api/roms/${rom.id}`);
    expect(romResponse.status()).toBe(200);
    const romBody = (await romResponse.json()) as { rom: RomMetadata };
    expect(romBody.rom.id).toBe(rom.id);
    expect(JSON.stringify(romBody)).not.toContain(server.dataDir);

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
    expect(JSON.stringify(traversalBody)).not.toContain(server.dataDir);

    const romFiles = await readdir(join(server.dataDir, 'roms'));
    expect(romFiles).toEqual([`${rom.id}.gb`]);
    expect(await exists(join(server.dataDir, 'evil.gb'))).toBe(false);
    expect(await exists(join(server.dataDir, 'roms', 'evil.gb'))).toBe(false);

    // Review, then finish. Only Finish writes settings and starts the ROM.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('setup-step')).toHaveAttribute('data-step', '3');
    await expect(page.getByTestId('review-channel')).toHaveText('example_channel');
    await expect(page.getByTestId('review-rom')).toContainText(/mooneye-gb/);
    expect(await readSettings()).toEqual({ channel: null, romId: null, firstRun: true });

    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('emulator-status')).toHaveText('running', {
      timeout: 30_000,
    });

    const settings = await readSettings();
    expect(settings).toEqual({ channel: 'example_channel', romId: rom.id, firstRun: false });
    expect(JSON.stringify(settings)).not.toContain(server.dataDir);

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
    expect(JSON.stringify(running)).not.toContain(server.dataDir);
    await expect
      .poll(async () => (await readStatus()).videoFrames, { timeout: 20_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await readStatus()).audioChunks, { timeout: 20_000 })
      .toBeGreaterThan(0);

    const health = (await (await server.request.get(`${server.baseURL}/health`)).json()) as {
      emulator: string;
    };
    expect(health.emulator).toBe('running');

    const debugResponse = await server.request.get(`${server.baseURL}/api/debug`);
    expect(debugResponse.status()).toBe(200);
    expect(JSON.stringify(await debugResponse.json())).not.toContain(server.dataDir);

    await expect(page.getByTestId('open-overlay')).toHaveAttribute('href', '/overlay?client=obs');

    // Stream audio is controlled from the desktop/browser dashboard, not from
    // the clean OBS browser source.
    const audioPanel = page.getByTestId('stream-audio-panel');
    await expect(audioPanel).toBeVisible();
    await expect(page.getByTestId('stream-audio-status')).toHaveAttribute(
      'data-audio-muted',
      'false',
    );
    await page.getByTestId('toggle-stream-audio').click();
    await expect(page.getByTestId('stream-audio-status')).toHaveAttribute(
      'data-audio-muted',
      'true',
    );
    await expect(page.getByTestId('toggle-stream-audio')).toHaveText('Unmute stream');
    await expect
      .poll(async () => {
        const response = await server.request.get(`${server.baseURL}/api/audio`);
        return ((await response.json()) as { muted: boolean }).muted;
      })
      .toBe(true);

    await page.getByTestId('stream-audio-volume').evaluate((element) => {
      const input = element as HTMLInputElement;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, '40');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.getByTestId('stream-audio-volume-value')).toHaveText('40%');
    await expect
      .poll(async () => {
        const response = await server.request.get(`${server.baseURL}/api/audio`);
        return ((await response.json()) as { volume: number }).volume;
      })
      .toBe(0.4);

    await page.getByTestId('toggle-stream-audio').click();
    await expect(page.getByTestId('stream-audio-status')).toHaveAttribute(
      'data-audio-muted',
      'false',
    );

    // Local controls enqueue operator input through the same bounded queue,
    // without the chat cooldown or rate cap.
    const localInput = page.getByTestId('local-input');
    await expect(localInput).toBeVisible();
    await expect(page.getByTestId('local-input-RIGHT')).toBeEnabled();
    await page.getByTestId('local-input-RIGHT').click();
    await expect.poll(async () => (await readInput()).lastExecuted?.button).toBe('RIGHT');
    await expect.poll(async () => (await readInput()).lastExecuted?.user).toBe('local');
    const localState = await readInput();
    expect(localState.recent.at(-1)).toMatchObject({
      user: 'local',
      button: 'RIGHT',
      source: 'local',
    });
    await expect(page.getByTestId('dashboard-recent-inputs')).toContainText('local');

    // Keyboard shortcuts work when focus is not in a form control.
    await page.getByRole('heading', { name: 'Ready to play' }).click();
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await readInput()).lastExecuted?.button).toBe('UP');

    const invalidInput = await server.request.post(`${server.baseURL}/api/input`, {
      data: { button: 'TURBO' },
    });
    expect(invalidInput.status()).toBe(400);

    // Stop, start, and restart are serialized and reflected in UI and API.
    await page.getByTestId('stop-emulator').click();
    await expect(page.getByTestId('emulator-status')).toHaveText('stopped');
    await expect.poll(async () => (await readStatus()).status).toBe('stopped');
    await expect(page.getByTestId('local-input-A')).toBeDisabled();
    const stoppedInput = await server.request.post(`${server.baseURL}/api/input`, {
      data: { button: 'A' },
    });
    expect(stoppedInput.status()).toBe(200);
    expect(await stoppedInput.json()).toMatchObject({
      accepted: false,
      reason: 'not-running',
    });

    await page.getByTestId('start-emulator').click();
    await expect(page.getByTestId('emulator-status')).toHaveText('running', {
      timeout: 30_000,
    });
    await expect.poll(async () => (await readStatus()).status, { timeout: 30_000 }).toBe('running');
    await expect(page.getByTestId('local-input-A')).toBeEnabled();

    const beforeRestart = await readStatus();
    await expect
      .poll(async () => (await readStatus()).videoFrames, { timeout: 20_000 })
      .toBeGreaterThan(0);
    expect(beforeRestart.status).toBe('running');

    await page.getByTestId('restart-emulator').click();
    await expect(page.getByTestId('emulator-status')).toHaveText('running', {
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

  test('serializes concurrent ROM imports without duplicates or lost entries', async ({
    server,
  }) => {
    const upload = (filename: string, data: Buffer) =>
      server.request.post(`${server.baseURL}/api/roms`, {
        headers: { 'content-type': 'application/octet-stream', 'x-filename': filename },
        data,
      });

    const gbBytes = await readFile(gbRomPath);
    const identical = await Promise.all(
      Array.from({ length: 5 }, (_, index) => upload(`same-${index}.gb`, gbBytes)),
    );
    expect(identical.map((response) => response.status()).sort()).toEqual([
      200, 200, 200, 200, 201,
    ]);

    const identicalBodies = await Promise.all(
      identical.map(
        async (response) =>
          (await response.json()) as {
            rom: RomMetadata;
            created: boolean;
          },
      ),
    );
    const ids = new Set(identicalBodies.map((body) => body.rom.id));
    expect(ids.size).toBe(1);
    expect(identicalBodies.filter((body) => body.created)).toHaveLength(1);

    const id = identicalBodies[0].rom.id;
    let list = (await (await server.request.get(`${server.baseURL}/api/roms`)).json()) as {
      roms: RomMetadata[];
    };
    expect(list.roms).toHaveLength(1);
    expect(await readdir(join(server.dataDir, 'roms'))).toEqual([`${id}.gb`]);

    const distinct = await Promise.all([
      upload('test_gbc.gbc', await readFile(join(romDir, 'test_gbc.gbc'))),
      upload('test_gba.gba', await readFile(join(romDir, 'test_gba.gba'))),
    ]);
    expect(distinct.map((response) => response.status()).sort()).toEqual([201, 201]);

    list = (await (await server.request.get(`${server.baseURL}/api/roms`)).json()) as {
      roms: RomMetadata[];
    };
    expect(list.roms).toHaveLength(3);
    expect(new Set(list.roms.map((rom) => rom.id)).size).toBe(3);
    expect((await readdir(join(server.dataDir, 'roms'))).sort()).toEqual(
      list.roms.map((rom) => `${rom.id}${rom.extension}`).sort(),
    );
  });

  test('rejects shallow structural fakes at the 32 KiB boundary', async ({ server }) => {
    const upload = (filename: string, data: Buffer) =>
      server.request.post(`${server.baseURL}/api/roms`, {
        headers: { 'content-type': 'application/octet-stream', 'x-filename': filename },
        data,
      });
    const expectRejected = async (filename: string, data: Buffer): Promise<void> => {
      const response = await upload(filename, data);
      expect(response.status(), `${filename} should be rejected`).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(
        /Invalid ROM|too small|header/i,
      );
    };

    const gbBytes = await readFile(gbRomPath);
    const gbaBytes = await readFile(join(romDir, 'test_gba.gba'));
    const copyLogo = (target: Buffer): Buffer => {
      gbBytes.copy(target, 0x104, 0x104, 0x134);
      return target;
    };

    const gbaZeros = Buffer.alloc(32 * 1024);
    gbaZeros[0xb2] = 0x96;
    await expectRejected('zeros.gba', gbaZeros);

    const gbaGarbage = Buffer.alloc(32 * 1024, 0xab);
    gbaGarbage[0xb2] = 0x96;
    await expectRejected('garbage.gba', gbaGarbage);

    await expectRejected('logo-truncated.gb', copyLogo(Buffer.alloc(0x150)));
    await expectRejected('below-minimum.gb', copyLogo(Buffer.alloc(32 * 1024 - 1)));
    await expectRejected('below-minimum.gba', gbaBytes.subarray(0, 32 * 1024 - 1));

    const minimum = await upload('minimum.gb', copyLogo(Buffer.alloc(32 * 1024)));
    expect(minimum.status()).toBe(201);
    const minimumBody = (await minimum.json()) as { rom: RomMetadata };
    expect(minimumBody.rom).toMatchObject({ size: 32 * 1024, model: 'DMG' });

    const list = (await (await server.request.get(`${server.baseURL}/api/roms`)).json()) as {
      roms: RomMetadata[];
    };
    expect(list.roms.map((rom) => rom.id)).toEqual([minimumBody.rom.id]);
    expect(await readdir(join(server.dataDir, 'roms'))).toEqual([`${minimumBody.rom.id}.gb`]);
  });
});
