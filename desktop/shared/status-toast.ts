export interface StatusToastMessage {
  id: number | string;
  variant: 'success' | 'warning' | 'error';
  title: string;
  description: string;
}

export function isStatusToastMessage(value: unknown): value is StatusToastMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return ((typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128)
    || (typeof message.id === 'number' && Number.isSafeInteger(message.id)))
    && (message.variant === 'success' || message.variant === 'warning' || message.variant === 'error')
    && typeof message.title === 'string' && message.title.length > 0 && message.title.length <= 512
    && typeof message.description === 'string' && message.description.length <= 4096;
}
