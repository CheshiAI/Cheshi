export type ChatMcpRuntimeStatus =
  | 'notStarted'
  | 'starting'
  | 'connected'
  | 'authenticationRequired'
  | 'failed'
  | 'cancelled'
  | 'disabled';

export function normalizeMcpRuntimeStatus(value: unknown): ChatMcpRuntimeStatus | null {
  switch (value) {
    case 'notStarted':
    case 'starting':
    case 'connected':
    case 'authenticationRequired':
    case 'failed':
    case 'cancelled':
    case 'disabled':
      return value;
    default:
      return null;
  }
}
