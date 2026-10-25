import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { createElectronEnv, expect, test } from '../../fixtures/server';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const romPath = fileURLToPath(new URL('../../fixtures/roms/test_gb.gb', import.meta.url));

interface EmulatorStatus {
  status: string;
  rom: {
    title: string;
    model: string;
    platform: string;
    width: number;
    height: number;
  } | null;
  audioSampleRate: number;
  videoFrames: number;
  audioChunks: number;
}

function readServerPid(logs: string): number | undefined {
  const ready = /\[desktop\] server child ready at \S+ \(pid (\d+)\)/.exec(logs);
  if (ready) return Number(ready[1]);

  const started = /\[desktop\] server child started \(pid (\d+)\)/.exec(logs);
  return started ? Number(started[1]) : undefined;
}

function readServerUrl(logs: string): string | undefined {
  return /\[desktop\] server child ready at (http:\/\/\S+)/.exec(logs)?.[1];
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.describe('electron server child', () => {
  test.beforeAll(() => {
    // This scenario exercises the real built server, web bundle, and desktop
    // entrypoint. Always rebuild so the test cannot pass against stale output.
    execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });
  });

  test('spawns the server, boots node-mgba in a worker, and stops the child on quit', async ({
    playwright: _playwright,
  }, testInfo) => {
    test.setTimeout(120_000);

    const dataDir = await mkdtemp(join(tmpdir(), 'tpg-electron-child-'));
    let app: ElectronApplication | undefined;
    let electronLogs = '';
    let serverPid: number | undefined;

    const collectLogs = (chunk: Buffer | string): void => {
      electronLogs += chunk.toString();
      if (electronLogs.length > 200_000) electronLogs = electronLogs.slice(-200_000);
    };

    try {
      app = await electron.launch({
        args: [
          ...(process.env.CI ? ['--no-sandbox'] : []),
          `--user-data-dir=${join(dataDir, 'electron-profile')}`,
          repoRoot,
        ],
        env: createElectronEnv({
          TPG_DEV: '0',
          TPG_TEST: '0',
          TPG_DATA_DIR: dataDir,
          TPG_ROM: romPath,
          TPG_LOG_LEVEL: 'debug',
        }),
      });

      const electronProcess = app.process();
      electronProcess.stdout?.on('data', collectLogs);
      electronProcess.stderr?.on('data', collectLogs);

      await expect
        .poll(() => readServerPid(electronLogs) !== undefined, { timeout: 30_000 })
        .toBe(true);
      serverPid = readServerPid(electronLogs);
      expect(serverPid).toBeGreaterThan(0);

      await expect
        .poll(() => readServerUrl(electronLogs) !== undefined, { timeout: 20_000 })
        .toBe(true);
      const spawnedUrl = readServerUrl(electronLogs);
      expect(spawnedUrl).toBeDefined();

      const page = await app.firstWindow();
      await expect(page).toHaveTitle('Twitch Plays GB');
      await expect(page.getByRole('heading', { name: 'First-run setup' })).toBeVisible();
      await expect(page.getByTestId('server-status-label')).toHaveText('online');

      // Same-origin fetches prove the renderer is talking to the spawned child,
      // not a separately started server.
      expect(new URL(page.url()).origin).toBe(new URL(spawnedUrl as string).origin);

      const readStatus = async (): Promise<EmulatorStatus> =>
        page.evaluate(async () => {
          const response = await fetch('/api/emulator/status');
          if (!response.ok) throw new Error(`status endpoint returned HTTP ${response.status}`);
          return (await response.json()) as EmulatorStatus;
        });

      await expect
        .poll(async () => (await readStatus()).status, { timeout: 30_000 })
        .toBe('running');
      await expect
        .poll(async () => (await readStatus()).videoFrames, { timeout: 30_000 })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => (await readStatus()).audioChunks, { timeout: 30_000 })
        .toBeGreaterThan(0);

      const status = await readStatus();
      expect(status).toMatchObject({
        status: 'running',
        rom: {
          model: 'DMG',
          platform: 'GB/GBC',
          width: 160,
          height: 144,
        },
        audioSampleRate: 48_000,
      });
      expect(status.rom?.title).toEqual(expect.any(String));

      const health = await page.evaluate(async () => {
        const response = await fetch('/health');
        return { ok: response.ok, body: (await response.json()) as unknown };
      });
      expect(health.ok).toBe(true);
      expect(health.body).toMatchObject({ status: 'ok', emulator: 'running' });

      // The child's prefixed logs prove native module loading and worker
      // threads succeeded under ELECTRON_RUN_AS_NODE.
      expect(electronLogs).toContain('[server] TPG_URL=');
      expect(electronLogs).toContain('emulator running:');

      await app.close();
      app = undefined;

      await expect
        .poll(() => isProcessRunning(serverPid as number), { timeout: 10_000 })
        .toBe(false);

      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      expect(existsSync(dataDir)).toBe(false);
    } catch (error) {
      await testInfo.attach('electron-server-child-logs', {
        body: electronLogs || '(no Electron output captured)',
        contentType: 'text/plain',
      });
      throw error;
    } finally {
      await app?.close().catch(() => {});
      if (serverPid !== undefined && isProcessRunning(serverPid)) {
        try {
          process.kill(serverPid, 'SIGKILL');
        } catch {
          // The process exited between the check and the signal.
        }
      }
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  });
});
