import type { ChatMessage } from '../../shared/chat';
import type { ChatMessageListener, ChatSource } from './types';

/**
 * Development/test chat source. It has no network connection; the developer
 * panel and the test-only endpoint push messages into it explicitly.
 */
export class FakeChatSource implements ChatSource {
  readonly kind = 'fake' as const;

  private listener: ChatMessageListener | null = null;
  private running = false;

  get connected(): boolean {
    return this.running;
  }

  start(onMessage: ChatMessageListener): void {
    this.listener = onMessage;
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.listener = null;
  }

  inject(message: ChatMessage): void {
    if (!this.running || !this.listener) {
      throw new Error('Fake chat source is not running');
    }
    this.listener(message);
  }
}
