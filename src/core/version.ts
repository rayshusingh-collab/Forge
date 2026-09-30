import { readFileSync } from 'node:fs';

/**
 * Reads Forge's version from package.json. The relative path is valid from
 * both `src/core/` (dev) and `dist/core/` (build), which sit at the same depth.
 */
export function readForgeVersion(): string {
  const packageJsonUrl = new URL('../../package.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') {
    return parsed.version;
  }
  throw new Error('package.json does not contain a valid "version" field');
}
