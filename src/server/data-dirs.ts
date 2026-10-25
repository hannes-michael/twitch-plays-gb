import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_SUBDIRS = ['roms', 'saves', 'states'] as const;

export interface DataLayout {
  romsDir: string;
  savesDir: string;
  statesDir: string;
}

/** Creates the fixed data layout. No client input participates in these paths. */
export function ensureDataLayout(dataDir: string): DataLayout {
  const layout: DataLayout = {
    romsDir: join(dataDir, 'roms'),
    savesDir: join(dataDir, 'saves'),
    statesDir: join(dataDir, 'states'),
  };

  for (const directory of Object.values(layout)) {
    mkdirSync(directory, { recursive: true });
  }

  return layout;
}
