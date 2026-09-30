/**
 * What AI roles may see. A conservative, path-based deny policy applied on
 * top of Git's own ignore rules. It reduces the chance of sending secrets;
 * it cannot guarantee it (a secret pasted into ordinary source code is not
 * detectable by path).
 */

export type PathVerdict = 'allowed' | 'sensitive' | 'protected' | 'generated' | 'binary';

/** Directories never read: Forge/Git control data, dependencies, build output, caches. */
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.forge',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.terraform',
  '.cache',
]);

/** Directories that commonly hold credentials. */
const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', 'secrets', '.secrets']);

const SENSITIVE_NAMES: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\.(?!example$|sample$|template$)/,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|kdbx|asc|gpg|ppk|ovpn)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^(\.npmrc|\.yarnrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.htpasswd|\.dockercfg|\.pgpass|\.s3cfg)$/,
  /^(credentials?|secrets?)(\.[a-z0-9]+)?$/,
  /\.(secret|secrets)$/,
  /^service[-_]?account.*\.json$/,
  /\.(tfvars|tfstate)(\.backup)?$/,
  /^(auth|token|tokens)\.json$/,
];

/** Large generated files: listed in the tree, contents never sent. */
const GENERATED_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tif', 'tiff', 'psd', 'svgz',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'class', 'wasm', 'pyc',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'ogg', 'mov', 'avi', 'webm',
  'sqlite', 'db', 'mdb', 'iso', 'dmg',
]);

export function classifyPath(path: string): PathVerdict {
  const segments = path.split('/');
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  const name = segments.at(-1)!.toLowerCase();
  if (directories.some((directory) => directory === '.git' || directory === '.forge') || name === '.git') {
    return 'protected';
  }
  if (directories.some((directory) => SENSITIVE_DIRECTORIES.has(directory)) || SENSITIVE_NAMES.some((pattern) => pattern.test(name))) {
    return 'sensitive';
  }
  if (directories.some((directory) => EXCLUDED_DIRECTORIES.has(directory)) || GENERATED_NAMES.has(name) || name.endsWith('.min.js') || name.endsWith('.map')) {
    return 'generated';
  }
  const extension = name.includes('.') ? name.split('.').at(-1)! : '';
  return BINARY_EXTENSIONS.has(extension) ? 'binary' : 'allowed';
}

/** True if a path may appear in the file tree sent to an AI role (contents are decided separately). */
export function listableInTree(verdict: PathVerdict): boolean {
  return verdict === 'allowed' || verdict === 'generated' || verdict === 'binary';
}

/** Content sniff: NUL bytes mean binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8_192).includes(0);
}
