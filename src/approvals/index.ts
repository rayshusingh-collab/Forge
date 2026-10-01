export { leaseApprovalBinding, taskApprovalBinding } from './binding.ts';
export type { ApprovalBinding } from './binding.ts';
export {
  consumeApproval,
  currentFingerprint,
  requestApproval,
  resolveApproval,
  resolveApprovalReference,
  staleApprovals,
  sweepApprovals,
} from './transitions.ts';
export type { ApprovalRequestInput, ApprovalRequestResult, ResolveOutcome } from './transitions.ts';
