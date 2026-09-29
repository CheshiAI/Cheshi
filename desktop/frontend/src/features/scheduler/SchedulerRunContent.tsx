import { useState } from 'react';
import type { ScheduleRun, SchedulerApi, SchedulerAttention, SchedulerAction } from '../../../../shared/scheduler';
import { NeumorphicButton } from '../../shared/ui';
import { ChatUserInputPrompt } from '../chat/ChatUserInputPrompt';
import styles from './Scheduler.module.css';

export function showSchedulerRun(id: string): void {
  window.dispatchEvent(new CustomEvent('cheshi:scheduler-review', { detail: id }));
}
export function SchedulerRunContent({ api, run, attention, refresh, onOpenThread }: {
  api: SchedulerApi; run: ScheduleRun; attention?: SchedulerAttention; refresh(): Promise<void>; onOpenThread?(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operate = async (operation: () => Promise<void>) => {
    if (busy) return false;
    setBusy(true); setError('');
    try { await operation(); await refresh(); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { setBusy(false); }
  };
  const act = (action: SchedulerAction) => { void operate(() => api.act(run.id, action)); };
  const awaiting = run.status === 'pending' || run.status === 'approved';
  return <div className={styles.form}>
    <p>{new Date(run.plannedAt).toLocaleString('en-US')} · {run.mode === 'auto' ? 'Auto' : 'Approval required'}</p>
    <p>Status: {run.status}</p>
    {run.kind === 'task' && <p>Workspace: {run.workspace}</p>}
    {run.snapshot && <p>Permissions: {run.snapshot.permissionMode === 'read-only' ? 'Read only' : 'Ask for approval'}</p>}
    {run.snapshot && <p className={styles.summary}>{run.snapshot.prompt}</p>}
    {run.summary && <p className={styles.summary}>{run.summary}</p>}
    {run.startedAt && <p>Started: {new Date(run.startedAt).toLocaleString('en-US')}</p>}
    {run.finishedAt && <p>Finished: {new Date(run.finishedAt).toLocaleString('en-US')}</p>}
    {run.profileId && <p>Account: {run.profileId}</p>}
    {attention?.approvals.map(approval => <section key={approval.id}>
      <h3>{approval.title}</h3><p className={styles.summary}>{approval.detail}</p>
      <div className={styles.actions}>
        <NeumorphicButton variant="ghost" disabled={busy} onClick={() => void operate(() => api.respondApproval(run.id, approval.id, 'decline'))}>Decline</NeumorphicButton>
        <NeumorphicButton variant="standard" disabled={busy} onClick={() => void operate(() => api.respondApproval(run.id, approval.id, 'accept'))}>Allow once</NeumorphicButton>
      </div>
    </section>)}
    {attention?.inputs.map(request => <ChatUserInputPrompt key={request.id} request={request} pending={busy} error={null}
      respond={(id, response) => operate(() => api.respondInput(run.id, id, response))} />)}
    {error && <p role="alert">{error}</p>}
    <div className={styles.actions}>
      {awaiting && run.kind === 'event' && <NeumorphicButton variant="standard" disabled={busy} onClick={() => act('acknowledge')}>Got it</NeumorphicButton>}
      {awaiting && run.kind === 'task' && <>
        <NeumorphicButton variant="ghost" disabled={busy} onClick={() => act('skip')}>Skip this run</NeumorphicButton>
        {run.mode !== 'auto' && run.status !== 'approved' && <NeumorphicButton variant="standard" disabled={busy} onClick={() => act('approve')}>Approve for scheduled time</NeumorphicButton>}
      </>}
      {run.status === 'missed' && run.kind === 'task' && <NeumorphicButton variant="standard" disabled={busy} onClick={() => act('run-late')}>Run now</NeumorphicButton>}
      {['starting', 'running'].includes(run.status) && <NeumorphicButton variant="ghost" disabled={busy} onClick={() => act('cancel')}>Stop task</NeumorphicButton>}
      {run.threadId && onOpenThread && <NeumorphicButton variant="ghost" disabled={busy} onClick={() => onOpenThread(run.threadId!)}>Open conversation</NeumorphicButton>}
    </div>
  </div>;
}
