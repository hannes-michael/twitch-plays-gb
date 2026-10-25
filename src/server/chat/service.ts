import { randomUUID } from 'node:crypto';
import { chatMessageInputSchema, type ChatMessage, type ChatStatus } from '../../shared/chat';
import type { Logger } from '../logger';
import { FakeChatSource } from './fake-source';
import type { ChatMessageListener, ChatSource } from './types';

const MAX_RECENT_MESSAGES = 100;

export class ChatInputError extends Error {
  constructor() {
    super('Invalid chat message');
    this.name = 'ChatInputError';
  }
}

export class ChatUnavailableError extends Error {
  constructor() {
    super('Fake chat is not available');
    this.name = 'ChatUnavailableError';
  }
}

/**
 * Owns the active chat source, a bounded recent-message log, and subscribers.
 * Only development/test mode starts a source; production reports source=none.
 */
export class ChatService {
  private readonly logger: Logger;
  private readonly listeners = new Set<ChatMessageListener>();
  private recent: ChatMessage[] = [];
  private source: ChatSource | null = null;
  private received = 0;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async startFake(): Promise<void> {
    if (this.source) return;
    const source = new FakeChatSource();
    this.source = source;
    await source.start((message) => this.record(message));
  }

  async close(): Promise<void> {
    const source = this.source;
    this.source = null;
    if (source) await source.stop();
  }

  getStatus(): ChatStatus {
    return {
      source: this.source ? this.source.kind : 'none',
      connected: this.source?.connected ?? false,
      messages: this.received,
    };
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
