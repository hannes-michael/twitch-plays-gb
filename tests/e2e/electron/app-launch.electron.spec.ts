import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { expect, test } from '../../fixtures/server';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test.describe('electron app launch', () => {
  test.beforeAll(() => {
    // The Electron project runs from the real desktop bundle, so make sure the
    // test never exercises a stale or missing build.
    execSync('npm run build:desktop', { cwd: repoRoot, stdio: 'inherit' });
  });

  test('opens the setup screen in a secure window against the real server', async ({ server }) => {
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
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });
    };

    try {
      app = await electron.launch({
        args: [...(process.env.CI ? ['--no-sandbox'] : []), repoRoot],
        env: {
          ...process.env,
          TPG_SERVER_URL: server.baseURL,
          TPG_DEV: '0',
          TPG_TEST: '0',
        },
      });
      app.on('window', trackPage);

      const page = await app.firstWindow();
      trackPage(page);

      await expect(page).toHaveTitle('Twitch Plays GB');
      await expect
        .poll(() =>
          app?.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            if (!window) return null;
            return { title: window.getTitle(), visible: window.isVisible() };
          }),
        )
        .toEqual({ title: 'Twitch Plays GB', visible: true });

      await expect(page.getByRole('heading', { name: 'First-run setup' })).toBeVisible();
      await expect(page.getByTestId('server-status-label')).toHaveText('online');

      expect(pageErrors, 'renderer page errors').toEqual([]);
      expect(consoleErrors, 'renderer console errors').toEqual([]);
    } finally {
      await app?.close();
    }
  });
});
