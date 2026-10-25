import { join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';

const APP_TITLE = 'Twitch Plays GB';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
const BACKGROUND_COLOR = '#0b1020';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

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

function createWindow(serverUrl: URL): BrowserWindow {
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

  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = toHttpUrl(url);
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

    if (target.origin !== serverUrl.origin) {
      process.stderr.write(`[desktop] blocked navigation to ${targetUrl}\n`);
      event.preventDefault();
    }
  };

  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);

  void window.loadURL(serverUrl.toString()).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[desktop] failed to load ${serverUrl.origin}: ${message}\n`);
  });

  return window;
}

function start(): void {
  app.setName(APP_TITLE);
  if (process.platform === 'win32') {
    app.setAppUserModelId('dev.twitchplaysgb.app');
  }

  let serverUrl: URL;
  try {
    serverUrl = parseServerUrl(process.env.TPG_SERVER_URL ?? DEFAULT_SERVER_URL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[desktop] ${message}\n`);
    dialog.showErrorBox('Twitch Plays GB could not start', message);
    app.exit(1);
    return;
  }

  void app
    .whenReady()
    .then(() => {
      createWindow(serverUrl);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`[desktop] failed to start: ${message}\n`);
      app.exit(1);
    });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

start();
