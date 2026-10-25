import type { Page } from '@playwright/test';
import { expect, startServer, test, type TestServer } from '../../fixtures/server';

test.describe('embedded Vite HMR', () => {
  test('connects HMR on two concurrent test servers without renderer errors', async ({
    browser,
    server,
  }) => {
    let secondServer: TestServer | undefined;
    const pages: Page[] = [];
    const errors: string[] = [];
    const hmrConnections = new Set<string>();

    const openApp = async (baseURL: string): Promise<Page> => {
      const page = await browser.newPage();
      pages.push(page);
      page.on('pageerror', (error) => {
        errors.push(`${baseURL} pageerror: ${error.message}`);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          errors.push(`${baseURL} console error: ${message.text()}`);
        }
        if (message.text().includes('[vite] connected.')) {
          hmrConnections.add(baseURL);
        }
      });

      const response = await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      expect(response?.ok()).toBe(true);
      await expect(page.getByRole('heading', { name: 'First-run setup' })).toBeVisible();
      await expect(page.getByTestId('server-status-label')).toHaveText('online');
      return page;
    };

    try {
      secondServer = await startServer();
      await openApp(server.baseURL);
      await openApp(secondServer.baseURL);

      await expect.poll(() => hmrConnections.size).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(pages.map((page) => page.close()));
      await secondServer?.stop();
    }
  });
});
