import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
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
});
