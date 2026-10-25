import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';

const APP_TITLE = 'Twitch Plays GB';
const CAPTURE_TITLE = 'Twitch Plays GB Capture';
const BACKGROUND_COLOR = '#0b1020';
const CAPTURE_BACKGROUND_COLOR = '#000000';
const CAPTURE_WIDTH = 960;
const CAPTURE_HEIGHT = 540;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SERVER_START_TIMEOUT_MS = 20_000;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const LOG_TAIL_LINES = 200;
const LOG_TAIL_CHARS = 20_000;

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let serverChild: ChildProcess | undefined;
let serverChildExited = true;
let serverReady = false;
let serverLogs: string[] = [];
let stopping = false;
let quitting = false;
let stopPromise: Promise<void> | undefined;

function flagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseServerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`TPG_SERVER_URL is not a valid URL: ${JSON.stringify(value)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`TPG_SERVER_URL must use http or https, received ${JSON.stringify(value)}`);
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `TPG_SERVER_URL must point at this machine (127.0.0.1, localhost, or [::1]), ` +
        `received ${JSON.stringify(value)}`,
    );
  }

  return url;
}

function toHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function appendServerLog(stream: 'stdout' | 'stderr', line: string): void {
  serverLogs.push(line);
  if (serverLogs.length > LOG_TAIL_LINES) {
    serverLogs = serverLogs.slice(-LOG_TAIL_LINES);
  }

  const prefix = stream === 'stdout' ? '[server]' : '[server:stderr]';
  const output = stream === 'stdout' ? process.stdout : process.stderr;
  output.write(`${prefix} ${line}\n`);
}

function formatLogTail(): string {
  if (serverLogs.length === 0) return 'No server output was captured.';
  const tail = serverLogs.slice(-40).join('\n').slice(-LOG_TAIL_CHARS);
  return `Last server output:\n${tail}`;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolveExit(false);
    }, timeoutMs);

    function onExit(): void {
      clearTimeout(timer);
      resolveExit(true);
    }

    child.once('exit', onExit);
  });
}

function stopServerChild(): Promise<void> {
  if (stopPromise) return stopPromise;

  const child = serverChild;
  if (!child || serverChildExited) return Promise.resolve();

  stopping = true;
  stopPromise = (async () => {
    process.stdout.write(`[desktop] stopping server child (pid ${child.pid ?? 'unknown'})\n`);

    if (process.platform === 'win32' && child.pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      if (await waitForChildExit(child, CHILD_SHUTDOWN_TIMEOUT_MS)) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process already exited.
      }
      await waitForChildExit(child, 1_000);
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch {
      // The process already exited.
    }

    if (await waitForChildExit(child, CHILD_SHUTDOWN_TIMEOUT_MS)) return;

    process.stderr.write('[desktop] server child did not exit after SIGTERM; sending SIGKILL\n');
    try {
      child.kill('SIGKILL');
    } catch {
      // The process already exited.
    }
    await waitForChildExit(child, 1_000);
  })().finally(() => {
    serverChildExited = child.exitCode !== null || child.signalCode !== null;
  });

  return stopPromise;
}

function resolveServerEntry(): string {
  // The entry override is a development/CI escape hatch. A packaged app must
  // always use its own unpacked bundle, never a path inherited from the
  // environment.
  if (!app.isPackaged) {
    const override = process.env.TPG_SERVER_ENTRY?.trim();
    if (override) return resolve(override);
  }

  if (app.isPackaged) {
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server', 'index.js');
    if (existsSync(unpacked)) return unpacked;
  }

  return join(app.getAppPath(), 'dist', 'server', 'index.js');
}

function resolveDataDir(): string {
  const override = process.env.TPG_DATA_DIR?.trim();
  if (override) return resolve(override);

  // TPG_DEV is a development flag. Packaged apps always use Electron's real
  // userData directory, even if the environment inherited TPG_DEV=1.
  if (!app.isPackaged && flagEnabled(process.env.TPG_DEV)) {
    return join(app.getAppPath(), 'data', 'dev');
  }

  return app.getPath('userData');
}

/**
 * The server child runs with its working directory set to the server bundle,
 * so a relative ROM from the shell's environment must be resolved first.
 * Try the desktop process working directory, then the app data directory.
 * Absolute paths are passed through unchanged.
 */
function resolveRomPath(rom: string, dataDir: string): string {
  if (isAbsolute(rom)) return rom;

  const cwdCandidate = resolve(process.cwd(), rom);
  if (existsSync(cwdCandidate)) return cwdCandidate;

  const dataCandidate = resolve(dataDir, rom);
  if (existsSync(dataCandidate)) return dataCandidate;

  return cwdCandidate;
}

function createChildEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith('TPG_') ||
      key === 'HOST' ||
      key === 'PORT' ||
      key === 'NODE_OPTIONS' ||
      key === 'ELECTRON_RUN_AS_NODE' ||
      key === 'ELECTRON_NO_ASAR'
    ) {
      continue;
    }
    env[key] = value;
  }

  env.ELECTRON_RUN_AS_NODE = '1';
  env.TPG_DATA_DIR = dataDir;
  // The spawned server always serves the built assets. TPG_DEV must never
  // enable Vite middleware here, and packaged apps must never enter test mode
  // just because the environment inherited those flags.
  env.TPG_DEV = '0';
  env.TPG_TEST = app.isPackaged ? '0' : (process.env.TPG_TEST ?? '0');

  // Only forward app configuration that the child understands. In particular,
  // never forward a stale TPG_SERVER_URL, TPG_SERVER_ENTRY, TPG_CAPTURE, or the
  // raw TPG_ROM (the resolved absolute ROM is passed as --rom instead).
  if (process.env.TPG_LOG_LEVEL !== undefined) env.TPG_LOG_LEVEL = process.env.TPG_LOG_LEVEL;

  return env;
}

function waitForServerUrl(child: ChildProcess): Promise<URL> {
  return new Promise((resolveUrl, rejectUrl) => {
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`Server did not print TPG_URL within ${SERVER_START_TIMEOUT_MS}ms.`));
    }, SERVER_START_TIMEOUT_MS);

    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      finish();
      rejectUrl(new Error(`${error.message}\n${formatLogTail()}`, { cause: error }));
    };

    if (!child.stdout || !child.stderr) {
      fail(new Error('Failed to capture server stdout/stderr.'));
      return;
    }

    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      appendServerLog('stdout', line);
      const match = /^TPG_URL=(.+)$/.exec(line);
      if (!match || settled) return;

      try {
        const url = parseServerUrl(match[1].trim());
        finish();
        resolveUrl(url);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line) => {
      appendServerLog('stderr', line);
    });

    child.once('error', (error) => {
      fail(new Error(`Failed to start server child: ${error.message}`));
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      fail(new Error(`Server exited with ${detail} before becoming ready.`));
    });
  });
}

async function waitForHealth(child: ChildProcess, url: URL): Promise<void> {
  const healthUrl = new URL('/health', url);
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  let lastError = 'no response yet';

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = child.signalCode
        ? `signal ${child.signalCode}`
        : `code ${child.exitCode ?? 'unknown'}`;
      throw new Error(`Server exited with ${detail} before becoming healthy.\n${formatLogTail()}`);
    }

    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const body: unknown = await response.json();
        if (
          typeof body === 'object' &&
          body !== null &&
          (body as { status?: unknown }).status === 'ok'
        ) {
          return;
        }
        lastError = `unexpected health payload: ${JSON.stringify(body)}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Server did not become healthy at ${healthUrl.toString()} within ` +
      `${SERVER_START_TIMEOUT_MS}ms (last error: ${lastError}).\n${formatLogTail()}`,
  );
}

async function startServerChild(): Promise<{ child: ChildProcess; url: URL }> {
  const serverEntry = resolveServerEntry();
  if (!existsSync(serverEntry)) {
    throw new Error(
      `Server bundle not found at ${serverEntry}. Run "npm run build" before starting the desktop app.`,
    );
  }

  const dataDir = resolveDataDir();
  const rawRom = process.env.TPG_ROM?.trim();
  const rom = rawRom ? resolveRomPath(rawRom, dataDir) : undefined;
  const args = [
    serverEntry,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--data-dir',
    dataDir,
    ...(rom ? ['--rom', rom] : []),
  ];

  serverLogs = [];
  serverReady = false;
  serverChildExited = false;

  const child = spawn(process.execPath, args, {
    cwd: app.isPackaged ? dirname(serverEntry) : app.getAppPath(),
    env: createChildEnv(dataDir),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverChild = child;

  process.stdout.write(`[desktop] server child started (pid ${child.pid ?? 'unknown'})\n`);
  process.stdout.write(`[desktop] server entry: ${serverEntry}\n`);

  child.once('exit', (code, signal) => {
    serverChildExited = true;
    if (quitting || stopping || !serverReady) return;

    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    process.stderr.write(`[desktop] server child exited unexpectedly (${detail})\n`);
    handleServerCrash(detail);
  });

  const url = await waitForServerUrl(child);
  await waitForHealth(child, url);
  serverReady = true;

  process.stdout.write(
    `[desktop] server child ready at ${url.origin} (pid ${child.pid ?? 'unknown'})\n`,
  );
  if (rom) {
    process.stdout.write(`[desktop] ROM: ${rom}\n`);
  }
  return { child, url };
}

function handleServerCrash(detail: string): void {
  if (quitting) return;

  quitting = true;
  const message =
    `The local server stopped unexpectedly (${detail}).\n\n` +
    `Restart ${APP_TITLE}. If this repeats, check the data directory and ROM settings.\n\n` +
    formatLogTail();
  process.stderr.write(`[desktop] ${message}\n`);

  void stopServerChild().finally(() => {
    try {
      dialog.showErrorBox(`${APP_TITLE} lost its server`, message);
    } finally {
      app.quit();
    }
  });
}

function applySecureWebContents(window: BrowserWindow, url: URL): void {
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    const external = toHttpUrl(target);
    if (external) {
      void shell.openExternal(external.toString());
    }
    return { action: 'deny' };
  });

  const guardNavigation = (event: Electron.Event, targetUrl: string): void => {
    let target: URL;
    try {
      target = new URL(targetUrl);
    } catch {
      event.preventDefault();
      return;
    }

    if (target.origin !== url.origin) {
      process.stderr.write(`[desktop] blocked navigation to ${targetUrl}\n`);
      event.preventDefault();
    }
  };

  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
}

function createDashboardWindow(url: URL): BrowserWindow {
  const window = new BrowserWindow({
    title: APP_TITLE,
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  applySecureWebContents(window, url);

  void window.loadURL(url.toString()).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[desktop] failed to load ${url.origin}: ${message}\n`);
  });

  return window;
}

