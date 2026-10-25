import { contextBridge } from 'electron';

/**
 * The only surface the renderer gets from the desktop shell. Keep it free of
 * Node APIs: the dashboard talks to the local server over HTTP/WebSocket.
 */
export interface TpgDesktopBridge {
  readonly apiVersion: 1;
  readonly platform: string;
  readonly electronVersion: string;
}

const bridge: TpgDesktopBridge = Object.freeze({
  apiVersion: 1,
  platform: process.platform,
  electronVersion: process.versions.electron ?? 'unknown',
});

contextBridge.exposeInMainWorld('tpg', bridge);
