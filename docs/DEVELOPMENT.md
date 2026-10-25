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
| `npm run package:linux`   | Build, then run electron-builder for Linux                                            |
| `npm run package:win`     | Build, then run electron-builder for Windows                                          |

`dev:web` prints `TPG_URL=http://127.0.0.1:<port>` when the server is ready.
Open that URL in a browser. Override the port with `TPG_PORT=3001` or, for the
built server, `npm start -- --port 3001`. Use `--port 0` for a random port.

`dev:electron` checks `/health` first and exits with an actionable message if
the server is not reachable. Point it at another server with
`TPG_SERVER_URL=http://127.0.0.1:3001` (PowerShell:
`$env:TPG_SERVER_URL = 'http://127.0.0.1:3001'`).

Packaging commands are scaffolding for the later packaged-app milestones
(P0-27/P0-28). The desktop shell currently expects a separately running server.

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
   - Windows: `%APPDATA%\twitch-plays-gb`

The JSON config file is `<dataDir>/config.json` unless `--config` or
`TPG_CONFIG` points elsewhere. The dev commands also keep Electron's Chromium
profile in `data/dev/electron` (and the Electron E2E test uses the fixture's
temporary directory), so development and tests do not write to the real
Electron profile.

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

## Planned developer tools

The fake chat panel/source (P0-15) and the emulator/chat/frame debug panel
(P0-11) are not implemented yet. When they land they will be documented here.
OBS setup documentation is also planned in `docs/OBS.md`.
