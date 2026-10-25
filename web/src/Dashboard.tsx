import { useEffect, useState } from 'react';
import type { ChatStatus } from '@shared/chat';
import type { EmulatorStatus } from '@shared/emulator-status';
import type { InputState } from '@shared/input';
import type { SettingsResponse } from '@shared/settings';

export type EmulatorOperation = 'start' | 'stop' | 'restart';

const INPUT_POLL_INTERVAL_MS = 1_000;
const INPUT_REQUEST_TIMEOUT_MS = 1_500;

function inputStatus(event: InputState['recent'][number]): string {
  if (event.status === 'dropped') return event.dropReason ?? 'dropped';
  return event.status;
}

interface DashboardProps {
  settings: SettingsResponse;
  emulator: EmulatorStatus;
  busy: EmulatorOperation | null;
  saving: boolean;
  notice: string | null;
  onOperation: (operation: EmulatorOperation) => void;
  onSave: () => void;
  onReconfigure: () => void;
}

function autosaveLabel(intervalMs: number): string {
  if (intervalMs <= 0) return 'off';
  if (intervalMs < 1_000) return `${intervalMs} ms`;
  return `${Math.round(intervalMs / 1_000)}s`;
}

export default function Dashboard({
  settings,
  emulator,
  busy,
  saving,
  notice,
  onOperation,
  onSave,
  onReconfigure,
}: DashboardProps) {
  const [input, setInput] = useState<InputState | null>(null);
  const [chat, setChat] = useState<ChatStatus | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pollInput = async (): Promise<void> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), INPUT_REQUEST_TIMEOUT_MS);

      try {
        const [inputResponse, chatResponse] = await Promise.all([
          fetch('/api/input/state', {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          }),
          fetch('/api/chat', {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          }),
        ]);
        if (active && inputResponse.ok) {
          setInput((await inputResponse.json()) as InputState);
        }
        if (active && chatResponse.ok) {
          setChat((await chatResponse.json()) as ChatStatus);
        }
      } catch {
        // Transient polling failures stay quiet; the server-status chip covers
        // an unreachable server.
      } finally {
        clearTimeout(timeout);
        if (active) timer = setTimeout(pollInput, INPUT_POLL_INTERVAL_MS);
      }
    };

    void pollInput();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const romLabel = emulator.rom
    ? `${emulator.rom.title} · ${emulator.rom.model} ${emulator.rom.width}x${emulator.rom.height}`
    : 'No ROM loaded';
  const modeLabel = input?.mode === 'democracy' ? 'Democracy' : 'Anarchy';
  const recent = input ? input.recent.slice(-8).reverse() : [];

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
        The emulator runs locally. Chat drives anarchy input with a FIFO queue, per-user cooldown,
        and a global rate cap. Start, Stop, and Restart control the current session.
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

      <dl className="dashboard-meta save-meta" aria-label="Save state">
        <div>
          <dt>Last saved</dt>
          <dd data-testid="last-saved">{emulator.lastSavedAt ?? 'never'}</dd>
        </div>
        <div>
          <dt>Saves</dt>
          <dd data-testid="save-count">{emulator.saveCount}</dd>
        </div>
        <div>
          <dt>Restored</dt>
          <dd data-testid="restored-from">{emulator.restoredFrom ?? 'none'}</dd>
        </div>
        <div>
          <dt>Autosave</dt>
          <dd data-testid="autosave-interval">{autosaveLabel(emulator.autosaveIntervalMs)}</dd>
        </div>
      </dl>

      <section
        className="chat-input-panel"
        aria-labelledby="chat-input-title"
        data-testid="dashboard-input"
      >
        <div className="chat-input-heading">
          <h3 id="chat-input-title">Chat input</h3>
          <span className="chat-mode" data-testid="dashboard-input-mode">
            {modeLabel}
          </span>
        </div>
        <p className="field-hint">
          Chat:{' '}
          <span data-testid="dashboard-chat-status">
            {chat
              ? `${chat.source} ${chat.connected ? 'connected' : 'disconnected'}${
                  chat.channel ? ` (#${chat.channel})` : ''
                }`
              : 'loading'}
          </span>
          {chat?.lastError ? <> · {chat.lastError}</> : null}
        </p>
        <dl className="chat-input-stats">
          <div>
            <dt>Queue</dt>
            <dd data-testid="dashboard-queue-count">{input?.queue.length ?? 0}</dd>
          </div>
          <div>
            <dt>Accepted</dt>
            <dd data-testid="dashboard-input-accepted">{input?.stats.accepted ?? 0}</dd>
          </div>
          <div>
            <dt>Executed</dt>
            <dd data-testid="dashboard-input-executed">{input?.stats.executed ?? 0}</dd>
          </div>
          <div>
            <dt>Dropped</dt>
            <dd data-testid="dashboard-input-dropped">{input?.stats.dropped ?? 0}</dd>
          </div>
        </dl>
        <p className="field-hint">
          Last drop:{' '}
          <span data-testid="dashboard-last-drop">
            {input?.lastDrop ? `${input.lastDrop.reason} (${input.lastDrop.user})` : 'none yet'}
          </span>
        </p>
        <ol
          className="chat-input-recent"
          aria-label="Recent chat inputs"
          data-testid="dashboard-recent-inputs"
        >
          {recent.length === 0 ? (
            <li className="field-hint">No chat inputs yet.</li>
          ) : (
            recent.map((event) => (
              <li key={event.id} data-testid="dashboard-input-event">
                <strong>{event.user}</strong> {event.button}{' '}
                <span className={`input-status input-${event.status}`}>{inputStatus(event)}</span>
              </li>
            ))
          )}
        </ol>
      </section>

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
        <button
          type="button"
          className="secondary-action"
          data-testid="save-emulator"
          disabled={busy !== null || saving || emulator.status !== 'running'}
          onClick={onSave}
        >
          {saving ? 'Saving…' : 'Save now'}
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

      {emulator.lastSaveError ? (
        <p className="notice" role="alert" data-testid="save-error">
          Save failed: {emulator.lastSaveError}
        </p>
      ) : null}
      {emulator.lastError ? (
        <p className="notice" role="alert">
          {emulator.lastError}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status" data-testid="dashboard-notice">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
