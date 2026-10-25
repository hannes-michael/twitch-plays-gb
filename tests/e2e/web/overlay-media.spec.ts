import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../../fixtures/server';

const romDir = fileURLToPath(new URL('../../fixtures/roms/', import.meta.url));

test.use({ emulatorRom: join(romDir, 'test_gb.gb') });

test.describe('OBS overlay media', () => {
  test('renders emulator video and unlocks streamed audio', async ({ app }) => {
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

    const response = await app.page.goto(`${app.baseURL}/overlay?client=obs`, {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.ok()).toBe(true);

    const canvas = app.page.getByTestId('overlay-canvas');
    await expect(canvas).toBeVisible();
    await expect(app.page.getByTestId('emulator-status')).toHaveText('running');

    const frameCount = app.page.getByTestId('frame-count');
    await expect
      .poll(async () => Number(await frameCount.textContent()), { timeout: 20_000 })
      .toBeGreaterThan(0);

    const firstFrameCount = Number(await frameCount.textContent());
    await expect
      .poll(async () => Number(await frameCount.textContent()), { timeout: 20_000 })
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

    const audioCount = app.page.getByTestId('audio-count');
    await expect
      .poll(async () => Number(await audioCount.textContent()), { timeout: 20_000 })
      .toBeGreaterThan(0);

    await expect(app.page.getByTestId('audio-state')).toHaveAttribute('data-audio-state', 'muted');
    await app.page.getByTestId('unmute-audio').click();
    await expect(app.page.getByTestId('audio-state')).toHaveAttribute(
      'data-audio-state',
      /running|unlocked/,
    );

    expect(pageErrors, 'page errors').toEqual([]);
    expect(consoleErrors, 'console errors').toEqual([]);
  });
});
