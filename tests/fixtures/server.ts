import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const STARTUP_TIMEOUT_MS = 20_000;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface TestServer {
  baseURL: string;
  dataDir: string;
  pid: number | undefined;
  /** Exit code after the process has exited, or null while it is running. */
  readonly exitCode: number | null;
  getLogs(): string;
  stop(): Promise<void>;
}

export interface StartServerOptions {
  /** Production mode runs the built dist/server entrypoint and static dist/web assets. */
  mode?: 'test' | 'production';
  /** Test-only override for the SIGTERM-to-SIGKILL escalation delay. */
  shutdownTimeoutMs?: number;
  /** Boot this ROM through the normal `--rom` configuration path. */
  rom?: string;
  /** Bind address; tests can bind 0.0.0.0 and still connect through 127.0.0.1. */
  host?: string;
  /** Extra environment values applied after the fixture's isolation defaults. */
  env?: NodeJS.ProcessEnv;
  /** Seed the temporary data directory after creation and before server startup. */
  prepareDataDir?: (dataDir: string) => void | Promise<void>;
}

export interface ServerFixture {
  baseURL: string;
  dataDir: string;
  request: APIRequestContext;
  getLogs(): string;
}

export interface AppFixture {
  baseURL: string;
  dataDir: string;
  page: Page;
  request: APIRequestContext;
}

type Fixtures = {
  server: ServerFixture;
  app: AppFixture;
  /** Playwright option: boot this ROM through the normal `--rom` config path. */
  emulatorRom: string;
  /** Playwright option: extra environment for the real server process. */
  serverEnv: NodeJS.ProcessEnv;
};

interface LogBuffer {
  lines: string[];
  partial: string;
}

function createLogBuffer(): LogBuffer {
  return { lines: [], partial: '' };
}

function appendChunk(
  buffer: LogBuffer,
  chunk: Buffer | string,
  onLine: (line: string) => void,
): void {
  buffer.partial += chunk.toString();
  const parts = buffer.partial.split(/\r?\n/);
  buffer.partial = parts.pop() ?? '';
  for (const line of parts) {
    if (line === '') continue;
    buffer.lines.push(line);
    onLine(line);
  }
}

function flushBuffer(buffer: LogBuffer): void {
  if (buffer.partial !== '') {
    buffer.lines.push(buffer.partial);
    buffer.partial = '';
  }
}

