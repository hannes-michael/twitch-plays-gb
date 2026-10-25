# Testing

Twitch Plays GB is **E2E-first**. Playwright is the primary test tool. We do not
maintain a broad unit-test suite.

## The loop

For every feature:

1. Write or update a feature-level E2E test that describes the user-visible
   behavior.
2. Run it and confirm it fails for the expected reason.
3. Implement the smallest change that makes it pass.
4. Refactor with the test as the safety net.
5. Commit with a conventional commit.

Rules:

- Prefer E2E over unit tests. Add one focused integration test only when a bug
  cannot be reproduced E2E.
- Treat `node-mgba`, Electron, and OBS as dependencies. Test integration, not
  internals.
- Assert DOM state, canvas size/pixels, counters, and visible statuses. Avoid
  full-screen snapshots.
- Use `expect.poll` and explicit UI states instead of arbitrary sleeps.
- Keep the suite small and high-value: roughly 12–18 scenarios in total.
- Drive short timings through normal config values (`TPG_*`), never through
  test-only branches in feature logic.
- Capture traces/videos on failure. Use `npm run test:e2e:ui` to debug locally.

## Commands

```bash
npm run test:e2e          # all projects
npm run test:e2e:ui       # Playwright UI mode
npm run test:e2e:headed   # visible browser/Electron
npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=electron
```

## Projects

| Project    | Directory            | Purpose                              |
| ---------- | -------------------- | ------------------------------------ |
| `chromium` | `tests/e2e/web`      | Browser UI and OBS overlay scenarios |
| `electron` | `tests/e2e/electron` | Desktop shell and capture window     |

## Server fixture

E2E tests start the real server on a random port with a temporary data
directory. The server runs with `TPG_TEST=1` and `--port 0`, prints a
machine-readable URL line, and the fixture waits for `/health` before returning.

```ts
import { test, expect } from '../../fixtures/server';

test('launches', async ({ app }) => {
  // app.page is already navigated to the server; app.baseURL points at it.
  await expect(app.page.getByRole('heading', { name: 'Twitch Plays GB' })).toBeVisible();
  const response = await app.request.get(`${app.baseURL}/health`);
  expect(response.status()).toBe(200);
});
```

The fixture kills the server process on teardown and deletes its temp directory.
Never point tests at your real data directory.

## Fake chat

Test-only injection is available through the UI test panel and a test-only HTTP
endpoint. Both are disabled unless `TPG_TEST=1`. Use them to drive anarchy and
democracy scenarios deterministically; do not mock the emulator.

## Failure artifacts

On failure Playwright retains a trace, video, and screenshot. Open a trace with:

```bash
npx playwright show-trace test-results/<test>/trace.zip
```

## OBS

OBS itself is not automated. Keep the manual checklist in `docs/OBS.md` up to
date and run it on Linux and Windows before a release.
