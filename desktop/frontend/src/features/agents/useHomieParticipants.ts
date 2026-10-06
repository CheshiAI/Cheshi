import { useEffect, useRef, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { AgentChatsApi } from '../../../../shared/agent-chats';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import { useChatsSnapshot } from '../agent-chats/useChatsSnapshot';

interface Draft { roomId: string; baseline: string; members: string[]; owner: string }
export function useHomieParticipants(roomId: string | undefined, agents: SpecialistAgent[], workspaceRoot: string | undefined,
  api: AgentChatsApi | undefined = cheshiDesktop?.agentChats) {
  const data = useChatsSnapshot(roomId ? api : undefined, Boolean(roomId));
  const room = data.snapshot.rooms.find(item => item.id === roomId && item.workspace === workspaceRoot);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false), generation = useRef(0);
  useEffect(() => {
    generation.current++; setDraft(null); setSaving(false); setError(null); pending.current = false;
    return () => { generation.current++; };
  }, [roomId, api]);
  const baseline = JSON.stringify([room?.members, room?.defaultAgentId]);
  const current = draft?.roomId === roomId ? draft : null;
  const members = current?.members ?? room?.members.map(item => item.id) ?? [];
  const owner = current?.owner ?? room?.defaultAgentId ?? '';
  const candidates = agents.map(agent => {
    const member = [...(room?.members ?? []), ...(room?.formerMembers ?? [])].find(item => item.id === agent.id);
    const available = Boolean(agent.accountId && agent.assignments.some(item => item.workspaceRoot === workspaceRoot)
      && (!member || member.accountId === agent.accountId));
    return { id: agent.id, name: agent.name, available, existing: Boolean(room?.members.some(item => item.id === agent.id)) };
  });
  for (const member of room?.members ?? []) {
    if (!candidates.some(item => item.id === member.id)) candidates.push({ ...member, available: false, existing: true });
  }
  const defaults = candidates.filter(item => item.available && members.includes(item.id));
  const conflict = current !== null && current.baseline !== baseline;
  const canSave = Boolean(room && current && !conflict && defaults.some(item => item.id === owner) && !saving);
  const update = (selected: string[], defaultAgentId: string) => {
    if (!room || saving || conflict) return;
    setError(null);
    setDraft({ roomId: room.id, baseline, members: selected, owner: defaultAgentId });
  };
  const toggle = (id: string, checked: boolean) => {
    const candidate = candidates.find(item => item.id === id);
    if (!candidate || (!candidate.existing && !candidate.available)) return;
    const selected = checked ? [...new Set([...members, id])] : members.filter(item => item !== id);
    update(selected, defaults.some(item => item.id === owner) && selected.includes(owner) ? owner
      : candidates.find(item => item.available && selected.includes(item.id))?.id ?? '');
  };
  async function save() {
    if (!canSave || !room || pending.current) return;
    const started = generation.current;
    pending.current = true; setSaving(true); setError(null);
    try {
      await data.request({ action: 'participants', roomId: room.id, members, defaultAgentId: owner,
        expectedMembers: room.members.map(item => item.id), expectedDefaultAgentId: room.defaultAgentId });
      if (generation.current === started) setDraft(null);
    } catch (reason) {
      if (generation.current === started) setError(reason instanceof Error ? reason.message : 'Could not save participants.');
    } finally {
      if (generation.current === started) { pending.current = false; setSaving(false); }
    }
  }
  return { room, candidates, members, owner, defaults, saving, canSave, conflict, toggle, save,
    error: error ?? (roomId ? data.error ?? (data.loaded && !room ? 'This room is no longer available.' : null) : null),
    loading: Boolean(roomId && !data.loaded), setOwner: (id: string) => update(members, id),
    reset: () => { setDraft(null); setError(null); } };
}
