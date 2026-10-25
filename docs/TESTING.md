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
npm run smoke:packaged -- --linux   # packaged AppImage + .deb smoke
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
teardown. Never point tests at your real data directory. To simulate a server
restart, create a directory with `mkdtemp`, pass `dataDir` to `startServer` with
`cleanupDataDir: false`, stop and start the process again, then remove the
directory yourself. `server.crash()` SIGKILLs a process and keeps its data
directory for crash-window scenarios.

The vendored ROMs under `tests/fixtures/roms/` boot through the normal `--rom`
config path:

```ts
const server = await startServer({ rom: 'tests/fixtures/roms/test_gb.gb' });
```

For tests that use the `app`/`page` fixture, set the Playwright option instead:

```ts
test.use({ emulatorRom: join(romDir, 'test_gb.gb') });
```

Short input/democracy timings and other server configuration go through the
`serverEnv` option, which is passed as normal server environment (never as a
test-only branch):

```ts
test.use({
  emulatorRom: join(romDir, 'test_gb.gb'),
  serverEnv: {
    TPG_INPUT_COOLDOWN_MS: '300',
    TPG_INPUT_MAX_QUEUE: '2',
    TPG_INPUT_MAX_PER_SECOND: '2',
    TPG_INPUT_STALE_MS: '1500',
    TPG_HOLD_FRAMES: '2',
    TPG_RELEASE_FRAMES: '1',
  },
});
```

`emulator-boot.spec.ts` boots GB, GBC, and GBA in one scenario and checks model,
native dimensions, frame/audio counters, 48 kHz audio, and `/health`.
`overlay-media.spec.ts` loads `/overlay?client=obs`, asserts the stream-clean
canvas (no HUD/debug counters/buttons), checks pixel output and growing server
media counters, and drives mute/volume through `/api/audio`. It then loads
`/overlay?client=preview` and confirms the diagnostic HUD still receives video
and audio counters. Both wait on real status/counters with `expect.poll`; do not
replace them with sleeps.
`chat-input.spec.ts` drives the real GB ROM and fake chat source through the
developer injection endpoint. It proves FIFO execution, per-user cooldown,
global rate cap, queue overflow, queue drain after start, stale drop, and the
preview input ticker. A second scenario proves bots/self messages, bare commands
(with bare mode off), invalid text, and meta commands are ignored; it then
disconnects the fake source through `/api/test/chat/outage`, checks `/api/chat`
and debug status while video/audio counters keep growing, reconnects, and
executes a command. Focused safeguards cover the dev/production chat-source
policy, Twitch `bot-badge`/known-bot mapping, overlapping chat-source
transitions, and input-state WS coalescing. No test connects to real Twitch.

`saves.spec.ts` reuses one temp data directory across server restarts with
`TPG_AUTOSAVE_INTERVAL_MS=250`. It waits for two autosaved generations
(`states/<romId>.state` and `.prev`), saves a known frame index, restarts and
asserts both `restoredFrom: "current"` and a restored `lastFrameIndex` at or
after the saved frame (not a fresh boot). It then corrupts the current file
after shutdown and asserts fallback to `"previous"`. A further save after that
fallback is followed by a simulated SIGKILL (`server.crash()`), corruption of
the new current state, and a restart that must still restore `"previous"`;
orphan `.tmp` files must be cleaned up. The second scenario drives the
dashboard Save button, `/api/emulator/save`, a moderator `!save` versus a
regular viewer's ignored attempt, save-on-stop, and a SIGTERM quit save with a
one-hour autosave interval (proved by the quit log and a changed state mtime).
The third scenario holds `!a` for 600+600 frames and SIGTERMs the server,
proving the active press is cancelled and the quit save still completes without
SIGKILL. The fourth breaks the states directory, then asserts the save failure
is sanitized in status/debug, the dashboard shows a failure instead of "No
running emulator", and the Save button is disabled while stopped. Status/
settings/debug JSON must not contain the data directory. The vendored fixture
ROMs have no battery-backed SRAM, so no battery file is expected; save states
are covered instead of fabricated battery data.

