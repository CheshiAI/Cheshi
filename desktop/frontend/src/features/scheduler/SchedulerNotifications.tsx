import { Bell, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DismissibleToast } from '../../shared/ui/DismissibleToast';
import { Modal } from '../../shared/ui';
import { useScheduler } from './useScheduler';
import { SchedulerRunContent } from './SchedulerRunContent';
import { DEFAULT_SCHEDULER_NOTIFICATION_POSITION, type SchedulerApi } from '../../../../shared/scheduler';

export function SchedulerNotifications({ onOpenThread, api: providedApi }: { onOpenThread(id: string): void; api?: SchedulerApi }) {
  const { api, state, refresh } = useScheduler(providedApi);
  const [review, setReview] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { if (state.reviewId) setReview(state.reviewId); }, [state.reviewId, state.reviewVersion]);
  useEffect(() => {
    const open = (event: Event) => { if (event instanceof CustomEvent && typeof event.detail === 'string') setReview(event.detail); };
    window.addEventListener('cheshi:scheduler-review', open);
    return () => window.removeEventListener('cheshi:scheduler-review', open);
  }, []);
  const needsInput = state.attention.find(item => item.approvals.length || item.inputs.length);
  const inputKey = needsInput ? `${needsInput.runId}:${needsInput.approvals.map(item => item.id)}:${needsInput.inputs.map(item => item.id)}` : '';
  const run = needsInput && !hidden.includes(inputKey) ? state.runs.find(item => item.id === needsInput.runId)
    : [...state.runs].reverse().find(item => !item.dismissed && item.status === 'pending');
  const dismiss = async () => {
    if (!api || !run) return;
    try {
      if (run.id === needsInput?.runId) setHidden(current => [...current, inputKey]);
      else await api.act(run.id, run.kind === 'event' && run.mode === 'auto' ? 'acknowledge' : 'dismiss');
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  useEffect(() => {
    if (!api || !run || run.mode !== 'auto' || run.status !== 'pending' || needsInput?.runId === run.id) return;
    const id = run.id;
    const timeout = setTimeout(() => {
      void api.act(id, run.kind === 'event' ? 'acknowledge' : 'dismiss').then(refresh).catch(reason => setError(String(reason)));
    }, 8000);
    return () => clearTimeout(timeout);
  }, [api, run?.id, run?.mode, run?.status, needsInput?.runId, refresh]);
  if (!api) return null;
  const detail = state.runs.find(item => item.id === review);
  return <>
    {run && !review && <DismissibleToast placement={state.notificationPosition ?? DEFAULT_SCHEDULER_NOTIFICATION_POSITION} title={run.kind === 'event' ? 'UPCOMING EVENT' : needsInput?.runId === run.id ? 'TASK NEEDS YOUR INPUT' : 'SCHEDULED TASK'}
      icon={run.kind === 'event' ? <Bell /> : <Clock />} description={run.title} closeButtonVariant="ghost" onDismiss={() => void dismiss()}>
      {error && <p role="alert">{error}</p>}
      {run.mode === 'auto' && run.status === 'pending' ? <p>{run.kind === 'task' ? 'This task will run automatically' : 'Your event starts'} at {new Date(run.plannedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.</p>
        : <SchedulerRunContent key={run.id} api={api} run={run} attention={state.attention.find(item => item.runId === run.id)} refresh={refresh} onOpenThread={onOpenThread} />}
    </DismissibleToast>}
    {detail && <Modal title={detail.title} headerVariant="section" closeButtonVariant="ghost" onClose={() => setReview(null)}>
      <SchedulerRunContent key={detail.id} api={api} run={detail} attention={state.attention.find(item => item.runId === detail.id)} refresh={refresh}
        onOpenThread={id => { onOpenThread(id); setReview(null); }} />
    </Modal>}
  </>;
}
