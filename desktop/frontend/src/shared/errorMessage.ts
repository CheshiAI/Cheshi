export function errorMessage(value: unknown, fallback?: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return fallback ?? String(value);
}
