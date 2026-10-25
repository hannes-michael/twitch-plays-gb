import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const liveChildren = new Set();

export function liveChildProcesses() {
  return [...liveChildren];
}

export function electronExecutable() {
  return require('electron');
}

export function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function prefixStream(stream, prefix, onLine) {
  if (!stream) return;

  let partial = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? '';

    for (const line of lines) {
      console.log(`[${prefix}] ${line}`);
      onLine?.(line);
    }
  });
  stream.on('end', () => {
    if (partial === '') return;
    console.log(`[${prefix}] ${partial}`);
    onLine?.(partial);
    partial = '';
  });
}

export function spawnPrefixed(name, command, args, options = {}) {
  const { onLine, ...spawnOptions } = options;
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    ...spawnOptions,
  });

  prefixStream(child.stdout, name, onLine);
  prefixStream(child.stderr, name, onLine);
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  child.once('error', () => liveChildren.delete(child));
  return child;
}

export function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);

    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }

    child.once('exit', onExit);
  });
}

export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

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

export function runCommand(name, command, args, options = {}) {
  const { timeoutMs = 0, signal, ...spawnOptions } = options;

  return new Promise((resolve, reject) => {
    const child = spawnPrefixed(name, command, args, spawnOptions);
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutTimer;
    let forceKillTimer;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killTree(child, 'SIGTERM');
      // A build that ignores SIGTERM must not keep the dev command alive.
      forceKillTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2_000);
      forceKillTimer.unref?.();
    };

    function onAbort() {
      if (settled) return;
      aborted = true;
      terminate();
    }

    child.once('error', (error) => {
      finish(error);
    });
    child.once('exit', (code, exitSignal) => {
      if (timedOut) {
        finish(new Error(`${name} timed out after ${timeoutMs}ms`));
        return;
      }
      if (aborted) {
        finish(new Error(`${name} was aborted`));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `${name} exited ${exitSignal ? `with signal ${exitSignal}` : `with code ${code ?? 'unknown'}`}`,
        ),
      );
    });

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }
  });
}

export async function buildDesktop({ timeoutMs = 120_000, signal } = {}) {
  await runCommand('build', npmExecutable(), ['run', 'build:desktop'], {
    // npm.cmd needs cmd.exe on Windows. The arguments here are fixed literals.
    shell: process.platform === 'win32',
    timeoutMs,
    signal,
  });
}

export async function fetchHealth(serverUrl, timeoutMs = 2_000) {
  const response = await fetch(new URL('/health', serverUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`health check returned HTTP ${response.status}`);
  }

  const body = await response.json();
  if (typeof body !== 'object' || body === null || body.status !== 'ok') {
    throw new Error(`unexpected health payload: ${JSON.stringify(body)}`);
  }
  return body;
}

export function spawnElectron(name, serverUrl, extraArgs = [], env = {}) {
  return spawnPrefixed(name, electronExecutable(), [...extraArgs, repoRoot], {
    env: { ...process.env, TPG_SERVER_URL: serverUrl, ...env },
  });
}
