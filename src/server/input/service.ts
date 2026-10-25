import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatTimings } from '../../shared/chat';
import type {
  InputButton,
  InputDropReason,
  InputEvent,
  InputMode,
  InputState,
  InputStats,
} from '../../shared/input';
import type { ChatService } from '../chat/service';
import { EmulatorNotRunningError, type EmulatorService } from '../emulator/service';
import type { Logger } from '../logger';
import { parseChatCommand } from './command-parser';

export type InputStateListener = (state: InputState) => void;

export interface InputServiceOptions {
  bareCommands?: boolean;
  mode?: InputMode;
}

const MAX_RECENT_INPUTS = 10;
const RATE_WINDOW_MS = 1_000;

function createStats(): InputStats {
  return {
    accepted: 0,
    executed: 0,
    dropped: 0,
    cooldownDrops: 0,
    rateLimitDrops: 0,
    queueFullDrops: 0,
    staleDrops: 0,
  };
}

/**
 * Chat-driven anarchy input queue. It accepts at most one input per user per
 * cooldown, one queue-full batch at a time, and a global number of accepted
 * inputs per sliding second. Execution is strictly FIFO and only runs while
 * the emulator is running. Chat disconnects never touch the processor.
 */
export class InputService {
  private readonly logger: Logger;
  private readonly emulator: EmulatorService;
  private readonly timings: ChatTimings;
  private readonly bareCommands: boolean;
  private readonly listeners = new Set<InputStateListener>();
  private readonly queue: InputEvent[] = [];
  private readonly recent: InputEvent[] = [];
  private readonly stats = createStats();
  private readonly cooldowns = new Map<string, number>();
  private readonly rateWindow: number[] = [];
  private readonly unsubscribeChat: () => void;
  private readonly unsubscribeEmulator: () => void;
  private mode: InputMode;
  private paused = false;
  private lastExecuted: InputState['lastExecuted'] = null;
  private lastDrop: InputState['lastDrop'] = null;
  private lastMeta: InputState['lastMeta'] = null;
  private closed = false;
  private processing = false;
  private processScheduled = false;

  constructor(
    logger: Logger,
    emulator: EmulatorService,
    chat: ChatService,
    timings: ChatTimings,
    options: InputServiceOptions = {},
  ) {
    this.logger = logger;
    this.emulator = emulator;
    this.timings = timings;
    this.bareCommands = options.bareCommands ?? false;
    this.mode = options.mode ?? 'anarchy';
    this.unsubscribeChat = chat.subscribe((message) => this.handleMessage(message));
    this.unsubscribeEmulator = emulator.onStatusChange(() => this.scheduleProcess());
  }

  getState(): InputState {
    return {
      mode: this.mode,
      paused: this.paused,
      queue: this.queue.map((event) => ({ ...event })),
      recent: this.recent.map((event) => ({ ...event })),
      stats: { ...this.stats },
      lastExecuted: this.lastExecuted ? { ...this.lastExecuted } : null,
      lastDrop: this.lastDrop ? { ...this.lastDrop } : null,
      lastMeta: this.lastMeta ? { ...this.lastMeta } : null,
    };
  }

  subscribe(listener: InputStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeChat();
    this.unsubscribeEmulator();
    this.listeners.clear();
  }

  private handleMessage(message: ChatMessage): void {
    // Bots are noise, and an authenticated future bot's own messages must never
    // be able to trigger input. Invalid text and meta commands are ignored.
    if (message.roles?.bot || message.roles?.self) return;

    const parsed = parseChatCommand(message.text, { bareCommands: this.bareCommands });
    if (!parsed) return;

    if (parsed.kind === 'meta') {
      if (parsed.command === 'save') {
        this.handleSaveCommand(message);
        return;
      }
      // Mode switching and pause/resume are later P1 work.
      this.logger.debug(`ignoring meta chat command: ${parsed.command}`);
      return;
    }

    this.accept(message, parsed.button);
  }

