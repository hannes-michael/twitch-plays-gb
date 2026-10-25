import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { EmulatorController, GB_FPS, ResamplingMediaSink, type RomInfo } from 'node-mgba';
import type WebSocket from 'ws';
import { CONFIG_DEFAULTS } from '../../shared/config';
import {
  AUDIO_TARGET_SAMPLE_RATE,
  createStoppedEmulatorStatus,
  type EmulatorRestoreSource,
  type EmulatorRomStatus,
  type EmulatorStatus,
} from '../../shared/emulator-status';
import type { InputButton } from '../../shared/input';
import type { Logger } from '../logger';
import { MediaHub } from './media-hub';

export type EmulatorStatusListener = (status: EmulatorStatus) => void;

export type EmulatorSaveReason =
  'auto' | 'manual' | 'command' | 'stop' | 'restart' | 'rom-change' | 'quit';

type EmulatorStopReason = 'stop' | 'restart' | 'rom-change' | 'quit';

export class EmulatorNotRunningError extends Error {
  constructor() {
    super('Emulator is not running');
    this.name = 'EmulatorNotRunningError';
  }
}

export interface EmulatorStartOptions {
  romPath: string;
  /** Imported ROM id; null for the `--rom` configuration path. */
  romId?: string | null;
  batterySavePath?: string;
  /** Base path for the current state; the previous generation is `<path>.prev`. */
  stateSavePath?: string;
  /** Autosave cadence in milliseconds; 0 or less disables the timer. */
  autosaveIntervalMs?: number;
  /** Set false to boot a fresh session (restart and ROM switches). */
  restoreState?: boolean;
}

interface SaveInfo {
  lastSavedAt: string | null;
  saveCount: number;
  restoredFrom: EmulatorRestoreSource | null;
  lastSaveError: string | null;
  autosaveIntervalMs: number;
}

function createSaveInfo(): SaveInfo {
  return {
    lastSavedAt: null,
    saveCount: 0,
    restoredFrom: null,
    lastSaveError: null,
    autosaveIntervalMs: 0,
  };
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
  return raw.slice(0, 500) || 'Emulator failed';
}

/**
 * Owns the node-mgba controller and exposes a browser-safe status snapshot.
 * Media always flows through the hub's binary protocol; node-mgba's own
 * WebSocket sink is deliberately not used.
 *
 * Start, stop, restart, ROM changes, saves, and input presses share one
 * operation queue so concurrent requests can never race the controller
 * lifecycle. Save states are written through a temp file and rotated to a
 * single previous generation so a crash always leaves one loadable file.
 */
export class EmulatorService {
  private readonly logger: Logger;
  private readonly hub: MediaHub;
  private readonly listeners = new Set<EmulatorStatusListener>();
  private controller: EmulatorController | null = null;
  private lifecycle = createStoppedEmulatorStatus();
  private saveInfo = createSaveInfo();
  private lastSuccessfulStart: EmulatorStartOptions | null = null;
  private lastSessionStatePath: string | null = null;
  private stateSavePath: string | null = null;
  private batterySavePath: string | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private closePromise: Promise<boolean> | null = null;
  private autosaveTimer: NodeJS.Timeout | null = null;
  private pendingSaves = 0;
  private closing = false;

  constructor(logger: Logger) {
    this.logger = logger;
    this.hub = new MediaHub(logger);
  }

  status(): EmulatorStatus {
    return {
      ...this.lifecycle,
      ...this.saveInfo,
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

  stop(): Promise<boolean> {
    if (this.closePromise) return this.closePromise.then(() => false);
    return this.enqueue(() => this.stopInternal('stop'));
  }

  restart(options: EmulatorStartOptions): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.enqueue(async () => {
      await this.stopInternal('restart');
      if (this.closing) return;
      // A restart is a fresh boot. The state saved before closing is the
      // recovery point for a later Start, not a resume target for Restart.
      await this.startInternal(options, false);
    });
  }

  /**
   * Writes a save state. It is serialized with lifecycle operations and input
   * presses, so a save never observes a half-applied input sequence. Returns
   * false when the emulator is stopped or no state path is configured.
   */
  saveState(reason: EmulatorSaveReason = 'manual'): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);

