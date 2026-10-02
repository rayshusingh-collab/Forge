import { join } from 'node:path';

import { ProjectConfigError } from '../core/errors.ts';
import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import { ORCHESTRATION_LIMITS, acquireFileLock, readJsonDocument, serializeJson, writeFileAtomic } from '../state/index.ts';

/**
 * Project configuration: `.forge/config.json`, machine-local like the rest
 * of `.forge/`. It holds human-chosen DEFAULTS for roles and orchestration;
 * it never holds credentials, and it is only changed by `forge config`
 * (or a human editing the file, which Forge then validates strictly).
 *
 * Keys are a fixed, flat, typed list. Unknown keys, wrong types,
 * out-of-range values, nested paths, and credential-like keys or values are
 * refused. The file is protected Forge metadata: workers changing it
 * trigger the `.forge/` integrity guard.
 *
 * Precedence for every orchestration setting:
 *   hard safety limits (never overridable)
 *     > explicit CLI option
 *     > project configuration (this file)
 *     > environment (timeouts only: FORGE_WORKER_TIMEOUT_MS)
 *     > Forge's conservative default
 */

export const PROJECT_CONFIG_FILE = 'config.json';
export const PROJECT_CONFIG_VERSION = 1;

type SettingSpec =
  | { readonly type: 'boolean'; readonly default: boolean; readonly description: string }
  | { readonly type: 'integer'; readonly min: number; readonly max: number; readonly default: number | null; readonly description: string }
  | { readonly type: 'provider'; readonly default: string; readonly description: string };

export const SETTINGS = {
  'providers.implementer': { type: 'provider', default: 'claude', description: 'Implementer (worker) for task attempts' },
  'providers.planner': { type: 'provider', default: 'claude', description: 'AI planner for `forge plan create`' },
  'providers.reviewer': { type: 'provider', default: 'claude', description: 'AI reviewer for `forge task review` and `forge run --review`' },
  'providers.decisionMaker': { type: 'provider', default: 'claude', description: 'AI decision-maker for `forge run --auto-decide`' },
  'run.allowEdits': { type: 'boolean', default: false, description: 'Implementer may modify files during `forge run`' },
  'run.maxTasks': { type: 'integer', min: 1, max: ORCHESTRATION_LIMITS.maxTasks, default: 5, description: 'Distinct tasks per run' },
  'run.maxSteps': { type: 'integer', min: 1, max: ORCHESTRATION_LIMITS.maxSteps, default: 30, description: 'Workflow steps per run' },
  'run.repairOnValidationFailure': { type: 'boolean', default: false, description: 'Repair after failed deterministic validation' },
  'run.repairOnBlockingReview': { type: 'boolean', default: false, description: 'Repair after blocking review concerns (requires run.review)' },
  'run.maxRepairsPerTask': { type: 'integer', min: 0, max: ORCHESTRATION_LIMITS.maxRepairsPerTask, default: 2, description: 'Repairs per task, across runs' },
  'run.review': { type: 'boolean', default: false, description: 'Advisory AI review of every validated task' },
  'run.continueOnConcerns': { type: 'boolean', default: false, description: 'Do not stop for review warnings' },
  'run.continueWithoutReview': { type: 'boolean', default: false, description: 'Continue unreviewed when the reviewer is unavailable' },
  'run.autoDecide': { type: 'boolean', default: false, description: 'Let the AI decision-maker accept, reject or escalate review concerns (requires run.review)' },
  'run.autoCommit': { type: 'boolean', default: false, description: 'Commit validated tasks locally (never pushes)' },
  'run.workerTimeoutSeconds': { type: 'integer', min: 1, max: 86_400, default: null, description: 'Implementer timeout per attempt (default: FORGE_WORKER_TIMEOUT_MS)' },
  'run.reviewTimeoutSeconds': { type: 'integer', min: 1, max: 86_400, default: null, description: 'Reviewer timeout (default: the worker timeout)' },
  'run.decisionTimeoutSeconds': { type: 'integer', min: 1, max: 86_400, default: null, description: 'Decision-maker timeout (default: the reviewer timeout)' },
  'run.autonomous': {
    type: 'boolean',
    default: false,
    description: 'Hands-off mode: handle recoverable events (timeouts, provider failures, truncated evidence, repairs) within bounded budgets; hard stops unchanged',
  },
  'run.timeoutRecoveries': {
    type: 'integer',
    min: 0,
    max: ORCHESTRATION_LIMITS.maxTimeoutRecoveries,
    default: null,
    description: 'Continuations of a timed-out attempt per task (default: 2 when autonomous, else 0)',
  },
  'run.timeoutIncreaseSeconds': { type: 'integer', min: 0, max: 86_400, default: null, description: 'Worker timeout added per timeout recovery (default: half the worker timeout when autonomous)' },
  'run.maxWorkerTimeoutSeconds': { type: 'integer', min: 1, max: 86_400, default: null, description: 'Hard cap on a recovery\'s worker timeout (default: twice the worker timeout when autonomous)' },
  'run.providerRetries': {
    type: 'integer',
    min: 0,
    max: ORCHESTRATION_LIMITS.maxProviderRetries,
    default: null,
    description: 'Retries after transient provider failures (default: 2 when autonomous, else 0)',
  },
  'run.retryBackoffSeconds': {
    type: 'integer',
    min: 0,
    max: ORCHESTRATION_LIMITS.maxRetryBackoffMs / 1000,
    default: null,
    description: 'Wait before the Nth provider retry: N × this (default: 5 when autonomous, else 0)',
  },
  'run.evidenceReviews': {
    type: 'integer',
    min: 0,
    max: ORCHESTRATION_LIMITS.maxEvidenceReviews,
    default: null,
    description: 'Re-reviews with expanded evidence per attempt (default: 1 when autonomous, else 0)',
  },
} as const satisfies Readonly<Record<string, SettingSpec>>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue = string | number | boolean;
export type ProjectSettings = Readonly<Partial<Record<SettingKey, SettingValue>>>;

