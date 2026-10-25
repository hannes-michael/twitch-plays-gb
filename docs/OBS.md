# OBS setup

Twitch Plays GB does not encode or stream video itself. OBS captures one of two
local sources:

| Path                    | Best for                                  | Source type                              |
| ----------------------- | ----------------------------------------- | ---------------------------------------- |
| Browser Source overlay  | Transparent/HUD overlay, browser-based UI | OBS Browser Source                       |
| Electron capture window | Native window capture, simple audio setup | OBS Window Capture / Application Capture |

> **Manual verification pending.** OBS was not installed in the environment
> where this document and the P0-26/P0-25 changes were written. None of the OBS
> checks in this file have been executed yet. Run the checklist below on Linux
> and Windows before claiming OBS support.

## Browser Source (`/overlay?client=obs`)

The overlay is a normal web page and keeps working in a browser. `client=obs`
is currently a hint only; per-client media roles arrive in P1-09.

### URL and source settings

Start the local server first. With `npm run dev:web` or `npm start`, the default
URL is:

```text
http://127.0.0.1:3000/overlay?client=obs
```

For the desktop app, the server child currently binds a random loopback port.
Read the `[desktop] server child ready at http://127.0.0.1:<port> (pid ...)`
line in the Electron console until the OBS setup page (P1-16) exposes a copyable
URL in the UI. The capture window path below does not need the URL.

1. In OBS, select the target scene.
2. **Sources** → **+** → **Browser**.
3. Set **URL** to the overlay URL.
4. Set **Width** to `1920` and **Height** to `1080` (or `960` × `540` for a
   smaller canvas). The overlay keeps a 16:9 stage and letterboxes inside it.
5. Set **FPS** to `60` (or `30` to match your stream output).
6. Leave **Shutdown source when not visible** off and **Refresh browser when
   scene becomes active** off so the WebSocket stays connected while switching
   scenes.
7. Leave **Custom CSS** empty unless you are intentionally hiding HUD elements.

### Audio and the autoplay workaround

Browsers block audio until a user gesture. The overlay therefore starts muted
on purpose; the capture page and a normal browser both show an **Unmute audio**
button.

1. In the Browser Source properties, enable **Control audio via OBS** (OBS 28+)
   so the overlay appears in the OBS audio mixer.
2. Right-click the source → **Interact**.
3. Click **Unmute audio**. If the first click was blocked, click **Retry audio**.
4. Confirm the overlay's `sound` status changes from `muted`/`blocked` to
   `running` and the OBS audio meter moves.
5. If audio still does not reach the stream, check **Advanced Audio Properties**
   and confirm the source is not muted and is routed to the intended track.

If **Control audio via OBS** is unavailable, leave it off and capture the OBS
desktop/application audio instead; the overlay still needs the Interact →
Unmute step.

### Browser Source checklist

- [ ] Canvas shows the emulator picture at the native aspect ratio.
- [ ] Status is `running`, frames increase, and the FPS value is near 60.
- [ ] Audio chunks increase and the mixer meter moves after unmute.
- [ ] The overlay reconnects after a page refresh (full reconnect policy is
      P1-10/P1-41).
- [ ] Transparent background and HUD options (P1-14) are not expected yet.

## Electron capture window

The desktop app can open a dedicated 960 × 540 (16:9), resizable window with a
black background and the stable title **Twitch Plays GB Capture**. It loads
`/overlay?client=capture`.

Open it with either method:

- Application menu → **Window** → **Open Capture Window**
  (`Ctrl+Shift+C`, or `Cmd+Shift+C` on macOS).
- Start the app with `TPG_CAPTURE=1`:

  ```bash
  TPG_CAPTURE=1 npm run dev
  # PowerShell:
  $env:TPG_CAPTURE = '1'; npm run dev
  ```

If the window is already open, the menu item focuses it. Closing it does not
quit the app while the dashboard is open. Window bounds are not persisted yet
(P1-24).

The window sets Electron's autoplay policy to
`no-user-gesture-required`, so the audio context may start without a click.
The overlay still starts muted: click **Unmute audio** once in the capture
window (click the window itself, not the OBS preview). The `sound` status must
read `running`.

### Linux (X11 and Wayland)

1. **Sources** → **+** → **Window Capture**.
2. Choose **Twitch Plays GB Capture** in the **Window** dropdown.
3. X11: use **Xcomposite** (or **Automatic**). Wayland: OBS uses PipeWire; pick
   the window in the portal dialog and allow screen/window capture.
4. Turn **Show cursor** off.
5. Add an audio source:
   - OBS 30+ on PipeWire: **Application Audio Capture** and select the Electron
     app, or
   - capture the desktop/monitor audio if application capture is unavailable.
6. If the window is black, switch capture methods, make sure the window is not
   minimized, and avoid fractional display scaling while testing.

### Windows

1. **Sources** → **+** → **Window Capture**.
2. Choose **Twitch Plays GB Capture [Twitch Plays GB.exe]** in the **Window**
   dropdown.
3. Prefer **Windows 10 (1903 and up)** (Windows Graphics Capture). Use
   **BitBlt** as a fallback.
4. Turn **Show cursor** off.
5. For audio, add **Application Audio Capture (BETA)** and select the
   **Twitch Plays GB** process, or use desktop audio. Confirm the unmute step
   above before blaming OBS.
6. If the capture is black, toggle the capture method, disable HDR for the
   display, and make sure the app is not minimized.

### Capture window checklist

- [ ] Window opens from the menu and with `TPG_CAPTURE=1`.
- [ ] Title stays exactly `Twitch Plays GB Capture` while the page changes.
- [ ] Window is 16:9 with a black background and can be resized.
- [ ] OBS lists the window by its stable title on Linux and Windows.
- [ ] Picture is 160 × 144 for GB/GBC or 240 × 160 for GBA, scaled without
      blurring (the overlay uses pixelated rendering).
- [ ] Audio reaches the stream after **Unmute audio**; status is `running`.
- [ ] Closing the capture window leaves the dashboard open; reopening focuses
      or recreates it.
- [ ] No orphan Electron, server, or node-mgba process remains after quitting.

## Manual OBS verification (not yet executed)

Run this on both platforms before a release:

- [ ] Linux X11: Browser Source video + audio.
- [ ] Linux Wayland: Window Capture via PipeWire + application audio.
- [ ] Windows: Browser Source video + audio.
- [ ] Windows: Window Capture video + Application Audio Capture.
- [ ] Capture window title remains stable through a page-title change and a
      server reconnect.
- [ ] Audio unmute workaround works through OBS **Interact** for Browser Source.
- [ ] 60 FPS overlay for at least 10 minutes on GB and GBA without runaway CPU
      or dropped frames.
- [ ] OBS scene switch does not stop the emulator or disconnect the overlay.

Record the OBS version, OS, display server (X11/Wayland), and capture method for
each run.
