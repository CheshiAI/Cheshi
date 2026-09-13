/** A single response in an in-memory Codex session, without a chat history. */
export interface EphemeralSessionRequest {
  requestId: string;
  model: string;
  effort: string;
  instructions: string;
  input: string;
}

export interface EphemeralSessionResult {
  text: string;
  model: string;
}

export function ephemeralSessionRequest(value: unknown): EphemeralSessionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Temporary session request must be an object.');
  }
  const request = value as Record<string, unknown>;
  const limits = { requestId: 128, model: 128, effort: 32, instructions: 16_000, input: 128_000 };
  for (const [key, limit] of Object.entries(limits)) {
    const field = request[key];
    if (typeof field !== 'string' || !field.trim() || field.length > limit) {
      throw new TypeError(`Temporary session ${key} must be between 1 and ${limit} characters.`);
    }
  }
  return {
    requestId: request.requestId as string,
    model: request.model as string,
    effort: request.effort as string,
    instructions: request.instructions as string,
    input: request.input as string,
  };
}
