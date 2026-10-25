import { join } from 'node:path';
import {
  buildDesktop,
  fetchHealth,
  killTree,
  repoRoot,
  spawnElectron,
  waitForExit,
} from './dev-utils.mjs';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';

function log(message) {
  console.log(`[desktop] ${message}`);
}

function parseServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`TPG_SERVER_URL is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`TPG_SERVER_URL must use http or https, received ${JSON.stringify(value)}`);
  }
  return url;
}

async function main() {
  const serverUrl = parseServerUrl(process.env.TPG_SERVER_URL ?? DEFAULT_SERVER_URL);

  try {
    const health = await fetchHealth(serverUrl.toString());
    log(`server healthy at ${serverUrl.origin} (version ${health.version ?? 'unknown'})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[desktop] Cannot reach a Twitch Plays GB server at ${serverUrl.toString()}.`);
    console.error(`[desktop] ${message}`);
    console.error('[desktop] Start the server in another terminal:');
    console.error('[desktop]   npm run dev:web');
    console.error('[desktop] Or point the shell at another server:');
    console.error('[desktop]   TPG_SERVER_URL=http://127.0.0.1:3001 npm run dev:electron');
    process.exit(1);
  }

  await buildDesktop();

  let stopping = false;
  const userDataDir = join(repoRoot, 'data', 'dev', 'electron');
  const child = spawnElectron('electron', serverUrl.toString(), [
    `--user-data-dir=${userDataDir}`,
    ...process.argv.slice(2),
  ]);

  const stop = async (code) => {
    if (stopping) return;
    stopping = true;
    killTree(child, 'SIGTERM');
    const exited = await waitForExit(child, 4_000);
    if (!exited) {
      killTree(child, 'SIGKILL');
      await waitForExit(child, 1_000);
    }
    process.exit(code);
  };

  process.on('SIGINT', () => {
    void stop(0);
  });
  process.on('SIGTERM', () => {
    void stop(0);
  });

  child.once('exit', (code, signal) => {
    if (stopping) return;
    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    log(`Electron exited (${detail})`);
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[desktop] ${message}`);
  process.exit(1);
});
