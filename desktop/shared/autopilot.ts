import { parseResearchInvestigation } from './autopilot-investigation.ts';
import type { ResearchInvestigation } from './autopilot-investigation.ts';

export const AUTOPILOT_CHANNELS = {
  get: 'cheshi:autopilot:get',
  start: 'cheshi:autopilot:start',
  stop: 'cheshi:autopilot:stop',
  view: 'cheshi:autopilot:view',
  state: 'cheshi:autopilot:state',
  export: 'cheshi:autopilot:export',
} as const;

export const AUTOPILOT_MAX_STEPS = 20;
export const AUTOPILOT_MAX_READS = 40;
export type AutopilotPhase = 'idle' | 'planning' | 'synthesizing' | 'reading' | 'loading' | 'thinking' | 'acting' | 'completed' | 'partial' | 'stopped' | 'limit' | 'error';
export interface AutopilotRequest { url: string; goal: string; searchText?: string; mode?: 'research'; targetSources?: number; contextId?: string }
export interface AutopilotSource { url: string; title: string; accessedAt: string; evidence: string; confidence: number; id?: string; publisher?: string; section?: string; sectionId?: string }
export interface AutopilotIssue { url: string; message: string }
export type AutopilotReportFormat = 'markdown' | 'csv';
export interface AutopilotBounds { x: number; y: number; width: number; height: number }
export interface AutopilotViewRequest { visible: boolean; bounds: AutopilotBounds }
export interface AutopilotStep {
  url: string;
  title: string;
  loadMs: number;
  decisionMs: number;
  confidence: number | null;
  action?: string;
  kind?: 'navigation' | 'reading';
}
export function autopilotUsage(steps: AutopilotStep[]) {
  const readings = steps.filter(step => step.kind === 'reading').length;
  return { navigation: Math.max(0, steps.length - readings - 1), readings };
}
export interface AutopilotState {
  configured: boolean;
  phase: AutopilotPhase;
  url: string;
  title: string;
  goal: string;
  searchText?: string;
  error: string | null;
  modelMs: number;
  steps: AutopilotStep[];
  mode?: 'research';
  targetSources?: number;
  sources?: AutopilotSource[];
  issues?: AutopilotIssue[];
  investigation?: ResearchInvestigation;
}
export interface AutopilotApi {
  getState(): Promise<AutopilotState>;
  start(request: AutopilotRequest): Promise<AutopilotState>;
  stop(): Promise<AutopilotState>;
  exportReport(format: AutopilotReportFormat): Promise<boolean>;
  setView(request: AutopilotViewRequest): Promise<void>;
  onState(handler: (state: AutopilotState) => void): () => void;
}

export function autopilotRunning(state: Pick<AutopilotState, 'phase'>): boolean {
  return state.phase === 'planning' || state.phase === 'synthesizing' || state.phase === 'reading' || state.phase === 'loading' || state.phase === 'thinking' || state.phase === 'acting';
}

export function autopilotRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid Autopilot data.');
  return value as Record<string, unknown>;
}

export function safeAutopilotUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) throw new TypeError('Invalid Autopilot text.');
  return value;
}

function flag(value: unknown): boolean {
  if (value !== true && value !== false) throw new TypeError('Invalid Autopilot flag.');
  return value;
}

function number(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError('Invalid Autopilot number.');
  }
  return value;
}

export function parseAutopilotRequest(value: unknown): AutopilotRequest {
  const input = autopilotRecord(value);
  const url = safeAutopilotUrl(input.url);
  const goal = text(input.goal, 2000).trim();
  if (!url || !goal) throw new TypeError('Enter a valid HTTP(S) start URL and a goal.');
  const searchText = input.searchText === undefined ? '' : text(input.searchText, 500).trim();
  const contextId = input.contextId === undefined ? undefined : text(input.contextId, 128);
  if (contextId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(contextId)) throw new TypeError('Invalid chat context.');
  return { url, goal, ...(contextId === undefined ? {} : { contextId }), ...(searchText ? { searchText } : {}), ...researchMode(input) };
}

function researchMode(input: Record<string, unknown>): { mode?: 'research'; targetSources?: number } {
  if (input.mode === undefined && input.targetSources === undefined) return {};
  if (input.mode !== 'research') throw new TypeError('Invalid Autopilot mode.');
  const targetSources = input.targetSources === undefined ? 5 : number(input.targetSources, 1, 10);
  if (!Number.isInteger(targetSources)) throw new TypeError('Source count must be a whole number.');
  return { mode: 'research', targetSources };
}

export function parseAutopilotReportFormat(value: unknown): AutopilotReportFormat {
  if (value !== 'markdown' && value !== 'csv') throw new TypeError('Invalid report format.');
  return value;
}

