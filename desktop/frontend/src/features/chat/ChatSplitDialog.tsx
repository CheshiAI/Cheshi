import { GitFork, Plus } from 'lucide-react';
import { chatRelayContextIds } from '../../../../shared/chat-relay';
import { SplitPreview } from '../../shared/ui/SplitPreview';
import { CHAT_PANE_LIMIT, CHAT_PANE_MIN_WIDTH, chatForkUnavailableReason } from './chatWorkspaceModel';
import type { ChatWorkspaceController } from './useChatWorkspace';

export function ChatSplitDialog({ workspace, paneId, sourceThreadId, target, onClose }: {
  workspace: ChatWorkspaceController;
  paneId: string;
  sourceThreadId: string | null;
  target: HTMLElement;
  onClose: () => void;
}) {
  const source = workspace.controllers[paneId]?.state;
  const locked = workspace.relay.running && workspace.relay.state !== null
    && chatRelayContextIds(workspace.relay.state).includes(paneId);
  const forkReason = source?.activeSessionId !== sourceThreadId ? 'The source conversation changed. Reopen this preview.'
    : chatForkUnavailableReason(source, locked);
  const unavailable = workspace.splitPending || !workspace.paneIds.includes(paneId) || workspace.paneIds.length >= CHAT_PANE_LIMIT;
  return <SplitPreview target={target} direction="right" minimumTargetWidth={CHAT_PANE_MIN_WIDTH}
    title="Split chat right" onClose={onClose} backdrop="regional"
    onCommitted={() => requestAnimationFrame(() => {
      target.closest('main')?.querySelector<HTMLElement>('[data-chat-pane][data-active="true"]')?.focus({ preventScroll: true });
    })}
    choices={[
      { id: 'new', label: 'New session', icon: <Plus aria-hidden="true" />, description: 'Start an empty conversation.',
        disabledReason: unavailable ? 'A chat split is currently unavailable.' : undefined },
      { id: 'fork', label: 'Fork current conversation', icon: <GitFork aria-hidden="true" />,
        description: 'Continue independently with the current conversation.',
        disabledReason: unavailable ? 'A chat split is currently unavailable.' : forkReason ?? undefined },
    ]} onChoose={mode => {
      if (unavailable || (mode === 'fork' && forkReason)) return false;
      return workspace.splitPane(paneId, mode === 'fork' ? 'fork' : 'new', sourceThreadId ?? undefined);
    }} />;
}
