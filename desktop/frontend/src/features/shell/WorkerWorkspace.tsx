import { useCallback, useImperativeHandle, useState, type ComponentProps, type Ref } from 'react';
import { ChatsView } from '../agent-chats/ChatsView';
import { AgentManagementViews } from './AgentManagementViews';
import type { AgentChatsApi } from '../../../../shared/agent-chats';
import type { AgentRegistryApi } from '../../../../shared/agent-registry';
import type { AgentManagementApi } from '../../../../shared/agent-management';

export interface WorkerWorkspaceHandle { closeHomies(): void }
type ConversationProps = Pick<ComponentProps<typeof ChatsView>, 'sidebarTarget' | 'sidebarActive' | 'onOpenRoom'
  | 'reviewedMessageId' | 'onReviewFileChanges' | 'reviewedVerificationId' | 'onReviewVerification'>;

/** Keep panel interactions inside Worker so they do not render every workspace view. */
export function WorkerWorkspace({ ref, view, onBeforeOpenHomies, api, registryApi, managementApi, ...conversation }: ConversationProps & {
  ref?: Ref<WorkerWorkspaceHandle>;
  view: 'chats' | 'docker' | null;
  onBeforeOpenHomies(): void;
  api?: AgentChatsApi;
  registryApi?: AgentRegistryApi;
  managementApi?: AgentManagementApi;
}) {
  const [homies, setHomies] = useState<{ agentId: string | null; roomId?: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [listTarget, setListTarget] = useState<HTMLDivElement | null>(null);
  const closeHomies = useCallback(() => { setHomies(null); setEditing(false); setOpen(false); }, []);
  useImperativeHandle(ref, () => ({ closeHomies }), [closeHomies]);
  const onEditingChange = useCallback((value: boolean) => {
    setEditing(value);
    if (value) setOpen(true);
  }, []);
  const manage = (agentId?: string, roomId?: string) => {
    if (!agentId && homies && !editing && open) { setOpen(false); return; }
    onBeforeOpenHomies();
    setEditing(Boolean(agentId)); setOpen(true);
    setHomies({ agentId: agentId ?? null, ...(roomId ? { roomId } : {}) });
  };
  return <>
    <ChatsView {...conversation} api={api} registry={registryApi} management={managementApi}
      active={view === 'chats' && !(homies && editing)} onManageHomies={manage}
      homiesOpen={homies !== null && !editing && open}
      onHomiesTarget={setListTarget} onCloseHomies={() => setOpen(false)} />
    <AgentManagementViews api={managementApi} registryApi={registryApi} chatsApi={api}
      view={view === 'docker' ? 'docker' : view === 'chats' && homies ? 'homies' : null}
      listTarget={listTarget} onEditingChange={onEditingChange} selectionRequest={homies ?? undefined}
      onClose={homies ? () => { if (editing) closeHomies(); else setOpen(false); } : undefined} />
  </>;
}
