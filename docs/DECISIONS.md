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

**Status:** proposed (to validate in P0-27/P0-29)

The server starts as a child process using the Electron binary with
`ELECTRON_RUN_AS_NODE=1`, so the packaged app does not ship a second Node
runtime. If native module ABI or worker threads fail, fall back to a bundled
Node 22 runtime. Decision recorded after the spike.
