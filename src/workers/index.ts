export {
  CLAUDE_TOOLS,
  REQUIRED_ROLE_OPTIONS,
  buildClaudeRoleArgs,
  FORBIDDEN_CLAUDE_OPTIONS,
  REQUIRED_CLAUDE_OPTIONS,
  buildClaudeArgs,
  findMissingCapabilities,
  parseAuthStatus,
  parseClaudeVersion,
} from './claude-code/command.ts';
export { parseClaudeOutput } from './claude-code/output.ts';
export type { ClaudeOutputParse, ClaudeRunReport } from './claude-code/output.ts';
export {
  CLAUDE_CODE_WORKER_ID,
  CLAUDE_EXECUTABLE_NAME,
  CLAUDE_MAX_OUTPUT_BYTES,
  ClaudeCodeWorker,
  interpretRun,
} from './claude-code/worker.ts';
export type { ClaudeCodeWorkerOptions } from './claude-code/worker.ts';
export { buildPromptEnvelope } from './prompt-envelope.ts';
export type { PromptEnvelope } from './prompt-envelope.ts';
export { createWorkerRegistry } from './registry.ts';
export type { WorkerDescriptor, WorkerRegistry, WorkerRegistryDependencies } from './registry.ts';
export { WORKER_REQUEST_LIMITS, prepareWorkerRequest } from './request.ts';
export type { PrepareWorkerRequestInput } from './request.ts';
export { runRecordedWorker } from './run-recorder.ts';
export type { RecordedRun, RecordedRunOptions } from './run-recorder.ts';
export { WORKER_OUTCOMES, WORKER_RESULT_LIMITS } from './types.ts';
export type {
  AuthorizedDirectory,
  ProviderMetadata,
  Worker,
  WorkerCapabilities,
  WorkerExecuteOptions,
  WorkerHealth,
  WorkerHealthCheck,
  WorkerOutcome,
  WorkerProcessInfo,
  WorkerRequest,
  WorkerResult,
} from './types.ts';
