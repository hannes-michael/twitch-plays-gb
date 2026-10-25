import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const SELF_TEST_STATUS_TIMEOUT_MS = 30_000;
const SELF_TEST_GROWTH_TIMEOUT_MS = 5_000;
const SELF_TEST_POLL_INTERVAL_MS = 100;
const SELF_TEST_REQUEST_TIMEOUT_MS = 5_000;

function flagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const SELF_TEST =
  process.argv.some(
    (arg) => arg === '--self-test' || arg === '--self-test=1' || arg === '--self-test=true',
  ) || flagEnabled(process.env.TPG_SELF_TEST);

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let serverChild: ChildProcess | undefined;
let serverChildExited = true;
let serverReady = false;
let serverLogs: string[] = [];
let stopping = false;
let quitting = false;
let stopPromise: Promise<void> | undefined;
let selfTestDataDir: string | undefined;
let selfTestCreatedDataDir = false;
let selfTestFinishing = false;

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

class SelfTestFailure extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'SelfTestFailure';
    this.reason = reason;
  }
}

interface SelfTestRomStatus {
  title?: string;
  model?: string;
  platform?: string;
  width?: number;
  height?: number;
}

interface SelfTestEmulatorStatus {
  status?: string;
  rom?: SelfTestRomStatus | null;
  videoFrames?: number;
  audioChunks?: number;
  audioSampleRate?: number;
  lastError?: string | null;
}

interface SelfTestPage {
  status: number;
  contentType: string;
  body: string;
}

type SelfTestAssetKind = 'script' | 'stylesheet' | 'modulepreload';

interface SelfTestAsset {
  url: string;
  kind: SelfTestAssetKind;
}

interface SelfTestResult {
  status: 'ok' | 'fail';
  packaged: number;
  rom: number;
  model: string;
  size: string;
  frames: number;
  audio: number;
  sampleRate: number;
  pid: number;
  reason: string | null;
}

let selfTestPid: number | undefined;
let selfTestRomRequested = false;
let selfTestLastStatus: SelfTestEmulatorStatus | undefined;

function prepareSelfTestDataDir(): string {
  const override = process.env.TPG_DATA_DIR?.trim();
  if (override) {
    const dataDir = resolve(override);
    process.env.TPG_DATA_DIR = dataDir;
    return dataDir;
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'tpg-self-test-'));
  selfTestCreatedDataDir = true;
  process.env.TPG_DATA_DIR = dataDir;
  return dataDir;
}

function cleanupSelfTestDataDir(): void {
  if (!selfTestCreatedDataDir || !selfTestDataDir) return;

  try {
    rmSync(selfTestDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // The harness or the OS can clean up a temp directory that is still locked.
  }
}

function writeSelfTestLine(stream: NodeJS.WriteStream, line: string): Promise<void> {
  return new Promise((resolveWrite) => {
    let settled = false;

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveWrite();
    }

    // The NSIS portable wrapper does not always inherit stdout. Never let a
    // closed or blocked stream prevent the result file/app.exit path.
    const timer = setTimeout(finish, 1_000);
    try {
      stream.write(line.endsWith('\n') ? line : `${line}\n`, finish);
    } catch {
      finish();
    }
  });
}

function buildSelfTestResult(status: 'ok' | 'fail', reason?: string): SelfTestResult {
  const rom = selfTestLastStatus?.rom;
  return {
    status,
    packaged: app.isPackaged ? 1 : 0,
    rom: selfTestRomRequested ? 1 : 0,
    model: rom?.model ?? 'none',
    size: rom && rom.width && rom.height ? `${rom.width}x${rom.height}` : 'none',
    frames: selfTestLastStatus?.videoFrames ?? 0,
    audio: selfTestLastStatus?.audioChunks ?? 0,
    sampleRate: selfTestLastStatus?.audioSampleRate ?? 0,
    pid: selfTestPid ?? 0,
    reason: reason ?? null,
  };
}

