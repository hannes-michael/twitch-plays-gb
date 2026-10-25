import { useEffect, useRef, useState } from 'react';
import { DEFAULT_AUDIO_CONTROL, type AudioControl } from '@shared/audio';
import type { ChatStatus } from '@shared/chat';
import type { EmulatorStatus } from '@shared/emulator-status';
import type { InputButton, InputState, LocalInputResponse } from '@shared/input';
import type { SettingsResponse } from '@shared/settings';

export type EmulatorOperation = 'start' | 'stop' | 'restart';

const INPUT_POLL_INTERVAL_MS = 1_000;
const INPUT_REQUEST_TIMEOUT_MS = 1_500;

const KEY_BINDINGS: Record<string, InputButton> = {
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  KeyX: 'A',
  KeyZ: 'B',
  Enter: 'START',
  ShiftLeft: 'SELECT',
  ShiftRight: 'SELECT',
  KeyQ: 'L',
  KeyW: 'R',
};

const DPAD_BUTTONS: Array<{ button: InputButton; label: string; className: string; name: string }> =
  [
    { button: 'UP', label: '↑', className: 'dpad-up', name: 'Up' },
    { button: 'LEFT', label: '←', className: 'dpad-left', name: 'Left' },
    { button: 'RIGHT', label: '→', className: 'dpad-right', name: 'Right' },
    { button: 'DOWN', label: '↓', className: 'dpad-down', name: 'Down' },
  ];

const FACE_BUTTONS: Array<{ button: InputButton; className: string; name: string }> = [
  { button: 'B', className: 'face-b', name: 'B' },
  { button: 'A', className: 'face-a', name: 'A' },
];

