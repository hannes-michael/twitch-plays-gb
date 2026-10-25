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

The shared fixture exports two things:

- `server` — the running server, with `baseURL`, `dataDir`, `request`, and
  `getLogs()`. Use it for Electron tests that do not have a `page` fixture.
- `app` — the `server` fixture plus a Chromium `page` already navigated to the
  server. Use it for browser tests.

```ts
import { test, expect } from '../../fixtures/server';

test('browser scenario', async ({ app }) => {
  // app.page is already navigated; app.baseURL, app.request, and app.getLogs() exist.
  await expect(app.page.getByRole('heading', { name: 'Twitch Plays GB' })).toBeVisible();
  const response = await app.request.get(`${app.baseURL}/health`);
  expect(response.status()).toBe(200);
});

test('server-only scenario', async ({ server }) => {
  const response = await server.request.get('/health');
  expect(response.status()).toBe(200);
});
```

Test mode refuses to start without an explicit data directory. The fixture
always passes a fresh temp directory through `--data-dir` and deletes it on
teardown. Never point tests at your real data directory.

The vendored ROMs under `tests/fixtures/roms/` boot through the normal `--rom`
config path:

```ts
const server = await startServer({ rom: 'tests/fixtures/roms/test_gb.gb' });
```

For tests that use the `app`/`page` fixture, set the Playwright option instead:

```ts
test.use({ emulatorRom: join(romDir, 'test_gb.gb') });
```

`emulator-boot.spec.ts` boots GB, GBC, and GBA in one scenario and checks model,
native dimensions, frame/audio counters, 48 kHz audio, and `/health`.
`overlay-media.spec.ts` loads `/overlay?client=obs`, checks canvas dimensions
and pixels, growing counters, and the click-to-unmute audio path. Both wait on
real status/counters with `expect.poll`; do not replace them with sleeps.

Production-mode checks use `startServer({ mode: 'production' })`, which runs the
built `dist/server/index.js` with `TPG_TEST=0` against `dist/web`. The production
spec builds both artifacts in `beforeAll` on every run, so stale output is never
tested by accident.

## Electron project

Electron tests live in `tests/e2e/electron` and use Playwright's `_electron`
launcher against the real desktop bundle in `dist/desktop`. The spec builds that
bundle in `beforeAll`, starts the real server through the `server` fixture, and
passes its random-port URL to Electron. Always build the launch environment with
`createElectronEnv` so a developer's `TPG_*`, `HOST`, `PORT`, or `NODE_OPTIONS`
values cannot leak into the scenario:

```ts
const app = await electron.launch({
  args: [`--user-data-dir=${join(server.dataDir, 'electron-profile')}`, repoRoot],
  env: createElectronEnv({ TPG_SERVER_URL: server.baseURL }),
});
const page = await app.firstWindow();
await expect(page).toHaveTitle('Twitch Plays GB');
await expect(page.getByTestId('server-status-label')).toHaveText('online');
```

`server-child.electron.spec.ts` builds web, server, and desktop in `beforeAll`,
launches Electron with **no** `TPG_SERVER_URL`, and proves the shell spawned
`dist/server/index.js` through Electron-as-Node. It checks the setup screen,
same-origin `/api/emulator/status` and `/health`, GB model/dimensions, growing
video/audio counters, and that the child PID exits after `app.close()`.
`capture-window.electron.spec.ts` uses the external server fixture with
`TPG_CAPTURE=1`, finds the window titled `Twitch Plays GB Capture`, and checks
the stable title, black 960 × 540 bounds, 160 × 144 canvas, growing frames,
audio unlock, and reopening from the application menu.

Electron needs a display. On Linux CI this suite runs under
`xvfb-run -a`. The launch adds `--no-sandbox` only when `CI` is set; production
main always keeps the Chromium sandbox enabled. Tests use web-first assertions
and fail if the renderer emits a page error or console error.

## Fake chat (planned, P0-15)

Test-only injection is not implemented yet. When it lands, it will be available
through a UI test panel and a test-only HTTP endpoint, both disabled unless
`TPG_TEST=1`. Use them to drive anarchy and democracy scenarios deterministically;
do not mock the emulator.

## Failure artifacts

On failure Playwright retains a trace, video, and screenshot. Open a trace with:

```bash
npx playwright show-trace test-results/<test>/trace.zip
```

## OBS (manual, pending)

OBS itself is not automated. `docs/OBS.md` documents Browser Source and capture
window setup, audio/autoplay workarounds, and a manual checklist. OBS was not
installed in the environment where the P0-25/P0-26 work was implemented, so the
checklist is **not yet executed**. Run it on Linux and Windows before a release.
