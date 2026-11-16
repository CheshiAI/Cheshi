import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertApplicationRecords, readApplicationRecords } from '../../experiments/codex-specialists/src/application-storage.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'cheshi-application-storage-')); roots.push(root);
  fs.mkdirSync(join(root, 'state')); fs.mkdirSync(join(root, 'integrations', 'a'.repeat(64)), { recursive: true });
  return { root, state: join(root, 'state', 'agent.json'), journal: join(root, 'integrations', 'a'.repeat(64), 'application.json') };
}
test('native Node imports and serialized storage probe remain strip-only and self-contained', () => {
  const f = fixture(); fs.writeFileSync(f.state, JSON.stringify({ tasks: [] }));
  const module = resolve('experiments/codex-specialists/src/application-storage.ts');
  const script = `const {readApplicationRecords}=await import(process.argv[1]); const probe=readApplicationRecords.toString(); const fs=await import('node:fs'); console.log(JSON.stringify(Function('fs','root','return ('+probe+')(fs,root)')(fs,process.argv[2])));`;
  const output = execFileSync('node', ['--input-type=module', '-e', script, module, f.root], { encoding: 'utf8' });
  expect(JSON.parse(output)).toEqual({ version: 1, references: [], journals: [] });
});
test('missing referenced journals, malformed records and symlinks fail closed', () => {
  const f = fixture();
  fs.writeFileSync(f.state, JSON.stringify({ tasks: [{ integration: { id: 'a'.repeat(64), application: {} } }] }));
  expect(() => assertApplicationRecords(readApplicationRecords(fs, f.root))).toThrow('missing');
  fs.writeFileSync(f.journal, '{corrupt');
  expect(() => readApplicationRecords(fs, f.root)).toThrow();
  fs.writeFileSync(f.journal, 'null');
  expect(() => assertApplicationRecords(readApplicationRecords(fs, f.root))).toThrow('receipt');
  fs.rmSync(f.journal); fs.symlinkSync(f.state, f.journal);
  expect(() => readApplicationRecords(fs, f.root)).toThrow();
});
