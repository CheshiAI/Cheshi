import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { AUTOPILOT_MAX_STEPS, AUTOPILOT_MAX_READS, autopilotUsage, parseAutopilotState } from '../shared/autopilot.ts';
import type { AutopilotReportFormat, AutopilotState } from '../shared/autopilot.ts';
import { questionStatus } from '../shared/autopilot-investigation.ts';

const markdown = (value: string) => value.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&');
const destination = (value: string) => value.replace(/[()<>\\]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
function csvCell(value: string): string {
  // Quoting alone does not prevent spreadsheet formulas in imported CSV files.
  const safe = /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function autopilotReport(value: AutopilotState, format: AutopilotReportFormat): string {
  const state = parseAutopilotState(value);
  if (state.mode !== 'research' || (!state.sources?.length && !state.issues?.length && !state.investigation)) {
    throw new Error('Collect research results before exporting.');
  }
  const sources = state.sources ?? [];
  const investigation = state.investigation;
  const usage = autopilotUsage(state.steps);
  const usageText = `Navigation: ${usage.navigation}/${AUTOPILOT_MAX_STEPS}; document reads: ${usage.readings}/${AUTOPILOT_MAX_READS}.`;
  const status = state.phase === 'completed' ? investigation ? 'Questions answered' : 'Target reached' : 'Incomplete';
  if (format === 'csv') {
    const header = ['Record', 'Research goal', 'Run status', 'Source limit', 'Title', 'URL', 'Checked at', 'Evidence', 'Confidence', 'Issue',
      'Source ID', 'Publisher', 'Question ID', 'Question status', 'Answer', 'Citations', 'Comparison', 'Limitations', 'Role', 'Relation', 'Section', 'Section ID'];
    const rows = sources.map(source => ['source', state.goal, status, String(state.targetSources), source.title, source.url,
      source.accessedAt, source.evidence, String(source.confidence), '', source.id ?? '', source.publisher ?? '',
      '', '', '', '', '', '', '', '', source.section ?? '', source.sectionId ?? '']);
    for (const question of investigation?.plan.questions ?? []) {
      const answer = investigation?.report?.answers.find(answer => answer.questionId === question.id);
      rows.push(['question', state.goal, status, String(state.targetSources), question.question, '', '', '', '', '', '', '', question.id,
        answer?.status ?? questionStatus(question, investigation!.assessments), answer?.answer ?? 'No final answer.', answer?.sourceIds.join('; ') ?? '',
        answer?.comparison ?? '', answer?.limitations ?? 'Research is incomplete.']);
    }
    for (const evidence of investigation?.assessments ?? []) rows.push(['assessment', state.goal, status, String(state.targetSources),
      '', '', '', '', '', '', evidence.sourceId, '', evidence.questionId, '', '', '', '', '', evidence.role, evidence.relation]);
    for (const issue of state.issues ?? []) rows.push(['issue', state.goal, status, String(state.targetSources), '', issue.url, '', '', '', issue.message]);
    if (state.error) rows.push(['run', state.goal, status, String(state.targetSources), '', '', '', '', '', state.error]);
    if (investigation) rows.push(['usage', state.goal, status, String(state.targetSources), '', '', '', '', '', usageText]);
    return '\uFEFF' + [header, ...rows].map(row => header.map((_, index) => csvCell(row[index] ?? '')).join(',')).join('\r\n') + '\r\n';
  }
  return ['# Research report', '', `Topic: ${markdown(state.goal)}`, '',
    `Status: ${status} (${sources.length}/${state.targetSources} sources).`, '',
    ...(investigation ? [usageText, ''] : []),
    'Evidence below is quoted from the visited pages. Model confidence is not independent fact verification.', '',
    ...(state.error ? [`Note: ${markdown(state.error)}`, ''] : []),
    ...(investigation ? [`Codex model: ${markdown(investigation.model)}`, '', '## Questions and findings', '',
      ...investigation.plan.questions.flatMap(question => {
        const answer = investigation.report?.answers.find(answer => answer.questionId === question.id);
        return [`### ${markdown(question.question)}`, '', `Evidence status: ${answer?.status ?? questionStatus(question, investigation.assessments)}`, '',
          markdown(answer?.answer ?? 'No final answer was generated. This question remains unconfirmed.'), '',
          `Citations: ${(answer?.sourceIds ?? []).map(id => {
            const source = sources.find(source => source.id === id)!;
            return `[${id}](${destination(source.url)})`;
          }).join(', ') || 'None'}`, '', `Comparison: ${markdown(answer?.comparison ?? 'Not completed.')}`, '',
          `Limitations: ${markdown(answer?.limitations ?? 'Research was stopped or is incomplete.')}`, ''];
      }), '## Collected evidence', ''] : []),
    ...sources.flatMap((source, index) => [`## ${source.id ?? index + 1}. ${markdown(source.title || source.url)}`, '',
      `Source: [${markdown(source.url)}](${destination(source.url)})`, '',
      ...(source.publisher ? [`Publisher group: ${markdown(source.publisher)}`, ''] : []),
      ...(source.section ? [`Section: ${markdown(source.section)}`, ''] : []),
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
