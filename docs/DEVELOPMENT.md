# Development

Twitch Plays GB is a single TypeScript package with a local Express server, a
React UI, and an Electron shell. This guide covers the development loop,
commands, data directories, and the VS Code setup.

## Requirements

- Node.js 22 (see `.nvmrc`)
- npm
- Linux x64 or Windows x64
- A display for the Electron window. On a headless Linux machine, use
  `xvfb-run` for tests (see `docs/TESTING.md`).

Install dependencies and Playwright's Chromium once:

```bash
npm install
npx playwright install chromium
```

## One-command dev loop

```bash
npm run dev
```

This command:

1. Starts the real server with `tsx watch` and `TPG_DEV=1`. Vite runs embedded
   in the server, so the UI has hot module replacement and the API has no
   separate proxy process.
2. Waits for the server to print `TPG_URL=...` and answer `/health`.
3. Builds `dist/desktop` with tsup and launches Electron against that server.
4. Watches `src/desktop` and rebuilds plus restarts Electron when main or
   preload code changes.

The server listens on `http://127.0.0.1:3000` by default. Open the same URL in
a browser if you want a second view of the UI. Server code changes are handled
by `tsx watch`; the Electron window stays open when the URL is unchanged and
reconnects through its health poll. If Electron exits, the dev command shuts
the server down and exits instead of restarting in a loop.

Child output is prefixed with `[server]`, `[build]`, `[electron]`, or `[dev]`.
The server logs its resolved data directory on startup. Vite's HMR WebSocket is
served by that same server on `/__vite_hmr`, so concurrent dev/test servers do
not share a fixed HMR port.

## Booting a ROM

Pass a `.gb`, `.gbc`, or `.gba` file through normal configuration to boot the
emulator when the server starts. The server stores it as an absolute path.
Missing files and other extensions are configuration errors.

When the desktop shell spawns its own server, it resolves a relative `TPG_ROM`
against the desktop process working directory first, then against the data
directory, and passes an absolute `--rom` to the child. Absolute paths are
unchanged. The standalone server (`npm start` or `npm run dev:web`) resolves
relative paths against its own working directory.

```bash
# One-command dev (env var; `npm run dev` forwards args to Electron)
TPG_ROM=tests/fixtures/roms/test_gb.gb npm run dev

# Browser-only server with a CLI flag
npm run dev:web -- --rom tests/fixtures/roms/test_gb.gb

# Built server
npm start -- --rom tests/fixtures/roms/test_gb.gb
```

The server starts without a ROM by default, so `/`, `/health`, and the setup
screen keep working. With a ROM, `/api/emulator/status` reports the model,
dimensions, frame/audio counters, and 48 kHz audio state, and
`/overlay?client=obs` renders the live canvas. The OBS browser source and the
Electron capture window are stream-clean: no counters, status chips, ticker, or
audio buttons. Use `/overlay?client=preview` (or no `client`) for the diagnostic
HUD. Stream audio is controlled from the dashboard (mute and volume) and applies
to every overlay client. If a browser blocks autoplay, clicking the clean
overlay once retries the audio unlock; OBS can also allow autoplay itself.

## First-run setup, ROM library, and lifecycle

When no channel and ROM are saved yet, the UI shows the first-run wizard:

1. Twitch channel and legal notice.
2. ROM import with a file picker or drag/drop.
3. Review, **Finish setup**, then the dashboard.

Imports are validated on the server. `POST /api/roms` accepts raw
`application/octet-stream` bytes with an `x-filename` header; the file must be
`.gb`, `.gbc`, or `.gba` (case-insensitive), 32 KiB–32 MiB, and have a valid
Nintendo logo for its platform (GB/GBC or GBA) plus the GBA fixed `0x96` header
byte. Client filenames are only sanitized display names. Disk files are always
`<dataDir>/roms/<sha256>.<extension>`, and identical bytes deduplicate. ROM
metadata is persisted in `<dataDir>/roms.json`; `GET /api/roms` and
`GET /api/roms/:id` never expose filesystem paths. Concurrent imports are
serialized, and corrupt `settings.json` or `roms.json` files fall back to
defaults with a warning instead of blocking server startup.

