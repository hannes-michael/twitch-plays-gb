# Twitch Plays GB

Local Game Boy, GBC, and GBA emulator driven by Twitch chat, designed for OBS
streaming. The app runs an Electron desktop shell and a local server; OBS
captures either the built-in Browser Source overlay or a dedicated capture
window.

> Status: early development. See `PLAN.md` for the implementation roadmap and
> `docs/TESTING.md` for the E2E-first workflow.

## Requirements

- Node.js 22 (see `.nvmrc`)
- Linux x64 or Windows x64

## Quick start

```bash
npm install
npm run dev
```

## Commands

```bash
npm run dev              # Vite + server watch + Electron
npm run dev:web          # browser-only UI
npm run dev:electron     # Electron shell only
npm run test:e2e         # Playwright
npm run test:e2e:ui      # Playwright UI mode
npm run test:e2e:headed  # visible browser/Electron
npm run lint
npm run typecheck
npm run format
npm run build
npm run package:linux
npm run package:win
```

## Documentation

- `docs/OBS.md` — OBS setup for both capture paths
- `docs/DEVELOPMENT.md` — dev commands, fake chat, data directories
- `docs/TESTING.md` — E2E-first workflow and fixtures
- `docs/DECISIONS.md` — architecture decisions and spike outcomes

## Legal

This project does not include or distribute commercial ROMs. You must supply
your own legally obtained ROMs. Twitch Plays GB is not affiliated with Nintendo,
Game Freak, or Twitch.

## License

MIT — see `LICENSE`.
