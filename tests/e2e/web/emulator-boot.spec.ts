import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, startServer, test } from '../../fixtures/server';

const romDir = fileURLToPath(new URL('../../fixtures/roms/', import.meta.url));

interface EmulatorStatus {
  status: string;
  rom: {
    title: string;
    model: string;
    platform: string;
    width: number;
    height: number;
  } | null;
  fps: number;
  videoFrames: number;
  audioChunks: number;
  audioSampleRate: number;
  droppedVideoFrames: number;
  droppedAudioChunks: number;
  lastError: string | null;
}

const consoles = [
  { file: 'test_gb.gb', model: 'DMG', platform: 'GB/GBC', width: 160, height: 144 },
  { file: 'test_gbc.gbc', model: 'CGB', platform: 'GB/GBC', width: 160, height: 144 },
  { file: 'test_gba.gba', model: 'AGB', platform: 'GBA', width: 240, height: 160 },
] as const;

test.describe('emulator boot', () => {
  test('boots the vendored GB, GBC, and GBA ROMs with video and audio', async () => {
    test.setTimeout(120_000);

    for (const console of consoles) {
      const romPath = join(romDir, console.file);
      const server = await startServer({ rom: romPath });

      try {
        const statusURL = `${server.baseURL}/api/emulator/status`;
        const readStatus = async (): Promise<EmulatorStatus> => {
          const response = await fetch(statusURL);
          expect(response.status, await response.clone().text()).toBe(200);
          return (await response.json()) as EmulatorStatus;
        };

        await expect
          .poll(async () => (await readStatus()).status, { timeout: 20_000 })
          .toBe('running');

        await expect
          .poll(async () => (await readStatus()).videoFrames, { timeout: 20_000 })
          .toBeGreaterThan(0);
        await expect
          .poll(async () => (await readStatus()).audioChunks, { timeout: 20_000 })
          .toBeGreaterThan(0);

        const status = await readStatus();
        expect(status).toMatchObject({
          status: 'running',
          rom: {
            model: console.model,
            platform: console.platform,
            width: console.width,
            height: console.height,
          },
          audioSampleRate: 48_000,
        });
        expect(status.rom?.title).toEqual(expect.any(String));
        expect(status.fps).toBeGreaterThan(59);
        expect(status.videoFrames).toBeGreaterThan(0);
        expect(status.audioChunks).toBeGreaterThan(0);
        expect(status.droppedVideoFrames).toEqual(expect.any(Number));
        expect(status.droppedAudioChunks).toEqual(expect.any(Number));
        expect(status.lastError).toBeNull();
        expect(JSON.stringify(status)).not.toContain(romPath);

        const healthResponse = await fetch(`${server.baseURL}/health`);
        expect(healthResponse.status).toBe(200);
        const health = (await healthResponse.json()) as { emulator: string };
        expect(health.emulator).toBe('running');
      } finally {
        await server.stop();
      }
    }
  });
});