**Finish setup** writes `<dataDir>/settings.json` and explicitly starts the
selected ROM. The dashboard exposes Start, Stop, Restart, Save, stream-audio
mute/volume, manual D-pad/keyboard input, an OBS overlay link, and Reconfigure.
`POST /api/emulator/start|stop|restart` are serialized by the emulator service
and return `{ "status": ... }`. A failed boot returns HTTP 200 with
`status: "error"` and a sanitized `lastError`, so the server stays up and the UI
can show the failure. On server start `--rom` wins over the saved ROM; the saved
ROM starts when no `--rom` is given. A configured `--rom`
reports `romId: null`.

Battery-backed SRAM is flushed on stop to `<dataDir>/saves/<key>.sav` when the
cartridge has a battery. Save states live in `<dataDir>/states/<key>.state` with
one previous generation at `<key>.state.prev`. Imported ROMs use their 64-hex
`romId` as the key; a `--rom` session uses `rom-<first 16 hex of the ROM's
sha256>`, so the saves survive moving or renaming the file. A state is written
through a temp file and rotated, so a crash always leaves one loadable
generation. Leftover temp files are removed when the ROM starts.

States are saved every 60 seconds by default (configurable), on Stop, Restart,
ROM change, server quit, and through the dashboard **Save now** button or the
broadcaster/mod `!save` command. On boot the newest valid state is restored,
falling back to the previous generation when the current file is corrupt. After
a fallback, the next save discards the corrupt current instead of replacing the
valid previous generation; the new current is installed atomically before the
previous is removed on a later normal save. The status reports `lastFrameIndex`
from the restored emulator core, so a restart resumes at the saved frame rather
than a fresh boot. A long chat input press is cancelled before Stop/quit so the
save fits inside the shutdown timeout. A restart boots a fresh session after
saving the old one. The vendored fixture ROMs have no battery-backed SRAM, so
battery saves legitimately write no file.

## Chat source and anarchy input

Production selects the Twitch chat source when a channel is configured (from
`--channel`/`TPG_CHANNEL` or the saved setup channel). It connects anonymously
with `@twurple/chat`; no account token, OAuth secret, or stream key is stored or
required. Twurple owns reconnect attempts, while `/api/chat` and the developer
panel expose `connected`, `channel`, and a bounded `lastError`. Source
transitions are serialized, so overlapping channel changes close the older
client and only the newest channel stays connected. Chat failures never stop the
emulator or its input queue.

Test mode always uses the deterministic fake source and never touches the
network. Development uses real anonymous Twitch chat as soon as a channel is
configured, so a normal `npm run dev` session with a saved or `TPG_CHANNEL`
channel interacts with actual chat. With no channel, development keeps the fake
source for the developer panel; `TPG_CHAT=fake` forces fake chat. In production
`TPG_CHAT=fake` reports no source rather than exposing a fake chat that has no
external input.

Chat messages become input when they match a command. The `!` prefix is
required by default (`!right`, `!a`, `!start`); aliases include `u`, `d`,
`st`, and `sel`. Set `TPG_BARE_COMMANDS=1` (or `--bare-commands`) to accept the
same commands without `!`. Matching is case-insensitive. `mode`, `pause`, and
`resume` are recognized as meta commands but are ignored until the
mode/pause work lands. `save` is available to the broadcaster and moderators
and writes a save state; other users are ignored, with the latest attempt
visible as `lastMeta` in `/api/input/state`. Invalid messages, known bots
(`nightbot`, `streamelements`, `streamlabs`, `moobot`, `fossabot`,
`commanderroot`, `sery_bot`), Twitch bot badges (`bot-badge`/`twitchbot`),
and self messages never enter the queue.

