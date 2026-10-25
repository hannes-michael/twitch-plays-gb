import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

interface InputSnapshot {
  lastExecuted: { button: string; user: string } | null;
}

interface EmulatorSnapshot {
  status: string;
  videoFrames: number;
  audioChunks: number;
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

function findCapturePage(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => page.url().includes('/overlay?client=capture'));
}

function findDashboardPage(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => !page.url().includes('/overlay'));
}

test.describe('electron capture window', () => {
  test.beforeAll(() => {
    execSync('npm run build:desktop', { cwd: repoRoot, stdio: 'inherit' });
  });

  test('opens a clean capture window with audio and local input controlled from the dashboard', async ({
    server,
  }) => {
    test.setTimeout(150_000);

    // Give the dashboard persisted settings so it mounts the real dashboard
    // instead of the first-run wizard.
    const gbBytes = await readFile(join(romDir, 'test_gb.gb'));
    const importResponse = await server.request.post('/api/roms', {
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'test_gb.gb' },
      data: gbBytes,
    });
    expect(importResponse.status(), await importResponse.text()).toBe(201);
    const imported = (await importResponse.json()) as { rom: { id: string } };
    const settingsResponse = await server.request.post('/api/settings', {
      data: { channel: 'example_channel', romId: imported.rom.id },
    });
    expect(settingsResponse.status(), await settingsResponse.text()).toBe(200);

    const readStatus = async (): Promise<EmulatorSnapshot> =>
      (await (await server.request.get('/api/emulator/status')).json()) as EmulatorSnapshot;
    const readInput = async (): Promise<InputSnapshot> =>
      (await (await server.request.get('/api/input/state')).json()) as InputSnapshot;

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

      await expect
        .poll(async () => (await findDashboardPage(app as ElectronApplication)) !== undefined, {
          timeout: 20_000,
        })
        .toBe(true);
      const dashboardPage = await findDashboardPage(app);
      expect(dashboardPage).toBeDefined();
      if (!dashboardPage) throw new Error('Dashboard page was not found');
      trackPage(dashboardPage);
      await expect(dashboardPage.getByTestId('server-status-label')).toHaveText('online');
      await expect(dashboardPage.getByTestId('stream-audio-panel')).toBeVisible();

      // The capture surface is stream-clean: the game canvas only.
      const captureRoot = capturePage.getByTestId('overlay-root');
      await expect(captureRoot).toHaveAttribute('data-overlay-client', 'capture');
      await expect(capturePage.getByTestId('overlay-canvas')).toBeVisible();
      await expect(capturePage.getByTestId('overlay-hud')).toHaveCount(0);
      await expect(capturePage.getByTestId('emulator-status')).toHaveCount(0);
      await expect(capturePage.getByTestId('frame-count')).toHaveCount(0);
      await expect(capturePage.getByTestId('audio-count')).toHaveCount(0);
      await expect(capturePage.getByTestId('unmute-audio')).toHaveCount(0);

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

      // The capture window has autoplay enabled, so the default unmuted stream
      // starts without a click.
      await expect
        .poll(async () => (await readStatus()).audioChunks, { timeout: 20_000 })
        .toBeGreaterThan(0);
      await expect(captureRoot).toHaveAttribute('data-audio-state', 'running');

      // Audio is controlled from the Electron dashboard and reaches the
      // capture window over the server WebSocket.
      await expect(dashboardPage.getByTestId('stream-audio-status')).toHaveAttribute(
        'data-audio-muted',
        'false',
      );
      await dashboardPage.getByTestId('toggle-stream-audio').click();
      await expect(dashboardPage.getByTestId('stream-audio-status')).toHaveAttribute(
        'data-audio-muted',
        'true',
      );
      await expect(captureRoot).toHaveAttribute('data-audio-state', 'muted');
      await expect
        .poll(async () => {
          const response = await server.request.get('/api/audio');
          return ((await response.json()) as { muted: boolean }).muted;
        })
        .toBe(true);

      await dashboardPage.getByTestId('toggle-stream-audio').click();
      await expect(dashboardPage.getByTestId('stream-audio-status')).toHaveAttribute(
        'data-audio-muted',
        'false',
      );
      await expect(captureRoot).toHaveAttribute('data-audio-state', 'running');

      // Local input from the dashboard queues and executes without chat.
      await expect(dashboardPage.getByTestId('local-input-RIGHT')).toBeEnabled();
      await dashboardPage.getByTestId('local-input-RIGHT').click();
      await expect.poll(async () => (await readInput()).lastExecuted?.button).toBe('RIGHT');
      await expect.poll(async () => (await readInput()).lastExecuted?.user).toBe('local');
      await expect(dashboardPage.getByTestId('dashboard-recent-inputs')).toContainText('local');

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

      await expect
        .poll(async () => (await readStatus()).videoFrames, { timeout: 20_000 })
        .toBeGreaterThan(0);
      const firstFrameCount = (await readStatus()).videoFrames;
      await expect
        .poll(async () => (await readStatus()).videoFrames, { timeout: 20_000 })
        .toBeGreaterThan(firstFrameCount);

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
      await expect(reopenedPage.getByTestId('overlay-hud')).toHaveCount(0);
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