function formatSelfTestSuccessLine(result: SelfTestResult): string {
  return [
    'TPG_SELF_TEST_OK',
    `packaged=${result.packaged}`,
    `rom=${result.rom}`,
    `model=${result.model}`,
    `size=${result.size}`,
    `frames=${result.frames}`,
    `audio=${result.audio}`,
    `sampleRate=${result.sampleRate}`,
    `pid=${result.pid}`,
  ].join(' ');
}

function writeSelfTestResultFile(result: SelfTestResult): void {
  const rawPath = process.env.TPG_SELF_TEST_RESULT?.trim();
  if (!rawPath) return;

  const target = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  const tempPath = `${target}.tmp-${process.pid}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  try {
    renameSync(tempPath, target);
  } catch {
    rmSync(target, { force: true });
    renameSync(tempPath, target);
  }
}

async function finishSelfTest(
  code: number,
  line: string,
  details?: string,
  result?: SelfTestResult,
): Promise<void> {
  if (selfTestFinishing) return;
  selfTestFinishing = true;

  let stopError: unknown;
  try {
    await stopServerChild();
  } catch (error) {
    stopError = error;
  }

  let finalResult =
    result ??
    buildSelfTestResult(code === 0 ? 'ok' : 'fail', stopError ? 'server-stop-failed' : undefined);

  if (stopError !== undefined) {
    code = 1;
    line = 'TPG_SELF_TEST_FAIL reason=server-stop-failed';
    details =
      `${details ? `${details}\n` : ''}` +
      `Failed to stop the server child: ${stopError instanceof Error ? stopError.message : String(stopError)}`;
    finalResult = { ...finalResult, status: 'fail', reason: 'server-stop-failed' };
  }

  cleanupSelfTestDataDir();

  try {
    writeSelfTestResultFile(finalResult);
  } catch (error) {
    code = 1;
    line = 'TPG_SELF_TEST_FAIL reason=result-file-write-failed';
    details =
      `Could not write TPG_SELF_TEST_RESULT: ` +
      `${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    const stream = code === 0 ? process.stdout : process.stderr;
    await writeSelfTestLine(stream, line);
    if (details) await writeSelfTestLine(stream, details);
  } catch {
    // The result file is the machine-readable channel for wrappers without stdout.
  } finally {
    app.exit(code);
  }
}

function failSelfTest(reason: string, message: string): Promise<void> {
  const details = message.includes('Last server output:')
    ? message
    : `${message}\n${formatLogTail()}`;
  return finishSelfTest(
    1,
    `TPG_SELF_TEST_FAIL reason=${reason}`,
    details,
    buildSelfTestResult('fail', reason),
  );
}

async function fetchSelfTestPage(url: URL, accept: string): Promise<SelfTestPage> {
  const response = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(SELF_TEST_REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body,
  };
}

function validatePackagedHtml(name: string, page: SelfTestPage): string | undefined {
  if (page.status !== 200) return `${name} returned HTTP ${page.status}`;
  if (!page.contentType.toLowerCase().includes('text/html')) {
    return `${name} returned content-type ${JSON.stringify(page.contentType)}`;
  }
  if (!page.body.includes('<div id="root">')) {
    return `${name} did not return the built SPA shell`;
  }
  if (!page.body.includes('/assets/')) {
    return `${name} did not reference built web assets`;
  }
  if (page.body.includes('/@vite/client') || page.body.includes('@react-refresh')) {
    return `${name} was served by Vite middleware instead of the packaged assets`;
  }
  return undefined;
}

function readHtmlAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function extractHtmlAssets(html: string): SelfTestAsset[] {
  const assets = new Map<string, SelfTestAssetKind>();
  const tagPattern = /<(script|link)\b[^>]*>/gi;

  for (const match of html.matchAll(tagPattern)) {
    const tag = match[0];
    const tagName = match[1].toLowerCase();

    if (tagName === 'script') {
      const src = readHtmlAttribute(tag, 'src');
      if (src) assets.set(src, 'script');
      continue;
    }

    const rel = readHtmlAttribute(tag, 'rel')?.trim().toLowerCase();
    const href = readHtmlAttribute(tag, 'href');
    if (!href) continue;
    if (rel === 'stylesheet') assets.set(href, 'stylesheet');
    else if (rel === 'modulepreload') assets.set(href, 'modulepreload');
  }

  return [...assets].map(([url, kind]) => ({ url, kind }));
}

async function validatePackagedAssets(
  pageName: string,
  pageUrl: URL,
  page: SelfTestPage,
): Promise<void> {
  const assets = extractHtmlAssets(page.body);
  const kinds = new Set(assets.map((asset) => asset.kind));

  if (!kinds.has('script')) {
    throw new SelfTestFailure('asset-missing', `${pageName} did not reference a script asset.`);
  }
  if (!kinds.has('stylesheet')) {
    throw new SelfTestFailure('asset-missing', `${pageName} did not reference a stylesheet asset.`);
  }

  for (const asset of assets) {
    let assetUrl: URL;
    try {
      assetUrl = new URL(asset.url, pageUrl);
    } catch {
      throw new SelfTestFailure(
        'asset-url',
        `${pageName} referenced an invalid ${asset.kind} URL: ${JSON.stringify(asset.url)}.`,
      );
    }

    if (assetUrl.origin !== pageUrl.origin) {
      throw new SelfTestFailure(
        'asset-origin',
        `${pageName} referenced a cross-origin ${asset.kind}: ${assetUrl.toString()}.`,
      );
    }

    const response = await fetch(assetUrl, {
      headers: {
        accept: asset.kind === 'stylesheet' ? 'text/css,*/*;q=0.1' : 'text/javascript,*/*;q=0.1',
      },
      signal: AbortSignal.timeout(SELF_TEST_REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    if (response.status !== 200) {
      throw new SelfTestFailure(
        'asset-fetch',
        `${pageName} ${asset.kind} ${assetUrl.pathname} returned HTTP ${response.status}.`,
      );
    }

    const expectedType = asset.kind === 'stylesheet' ? 'text/css' : 'javascript';
    if (!contentType.includes(expectedType)) {
      throw new SelfTestFailure(
        'asset-content-type',
        `${pageName} ${asset.kind} ${assetUrl.pathname} returned content-type ` +
          `${JSON.stringify(contentType)}.`,
      );
    }

    if (body.trim().length === 0) {
      throw new SelfTestFailure(
        'asset-empty',
        `${pageName} ${asset.kind} ${assetUrl.pathname} returned an empty body.`,
      );
    }
  }
}

async function validateMissingAsset(pageUrl: URL): Promise<void> {
  const missingUrl = new URL('/assets/__tpg_self_test_missing__.js', pageUrl);
  const response = await fetch(missingUrl, {
    signal: AbortSignal.timeout(SELF_TEST_REQUEST_TIMEOUT_MS),
  });
  await response.text();

  if (response.status !== 404) {
    throw new SelfTestFailure(
      'missing-asset-fallback',
      `A missing packaged asset returned HTTP ${response.status} instead of 404.`,
    );
  }
}

async function fetchSelfTestJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(SELF_TEST_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function waitForRunningMedia(url: URL): Promise<SelfTestEmulatorStatus> {
  const statusUrl = new URL('/api/emulator/status', url);
  const startupDeadline = Date.now() + SELF_TEST_STATUS_TIMEOUT_MS;
  let growthDeadline: number | undefined;
  let firstStatus: SelfTestEmulatorStatus | undefined;
  let lastStatus: SelfTestEmulatorStatus | undefined;
  let lastError = 'no response yet';

  while (Date.now() < (growthDeadline ?? startupDeadline)) {
    let status: SelfTestEmulatorStatus;

    try {
      status = await fetchSelfTestJson<SelfTestEmulatorStatus>(statusUrl);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, SELF_TEST_POLL_INTERVAL_MS));
      continue;
    }

    lastStatus = status;
    selfTestLastStatus = status;

    if (status.status === 'error') {
      throw new SelfTestFailure(
        'emulator-error',
        `Emulator reported an error: ${status.lastError ?? 'unknown error'}`,
      );
    }

    const runningWithMedia =
      status.status === 'running' &&
      typeof status.videoFrames === 'number' &&
      status.videoFrames > 0 &&
      typeof status.audioChunks === 'number' &&
      status.audioChunks > 0;

    if (runningWithMedia) {
      if (!firstStatus) {
        firstStatus = status;
        growthDeadline = Date.now() + SELF_TEST_GROWTH_TIMEOUT_MS;
      } else if (
        (status.videoFrames ?? 0) > (firstStatus.videoFrames ?? 0) &&
        (status.audioChunks ?? 0) > (firstStatus.audioChunks ?? 0)
      ) {
        return status;
      }
    }

    lastError =
      `status ${status.status ?? 'unknown'}, ` +
      `frames ${status.videoFrames ?? 0}, audio ${status.audioChunks ?? 0}`;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, SELF_TEST_POLL_INTERVAL_MS));
  }

  const romDetail = lastStatus?.rom
    ? ` Last ROM status: ${lastStatus.rom.model ?? 'unknown'} ${lastStatus.rom.width}x${lastStatus.rom.height}.`
    : '';

  if (firstStatus) {
    throw new SelfTestFailure(
      'emulator-not-growing',
      `Emulator counters did not grow within ${SELF_TEST_GROWTH_TIMEOUT_MS}ms ` +
        `(first: frames ${firstStatus.videoFrames ?? 0}, audio ${firstStatus.audioChunks ?? 0}; ` +
        `last: ${lastError}).${romDetail}`,
    );
  }

  throw new SelfTestFailure(
    'emulator-timeout',
    `Emulator did not become running with video and audio within ` +
      `${SELF_TEST_STATUS_TIMEOUT_MS}ms (last: ${lastError}).${romDetail}`,
  );
}

