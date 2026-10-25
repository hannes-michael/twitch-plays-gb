import { randomUUID } from 'node:crypto';
import { ChatClient } from '@twurple/chat';
import type { ChatRoles } from '../../shared/chat';
import type { Logger } from '../logger';
import type { ChatMessageListener, ChatSource } from './types';

const BOT_USERNAMES = new Set([
  'nightbot',
  'streamelements',
  'streamlabs',
  'moobot',
  'fossabot',
  'commanderroot',
  'sery_bot',
]);

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 300) || 'Twitch chat connection failed';
}

function receivedAt(message: { date?: Date }): string {
  const date = message.date;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/**
 * Anonymous, read-only Twitch IRC source. No OAuth token or channel write
 * permission is involved. Twurple owns reconnect attempts; this source only
 * reports the resulting connect/disconnect/error state.
 */
export class TwitchChatSource implements ChatSource {
  readonly kind = 'twitch' as const;
  readonly channel: string;

  private readonly logger: Logger;
  private listener: ChatMessageListener | null = null;
  private client: ChatClient | null = null;
  private isConnected = false;
  private lastErr: string | undefined;

  constructor(channel: string, logger: Logger) {
    this.channel = channel;
    this.logger = logger;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get lastError(): string | undefined {
    return this.lastErr;
  }

  start(onMessage: ChatMessageListener): void {
    if (this.client) return;

    this.listener = onMessage;
    const client = new ChatClient({ channels: [this.channel] });
    this.client = client;

    client.onConnect(() => {
      this.isConnected = true;
      this.lastErr = undefined;
      this.logger.info(`twitch chat connected to #${this.channel} (anonymous)`);
    });

    client.onDisconnect((_manual, reason) => {
      this.isConnected = false;
      this.lastErr = reason ? errorMessage(reason) : undefined;
      this.logger.warn(
        `twitch chat disconnected from #${this.channel}${reason ? `: ${errorMessage(reason)}` : ''}`,
      );
    });

    client.onMessage((_channel, user, text, message) => {
      const listener = this.listener;
      if (!listener) return;

      const roles: ChatRoles = {
        broadcaster: message.userInfo.isBroadcaster,
        mod: message.userInfo.isMod,
        vip: message.userInfo.isVip,
        bot: BOT_USERNAMES.has(user.toLowerCase()) || message.userInfo.badges.has('bot'),
      };

      try {
        listener({
          id: message.id || randomUUID(),
          user,
          text,
          receivedAt: receivedAt(message),
          channel: this.channel,
          roles,
        });
      } catch (error) {
        // A consumer bug must never escape into Twurple's IRC event loop.
        this.logger.warn(`twitch chat message listener failed: ${errorMessage(error)}`);
      }
    });

    try {
      client.connect();
      this.logger.info(`connecting anonymously to twitch chat #${this.channel}`);
    } catch (error) {
      this.isConnected = false;
      this.lastErr = errorMessage(error);
      this.logger.warn(`twitch chat connect failed: ${this.lastErr}`);
    }
  }

  stop(): void {
    const client = this.client;
    this.client = null;
    this.listener = null;
    this.isConnected = false;
    this.lastErr = undefined;

    if (!client) return;
    try {
      client.quit();
    } catch (error) {
      this.logger.debug(`twitch chat quit failed: ${errorMessage(error)}`);
    }
  }
}

export { BOT_USERNAMES };
