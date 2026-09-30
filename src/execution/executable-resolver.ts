import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Resolves an executable name to an absolute program that the no-shell
 * `ProcessRunner` can launch directly.
 *
 * Why: on Windows, `.cmd`/`.bat` launchers (e.g. those npm creates for global
 * packages) can only run through `cmd.exe`, whose argument parsing makes
 * passing untrusted text unsafe. Instead of enabling a shell, npm "cmd-shim"
 * launchers are parsed to find the program they wrap, which is then launched
 * directly. Unrecognized `.cmd`/`.bat` files are refused, never shell-executed.
 *
 * Search rules:
 * - Bare names are looked up only in absolute `PATH` entries. The current
 *   directory and relative entries are never searched, so a file planted in
 *   a project cannot shadow a real tool.
 * - On Windows, candidates are tried with the `PATHEXT` extensions Forge can
 *   run: `.exe`, `.com`, `.cmd`, `.bat`.
 * - Explicit paths must be absolute.
 */

export type ExecutableKind = 'native' | 'node-script';

export interface ResolvedExecutable {
  /** Absolute program to spawn. */
  readonly command: string;
  /** Arguments to place before the caller's arguments (e.g. the wrapped script). */
  readonly prefixArgs: readonly string[];
  /** The file that was found (the launcher itself when a shim was unwrapped). */
  readonly source: string;
  readonly kind: ExecutableKind;
}

export type ExecutableResolution =
  | { readonly ok: true; readonly executable: ResolvedExecutable }
  | { readonly ok: false; readonly reason: 'not-found' | 'unsupported' | 'invalid'; readonly message: string };

export interface ResolveExecutableOptions {
  /** Environment providing `PATH` (and `PATHEXT` on Windows). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Overrides platform-specific lookup rules (tests). */
  readonly platform?: NodeJS.Platform;
  /** Node used to run wrapped scripts when the shim does not ship its own `node.exe`. */
  readonly nodeExecutable?: string;
}

const WINDOWS_RUNNABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'];
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

/** Shims larger than this are not npm cmd-shims. */
const MAX_SHIM_BYTES = 64 * 1024;

/**
 * Matches the wrapped target in npm cmd-shim launchers, in both the current
 * (`"%dp0%\..."`) and older (`"%~dp0\..."`) formats, e.g.:
 *   "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
 *   "%dp0%\node_modules\pkg\bin\tool.exe"   %*
 */
const SHIM_TARGET = /"(?:%dp0%|%~dp0)\\?([^"%\r\n]+\.(?:js|cjs|mjs|exe))"\s*%\*/gi;

export async function resolveExecutable(
  nameOrPath: string,
  options: ResolveExecutableOptions = {},
): Promise<ExecutableResolution> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;

  if (typeof nameOrPath !== 'string' || nameOrPath.trim() === '' || nameOrPath.includes('\0')) {
    return invalid('Executable name must be a non-empty string');
  }

  if (/[\\/]/.test(nameOrPath)) {
    if (!isAbsolute(nameOrPath)) {
      return invalid(`Executable path must be absolute: ${nameOrPath}`);
    }
    const path = normalize(nameOrPath);
    // On Windows an extensionless explicit path (e.g. node_modules/.bin/tsc,
    // which is a POSIX shell script) is tried with PATHEXT first, as Windows would.
    if (platform === 'win32' && !WINDOWS_RUNNABLE_EXTENSIONS.includes(extname(path).toLowerCase())) {
      for (const extension of pathExtensions(env)) {
        if (await isRunnableFile(`${path}${extension}`, platform)) {
          return classify(`${path}${extension}`, platform, nodeExecutable);
        }
      }
    }
    if (!(await isRunnableFile(path, platform))) {
      return { ok: false, reason: 'not-found', message: `Executable not found: ${path}` };
    }
    return classify(path, platform, nodeExecutable);
  }

  if (!BARE_NAME.test(nameOrPath)) {
    return invalid(`Executable name contains unsupported characters: ${nameOrPath}`);
  }

  for (const candidate of candidatePaths(nameOrPath, env, platform)) {
    if (await isRunnableFile(candidate, platform)) {
      return classify(candidate, platform, nodeExecutable);
    }
  }
  return { ok: false, reason: 'not-found', message: `"${nameOrPath}" was not found on PATH` };
}

