# AGENTS.md

Guidance for coding agents working on Twitch Plays GB.

## Read first

- `README.md` — product behavior and commands.
- `docs/TESTING.md` — E2E-first workflow, fixtures, and debugging.
- `docs/DECISIONS.md` — architecture decisions and known constraints.
- `PLAN.md` is a **local, git-ignored roadmap**. Do not edit or commit it unless
  the user explicitly asks.

## Workflow

1. Read the relevant code and docs before changing anything.
2. Work in small, reviewable cycles.
3. **E2E-first:** write or update a Playwright test that describes the behavior,
   run it red, implement the smallest change that makes it pass, then refactor.
4. Run the narrowest test while iterating; run the full verification before
   finishing.
5. Commit with a conventional commit. Do not push, rewrite history, or open PRs
   unless asked.
6. Report exact commands/results and any deferred work. Never claim a check you
   did not run.

No broad unit-test suite. Add one focused integration test only when a bug
cannot be reproduced E2E. Do not fix unrelated nits or gold-plate.

## Commands

```bash
npm run dev              # server watch + Vite HMR + Electron
npm run dev:web          # browser-only
npm run dev:electron     # Electron against an existing server
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:e2e         # full Chromium + Electron suite
npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=electron
npm run test:e2e:ui
npm run smoke:packaged -- --linux --unpacked
```

Full definition of done: `typecheck`, `lint`, `format:check`, `build`, and
`test:e2e` pass. Run the packaged smoke after changes to Electron, native
modules, the server child, or packaging.

## Architecture boundaries

- `src/server` — Express 5 API, WebSocket media/state, emulator service, ROM
  store, settings, chat and input services.
- `src/desktop` — Electron main/preload, secure windows, server child lifecycle.
- `src/shared` — browser-safe types, zod schemas, config, media protocol.
- `web` — React 19 UI (setup wizard, dashboard, overlay).
- `node-mgba` is pinned and **only imported under `src/server/emulator/`**
  (plus the browser helpers in the overlay). Keep it external in the server
  bundle; never bundle native code.
- The Electron main process spawns the server via `ELECTRON_RUN_AS_NODE` from
  unpacked files. Renderers talk to it over localhost HTTP/WebSocket only.
- Config precedence is CLI > env > JSON > defaults. Validate with zod; never
  log secrets.
- Test-only endpoints must stay gated to dev/test and loopback-only, and return
  404 in production. Never add test-only branches to feature logic.

## Testing rules

- Use the real server fixture (`tests/fixtures/server.ts`): random port,
  temporary data dir, `TPG_TEST=1`, fake chat. Never touch the real user data
  directory.
- Use short timings through normal config (`TPG_*`), not test-only code paths.
- Use `expect.poll` and web-first assertions; avoid fixed sleeps and full-page
  snapshots.
- Assert user-visible behavior: DOM state, canvas size/pixels, counters,
  statuses, API payloads.
- Keep the suite high-value. It is currently larger than the plan's 12–18 target;
  prefer extending an existing scenario over adding a new spec.
- Clean up temp dirs and child processes. A test must not leave orphans.
- Twitch is not contacted in tests; use fake chat injection.

## Conventions and safety

- TypeScript strict, ESM, existing path aliases (`@shared`, `@server`,
  `@desktop`, `@web`). Keep changes consistent with surrounding code.
- Data lives under `data/dev` in development and a temp dir in tests. State and
  battery saves are atomic; keep two generations.
- No commercial ROMs, Twitch OAuth tokens, stream keys, or secrets in the repo.
  Vendored fixtures are open source with notices.
- Support Linux x64 and Windows x64: use cross-platform paths and process
  handling; avoid shelling out where Node APIs suffice.
- Inspect unfamiliar files before overwriting or deleting them. Do not discard
  user work.
- Do not commit `dist/`, `release/`, `data/`, `logs/`, `test-results/`,
  `playwright-report/`, `roms/`, `.env`, or `PLAN.md`.

## Definition of done

- Behavior is covered by a meaningful E2E test, or the change is docs/tooling
  only.
- `git status` is clean except for intentional, committed changes.
- No orphan processes, stale temp dirs, or generated artifacts are tracked.
- The final report lists what changed, commands run, results, and residual
  risks.
