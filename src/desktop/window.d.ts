import type { TpgDesktopBridge } from './preload';

declare global {
  interface Window {
    readonly tpg?: TpgDesktopBridge;
  }
}

export {};