Anarchy input is FIFO. A message can be dropped for a per-user cooldown,
global accepted-inputs-per-second cap, a full queue, a stale queue entry at
execution time, or an emulator press error. The queue only drains while the
emulator is running. Stopping the emulator keeps queued inputs; starting it
again drains them (subject to staleness). `/api/input/state` exposes the mode,
queue, recent events (bounded to 10), stats, last execution, and last drop.
Input changes are broadcast on `/ws` as `{ "type": "input-state", "input": ... }`
and new clients receive the current state immediately. Input-state broadcasts
are coalesced to at most 10 Hz with a trailing update, and text broadcasts skip
clients whose WebSocket buffer exceeds 512 KiB. The dashboard polls the state
once per second, and the preview overlay consumes the WS messages for its mode,
queue count, and recent-input ticker.

The dashboard also owns local controls. `POST /api/input` with
`{ "button": "UP" }` enqueues an operator input (`source: "local"`, user
`local`); it bypasses chat cooldowns and the global rate cap but still respects
the queue cap and only runs while the emulator is running. The response is
`{ accepted, reason?, input }`, where `reason` is `not-running`, `queue-full`, or
an execution drop reason. Manual buttons and these keyboard shortcuts send the
same request when focus is not in a form control: arrows, `X` (A), `Z` (B),
`Enter` (Start), `Shift` (Select), `Q` (L), and `W` (R).

`GET /api/audio` returns `{ muted, volume }`, and `POST /api/audio` updates
either field (`volume` is 0..1). The state is shared by all overlay clients and
broadcast on `/ws` as `{ "type": "audio-state", "audio": ... }`; new clients
receive it immediately. The stream starts unmuted at full volume. The clean OBS
and capture clients apply the state without any visible debug UI; the preview
client also shows playback state and an unlock button. If a browser blocks
autoplay, a click on the clean overlay retries `AudioContext.resume()`.

`--rom` sessions keep their last successful start options for Start and Restart
requests without an explicit `romId`, so lifecycle controls never switch to the
saved UI selection. A saved selection is only used when no `--rom` session has
been started.

`tests/fixtures/roms/` contains open-source homebrew ROMs for automated tests;
they are not playable games. See `NOTICE.md` there for licenses.

## Commands

| Command                   | What it does                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev`             | Server watch + embedded Vite HMR + Electron, with Electron restart on desktop changes |
| `npm run dev:web`         | Server watch + embedded Vite HMR, no Electron (browser-only)                          |
| `npm run dev:electron`    | Build the desktop bundle and launch Electron against an already-running server        |
| `npm run build`           | Build the web UI, server, and desktop bundles into `dist/`                            |
| `npm start`               | Run the built production server (`dist/server/index.js`)                              |
| `npm run typecheck`       | TypeScript, no emit                                                                   |
| `npm run lint`            | ESLint                                                                                |
| `npm run format`          | Prettier, write                                                                       |
| `npm run format:check`    | Prettier, check only                                                                  |
| `npm run test:e2e`        | All Playwright projects (Chromium + Electron)                                         |
| `npm run test:e2e:ui`     | Playwright UI mode                                                                    |
| `npm run test:e2e:headed` | Playwright with visible browser/Electron windows                                      |
| `npm run package:linux`   | Build, then run electron-builder for Linux (AppImage + .deb)                          |
| `npm run package:win`     | Build, then run electron-builder for Windows (NSIS + portable)                        |
| `npm run bundle`          | Build + package for the host platform into `release/<version>/` (no E2E)              |
| `npm run bundle:linux`    | Build + package Linux targets into `release/<version>/` (no E2E)                      |
| `npm run bundle:win`      | Build + package Windows targets into `release/<version>/` (no E2E)                    |
| `npm run smoke:packaged`  | Headless smoke test for packaged artifacts (see `docs/TESTING.md`)                    |

`dev:web` prints `TPG_URL=http://127.0.0.1:<port>` when the server is ready.
Open that URL in a browser. Override the port with `TPG_PORT=3001` or, for the
built server, `npm start -- --port 3001`. Use `--port 0` for a random port.

`dev:electron` checks `/health` first and exits with an actionable message if
the server is not reachable. Point it at another server with
`TPG_SERVER_URL=http://127.0.0.1:3001` (PowerShell:
`$env:TPG_SERVER_URL = 'http://127.0.0.1:3001'`).

When `TPG_SERVER_URL` is unset, the desktop shell spawns the built server itself
instead of expecting an external one. From a source checkout:

