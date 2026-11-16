import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { chatUserInputResponse } from '../../shared/chat-user-input.ts';
import { scheduleInput, scheduleTarget, schedulerAction, schedulerFlag, schedulerNotificationPosition, schedulerText, SCHEDULER_CHANNEL } from '../../shared/scheduler.ts';
import { getScheduler } from './application.mts';
import type { SchedulerCodexRunner } from './codex-runner.mts';
import type { CodexChatService } from '../codex-chat-service.mts';
import { createSchedulerSubscriptions } from './subscriptions.mts';
import { registerWorkspaceChatServices } from '../codex-workspace-activity.mts';
import type { SchedulerEngine } from './engine.mts';
import { schedulerDesktop } from './desktop.mts';
import { migrateSchedule } from './migration.mts';
import { AppleCalendarService } from '../apple-calendar-service.mts';

export function createWorkspaceScheduler(options: ConstructorParameters<typeof SchedulerCodexRunner>[0] & {
  ipc: Pick<IpcMain, 'handle'>; assertSender(event: IpcMainInvokeEvent): void; workspace: string; dataDirectory: string;
  primary: CodexChatService;
}) {
  const removeServices = registerWorkspaceChatServices(options.workspace, () => [options.primary, ...options.contexts.allServices().map(entry => entry.service)]);
  let current: SchedulerEngine | undefined;
  const subscribers = createSchedulerSubscriptions();
  let disposed = false;
  const ready = getScheduler(options.dataDirectory).then(engine => {
    current = engine; return { engine, unsubscribe: engine.subscribe(() => subscribers.changed()) };
  });
  void ready.catch(error => console.error('[cheshi:scheduler] Startup failed:', String(error)));
  options.ipc.handle(SCHEDULER_CHANNEL, async (event, method: unknown, value: unknown, extra: unknown) => {
    options.assertSender(event);
    const { engine } = await ready;
    options.assertSender(event);
    if (disposed) throw new Error('Workspace scheduler is closed.');
    const workspace = options.workspace;
    if (method === 'subscribe') { subscribers.add(event.sender, schedulerText(value)); return; }
    if (method === 'unsubscribe') { subscribers.remove(event.sender, schedulerText(value)); return; }
    if (method === 'read') return engine.snapshot(workspace);
    if (method === 'startup') return schedulerDesktop().startup();
    if (method === 'set-startup') return schedulerDesktop().setStartup(schedulerFlag(value));
    if (method === 'save') return engine.save(workspace, scheduleInput(value), extra === undefined ? undefined : scheduleTarget(extra));
    if (method === 'migrate') { const target = scheduleTarget(value); return migrateSchedule(engine, new AppleCalendarService(), workspace, target.id, target.revision, schedulerText(extra)); }
    if (method === 'remove') { const target = scheduleTarget(value); return engine.store.remove(workspace, target.id, target.revision); }
    if (method === 'notification-position') { engine.store.notificationPosition = schedulerNotificationPosition(value); return; }
    if (method === 'auto') return engine.setAuto(schedulerFlag(value));
    if (method === 'act') return engine.act(workspace, schedulerText(value), schedulerAction(extra));
    if (method === 'approval' || method === 'input') {
      if (!extra || typeof extra !== 'object') throw new TypeError('Invalid task response');
      const response = extra as Record<string, unknown>;
      const id = schedulerText(response.id);
      const runId = schedulerText(value);
      if (engine.store.run(runId)?.workspace !== workspace) throw new Error('Task is not in this workspace.');
      const runner = engine.runnerFor(runId);
      if (!runner?.respondInput || !runner.respondApproval) throw new Error('Task is no longer running.');
      if (method === 'input') return runner.respondInput(runId, id, chatUserInputResponse(response.response));
      if (response.decision !== 'accept' && response.decision !== 'decline') throw new TypeError('Invalid approval');
      return runner.respondApproval(runId, id, response.decision);
    }
    throw new Error('Unknown scheduler operation');
  });
  return { get busy() { return current?.workspaceBusy(options.workspace) ?? false; }, async dispose() {
    disposed = true; subscribers.dispose(); removeServices();
    const state = await ready; state.unsubscribe();
  } };
}
