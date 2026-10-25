import type { EmulatorLifecycleStatus } from '../shared/emulator-status';

export interface ServerState {
  clients: number;
  emulator: EmulatorLifecycleStatus;
}

export function createServerState(): ServerState {
  return {
    clients: 0,
    emulator: 'stopped',
  };
}
