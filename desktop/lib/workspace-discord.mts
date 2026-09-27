import path from 'node:path';
import type { CodexChatService } from './codex-chat-service.mts';
import type { DiscordBridge, DiscordTarget } from './discord-service.mts';
import { inputRecord } from '../shared/chat-user-input.ts';
import { startDiscordSetup } from './discord-setup.mts';
import type { DiscordSetupBrowser } from './discord-setup-tools.mts';

export function createWorkspaceDiscord(options: {
  workspace: string; bridge?: DiscordBridge;
  services(): Array<{ contextId: string; service: CodexChatService }>;
  queueSize(context: string, thread: string): number | null;
}) {
  const bindings = new Map<string, { key: string; context: string; target: DiscordTarget; permissions: string }>();
  const pending = new Map<string, string>();
  let restored = false;
  const contexts = () => options.services();
  function observe(context: string, thread: string, title: string, created = false) {
    if (!options.bridge) return;
    const source = contexts().find(entry => entry.contextId === context)?.service;
    if (!source || source.threadIsSubagent.get(thread) === true) return;
    const previous = bindings.get(thread);
    const permissions = source.viewedThreadId === thread || created ? JSON.stringify(source.permissionOverrides()) : previous?.permissions ?? 'reopen-required';
    const target: DiscordTarget = {
      workspace: options.workspace, thread, title: title || previous?.target.title || `${path.basename(options.workspace)}-new-chat`,
      async execute(text, id, signal) {
        signal.throwIfAborted();
        const currentThread = target.thread;
        const services = contexts();
        const owner = services.find(entry => entry.service.activeTurns.has(currentThread))
          ?? services.find(entry => entry.service.viewedThreadId === currentThread)
          ?? services.find(entry => entry.service === source);
        if (!owner) return { text: 'Reopen this session in Cheshi. The instruction was not executed.' };
        const service = owner.service;
        const queued = services.reduce((sum, entry) => sum + (options.queueSize(entry.contextId, currentThread) ?? 0), 0);
        const waiting = services.some(entry => [...entry.service.pendingApprovals.values()].some(item => item.threadId === currentThread)
          || entry.service.userInputs.list().some(item => item.threadId === currentThread));
        const active = service.activeTurns.has(currentThread);
        if (text === '/status' || text === '상태') return { text: `${waiting ? 'Waiting for your response' : active ? 'Working' : 'Idle'} · Queued messages: ${queued}` };
        if (options.queueSize(owner.contextId, currentThread) === null) return { text: 'Checking the queue in Cheshi. Try again shortly.' };
        if (text === '/stop' || text === '중지') {
          if (queued) return { text: 'Clear the queue in Cheshi before stopping.' };
          const result = await service.cancelResponse(currentThread);
          return { text: result.requested ? 'Stop requested' : 'No task is currently running.' };
        }
        if (waiting) return { text: 'Respond to the pending approval or question in Cheshi first.' };
        const binding = bindings.get(currentThread);
        const currentPermissions = JSON.stringify(service.permissionOverrides());
        // A different foreground session must not silently grant this channel its
        // permission profile. Reopening the bound session confirms its current mode.
        if (!active && service.viewedThreadId !== currentThread && binding?.permissions !== currentPermissions) {
          return { text: 'Permissions have changed. Open this session in Cheshi and check its permissions before sending another instruction.' };
        }
        if (binding && service.viewedThreadId === currentThread) binding.permissions = currentPermissions;
        if (services.some(entry => entry.service.pendingTurnStarts.has(currentThread)) || (!active && queued)) {
          return { text: 'A task is starting or queued messages are being processed. Try again shortly.' };
        }
        service.emit({ type: 'user-message', threadId: currentThread, clientMessageId: id, text, createdAt: Date.now() / 1000 });
        if (active) { await service.steerMessage(text, id, null, [], currentThread); return { text: 'Additional instruction sent' }; }
        pending.set(id, currentThread);
        let result;
        try { result = await service.sendMessage(text, id, null, [], currentThread, signal); }
        finally { pending.delete(id); }
        if (result.threadId !== currentThread) {
          target.thread = result.threadId;
          const binding = bindings.get(currentThread);
          if (binding) { bindings.delete(currentThread); bindings.set(result.threadId, binding); }
        }
        return { text: 'Working…', thread: result.threadId };
      },
    };
    bindings.set(thread, { key: options.bridge.observe(target), context, target, permissions });
  }
  return {
    setup(context: unknown, createBrowser?: () => DiscordSetupBrowser) {
      if (context !== undefined && typeof context !== 'string') throw new TypeError('Invalid setup chat context.');
      const source = contexts().find(entry => entry.contextId === (context ?? 'main'));
      if (!source) throw new Error('Open a chat pane before starting Discord setup.');
      return startDiscordSetup(source.service, createBrowser);
    },
    event(context: string, value: unknown) {
      const event = inputRecord(value); if (!event || !options.bridge) return;
      if (!restored) {
        restored = true;
        for (const session of options.bridge.sessions(options.workspace)) observe(context, session.thread, session.title);
      }
      const session = inputRecord(event.session);
      const thread = typeof event.threadId === 'string' ? event.threadId : typeof session?.id === 'string' ? session.id : null;
      if (thread && event.type === 'session-selected' && typeof event.previousThreadId === 'string'
        && [...pending.values()].includes(event.previousThreadId)) {
        const binding = bindings.get(event.previousThreadId);
        if (binding && event.previousThreadId !== thread) {
          bindings.delete(event.previousThreadId); bindings.set(thread, binding); binding.target.thread = thread;
          options.bridge.continue(binding.key, thread);
        }
      }
      if (thread && event.type === 'turn-started') {
        const previous = pending.get(String(event.clientMessageId));
        const binding = previous ? bindings.get(previous) : undefined;
        if (previous && binding && previous !== thread) {
          bindings.delete(previous); bindings.set(thread, binding); binding.target.thread = thread;
          options.bridge.continue(binding.key, thread);
        }
      }
      if (thread && ['session-created', 'session-selected', 'session-opened', 'session-title'].includes(String(event.type))) {
        observe(context, thread, typeof event.title === 'string' ? event.title : typeof session?.title === 'string' ? session.title : '', event.type === 'session-created');
      }
      if (event.type === 'sessions-deleted' && Array.isArray(event.threadIds)) {
        for (const id of event.threadIds) {
          const binding = bindings.get(String(id));
          if (binding) { options.bridge.event(binding.key, { type: 'session-deleted' }, 0); options.bridge.unavailable(binding.key); bindings.delete(String(id)); }
        }
      }
      const request = inputRecord(event.approval) ?? inputRecord(event.request);
      const binding = bindings.get(thread ?? String(request?.threadId));
      if (binding && event.type === 'turn-started') binding.context = context;
      if (binding) options.bridge.event(binding.key, event, options.queueSize(binding.context, binding.target.thread));
    },
    queue(context: string) {
      for (const binding of bindings.values()) if (binding.context === context) options.bridge?.event(binding.key,
        { type: 'queue-changed' }, options.queueSize(context, binding.target.thread));
    },
    remove(context: string) {
      for (const [thread, binding] of bindings) if (binding.context === context) { options.bridge?.unavailable(binding.key); bindings.delete(thread); }
    },
    dispose() { for (const binding of bindings.values()) options.bridge?.unavailable(binding.key); bindings.clear(); },
  };
}
