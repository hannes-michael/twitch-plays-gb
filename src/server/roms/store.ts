import { createHash } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { z } from 'zod';
import {
  MAX_ROM_BYTES,
  ROM_EXTENSIONS,
  type RomExtension,
  type RomMetadata,
} from '../../shared/roms';
import { readJsonFile, writeJsonAtomic } from '../persistence';
import type { Logger } from '../logger';

const NINTENDO_LOGO = Buffer.from([
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
  0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);

const GBA_NINTENDO_LOGO = Buffer.from([
  0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21, 0x3d, 0x84, 0x82, 0x0a, 0x84, 0xe4, 0x09, 0xad,
  0x11, 0x24, 0x8b, 0x98, 0xc0, 0x81, 0x7f, 0x21, 0xa3, 0x52, 0xbe, 0x19, 0x93, 0x09, 0xce, 0x20,
  0x10, 0x46, 0x4a, 0x4a, 0xf8, 0x27, 0x31, 0xec, 0x58, 0xc7, 0xe8, 0x33, 0x82, 0xe3, 0xce, 0xbf,
  0x85, 0xf4, 0xdf, 0x94, 0xce, 0x4b, 0x09, 0xc1, 0x94, 0x56, 0x8a, 0xc0, 0x13, 0x72, 0xa7, 0xfc,
  0x9f, 0x84, 0x4d, 0x73, 0xa3, 0xca, 0x9a, 0x61, 0x58, 0x97, 0xa3, 0x27, 0xfc, 0x03, 0x98, 0x76,
  0x23, 0x1d, 0xc7, 0x61, 0x03, 0x04, 0xae, 0x56, 0xbf, 0x38, 0x84, 0x00, 0x40, 0xa7, 0x0e, 0xfd,
  0xff, 0x52, 0xfe, 0x03, 0x6f, 0x95, 0x30, 0xf1, 0x97, 0xfb, 0xc0, 0x85, 0x60, 0xd6, 0x80, 0x25,
  0xa9, 0x63, 0xbe, 0x03, 0x01, 0x4e, 0x38, 0xe2, 0xf9, 0xa2, 0x34, 0xff, 0xbb, 0x3e, 0x03, 0x44,
  0x78, 0x00, 0x90, 0xcb, 0x88, 0x11, 0x3a, 0x94, 0x65, 0xc0, 0x7c, 0x63, 0x87, 0xf0, 0x3c, 0xaf,
  0xd6, 0x25, 0xe4, 0x8b, 0x38, 0x0a, 0xac, 0x72, 0x21, 0xd4, 0xf8, 0x07,
]);

const MIN_ROM_BYTES = 32 * 1024;

const ROM_EXTENSION_SET = new Set<string>(ROM_EXTENSIONS);
const ROM_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_DISPLAY_NAME = 120;
const MAX_TITLE = 64;

const RomMetadataSchema = z.object({
  id: z.string().regex(ROM_ID_PATTERN),
  name: z.string().min(1).max(MAX_DISPLAY_NAME),
  title: z.string().min(1).max(MAX_TITLE),
  model: z.enum(['DMG', 'CGB', 'AGB', 'SGB']),
  platform: z.enum(['GB/GBC', 'GBA']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  extension: z.enum(ROM_EXTENSIONS),
  size: z.number().int().positive(),
  importedAt: z.string(),
});

const RomIndexSchema = z.object({
  version: z.literal(1),
  roms: z.array(RomMetadataSchema),
});

export interface RomImportResult {
  rom: RomMetadata;
  created: boolean;
}

export class RomImportError extends Error {
  readonly statusCode: 400 | 413;

  constructor(message: string, statusCode: 400 | 413 = 400) {
    super(message);
    this.name = 'RomImportError';
    this.statusCode = statusCode;
  }
}

interface HeaderInfo {
  title: string;
  model: RomMetadata['model'];
  platform: RomMetadata['platform'];
  width: number;
  height: number;
}

function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code >= 0x20 && code !== 0x7f ? character : ' ';
  }
  return result;
}

