/** Browser-safe emulator status contract shared by the server, UI, and tests. */

export const AUDIO_TARGET_SAMPLE_RATE = 48_000;

export type EmulatorLifecycleStatus = 'stopped' | 'starting' | 'running' | 'error';
export type EmulatorModel = 'DMG' | 'CGB' | 'AGB' | 'SGB';
export type EmulatorPlatform = 'GB/GBC' | 'GBA';

export interface EmulatorRomStatus {
  title: string;
  model: EmulatorModel;
  platform: EmulatorPlatform;
  width: number;
  height: number;
}

export interface EmulatorStatus {
  status: EmulatorLifecycleStatus;
  rom: EmulatorRomStatus | null;
  fps: number;
  videoFrames: number;
  audioChunks: number;
  audioSampleRate: number;
  droppedVideoFrames: number;
  droppedAudioChunks: number;
  lastError: string | null;
}

export function createStoppedEmulatorStatus(): EmulatorStatus {
  return {
    status: 'stopped',
    rom: null,
    fps: 0,
    videoFrames: 0,
    audioChunks: 0,
    audioSampleRate: AUDIO_TARGET_SAMPLE_RATE,
    droppedVideoFrames: 0,
    droppedAudioChunks: 0,
    lastError: null,
  };
}
