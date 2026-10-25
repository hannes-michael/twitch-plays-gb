export interface ServerState {
  clients: number;
  emulator: 'stopped';
}

export function createServerState(): ServerState {
  return {
    clients: 0,
    emulator: 'stopped',
  };
}
