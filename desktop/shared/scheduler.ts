import type { ChatUserInputRequest, ChatUserInputResponse } from './chat-user-input.ts';
import type { CalendarEvent } from './apple-calendar.ts';

export const SCHEDULER_CHANNEL = 'cheshi:scheduler';
export const SCHEDULER_CHANGED_CHANNEL = 'cheshi:scheduler:changed';
export const SCHEDULER_NOTIFICATION_POSITIONS = ['bottom-left', 'top-right', 'bottom-right'] as const;
export type SchedulerNotificationPosition = typeof SCHEDULER_NOTIFICATION_POSITIONS[number];
export const DEFAULT_SCHEDULER_NOTIFICATION_POSITION: SchedulerNotificationPosition = 'bottom-left';
export function schedulerNotificationPosition(value: unknown): SchedulerNotificationPosition {
  if (typeof value !== 'string' || !SCHEDULER_NOTIFICATION_POSITIONS.some(position => position === value)) {
    throw new TypeError('Invalid scheduler notification position');
  }
  return value as SchedulerNotificationPosition;
}
export type ScheduleRepeat = 'once' | 'daily' | 'weekly';
export type ScheduleInput = {
  title: string; prompt: string; startAt: string; timeZone: string; repeat: ScheduleRepeat;
  enabled: boolean; threadId: string | null; permissionMode: 'read-only' | 'ask-for-approval';
  model: string | null; effort: string;
};
export type Schedule = ScheduleInput & { id: string; workspace: string; revision: number; nextAt: string | null;
  calendarLink?: { state: 'creating' | 'unknown' | 'linked'; eventId?: string } };
export type SchedulerSummary = { pending: number; running: number; next: string | null };
export type RunStatus = 'pending' | 'approved' | 'starting' | 'running' | 'completed' | 'failed' | 'unknown'
  | 'skipped' | 'missed' | 'acknowledged' | 'cancelled';
export type ScheduleRun = {
  id: string; scheduleId: string; workspace: string; title: string; kind: 'task' | 'event';
  plannedAt: string; startedAt: string | null; finishedAt: string | null; status: RunStatus;
  mode: 'manual' | 'auto'; approvedAt: string | null; dismissed: boolean; summary: string;
  profileId: string | null; threadId: string | null; turnId: string | null; snapshot: ScheduleInput | null;
  ownerPid?: number;
};
export type ScheduleApproval = { id: string; title: string; detail: string };
export type SchedulerAttention = { runId: string; approvals: ScheduleApproval[]; inputs: ChatUserInputRequest[] };
export type SchedulerSnapshot = {
  notificationPosition?: SchedulerNotificationPosition;
  auto: boolean; schedules: Schedule[]; runs: ScheduleRun[]; attention: SchedulerAttention[]; error: string;
  calendarTasks?: CalendarTask[];
  reviewId?: string | null;
  reviewVersion?: number;
  calendarVersion?: number;
};
export type CalendarTask = { key: string; event: CalendarEvent; workspace: string; input: ScheduleInput | null; error: string };
export type SchedulerAction = 'approve' | 'skip' | 'acknowledge' | 'dismiss' | 'run-late' | 'cancel';
export interface SchedulerApi {
  startup?(): Promise<{ enabled: boolean; available: boolean }>;
  setStartup?(enabled: boolean): Promise<void>;
  migrate?(id: string, revision: number, calendarId: string): Promise<void>;
  onChanged(listener: () => void, onError?: (message: string) => void): () => void;
  read(): Promise<SchedulerSnapshot>;
  save(input: ScheduleInput, target?: { id: string; revision: number }): Promise<Schedule>;
  remove(id: string, revision: number): Promise<void>;
  setAuto(enabled: boolean): Promise<void>;
  setNotificationPosition?(position: SchedulerNotificationPosition): Promise<void>;
  act(id: string, action: SchedulerAction): Promise<void>;
  respondApproval(runId: string, id: string, decision: 'accept' | 'decline'): Promise<void>;
  respondInput(runId: string, id: string, response: ChatUserInputResponse): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid schedule');
  return value as Record<string, unknown>;
}
export function schedulerText(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new TypeError('Invalid schedule text');
  return value.trim();
}
export function schedulerFlag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Invalid scheduler option');
  return value === true;
}
export function scheduleInput(value: unknown): ScheduleInput {
  const input = record(value);
  const title = schedulerText(input.title);
  const prompt = schedulerText(input.prompt, 100_000);
  const startAt = schedulerText(input.startAt);
  const date = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(startAt);
  if (!date || Number(date[1]) < 1900 || Number(date[1]) > 9998 || !Number.isFinite(Date.parse(startAt))
    || new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))).toISOString().slice(0, 10) !== startAt.slice(0, 10)) {
    throw new TypeError('Invalid schedule date');
  }
  const timeZone = schedulerText(input.timeZone);
  new Intl.DateTimeFormat('en', { timeZone }).format();
  if (!['once', 'daily', 'weekly'].includes(String(input.repeat))) throw new TypeError('Invalid repeat');
  if (input.permissionMode !== 'read-only' && input.permissionMode !== 'ask-for-approval') throw new TypeError('Invalid schedule permissions');
  return {
    title, prompt, startAt: new Date(startAt).toISOString(), timeZone, repeat: input.repeat as ScheduleRepeat,
    enabled: schedulerFlag(input.enabled), threadId: input.threadId === null ? null : schedulerText(input.threadId),
    permissionMode: input.permissionMode, model: input.model === null ? null : schedulerText(input.model),
    effort: schedulerText(input.effort, 100),
  };
}
export function scheduleTarget(value: unknown): { id: string; revision: number } {
  const target = record(value);
  if (!Number.isSafeInteger(target.revision) || Number(target.revision) < 1) throw new TypeError('Invalid schedule revision');
  return { id: schedulerText(target.id), revision: Number(target.revision) };
}
export function schedulerAction(value: unknown): SchedulerAction {
  if (!['approve', 'skip', 'acknowledge', 'dismiss', 'run-late', 'cancel'].includes(String(value))) throw new TypeError('Invalid scheduler action');
  return value as SchedulerAction;
}
