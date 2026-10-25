import { useEffect, useRef, useState } from 'react';
import type { AppMode } from '@shared/debug';
import {
  createStoppedEmulatorStatus,
  type EmulatorLifecycleStatus,
  type EmulatorSaveResponse,
  type EmulatorStatus,
} from '@shared/emulator-status';
import type { EmulatorOperationResponse, SettingsResponse } from '@shared/settings';
import Dashboard, { type EmulatorOperation } from './Dashboard';
import DeveloperPanel from './DeveloperPanel';
import SetupWizard from './SetupWizard';

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
const EMULATOR_POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 1_500;
const SETTINGS_TIMEOUT_MS = 3_000;

export default function App() {
  const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<AppMode | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [emulator, setEmulator] = useState<EmulatorStatus>(createStoppedEmulatorStatus);
  const [reconfiguring, setReconfiguring] = useState(false);
  const [operation, setOperation] = useState<EmulatorOperation | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const statusEpoch = useRef(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const checkHealth = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SETTINGS_TIMEOUT_MS);

    const loadSettings = async (): Promise<void> => {
      try {
        const response = await fetch('/api/settings', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`Settings request failed with HTTP ${response.status}`);
        const body = (await response.json()) as SettingsResponse;
        if (!active) return;
        setSettings(body);
        setSettingsError(null);
      } catch {
        if (active) setSettingsError('Could not load the local setup state.');
      } finally {
        clearTimeout(timeout);
      }
    };

    void loadSettings();

    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pollStatus = async (): Promise<void> => {
      const epoch = statusEpoch.current;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch('/api/emulator/status', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return;
        const next = (await response.json()) as EmulatorStatus;
        if (active && epoch === statusEpoch.current) setEmulator(next);
      } catch {
        // Transient status failures stay quiet; the server-status chip already
        // reports an unreachable server.
      } finally {
        clearTimeout(timeout);
        if (active) {
          timer = setTimeout(pollStatus, EMULATOR_POLL_INTERVAL_MS);
        }
      }
    };

    void pollStatus();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const runEmulatorOperation = async (nextOperation: EmulatorOperation): Promise<void> => {
    if (!settings || operation !== null) return;

    setOperation(nextOperation);
    setNotice(null);
    statusEpoch.current += 1;

    try {
      const romId = emulator.romId;
      const requestBody =
        nextOperation === 'stop' || romId === null ? undefined : JSON.stringify({ romId });
      const response = await fetch(`/api/emulator/${nextOperation}`, {
        method: 'POST',
        headers:
          requestBody === undefined
            ? { accept: 'application/json' }
            : { 'content-type': 'application/json', accept: 'application/json' },
        body: requestBody,
      });
      const body = (await response.json().catch(() => null)) as
        (EmulatorOperationResponse & { error?: string }) | null;

      if (!response.ok || !body?.status) {
        setNotice(
          body?.error ?? `Could not ${nextOperation} the emulator (HTTP ${response.status}).`,
        );
        return;
      }

      statusEpoch.current += 1;
      setEmulator(body.status);
    } catch {
      setNotice('Could not reach the local server.');
    } finally {
      setOperation(null);
    }
  };

  const saveEmulator = async (): Promise<void> => {
    if (saving) return;

    setSaving(true);
    setNotice(null);

    try {
      const response = await fetch('/api/emulator/save', {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      const body = (await response.json().catch(() => null)) as
        (EmulatorSaveResponse & { error?: string }) | null;

      if (!response.ok || !body?.status) {
        setNotice(body?.error || `Could not save the emulator state (HTTP ${response.status}).`);
        return;
      }

      statusEpoch.current += 1;
      setEmulator(body.status);

      if (!body.saved) {
        if (body.status.lastSaveError) {
          setNotice(`Save failed: ${body.status.lastSaveError}`);
        } else if (body.status.status !== 'running') {
          setNotice('No running emulator to save.');
        } else {
          setNotice('Save failed.');
        }
        return;
      }

      setNotice('Save state written.');
    } catch {
      setNotice('Could not reach the local server.');
    } finally {
      setSaving(false);
    }
  };

  const handleSetupComplete = (
    next: SettingsResponse,
    status: EmulatorStatus | null,
    setupNotice?: string,
  ): void => {
    statusEpoch.current += 1;
    setSettings(next);
    if (status) setEmulator(status);
    setReconfiguring(false);
    setNotice(setupNotice ?? null);
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

      {settings === null ? (
        <section className="setup-card" aria-labelledby="setup-title">
          <h2 id="setup-title">First-run setup</h2>
          <p className="lede">{settingsError ?? 'Loading local setup…'}</p>
          {settingsError ? (
            <button
              type="button"
              className="secondary-action"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          ) : null}
        </section>
      ) : !settings.firstRun && !reconfiguring ? (
        <Dashboard
          settings={settings}
          emulator={emulator}
          busy={operation}
          saving={saving}
          notice={notice}
          onOperation={(nextOperation) => void runEmulatorOperation(nextOperation)}
          onSave={() => void saveEmulator()}
          onReconfigure={() => {
            setNotice(null);
            setReconfiguring(true);
          }}
        />
      ) : (
        <SetupWizard
          initialChannel={settings.channel}
          initialRomId={settings.romId}
          cancelable={!settings.firstRun}
          onCancel={() => setReconfiguring(false)}
          onComplete={handleSetupComplete}
        />
      )}

      {appMode === 'dev' || appMode === 'test' ? <DeveloperPanel /> : null}
    </main>
  );
}
