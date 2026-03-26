import type { ApprovalMode } from './types.js';

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'detailed';

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  switch (value) {
    case 'full-auto':
    case 'full-approval':
    case 'all-permissions':
      return 'full-auto';
    case 'less-interruption':
    case 'less-interruptive':
      return 'less-interruption';
    case 'detailed':
    case 'less-approval':
    default:
      return 'detailed';
  }
}