function openCaptureWindow(url: URL): BrowserWindow {
  if (captureWindow && !captureWindow.isDestroyed()) {
    if (captureWindow.isMinimized()) captureWindow.restore();
    captureWindow.show();
    captureWindow.focus();
    return captureWindow;
  }

  const window = new BrowserWindow({
    title: CAPTURE_TITLE,
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    minWidth: 320,
    minHeight: 180,
    show: false,
    resizable: true,
    backgroundColor: CAPTURE_BACKGROUND_COLOR,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  captureWindow = window;
  window.setMenuBarVisibility(false);

  // OBS matches windows by title. Ignore page title changes so navigation or
  // HUD updates can never break the capture source.
  window.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(CAPTURE_TITLE);
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    if (captureWindow === window) captureWindow = null;
  });

  applySecureWebContents(window, url);

  const captureUrl = new URL('/overlay?client=capture', url);
  void window.loadURL(captureUrl.toString()).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[desktop] failed to load ${captureUrl.toString()}: ${message}\n`);
  });

  return window;
}

function buildApplicationMenu(url: URL): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }],
    },
    {
      label: 'Window',
      submenu: [
        {
          id: 'open-capture-window',
          label: 'Open Capture Window',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => {
            openCaptureWindow(url);
          },
        },
        { type: 'separator' },
        { role: 'minimize' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function handleBeforeQuit(event: Electron.Event): void {
  if (quitting) return;

  if (serverChild && !serverChildExited) {
    event.preventDefault();
    quitting = true;
    void stopServerChild().finally(() => {
      app.quit();
    });
    return;
  }

  quitting = true;
}

function start(): void {
  app.setName(APP_TITLE);
  if (process.platform === 'win32') {
    app.setAppUserModelId('dev.twitchplaysgb.app');
  }

  let externalUrl: URL | undefined;
  if (process.env.TPG_SERVER_URL) {
    try {
      externalUrl = parseServerUrl(process.env.TPG_SERVER_URL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[desktop] ${message}\n`);
      try {
        dialog.showErrorBox('Twitch Plays GB could not start', message);
      } finally {
        app.exit(1);
      }
      return;
    }
  }

  app.on('before-quit', handleBeforeQuit);
  app.on('window-all-closed', () => {
    app.quit();
  });

  void app
    .whenReady()
    .then(async () => {
      let url: URL;

      if (externalUrl) {
        url = externalUrl;
      } else {
        try {
          const started = await startServerChild();
          url = started.url;
        } catch (error) {
          if (quitting) return;
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[desktop] failed to start server child: ${message}\n`);
          await stopServerChild().catch(() => {});
          try {
            dialog.showErrorBox('Twitch Plays GB could not start its server', message);
          } finally {
            app.exit(1);
          }
          return;
        }
      }

      if (quitting) return;
      buildApplicationMenu(url);
      mainWindow = createDashboardWindow(url);

      if (flagEnabled(process.env.TPG_CAPTURE)) {
        openCaptureWindow(url);
      }
    })
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`[desktop] failed to start: ${message}\n`);
      await stopServerChild().catch(() => {});
      app.exit(1);
    });
}

start();
