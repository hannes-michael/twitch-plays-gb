import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

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
  return new Promise((resolve, reject) => {
    const child = spawnPrefixed(name, command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${name} exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}`,
        ),
      );
    });
  });
}

export async function buildDesktop() {
  await runCommand('build', npmExecutable(), ['run', 'build:desktop'], {
    // npm.cmd needs cmd.exe on Windows. The arguments here are fixed literals.
    shell: process.platform === 'win32',
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
