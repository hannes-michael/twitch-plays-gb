import type { EmulatorModel, EmulatorPlatform } from './emulator-status';

export const ROM_EXTENSIONS = ['.gb', '.gbc', '.gba'] as const;
export type RomExtension = (typeof ROM_EXTENSIONS)[number];

export const MAX_ROM_BYTES = 32 * 1024 * 1024;

/**
 * Browser-safe ROM metadata. Deliberately contains no filesystem path: clients
 * identify ROMs by the content hash and the server owns all disk locations.
 */
export interface RomMetadata {
  id: string;
  name: string;
  title: string;
  model: EmulatorModel;
  platform: EmulatorPlatform;
  width: number;
  height: number;
  extension: RomExtension;
  size: number;
  importedAt: string;
}

export interface RomListResponse {
  roms: RomMetadata[];
}

export interface RomImportResponse {
  rom: RomMetadata;
  created: boolean;
}

export interface RomResponse {
  rom: RomMetadata;
}
