export const AUTOPILOT_CHANNELS = {
  get: 'cheshi:autopilot:get',
  start: 'cheshi:autopilot:start',
  stop: 'cheshi:autopilot:stop',
  view: 'cheshi:autopilot:view',
  state: 'cheshi:autopilot:state',
} as const;

export const AUTOPILOT_MAX_STEPS = 20;
export type AutopilotPhase = 'idle' | 'loading' | 'thinking' | 'acting' | 'completed' | 'stopped' | 'limit' | 'error';
export interface AutopilotRequest { url: string; goal: string; searchText?: string }
export interface AutopilotBounds { x: number; y: number; width: number; height: number }
export interface AutopilotViewRequest { visible: boolean; bounds: AutopilotBounds }
export interface AutopilotStep {
  url: string;
  title: string;
  loadMs: number;
  decisionMs: number;
  confidence: number | null;
  action?: string;
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
}
export interface AutopilotApi {
  getState(): Promise<AutopilotState>;
  start(request: AutopilotRequest): Promise<AutopilotState>;
  stop(): Promise<AutopilotState>;
  setView(request: AutopilotViewRequest): Promise<void>;
  onState(handler: (state: AutopilotState) => void): () => void;
}

export function autopilotRunning(state: Pick<AutopilotState, 'phase'>): boolean {
  return state.phase === 'loading' || state.phase === 'thinking' || state.phase === 'acting';
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
  return { url, goal, ...(searchText ? { searchText } : {}) };
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
  const phases: AutopilotPhase[] = ['idle', 'loading', 'thinking', 'acting', 'completed', 'stopped', 'limit', 'error'];
  const phase = phases.find(candidate => candidate === input.phase);
  const url = input.url === '' ? '' : safeAutopilotUrl(input.url);
  if (!phase || url === null || !Array.isArray(input.steps) || input.steps.length > AUTOPILOT_MAX_STEPS + 1) {
    throw new TypeError('Invalid Autopilot state.');
  }
  const steps = input.steps.map(value => {
    const step = autopilotRecord(value);
    const stepUrl = safeAutopilotUrl(step.url);
    if (!stepUrl) throw new TypeError('Invalid Autopilot step URL.');
    return { url: stepUrl, title: text(step.title, 500), loadMs: number(step.loadMs),
      decisionMs: number(step.decisionMs), confidence: step.confidence === null ? null : number(step.confidence, 0, 1),
      ...(step.action === undefined ? {} : { action: text(step.action, 600) }) };
  });
  return { configured: flag(input.configured), phase, url, title: text(input.title, 500), goal: text(input.goal, 2000),
    error: input.error === null ? null : text(input.error, 2000), modelMs: number(input.modelMs), steps,
    ...(input.searchText === undefined ? {} : { searchText: text(input.searchText, 500) }) };
}
