import type { EmulatorStatus } from '@shared/emulator-status';
import type { SettingsResponse } from '@shared/settings';

export type EmulatorOperation = 'start' | 'stop' | 'restart';

interface DashboardProps {
  settings: SettingsResponse;
  emulator: EmulatorStatus;
  busy: EmulatorOperation | null;
  notice: string | null;
  onOperation: (operation: EmulatorOperation) => void;
  onReconfigure: () => void;
}

export default function Dashboard({
  settings,
  emulator,
  busy,
  notice,
  onOperation,
  onReconfigure,
}: DashboardProps) {
  const romLabel = emulator.rom
    ? `${emulator.rom.title} · ${emulator.rom.model} ${emulator.rom.width}x${emulator.rom.height}`
    : 'No ROM loaded';

  return (
    <section className="setup-card dashboard-card" aria-labelledby="dashboard-title">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h2 id="dashboard-title">Ready to play</h2>
        </div>
        <div
          className={`emulator-state emulator-${emulator.status}`}
          role="status"
          aria-live="polite"
        >
          <span className="status-dot" aria-hidden="true" />
          <span data-testid="emulator-status">{emulator.status}</span>
        </div>
      </div>

      <p className="lede">
        The emulator runs locally. Chat input lands in a later build; use Start, Stop, and Restart
        to control the current session.
      </p>

      <dl className="dashboard-meta">
        <div>
          <dt>Twitch channel</dt>
          <dd data-testid="dashboard-channel">{settings.channel}</dd>
        </div>
        <div>
          <dt>ROM</dt>
          <dd data-testid="dashboard-rom">{romLabel}</dd>
        </div>
      </dl>

      <div className="dashboard-actions">
        <button
          type="button"
          className="primary-action"
          data-testid="start-emulator"
          disabled={busy !== null}
          onClick={() => onOperation('start')}
        >
          Start
        </button>
        <button
          type="button"
          className="secondary-action"
          data-testid="stop-emulator"
          disabled={busy !== null}
          onClick={() => onOperation('stop')}
        >
          Stop
        </button>
        <button
          type="button"
          className="secondary-action"
          data-testid="restart-emulator"
          disabled={busy !== null}
          onClick={() => onOperation('restart')}
        >
          Restart
        </button>
        <a
          className="secondary-action overlay-link"
          data-testid="open-overlay"
          href="/overlay?client=obs"
          target="_blank"
          rel="noreferrer"
        >
          Open OBS overlay
        </a>
        <button
          type="button"
          className="secondary-action"
          data-testid="reconfigure"
          disabled={busy !== null}
          onClick={onReconfigure}
        >
          Reconfigure
        </button>
      </div>

      {emulator.lastError ? (
        <p className="notice" role="alert">
          {emulator.lastError}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
