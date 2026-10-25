import { watch } from 'node:fs';
import { join } from 'node:path';
import {
  buildDesktop,
  fetchHealth,
  killTree,
  repoRoot,
  spawnElectron,
  spawnPrefixed,
  waitForExit,
} from './dev-utils.mjs';

const SERVER_START_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const RESTART_DEBOUNCE_MS = 200;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let serverProcess;
let electronProcess;
let electronExitExpected = false;
let watcher;
let currentUrl;
let serverReady = false;
let shuttingDown = false;
let restarting = false;
let restartQueued = false;
let restartTimer;

function log(message) {
  console.log(`[dev] ${message}`);
}

function startServer() {
  let resolveUrl;
  let rejectUrl;
  const firstUrl = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const startupTimer = setTimeout(() => {
    rejectUrl(new Error(`server did not print TPG_URL within ${SERVER_START_TIMEOUT_MS}ms`));
  }, SERVER_START_TIMEOUT_MS);
  startupTimer.unref();

  const failStartup = (message) => {
    clearTimeout(startupTimer);
    rejectUrl(new Error(message));
  };

  const child = spawnPrefixed(
    'server',
    process.execPath,
    [tsxCli, 'watch', 'src/server/index.ts'],
    {
      env: { ...process.env, TPG_DEV: '1', TPG_TEST: '0' },
      onLine: (line) => {
        const match = /^TPG_URL=(.+)$/.exec(line);
        if (match) {
          clearTimeout(startupTimer);
          const url = match[1].trim();
          const changed = currentUrl !== undefined && currentUrl !== url;
          currentUrl = url;
          resolveUrl?.(url);

          if (changed && serverReady && !shuttingDown) {
            log(`server URL changed to ${url}; restarting Electron`);
            void restartElectron('server URL changed');
          }
        }

        if (
          !serverReady &&
          /Configuration error:|Failed to initialize server|is already in use|Fatal error:/.test(
            line,
          )
        ) {
          failStartup(`server startup failed: ${line}`);
        }
      },
    },
  );

  serverProcess = child;
  child.once('error', (error) => {
    rejectUrl(error);
  });
  child.once('exit', (code, signal) => {
    if (serverProcess === child) serverProcess = undefined;
    if (shuttingDown) return;

    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    if (!serverReady) {
      failStartup(`server exited before becoming ready (${detail})`);
      return;
    }

    log(`server watcher exited (${detail})`);
    void shutdown(code && code !== 0 ? code : 0, 'server exited');
  });

  return firstUrl;
}

async function waitForHealth(serverUrl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = 'no response yet';

  while (Date.now() < deadline) {
    try {
      await fetchHealth(serverUrl, 1_000);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(
    `server did not become healthy at ${serverUrl}/health within ${HEALTH_TIMEOUT_MS}ms ` +
      `(${lastError})`,
  );
}

function launchElectron(serverUrl) {
  const userDataDir = join(repoRoot, 'data', 'dev', 'electron');
  const child = spawnElectron('electron', serverUrl, [
    `--user-data-dir=${userDataDir}`,
    ...process.argv.slice(2),
  ]);
  electronProcess = child;

  child.once('error', (error) => {
    if (electronProcess === child) electronProcess = undefined;
    if (shuttingDown) return;
    log(`failed to launch Electron: ${error.message}`);
    void shutdown(1, 'Electron launch failed');
  });

  child.once('exit', (code, signal) => {
    if (electronProcess !== child) return;
    electronProcess = undefined;
    if (shuttingDown || electronExitExpected) return;

    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    log(`Electron exited (${detail}); shutting down dev`);
    void shutdown(code ?? (signal ? 1 : 0), 'Electron exited');
  });
}

async function stopElectron() {
  const child = electronProcess;
  if (!child) return;

  electronExitExpected = true;
  killTree(child, 'SIGTERM');
  const exited = await waitForExit(child, 4_000);
  if (!exited) {
    killTree(child, 'SIGKILL');
    await waitForExit(child, 1_000);
  }

  electronExitExpected = false;
  if (electronProcess === child) electronProcess = undefined;
}

async function restartElectron(reason) {
  if (shuttingDown) return;
  if (restarting) {
    restartQueued = true;
    return;
  }

  restarting = true;
  try {
    do {
      restartQueued = false;
      log(`${reason}; rebuilding desktop bundle`);

      try {
        await buildDesktop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`desktop build failed: ${message}; keeping the current window`);
        return;
      }

      if (shuttingDown) return;
      await stopElectron();
      if (shuttingDown || !currentUrl) return;

      launchElectron(currentUrl);
      log('Electron restarted');
      reason = 'desktop source changed';
    } while (restartQueued);
  } finally {
    restarting = false;
  }
}

function watchDesktop() {
  const target = join(repoRoot, 'src', 'desktop');
  const onChange = (_event, filename) => {
    if (shuttingDown) return;
    if (filename && !/\.(?:[cm]?[jt]sx?|json)$/i.test(filename.toString())) return;

    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      void restartElectron('desktop source changed');
    }, RESTART_DEBOUNCE_MS);
  };

  try {
    watcher = watch(target, { recursive: true }, onChange);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`recursive desktop watch unavailable (${message}); watching the top level only`);
    watcher = watch(target, onChange);
  }

  watcher.on('error', (error) => {
    log(`desktop watcher error: ${error.message}`);
  });
}

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${reason}; shutting down`);

  clearTimeout(restartTimer);
  watcher?.close();
  watcher = undefined;
  electronExitExpected = true;

  const children = [electronProcess, serverProcess].filter(Boolean);
  for (const child of children) {
    killTree(child, 'SIGTERM');
  }

  const exits = await Promise.all(children.map((child) => waitForExit(child, SHUTDOWN_TIMEOUT_MS)));
  for (let index = 0; index < children.length; index += 1) {
    if (exits[index]) continue;
    killTree(children[index], 'SIGKILL');
    await waitForExit(children[index], 1_000);
  }

  process.exit(code);
}

async function main() {
  const serverUrl = await startServer();
  log(`server is starting at ${serverUrl}`);
  await waitForHealth(serverUrl);
  serverReady = true;
  log(`server healthy at ${serverUrl}`);
  log(`data directory is managed by the server (dev default: ${join(repoRoot, 'data', 'dev')})`);

  await buildDesktop();
  if (shuttingDown) return;

  log('desktop bundle built; launching Electron');
  launchElectron(serverUrl);
  watchDesktop();
  log('watching src/desktop for changes; press Ctrl+C to stop');
}

process.on('SIGINT', () => {
  void shutdown(0, 'SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown(0, 'SIGTERM');
});

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log(message);
  void shutdown(1, 'startup failed');
});
