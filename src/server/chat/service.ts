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
 * Source selection is supplied by the server mode policy; test/dev normally
 * starts the fake source, while production starts anonymous Twitch chat when a
 * channel is configured. Chat failures only affect status, never emulation.
 */
export class ChatService {
  private readonly logger: Logger;
  private readonly listeners = new Set<ChatMessageListener>();
  private readonly selectSource: ChatSourceSelector;
  private recent: ChatMessage[] = [];
  private source: ChatSource | null = null;
  private received = 0;

  constructor(logger: Logger, options: ChatServiceOptions = {}) {
    this.logger = logger;
    this.selectSource = options.selectSource ?? (() => 'none');
  }

  async applyChannel(channel: string | null): Promise<void> {
    const normalized = channel ? normalizeTwitchChannel(channel) : null;
    const selection = this.selectSource(normalized);

    if (selection === 'fake') {
      await this.startFake();
      return;
    }
    if (selection === 'twitch' && normalized) {
      await this.startTwitch(normalized);
      return;
    }
    await this.close();
  }

  async startFake(): Promise<void> {
    if (this.source?.kind === 'fake' && this.source.connected) return;

    await this.close();
    const source = new FakeChatSource();
    this.source = source;
    await source.start((message) => this.record(message));
  }

  async startTwitch(channel: string): Promise<void> {
    const normalized = normalizeTwitchChannel(channel);
    if (!normalized) {
      this.logger.warn(`cannot start Twitch chat: invalid channel ${JSON.stringify(channel)}`);
      return;
    }

    if (this.source?.kind === 'twitch' && this.source.channel === normalized) return;

    await this.close();
    const source = new TwitchChatSource(normalized, this.logger);
    this.source = source;
    await source.start((message) => this.record(message));
  }

  async setFakeOutage(outage: boolean): Promise<void> {
    const source = this.source;
    if (!(source instanceof FakeChatSource)) {
      throw new ChatUnavailableError('Fake chat is not available');
    }

    if (outage) {
      source.stop();
      this.logger.warn('fake chat source disconnected (test outage)');
      return;
    }

    await source.start((message) => this.record(message));
    this.logger.info('fake chat source reconnected (test outage cleared)');
  }

  async close(): Promise<void> {
    const source = this.source;
    this.source = null;
    if (source) await source.stop();
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