`setup-import.spec.ts` is the first-run scenario: it checks the legal notice and
channel step, rejects invalid ROM uploads, imports the vendored GB ROM through
the file input, reviews and finishes setup, and then drives Stop, Start, and
Restart from the dashboard. It asserts persisted settings, server-generated
`roms/<id>.gb` filenames, duplicate deduplication, no absolute paths in API
payloads, and no renderer page/console errors. It also exercises dashboard
stream-audio mute/volume, local D-pad and keyboard input, rejection while
stopped, and invalid button validation. `app-launch.spec.ts` separately checks
that Continue advances to ROM import without writing settings before Finish.

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
`dist/server/index.js` through Electron-as-Node. It passes a repo-relative
`TPG_ROM` and asserts the resolved absolute path in the desktop log, then checks
the setup screen, same-origin `/api/emulator/status` and `/health`, GB
model/dimensions, growing video/audio counters, and that the child PID exits
after `app.close()`. A second launch with `TPG_TEST=1` and short timing values
asserts the shell forwards `TPG_DEMOCRACY_WINDOW_MS`, `TPG_HOLD_FRAMES`, and
`TPG_RELEASE_FRAMES` to the spawned child (`/api/debug.timings`). The same
forwarding list also includes the input cooldown/queue/rate/stale values,
`TPG_AUTOSAVE_INTERVAL_MS`, bare commands, and chat source policy.
`capture-window.electron.spec.ts` uses the external server fixture with
`TPG_CAPTURE=1`, finds the window titled `Twitch Plays GB Capture`, and checks
the stable title, black 960 × 540 bounds, stream-clean 160 × 144 canvas, growing
frames, and reopening from the application menu. The dashboard (seeded with
settings through the public API) controls mute/volume and local input; the test
asserts those changes reach the capture window over the WebSocket and the
server input queue.

Electron needs a display. On Linux CI this suite runs under
`xvfb-run -a`. The launch adds `--no-sandbox` only when `CI` is set; production
main always keeps the Chromium sandbox enabled. Tests use web-first assertions
and fail if the renderer emits a page error or console error.

## Packaged smoke (P0-28)

The Playwright suite covers source builds. Packaged artifacts get a separate,
dependency-free Node harness:

```bash
npm run package:linux
npm run smoke:packaged -- --linux

npm run package:win
npm run smoke:packaged -- --win          # Windows
npm run smoke:packaged -- --win --wine   # best effort on Linux

npm run bundle:linux                     # versioned output in release/<version>/
npm run smoke:packaged -- --linux --release-dir release/<version>
```

`npm run bundle`, `bundle:linux`, `bundle:win`, and `bundle:all` build without
the E2E suite and keep each version's artifacts in `release/<version>/`. Use
`--release-dir <path>` to point the smoke harness at a versioned directory.

`scripts/smoke-packaged.mjs` launches each selected artifact with `--self-test`.
Self-test mode is headless: no dashboard/capture windows, no menu, no dialogs.
It still spawns the real server child through Electron-as-Node and checks:

- the child has a real PID and `/health` is healthy;
- `GET /` and `GET /overlay?client=obs` return 200 HTML from the packaged
  assets, not Vite middleware;
- every referenced `<script src>`, stylesheet, and modulepreload URL returns
  200 with a JS/CSS content type and a non-empty body, and a missing
  `/assets/...` request returns 404;
- the child logs show `dev=false test=false` even when the harness exports
  `TPG_DEV=1`/`TPG_TEST=1`;
- with `TPG_ROM`, `/api/emulator/status` becomes `running` with a model and
  native dimensions, both video and audio counters grow across a second poll,
  and audio is 48000 Hz;
- the child exits and its PID is gone after the app exits.