async function runSelfTest(): Promise<void> {
  selfTestRomRequested = Boolean(process.env.TPG_ROM?.trim());

  try {
    let started: { child: ChildProcess; url: URL; serverEntry: string };
    try {
      started = await startServerChild();
    } catch (error) {
      selfTestPid = serverChild?.pid;
      throw new SelfTestFailure(
        'server-start-failed',
        error instanceof Error ? error.message : String(error),
      );
    }

    const { child, url, serverEntry } = started;

    if (typeof child.pid !== 'number' || child.pid <= 0) {
      throw new SelfTestFailure('server-pid', 'The server child did not report a real PID.');
    }
    selfTestPid = child.pid;

    const health = await fetchSelfTestJson<{ status?: string }>(new URL('/health', url));
    if (health.status !== 'ok') {
      throw new SelfTestFailure('health', `Unexpected /health payload: ${JSON.stringify(health)}`);
    }

    const rootPage = await fetchSelfTestPage(new URL('/', url), 'text/html');
    const overlayPage = await fetchSelfTestPage(new URL('/overlay?client=obs', url), 'text/html');
    const rootProblem = validatePackagedHtml('GET /', rootPage);
    if (rootProblem) throw new SelfTestFailure('root-html', rootProblem);
    const overlayProblem = validatePackagedHtml('GET /overlay?client=obs', overlayPage);
    if (overlayProblem) throw new SelfTestFailure('overlay-html', overlayProblem);

    await validatePackagedAssets('GET /', url, rootPage);
    await validatePackagedAssets('GET /overlay?client=obs', url, overlayPage);
    await validateMissingAsset(url);

    if (app.isPackaged && serverLogs.some((line) => line.includes('mounting Vite middleware'))) {
      throw new SelfTestFailure(
        'vite-middleware',
        'The packaged server mounted Vite middleware instead of serving built assets.',
      );
    }

    if (app.isPackaged && !serverEntry.includes('app.asar.unpacked')) {
      throw new SelfTestFailure(
        'unpacked-entry',
        `The packaged server did not run from app.asar.unpacked (entry: ${serverEntry}).`,
      );
    }

    const configLine = serverLogs.find((line) => line.includes('configuration: host='));
    if (configLine && (!/\bdev=false\b/.test(configLine) || !/\btest=false\b/.test(configLine))) {
      throw new SelfTestFailure(
        'dev-test-flags',
        `The server child received development/test flags: ${configLine}`,
      );
    }

    let status: SelfTestEmulatorStatus;
    if (selfTestRomRequested) {
      status = await waitForRunningMedia(url);
      selfTestLastStatus = status;
      const rom = status.rom;
      if (!rom || !rom.model || !rom.width || !rom.height) {
        throw new SelfTestFailure(
          'rom-status',
          'The emulator did not report ROM model/dimensions.',
        );
      }

      const [expectedWidth, expectedHeight] = rom.model === 'AGB' ? [240, 160] : [160, 144];
      if (rom.width !== expectedWidth || rom.height !== expectedHeight) {
        throw new SelfTestFailure(
          'rom-dimensions',
          `Unexpected dimensions for ${rom.model}: ${rom.width}x${rom.height} ` +
            `(expected ${expectedWidth}x${expectedHeight}).`,
        );
      }
      if (status.audioSampleRate !== 48_000) {
        throw new SelfTestFailure(
          'audio-rate',
          `Expected 48000 Hz audio, received ${status.audioSampleRate ?? 'unknown'}.`,
        );
      }
    } else {
      status = await fetchSelfTestJson<SelfTestEmulatorStatus>(
        new URL('/api/emulator/status', url),
      );
      selfTestLastStatus = status;
      if (status.status !== 'stopped' || status.rom) {
        throw new SelfTestFailure(
          'unexpected-emulator',
          `Without a ROM the emulator should stay stopped, received ${JSON.stringify(status)}.`,
        );
      }
    }

    selfTestPid = child.pid;
    const result = buildSelfTestResult('ok');
    await finishSelfTest(0, formatSelfTestSuccessLine(result), undefined, result);
  } catch (error) {
    const reason = error instanceof SelfTestFailure ? error.reason : 'unexpected-error';
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await failSelfTest(reason, message);
  }
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

async function startServerChild(): Promise<{
  child: ChildProcess;
  url: URL;
  serverEntry: string;
}> {
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
  return { child, url, serverEntry };
}

function handleServerCrash(detail: string): void {
  if (quitting) return;

  quitting = true;
  const reason = `The local server stopped unexpectedly (${detail}).`;
  process.stderr.write(`[desktop] ${reason}\n`);

  if (SELF_TEST) {
    void failSelfTest('server-crashed', reason);
    return;
  }

  const message =
    `${reason}\n\n` +
    `Restart ${APP_TITLE}. If this repeats, check the data directory and ROM settings.\n\n` +
    formatLogTail();

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

  if (SELF_TEST) {
    // Headless packaged smoke mode: no windows, menu, capture window, or
    // dialogs. It still spawns the real server child through Electron-as-Node
    // and exercises the packaged assets and native emulator worker.
    app.disableHardwareAcceleration();
    selfTestDataDir = prepareSelfTestDataDir();
    const profileDir = join(selfTestDataDir, 'electron-profile');
    mkdirSync(profileDir, { recursive: true });
    app.setPath('userData', profileDir);

    // A self-test always owns its server. External-server and capture settings
    // from the surrounding shell must not change what is being proven.
    delete process.env.TPG_SERVER_URL;
    delete process.env.TPG_SERVER_ENTRY;
    delete process.env.TPG_CAPTURE;

    process.once('exit', cleanupSelfTestDataDir);

    void app
      .whenReady()
      .then(runSelfTest)
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        await failSelfTest('startup-failed', message);
      });
    return;
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
