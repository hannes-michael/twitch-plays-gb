# Architecture decisions

This file records go/no-go decisions from P0 spikes and any architecture changes.
Add a new ADR when a decision changes. Keep entries short and dated.

## ADR-001: Single TypeScript package with explicit boundaries

**Status:** accepted (P0)

The app is one npm package with four boundaries: `src/server`, `src/desktop`,
`src/shared`, and `web`. The server and web UI share types and validation from
`src/shared`; the Electron main process never imports server internals directly
and instead talks to the local server over HTTP/WebSocket. This keeps the server
runnable headlessly and the Electron shell replaceable.

## ADR-002: node-mgba pinned and isolated behind an emulator service

**Status:** accepted (P0)

`node-mgba@0.3.2` is pinned exactly. All emulator calls go through
`src/server/emulator` so the rest of the server never depends on native module
details. This limits the blast radius of native ABI changes and makes the
emulator replaceable.

Note: `node-mgba` depends on `sharp`, which currently has published libvips
advisories with no fix. We only request raw RGBA frames and PCM audio; we do not
expose image encoding to untrusted input. Re-evaluate when upstream updates.

## ADR-003: Vite in middleware mode for dev/test; static files in production

**Status:** accepted (P0)

The server embeds Vite in middleware mode when `TPG_DEV=1` or `TPG_TEST=1`.
This gives one process for API + UI + HMR in development and lets E2E tests boot
a single random-port server with no separate web server. Production serves the
built `dist/web` bundle as static files with SPA fallback.

Consequence: `vite` remains a development dependency and is imported
dynamically only in dev/test. Packaged builds never load it.

## ADR-004: OBS is the streaming layer

**Status:** accepted (product decision)

v1 does not encode RTMP. OBS captures either the Browser Source overlay or the
dedicated Electron capture window. No stream keys or Twitch OAuth are stored.

## ADR-005: E2E-first testing

**Status:** accepted (product decision)

Feature work starts with a failing Playwright scenario. We avoid a broad unit
suite. Integration tests are added only when a bug cannot be reproduced E2E.

## ADR-006: Electron-as-Node for the server child process

**Status:** accepted (validated in P0-27/P0-28/P0-29 on Linux x64; Windows pending CI)

The server starts as a child process using the Electron binary with
`ELECTRON_RUN_AS_NODE=1`, so the packaged app does not ship a second Node
runtime. The desktop main process spawns:

```text
process.execPath <serverEntry> --host 127.0.0.1 --port 0 --data-dir <dir> [--rom <rom>]
```

It parses the exact `TPG_URL=http://host:port` line, waits for `/health` with a
20 second bound, then loads the dashboard. Child stdout/stderr are prefixed and
tailed for error dialogs. On quit the child gets SIGTERM, then SIGKILL after 5
seconds; Windows uses `taskkill /pid <pid> /T /F`.

**Spike result (2026-10-25):** go on Linux x64. The
`server-child.electron.spec.ts` E2E test spawns the real built
`dist/server/index.js` from Electron-as-Node with no external server, boots the
vendored GB ROM, and observes native `node-mgba`/koffi loading plus worker-thread
video and audio counters. The child exits with no orphan when Electron quits.
Windows CI is the remaining validation; if it fails on native ABI or worker
threads, fall back to a bundled Node 22 runtime for the server child. No fallback
is needed on Linux.

**Packaged path:** never run the server from inside an asar archive. In packaged
mode the shell prefers
`process.resourcesPath/app.asar.unpacked/dist/server/index.js` and falls back to
`app.getAppPath()/dist/server/index.js`. `electron-builder` must unpack
`dist/**`, `package.json`, and the runtime `node_modules/**`. Unpacking the
runtime modules is required because the server entry itself lives outside the
asar: bare imports such as `express` and `ws` resolve from the unpacked
`node_modules`, and `node-mgba`'s worker file and native libraries must also be
real files. P0-28 must validate this layout and may narrow the unpack set after
a packaged smoke test. Packaging must leave Electron's `RunAsNode` fuse enabled
(the default); disabling it would prevent `ELECTRON_RUN_AS_NODE=1` from starting
the server child.

