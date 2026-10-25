/** Browser-safe stream-audio control shared by the server, UI, and tests. */

export interface AudioControl {
  muted: boolean;
  /** Effective playback volume from 0 to 1; ignored while muted. */
  volume: number;
}

export const AUDIO_VOLUME_MIN = 0;
export const AUDIO_VOLUME_MAX = 1;

/**
 * Streams start audible. Electron allows autoplay for the capture window, and
 * OBS can grant the same permission to a browser source. Clients that block
 * audio until a gesture retry on the first click.
 */
export const DEFAULT_AUDIO_CONTROL: AudioControl = {
  muted: false,
  volume: 1,
};

export function clampAudioVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUDIO_CONTROL.volume;
  return Math.min(AUDIO_VOLUME_MAX, Math.max(AUDIO_VOLUME_MIN, value));
}

export interface AudioStateMessage {
  type: 'audio-state';
  audio: AudioControl;
}
