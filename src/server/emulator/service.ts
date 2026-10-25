import { basename, extname } from 'node:path';
import { EmulatorController, GB_FPS, ResamplingMediaSink, type RomInfo } from 'node-mgba';
import type WebSocket from 'ws';
import {
  AUDIO_TARGET_SAMPLE_RATE,
  createStoppedEmulatorStatus,
  type EmulatorRomStatus,
  type EmulatorStatus,
} from '../../shared/emulator-status';
import type { Logger } from '../logger';
import { MediaHub } from './media-hub';

export type EmulatorStatusListener = (status: EmulatorStatus) => void;

function toRomStatus(info: RomInfo, romPath: string): EmulatorRomStatus {
  const isGba = info.platform === 'GBA';
  return {
    title: info.title.trim() || basename(romPath, extname(romPath)),
    model: info.model,
    platform: info.platform,
    width: isGba ? 240 : 160,
    height: isGba ? 160 : 144,
  };
}

function sanitizeError(error: unknown, romPath: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(romPath).join('<rom>').slice(0, 500) || 'Emulator failed to start';
}

/**
 * Owns the node-mgba controller and exposes a browser-safe status snapshot.
 * Media always flows through the hub's binary protocol; node-mgba's own
 * WebSocket sink is deliberately not used.
 */
export class EmulatorService {
  private readonly logger: Logger;
  private readonly hub: MediaHub;
  private readonly listeners = new Set<EmulatorStatusListener>();
  private controller: EmulatorController | null = null;
  private lifecycle = createStoppedEmulatorStatus();
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;

  constructor(logger: Logger) {
    this.logger = logger;
    this.hub = new MediaHub(logger);
  }

  status(): EmulatorStatus {
    return {
      ...this.lifecycle,
      fps: this.lifecycle.status === 'running' && this.controller ? this.controller.currentFps : 0,
      videoFrames: this.hub.videoFrames,
      audioChunks: this.hub.audioChunks,
      audioSampleRate: this.hub.audioSampleRate,
      droppedVideoFrames: this.hub.droppedVideoFrames,
      droppedAudioChunks: this.hub.droppedAudioChunks,
    };
  }

  attachClient(socket: WebSocket): void {
    this.hub.attachClient(socket);
  }

  onStatusChange(listener: EmulatorStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(romPath: string): Promise<void> {
    if (this.closing) return;
    if (this.startPromise) return this.startPromise;
    if (this.controller) return;

    this.hub.resetCounters();
    this.lifecycle = { ...createStoppedEmulatorStatus(), status: 'starting' };
    this.publish();

    const promise = this.startInternal(romPath);
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    const pending = this.startPromise;
    if (pending) await pending.catch(() => {});
    await this.stopInternal();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closing = true;
    this.closePromise = (async () => {
      const pending = this.startPromise;
      if (pending) await pending.catch(() => {});
      await this.stopInternal();
    })();

    return this.closePromise;
  }

  private async startInternal(romPath: string): Promise<void> {
    let controller: EmulatorController | undefined;

    try {
      controller = new EmulatorController({
        romPath,
        realtime: true,
        fps: GB_FPS,
        mediaSinks: [
          new ResamplingMediaSink(this.hub, { targetSampleRate: AUDIO_TARGET_SAMPLE_RATE }),
        ],
      });
      this.controller = controller;

      const info = await controller.initialize();

      if (this.closing) {
        this.controller = null;
        await this.closeController(controller);
        this.lifecycle = createStoppedEmulatorStatus();
        return;
      }

      const rom = toRomStatus(info, romPath);
      this.lifecycle = {
        ...createStoppedEmulatorStatus(),
        status: 'running',
        rom,
        audioSampleRate: AUDIO_TARGET_SAMPLE_RATE,
      };
      this.logger.info(
        `emulator running: ${rom.title} (${rom.model}, ${rom.width}x${rom.height}) at ${controller.currentFps.toFixed(4)} fps`,
      );
      this.publish();
    } catch (error) {
      this.controller = null;
      if (controller) await this.closeController(controller);

      const message = sanitizeError(error, romPath);
      this.lifecycle = {
        ...createStoppedEmulatorStatus(),
        status: 'error',
        lastError: message,
      };
      this.logger.error(
        `emulator failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.publish();
    }
  }

  private async stopInternal(): Promise<void> {
    const controller = this.controller;
    this.controller = null;

    if (controller) {
      await this.closeController(controller);
      this.logger.info('emulator stopped');
    }

    this.hub.resetCounters();
    this.lifecycle = createStoppedEmulatorStatus();
    this.publish();
  }

  private async closeController(controller: EmulatorController): Promise<void> {
    try {
      await controller.close();
    } catch (error) {
      this.logger.warn(`failed to close emulator: ${(error as Error).message}`);
    }
  }

  private publish(): void {
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        this.logger.warn(`emulator status listener failed: ${(error as Error).message}`);
      }
    }
  }
}
