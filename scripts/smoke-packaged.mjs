#!/usr/bin/env node
/**
 * Headless smoke test for packaged Twitch Plays GB artifacts.
 *
 * Every selected artifact is launched with `--self-test`. The packaged app must
 * print a `TPG_SELF_TEST_OK ...` line and exit 0 after booting its real server
 * child (Electron-as-Node), serving the packaged web assets, and — when a ROM is
 * supplied — running the native node-mgba worker.
 *
 * The script deliberately sets TPG_DEV=1 and TPG_TEST=1 to prove the packaged
 * app ignores inherited development/test flags. It only adds `--no-sandbox` when
 * the environment cannot run Chromium's sandbox (root or a sandbox error); the
 * production app itself never adds that switch.
 *
 * Usage:
 *   node scripts/smoke-packaged.mjs                 # host platform targets
 *   node scripts/smoke-packaged.mjs --linux         # AppImage + .deb
 *   node scripts/smoke-packaged.mjs --linux --unpacked
 *   node scripts/smoke-packaged.mjs --win           # Windows host only
 *   node scripts/smoke-packaged.mjs --win --wine    # attempt Windows artifacts under Wine
 *   node scripts/smoke-packaged.mjs --all --wine
 *   node scripts/smoke-packaged.mjs --linux --no-rom
 *
 * Windows targets require Windows or `--wine`. The NSIS installer branch is
 * best-effort under Wine; a failure is reported, never converted into a pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(repoRoot, 'release');
const romPath = join(repoRoot, 'tests', 'fixtures', 'roms', 'test_gb.gb');
const logDir = join(repoRoot, 'test-results', 'packaged-smoke');
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURED_CHARS = 5_000_000;

const options = {
  linux: false,
  win: false,
  appimage: false,
  deb: false,
  unpacked: false,
  portable: false,
  installer: false,
  wine: false,
  noRom: false,
  verbose: false,
  keepTemp: false,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

let explicitTarget = false;

for (let index = 0; index < process.argv.length - 2; index += 1) {
  const arg = process.argv[index + 2];

  switch (arg) {
    case '--linux':
      options.linux = true;
      explicitTarget = true;
      break;
    case '--win':
      options.win = true;
      explicitTarget = true;
      break;
    case '--all':
      options.linux = true;
      options.win = true;
      explicitTarget = true;
      break;
    case '--appimage':
      options.appimage = true;
      explicitTarget = true;
      break;
    case '--deb':
      options.deb = true;
      explicitTarget = true;
      break;
    case '--unpacked':
      options.unpacked = true;
      explicitTarget = true;
      break;
    case '--portable':
      options.portable = true;
      explicitTarget = true;
      break;
    case '--installer':
      options.installer = true;
      explicitTarget = true;
      break;
    case '--wine':
      options.wine = true;
      break;
    case '--no-rom':
      options.noRom = true;
      break;
    case '--verbose':
      options.verbose = true;
      break;
    case '--keep-temp':
      options.keepTemp = true;
      break;
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
      break;
    default:
      if (arg.startsWith('--timeout=')) {
        options.timeoutMs = parseTimeout(arg.slice('--timeout='.length));
        break;
      }
      if (arg === '--timeout') {
        options.timeoutMs = parseTimeout(process.argv[index + 3]);
        index += 1;
        break;
      }
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(2);
  }
}

if (!explicitTarget) {
  if (process.platform === 'win32') options.win = true;
  else options.linux = true;
}

function parseTimeout(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000) {
    console.error(`Invalid --timeout value: ${JSON.stringify(value)} (milliseconds, >= 1000)`);
    process.exit(2);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/smoke-packaged.mjs [targets] [options]

Targets:
  --linux       AppImage and .deb (default on Linux)
  --win         NSIS installer and portable .exe (default on Windows)
  --all         All Linux + Windows targets (Windows needs Windows or --wine)
  --appimage    Only the AppImage
  --deb         Only the .deb
  --unpacked    Also run release/linux-unpacked/<binary>
  --portable    Only the portable .exe
  --installer   Only the NSIS installer .exe

Options:
  --wine            Run Windows artifacts through Wine on Linux/macOS
  --no-rom          Do not pass TPG_ROM (server/UI checks only)
  --timeout <ms>    Per-target timeout (default ${DEFAULT_TIMEOUT_MS})
  --keep-temp       Keep temporary data/extraction directories
  --verbose         Stream app output while it runs
  -h, --help        Show this help
`);
}

function createSmokeEnv(overrides = {}) {
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
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

  return { ...env, ...overrides };
}

function findCommand(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

async function isExecutableFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function pickNewest(files) {
  let newest;
  let newestTime = -1;

  for (const file of files) {
    const info = await stat(file);
    if (info.mtimeMs > newestTime) {
      newest = file;
      newestTime = info.mtimeMs;
    }
  }

  return newest;
}

async function listReleaseFiles() {
  try {
    const entries = await readdir(releaseDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(releaseDir, entry.name));
  } catch {
    return [];
  }
}

async function findAppImage() {
  const files = (await listReleaseFiles()).filter((file) => file.endsWith('.AppImage'));
  return pickNewest(files);
}

async function findDeb() {
  const files = (await listReleaseFiles()).filter((file) => file.endsWith('.deb'));
  return pickNewest(files);
}

async function findUnpackedExecutable() {
  const unpackedDir = join(releaseDir, 'linux-unpacked');
  if (!existsSync(unpackedDir)) return undefined;

  const preferred = join(unpackedDir, 'twitch-plays-gb');
  if (await isExecutableFile(preferred)) return preferred;

  for (const entry of await readdir(unpackedDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/^(chrome-sandbox|chrome_crashpad_handler)$/.test(entry.name)) continue;
    if (entry.name.includes('.so')) continue;
    const candidate = join(unpackedDir, entry.name);
    if (await isExecutableFile(candidate)) return candidate;
  }

  return undefined;
}

async function findWindowsArtifacts() {
  const files = (await listReleaseFiles()).filter((file) => file.toLowerCase().endsWith('.exe'));
  const installers = files.filter((file) => /setup|install/i.test(file));
  const portables = files.filter((file) => !/setup|install/i.test(file));

  return {
    installer: await pickNewest(installers),
    portable: await pickNewest(portables),
  };
}

async function findLinuxExecutableRecursive(root) {
  const preferredNames = new Set(['twitch-plays-gb', 'twitch-plays-gb.exe']);
  const excluded = /^(chrome-sandbox|chrome_crashpad_handler|uninstall.*)$/i;

  async function walk(dir, depth) {
    if (depth > 4) return undefined;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (entry.isFile() && preferredNames.has(entry.name)) {
        const candidate = join(dir, entry.name);
        if (await isExecutableFile(candidate)) return candidate;
      }
    }

    for (const entry of entries) {
      if (!entry.isFile() || excluded.test(entry.name)) continue;
      if (entry.name.includes('.so') || entry.name.endsWith('.pak')) continue;
      const candidate = join(dir, entry.name);
      if (await isExecutableFile(candidate)) return candidate;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = await walk(join(dir, entry.name), depth + 1);
      if (found) return found;
    }

    return undefined;
  }

  return walk(root, 0);
}

async function extractAppImage(appImagePath, extractDir) {
  await mkdir(extractDir, { recursive: true });
  const result = await spawnCaptured(appImagePath, ['--appimage-extract'], {
    env: process.env,
    cwd: extractDir,
    timeoutMs: options.timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(
      `--appimage-extract failed (exit ${result.code}): ${result.stderr.trim() || result.error || ''}`,
    );
  }

  const appRun = join(extractDir, 'squashfs-root', 'AppRun');
  if (!existsSync(appRun)) {
    throw new Error(`--appimage-extract did not produce ${appRun}`);
  }
  return appRun;
}

async function findDebExecutable(extractDir) {
  const desktopDir = join(extractDir, 'usr', 'share', 'applications');

  try {
    for (const name of await readdir(desktopDir)) {
      if (!name.endsWith('.desktop')) continue;
      const content = await readFile(join(desktopDir, name), 'utf8');
      const execLine = /^Exec=(.+)$/m.exec(content)?.[1]?.trim();
      if (!execLine) continue;
      const quoted = /^Exec="([^"]+)"/.exec(content)?.[1];
      const command = quoted ?? execLine.split(/\s+/)[0];
      const candidate = join(extractDir, command);
      if (await isExecutableFile(candidate)) return candidate;
    }
  } catch {
    // Fall back to scanning the extracted tree.
  }

  return findLinuxExecutableRecursive(extractDir);
}

function killProcessTree(child) {
  if (child.pid === undefined) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process already exited.
    }
  }
}

function appendCaptured(current, chunk) {
  const next = current + chunk.toString();
  return next.length > MAX_CAPTURED_CHARS ? next.slice(-MAX_CAPTURED_CHARS) : next;
}

function spawnCaptured(command, args, { env, cwd, timeoutMs }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolvePromise({
        command,
        args,
        code: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk) => {
      stdout = appendCaptured(stdout, chunk);
      if (options.verbose) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendCaptured(stderr, chunk);
      if (options.verbose) process.stderr.write(chunk);
    });

    let hardKillTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      hardKillTimer = setTimeout(() => {
        finish({ code: null, signal: 'SIGKILL' });
      }, 5_000);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      resolvePromise({ command, args, stdout, stderr, timedOut, ...result });
    };

    child.once('error', (error) => {
      finish({ code: null, signal: null, error: error.message });
    });

    child.once('close', (code, signal) => {
      finish({ code, signal });
    });
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForFile(finder, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const file = await finder();
    if (file) return file;
    await sleep(200);
  }

  return undefined;
}

async function linuxDisplayPrefix() {
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return [];

  const xvfbRun = findCommand('xvfb-run');
  if (xvfbRun) return [xvfbRun, '-a'];

  throw new Error(
    'No display detected (DISPLAY/WAYLAND_DISPLAY are unset) and xvfb-run is not installed. ' +
      'Install xvfb or run this smoke test with a display.',
  );
}

async function toWinePath(path) {
  if (!findCommand('winepath')) throw new Error('winepath is not installed.');

  const result = await spawnCaptured('winepath', ['-w', path], {
    env: process.env,
    cwd: repoRoot,
    timeoutMs: 30_000,
  });

  const converted = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  if (result.code !== 0 || !converted) {
    throw new Error(
      `winepath failed for ${path}: ${result.error ?? result.stderr.trim() ?? `exit ${result.code}`}`,
    );
  }

  return converted;
}

async function extractDeb(debPath, extractDir) {
  await mkdir(extractDir, { recursive: true });
  const dpkgDeb = findCommand('dpkg-deb');

  if (dpkgDeb) {
    const result = await spawnCaptured(dpkgDeb, ['-x', debPath, extractDir], {
      env: process.env,
      cwd: repoRoot,
      timeoutMs: options.timeoutMs,
    });
    if (result.code !== 0) {
      throw new Error(
        `dpkg-deb -x failed (exit ${result.code}): ${result.stderr.trim() || result.error || ''}`,
      );
    }
    return;
  }

  const ar = findCommand('ar');
  const tar = findCommand('tar');
  if (!ar || !tar) {
    throw new Error('Neither dpkg-deb nor ar+tar is available to extract the .deb.');
  }

  const arDir = join(extractDir, '.ar');
  await mkdir(arDir, { recursive: true });

  const arResult = await spawnCaptured(ar, ['x', debPath], {
    env: process.env,
    cwd: arDir,
    timeoutMs: options.timeoutMs,
  });
  if (arResult.code !== 0) {
    throw new Error(`ar x failed (exit ${arResult.code}): ${arResult.stderr.trim()}`);
  }

  const dataArchive = (await readdir(arDir)).find((name) => /^data\.tar(\.|$)/.test(name));
  if (!dataArchive) throw new Error('The .deb does not contain a data.tar archive.');

  const tarResult = await spawnCaptured(tar, ['-xf', dataArchive, '-C', extractDir], {
    env: process.env,
    cwd: arDir,
    timeoutMs: options.timeoutMs,
  });
  if (tarResult.code !== 0) {
    throw new Error(`tar -xf ${dataArchive} failed (exit ${tarResult.code}): ${tarResult.stderr}`);
  }
}

async function readSelfTestResult(resultFile) {
  try {
    return JSON.parse(await readFile(resultFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function formatSelfTestResultLine(result) {
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

function buildSuccessCheck(run, result, resultFile, timeoutMs = options.timeoutMs) {
  const output = `${run.stdout}\n${run.stderr}`;
  const stdoutSuccessLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('TPG_SELF_TEST_OK '));

  if (run.timedOut) {
    return {
      ok: false,
      successLine: stdoutSuccessLine,
      detail: `timed out after ${timeoutMs}ms without a self-test result`,
    };
  }

  if (run.error) {
    return {
      ok: false,
      successLine: stdoutSuccessLine,
      detail: `could not launch: ${run.error}`,
    };
  }

  if (!result) {
    return {
      ok: false,
      successLine: stdoutSuccessLine,
      detail:
        `missing or invalid self-test result file: ${resultFile}` +
        `${run.code !== 0 ? ` (exit ${run.code})` : ''}`,
    };
  }

  if (result.status !== 'ok') {
    return {
      ok: false,
      successLine: stdoutSuccessLine,
      detail:
        `self-test result status=${result.status}` +
        `${result.reason ? ` reason=${result.reason}` : ''}` +
        `${run.code !== 0 ? ` (exit ${run.code})` : ''}`,
    };
  }

  if (run.code !== 0) {
    return {
      ok: false,
      successLine: stdoutSuccessLine,
      detail: `exited with code ${run.code}${run.signal ? ` (signal ${run.signal})` : ''}`,
    };
  }

  if (result.packaged !== 1) {
    return {
      ok: false,
      successLine: stdoutSuccessLine,
      detail: 'self-test did not report packaged=1',
    };
  }

  const expectedRom = options.noRom ? 0 : 1;
  if (result.rom !== expectedRom) {
    return {
      ok: false,
      successLine: stdoutSuccessLine,
      detail: `self-test did not report rom=${expectedRom}`,
    };
  }

  if (!Number.isInteger(result.pid) || result.pid <= 0) {
    return {
      ok: false,
      successLine: stdoutSuccessLine,
      detail: 'self-test result has no server pid',
    };
  }

  if (expectedRom === 1) {
    if (typeof result.model !== 'string' || result.model === 'none') {
      return {
        ok: false,
        successLine: stdoutSuccessLine,
        detail: 'self-test result has no ROM model',
      };
    }
    if (typeof result.size !== 'string' || result.size === 'none') {
      return {
        ok: false,
        successLine: stdoutSuccessLine,
        detail: 'self-test result has no ROM dimensions',
      };
    }
    if (!(typeof result.frames === 'number' && result.frames > 0)) {
      return {
        ok: false,
        successLine: stdoutSuccessLine,
        detail: 'self-test result has no video frames',
      };
    }
    if (!(typeof result.audio === 'number' && result.audio > 0)) {
      return {
        ok: false,
        successLine: stdoutSuccessLine,
        detail: 'self-test result has no audio chunks',
      };
    }
    if (result.sampleRate !== 48_000) {
      return {
        ok: false,
        successLine: stdoutSuccessLine,
        detail: `self-test result audioSampleRate=${result.sampleRate}`,
      };
    }
  } else if (result.frames !== 0 || result.audio !== 0) {
    return {
      ok: false,
      successLine: stdoutSuccessLine,
      detail: 'self-test reported media counters without a ROM',
    };
  }

  const successLine = formatSelfTestResultLine(result);
  return { ok: true, successLine, detail: successLine, result };
}

async function checkOrphan(pid, useWine) {
  if (!pid || useWine) return undefined;
  await sleep(750);
  if (!isPidAlive(pid)) return undefined;

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Best effort; the check below still fails.
  }

  return `server child pid ${pid} was still alive after the app exited`;
}

async function runLinuxSelfTest({
  artifact,
  command,
  baseArgs = [],
  extraEnv = {},
  timeoutMs = options.timeoutMs,
}) {
  const displayPrefix = await linuxDisplayPrefix();
  const resultFile = join(currentDataDir, 'self-test-result.json');
  await rm(resultFile, { force: true });

  const env = createSmokeEnv({
    ...extraEnv,
    TPG_DATA_DIR: currentDataDir,
    TPG_LOG_LEVEL: 'debug',
    TPG_DEV: '1',
    TPG_TEST: '1',
    TPG_SELF_TEST_RESULT: resultFile,
    ...(options.noRom ? {} : { TPG_ROM: romPath }),
  });

  let extraArgs = [];
  if (process.getuid?.() === 0) extraArgs.push('--no-sandbox');

  const runOnce = async (args) => {
    const invocation =
      displayPrefix.length > 0
        ? { command: displayPrefix[0], args: [...displayPrefix.slice(1), command, ...args] }
        : { command, args };
    return spawnCaptured(invocation.command, invocation.args, {
      env,
      cwd: repoRoot,
      timeoutMs,
    });
  };

  let run = await runOnce([...extraArgs, ...baseArgs, '--self-test']);
  let sandboxFallback = false;

  if (
    run.code !== 0 &&
    !extraArgs.includes('--no-sandbox') &&
    /sandbox|setuid|SUID/i.test(`${run.stdout}\n${run.stderr}`)
  ) {
    sandboxFallback = true;
    extraArgs = ['--no-sandbox'];
    await rm(resultFile, { force: true });
    run = await runOnce([...extraArgs, ...baseArgs, '--self-test']);
  }

  const result = await readSelfTestResult(resultFile);
  const check = buildSuccessCheck(run, result, resultFile, timeoutMs);
  if (check.ok) {
    const orphan = await checkOrphan(result?.pid, false);
    if (orphan) {
      return {
        ...check,
        ok: false,
        detail: orphan,
        artifact,
        run,
        sandboxFallback,
        result,
      };
    }
  }

  return { ...check, artifact, run, sandboxFallback, result };
}

let currentDataDir;

async function runWindowsSelfTest({ artifact, executable, baseArgs = [], extraEnv = {} }) {
  const useWine = process.platform !== 'win32';
  if (useWine && !options.wine) {
    throw new Error('Windows targets require Windows or --wine.');
  }

  if (useWine && !findCommand('wine')) {
    throw new Error('Wine is not installed.');
  }

  const resultFileUnix = join(currentDataDir, 'self-test-result.json');
  await rm(resultFileUnix, { force: true });

  const dataDir = useWine ? await toWinePath(currentDataDir) : currentDataDir;
  const resultFile = useWine ? await toWinePath(resultFileUnix) : resultFileUnix;
  const rom = options.noRom ? undefined : useWine ? await toWinePath(romPath) : romPath;
  const env = createSmokeEnv({
    ...extraEnv,
    TPG_DATA_DIR: dataDir,
    TPG_LOG_LEVEL: 'debug',
    TPG_DEV: '1',
    TPG_TEST: '1',
    TPG_SELF_TEST_RESULT: resultFile,
    ...(rom ? { TPG_ROM: rom } : {}),
    ...(useWine ? { WINEDEBUG: '-all' } : {}),
  });

  const invocation = useWine
    ? { command: 'wine', args: [executable, ...baseArgs, '--self-test'] }
    : { command: executable, args: [...baseArgs, '--self-test'] };

  const run = await spawnCaptured(invocation.command, invocation.args, {
    env,
    cwd: repoRoot,
    timeoutMs: options.timeoutMs,
  });
  const result = await readSelfTestResult(resultFileUnix);
  const check = buildSuccessCheck(run, result, resultFileUnix);
  if (check.ok) {
    const orphan = await checkOrphan(result?.pid, useWine);
    if (orphan) {
      return { ...check, ok: false, detail: orphan, artifact, run, useWine, result };
    }
  }

  return { ...check, artifact, run, useWine, result };
}

async function pickWindowsInstallDir(context) {
  if (process.platform !== 'win32') {
    return join(context.tempRoot, 'installed');
  }

  const suffix = randomBytes(6).toString('hex');
  const systemDrive = (process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
  const candidates = [
    `${systemDrive}\\tpg-smoke-${suffix}`,
    join(process.env.PUBLIC || 'C:\\Users\\Public', `tpg-smoke-${suffix}`),
    join(tmpdir(), `tpg-smoke-${suffix}`),
  ];

  for (const candidate of candidates) {
    if (/\s/.test(candidate)) continue;
    try {
      await mkdir(candidate, { recursive: true });
      return candidate;
    } catch {
      // Try the next writable, space-free root.
    }
  }

  throw new Error('Could not create a space-free install directory for NSIS /D.');
}

async function runWindowsInstaller(context, installer) {
  const useWine = process.platform !== 'win32';
  if (useWine && !options.wine) {
    throw new Error('Windows targets require Windows or --wine.');
  }

  const installDir = await pickWindowsInstallDir(context);
  if (/\s/.test(installDir)) {
    throw new Error(`NSIS /D requires a space-free install directory, received ${installDir}`);
  }
  context.cleanupDirs.push(installDir);
  await mkdir(installDir, { recursive: true });

  const installDirArg = useWine ? await toWinePath(installDir) : installDir;
  const installerEnv = createSmokeEnv(
    useWine ? { WINEDEBUG: '-all', TPG_DATA_DIR: await toWinePath(currentDataDir) } : {},
  );

  const installInvocation = useWine
    ? {
        command: 'wine',
        args: [installer, '/S', `/D=${installDirArg}`],
      }
    : { command: installer, args: ['/S', `/D=${installDirArg}`] };

  const install = await spawnCaptured(installInvocation.command, installInvocation.args, {
    env: installerEnv,
    cwd: repoRoot,
    timeoutMs: options.timeoutMs,
  });

  if (install.code !== 0) {
    throw new Error(
      `silent install failed (exit ${install.code}): ${install.stderr.trim() || install.error || ''}`,
    );
  }

  const installedExe = await waitForFile(async () => {
    for (const entry of await readdir(installDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.exe')) continue;
      if (/^uninstall/i.test(entry.name)) continue;
      return join(installDir, entry.name);
    }
    return undefined;
  }, 30_000);

  if (!installedExe) {
    throw new Error(`installer completed but no executable was found under ${installDir}`);
  }

  const result = await runWindowsSelfTest({
    artifact: installer,
    executable: installedExe,
  });

  const uninstaller = await waitForFile(async () => {
    for (const entry of await readdir(installDir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && /^uninstall.*\.exe$/i.test(entry.name)) {
        return join(installDir, entry.name);
      }
    }
    return undefined;
  }, 5_000);

  if (uninstaller) {
    const uninstallInvocation = useWine
      ? { command: 'wine', args: [uninstaller, '/S'] }
      : { command: uninstaller, args: ['/S'] };
    await spawnCaptured(uninstallInvocation.command, uninstallInvocation.args, {
      env: installerEnv,
      cwd: repoRoot,
      timeoutMs: 60_000,
    });

    // The NSIS uninstaller can return before it has removed the installed
    // files. Give it a bounded window so temp cleanup does not race it.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && existsSync(installedExe)) {
      await sleep(200);
    }
  }

  return result;
}

async function runTarget(target) {
  const started = Date.now();
  const tempRoot = await mkdtemp(join(tmpdir(), `tpg-smoke-${target.name}-`));
  const dataDir = join(tempRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  currentDataDir = dataDir;
  const cleanupDirs = [];

  let outcome;
  let cleanupError;
  try {
    outcome = await target.run({ name: target.name, tempRoot, dataDir, cleanupDirs });
  } catch (error) {
    outcome = {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      successLine: undefined,
      artifact: target.artifact,
      run: undefined,
      sandboxFallback: false,
    };
  } finally {
    currentDataDir = undefined;
    if (!options.keepTemp) {
      for (const dir of cleanupDirs) {
        try {
          await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
          cleanupError ??= error;
        }
      }

      try {
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }

  if (cleanupError && outcome.ok) {
    outcome = {
      ...outcome,
      ok: false,
      detail:
        `temporary directory cleanup failed: ` +
        `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    };
  }

  const durationMs = Date.now() - started;
  const logPath = join(logDir, `${target.name}.log`);
  await writeTargetLog(logPath, target, outcome, tempRoot, durationMs);

  return { ...outcome, name: target.name, durationMs, logPath, tempRoot };
}

async function writeTargetLog(logPath, target, outcome, tempRoot, durationMs) {
  await mkdir(logDir, { recursive: true });
  const run = outcome.run;
  const lines = [
    `target: ${target.name}`,
    `artifact: ${outcome.artifact ?? target.artifact ?? '(not found)'}`,
    `durationMs: ${durationMs}`,
    `tempRoot: ${tempRoot}${options.keepTemp ? ' (kept)' : ' (removed)'}`,
    `sandboxFallback: ${outcome.sandboxFallback ?? false}`,
    `appImageFallback: ${outcome.appImageFallback ?? false}`,
    `ok: ${outcome.ok}`,
    `detail: ${outcome.detail}`,
    `successLine: ${outcome.successLine ?? '(none)'}`,
    `result: ${outcome.result ? JSON.stringify(outcome.result) : '(none)'}`,
    '',
  ];

  if (run) {
    lines.push(
      `command: ${run.command}`,
      `args: ${JSON.stringify(run.args)}`,
      `exitCode: ${run.code}`,
      `signal: ${run.signal}`,
      `timedOut: ${run.timedOut}`,
      `error: ${run.error ?? '(none)'}`,
      '',
      '--- stdout ---',
      run.stdout,
      '--- stderr ---',
      run.stderr,
    );
  }

  await writeFile(logPath, `${lines.join('\n')}\n`);
}

function printResult(result) {
  if (result.ok) {
    console.log(`PASS ${result.name} (${result.durationMs}ms)`);
    console.log(`     ${result.successLine}`);
    if (result.sandboxFallback) {
      console.log('     note: --no-sandbox was required by this environment (harness only)');
    }
    if (result.appImageFallback) {
      console.log('     note: AppImage runtime hung; ran the --appimage-extract output instead');
    }
    return;
  }

  console.error(`FAIL ${result.name} (${result.durationMs}ms)`);
  console.error(`     ${result.detail}`);
  if (result.artifact) console.error(`     artifact: ${result.artifact}`);
  console.error(`     log: ${result.logPath}`);

  const output = `${result.run?.stdout ?? ''}\n${result.run?.stderr ?? ''}`.trim();
  if (output) {
    const tail = output.split(/\r?\n/).slice(-30).join('\n');
    console.error('     last output:');
    for (const line of tail.split('\n')) console.error(`       ${line}`);
  }
}

async function main() {
  const targets = [];

  const wantAppImage = options.appimage || options.linux;
  const wantDeb = options.deb || options.linux;
  const wantUnpacked = options.unpacked;
  const wantPortable = options.portable || options.win;
  const wantInstaller = options.installer || options.win;

  if (wantAppImage) {
    targets.push({
      name: 'appimage',
      async run(context) {
        const artifact = await findAppImage();
        if (!artifact)
          throw new Error(`No .AppImage found in ${releaseDir}. Run npm run package:linux.`);

        // Preferred path: let the AppImage runtime extract and run itself
        // without FUSE. Some runtime/container combinations hang before they
        // launch the app, so fall back to the runtime's own --appimage-extract
        // when the probe produced no output at all.
        const direct = await runLinuxSelfTest({
          artifact,
          command: artifact,
          extraEnv: { APPIMAGE_EXTRACT_AND_RUN: '1' },
          timeoutMs: Math.min(options.timeoutMs, 20_000),
        });
        if (direct.ok) return direct;

        const directOutput = `${direct.run?.stdout ?? ''}${direct.run?.stderr ?? ''}`.trim();
        if (!direct.run?.timedOut || directOutput !== '') return direct;

        const appRun = await extractAppImage(artifact, join(context.tempRoot, 'appimage'));
        const fallback = await runLinuxSelfTest({
          artifact,
          command: appRun,
          extraEnv: { APPIMAGE_EXTRACT_AND_RUN: '1' },
        });

        return {
          ...fallback,
          appImageFallback: true,
          detail: fallback.ok
            ? `${fallback.detail} (AppImage runtime hung; ran --appimage-extract output)`
            : `${fallback.detail} (after --appimage-extract fallback)`,
        };
      },
    });
  }

  if (wantDeb) {
    targets.push({
      name: 'deb',
      async run(context) {
        const artifact = await findDeb();
        if (!artifact)
          throw new Error(`No .deb found in ${releaseDir}. Run npm run package:linux.`);

        const extractDir = join(context.tempRoot, 'extract');
        await extractDeb(artifact, extractDir);
        const executable = await findDebExecutable(extractDir);
        if (!executable)
          throw new Error(`No executable found in the extracted .deb at ${extractDir}`);

        return runLinuxSelfTest({
          artifact,
          command: executable,
        });
      },
    });
  }

  if (wantUnpacked) {
    targets.push({
      name: 'unpacked',
      async run() {
        const executable = await findUnpackedExecutable();
        if (!executable) {
          throw new Error(
            `No executable found under ${join(releaseDir, 'linux-unpacked')}. Run npm run package:linux.`,
          );
        }
        return runLinuxSelfTest({
          artifact: executable,
          command: executable,
        });
      },
    });
  }

  if (wantPortable) {
    targets.push({
      name: 'portable',
      async run() {
        const artifacts = await findWindowsArtifacts();
        if (!artifacts.portable) {
          throw new Error(`No portable .exe found in ${releaseDir}. Run npm run package:win.`);
        }
        return runWindowsSelfTest({
          name: 'portable',
          artifact: artifacts.portable,
          executable: artifacts.portable,
        });
      },
    });
  }

  if (wantInstaller) {
    targets.push({
      name: 'installer',
      async run(context) {
        const artifacts = await findWindowsArtifacts();
        if (!artifacts.installer) {
          throw new Error(
            `No NSIS installer .exe found in ${releaseDir}. Run npm run package:win.`,
          );
        }
        return runWindowsInstaller(context, artifacts.installer);
      },
    });
  }

  if (targets.length === 0) {
    console.error('No smoke targets selected.');
    process.exit(2);
  }

  console.log(`Packaged smoke targets: ${targets.map((target) => target.name).join(', ')}`);
  console.log(`ROM: ${options.noRom ? '(none)' : romPath}`);
  console.log(`Timeout: ${options.timeoutMs}ms per target\n`);

  const results = [];
  for (const target of targets) {
    console.log(`Running ${target.name}...`);
    results.push(await runTarget(target));
    printResult(results[results.length - 1]);
    console.log('');
  }

  const failed = results.filter((result) => !result.ok);
  console.log('Summary:');
  for (const result of results) {
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'} ${result.name} (${result.durationMs}ms)`);
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${results.length} target(s) failed.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll ${results.length} target(s) passed.`);
}

main().catch((error) => {
  console.error(`Packaged smoke harness failed: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
