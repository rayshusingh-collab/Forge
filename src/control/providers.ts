import type { AiProviderRegistry } from '../ai/index.ts';
import { SETTINGS } from '../config/index.ts';
import type { ProjectSettings } from '../config/index.ts';
import type { WorkerRegistry } from '../workers/index.ts';

/**
 * Provider health by ROLE. Forge has four AI roles, each filled by a
 * provider chosen by a human (project configuration or CLI option): the
 * planner, reviewer and decision-maker come from the AI-provider registry, the implementer
 * from the worker registry. Today all are Claude-backed; nothing here
 * assumes they stay that way or that the roles share a provider.
 *
 * Health checks are local (version, capabilities, login status); no AI
 * call is made and no project state is touched.
 */

export const PROVIDER_ROLES = ['planner', 'implementer', 'reviewer', 'decision-maker'] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

const ROLE_SETTING = {
  planner: 'providers.planner',
  implementer: 'providers.implementer',
  reviewer: 'providers.reviewer',
  'decision-maker': 'providers.decisionMaker',
} as const;

export interface RoleHealth {
  readonly role: ProviderRole;
  /** Provider name chosen for the role. */
  readonly configured: string;
  readonly source: 'project' | 'default' | 'option';
  /** Resolved provider ID, or null when the name is unknown. */
  readonly providerId: string | null;
  readonly displayName: string | null;
  readonly available: boolean;
  readonly version: string | null;
  /** Failing checks, or a short success note. */
  readonly detail: string;
}

export interface Registries {
  readonly workers: WorkerRegistry;
  readonly aiProviders: AiProviderRegistry;
}

/** The provider name for a role: an explicit option, else project configuration, else the default. */
export function roleProvider(role: ProviderRole, settings: ProjectSettings, override?: string): { readonly name: string; readonly source: RoleHealth['source'] } {
  if (override !== undefined) {
    return { name: override, source: 'option' };
  }
  const key = ROLE_SETTING[role];
  const configured = settings[key];
  return typeof configured === 'string' ? { name: configured, source: 'project' } : { name: SETTINGS[key].default, source: 'default' };
}

export async function checkRole(
  role: ProviderRole,
  registries: Registries,
  settings: ProjectSettings,
  override?: string,
): Promise<RoleHealth> {
  const { name, source } = roleProvider(role, settings, override);
  const provider = role === 'implementer' ? registries.workers.create(name) : registries.aiProviders.create(name);
  if (provider === undefined) {
    const known = (role === 'implementer' ? registries.workers.list() : registries.aiProviders.list()).flatMap((entry) => [entry.id, ...entry.aliases]);
    return {
      role,
      configured: name,
      source,
      providerId: null,
      displayName: null,
      available: false,
      version: null,
      detail: `unknown provider "${name}" for the ${role} role (available: ${known.join(', ') || 'none'})`,
    };
  }
  const health = await provider.healthCheck();
  const failing = health.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
  return {
    role,
    configured: name,
    source,
    providerId: provider.id,
    displayName: provider.displayName,
    available: health.available,
    version: health.version,
    detail: health.available ? `${health.version ?? 'unknown version'}${health.authenticated === false ? ' (not logged in)' : ''}` : failing.join('; ') || 'unavailable',
  };
}
