# Twitch Plays GB

Local Game Boy, GBC, and GBA emulator driven by Twitch chat, designed for OBS
streaming. The app runs an Electron desktop shell and a local server; OBS
captures either the built-in Browser Source overlay or a dedicated capture
window.

> Status: early development. The config-driven server and first-run UI walking
> skeleton are runnable. Electron, emulator, Twitch, and OBS integration are
> planned. See `PLAN.md` for the local implementation roadmap (not committed)
> and `docs/TESTING.md` for the E2E-first workflow.

## Requirements

- Node.js 22 (see `.nvmrc`)
- Linux x64 or Windows x64

## Quick start (walking skeleton)

```bash
npm install
npm run build:web
npm run build:server
npm start
```

The server binds to `127.0.0.1:3000` by default. Use `--port 0` to choose a
random port; the server prints `TPG_URL=http://127.0.0.1:<port>` when ready.

## Commands

Available now:

```bash
npm run build:web        # build the React UI
npm run build:server     # build the server bundle
npm start                # run the built server
npm run dev:web          # standalone Vite UI (start the API server too)
npm run dev:server       # server only; set TPG_DEV=1 for Vite middleware
npm run typecheck
npm run lint
npm run format
npm run format:check
npm run test:e2e         # Playwright (chromium scenarios currently)
npm run test:e2e:ui
npm run test:e2e:headed
```

Planned, not yet implemented:

```bash
npm run dev              # Vite + server + Electron orchestration
npm run dev:electron     # Electron shell only
npm run build            # includes the desktop bundle
npm run package:linux
npm run package:win
```

The server does not load `.env` automatically; export variables in your shell
for now. See `.env.example`.

## Documentation

- `docs/DECISIONS.md` — architecture decisions and spike outcomes
- `docs/TESTING.md` — E2E-first workflow and fixtures

OBS and development guides are planned but not written yet.

## Legal

This project does not include or distribute commercial ROMs. You must supply
your own legally obtained ROMs. Twitch Plays GB is not affiliated with Nintendo,
Game Freak, or Twitch.

## License

MIT — see `LICENSE`.
