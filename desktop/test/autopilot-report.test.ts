import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { IpcRenderer } from 'electron';
import { autopilotReport, saveAutopilotReportAutomatically } from '../lib/autopilot-report.mts';
import { createAutopilotApi } from '../lib/autopilot-preload.cts';
import { AUTOPILOT_CHANNELS } from '../shared/autopilot';
import type { AutopilotState } from '../shared/autopilot';

const state: AutopilotState = { configured: true, phase: 'stopped', mode: 'research', targetSources: 5,
  url: 'https://example.org/', title: 'Research', goal: 'Compare services', error: null, modelMs: 0, steps: [],
  sources: [{ url: 'https://example.org/page(test)', title: '<script>bad</script>', evidence: '=HYPERLINK("bad")\nQuoted evidence, with commas.',
    accessedAt: '2026-09-17T00:00:00.000Z', confidence: 0.75 }],
  issues: [{ url: 'https://example.org/private', message: 'Login required' }] };

test('Markdown includes evidence, provenance, incomplete status and escaped page content', () => {
  const text = autopilotReport(state, 'markdown');
  expect(text).toContain('Incomplete (1/5 sources)');
  expect(text).toContain('2026-09-17T00:00:00.000Z');
  expect(text).toContain('75%');
  expect(text).toContain('Login required');
  expect(text).toContain('(https://example.org/page%28test%29)');
  expect(text).not.toContain('<script>');
});

test('CSV preserves multiline fields and neutralizes spreadsheet formulas', () => {
  const text = autopilotReport({ ...state, goal: '@formula', sources: [{ ...state.sources![0]!, title: '"Title, one"' }] }, 'csv');
  expect(text).toContain('"\'@formula"');
  expect(text).toContain('"\'=HYPERLINK(""bad"")\nQuoted evidence, with commas."');
  expect(text).toContain('"""Title, one"""');
  expect(text).toContain('"Incomplete","5"');
  expect(text).toContain('"issue"');
});

test('failed research reports retain the failure explanation', () => {
  expect(autopilotReport({ ...state, phase: 'error', error: 'Model unavailable' }, 'markdown')).toContain('Model unavailable');
});

test('preload sends only a validated format and rejects nonboolean save responses', async () => {
  const requests: unknown[] = [];
  let result: unknown = true;
  const ipc = Object.assign(new EventEmitter(), { async invoke(channel: string, value?: unknown) {
    requests.push({ channel, value }); return result;
  } });
  const api = createAutopilotApi(ipc as unknown as Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>);
  expect(await api.exportReport('markdown')).toBe(true);
  expect(requests).toEqual([{ channel: AUTOPILOT_CHANNELS.export, value: 'markdown' }]);
  result = false;
  expect(await api.exportReport('csv')).toBe(false);
  result = 'true';
  let error: unknown;
  try { await api.exportReport('csv'); } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(TypeError);
});


test('automatic concurrent saves create unique files without overwriting previous reports', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-report-auto-'));
  try {
    const nested = path.join(directory, 'reports');
    const files = await Promise.all(['first', 'second', 'third'].map(content =>
      saveAutopilotReportAutomatically(content, 'markdown', nested)));
    expect(new Set(files).size).toBe(3);
    expect(await Promise.all(files.map(file => readFile(file, 'utf8')))).toEqual(['first', 'second', 'third']);
    expect(files.every(file => file.startsWith(nested) && file.endsWith('.md'))).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
