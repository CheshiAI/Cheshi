import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseAutopilotState } from '../shared/autopilot.ts';
import type { AutopilotReportFormat, AutopilotState } from '../shared/autopilot.ts';

const markdown = (value: string) => value.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&');
const destination = (value: string) => value.replace(/[()<>\\]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
function csvCell(value: string): string {
  // Quoting alone does not prevent spreadsheet formulas in imported CSV files.
  const safe = /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function autopilotReport(value: AutopilotState, format: AutopilotReportFormat): string {
  const state = parseAutopilotState(value);
  if (state.mode !== 'research' || (!state.sources?.length && !state.issues?.length)) {
    throw new Error('Collect research results before exporting.');
  }
  const sources = state.sources ?? [];
  const status = state.phase === 'completed' ? 'Target reached' : 'Incomplete';
  if (format === 'csv') {
    const header = ['Record', 'Research goal', 'Run status', 'Target sources', 'Title', 'URL', 'Checked at', 'Evidence', 'Confidence', 'Issue'];
    const rows = sources.map(source => ['source', state.goal, status, String(state.targetSources), source.title, source.url,
      source.accessedAt, source.evidence, String(source.confidence), '']);
    for (const issue of state.issues ?? []) rows.push(['issue', state.goal, status, String(state.targetSources), '', issue.url, '', '', '', issue.message]);
    if (state.error) rows.push(['run', state.goal, status, String(state.targetSources), '', '', '', '', '', state.error]);
    return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  return ['# Research report', '', `Topic: ${markdown(state.goal)}`, '',
    `Status: ${status} (${sources.length}/${state.targetSources} sources).`, '',
    'Evidence below is quoted from the visited pages. Model confidence is not independent fact verification.', '',
    ...(state.error ? [`Note: ${markdown(state.error)}`, ''] : []),
    ...sources.flatMap((source, index) => [`## ${index + 1}. ${markdown(source.title || source.url)}`, '',
      `Source: [${markdown(source.url)}](${destination(source.url)})`, '',
      `Checked at: ${source.accessedAt} · Model confidence: ${Math.round(source.confidence * 100)}%`, '',
      ...source.evidence.split(/\r?\n/).map(line => `> ${markdown(line)}`), '']),
    ...(state.issues?.length ? ['## Unavailable or unconfirmed', '', ...state.issues.map(issue =>
      `- [${markdown(issue.url)}](${destination(issue.url)}): ${markdown(issue.message)}`), ''] : []),
  ].join('\n');
}

/** Exclusive creation prevents concurrent exports from overwriting an existing report. */
export async function saveAutopilotReportAutomatically(content: string, format: AutopilotReportFormat,
  directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const extension = format === 'markdown' ? 'md' : 'csv';
  const filename = `research-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.${extension}`;
  const destination = path.join(directory, filename);
  await writeFile(destination, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return destination;
}
