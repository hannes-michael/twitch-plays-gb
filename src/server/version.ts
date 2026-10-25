import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | undefined;

export function readPackageVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof (parsed as { version?: unknown }).version === 'string'
    ) {
      cachedVersion = (parsed as { version: string }).version;
      return cachedVersion;
    }
  } catch {
    // Fall through to a safe placeholder; the health endpoint must stay usable.
  }

  cachedVersion = '0.0.0';
  return cachedVersion;
}