const SYSTEM_BUTTONS: Array<{ button: InputButton; name: string }> = [
  { button: 'START', name: 'Start' },
  { button: 'SELECT', name: 'Select' },
  { button: 'L', name: 'L' },
  { button: 'R', name: 'R' },
];

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
  const [audio, setAudio] = useState<AudioControl>({ ...DEFAULT_AUDIO_CONTROL });
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const audioRequestPending = useRef(0);
  const sendLocalInputRef = useRef<(button: InputButton) => void>(() => {});

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pollInput = async (): Promise<void> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), INPUT_REQUEST_TIMEOUT_MS);

      try {
        const [inputResponse, chatResponse, audioResponse] = await Promise.all([
          fetch('/api/input/state', {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          }),
          fetch('/api/chat', {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          }),
          fetch('/api/audio', {
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
        if (active && audioResponse.ok && audioRequestPending.current === 0) {
          setAudio((await audioResponse.json()) as AudioControl);
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

  const updateAudioControl = async (patch: Partial<AudioControl>): Promise<void> => {
    setAudio((current) => ({ ...current, ...patch }));
    setControlNotice(null);
    audioRequestPending.current += 1;

    try {
      const response = await fetch('/api/audio', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = (await response.json().catch(() => null)) as
        (AudioControl & { error?: string }) | null;

      if (!response.ok || !body) {
        setControlNotice(body?.error ?? `Could not update stream audio (HTTP ${response.status}).`);
        return;
      }
      setAudio(body);
    } catch {
      setControlNotice('Could not reach the local server.');
    } finally {
      audioRequestPending.current = Math.max(0, audioRequestPending.current - 1);
    }
  };

  const sendLocalInput = async (button: InputButton): Promise<void> => {
    if (emulator.status !== 'running') return;

    setControlNotice(null);
    try {
      const response = await fetch('/api/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ button }),
      });
      const body = (await response.json().catch(() => null)) as
        (LocalInputResponse & { error?: string }) | null;

      if (!response.ok || !body) {
        setControlNotice(body?.error ?? `Could not send ${button} (HTTP ${response.status}).`);
        return;
      }

      setInput(body.input);
      if (!body.accepted) {
        if (body.reason === 'not-running') {
          setControlNotice('Start the emulator before sending input.');
        } else if (body.reason === 'queue-full') {
          setControlNotice('The input queue is full.');
        } else {
          setControlNotice(`Input ${button} was rejected.`);
        }
      }
    } catch {
      setControlNotice('Could not reach the local server.');
    }
  };
  sendLocalInputRef.current = (button) => {
    void sendLocalInput(button);
  };

  useEffect(() => {
    if (emulator.status !== 'running') return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;

      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;

      const button = KEY_BINDINGS[event.code];
      if (!button) return;

      event.preventDefault();
      sendLocalInputRef.current(button);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [emulator.status]);

  const romLabel = emulator.rom
    ? `${emulator.rom.title} · ${emulator.rom.model} ${emulator.rom.width}x${emulator.rom.height}`
    : 'No ROM loaded';
  const modeLabel = input?.mode === 'democracy' ? 'Democracy' : 'Anarchy';
  const recent = input ? input.recent.slice(-8).reverse() : [];
  const running = emulator.status === 'running';
  const volumePercent = Math.round(audio.volume * 100);

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
        aria-labelledby="stream-audio-title"
        data-testid="stream-audio-panel"
      >
        <div className="chat-input-heading">
          <h3 id="stream-audio-title">Stream audio</h3>
          <span
            className="chat-mode"
            data-testid="stream-audio-status"
            data-audio-muted={audio.muted ? 'true' : 'false'}
          >
            {audio.muted ? 'Muted' : `${volumePercent}%`}
          </span>
        </div>
        <div className="audio-controls">
          <button
            type="button"
            className="secondary-action"
            data-testid="toggle-stream-audio"
            data-audio-muted={audio.muted ? 'true' : 'false'}
            aria-pressed={!audio.muted}
            onClick={() => void updateAudioControl({ muted: !audio.muted })}
          >
            {audio.muted ? 'Unmute stream' : 'Mute stream'}
          </button>
          <label className="audio-volume">
            <span>Volume</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={volumePercent}
              data-testid="stream-audio-volume"
              onChange={(event) =>
                void updateAudioControl({ volume: Number(event.target.value) / 100 })
              }
            />
            <output data-testid="stream-audio-volume-value">{volumePercent}%</output>
          </label>
        </div>
        <p className="field-hint">
          Applies to the OBS overlay and the Electron capture window. The browser source itself
          stays free of debug controls.
        </p>
      </section>

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

      <section
        className="chat-input-panel"
        aria-labelledby="local-input-title"
        data-testid="local-input"
      >
        <div className="chat-input-heading">
          <h3 id="local-input-title">Manual controls</h3>
          <span className="chat-mode">{running ? 'Ready' : 'Start the emulator'}</span>
        </div>
        <div className="local-controls">
          <div className="dpad" aria-label="Directional pad">
            {DPAD_BUTTONS.map(({ button, label, className, name }) => (
              <button
                key={button}
                type="button"
                className={`local-button ${className}`}
                data-testid={`local-input-${button}`}
                aria-label={name}
                title={name}
                disabled={!running}
                onClick={() => void sendLocalInput(button)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="face-pad" aria-label="Face buttons">
            {FACE_BUTTONS.map(({ button, className, name }) => (
              <button
                key={button}
                type="button"
                className={`local-button ${className}`}
                data-testid={`local-input-${button}`}
                aria-label={name}
                title={name}
                disabled={!running}
                onClick={() => void sendLocalInput(button)}
              >
                {button}
              </button>
            ))}
          </div>
          <div className="system-pad" aria-label="System buttons">
            {SYSTEM_BUTTONS.map(({ button, name }) => (
              <button
                key={button}
                type="button"
                className="local-button system-button"
                data-testid={`local-input-${button}`}
                aria-label={name}
                title={name}
                disabled={!running}
                onClick={() => void sendLocalInput(button)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <p className="field-hint">
          Keyboard: arrows move · X = A · Z = B · Enter = Start · Shift = Select · Q = L · W = R.
          Local inputs skip chat cooldowns but share the queue with chat.
        </p>
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

      {controlNotice ? (
        <p className="notice" role="status" data-testid="dashboard-control-notice">
          {controlNotice}
        </p>
      ) : null}
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
