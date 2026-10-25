import { useEffect, useState, type FormEvent } from 'react';
import type { ChatMessage } from '@shared/chat';
import type { DebugSnapshot } from '@shared/debug';

const DEBUG_POLL_INTERVAL_MS = 1_500;
const DEBUG_REQUEST_TIMEOUT_MS = 1_500;
const MAX_RECENT_MESSAGES = 100;

/**
 * Developer-only panel. The dashboard mounts it only when /health reports
 * dev/test mode, so production never requests /api/debug. If the endpoint still
 * answers 404, polling stops and the panel stays hidden. The test-chat form
 * posts to the same developer-only endpoint as external callers, then shows the
 * server's recent chat log.
 */
export default function DeveloperPanel() {
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [visible, setVisible] = useState(false);
  const [user, setUser] = useState('dev');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const poll = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEBUG_REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch('/api/debug', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (response.status === 404) {
          stopped = true;
          if (active) setVisible(false);
          return;
        }
        if (!response.ok) {
          throw new Error(`Debug request failed with HTTP ${response.status}`);
        }
        const next = (await response.json()) as DebugSnapshot;
        if (!active) return;
        setSnapshot(next);
        setVisible(true);
      } catch {
        // Production answers 404 and stops polling. Transient local failures
        // retry quietly; the UI must not emit page/console errors for this.
      } finally {
        clearTimeout(timeout);
        if (active && !stopped) {
          timer = setTimeout(poll, DEBUG_POLL_INTERVAL_MS);
        }
      }
    };

    void poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedUser = user.trim();
    const trimmedText = text.trim();
    if (!trimmedUser || !trimmedText) {
      setNotice('Enter a user and a message.');
      return;
    }

    setSending(true);
    setNotice(null);

    try {
      const response = await fetch('/api/test/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ user: trimmedUser, text: trimmedText }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        message?: ChatMessage;
      } | null;

      if (!response.ok || !body?.message) {
        setNotice(body?.error ?? `Send failed (HTTP ${response.status})`);
        return;
      }

      setText('');
      const message = body.message;
      setSnapshot((current) => {
        if (!current) return current;
        if (current.chat.recent.some((entry) => entry.id === message.id)) return current;
        return {
          ...current,
          chat: {
            ...current.chat,
            messages: current.chat.messages + 1,
            recent: [...current.chat.recent, message].slice(-MAX_RECENT_MESSAGES),
          },
        };
      });
    } catch {
      setNotice('Could not reach the local server.');
    } finally {
      setSending(false);
    }
  };

  if (!visible || !snapshot) return null;

  return (
    <section
      className="developer-panel"
      aria-labelledby="developer-title"
      data-testid="developer-panel"
    >
      <header className="developer-header">
        <div>
          <p className="eyebrow">Local developer tools</p>
          <h2 id="developer-title">Developer</h2>
        </div>
        <span className="developer-mode" data-testid="debug-mode">
          {snapshot.mode}
        </span>
      </header>
      <p className="field-hint">
        Visible only when TPG_DEV or TPG_TEST is enabled. Production returns 404 for the debug and
        test-chat endpoints.
      </p>

      <div className="developer-grid">
        <article className="developer-card" aria-labelledby="test-chat-title">
          <h3 id="test-chat-title">Test chat</h3>
          <p className="developer-status">
            Source <span data-testid="debug-chat-source">{snapshot.chat.source}</span> ·{' '}
            <span data-testid="debug-chat-status">
              {snapshot.chat.connected ? 'connected' : 'disconnected'}
            </span>{' '}
            · <span data-testid="debug-chat-count">{snapshot.chat.messages}</span> messages
          </p>

          <form className="test-chat-form" onSubmit={handleSubmit}>
            <label htmlFor="test-chat-user">Chat user</label>
            <input
              id="test-chat-user"
              name="test-chat-user"
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              value={user}
              data-testid="test-chat-user"
              onChange={(event) => setUser(event.target.value)}
            />
            <label htmlFor="test-chat-text">Chat message</label>
            <div className="test-chat-row">
              <input
                id="test-chat-text"
                name="test-chat-text"
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                placeholder="!up"
                value={text}
                data-testid="test-chat-input"
                onChange={(event) => setText(event.target.value)}
              />
              <button
                type="submit"
                className="primary-action"
                data-testid="test-chat-send"
                disabled={sending}
              >
                {sending ? 'Sending…' : 'Send test chat'}
              </button>
            </div>
          </form>

          {notice ? (
            <p className="notice" role="status">
              {notice}
            </p>
          ) : null}

          <ol className="test-chat-log" aria-label="Recent test chat" data-testid="test-chat-log">
            {snapshot.chat.recent.length === 0 ? (
              <li className="field-hint">No test messages yet.</li>
            ) : null}
            {snapshot.chat.recent.map((message) => (
              <li key={message.id} data-testid="test-chat-message">
                <strong data-testid="test-chat-user">{message.user}</strong>
                <span data-testid="test-chat-text">{message.text}</span>
              </li>
            ))}
          </ol>
        </article>

        <article className="developer-card" aria-labelledby="debug-metrics-title">
          <h3 id="debug-metrics-title">Debug metrics</h3>
          <dl className="debug-metrics">
            <div>
              <dt>WS clients</dt>
              <dd data-testid="debug-clients">{snapshot.clients.total}</dd>
            </div>
            <div>
              <dt>Emulator</dt>
              <dd data-testid="debug-emulator-status">{snapshot.emulator.status}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd data-testid="debug-emulator-model">{snapshot.emulator.rom?.model ?? 'none'}</dd>
            </div>
            <div>
              <dt>Video frames</dt>
              <dd data-testid="debug-video-frames">{snapshot.media.videoFrames}</dd>
            </div>
            <div>
              <dt>Audio chunks</dt>
              <dd data-testid="debug-audio-chunks">{snapshot.media.audioChunks}</dd>
            </div>
            <div>
              <dt>FPS</dt>
              <dd data-testid="debug-fps">{snapshot.media.fps.toFixed(1)}</dd>
            </div>
            <div>
              <dt>Audio rate</dt>
              <dd data-testid="debug-audio-rate">{snapshot.media.audioSampleRate}</dd>
            </div>
            <div>
              <dt>Queue length</dt>
              <dd data-testid="debug-queue-length">{snapshot.queue.length}</dd>
            </div>
            <div>
              <dt>Queue votes</dt>
              <dd data-testid="debug-queue-votes">{snapshot.queue.votes}</dd>
            </div>
            <div>
              <dt>Input mode</dt>
              <dd data-testid="debug-input-mode">{snapshot.input.mode}</dd>
            </div>
            <div>
              <dt>Inputs accepted</dt>
              <dd data-testid="debug-input-accepted">{snapshot.input.stats.accepted}</dd>
            </div>
            <div>
              <dt>Inputs executed</dt>
              <dd data-testid="debug-input-executed">{snapshot.input.stats.executed}</dd>
            </div>
            <div>
              <dt>Inputs dropped</dt>
              <dd data-testid="debug-input-dropped">{snapshot.input.stats.dropped}</dd>
            </div>
            <div>
              <dt>Last drop</dt>
              <dd data-testid="debug-input-last-drop">
                {snapshot.input.lastDrop?.reason ?? 'none'}
              </dd>
            </div>
            <div>
              <dt>Democracy window</dt>
              <dd>
                <span data-testid="debug-democracy-window">
                  {snapshot.timings.democracyWindowMs}
                </span>{' '}
                ms
              </dd>
            </div>
            <div>
              <dt>Hold frames</dt>
              <dd data-testid="debug-hold-frames">{snapshot.timings.holdFrames}</dd>
            </div>
            <div>
              <dt>Release frames</dt>
              <dd data-testid="debug-release-frames">{snapshot.timings.releaseFrames}</dd>
            </div>
            <div>
              <dt>Input cooldown</dt>
              <dd>
                <span data-testid="debug-input-cooldown">{snapshot.timings.inputCooldownMs}</span>{' '}
                ms
              </dd>
            </div>
            <div>
              <dt>Input queue cap</dt>
              <dd data-testid="debug-input-max-queue">{snapshot.timings.inputMaxQueue}</dd>
            </div>
            <div>
              <dt>Input rate cap</dt>
              <dd data-testid="debug-input-max-rate">{snapshot.timings.inputMaxPerSecond}/s</dd>
            </div>
            <div>
              <dt>Input stale</dt>
              <dd>
                <span data-testid="debug-input-stale">{snapshot.timings.inputStaleMs}</span> ms
              </dd>
            </div>
          </dl>
        </article>
      </div>
    </section>
  );
}
