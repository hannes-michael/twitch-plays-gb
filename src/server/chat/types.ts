import type { ChatMessage } from '../../shared/chat';

export type { ChatMessage, ChatStatus } from '../../shared/chat';

export type ChatMessageListener = (message: ChatMessage) => void;

/**
 * Event source contract for chat. Implementations must never throw into the
 * server or emulator when the network/job fails; they report connection state
 * instead.
 */
export interface ChatSource {
  readonly kind: 'fake' | 'twitch';
  readonly connected: boolean;
  readonly channel?: string;
  readonly lastError?: string;
  start(onMessage: ChatMessageListener): void | Promise<void>;
  stop(): void | Promise<void>;
}
