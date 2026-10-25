import { randomUUID } from 'node:crypto';
import { chatMessageInputSchema, type ChatMessage, type ChatStatus } from '../../shared/chat';
import { normalizeTwitchChannel } from '../../shared/settings';
import type { Logger } from '../logger';
import { FakeChatSource } from './fake-source';
import { TwitchChatSource } from './twitch-source';
import type { ChatMessageListener, ChatSource } from './types';

const MAX_RECENT_MESSAGES = 100;

export type ChatSourceSelection = 'fake' | 'twitch' | 'none';
export type ChatSourceSelector = (channel: string | null) => ChatSourceSelection;

export interface ChatServiceOptions {
  /** Chooses a source for an already-normalized channel or null. */
  selectSource?: ChatSourceSelector;
  /** Injectable for focused transition tests; defaults to the real client. */
  createTwitchSource?: (channel: string) => ChatSource;
}

export class ChatInputError extends Error {
  constructor() {
    super('Invalid chat message');
    this.name = 'ChatInputError';
  }
}

export class ChatUnavailableError extends Error {
  constructor(message = 'Fake chat is not available') {
    super(message);
    this.name = 'ChatUnavailableError';
  }
}

/**
 * Owns the active chat source, a bounded recent-message log, and subscribers.
 * Source selection is supplied by the server mode policy: tests always use the
 * fake source, development falls back to fake only until a channel is
 * configured, and production starts anonymous Twitch chat when a channel is
 * present. Chat failures only affect status, never emulation.
 *
 * Source transitions are serialized and generation-tagged. A transition that
 * was superseded while awaiting close/start aborts, so two overlapping channel
 * changes can never leave the older Twitch client connected.
 */
export class ChatService {
  private readonly logger: Logger;
  private readonly listeners = new Set<ChatMessageListener>();
  private readonly selectSource: ChatSourceSelector;
  private readonly createTwitchSource: (channel: string) => ChatSource;
  private recent: ChatMessage[] = [];
  private source: ChatSource | null = null;
  private received = 0;
  private transitionQueue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(logger: Logger, options: ChatServiceOptions = {}) {
    this.logger = logger;
    this.selectSource = options.selectSource ?? (() => 'none');
    this.createTwitchSource =
      options.createTwitchSource ?? ((channel) => new TwitchChatSource(channel, this.logger));
  }

  async applyChannel(channel: string | null): Promise<void> {
    const normalized = channel ? normalizeTwitchChannel(channel) : null;
    const selection = this.selectSource(normalized);

    await this.enqueueTransition(async (generation) => {
      if (selection === 'fake') {
        await this.startFakeInternal(generation);
        return;
      }
      if (selection === 'twitch' && normalized) {
        await this.startTwitchInternal(normalized, generation);
        return;
      }
      await this.closeSourceInternal();
    });
  }

  async startFake(): Promise<void> {
    await this.enqueueTransition((generation) => this.startFakeInternal(generation));
  }

  async startTwitch(channel: string): Promise<void> {
    const normalized = normalizeTwitchChannel(channel);
    if (!normalized) {
      this.logger.warn(`cannot start Twitch chat: invalid channel ${JSON.stringify(channel)}`);
      return;
    }

    await this.enqueueTransition((generation) => this.startTwitchInternal(normalized, generation));
  }

  async setFakeOutage(outage: boolean): Promise<void> {
    await this.enqueueTransition(async (generation) => {
      if (generation !== this.generation) return;

      const source = this.source;
      if (!source || source.kind !== 'fake') {
        throw new ChatUnavailableError('Fake chat is not available');
      }

      if (outage) {
        await this.stopSource(source);
        this.logger.warn('fake chat source disconnected (test outage)');
        return;
      }

      await source.start((message) => this.record(message));
      if (generation !== this.generation) {
        if (this.source === source) this.source = null;
        await this.stopSource(source);
        return;
      }
      this.logger.info('fake chat source reconnected (test outage cleared)');
    });
  }

  async close(): Promise<void> {
    await this.enqueueTransition(async () => {
      await this.closeSourceInternal();
    });
  }

  getStatus(): ChatStatus {
    const source = this.source;
    const status: ChatStatus = {
      source: source ? source.kind : 'none',
      connected: source?.connected ?? false,
      messages: this.received,
    };
    if (source?.channel) status.channel = source.channel;
    if (source?.lastError) status.lastError = source.lastError;
    return status;
  }

  getRecent(): ChatMessage[] {
    return [...this.recent];
  }

  subscribe(listener: ChatMessageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  injectFakeMessage(input: unknown): ChatMessage {
    const parsed = chatMessageInputSchema.safeParse(input);
    if (!parsed.success) throw new ChatInputError();

    const source = this.source;
    if (!(source instanceof FakeChatSource) || !source.connected) {
      throw new ChatUnavailableError();
    }

    const message: ChatMessage = {
      id: randomUUID(),
      user: parsed.data.user,
      text: parsed.data.text,
      receivedAt: new Date().toISOString(),
      ...(parsed.data.roles ? { roles: { ...parsed.data.roles } } : {}),
    };
    source.inject(message);
    return message;
  }

  private enqueueTransition(operation: (generation: number) => Promise<void>): Promise<void> {
    const generation = (this.generation += 1);
    const run = this.transitionQueue.then(
      () => operation(generation),
      () => operation(generation),
    );
    this.transitionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startFakeInternal(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (this.source?.kind === 'fake' && this.source.connected) return;

    await this.closeSourceInternal();
    if (generation !== this.generation) return;

    const source = new FakeChatSource();
    this.source = source;
    await source.start((message) => this.record(message));

    if (generation !== this.generation) {
      if (this.source === source) this.source = null;
      await this.stopSource(source);
    }
  }

  private async startTwitchInternal(channel: string, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (this.source?.kind === 'twitch' && this.source.channel === channel) return;

    await this.closeSourceInternal();
    if (generation !== this.generation) return;

    const source = this.createTwitchSource(channel);
    this.source = source;
    await source.start((message) => this.record(message));

    if (generation !== this.generation) {
      if (this.source === source) this.source = null;
      await this.stopSource(source);
    }
  }

  private async closeSourceInternal(): Promise<void> {
    const source = this.source;
    this.source = null;
    if (source) await this.stopSource(source);
  }

  private async stopSource(source: ChatSource): Promise<void> {
    try {
      await source.stop();
    } catch (error) {
      this.logger.warn(`chat source stop failed: ${(error as Error).message}`);
    }
  }

  private record(message: ChatMessage): void {
    this.received += 1;
    this.recent.push(message);
    if (this.recent.length > MAX_RECENT_MESSAGES) {
      this.recent.splice(0, this.recent.length - MAX_RECENT_MESSAGES);
    }

    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        this.logger.warn(`chat listener failed: ${(error as Error).message}`);
      }
    }
  }
}
