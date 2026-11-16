import type { AgentDetails, AgentTask } from '../../../../shared/agent-management';
import type { HomieStatusLabel } from './HomieStatusIcon';

export interface RuntimeStatusPresentation {
  label: HomieStatusLabel;
  reason: string;
  next: string;
  error?: string;
}

function waitingStatus(task: AgentTask): RuntimeStatusPresentation {
  const inspection = task.inspection, permission = inspection?.permissionRequest;
  if (permission?.status === 'pending') return { label: 'Waiting for approval', reason: permission.reason,
    next: 'Open the permission request in the work room and choose Allow for project or Deny.' };
  const question = inspection?.dialogue?.questions.find(item => item.answer === null);
  if (question) return { label: 'Waiting for reply', reason: question.text,
    next: 'Reply to this question in the work room.' };
  if (permission?.status === 'allowed') return { label: 'Approved · awaiting resume',
    reason: 'The requested permissions have been applied. The paused task has not resumed.',
    next: 'Reply to the task in the work room with what to do next. Approval does not automatically resume it.' };
  if (permission?.status === 'denied') return { label: 'Permission denied · paused',
    reason: 'The permission request was denied. The task remains paused.',
    next: 'Reply in the work room with instructions that fit the current permissions.' };
  const decision = inspection?.goal?.pending ?? inspection?.goal?.decisions.at(-1);
  return { label: 'Task paused', reason: decision?.reason || 'The task is waiting; no unanswered user question or permission request is recorded.',
    next: decision?.nextAction || 'Review the latest task message in the work room before continuing.' };
}

export function runtimeStatusPresentation(input: {
  label: HomieStatusLabel; details: AgentDetails | null; error: string | null; notice: string | null;
}): RuntimeStatusPresentation {
  const { label, details, error, notice } = input;
  if (label === 'Processing…' || label === 'Starting…') return { label,
    reason: 'The worker environment is being prepared.', next: 'Wait for preparation to finish.' };
  if (error && label !== 'Engine disconnected') {
    if (error.startsWith('Settings changed.')) return { label: 'Settings need applying', reason: error,
      next: 'Use Apply changes to update the worker environment.', error };
    return { label: 'Error', reason: error, error,
      next: error.includes('AppArmor') ? 'Open Settings → Homies and use Prepare Homies, then apply changes here.'
        : 'Follow the error details. Check the environment before retrying.' };
  }
  if (notice) return { label, reason: notice, next: 'Review this Homie’s project assignment in settings.' };
  if (label === 'Waiting for reply') {
    const waiting = details?.tasks.filter(task => task.status === 'waiting') ?? [];
    // Pending permission decisions take priority over previously approved tasks.
    const task = waiting.find(item => item.inspection?.permissionRequest?.status === 'pending')
      ?? waiting.find(item => item.inspection?.dialogue?.questions.some(question => question.answer === null))
      ?? waiting.at(-1);
    if (task) return waitingStatus(task);
  }
  if (label === 'Ready' && details?.tasks.some(task => task.status === 'unknown')) return {
    label: 'Result unknown', reason: 'An earlier task has no confirmed outcome.',
    next: 'Inspect the unfinished task before starting more work.' };
  const descriptions: Partial<Record<HomieStatusLabel, [string, string]>> = {
    Ready: ['The worker is ready and no task is running.', 'Send a message to this Homie in the work room.'],
    Working: ['The worker is processing a task.', 'Follow its progress in the work room.'],
    Sleeping: ['The worker is sleeping to save resources.', 'Send work to wake it automatically.'],
    'Manually stopped': ['The worker was stopped manually.', 'Use Start agent to make it available again.'],
    'Not running': ['The worker is not running.', 'Use Start agent to prepare and start it.'],
    'Sign-in required': ['The worker account is not signed in.', 'Sign in to the selected account, then apply changes.'],
    'Engine disconnected': [error || 'The container engine could not be reached.', 'Check Colima in Settings → Homies.'],
    'Status unknown': ['The current worker state has not been confirmed.', 'Wait for the status check to finish.'],
  };
  const [reason, next] = descriptions[label] ?? ['The worker state needs review.', 'Review the latest task message.'];
  return { label, reason, next };
}
