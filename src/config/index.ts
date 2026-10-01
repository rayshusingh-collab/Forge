export { DEFAULT_CONFIG, ENV_VARS, MAX_PROCESS_TIMEOUT_MS, RUNTIME_MODES, loadConfig } from './config.ts';
export type { Environment, ForgeConfig, RuntimeMode } from './config.ts';
export {
  EMPTY_PROJECT_CONFIG,
  PROJECT_CONFIG_FILE,
  PROJECT_CONFIG_VERSION,
  ProjectConfigStore,
  SETTINGS,
  checkSetting,
  decodeProjectConfig,
  describeUnknownKey,
  effectiveSettings,
  isSettingKey,
  parseSettingValue,
} from './project-config.ts';
export type { EffectiveSetting, ProjectConfig, ProjectSettings, SettingKey, SettingSource, SettingValue } from './project-config.ts';