```bash
npm run build
node_modules/.bin/electron . \
  --user-data-dir="$PWD/data/dev/electron" \
  --no-sandbox
```

The child runs `dist/server/index.js` through the Electron binary with
`ELECTRON_RUN_AS_NODE=1`, binds a random loopback port, and prints
`[desktop] server child ready at http://127.0.0.1:<port> (pid ...)` plus
`[server]` prefixed output. Quit Electron normally; it stops the child and
escalates to SIGKILL if the child does not exit within 5 seconds. Use
`TPG_DATA_DIR` to isolate its data directory and `TPG_ROM` to boot a ROM. The
one-command dev workflow still runs an external server and points Electron at it
with `TPG_SERVER_URL`, so it does not use the spawn path.

Packaged apps ignore inherited `TPG_DEV`, `TPG_TEST`, and `TPG_SERVER_ENTRY`.
The child always runs with `TPG_DEV=0`, `TPG_TEST=0`, and the unpacked server
entry; it serves built assets rather than mounting Vite. `TPG_DATA_DIR` still
wins when explicitly set; otherwise packaged apps use Electron's `userData`
directory.

## Packaging and packaged smoke tests

`npm run package:linux` builds the AppImage and `.deb` into `release/`.
`npm run package:win` builds the NSIS installer and portable `.exe` there. Both
scripts pass `--publish never` so CI's implicit electron-builder publishing
cannot require a GitHub token. The electron-builder config unpacks `dist/**`,
`package.json`, and runtime
`node_modules/**` so the spawned server entry can resolve bare imports and load
`node-mgba`'s worker and native libraries outside the asar. `release/` is
git-ignored; never commit build artifacts.

For versioned release bundling without the E2E suite, use `npm run bundle`
(host platform), `npm run bundle:linux`, `npm run bundle:win`, or
`npm run bundle:all`. These write artifacts to `release/<version>/` so builds
of different versions never mix. Add `--skip-build` to reuse `dist/`, or
`--clean` to empty the version directory first. The smoke harness accepts
`--release-dir <path>` so you can test a versioned directory:
`npm run smoke:packaged -- --linux --release-dir release/0.1.1`.

Every artifact is checked through the packaged app's headless self-test mode:

```bash
npm run smoke:packaged -- --linux              # AppImage + .deb
npm run smoke:packaged -- --linux --unpacked   # also release/linux-unpacked
npm run smoke:packaged -- --linux --no-rom     # server/UI checks only
npm run smoke:packaged -- --win                # on Windows
npm run smoke:packaged -- --win --wine         # best effort on Linux
```

The harness invokes each app with `--self-test` (the app also accepts
`TPG_SELF_TEST=1`). Self-test mode opens no dashboard or capture window, builds
no menu, and shows no dialogs. It still spawns the real server child through
Electron-as-Node, fetches the packaged SPA plus every referenced JS/CSS body,
and, when `TPG_ROM` is set, boots the native node-mgba worker. With a ROM it
also polls `/api/emulator/status` twice and requires both video and audio
counters to grow, not merely be non-zero. It prints a machine-readable line
such as:

```text
TPG_SELF_TEST_OK packaged=1 rom=1 model=DMG size=160x144 frames=... audio=... sampleRate=48000 pid=...
```

A failure prints `TPG_SELF_TEST_FAIL reason=...` plus the server log tail and
exits non-zero. The app stops the server child before exiting.

Self-test data and result handling:

- `TPG_DATA_DIR` is used when set; otherwise a temp directory under the OS temp
  directory is created and removed on exit. The harness always passes its own
  temp directory and removes it after checking for orphan processes.
- `TPG_ROM` is resolved like the normal spawn path (absolute, then relative to
  the working directory or data directory) and passed to the child as an
  absolute `--rom`. Without it the server/UI checks still run.
- `TPG_SELF_TEST_RESULT` selects an optional JSON result file. The app writes
  it atomically before exiting, with status, packaged/rom flags, model, size,
  frame/audio counters, sample rate, PID, and failure reason. The harness sets
  this for every target and treats the file as the machine-readable channel;
  this is required because the NSIS portable wrapper does not reliably inherit
  stdout. The app still prints the same result to stdout when possible.