function formatLogs(stdout: LogBuffer, stderr: LogBuffer): string {
  flushBuffer(stdout);
  flushBuffer(stderr);
  const sections: string[] = [];
  if (stdout.lines.length > 0) {
    sections.push(`stdout:\n${stdout.lines.slice(-80).join('\n')}`);
  }
  if (stderr.lines.length > 0) {
    sections.push(`stderr:\n${stderr.lines.slice(-80).join('\n')}`);
  }
  return sections.length > 0 ? sections.join('\n') : '(no server output captured)';
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit(): void {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

async function waitForHealth(
  baseURL: string,
  child: ChildProcess,
  logs: () => string,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = 'no response yet';

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const status = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
      throw new Error(`Server exited with ${status} before becoming healthy.\n${logs()}`);
    }

    try {
      const response = await fetch(`${baseURL}/health`, {
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

    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Server did not become healthy at ${baseURL}/health within ${STARTUP_TIMEOUT_MS}ms ` +
      `(last error: ${lastError}).\n${logs()}`,
  );
}

function waitForUrl(urlPromise: Promise<string>, logs: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Server did not print TPG_URL within ${STARTUP_TIMEOUT_MS}ms.\n${logs()}`));
    }, STARTUP_TIMEOUT_MS);

    urlPromise.then(
      (url) => {
        clearTimeout(timer);
        resolve(url);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Returns the current environment without app/test configuration leaks.
 * Electron tests use this so a developer's TPG_* or HOST/PORT values cannot
 * change the scenario under test. Pass explicit overrides for each launch.
 */
export function createElectronEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith('TPG_') ||
      key === 'HOST' ||
      key === 'PORT' ||
      key === 'NODE_OPTIONS' ||
      key === 'ELECTRON_RUN_AS_NODE'
    ) {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }

  return env;
}

function createServerEnv(
  dataDir: string,
  production: boolean,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  // Developer environment must not leak into the fixture. In particular, a
  // TPG_CONFIG pointing at a missing file would now be a hard config error.
  return {
    ...createElectronEnv(),
    TPG_TEST: production ? '0' : '1',
    TPG_DEV: '0',
    TPG_DATA_DIR: dataDir,
    TPG_LOG_LEVEL: 'debug',
    FORCE_COLOR: '0',
    ...overrides,
  };
}

/**
 * Starts the real server on a random port with a temporary data directory.
 *
 * Playwright usage:
 *
 *   import { test, expect } from '../../fixtures/server';
 *
 *   test('launches', async ({ app }) => {
 *     // app.page is already navigated to the server and app.baseURL points at it.
 *     await expect(app.page.getByRole('heading', { name: 'Twitch Plays GB' })).toBeVisible();
 *     const health = await app.request.get(`${app.baseURL}/health`);
 *   });
 */
export async function startServer(options: StartServerOptions = {}): Promise<TestServer> {
  const production = options.mode === 'production';
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const dataDir = await mkdtemp(join(tmpdir(), 'tpg-e2e-'));
  if (options.prepareDataDir) {
    try {
      await options.prepareDataDir(dataDir);
    } catch (error) {
      await rm(dataDir, { recursive: true, force: true });
      throw new Error(
        `Failed to prepare test data directory: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const stdoutLog = createLogBuffer();
  const stderrLog = createLogBuffer();
  const logs = (): string => formatLogs(stdoutLog, stderrLog);

  const serverArgs = ['--host', options.host ?? '127.0.0.1', '--port', '0', '--data-dir', dataDir];
  if (options.rom) {
    serverArgs.push('--rom', options.rom);
  }
  const commandArgs = production
    ? [join(repoRoot, 'dist', 'server', 'index.js'), ...serverArgs]
    : ['--import', 'tsx', join(repoRoot, 'src', 'server', 'index.ts'), ...serverArgs];

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, commandArgs, {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      env: createServerEnv(dataDir, production, options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw new Error(
      `Failed to start server process: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const { stdout, stderr } = child;
  if (!stdout || !stderr) {
    killProcessTree(child, 'SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
    throw new Error('Failed to capture server stdout/stderr.');
  }

  let stopped = false;
  let startupCompleted = false;
  let stopRequested = false;
  let forcedShutdown = false;
  let unexpectedExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let resolveUrl: ((url: string) => void) | undefined;
  let rejectUrl: ((error: Error) => void) | undefined;
  const urlPromise = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const onParentExit = (): void => {
    killProcessTree(child, 'SIGKILL');
  };
  process.once('exit', onParentExit);

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const exitedBeforeStop =
      child.exitCode !== null || child.signalCode !== null
        ? { code: child.exitCode, signal: child.signalCode }
        : undefined;
    stopRequested = true;
    process.removeListener('exit', onParentExit);
    flushBuffer(stdoutLog);
    flushBuffer(stderrLog);

    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      killProcessTree(child, 'SIGTERM');
      const exited = await waitForExit(child, shutdownTimeoutMs);
      if (!exited) {
        forcedShutdown = true;
        killProcessTree(child, 'SIGKILL');
        await waitForExit(child, 1_000);
      }
    }

    await rm(dataDir, { recursive: true, force: true });

    if (forcedShutdown) {
      throw new Error(
        `Server required SIGKILL after ${shutdownTimeoutMs}ms without exiting from SIGTERM.\n${logs()}`,
      );
    }

    if (startupCompleted) {
      const exit = unexpectedExit ?? exitedBeforeStop;
      if (exit !== undefined) {
        const detail = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`;
        throw new Error(`Server exited unexpectedly with ${detail} during the test.\n${logs()}`);
      }
    }
  };

  stdout.on('data', (chunk: Buffer | string) => {
    appendChunk(stdoutLog, chunk, (line) => {
      const match = /^TPG_URL=(.+)$/.exec(line);
      if (match) resolveUrl?.(match[1]);
    });
  });

  stderr.on('data', (chunk: Buffer | string) => {
    appendChunk(stderrLog, chunk, () => {});
  });

  child.once('error', (error) => {
    rejectUrl?.(new Error(`Failed to start server process: ${error.message}\n${logs()}`));
  });

  child.once('exit', (code, signal) => {
    if (startupCompleted && !stopRequested) {
      unexpectedExit = { code, signal };
    }
    rejectUrl?.(
      new Error(
        `Server exited with ${signal ? `signal ${signal}` : `code ${code}`} before printing TPG_URL.\n${logs()}`,
      ),
    );
  });

  try {
    const printedURL = new URL(await waitForUrl(urlPromise, logs));
    // A wildcard bind prints 0.0.0.0; the fixture still talks to it through
    // loopback so health checks work on every platform.
    if (printedURL.hostname === '0.0.0.0') printedURL.hostname = '127.0.0.1';
    const baseURL = printedURL.origin;
    await waitForHealth(baseURL, child, logs);
    startupCompleted = true;
    return {
      baseURL,
      dataDir,
      pid: child.pid,
      get exitCode() {
        return child.exitCode;
      },
      getLogs: logs,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export const test = base.extend<Fixtures>({
  emulatorRom: ['', { option: true }],
  serverEnv: [{}, { option: true }],

  server: async ({ playwright, emulatorRom, serverEnv }, use, testInfo) => {
    const server = await startServer({ rom: emulatorRom || undefined, env: serverEnv });
    const request = await playwright.request.newContext({ baseURL: server.baseURL });
    let failure: unknown;

    try {
      await use({
        baseURL: server.baseURL,
        dataDir: server.dataDir,
        getLogs: server.getLogs,
        request,
      });
    } catch (error) {
      failure = error;
    }

    let teardownError: unknown;
    try {
      await request.dispose();
    } catch (error) {
      teardownError = error;
    }

    try {
      await server.stop();
    } catch (error) {
      teardownError ??= error;
    }

    if (
      failure !== undefined ||
      teardownError !== undefined ||
      testInfo.status !== testInfo.expectedStatus
    ) {
      await testInfo.attach('server-logs', {
        body: server.getLogs(),
        contentType: 'text/plain',
      });
    }

    if (teardownError !== undefined) {
      await testInfo.attach('fixture-teardown-error', {
        body:
          teardownError instanceof Error
            ? (teardownError.stack ?? teardownError.message)
            : String(teardownError),
        contentType: 'text/plain',
      });
    }

    if (failure !== undefined) throw failure;
    if (teardownError !== undefined) throw teardownError;
  },

  app: async ({ page, server }, use) => {
    let response;
    try {
      response = await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load the app at ${server.baseURL}: ${message}\n${server.getLogs()}`,
        {
          cause: error,
        },
      );
    }

    if (!response || !response.ok()) {
      throw new Error(
        `App returned HTTP ${response?.status() ?? 'no response'} at ${server.baseURL}.\n${server.getLogs()}`,
      );
    }

    await use({ baseURL: server.baseURL, dataDir: server.dataDir, page, request: server.request });
  },
});

export { expect };