The harness sets `TPG_DATA_DIR` to a temp directory, `TPG_ROM` to the vendored
GB ROM, and `TPG_SELF_TEST_RESULT` to a JSON result path for every target. The
app writes the result file atomically before exiting; the harness validates
that file instead of relying on stdout, which the NSIS portable wrapper does
not reliably inherit. It removes the data directory, result file, extraction
directory, and installer directory afterwards. `--no-rom` checks the
server/UI path without the emulator. Linux uses `xvfb-run -a` when no display
is set and it is installed. The AppImage is first attempted with
`APPIMAGE_EXTRACT_AND_RUN=1`; if the runtime hangs before launching, the
harness extracts it with `--appimage-extract` and runs the extracted `AppRun`.
The `.deb` is extracted with `dpkg-deb` or `ar` + `tar`. The NSIS installer uses
a space-free install root because `/D` does not accept quoted paths.

The harness adds `--no-sandbox` only when the host is root or Chromium reports a
sandbox failure. This is a test-runner workaround, never a production default.
Logs are written to `test-results/packaged-smoke/` (git-ignored). The separate
`package-smoke.yml` workflow runs Linux under Xvfb and Windows natively, and
uploads logs/artifacts on failure.

## Fake chat and developer panel (P0-10/P0-11/P0-15)

Servers started with `TPG_DEV=1` or `TPG_TEST=1` expose the developer-only
routes below. Test mode always uses a fake chat source. Development uses the
fake source only until a channel is configured; with a channel it connects to
real anonymous Twitch chat, and `TPG_CHAT=fake` forces fake chat.

- `GET /api/debug` returns mode, resolved timings, emulator save state/media
  counters, chat status plus recent messages, the full input state/stats, WS
  client count, and queue length/votes.
- `POST /api/test/chat` accepts `{ "user": "...", "text": "..." }` and an
  optional `roles` object (`broadcaster`, `mod`, `vip`, `bot`, `self`) (user ≤ 32
  characters, text ≤ 200, trimmed, control characters rejected), injects the
  message into the fake source, and returns `201 { ok: true, message }`. Invalid
  payloads return 400.
- `POST /api/test/chat/outage` accepts `{ "outage": true|false }`, disconnects or
  reconnects the fake source, and returns `{ ok: true, chat }`. It returns 503 if
  the active source is not fake and 404 in production.

`GET /api/input/state` exposes the input queue/stats and `GET /api/chat` exposes
the current chat status. Both are read-only and available in production for the
dashboard. Input state is also pushed over the WebSocket as `input-state` on
connect and on every change. `POST /api/input` (local operator input) and
`GET`/`POST /api/audio` (stream mute/volume) are normal dashboard endpoints
available in every mode; audio changes are broadcast as `audio-state`.

The dashboard mounts the **Developer** panel only when `/health` reports dev/test
mode, then renders it once `/api/debug` answers 200. Production never requests
the debug endpoint. The test-chat form calls the same `POST /api/test/chat` path
as external callers;
it does not use a UI-only bypass. Injected messages are also broadcast as
`{ "type": "chat", "message": ... }` on `/ws`. Text is rendered as React text
nodes, never HTML.

Production mode starts anonymous read-only Twitch chat only when a channel is
configured (or no source when not); it never starts the fake source and returns
JSON 404 for all three developer routes. The developer routes also require a
loopback peer, so binding to `0.0.0.0` does not expose debug state or injection
to the LAN. Tests never connect to real Twitch; use fake chat and do not mock the
emulator.

`dev-panels.spec.ts` covers the panel metrics, fake source status, API and form
injection, XSS escaping, WS broadcast, and malformed payload. It also checks the
real WS client count. `server-cli.spec.ts` starts a server with
`TPG_DEMOCRACY_WINDOW_MS=750`, `TPG_HOLD_FRAMES=2`, and
`TPG_RELEASE_FRAMES=1` plus the input timing values and
`TPG_BARE_COMMANDS=1`; it asserts the resolved timings in `/api/debug` and that
a bare `up` message is accepted. Short timings use normal config rather than
test-only branches.
`chat-input.spec.ts` covers the input queue, stats, cooldown/rate/overflow
drops, drain-after-start, overlay ticker, chat filtering, and the fake outage
endpoint.

The Twitch source itself is intentionally not E2E-tested: the suite has no
network dependency and runs with the fake source even in dev/test. It compiles
into the real server build and uses `ChatClient` anonymous mode with no
credentials.

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
