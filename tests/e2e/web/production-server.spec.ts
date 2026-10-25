import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startServer } from '../../fixtures/server';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test.describe('production server', () => {
  test.beforeAll(() => {
    if (!existsSync(join(repoRoot, 'dist', 'web', 'index.html'))) {
      execSync('npm run build:web', { cwd: repoRoot, stdio: 'pipe' });
    }
    if (!existsSync(join(repoRoot, 'dist', 'server', 'index.js'))) {
      execSync('npm run build:server', { cwd: repoRoot, stdio: 'pipe' });
    }
  });

  test('serves the SPA and health while rejecting unknown API and asset paths', async (_fixtures, testInfo) => {
    const server = await startServer({ mode: 'production' });
    let failure: unknown;
    let stopError: unknown;

    try {
      const health = await fetch(`${server.baseURL}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok' });

      const root = await fetch(`${server.baseURL}/`, { headers: { accept: 'text/html' } });
      expect(root.status).toBe(200);
      expect(root.headers.get('content-type')).toContain('text/html');
      expect(await root.text()).toContain('<div id="root"></div>');

      const deepLink = await fetch(`${server.baseURL}/some/deep/link`, {
        headers: { accept: 'text/html' },
      });
      expect(deepLink.status).toBe(200);
      expect(await deepLink.text()).toContain('<div id="root"></div>');

      const api = await fetch(`${server.baseURL}/api/nope`, { headers: { accept: '*/*' } });
      expect(api.status).toBe(404);
      expect(api.headers.get('content-type')).toContain('application/json');
      expect(await api.json()).toEqual({ error: 'Not found' });

      const apiHtml = await fetch(`${server.baseURL}/api/nope`, {
        headers: { accept: 'text/html' },
      });
      expect(apiHtml.status).toBe(404);
      expect(apiHtml.headers.get('content-type')).toContain('application/json');

      const missingAsset = await fetch(`${server.baseURL}/assets/missing.js`, {
        headers: { accept: '*/*' },
      });
      expect(missingAsset.status).toBe(404);

      expect(health.headers.get('cache-control')).toBe('no-store');
    } catch (error) {
      failure = error;
    } finally {
      try {
        await server.stop();
      } catch (error) {
        stopError = error;
      }
    }

    if (failure !== undefined || stopError !== undefined) {
      await testInfo.attach('server-logs', {
        body: server.getLogs(),
        contentType: 'text/plain',
      });
    }
    if (failure !== undefined) throw failure;
    if (stopError !== undefined) throw stopError;
  });
});
