import type { ChatMessage, ChatStatus, ChatTimings } from './chat';
import type { EmulatorStatus } from './emulator-status';

/** Browser-safe snapshot returned by the developer-only /api/debug endpoint. */

export type AppMode = 'dev' | 'test' | 'production';

export interface DebugSnapshot {
  mode: AppMode;
  timings: ChatTimings;
  emulator: EmulatorStatus;
  chat: ChatStatus & { recent: ChatMessage[] };
  clients: { total: number };
  media: {
    videoFrames: number;
    audioChunks: number;
    fps: number;
    audioSampleRate: number;
  };
  queue: { length: number; votes: number };
}
