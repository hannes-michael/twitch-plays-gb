import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startServer } from '../../fixtures/server';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test.describe('production server', () => {
  test.beforeAll(() => {
    // Always build so this suite can never silently test stale artifacts.
    execSync('npm run build:web', { cwd: repoRoot, stdio: 'inherit' });
    execSync('npm run build:server', { cwd: repoRoot, stdio: 'inherit' });
  });

  test('serves the SPA and health while rejecting unknown API and asset paths', async ({
    browserName: _browserName,
  }, testInfo) => {
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

      // Developer endpoints are dev/test-only; production must never expose
      // debug state or a fake-chat injection path.
      const debug = await fetch(`${server.baseURL}/api/debug`);
      expect(debug.status).toBe(404);
      expect(await debug.json()).toEqual({ error: 'Not found' });

      const testChat = await fetch(`${server.baseURL}/api/test/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: 'dev', text: 'production must reject this' }),
      });
      expect(testChat.status).toBe(404);
      expect(await testChat.json()).toEqual({ error: 'Not found' });

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

  test('serves root for default/HEAD requests and guards assets and encoded API paths', async ({
    browserName: _browserName,
  }, testInfo) => {
    const server = await startServer({ mode: 'production' });
    let failure: unknown;
    let stopError: unknown;

    try {
      const defaultRoot = await fetch(`${server.baseURL}/`);
      expect(defaultRoot.status).toBe(200);
      expect(await defaultRoot.text()).toContain('<div id="root"></div>');

      const headRoot = await fetch(`${server.baseURL}/`, { method: 'HEAD' });
      expect(headRoot.status).toBe(200);

      const missingAsset = await fetch(`${server.baseURL}/assets/missing`, {
        headers: { accept: 'text/html' },
      });
      expect(missingAsset.status).toBe(404);

      const encodedApi = await fetch(`${server.baseURL}/api%2Fnope`, {
        headers: { accept: 'text/html' },
      });
      expect(encodedApi.status).toBe(404);
      expect(encodedApi.headers.get('content-type')).toContain('application/json');
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
