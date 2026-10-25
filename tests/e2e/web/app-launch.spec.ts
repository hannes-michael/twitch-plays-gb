import { test, expect } from '../../fixtures/server';

test.describe('app launch', () => {
  test('shows the first-run setup screen and a healthy server', async ({ app }) => {
    const response = await app.request.get(`${app.baseURL}/health`);
    expect(response.status()).toBe(200);

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
});
