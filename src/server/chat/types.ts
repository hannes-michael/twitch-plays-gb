import type { ChatMessage } from '../../shared/chat';

export type { ChatMessage, ChatStatus } from '../../shared/chat';

export type ChatMessageListener = (message: ChatMessage) => void;

/**
 * Event source contract for chat. The fake source is the only implementation
 * in P0; a Twitch IRC source can implement the same start/stop/callback shape.
 */
export interface ChatSource {
  readonly kind: 'fake';
  readonly connected: boolean;
  start(onMessage: ChatMessageListener): void | Promise<void>;
  stop(): void | Promise<void>;
}