function researchResults(input: Record<string, unknown>) {
  const mode = researchMode(input);
  if (!mode.mode) {
    if (input.sources !== undefined || input.issues !== undefined || input.investigation !== undefined) throw new TypeError('Unexpected research results.');
    return {};
  }
  if (!Array.isArray(input.sources) || input.sources.length > 10 || !Array.isArray(input.issues) || input.issues.length > 24) {
    throw new TypeError('Invalid research results.');
  }
  const seen = new Set<string>();
  const sources = input.sources.map(value => {
    const source = autopilotRecord(value);
    const url = safeAutopilotUrl(source.url);
    const accessedAt = text(source.accessedAt, 40);
    const evidence = text(source.evidence, 1200);
    const identity = input.investigation === undefined ? url : JSON.stringify([url, evidence]);
    if (!url || seen.has(identity!) || !evidence.trim() || !Number.isFinite(Date.parse(accessedAt))) throw new TypeError('Invalid research source.');
    seen.add(identity!);
    const id = source.id === undefined ? undefined : text(source.id, 10);
    if (id !== undefined && !/^s[1-9]\d?$/.test(id)) throw new TypeError('Invalid source ID.');
    return { url, title: text(source.title, 500), accessedAt, evidence, confidence: number(source.confidence, 0, 1),
      ...(id === undefined ? {} : { id }), ...(source.publisher === undefined ? {} : { publisher: text(source.publisher, 253) }),
      ...(source.section === undefined ? {} : { section: text(source.section, 300) }),
      ...(source.sectionId === undefined ? {} : { sectionId: text(source.sectionId, 20) }) };
  });
  const issues = input.issues.map(value => {
    const issue = autopilotRecord(value);
    const url = safeAutopilotUrl(issue.url);
    if (!url) throw new TypeError('Invalid research issue URL.');
    return { url, message: text(issue.message, 2000) };
  });
  const ids = sources.flatMap(source => source.id ? [source.id] : []);
  if (input.investigation !== undefined && (ids.length !== sources.length || new Set(ids).size !== ids.length)) throw new TypeError('Invalid research source IDs.');
  return { ...mode, sources, issues, ...(input.investigation === undefined ? {} : {
    investigation: parseResearchInvestigation(input.investigation, ids),
  }) };
}

export function parseAutopilotView(value: unknown): AutopilotViewRequest {
  const input = autopilotRecord(value);
  const bounds = autopilotRecord(input.bounds);
  return { visible: flag(input.visible), bounds: {
    x: number(bounds.x, -100_000, 100_000), y: number(bounds.y, -100_000, 100_000),
    width: number(bounds.width, 0, 100_000), height: number(bounds.height, 0, 100_000),
  } };
}

export function parseAutopilotState(value: unknown): AutopilotState {
  const input = autopilotRecord(value);
  const phases: AutopilotPhase[] = ['idle', 'planning', 'synthesizing', 'reading', 'loading', 'thinking', 'acting', 'completed', 'partial', 'stopped', 'limit', 'error'];
  const phase = phases.find(candidate => candidate === input.phase);
  const url = input.url === '' ? '' : safeAutopilotUrl(input.url);
  const extended = input.mode === 'research' && input.investigation !== undefined;
  if (!phase || url === null || !Array.isArray(input.steps)
    || input.steps.length > AUTOPILOT_MAX_STEPS + 1 + (extended ? AUTOPILOT_MAX_READS : 0)) {
    throw new TypeError('Invalid Autopilot state.');
  }
  const steps = input.steps.map((value): AutopilotStep => {
    const step = autopilotRecord(value);
    const stepUrl = safeAutopilotUrl(step.url);
    if (!stepUrl) throw new TypeError('Invalid Autopilot step URL.');
    const kind = step.kind;
    if (kind !== undefined && kind !== 'navigation' && kind !== 'reading') throw new TypeError('Invalid Autopilot step kind.');
    if (kind === 'reading' && !extended) throw new TypeError('Unexpected document reading.');
    return { url: stepUrl, title: text(step.title, 500), loadMs: number(step.loadMs),
      decisionMs: number(step.decisionMs), confidence: step.confidence === null ? null : number(step.confidence, 0, 1),
      ...(step.action === undefined ? {} : { action: text(step.action, 600) }),
      ...(kind === undefined ? {} : { kind }) };
  });
  const usage = autopilotUsage(steps);
  if (usage.navigation > AUTOPILOT_MAX_STEPS || usage.readings > AUTOPILOT_MAX_READS
    || steps[0]?.kind === 'reading') throw new TypeError('Invalid Autopilot usage.');
  return { configured: flag(input.configured), phase, url, title: text(input.title, 500), goal: text(input.goal, 2000),
    error: input.error === null ? null : text(input.error, 2000), modelMs: number(input.modelMs), steps,
    ...(input.searchText === undefined ? {} : { searchText: text(input.searchText, 500) }), ...researchResults(input) };
}
