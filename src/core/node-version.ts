/**
 * Minimum supported Node.js version. 22.18 is the first 22.x release with
 * TypeScript type stripping enabled by default, which the dev and test
 * workflows rely on. Keep in sync with `engines.node` in package.json.
 */
export const MIN_NODE_VERSION = '22.18.0';

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parses `22.18.0` or `v22.18.0`; returns undefined for anything else. */
export function parseVersion(version: string): SemVer | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function isSupportedNodeVersion(version: string, minimum: string = MIN_NODE_VERSION): boolean {
  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  if (actual === undefined || required === undefined) {
    return false;
  }
  return compareVersions(actual, required) >= 0;
}