Packaged mode ignores inherited `TPG_DEV`, `TPG_TEST`, and `TPG_SERVER_ENTRY`.
The child always gets `TPG_DEV=0` and `TPG_TEST=0`, so it serves built assets
instead of mounting Vite. `TPG_DATA_DIR` still wins when explicit; otherwise
packaged apps use Electron's `userData` directory. A relative `TPG_ROM` is
resolved in the desktop main process against the process working directory and
then the data directory before spawning; the child only receives an absolute
`--rom` path.

**Packaged smoke result (2026-10-25):** go on Linux x64 for both AppImage and
`.deb`. The headless `--self-test` mode spawns the real server child, serves the
packaged SPA and `/overlay?client=obs` without Vite, and boots the vendored GB
ROM through native `node-mgba`/koffi with a worker. Both artifacts reported
`DMG 160x144`, video frames > 0, audio chunks > 0, and 48000 Hz. The child PID
was gone after the app exited and temp directories were removed. The harness
sets inherited `TPG_DEV=1`/`TPG_TEST=1`; the packaged child still logged
`dev=false test=false`. The AppImage runtime hung with
`APPIMAGE_EXTRACT_AND_RUN=1` on the development host, so the harness falls back
to `--appimage-extract` and runs the extracted `AppRun`; this is a test-host
workaround, not an application change.

## ADR-007: Capture window reuses the overlay with a stable OBS title

**Status:** accepted (P0-26; OBS manual verification pending)

The desktop shell opens a second secure BrowserWindow at
`/overlay?client=capture`, 960 × 540, resizable, with a black background and
`autoplayPolicy: 'no-user-gesture-required'`. It ignores `page-title-updated`
and keeps the title `Twitch Plays GB Capture` so OBS Window/Application Capture
matches a stable source. It opens at startup with `TPG_CAPTURE=1` or from
**Window → Open Capture Window**; reopening focuses the existing window.

`client=capture` is a hint only for now. Per-client media roles, persisted
bounds, tray integration, and audio autoplay persistence are P1 work. OBS is not
installed in the development environment, so `docs/OBS.md` remains an unexecuted
manual checklist.

## ADR-008: P0 go/no-go — Linux packaged path proven; Windows and OBS manual pending

**Status:** accepted (P0-28/P0-30, 2026-10-25)

**Decision: GO for Linux x64. The overall P0 exit criteria remain conditional on
Windows CI execution and the manual OBS checks.**

Proven in this cycle:

- Linux AppImage and `.deb` build reproducibly with `npm run package:linux` and
  pass the headless packaged smoke test with a real ROM.
- Electron-as-Node runs the unpacked server entry from both artifacts, loads
  native `node-mgba`/koffi, and runs its worker thread.
- The packaged server serves the built SPA and `/overlay?client=obs`, never
  mounts Vite, and ignores inherited `TPG_DEV`/`TPG_TEST`.
- The emulator reports `DMG 160x144`, growing video/audio counters, and 48000 Hz
  audio; the server child is stopped and no orphan remains.
- The software side of both OBS paths is covered by E2E: Browser Source
  (`/overlay?client=obs`) and the stable-title capture window. Actual OBS
  capture is still manual.

Remaining before the P0 exit criteria are fully met:

- Build and run the NSIS installer and portable `.exe` on Windows. The
  `package-smoke.yml` workflow wires this, but it was not executed in this
  environment. The `--win --wine` path is best effort and is not a substitute
  for a native Windows run.
- Execute the OBS checklist in `docs/OBS.md` on Linux X11/Wayland and Windows.
- Re-run the packaged smoke on a host where the AppImage runtime works directly;
  the harness already tries `APPIMAGE_EXTRACT_AND_RUN=1` first and only falls
  back to extraction when the runtime hangs before launch.

No architecture change is required for Linux. If Windows Electron-as-Node or
the native ABI fails, ADR-006's fallback to a bundled Node 22 server runtime
remains the contingency; no fallback is used on Linux. No P1 features were
implemented in this cycle.