  private handleSaveCommand(message: ChatMessage): void {
    const allowed = Boolean(message.roles?.broadcaster || message.roles?.mod);
    this.lastMeta = {
      command: 'save',
      user: message.user,
      allowed,
      at: new Date().toISOString(),
    };
    this.publish();

    if (!allowed) {
      this.logger.debug(`ignoring unauthorized save command from ${message.user}`);
      return;
    }

    void this.emulator.saveState('command').catch((error: unknown) => {
      this.logger.warn(
        `save command failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private accept(message: ChatMessage, button: InputButton): void {
    const now = Date.now();
    const userKey = message.user.toLowerCase();
    this.pruneCooldowns(now);

    const lastAccepted = this.cooldowns.get(userKey);
    if (
      lastAccepted !== undefined &&
      this.timings.inputCooldownMs > 0 &&
      now - lastAccepted < this.timings.inputCooldownMs
    ) {
      this.reject(message, button, 'cooldown', now);
      return;
    }

    // Queue overflow is reported before the rate cap: a full queue is the more
    // actionable feedback when both limits apply to the same attempt.
    if (this.queue.length >= this.timings.inputMaxQueue) {
      this.reject(message, button, 'queue-full', now);
      return;
    }

    this.pruneRateWindow(now);
    if (this.rateWindow.length >= this.timings.inputMaxPerSecond) {
      this.reject(message, button, 'rate-limit', now);
      return;
    }

    const event: InputEvent = {
      id: randomUUID(),
      user: message.user,
      button,
      source: 'chat',
      receivedAt: message.receivedAt,
      queuedAt: new Date(now).toISOString(),
      status: 'queued',
    };

    this.cooldowns.set(userKey, now);
    this.rateWindow.push(now);
    this.stats.accepted += 1;
    this.queue.push(event);
    this.addRecent(event);
    this.publish();
    this.scheduleProcess();
  }

  private reject(
    message: ChatMessage,
    button: InputButton,
    reason: InputDropReason,
    now: number,
  ): void {
    const event: InputEvent = {
      id: randomUUID(),
      user: message.user,
      button,
      source: 'chat',
      receivedAt: message.receivedAt,
      queuedAt: new Date(now).toISOString(),
      status: 'dropped',
      dropReason: reason,
    };

    this.markDropped(event, reason, now);
    this.addRecent(event);
    this.publish();
  }

  private markDropped(event: InputEvent, reason: InputDropReason, now = Date.now()): void {
    event.status = 'dropped';
    event.dropReason = reason;
    this.stats.dropped += 1;
    if (reason === 'cooldown') this.stats.cooldownDrops += 1;
    else if (reason === 'rate-limit') this.stats.rateLimitDrops += 1;
    else if (reason === 'queue-full') this.stats.queueFullDrops += 1;
    else if (reason === 'stale') this.stats.staleDrops += 1;

    this.lastDrop = {
      reason,
      user: event.user,
      at: new Date(now).toISOString(),
    };
  }

  private addRecent(event: InputEvent): void {
    this.recent.push(event);
    if (this.recent.length > MAX_RECENT_INPUTS) {
      this.recent.splice(0, this.recent.length - MAX_RECENT_INPUTS);
    }
  }

  private pruneCooldowns(now: number): void {
    if (this.timings.inputCooldownMs <= 0) {
      this.cooldowns.clear();
      return;
    }
    for (const [user, at] of this.cooldowns) {
      if (now - at >= this.timings.inputCooldownMs) this.cooldowns.delete(user);
    }
  }

  private pruneRateWindow(now: number): void {
    const cutoff = now - RATE_WINDOW_MS;
    while (this.rateWindow.length > 0 && this.rateWindow[0] <= cutoff) {
      this.rateWindow.shift();
    }
  }

  private scheduleProcess(): void {
    if (this.closed || this.processing || this.processScheduled) return;
    this.processScheduled = true;
    setImmediate(() => {
      this.processScheduled = false;
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.closed) return;
    this.processing = true;

    try {
      while (!this.closed && this.queue.length > 0) {
        if (this.paused || this.emulator.status().status !== 'running') break;

        const event = this.queue[0];
        const queuedAt = Date.parse(event.queuedAt);
        if (
          this.timings.inputStaleMs > 0 &&
          !Number.isNaN(queuedAt) &&
          Date.now() - queuedAt > this.timings.inputStaleMs
        ) {
          this.queue.shift();
          this.markDropped(event, 'stale');
          this.publish();
          continue;
        }

        event.status = 'executing';
        this.publish();

        try {
          await this.emulator.press(
            event.button,
            this.timings.holdFrames,
            this.timings.releaseFrames,
          );
        } catch (error) {
          if (
            error instanceof EmulatorNotRunningError ||
            this.emulator.status().status !== 'running'
          ) {
            // A stop/cancel raced the press. Keep the input for the next start
            // instead of turning a dashboard action into a user-visible drop.
            event.status = 'queued';
            this.publish();
            this.logger.debug(`input press interrupted by emulator stop: ${String(error)}`);
            break;
          }

          this.queue.shift();
          this.markDropped(event, 'emulator-error');
          this.publish();
          this.logger.warn(
            `input ${event.button} failed; dropping: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        this.queue.shift();
        event.status = 'done';
        event.executedAt = new Date().toISOString();
        this.stats.executed += 1;
        this.lastExecuted = {
          button: event.button,
          user: event.user,
          at: event.executedAt,
        };
        this.publish();
      }
    } finally {
      this.processing = false;
      if (
        !this.closed &&
        this.queue.length > 0 &&
        !this.paused &&
        this.emulator.status().status === 'running'
      ) {
        this.scheduleProcess();
      }
    }
  }

  private publish(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        this.logger.warn(`input state listener failed: ${(error as Error).message}`);
      }
    }
  }
}