    this.pendingSaves += 1;
    return this.enqueue(async () => {
      try {
        return await this.saveStateInternal(reason);
      } finally {
        this.pendingSaves -= 1;
      }
    });
  }

  /**
   * Presses one button through the same lifecycle queue as start/stop/restart.
   * A stop requested during a press waits for the short input sequence to
   * finish; a press that starts after stop throws instead of touching a closed
   * controller.
   */
  press(button: InputButton, holdFrames: number, releaseFrames: number): Promise<void> {
    return this.enqueue(async () => {
      const controller = this.controller;
      if (this.closing || !controller || this.lifecycle.status !== 'running') {
        throw new EmulatorNotRunningError();
      }

      const handle = controller.pressButtons([{ button, holdFrames, releaseFrames }]);
      await handle.promise;
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise.then(() => undefined);

    this.closing = true;
    const run = this.enqueue(() => this.stopInternal('quit'));
    this.closePromise = run;
    return run.then(() => undefined);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startInternal(
    options: EmulatorStartOptions,
    restoreOverride?: boolean,
  ): Promise<void> {
    if (this.closing) return;

    const romId = options.romId ?? null;
    if (this.controller && this.lifecycle.status === 'running' && this.lifecycle.romId === romId) {
      return;
    }

    const nextStatePath = options.stateSavePath ?? null;
    // Never load another game's state into a newly selected ROM. The first
    // boot and a Start after Stop keep the same path and may restore.
    const stateKeyChanged =
      this.lastSessionStatePath !== null && this.lastSessionStatePath !== nextStatePath;
    const shouldRestore =
      (restoreOverride ?? options.restoreState !== false) &&
      !stateKeyChanged &&
      nextStatePath !== null;

    if (this.controller) await this.stopInternal('rom-change');
    if (this.closing) return;

    this.hub.resetCounters();
    this.stateSavePath = nextStatePath;
    this.batterySavePath = options.batterySavePath ?? null;
    this.saveInfo.restoredFrom = null;
    this.saveInfo.lastSaveError = null;
    this.saveInfo.autosaveIntervalMs =
      options.autosaveIntervalMs ?? CONFIG_DEFAULTS.timings.autosaveIntervalMs;
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

      if (shouldRestore && nextStatePath) {
        await this.restoreStateInternal(controller, nextStatePath);
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
        stateSavePath: options.stateSavePath,
        autosaveIntervalMs: options.autosaveIntervalMs,
        restoreState: options.restoreState,
      };
      this.lastSessionStatePath = nextStatePath;
      this.logger.info(
        `emulator running: ${rom.title} (${rom.model}, ${rom.width}x${rom.height}) at ${controller.currentFps.toFixed(4)} fps`,
      );
      this.startAutosave();
      this.publish();
    } catch (error) {
      this.controller = null;
      if (controller) await this.closeController(controller);
      this.clearAutosave();

      const message = sanitizeError(error, [
        options.romPath,
        options.batterySavePath,
        options.stateSavePath,
      ]);
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

  private async stopInternal(reason: EmulatorStopReason): Promise<boolean> {
    this.clearAutosave();

    const controller = this.controller;
    let saved = false;

    if (controller) {
      if (this.lifecycle.status === 'running') {
        saved = await this.saveStateInternal(reason);
      }
      this.controller = null;
      await this.flushBattery(controller);
      await this.closeController(controller);
      this.logger.info(`emulator stopped (${reason})`);
    }

    this.stateSavePath = null;
    this.batterySavePath = null;
    this.hub.resetCounters();
    this.lifecycle = createStoppedEmulatorStatus();
    this.publish();
    return saved;
  }

  private startAutosave(): void {
    this.clearAutosave();
    const interval = this.saveInfo.autosaveIntervalMs;
    if (!Number.isFinite(interval) || interval <= 0) return;

    this.autosaveTimer = setInterval(() => {
      if (this.closing || this.pendingSaves > 0 || this.lifecycle.status !== 'running') return;
      void this.saveState('auto').catch((error: unknown) => {
        this.logger.warn(
          `autosave failed: ${sanitizeError(error, [this.stateSavePath ?? undefined])}`,
        );
      });
    }, interval);
    this.autosaveTimer.unref();
  }

  private clearAutosave(): void {
    if (!this.autosaveTimer) return;
    clearInterval(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  private async saveStateInternal(reason: EmulatorSaveReason): Promise<boolean> {
    const controller = this.controller;
    const statePath = this.stateSavePath;
    if (!controller || !statePath || this.lifecycle.status !== 'running') return false;

    const temporary = `${statePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const previous = `${statePath}.prev`;

    try {
      await mkdir(dirname(statePath), { recursive: true });
      const written = await controller.saveState(temporary);
      if (!written) throw new Error('emulator did not write a save state');

      const info = await stat(temporary);
      if (info.size === 0) throw new Error('save state file is empty');

      // The current file is only replaced after the new one is complete. A
      // crash between the two renames leaves the previous generation intact.
      await rm(previous, { force: true });
      try {
        await rename(statePath, previous);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(temporary, statePath);

      this.saveInfo.saveCount += 1;
      this.saveInfo.lastSavedAt = new Date().toISOString();
      this.saveInfo.lastSaveError = null;
      this.logger.info(`emulator state saved (${reason})`);
      this.publish();
      return true;
    } catch (error) {
      const message = sanitizeError(error, [
        statePath,
        temporary,
        this.batterySavePath ?? undefined,
      ]);
      this.saveInfo.lastSaveError = message;
      this.logger.warn(`failed to save emulator state (${reason}): ${message}`);
      this.publish();
      return false;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async restoreStateInternal(
    controller: EmulatorController,
    statePath: string,
  ): Promise<EmulatorRestoreSource | null> {
    const candidates: Array<{ source: EmulatorRestoreSource; path: string }> = [
      { source: 'current', path: statePath },
      { source: 'previous', path: `${statePath}.prev` },
    ];

    for (const candidate of candidates) {
      let modifiedAt: Date;
      try {
        const info = await stat(candidate.path);
        if (info.size === 0) {
          this.logger.debug(`ignoring empty ${candidate.source} save state`);
          continue;
        }
        modifiedAt = info.mtime;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.logger.debug(`no ${candidate.source} save state found`);
          continue;
        }
        this.logger.warn(
          `could not inspect ${candidate.source} save state: ${sanitizeError(error, [candidate.path])}`,
        );
        continue;
      }

      try {
        const loaded = await controller.loadState(candidate.path);
        if (!loaded) {
          this.logger.warn(`could not load ${candidate.source} save state; trying the next one`);
          continue;
        }

        this.saveInfo.restoredFrom = candidate.source;
        this.saveInfo.lastSavedAt = modifiedAt.toISOString();
        this.logger.info(`restored emulator state (${candidate.source})`);
        return candidate.source;
      } catch (error) {
        this.logger.warn(
          `could not load ${candidate.source} save state: ${sanitizeError(error, [candidate.path])}`,
        );
      }
    }

    this.logger.info('no valid save state found; starting a fresh session');
    return null;
  }

  /**
   * P1-04: flush battery-backed SRAM before closing the worker. Fixture ROMs
   * without battery RAM report false and write no file; that is expected.
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
