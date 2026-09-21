import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkTypeSafeConnection } from '../lib/typesafe-connection.mts';
import { readTypeSafeKey } from '../lib/typesafe-key.mts';
test('key loading uses the named environment value and development fallback without importing signing variables', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-typesafe-key-'));
  try {
    const developmentFile = path.join(directory, '.env.signing');
    writeFileSync(developmentFile, 'TYPE_SAFE_AI="fixture-value"\nUNRELATED_SIGNING_VALUE=private-fixture\n');
    const environment: NodeJS.ProcessEnv = {};
    expect(readTypeSafeKey({ environment, developmentFile })).toBe('fixture-value');
    expect(environment).toEqual({});
    expect(readTypeSafeKey({ environment: { TYPE_SAFE_AI: 'environment-value' }, developmentFile })).toBe('environment-value');
    expect(readTypeSafeKey({ environment })).toBeNull();
    expect(readTypeSafeKey({ environment, developmentFile: path.join(directory, 'missing') })).toBeNull();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});



async function rejected(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
  expect((failure as Error).message).not.toContain('fixture-secret');
}

test('connection checking uses only synthetic inputs and validates a Jev Choice reply', async () => {
  let sent: unknown;
  await checkTypeSafeConnection('fixture-secret', async (url, options) => {
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    sent = JSON.parse(String(options.body));
    return Response.json({ answers: { connection: { type: 'choice', choice: 'yes', confidence: 0.99 } } });
  });
  expect(sent).toMatchObject({ model: 'jev-latest', state: { purpose: 'Connection check' } });
  expect(JSON.stringify(sent)).not.toContain('fixture-secret');
});

test('connection checking rejects provider errors, malformed choices and excessive responses safely', async () => {
  for (const [status, message] of [[401, 'rejected'], [403, 'rejected'], [429, 'limit'], [500, 'verify']] as const) {
    await rejected(checkTypeSafeConnection('fixture-secret', async () => new Response('fixture-secret', { status })), message);
  }
  await rejected(checkTypeSafeConnection('fixture-secret', async () => { throw new Error('fixture-secret'); }), 'reach TypeSafe');
  for (const answer of [null, true, { type: 'choice', choice: true }, { type: 'choice', choice: 'maybe' }, { type: 'noul', noul: 1 }]) {
    await rejected(checkTypeSafeConnection('fixture-secret', async () => Response.json({ answers: { connection: answer } })), 'Invalid');
  }
  await rejected(checkTypeSafeConnection('fixture-secret', async () => new Response('x'.repeat(16_385))), 'Invalid');
});
