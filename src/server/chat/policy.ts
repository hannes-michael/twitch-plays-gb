import type { ChatSourcePreference } from '../../shared/config';
import type { ChatSourceSelection } from './service';

export interface ChatSourcePolicyInput {
  dev: boolean;
  test: boolean;
  preference: ChatSourcePreference;
  channel: string | null;
}

/**
 * Test mode always uses the deterministic fake source. Development uses the
 * real anonymous Twitch source as soon as a channel is configured, so normal
 * `npm run dev` sessions interact with actual chat; with no channel it keeps
 * the fake source for the developer panel. `TPG_CHAT=fake` still forces fake
 * chat in development, and production never starts the fake source.
 */
export function selectChatSource(input: ChatSourcePolicyInput): ChatSourceSelection {
  if (input.test) return 'fake';
  if (input.preference === 'fake') return input.dev ? 'fake' : 'none';
  if (input.channel) return 'twitch';
  return input.dev ? 'fake' : 'none';
}
