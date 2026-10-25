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

export interface EmulatorStartOptions {
  romPath: string;
  /** Imported ROM id; null for the `--rom` configuration path. */
  romId?: string | null;
  batterySavePath?: string;
}

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

function sanitizeError(error: unknown, paths: readonly (string | undefined)[]): string {
  let raw = error instanceof Error ? error.message : String(error);
  for (const path of paths) {
    if (path) raw = raw.split(path).join('<path>');
  }
  return raw.slice(0, 500) || 'Emulator failed to start';
}

/**
 * Owns the node-mgba controller and exposes a browser-safe status snapshot.
 * Media always flows through the hub's binary protocol; node-mgba's own
 * WebSocket sink is deliberately not used.
 *
 * Start, stop, restart, and ROM changes share one operation queue so concurrent
 * HTTP requests can never race the controller lifecycle.
 */
export class EmulatorService {
  private readonly logger: Logger;
  private readonly hub: MediaHub;
  private readonly listeners = new Set<EmulatorStatusListener>();
  private controller: EmulatorController | null = null;
  private lifecycle = createStoppedEmulatorStatus();
  private lastSuccessfulStart: EmulatorStartOptions | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
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

  /** Server-internal options for reusing the last successful explicit session. */
  getLastStartOptions(): EmulatorStartOptions | null {
    return this.lastSuccessfulStart ? { ...this.lastSuccessfulStart } : null;
  }

  start(options: EmulatorStartOptions): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.enqueue(() => this.startInternal(options));
  }

  stop(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    return this.enqueue(() => this.stopInternal());
  }

  restart(options: EmulatorStartOptions): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.enqueue(async () => {
      await this.stopInternal();
      if (this.closing) return;
      await this.startInternal(options);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closing = true;
    this.closePromise = this.enqueue(() => this.stopInternal());
    return this.closePromise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startInternal(options: EmulatorStartOptions): Promise<void> {
    if (this.closing) return;

    const romId = options.romId ?? null;
    if (this.controller && this.lifecycle.status === 'running' && this.lifecycle.romId === romId) {
      return;
    }

    if (this.controller) await this.stopInternal();
    if (this.closing) return;

    this.hub.resetCounters();
    this.lifecycle = { ...createStoppedEmulatorStatus(), status: 'starting', romId };
    this.publish();

    let controller: EmulatorController | undefined;

    try {
      controller = new EmulatorController({
        romPath: options.romPath,
        realtime: true,
        fps: GB_FPS,
        ...(options.batterySavePath
          ? { batterySavePath: options.batterySavePath, autoFlushBatteryOnSave: true }
          : {}),
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
        this.publish();
        return;
      }

      const rom = toRomStatus(info, options.romPath);
      this.lifecycle = {
        ...createStoppedEmulatorStatus(),
        status: 'running',
        romId,
        rom,
        audioSampleRate: AUDIO_TARGET_SAMPLE_RATE,
      };
      this.lastSuccessfulStart = {
        romPath: options.romPath,
        romId,
        batterySavePath: options.batterySavePath,
      };
      this.logger.info(
        `emulator running: ${rom.title} (${rom.model}, ${rom.width}x${rom.height}) at ${controller.currentFps.toFixed(4)} fps`,
      );
      this.publish();
    } catch (error) {
      this.controller = null;
      if (controller) await this.closeController(controller);

      const message = sanitizeError(error, [options.romPath, options.batterySavePath]);
      this.lifecycle = {
        ...createStoppedEmulatorStatus(),
        status: 'error',
        romId,
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
      await this.flushBattery(controller);
      await this.closeController(controller);
      this.logger.info('emulator stopped');
    }

    this.hub.resetCounters();
    this.lifecycle = createStoppedEmulatorStatus();
    this.publish();
  }

  /**
   * P1-04 partial: flush battery-backed SRAM before closing the worker. Fixture
   * ROMs without battery RAM report false and write no file; that is expected.
   */
  private async flushBattery(controller: EmulatorController): Promise<void> {
    const path = controller.batterySavePath;
    if (!path) return;

    try {
      const saved = await controller.saveBatteryFile(path);
      if (saved) {
        this.logger.info('battery save written');
      } else {
        this.logger.debug('battery save skipped (cartridge has no battery-backed SRAM)');
      }
    } catch (error) {
      this.logger.warn(`failed to save battery: ${(error as Error).message}`);
    }
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
