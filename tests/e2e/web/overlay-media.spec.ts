import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../../fixtures/server';

const romDir = fileURLToPath(new URL('../../fixtures/roms/', import.meta.url));

interface EmulatorSnapshot {
  status: string;
  videoFrames: number;
  audioChunks: number;
}

test.use({ emulatorRom: join(romDir, 'test_gb.gb') });

test.describe('OBS overlay media', () => {
  test('renders a clean browser source, streams media, and applies stream audio control', async ({
    app,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    app.page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    app.page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    const readStatus = async (): Promise<EmulatorSnapshot> =>
      (await (
        await app.request.get(`${app.baseURL}/api/emulator/status`)
      ).json()) as EmulatorSnapshot;

    const response = await app.page.goto(`${app.baseURL}/overlay?client=obs`, {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.ok()).toBe(true);

    const root = app.page.getByTestId('overlay-root');
    const canvas = app.page.getByTestId('overlay-canvas');
    await expect(root).toHaveAttribute('data-overlay-client', 'obs');
    await expect(canvas).toBeVisible();

    // The OBS browser source is stream-clean: no status/FPS/frame/audio/WS
    // counters, mode chips, input ticker, or audio buttons.
    await expect(app.page.getByTestId('overlay-hud')).toHaveCount(0);
    await expect(app.page.getByTestId('emulator-status')).toHaveCount(0);
    await expect(app.page.getByTestId('frame-count')).toHaveCount(0);
    await expect(app.page.getByTestId('audio-count')).toHaveCount(0);
    await expect(app.page.getByTestId('unmute-audio')).toHaveCount(0);

    await expect.poll(async () => (await readStatus()).status, { timeout: 20_000 }).toBe('running');

    await expect
      .poll(async () => (await readStatus()).videoFrames, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const firstFrameCount = (await readStatus()).videoFrames;
    await expect
      .poll(async () => (await readStatus()).videoFrames, { timeout: 20_000 })
      .toBeGreaterThan(firstFrameCount);

    await expect
      .poll(
        () =>
          canvas.evaluate((element) => {
            const gameCanvas = element as HTMLCanvasElement;
            return [gameCanvas.width, gameCanvas.height];
          }),
        { timeout: 20_000 },
      )
      .toEqual([160, 144]);

    const distinctColors = await canvas.evaluate((element) => {
      const gameCanvas = element as HTMLCanvasElement;
      const context = gameCanvas.getContext('2d');
      if (!context) return 0;
      const { data } = context.getImageData(0, 0, gameCanvas.width, gameCanvas.height);
      const colors = new Set<string>();
      for (let index = 0; index < data.length; index += 4 * 97) {
        colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
      }
      return colors.size;
    });
    expect(distinctColors).toBeGreaterThan(1);

    await expect
      .poll(async () => (await readStatus()).audioChunks, { timeout: 20_000 })
      .toBeGreaterThan(0);

    // Streams default to audible. A click grants the browser autoplay gesture;
    // the dashboard/API then controls mute and volume without any overlay UI.
    await canvas.click();
    await expect(root).toHaveAttribute('data-audio-state', 'running');

    const muted = await app.request.post(`${app.baseURL}/api/audio`, {
      data: { muted: true, volume: 0.5 },
    });
    expect(muted.status(), await muted.text()).toBe(200);
    expect(await muted.json()).toEqual({ muted: true, volume: 0.5 });
    await expect(root).toHaveAttribute('data-audio-state', 'muted');
    await expect(root).toHaveAttribute('data-audio-muted', 'true');

    const unmuted = await app.request.post(`${app.baseURL}/api/audio`, {
      data: { muted: false },
    });
    expect(unmuted.status(), await unmuted.text()).toBe(200);
    await expect(root).toHaveAttribute('data-audio-state', 'running');
    await expect(root).toHaveAttribute('data-audio-volume', '0.5');

    // The preview client keeps the diagnostic HUD for local development.
    await app.page.goto(`${app.baseURL}/overlay?client=preview`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(app.page.getByTestId('overlay-hud')).toBeVisible();
    await expect(app.page.getByTestId('emulator-status')).toHaveText('running');
    await expect
      .poll(async () => Number(await app.page.getByTestId('frame-count').textContent()), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => Number(await app.page.getByTestId('audio-count').textContent()), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    expect(pageErrors, 'page errors').toEqual([]);
    expect(consoleErrors, 'console errors').toEqual([]);
  });
});
