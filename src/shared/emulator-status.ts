/** Browser-safe emulator status contract shared by the server, UI, and tests. */

export const AUDIO_TARGET_SAMPLE_RATE = 48_000;

export type EmulatorLifecycleStatus = 'stopped' | 'starting' | 'running' | 'error';
export type EmulatorModel = 'DMG' | 'CGB' | 'AGB' | 'SGB';
export type EmulatorPlatform = 'GB/GBC' | 'GBA';
export type EmulatorRestoreSource = 'current' | 'previous';

export interface EmulatorRomStatus {
  title: string;
  model: EmulatorModel;
  platform: EmulatorPlatform;
  width: number;
  height: number;
}

export interface EmulatorStatus {
  status: EmulatorLifecycleStatus;
  romId: string | null;
  rom: EmulatorRomStatus | null;
  fps: number;
  videoFrames: number;
  audioChunks: number;
  audioSampleRate: number;
  droppedVideoFrames: number;
  droppedAudioChunks: number;
  lastError: string | null;
  lastSavedAt: string | null;
  saveCount: number;
  restoredFrom: EmulatorRestoreSource | null;
  lastSaveError: string | null;
  autosaveIntervalMs: number;
}

export interface EmulatorSaveResponse {
  saved: boolean;
  status: EmulatorStatus;
}

export function createStoppedEmulatorStatus(): EmulatorStatus {
  return {
    status: 'stopped',
    romId: null,
    rom: null,
    fps: 0,
    videoFrames: 0,
    audioChunks: 0,
    audioSampleRate: AUDIO_TARGET_SAMPLE_RATE,
    droppedVideoFrames: 0,
    droppedAudioChunks: 0,
    lastError: null,
    lastSavedAt: null,
    saveCount: 0,
    restoredFrom: null,
    lastSaveError: null,
    autosaveIntervalMs: 0,
  };
}
