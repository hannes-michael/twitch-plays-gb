/**
 * Browser-safe input contracts shared by the server, UI, and tests.
 *
 * The queue and recent lists are bounded server-side; consumers must still
 * treat them as read-only snapshots.
 */

export type InputMode = 'anarchy' | 'democracy';

export type InputButton =
  'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'A' | 'B' | 'START' | 'SELECT' | 'L' | 'R';

export const INPUT_BUTTONS: readonly InputButton[] = [
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'A',
  'B',
  'START',
  'SELECT',
  'L',
  'R',
];

export type InputDropReason =
  'cooldown' | 'rate-limit' | 'queue-full' | 'stale' | 'invalid' | 'emulator-error';

export type InputEventStatus = 'queued' | 'executing' | 'done' | 'dropped';

export interface InputEvent {
  id: string;
  user: string;
  button: InputButton;
  source: 'chat' | 'local';
  receivedAt: string;
  queuedAt: string;
  status: InputEventStatus;
  dropReason?: InputDropReason;
  executedAt?: string;
}

export interface InputStats {
  accepted: number;
  executed: number;
  dropped: number;
  cooldownDrops: number;
  rateLimitDrops: number;
  queueFullDrops: number;
  staleDrops: number;
}

export interface InputLastExecuted {
  button: InputButton;
  user: string;
  at: string;
}

export interface InputLastDrop {
  reason: InputDropReason;
  user: string;
  at: string;
}

export type InputMetaCommand = 'mode' | 'pause' | 'resume' | 'save';

export interface InputLastMeta {
  command: InputMetaCommand;
  user: string;
  allowed: boolean;
  at: string;
}

export interface InputState {
  mode: InputMode;
  paused: boolean;
  queue: InputEvent[];
  recent: InputEvent[];
  stats: InputStats;
  lastExecuted: InputLastExecuted | null;
  lastDrop: InputLastDrop | null;
  lastMeta: InputLastMeta | null;
}

export interface InputStateMessage {
  type: 'input-state';
  input: InputState;
}

export type LocalInputRejection = InputDropReason | 'not-running';

export interface LocalInputResponse {
  accepted: boolean;
  reason?: LocalInputRejection;
  input: InputState;
}
