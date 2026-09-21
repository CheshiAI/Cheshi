import { recordValue } from './codex-service-utils.mts';

/** Check credentials using fixed synthetic data, never a conversation or workspace file. */
export async function checkTypeSafeConnection(key: string, request: (url: string, options: RequestInit) => Promise<Response> = fetch): Promise<void> {
  const signal = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await request('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: { purpose: 'Connection check' }, questions: {
        connection: { type: 'choice', instructions: 'Is the purpose a connection check?',
          criteria: { yes: 'Connection check.', no: 'Another purpose.' } },
      } }),
    });
  } catch { throw new Error('Could not reach TypeSafe. Check your connection and try again.'); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new Error('TypeSafe rejected the API key or model access.');
    if (response.status === 429) throw new Error('TypeSafe usage limit reached. Try again later.');
    throw new Error('Could not verify the TypeSafe connection. Try again later.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid TypeSafe connection response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assertResponseSize(bytes);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = recordValue(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const answer = recordValue(recordValue(result?.answers)?.connection);
  if (answer?.type !== 'choice' || (answer.choice !== 'yes' && answer.choice !== 'no')) {
    throw new Error('Invalid TypeSafe connection response.');
  }
}

function assertResponseSize(bytes: number): void {
  if (bytes > 16_384) throw new Error('Invalid TypeSafe connection response.');
}