export interface ProjectConfig {
  readonly schemaVersion: typeof PROJECT_CONFIG_VERSION;
  readonly settings: ProjectSettings;
  readonly updatedAt: string | null;
}

export const EMPTY_PROJECT_CONFIG: ProjectConfig = { schemaVersion: PROJECT_CONFIG_VERSION, settings: {}, updatedAt: null };

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Key names that suggest someone is trying to store a credential. */
const CREDENTIAL_KEY = /pass(word)?|secret|token|api[-_.]?key|credential|auth|private[-_.]?key|cookie|session/i;
/** Value shapes of common credentials (API keys, tokens). */
const CREDENTIAL_VALUE = /^(sk|pk|rk)-|^gh[pousr]_|^xox[abpr]-|^akia|^glpat-|^eyj[a-z0-9_-]{10,}/i;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

/** Explains why `key` is not settable (credential-like keys get a specific refusal). */
export function describeUnknownKey(key: string): string {
  if (CREDENTIAL_KEY.test(key)) {
    return `"${key}" looks like a credential; Forge configuration never stores secrets (use environment variables)`;
  }
  return `Unknown configuration key "${key}"; known keys: ${Object.keys(SETTINGS).join(', ')}`;
}

/** Strict parsing of a value given on the command line. */
export function parseSettingValue(key: SettingKey, text: string): SettingValue {
  const spec: SettingSpec = SETTINGS[key];
  const value = text.trim();
  switch (spec.type) {
    case 'boolean':
      if (value !== 'true' && value !== 'false') {
        throw new ProjectConfigError(`${key} must be true or false`);
      }
      return value === 'true';
    case 'integer': {
      if (!/^\d{1,6}$/.test(value)) {
        throw new ProjectConfigError(`${key} must be a whole number between ${spec.min} and ${spec.max}`);
      }
      return checkSetting(key, Number(value));
    }
    case 'provider':
      return checkSetting(key, value);
  }
}

/** Validates a typed value against its key's rules (also used when loading the file). */
export function checkSetting(key: SettingKey, value: unknown): SettingValue {
  const spec: SettingSpec = SETTINGS[key];
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new ProjectConfigError(`${key} must be true or false`);
      }
      return value;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
        throw new ProjectConfigError(`${key} must be a whole number between ${spec.min} and ${spec.max} (hard limit)`);
      }
      return value;
    case 'provider':
      if (typeof value !== 'string' || CREDENTIAL_VALUE.test(value)) {
        throw new ProjectConfigError(`${key} looks like a credential, not a provider name; Forge configuration never stores secrets`);
      }
      if (!PROVIDER_PATTERN.test(value)) {
        throw new ProjectConfigError(`${key} must be a provider name (lower-case letters, digits, "-"; at most 32 characters)`);
      }
      return value;
  }
}

export function decodeProjectConfig(raw: unknown): ProjectConfig {
  const r = new ObjectReader(raw, '', ['schemaVersion', 'settings', 'updatedAt']);
  if (r.integer('schemaVersion') !== PROJECT_CONFIG_VERSION) {
    throw new SchemaViolation('schemaVersion', `must be ${PROJECT_CONFIG_VERSION}`);
  }
  const settings: Partial<Record<SettingKey, SettingValue>> = {};
  const value = r.field('settings', (item, path) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SchemaViolation(path, 'must be an object');
    }
    return item as Record<string, unknown>;
  });
  for (const [key, item] of Object.entries(value)) {
    if (!isSettingKey(key)) {
      throw new SchemaViolation('settings:', describeUnknownKey(key));
    }
    try {
      settings[key] = checkSetting(key, item);
    } catch (error) {
      throw new SchemaViolation('settings:', error instanceof Error ? error.message : String(error));
    }
  }
  return { schemaVersion: PROJECT_CONFIG_VERSION, settings, updatedAt: r.nullableTimestamp('updatedAt') };
}

export class ProjectConfigStore {
  readonly file: string;
  private readonly lockFile: string;
  private readonly clock: () => Date;

