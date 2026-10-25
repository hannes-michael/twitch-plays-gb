import { useEffect, useRef, useState } from 'react';
import { CanvasStreamRenderer, WebAudioPlayer } from 'node-mgba/browser';
import { createStoppedEmulatorStatus, type EmulatorStatus } from '@shared/emulator-status';
import type { InputState } from '@shared/input';
import { decodeMediaMessage } from '@shared/media-protocol';

type AudioState = 'muted' | 'unlocking' | 'running' | 'blocked';

const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_TICKER_EVENTS = 8;

interface StateMessage {
  type: 'state';
  emulator: EmulatorStatus;
}

function isStateMessage(value: unknown): value is StateMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown; emulator?: unknown };
  return (
    message.type === 'state' &&
    typeof message.emulator === 'object' &&
    message.emulator !== null &&
    'status' in message.emulator
  );
}

function isInputState(value: unknown): value is InputState {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { mode?: unknown; queue?: unknown; recent?: unknown };
  return (
    (message.mode === 'anarchy' || message.mode === 'democracy') &&
    Array.isArray(message.queue) &&
    Array.isArray(message.recent)
  );
}

function inputStatus(event: InputState['recent'][number]): string {
  if (event.status === 'dropped') return event.dropReason ?? 'dropped';
  return event.status;
}

export default function Overlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<WebAudioPlayer | null>(null);
  const [status, setStatus] = useState<EmulatorStatus>(createStoppedEmulatorStatus);
  const [input, setInput] = useState<InputState | null>(null);
  const [connected, setConnected] = useState(false);
  const [videoFrames, setVideoFrames] = useState(0);
  const [audioChunks, setAudioChunks] = useState(0);
  const [audioState, setAudioState] = useState<AudioState>('muted');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new CanvasStreamRenderer({ defaultWidth: 160, defaultHeight: 144 });
    renderer.attach(canvas);

    const player = new WebAudioPlayer({
      mode: 'realtime',
      jitterBufferSeconds: 0.15,
      adaptiveRate: true,
      defaultVolume: 0,
    });
    playerRef.current = player;

    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let closed = false;

    const connect = (): void => {
      if (closed) return;

      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${window.location.host}/ws?client=obs`);
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        reconnectAttempts = 0;
        setConnected(true);
      };

      socket.onclose = () => {
        setConnected(false);
        if (closed || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      socket.onerror = () => {
        // The close event owns reconnection; avoid noisy console errors.
      };

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const message: unknown = JSON.parse(event.data);
            if (isStateMessage(message)) {
              setStatus(message.emulator);
            } else if (
              typeof message === 'object' &&
              message !== null &&
              (message as { type?: unknown }).type === 'input-state' &&
              isInputState((message as { input?: unknown }).input)
            ) {
              setInput((message as { input: InputState }).input);
            }
          } catch {
            // Ignore malformed text messages.
          }
          return;
        }

        if (!(event.data instanceof ArrayBuffer)) return;
        const decoded = decodeMediaMessage(event.data);
        if (!decoded) return;

        if (decoded.type === 'video') {
          renderer.submitFrame({
            type: 'frame',
            width: decoded.width,
            height: decoded.height,
            strideBytes: decoded.strideBytes,
            frameIndex: decoded.frameIndex,
            pts: decoded.pts,
            buffer: decoded.payload,
          });
          setVideoFrames((count) => count + 1);
          return;
        }

        if (decoded.channels !== 2) return;
        player.playChunk({
          type: 'audio',
          frameIndex: decoded.frameIndex,
          pts: decoded.pts,
          sampleRate: decoded.sampleRate,
          channels: 2,
          sampleFrames: decoded.sampleFrames,
          buffer: decoded.payload,
        });
        setAudioChunks((count) => count + 1);
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      renderer.detach();
      player.close();
      playerRef.current = null;
    };
  }, []);

  const handleUnmute = async (): Promise<void> => {
    const player = playerRef.current;
    if (!player) return;

    setAudioState('unlocking');
    try {
      const unlocked = await player.unlock();
      player.setVolume(1);
      setAudioState(unlocked ? 'running' : 'blocked');
    } catch {
      setAudioState('blocked');
    }
  };

  const romLabel = status.rom
    ? `${status.rom.title} · ${status.rom.model} ${status.rom.width}x${status.rom.height}`
    : 'No ROM loaded';
  const modeLabel = input?.mode === 'democracy' ? 'Democracy' : 'Anarchy';
  const ticker = input ? input.recent.slice(-MAX_TICKER_EVENTS).reverse() : [];

  return (
    <main className="overlay-shell">
      <section className="overlay-stage" aria-label="Game stream">
        <canvas
          ref={canvasRef}
          className="overlay-canvas"
          width={160}
          height={144}
          data-testid="overlay-canvas"
        />
        <div className="overlay-hud">
          <div className="overlay-meta">
            <span className="overlay-eyebrow">Twitch Plays GB</span>
            <strong data-testid="overlay-title">{romLabel}</strong>
          </div>
          <div className="overlay-stats">
            <span className="overlay-stat" title="Input mode">
              <span className="overlay-stat-label">mode</span>
              <span data-testid="overlay-input-mode">{modeLabel}</span>
            </span>
            <span className="overlay-stat" title="Queued inputs">
              <span className="overlay-stat-label">queue</span>
              <span data-testid="overlay-queue-count">{input?.queue.length ?? 0}</span>
            </span>
            <span className="overlay-stat" title="Emulator status">
              <span className="overlay-stat-label">status</span>
              <span data-testid="emulator-status">{status.status}</span>
            </span>
            <span className="overlay-stat" title="Emulator frames per second">
              <span className="overlay-stat-label">fps</span>
              <span data-testid="fps">{status.fps ? status.fps.toFixed(1) : '0.0'}</span>
            </span>
            <span className="overlay-stat" title="Video frames received">
              <span className="overlay-stat-label">frames</span>
              <span data-testid="frame-count">{videoFrames}</span>
            </span>
            <span className="overlay-stat" title="Audio chunks received">
              <span className="overlay-stat-label">audio</span>
              <span data-testid="audio-count">{audioChunks}</span>
            </span>
            <span className="overlay-stat" title="WebSocket connection">
              <span className="overlay-stat-label">ws</span>
              <span data-testid="overlay-connection">{connected ? 'online' : 'offline'}</span>
            </span>
            <span
              className="overlay-stat"
              title="Audio playback state"
              data-testid="audio-state"
              data-audio-state={audioState}
            >
              <span className="overlay-stat-label">sound</span>
              <span>{audioState}</span>
            </span>
            <button
              type="button"
              className="overlay-unmute"
              data-testid="unmute-audio"
              onClick={() => void handleUnmute()}
            >
              {audioState === 'blocked' ? 'Retry audio' : 'Unmute audio'}
            </button>
          </div>
          <ol
            className="overlay-input-ticker"
            aria-label="Recent inputs"
            data-testid="overlay-recent-inputs"
          >
            {ticker.length === 0 ? (
              <li className="overlay-input-empty">No inputs yet</li>
            ) : (
              ticker.map((event) => (
                <li key={event.id} data-testid="overlay-input-event">
                  <strong>{event.user}</strong> {event.button}{' '}
                  <span className={`input-status input-${event.status}`}>{inputStatus(event)}</span>
                </li>
              ))
            )}
          </ol>
        </div>
      </section>
    </main>
  );
}