- Packaged self-test forces the child to production mode (`TPG_DEV=0`,
  `TPG_TEST=0`) and verifies the logs/HTML contain no Vite middleware. The
  harness sets `TPG_DEV=1` and `TPG_TEST=1` on purpose to prove they are
  ignored.

Linux needs a display. The harness uses `xvfb-run -a` automatically when
`DISPLAY`/`WAYLAND_DISPLAY` is unset and `xvfb-run` is installed; otherwise it
fails with an actionable message. It first tries the AppImage with
`APPIMAGE_EXTRACT_AND_RUN=1`. On hosts where the AppImage runtime hangs before
launching the app (observed during P0-28), it falls back to the runtime's own
`--appimage-extract` and runs the extracted `AppRun`; both paths avoid FUSE.
The `.deb` is extracted with `dpkg-deb` or, when unavailable, `ar` + `tar`.

The harness adds `--no-sandbox` only when the host is root or Chromium reports a
sandbox failure. Production Electron code never adds `--no-sandbox`.

Windows targets require Windows or `--wine`. The portable executable is run
directly. The NSIS installer is installed silently to a space-free temp root
(`/S /D=<dir>`, `/D` last), the installed app runs `--self-test`, and the
uninstaller is invoked. `/D` does not tolerate quoted paths, so the harness
rejects an install directory containing whitespace. Installer automation under
Wine is best effort; the harness reports a failure rather than converting it
into a pass. The `.github/workflows/package-smoke.yml` workflow runs the native
Windows path.

Cross-building Windows packages on Linux is not a supported validation path.
electron-builder's NSIS uninstaller step runs an intermediate installer under
Wine and can hang, and a portable cross-build can miss Windows-only optional
binaries such as `sharp`. Use a Windows host or the Windows CI job for a real
Windows artifact; `--wine` is useful only for quick diagnostics.

## Capture window

Open the dedicated OBS capture window with **Window → Open Capture Window**
(`Ctrl+Shift+C`) or at startup:

```bash
TPG_CAPTURE=1 npm run dev
```

PowerShell:

```powershell
$env:TPG_CAPTURE = '1'; npm run dev
```

The window is 960 × 540, resizable, black, and keeps the title
**Twitch Plays GB Capture** regardless of page-title changes. It loads
`/overlay?client=capture` (stream-clean) and uses Electron's
`autoplayPolicy: 'no-user-gesture-required'`, so audio starts unmuted without a
click. Use the dashboard's **Stream audio** mute/volume controls; they reach the
capture window over the server WebSocket. Closing it leaves the dashboard open.
Bounds persistence and tray integration are later P1 work. See `docs/OBS.md` for
OBS Window/Application Capture steps and the unexecuted manual checklist.

## Data directories

The server resolves its data directory in this order:

1. Explicit `--data-dir <path>` or `TPG_DATA_DIR`. This always wins.
2. `TPG_DEV=1` (and not test mode): `<repository>/data/dev`.
3. Test mode (`TPG_TEST=1`): an explicit directory is required. The server
   exits with a configuration error rather than falling back to a real user
   directory. Playwright passes a temporary directory through `--data-dir` and
   deletes it on teardown.
4. Production: the platform default:
   - Linux: `$XDG_DATA_HOME/twitch-plays-gb` or `~/.local/share/twitch-plays-gb`
   - Windows (standalone server): `%APPDATA%\twitch-plays-gb`
   - Desktop shell on either platform: Electron's `userData` directory, passed
     to the server child as `TPG_DATA_DIR` (for example
     `%APPDATA%\Twitch Plays GB` on Windows).

The server creates this layout on startup:

```text
<dataDir>/
  config.json          # optional resolved configuration
  settings.json        # channel + selected ROM (written by Finish setup)
  roms.json            # imported ROM metadata (atomic)
  roms/<sha256>.<ext>  # validated ROM files; client names are never used
  saves/<key>.sav      # battery-backed SRAM, flushed on stop
  states/<key>.state   # newest save state
  states/<key>.state.prev  # previous generation for corrupt-state fallback
```