function candidatePaths(name: string, env: ResolveExecutableOptions['env'] & object, platform: NodeJS.Platform): string[] {
  const directories = (env['PATH'] ?? env['Path'] ?? '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '' && isAbsolute(entry));

  if (platform !== 'win32') {
    return directories.map((directory) => join(directory, name));
  }

  const extensions = pathExtensions(env);
  const hasRunnableExtension = WINDOWS_RUNNABLE_EXTENSIONS.includes(extname(name).toLowerCase());

  const candidates: string[] = [];
  for (const directory of directories) {
    if (hasRunnableExtension) {
      candidates.push(join(directory, name));
    }
    for (const extension of extensions) {
      candidates.push(join(directory, `${name}${extension}`));
    }
  }
  return candidates;
}

/** PATHEXT extensions Forge can run without a shell, in PATHEXT order. */
function pathExtensions(env: ResolveExecutableOptions['env'] & object): string[] {
  return (env['PATHEXT'] ?? DEFAULT_PATHEXT)
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => WINDOWS_RUNNABLE_EXTENSIONS.includes(extension));
}

async function isRunnableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) {
      return false;
    }
    if (platform !== 'win32' && !SCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) {
      await access(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

async function classify(path: string, platform: NodeJS.Platform, nodeExecutable: string): Promise<ExecutableResolution> {
  const extension = extname(path).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return ok({ command: nodeExecutable, prefixArgs: [path], source: path, kind: 'node-script' });
  }
  if (platform !== 'win32' || extension === '.exe' || extension === '.com') {
    return ok({ command: path, prefixArgs: [], source: path, kind: 'native' });
  }
  if (extension === '.cmd' || extension === '.bat') {
    return unwrapCmdShim(path, nodeExecutable);
  }
  return { ok: false, reason: 'unsupported', message: `Cannot run ${path} without a shell` };
}

async function unwrapCmdShim(shimPath: string, nodeExecutable: string): Promise<ExecutableResolution> {
  const unsupported = (why: string): ExecutableResolution => ({
    ok: false,
    reason: 'unsupported',
    message: `${shimPath} is a batch launcher that Forge cannot run safely without a shell (${why}). ` +
      'Point Forge at the underlying executable instead.',
  });

  let content: string;
  try {
    if ((await stat(shimPath)).size > MAX_SHIM_BYTES) {
      return unsupported('file too large to be an npm launcher');
    }
    content = await readFile(shimPath, 'utf8');
  } catch {
    return unsupported('unreadable');
  }

  const targets = new Set<string>();
  for (const match of content.matchAll(SHIM_TARGET)) {
    if (match[1] !== undefined) {
      targets.add(match[1]);
    }
  }
  if (targets.size === 0) {
    const npmLauncherTarget = findNpmLauncherTarget(content);
    if (npmLauncherTarget !== undefined) {
      targets.add(npmLauncherTarget);
    }
  }
  if (targets.size !== 1) {
    return unsupported(targets.size === 0 ? 'not an npm launcher' : 'ambiguous launcher target');
  }

  const shimDirectory = dirname(shimPath);
  const relativeTarget = [...targets][0]!.split(/[\\/]+/).join(sep);
  const target = normalize(join(shimDirectory, relativeTarget));
  try {
    if (!(await stat(target)).isFile()) {
      return unsupported(`launcher target is not a file: ${target}`);
    }
  } catch {
    return unsupported(`launcher target does not exist: ${target}`);
  }

  if (extname(target).toLowerCase() === '.exe') {
    return ok({ command: target, prefixArgs: [], source: shimPath, kind: 'native' });
  }
  // npm shims prefer a node.exe shipped beside them, else `node` from PATH;
  // Forge uses its own Node rather than whichever `node` PATH yields.
  const bundledNode = join(shimDirectory, 'node.exe');
  const node = (await stat(bundledNode).then((info) => info.isFile()).catch(() => false)) ? bundledNode : nodeExecutable;
  return ok({ command: node, prefixArgs: [target], source: shimPath, kind: 'node-script' });
}

/**
 * npm's own launchers (`npm.cmd`, `npx.cmd` in the Node.js directory) use a
 * different, fixed structure:
 *   SET "NODE_EXE=%~dp0\node.exe"
 *   SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"
 *   ...optional prefix override computed at run time...
 *   "%NODE_EXE%" "%NPM_CLI_JS%" %*
 * The script named in the final line is taken from its `%~dp0`-relative
 * assignment. The run-time prefix override (a globally updated npm) is
 * deliberately not evaluated: Forge runs the npm that ships beside this
 * launcher, deterministically.
 */
function findNpmLauncherTarget(content: string): string | undefined {
  const invocation = /^\s*"%NODE_EXE%"\s+"%([A-Z_]+)%"\s+%\*\s*$/im.exec(content);
  if (invocation === null) {
    return undefined;
  }
  const variable = invocation[1]!;
  const assignment = new RegExp(`^\\s*SET\\s+"${variable}=%~dp0\\\\?([^"%\\r\\n]+\\.(?:js|cjs|mjs))"\\s*$`, 'im').exec(content);
  return assignment?.[1];
}

function ok(executable: ResolvedExecutable): ExecutableResolution {
  return { ok: true, executable };
}

function invalid(message: string): ExecutableResolution {
  return { ok: false, reason: 'invalid', message };
}
