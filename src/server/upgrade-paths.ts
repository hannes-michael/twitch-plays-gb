export const APP_WS_PATH = '/ws';
export const VITE_HMR_PATH = '/__vite_hmr';

/** Returns only the pathname so WebSocket query strings (HMR tokens) work. */
export function upgradePathname(requestUrl: string | undefined): string | undefined {
  try {
    return new URL(requestUrl ?? '/', 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}