The JSON config file is `<dataDir>/config.json` unless `--config` or
`TPG_CONFIG` points elsewhere. The dev commands also keep Electron's Chromium
profile in `data/dev/electron` (and the Electron E2E test uses the fixture's
temporary directory), so development and tests do not write to the real
Electron profile.

When the desktop shell spawns its own server, it passes `TPG_DATA_DIR` if set,
otherwise the server gets Electron's `userData` directory. In `TPG_DEV=1` mode
the fallback is `<repository>/data/dev`. If `TPG_SERVER_URL` is set, the shell
does not spawn a server and does not own the external server's data directory.

`data/` is git-ignored. To reset development state, stop the dev command and
remove the directory:

```bash
rm -rf data/dev                 # Linux
Remove-Item -Recurse -Force data/dev   # Windows PowerShell
```

## Logging and random ports

The server logs the resolved data directory, the listen URL, and a
machine-readable `TPG_URL=...` line. Set `TPG_LOG_LEVEL=debug` for configuration
and Vite detail. `--port 0` binds a random free port and prints the actual URL;
the Playwright fixture relies on this.

## VS Code

Open the repository folder and use the Run and Debug view:

| Configuration                         | Use                                                          |
| ------------------------------------- | ------------------------------------------------------------ |
| `Server (dev, tsx)`                   | Debug the server with Vite middleware on port 3000           |
| `Electron main (dev server required)` | Build the desktop bundle, then debug Electron's main process |
| `Playwright: chromium`                | Debug browser E2E tests                                      |
| `Playwright: electron`                | Debug Electron E2E tests                                     |

Start `Server (dev, tsx)` first if you want to debug the Electron window; the
Electron configuration's pre-launch task builds `dist/desktop` but does not
start the server. The Electron window loads `TPG_SERVER_URL`, which defaults to
`http://127.0.0.1:3000`, and keeps its Chromium profile in
`data/dev/electron` like the other dev commands.

For the one-command workflow, use `npm run dev` in a terminal instead.

## Troubleshooting

### Port 3000 is already in use

Stop the other process or choose another port. On Linux:

```bash
ss -ltnp 'sport = :3000'
```

On Windows PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 3000
```

Then start the server with `TPG_PORT=3001` (or `--port 3001` for `npm start`)
and point Electron at it with `TPG_SERVER_URL=http://127.0.0.1:3001`.

### Electron does not open

- Confirm a display is available (`DISPLAY` or `WAYLAND_DISPLAY` on Linux). In
  CI and other headless environments, use `xvfb-run -a npm run test:e2e`.
- In unprivileged containers the Chromium sandbox can fail. Development
  commands forward extra arguments to Electron, so you can opt out locally:

  ```bash
  npm run dev -- --no-sandbox
  npm run dev:electron -- --no-sandbox
  ```

  This is a local workaround only. Production main never adds `--no-sandbox`.

### `dev:electron` says the server is unreachable

Start `npm run dev:web` in another terminal, wait for `TPG_URL=...`, then run
`npm run dev:electron` again. Check that `TPG_SERVER_URL` matches the server's
host and port.

### The UI shows `offline`

The server is not answering `/health`. Check the `[server]` logs for a startup
error, a bind failure, or a Vite error. The desktop shell only accepts loopback
server URLs (`127.0.0.1`, `localhost`, or `[::1]`).

### Tests or dev writes where it should not

- Development should log `data directory: <repository>/data/dev`.
- Test mode without an explicit data directory is a hard configuration error.
- Never set `TPG_DATA_DIR` to a real save directory while developing.

## Developer panel and test chat

When the server runs with `TPG_DEV=1` (including `npm run dev` and
`npm run dev:web`) or `TPG_TEST=1`, the dashboard shows a **Developer** section
below the setup card. It reads the mode from `/health`, mounts only in dev/test,
and is driven by the developer-only `GET /api/debug` endpoint, which it polls
every 1.5 seconds while visible. Production never requests `/api/debug`. It
shows:

