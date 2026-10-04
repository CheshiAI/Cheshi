import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startConnectionServer } from '../server/src/server.ts';

test('HTTP service enforces its public host, origin, static boundary and security headers', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-connect-http-'));
  writeFileSync(path.join(directory, 'index.html'), '<h1>Test phone</h1>');
  const instance = startConnectionServer({ origin: 'http://localhost:48769', port: 0, assets: directory });
  try {
    const target = `http://127.0.0.1:${instance.server.port}`;
    expect((await fetch(target)).status).toBe(403);
    const page = await fetch(target, { headers: { host: 'localhost:48769' } });
    expect(await page.text()).toBe('<h1>Test phone</h1>');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await fetch(`${target}/connect`, { headers: { host: 'localhost:48769', origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await fetch(`${target}/voice.json`, { headers: { host: 'localhost:48769' } })).status).toBe(404);
    expect((await fetch(target, { method: 'POST', headers: { host: 'localhost:48769' } })).status).toBe(405);
  } finally { instance.stop(); rmSync(directory, { recursive: true, force: true }); }
});
