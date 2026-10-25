import type { EmulatorStatus } from './emulator-status';

export interface SettingsResponse {
  channel: string | null;
  romId: string | null;
  firstRun: boolean;
}

export interface SettingsSaveRequest {
  channel: string;
  romId: string;
}

export interface EmulatorOperationResponse {
  status: EmulatorStatus;
}

const TWITCH_CHANNEL_PATTERN = /^[A-Za-z0-9_]{2,25}$/;

/**
 * Accepts a channel name with surrounding whitespace or one leading `#`.
 * Returns null when the normalized value is not a valid Twitch login name.
 */
export function normalizeTwitchChannel(value: string): string | null {
  const normalized = value.trim().replace(/^#/, '').trim();
  return TWITCH_CHANNEL_PATTERN.test(normalized) ? normalized : null;
}
