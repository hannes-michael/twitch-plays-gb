import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createElectronEnv, expect, test } from '../../fixtures/server';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const romDir = fileURLToPath(new URL('../../fixtures/roms/', import.meta.url));
const CAPTURE_TITLE = 'Twitch Plays GB Capture';

test.use({ emulatorRom: join(romDir, 'test_gb.gb') });

interface CaptureWindowInfo {
  title: string;
  bounds: { width: number; height: number };
  backgroundColor: string;
  url: string;
  visible: boolean;
}

async function readWindows(app: ElectronApplication): Promise<CaptureWindowInfo[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      title: window.getTitle(),
      bounds: window.getBounds(),
      backgroundColor: window.getBackgroundColor(),
      url: window.webContents.getURL(),
      visible: window.isVisible(),
    })),
  );
}

async function findCapturePage(app: ElectronApplication): Promise<Page | undefined> {
  const pages = app.windows();
  return pages.find((page) => page.url().includes('/overlay?client=capture'));
}

test.describe('electron capture window', () => {
  test.beforeAll(() => {
    execSync('npm run build:desktop', { cwd: repoRoot, stdio: 'inherit' });
  });

  test('opens a stable, black, audio-capable capture window and reopens it from the menu', async ({
    server,
  }) => {
    test.setTimeout(120_000);

    let app: ElectronApplication | undefined;
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const trackedPages = new WeakSet<Page>();

    const trackPage = (page: Page): void => {
      if (trackedPages.has(page)) return;
      trackedPages.add(page);

      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
    };

    try {
      app = await electron.launch({
        args: [
          ...(process.env.CI ? ['--no-sandbox'] : []),
          `--user-data-dir=${join(server.dataDir, 'electron-profile')}`,
          repoRoot,
        ],
        env: createElectronEnv({
          TPG_SERVER_URL: server.baseURL,
          TPG_CAPTURE: '1',
          TPG_DEV: '0',
          TPG_TEST: '0',
        }),
      });
      app.on('window', trackPage);
      for (const page of app.windows()) trackPage(page);

      // TPG_CAPTURE=1 opens the capture window at startup, in addition to the
      // dashboard. Wait for its URL rather than assuming window order.
      await expect
        .poll(async () => (await findCapturePage(app as ElectronApplication)) !== undefined, {
          timeout: 20_000,
        })
        .toBe(true);

      const capturePage = await findCapturePage(app);
      expect(capturePage).toBeDefined();
      if (!capturePage) throw new Error('Capture window page was not found');
      trackPage(capturePage);

      await expect(capturePage.getByTestId('overlay-canvas')).toBeVisible();
      await expect(capturePage.getByTestId('emulator-status')).toHaveText('running');

      await expect
        .poll(
          async () =>
            (await readWindows(app as ElectronApplication)).find((window) =>
              window.url.includes('/overlay?client=capture'),
            )?.title,
          { timeout: 20_000 },
        )
        .toBe(CAPTURE_TITLE);

      const captureWindow = (await readWindows(app)).find((window) =>
        window.url.includes('/overlay?client=capture'),
      );
      expect(captureWindow).toMatchObject({
        title: CAPTURE_TITLE,
        bounds: { width: 960, height: 540 },
        backgroundColor: '#000000',
        visible: true,
      });

      // The capture window is configured with
      // autoplayPolicy: 'no-user-gesture-required'. Electron does not expose
      // that preference back through getLastWebPreferences(), so verify the
      // observable effect: an AudioContext starts running without a gesture.
      const audioContextState = await capturePage.evaluate(async () => {
        const context = new AudioContext();
        const state = context.state;
        await context.close();
        return state;
      });
      expect(audioContextState).toBe('running');

      // The document title must not override the stable OBS window title.
      await capturePage.evaluate(() => {
        document.title = 'Overlay';
      });
      await expect(capturePage).toHaveTitle('Overlay');
      await expect
        .poll(
          async () =>
            (await readWindows(app as ElectronApplication)).find((window) =>
              window.url.includes('/overlay?client=capture'),
            )?.title,
        )
        .toBe(CAPTURE_TITLE);

      const canvas = capturePage.getByTestId('overlay-canvas');
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

      const frameCount = capturePage.getByTestId('frame-count');
      await expect
        .poll(async () => Number(await frameCount.textContent()), { timeout: 20_000 })
        .toBeGreaterThan(0);
      const firstFrameCount = Number(await frameCount.textContent());
      await expect
        .poll(async () => Number(await frameCount.textContent()), { timeout: 20_000 })
        .toBeGreaterThan(firstFrameCount);

      await expect
        .poll(async () => Number(await capturePage.getByTestId('audio-count').textContent()), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      const audioState = capturePage.getByTestId('audio-state');
      if ((await audioState.getAttribute('data-audio-state')) !== 'running') {
        await capturePage.getByTestId('unmute-audio').click();
      }
      await expect(audioState).toHaveAttribute('data-audio-state', 'running');

      // Closing the capture window leaves the dashboard running. The menu item
      // reopens (or focuses) the capture window.
      await app.evaluate(({ BrowserWindow }) => {
        const capture = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes('/overlay?client=capture'),
        );
        capture?.close();
      });
      await expect
        .poll(async () => (await findCapturePage(app as ElectronApplication)) === undefined)
        .toBe(true);
      expect((await app.windows()).length).toBe(1);

      await app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('open-capture-window');
        if (!item) throw new Error('Open Capture Window menu item is missing');
        (item as unknown as { click: () => void }).click();
      });

      await expect
        .poll(async () => (await findCapturePage(app as ElectronApplication)) !== undefined, {
          timeout: 20_000,
        })
        .toBe(true);
      const reopenedPage = await findCapturePage(app);
      expect(reopenedPage).toBeDefined();
      if (!reopenedPage) throw new Error('Reopened capture window page was not found');
      trackPage(reopenedPage);
      await expect(reopenedPage.getByTestId('overlay-canvas')).toBeVisible();
      await expect
        .poll(
          async () =>
            (await readWindows(app as ElectronApplication)).find((window) =>
              window.url.includes('/overlay?client=capture'),
            )?.title,
        )
        .toBe(CAPTURE_TITLE);

      expect(pageErrors, 'renderer page errors').toEqual([]);
      expect(consoleErrors, 'renderer console errors').toEqual([]);
    } finally {
      await app?.close().catch(() => {});
    }
  });
});
