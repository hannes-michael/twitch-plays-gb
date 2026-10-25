import { useEffect, useState, type FormEvent } from 'react';
import type { AppMode } from '@shared/debug';
import type { EmulatorLifecycleStatus } from '@shared/emulator-status';
import DeveloperPanel from './DeveloperPanel';

type ServerStatus = 'checking' | 'online' | 'offline';

interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
  mode: AppMode;
  emulator: EmulatorLifecycleStatus;
  clients: { total: number };
}

const HEALTH_POLL_INTERVAL_MS = 2_000;
const HEALTH_REQUEST_TIMEOUT_MS = 1_500;

export default function App() {
  const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<AppMode | null>(null);
  const [channel, setChannel] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const checkHealth = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch('/health', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(`Health check failed with HTTP ${response.status}`);
        }
        const health = (await response.json()) as HealthResponse;
        if (!active) return;
        if (health.status !== 'ok') {
          throw new Error('Health check returned a non-ok status');
        }
        setServerStatus('online');
        setServerVersion(health.version);
        setAppMode(health.mode);
      } catch {
        if (active) {
          setServerStatus('offline');
          setServerVersion(null);
        }
      } finally {
        clearTimeout(timeout);
        if (active) {
          timer = setTimeout(checkHealth, HEALTH_POLL_INTERVAL_MS);
        }
      }
    };

    void checkHealth();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedChannel = channel.trim();
    if (!trimmedChannel) {
      setNotice('Enter a Twitch channel to continue.');
      return;
    }
    setNotice(
      'Twitch connection is not available yet. Nothing was saved; this setup step is a preview for a later build.',
    );
  };

  const statusLabel =
    serverStatus === 'online' ? 'online' : serverStatus === 'offline' ? 'offline' : 'checking';

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Local emulator · OBS ready</p>
          <h1>Twitch Plays GB</h1>
        </div>
        <div
          className={`status-chip status-${serverStatus}`}
          role="status"
          aria-live="polite"
          data-testid="server-status"
        >
          <span className="status-dot" aria-hidden="true" />
          <span data-testid="server-status-label">{statusLabel}</span>
          {serverVersion ? <span className="status-version">v{serverVersion}</span> : null}
        </div>
      </header>

      <section className="setup-card" aria-labelledby="setup-title">
        <h2 id="setup-title">First-run setup</h2>
        <p className="lede">
          Run Game Boy, GBC, and GBA games locally and let Twitch chat play along. Start by telling
          the app which channel will host the game.
        </p>

        <form className="setup-form" onSubmit={handleSubmit}>
          <label htmlFor="channel">Twitch channel</label>
          <div className="input-row">
            <span className="input-prefix" aria-hidden="true">
              twitch.tv/
            </span>
            <input
              id="channel"
              name="channel"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="your_channel"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            />
          </div>
          <p className="field-hint">
            Use the channel name without the leading #. This form is a preview and does not connect
            or save yet.
          </p>
          <button type="submit" className="primary-action">
            Continue
          </button>
          {notice ? (
            <p className="notice" role="status">
              {notice}
            </p>
          ) : null}
        </form>

        <aside className="legal-notice" aria-label="Legal notice">
          <strong>Before you start</strong>
          <p>
            You must supply your own legally obtained ROMs. Not affiliated with Nintendo, Game
            Freak, or Twitch.
          </p>
        </aside>
      </section>

      {appMode === 'dev' || appMode === 'test' ? <DeveloperPanel /> : null}
    </main>
  );
}
