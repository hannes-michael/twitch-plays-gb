import { join } from 'node:path';
import { z } from 'zod';
import { normalizeTwitchChannel, type SettingsResponse } from '../shared/settings';
import type { Logger } from './logger';
import { readJsonFile, writeJsonAtomic } from './persistence';

const SettingsFileSchema = z.object({
  version: z.literal(1),
  channel: z.string().nullable(),
  romId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  updatedAt: z.string(),
});

type SettingsFile = z.infer<typeof SettingsFileSchema>;

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

/**
 * Persists the first-run choices. The public shape intentionally omits the
 * timestamp and every filesystem path.
 */
export class SettingsStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private file: SettingsFile = {
    version: 1,
    channel: null,
    romId: null,
    updatedAt: new Date(0).toISOString(),
  };

  constructor(dataDir: string, logger: Logger) {
    this.filePath = join(dataDir, 'settings.json');
    this.logger = logger;
  }

  async init(): Promise<void> {
    const raw = await readJsonFile(this.filePath);
    if (raw === undefined) return;

    const parsed = SettingsFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('settings file is invalid; starting with defaults');
      return;
    }

    this.file = parsed.data;
  }

  get(): SettingsResponse {
    return {
      channel: this.file.channel,
      romId: this.file.romId,
      firstRun: !this.file.channel || !this.file.romId,
    };
  }

  getRomId(): string | null {
    return this.file.romId;
  }

  async save(channel: string, romId: string): Promise<SettingsResponse> {
    const normalized = normalizeTwitchChannel(channel);
    if (!normalized) {
      throw new SettingsValidationError('Invalid Twitch channel');
    }

    const next: SettingsFile = {
      version: 1,
      channel: normalized,
      romId,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonAtomic(this.filePath, next);
    this.file = next;
    return this.get();
  }
}
