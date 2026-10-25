# Twitch Plays GB

Local Game Boy, GBC, and GBA emulator driven by Twitch chat, designed for OBS
streaming. The app runs an Electron desktop shell and a local server; OBS
captures either the built-in Browser Source overlay or a dedicated capture
window.

> Status: walking skeleton. The config-driven server, first-run UI, Electron
> shell (including a spawned server child and OBS capture window), one-command
> dev workflow, local GB/GBC/GBA video/audio overlay, OBS setup guide, and
> Linux AppImage/.deb builds are runnable. Linux packaged builds pass a headless
> smoke test; Windows packaging is wired for CI but has not been executed in the
> development environment. Twitch chat is planned, and OBS capture is still a
> manual checklist. See `PLAN.md` for the local implementation roadmap (not
> committed) and `docs/TESTING.md` for the E2E-first workflow.

## Requirements

- Node.js 22 (see `.nvmrc`)
- Linux x64 or Windows x64, with a display for the Electron window

## Quick start

```bash
npm install
TPG_ROM=/path/to/game.gb npm run dev
```

`npm run dev` starts the server with embedded Vite HMR, waits for health, builds
the desktop bundle, and opens Electron. The server listens on
`http://127.0.0.1:3000` by default and prints `TPG_URL=...`. Run without
`TPG_ROM` to open the setup screen only, or open
`http://127.0.0.1:3000/overlay?client=obs` for the OBS overlay. Press `Ctrl+C`
to stop everything.

Browser-only development:

```bash
npm run dev:web
```

Open the printed URL in your browser.

## Build and run

```bash
npm run build   # dist/web + dist/server + dist/desktop
npm start       # production server with built web assets
```

To launch the desktop shell against an already-running server:

```bash
npm run dev:electron
```

The Electron shell loads `TPG_SERVER_URL` when it is set and only accepts
loopback URLs. With no `TPG_SERVER_URL`, it spawns the built server itself
through Electron-as-Node and binds a random loopback port. Open the OBS capture
window with **Window → Open Capture Window** or:

```bash
TPG_CAPTURE=1 npm run dev
```

See `docs/OBS.md` for Browser Source and Window Capture steps and
`docs/DEVELOPMENT.md` for the dev workflow, data directories, VS Code launch
configs, and troubleshooting.

## Packaged builds

```bash
npm run package:linux    # AppImage + .deb in release/
npm run package:win      # NSIS installer + portable .exe in release/
npm run smoke:packaged -- --linux
```

The packaged smoke test launches each artifact with `--self-test`, which runs
the real Electron-as-Node server child without opening any windows. It checks
the packaged SPA, `/overlay?client=obs`, and every referenced JS/CSS asset body,
and with `TPG_ROM` set it waits for the native node-mgba worker's video/audio
counters to grow at 48 kHz. On Linux it runs the AppImage and `.deb`; add
`--unpacked` for a fast `release/linux-unpacked` check. Windows targets run on
Windows, or with `--win --wine` as a best-effort local check. Release artifacts
are not committed. See `docs/TESTING.md` for the full matrix and options.

## Commands

```bash
npm run dev              # server watch + Vite HMR + Electron
npm run dev:web          # browser-only dev server
npm run dev:electron     # Electron against a running server
npm run build            # build web, server, and desktop bundles
npm start                # run the built server
npm run typecheck
npm run lint
npm run format
npm run format:check
npm run test:e2e         # Playwright (Chromium + Electron)
npm run test:e2e:ui
npm run test:e2e:headed
npm run package:linux    # build Linux AppImage + .deb
npm run package:win      # build Windows NSIS installer + portable .exe
npm run smoke:packaged   # headless smoke test for packaged artifacts
```

Development data lives in the git-ignored `data/dev` directory. Tests use
temporary directories and refuse to fall back to your real user data. Details
are in `docs/DEVELOPMENT.md`.

The server does not load `.env` automatically; export variables in your shell
for now. See `.env.example`.

## Documentation

- `docs/DEVELOPMENT.md` — dev commands, data directories, VS Code, troubleshooting
- `docs/TESTING.md` — E2E-first workflow, fixtures, Electron tests
- `docs/OBS.md` — Browser Source and capture window setup, audio checklist (manual, pending)
- `docs/DECISIONS.md` — architecture decisions and spike outcomes

OBS manual verification is still pending, and the fake chat/debug panels are
planned but not written yet.

## Legal

This project does not include or distribute commercial ROMs. You must supply
your own legally obtained ROMs. Twitch Plays GB is not affiliated with Nintendo,
Game Freak, or Twitch.

## License

MIT — see `LICENSE`.
