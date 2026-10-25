import { clampAudioVolume, DEFAULT_AUDIO_CONTROL, type AudioControl } from '../../shared/audio';
import type { Logger } from '../logger';

export type AudioControlListener = (control: AudioControl) => void;

export interface AudioControlUpdate {
  muted?: boolean;
  volume?: number;
}

/**
 * Owns the single stream-audio control shared by every overlay client. The
 * dashboard changes it; OBS browser sources and the capture window apply it.
 */
export class AudioService {
  private readonly logger: Logger;
  private readonly listeners = new Set<AudioControlListener>();
  private control: AudioControl = { ...DEFAULT_AUDIO_CONTROL };

  constructor(logger: Logger) {
    this.logger = logger;
  }

  getState(): AudioControl {
    return { ...this.control };
  }

  update(update: AudioControlUpdate): AudioControl {
    this.control = {
      muted: update.muted ?? this.control.muted,
      volume: update.volume === undefined ? this.control.volume : clampAudioVolume(update.volume),
    };

    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.warn(`audio control listener failed: ${(error as Error).message}`);
      }
    }
    return snapshot;
  }

  subscribe(listener: AudioControlListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
