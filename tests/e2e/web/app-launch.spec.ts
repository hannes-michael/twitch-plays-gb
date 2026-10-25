import { test, expect } from '../../fixtures/server';

test.describe('app launch', () => {
  test('shows the first-run setup screen and a healthy server', async ({ app }) => {
    const response = await app.request.get(`${app.baseURL}/health`);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');

    const health = await response.json();
    expect(health).toMatchObject({
      status: 'ok',
      emulator: 'stopped',
      clients: { total: expect.any(Number) },
    });
    expect(typeof health.version).toBe('string');
    expect(health.version.length).toBeGreaterThan(0);
    expect(typeof health.uptime).toBe('number');

    await expect(app.page.getByRole('heading', { name: 'Twitch Plays GB' })).toBeVisible();
    await expect(app.page.getByRole('heading', { name: 'First-run setup' })).toBeVisible();
    await expect(app.page.getByText('Before you start')).toBeVisible();
    await expect(
      app.page.getByText(/You must supply your own legally obtained ROMs/),
    ).toBeVisible();
    await expect(app.page.getByLabel('Twitch channel')).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(app.page.getByTestId('server-status-label')).toHaveText('online');
  });

  test('returns a JSON 404 for unknown API routes instead of proxying them', async ({ app }) => {
    const response = await app.request.get(`${app.baseURL}/api/nope`, {
      headers: { accept: '*/*' },
    });

    expect(response.status()).toBe(404);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  test('makes clear that the channel setup action is not persisted yet', async ({ app }) => {
    await app.page.getByLabel('Twitch channel').fill('example');
    await app.page.getByRole('button', { name: 'Continue' }).click();

    const notice = app.page
      .getByRole('status')
      .filter({ hasText: /example|not saved|not available|preview/i });
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText(/saved for this session/i);
    await expect(notice).toContainText(/not saved|not available yet|preview/i);
  });
});
