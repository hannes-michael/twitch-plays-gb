import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { loadConfig } from '../../../src/shared/config';
import { startServer } from '../../fixtures/server';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const serverEntry = join(repoRoot, 'src', 'server', 'index.ts');

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('TPG_') || key === 'HOST' || key === 'PORT') delete env[key];
  }
  return { ...env, FORCE_COLOR: '0', ...extra };
}

function runCli(args: string[], env: NodeJS.ProcessEnv = cleanEnv()) {
  return spawnSync(process.execPath, ['--import', 'tsx', serverEntry, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

test.describe('server CLI', () => {
  test('--help exits 0 and documents the supported options', () => {
    const result = runCli(['--help']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage:');
    for (const option of ['--port', '--config', '--data-dir', '--dev']) {
      expect(result.stdout).toContain(option);
    }
    expect(result.stdout).toMatch(/--port[^\n]*0/);
  });

  test('reports unknown options instead of asking for a value', () => {
    const result = runCli(['--bogus']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option: --bogus');
    expect(result.stderr).not.toContain('Missing value');
  });

  test('reports negative port range errors instead of missing values', () => {
    const result = runCli(['--port', '-1']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected an integer between 0 and 65535');
    expect(result.stderr).toContain('"-1"');
    expect(result.stderr).not.toContain('Missing value');
  });

  test('test mode requires an explicit data directory', () => {
    const xdgDataHome = mkdtempSync(join(tmpdir(), 'tpg-cli-xdg-'));

    try {
      const result = runCli(
        ['--port', '0'],
        cleanEnv({ TPG_TEST: '1', XDG_DATA_HOME: xdgDataHome }),
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Test mode requires an explicit data directory');
    } finally {
      rmSync(xdgDataHome, { recursive: true, force: true });
    }
  });

  test('development mode defaults to the repository data/dev directory', () => {
    const config = loadConfig({ argv: [], env: { TPG_DEV: '1' } });

    expect(config.dev).toBe(true);
    expect(config.test).toBe(false);
    expect(config.dataDir).toBe(resolve(repoRoot, 'data', 'dev'));
  });

  test('rejects missing explicit config paths via CLI and TPG_CONFIG', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tpg-cli-'));
    const missingConfig = join(dataDir, 'missing-config.json');

    try {
      // The invalid host keeps the current broken build from binding and
      // hanging during the red run; the config error should win after the fix.
      const viaCli = runCli([
        '--data-dir',
        dataDir,
        '--config',
        missingConfig,
        '--host',
        '192.0.2.1',
        '--port',
        '0',
      ]);
      const viaEnv = runCli(
        ['--data-dir', dataDir, '--host', '192.0.2.1', '--port', '0'],
        cleanEnv({ TPG_CONFIG: missingConfig }),
      );

      for (const result of [viaCli, viaEnv]) {
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Config file not found');
        expect(result.stderr).toContain(missingConfig);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test.describe('server fixture', () => {
  test('ignores inherited TPG_* configuration', async () => {
    const previousConfig = process.env.TPG_CONFIG;
    process.env.TPG_CONFIG = '/this/path/does/not/exist.json';

    try {
      const server = await startServer();
      try {
        const health = await fetch(`${server.baseURL}/health`);
        expect(health.status).toBe(200);
      } finally {
        await server.stop();
      }
    } finally {
      if (previousConfig === undefined) delete process.env.TPG_CONFIG;
      else process.env.TPG_CONFIG = previousConfig;
    }
  });

  test('fails teardown when the server exits unexpectedly with code 0', async () => {
    const server = await startServer();
    const pid = server.pid;
    if (pid === undefined) throw new Error('Server pid was not exposed.');

    process.kill(pid, 'SIGTERM');
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return 'running';
        } catch {
          return 'exited';
        }
      })
      .toBe('exited');

    const error = await server.stop().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Server exited unexpectedly');
    if (process.platform !== 'win32') {
      expect((error as Error).message).toContain('code 0');
    }
  });

  test('parses short chat timings from the environment into debug output', async () => {
    const server = await startServer({
      env: {
        TPG_DEMOCRACY_WINDOW_MS: '750',
        TPG_HOLD_FRAMES: '2',
        TPG_RELEASE_FRAMES: '1',
      },
    });

    try {
      const response = await fetch(`${server.baseURL}/api/debug`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        timings: { democracyWindowMs: 750, holdFrames: 2, releaseFrames: 1 },
      });
    } finally {
      await server.stop();
    }
  });

  test('fails teardown when SIGKILL escalation is required', async () => {
    test.skip(process.platform !== 'linux', 'procfs stopped-state check is Linux-only');

    const server = await startServer({ shutdownTimeoutMs: 100 });
    const pid = server.pid;
    if (pid === undefined) throw new Error('Server pid was not exposed.');

    process.kill(pid, 'SIGSTOP');
    await expect
      .poll(() => {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const end = stat.lastIndexOf(')');
        return stat.slice(end + 2).split(' ')[0];
      })
      .toBe('T');

    const error = await server.stop().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('SIGKILL');
  });
});