function sanitizeText(value: string, maxLength: number): string {
  return stripControlCharacters(value)
    .replace(/[/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function readHeaderTitle(rom: Buffer, start: number, end: number): string {
  const raw = rom.subarray(start, end).toString('latin1');
  const nullIndex = raw.indexOf('\0');
  return sanitizeText(nullIndex === -1 ? raw : raw.slice(0, nullIndex), MAX_TITLE);
}

function validateGbHeader(rom: Buffer, fallbackTitle: string): HeaderInfo {
  if (rom.length < MIN_ROM_BYTES) {
    throw new RomImportError('Invalid ROM: file is smaller than the 32 KiB minimum');
  }

  if (!rom.subarray(0x104, 0x134).equals(NINTENDO_LOGO)) {
    throw new RomImportError('Invalid ROM: Nintendo logo header is missing or corrupt');
  }

  const cgb = (rom[0x143] & 0x80) !== 0;
  const title =
    readHeaderTitle(rom, 0x134, 0x13f) ||
    readHeaderTitle(rom, 0x134, 0x144) ||
    fallbackTitle;

  return {
    title,
    model: cgb ? 'CGB' : 'DMG',
    platform: 'GB/GBC',
    width: 160,
    height: 144,
  };
}

function validateGbaHeader(rom: Buffer, fallbackTitle: string): HeaderInfo {
  if (rom.length < MIN_ROM_BYTES) {
    throw new RomImportError('Invalid ROM: file is smaller than the 32 KiB minimum');
  }

  if (!rom.subarray(0x04, 0xa0).equals(GBA_NINTENDO_LOGO)) {
    throw new RomImportError('Invalid ROM: GBA Nintendo logo header is missing or corrupt');
  }

  if (rom[0xb2] !== 0x96) {
    throw new RomImportError('Invalid ROM: GBA fixed header value is missing');
  }

  return {
    title: readHeaderTitle(rom, 0xa0, 0xac) || fallbackTitle,
    model: 'AGB',
    platform: 'GBA',
    width: 240,
    height: 160,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Owns imported ROM files and their persisted metadata.
 *
 * Client filenames are never used on disk. The content hash is the id, and the
 * only disk name is `<sha256>.<validated-extension>`.
 */
export class RomStore {
  private readonly romsDir: string;
  private readonly indexPath: string;
  private readonly logger: Logger;
  private roms: RomMetadata[] = [];
  private importQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string, logger: Logger) {
    this.romsDir = join(dataDir, 'roms');
    this.indexPath = join(dataDir, 'roms.json');
    this.logger = logger;
  }

  async init(): Promise<void> {
    await mkdir(this.romsDir, { recursive: true });

    let raw: unknown;
    try {
      raw = await readJsonFile(this.indexPath);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.logger.warn('ROM index is invalid; starting with an empty ROM library');
      this.roms = [];
      return;
    }

    if (raw === undefined) {
      this.roms = [];
      return;
    }

    const parsed = RomIndexSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('ROM index is invalid; starting with an empty ROM library');
      this.roms = [];
      return;
    }

    this.roms = parsed.data.roms;
  }

  list(): RomMetadata[] {
    return this.roms.map((rom) => ({ ...rom }));
  }

  get(id: string): RomMetadata | null {
    if (!ROM_ID_PATTERN.test(id)) return null;
    const rom = this.roms.find((entry) => entry.id === id);
    return rom ? { ...rom } : null;
  }

  getPath(id: string): string | null {
    const rom = this.get(id);
    return rom ? join(this.romsDir, `${rom.id}${rom.extension}`) : null;
  }

  importRom(buffer: Buffer, originalFilename: string | undefined): Promise<RomImportResult> {
    // Serializing the whole import (validation, dedupe check, write, index)
    // prevents concurrent identical uploads from each observing an empty index.
    return this.enqueueImport(() => this.importRomInternal(buffer, originalFilename));
  }

  private enqueueImport<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.importQueue.then(operation, operation);
    this.importQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async importRomInternal(
    buffer: Buffer,
    originalFilename: string | undefined,
  ): Promise<RomImportResult> {
    if (!originalFilename) {
      throw new RomImportError('Missing x-filename header');
    }

    const clientName = originalFilename.split(/[\\/]/).pop()?.trim() ?? '';
    if (!clientName) {
      throw new RomImportError('Invalid x-filename header');
    }

    const extension = extname(clientName).toLowerCase();
    if (!ROM_EXTENSION_SET.has(extension)) {
      throw new RomImportError('Invalid ROM extension: expected .gb, .gbc, or .gba');
    }

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new RomImportError('ROM file is empty');
    }
    if (buffer.length > MAX_ROM_BYTES) {
      throw new RomImportError('ROM file exceeds the 32 MiB limit', 413);
    }

    const name =
      sanitizeText(clientName.slice(0, clientName.length - extension.length), MAX_DISPLAY_NAME) ||
      sanitizeText(clientName, MAX_DISPLAY_NAME) ||
      'rom';

    const header =
      extension === '.gba' ? validateGbaHeader(buffer, name) : validateGbHeader(buffer, name);

    const id = createHash('sha256').update(buffer).digest('hex');
    const existing = this.roms.find((rom) => rom.id === id);

    if (existing) {
      const existingPath = join(this.romsDir, `${existing.id}${existing.extension}`);
      if (!(await fileExists(existingPath))) {
        await writeFile(existingPath, buffer, { mode: 0o644 });
      }
      return { rom: { ...existing }, created: false };
    }

    const romPath = join(this.romsDir, `${id}${extension}`);
    const metadata: RomMetadata = {
      id,
      name,
      title: header.title,
      model: header.model,
      platform: header.platform,
      width: header.width,
      height: header.height,
      extension: extension as RomExtension,
      size: buffer.length,
      importedAt: new Date().toISOString(),
    };

    await writeFile(romPath, buffer, { mode: 0o644 });
    this.roms.push(metadata);

    try {
      await writeJsonAtomic(this.indexPath, { version: 1, roms: this.roms });
    } catch (error) {
      this.roms.pop();
      await rm(romPath, { force: true }).catch(() => {});
      throw error;
    }

    return { rom: { ...metadata }, created: true };
  }
}