- WS client count and emulator status/model;
- video frames, audio chunks, FPS, and audio sample rate;
- fake/Twitch chat source, connection status, channel, and message count;
- live input mode, queue length, accepted/executed/dropped totals, and the last
  drop reason;
- last save time/count, restore source, last frame index, and autosave interval;
- resolved democracy window, hold/release frames, and input cooldown, queue,
  rate, and stale timings.

The **Test chat** form posts `{ user, text }` to `POST /api/test/chat`. External
callers can use the same route (loopback only; no auth because it is a local
developer endpoint):

```bash
curl -sS -X POST http://127.0.0.1:3000/api/test/chat \
  -H 'content-type: application/json' \
  -d '{"user":"dev","text":"!up"}'
```

Inputs are trimmed, limited to 32 user and 200 text characters, and reject
control characters. An optional `roles` object (`broadcaster`, `mod`, `vip`,
`bot`, `self`) mirrors Twitch badges/status for tests. Recent messages appear
in the panel log as escaped React text. Each injected message is also broadcast
on `/ws` as `{ "type": "chat", "message": ... }`, and new clients receive a
`chat-status` and `input-state` message. Production mode starts no fake source
and returns JSON 404 for `/api/debug`, `/api/test/chat`, and
`/api/test/chat/outage`.

The test outage endpoint disconnects or reconnects only the fake source so an
outage can be exercised without touching the emulator:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/test/chat/outage \
  -H 'content-type: application/json' \
  -d '{"outage":true}'

curl -sS -X POST http://127.0.0.1:3000/api/test/chat/outage \
  -H 'content-type: application/json' \
  -d '{"outage":false}'
```

While disconnected, `/api/chat` and `/api/debug` report `connected: false`,
`/api/test/chat` returns 503, and the emulator plus any already-queued inputs
continue normally. The endpoint returns 503 when the active source is not fake.

All developer routes also require a loopback peer
(`127.0.0.1`, `::1`, or `::ffff:127.0.0.1`), regardless of the bind address.
Binding the server to `0.0.0.0` still exposes the dashboard and `/health` on the
LAN, but returns 403 for debug state and fake-chat injection from non-loopback
clients.

### Chat and input timings

These values are resolved through normal configuration (CLI, environment, JSON
config, defaults) and exposed in the debug panel. Anarchy consumes the input
values; democracy/pause behavior lands later.

| Setting           | CLI                           | Default | Valid range        |
| ----------------- | ----------------------------- | ------- | ------------------ |
| Democracy window  | `--democracy-window-ms <ms>`  | 15000   | 1..3600000 ms      |
| Hold frames       | `--hold-frames <frames>`      | 8       | 1..600 frames      |
| Release frames    | `--release-frames <frames>`   | 4       | 1..600 frames      |
| Input cooldown    | `--input-cooldown-ms <ms>`    | 3000    | 0..3600000 ms      |
| Input queue cap   | `--input-max-queue <count>`   | 10      | 1..1000            |
| Input rate cap    | `--input-max-per-second <n>`  | 5       | 1..1000 per second |
| Input stale limit | `--input-stale-ms <ms>`       | 5000    | 0..3600000 ms      |
| Autosave interval | `--autosave-interval-ms <ms>` | 60000   | 100..3600000 ms    |

Environment equivalents: `TPG_DEMOCRACY_WINDOW_MS`, `TPG_HOLD_FRAMES`,
`TPG_RELEASE_FRAMES`, `TPG_INPUT_COOLDOWN_MS`, `TPG_INPUT_MAX_QUEUE`,
`TPG_INPUT_MAX_PER_SECOND`, `TPG_INPUT_STALE_MS`, and
`TPG_AUTOSAVE_INTERVAL_MS`. Bare commands use
`TPG_BARE_COMMANDS` (or `--bare-commands`); chat source selection uses
`TPG_CHAT` (or `--chat auto|fake|twitch`). The Electron shell forwards these
variables to its spawned server child, including packaged builds. The
hold/release defaults match node-mgba's input timing. A cooldown or stale value
of 0 disables that check.

OBS setup documentation remains a manual checklist in `docs/OBS.md`.