  constructor(layout: { readonly forgeDir: string; readonly lockFile: string }, options: { readonly clock?: () => Date } = {}) {
    this.file = join(layout.forgeDir, PROJECT_CONFIG_FILE);
    this.lockFile = layout.lockFile;
    this.clock = options.clock ?? (() => new Date());
  }

  /** The configuration, or the empty configuration when the file does not exist. Invalid files are refused, never repaired. */
  async load(): Promise<ProjectConfig> {
    let raw: unknown;
    try {
      raw = await readJsonDocument(this.file, 'Project configuration');
    } catch (error) {
      throw new ProjectConfigError(`Project configuration is unreadable: ${error instanceof Error ? error.message : String(error)}. Fix .forge/config.json, or delete it to return to the defaults.`, { cause: error });
    }
    if (raw === undefined) {
      return EMPTY_PROJECT_CONFIG;
    }
    try {
      return decodeProjectConfig(raw);
    } catch (error) {
      if (error instanceof SchemaViolation) {
        throw new ProjectConfigError(`Project configuration is invalid (${this.file}): ${error.message}. Fix it with \`forge config reset <key>\` or edit the file.`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async exists(): Promise<boolean> {
    return (await readJsonDocument(this.file, 'Project configuration').catch(() => null)) !== undefined;
  }

  /** Writes the empty configuration if no file exists (used by `forge init`). Returns whether it was created. */
  async createIfMissing(): Promise<boolean> {
    return this.change((current, existed) => (existed ? undefined : current.settings));
  }

  async set(key: SettingKey, value: SettingValue): Promise<{ readonly previous: SettingValue | undefined }> {
    const checked = checkSetting(key, value);
    let previous: SettingValue | undefined;
    await this.change((current) => {
      previous = current.settings[key];
      return { ...current.settings, [key]: checked };
    });
    return { previous };
  }

  /**
   * Removes a project override. Works on an INVALID file too (that is how a
   * bad value is repaired): the key is removed from the raw document, and the
   * rest must then validate, or nothing is written.
   */
  async reset(key: string): Promise<{ readonly previous: unknown }> {
    const lock = await acquireFileLock(this.lockFile, { timeoutMs: 5_000 });
    try {
      const raw = await readJsonDocument(this.file, 'Project configuration').catch((error: unknown) => {
        throw new ProjectConfigError(`Project configuration is unreadable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      });
      const settings = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)['settings'] : undefined;
      if (settings === null || typeof settings !== 'object' || Array.isArray(settings) || !Object.hasOwn(settings, key)) {
        if (!isSettingKey(key)) {
          throw new ProjectConfigError(describeUnknownKey(key));
        }
        return { previous: undefined };
      }
      const remaining: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
      const previous = remaining[key];
      delete remaining[key];
      let next: ProjectConfig;
      try {
        next = decodeProjectConfig({ schemaVersion: PROJECT_CONFIG_VERSION, settings: remaining, updatedAt: this.clock().toISOString() });
      } catch (error) {
        throw new ProjectConfigError(`Removing ${key} is not enough: ${error instanceof Error ? error.message : String(error)}; nothing was written`, { cause: error });
      }
      await writeFileAtomic(this.file, serializeJson(next));
      return { previous };
    } finally {
      await lock.release();
    }
  }

  /** Read-modify-write under the state lock, validated before an atomic write. `undefined` means "no change". */
  private async change(update: (current: ProjectConfig, existed: boolean) => ProjectSettings | undefined): Promise<boolean> {
    const lock = await acquireFileLock(this.lockFile, { timeoutMs: 5_000 });
    try {
      const existed = await this.exists();
      const current = await this.load();
      const settings = update(current, existed);
      if (settings === undefined) {
        return false;
      }
      const next: ProjectConfig = { schemaVersion: PROJECT_CONFIG_VERSION, settings, updatedAt: this.clock().toISOString() };
      decodeProjectConfig(JSON.parse(JSON.stringify(next)) as unknown);
      await writeFileAtomic(this.file, serializeJson(next));
      return true;
    } finally {
      await lock.release();
    }
  }
}

export type SettingSource = 'project' | 'environment' | 'default';

export interface EffectiveSetting {
  readonly key: SettingKey;
  readonly value: SettingValue | null;
  readonly source: SettingSource;
  readonly description: string;
}

/** Effective value of every key: project override, then environment (timeouts), then the default. */
export function effectiveSettings(config: ProjectConfig, environment: { readonly workerTimeoutMs: number; readonly workerTimeoutFromEnv: boolean }): EffectiveSetting[] {
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const spec: SettingSpec = SETTINGS[key];
    const override = config.settings[key];
    if (override !== undefined) {
      return { key, value: override, source: 'project', description: spec.description };
    }
    if (key === 'run.workerTimeoutSeconds' || key === 'run.reviewTimeoutSeconds') {
      return {
        key,
        value: Math.round(environment.workerTimeoutMs / 1000),
        source: environment.workerTimeoutFromEnv ? 'environment' : 'default',
        description: spec.description,
      };
    }
    return { key, value: spec.default, source: 'default', description: spec.description };
  });
}
